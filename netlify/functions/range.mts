import type { Context, Config } from "@netlify/functions";

/**
 * Reachable-range proxy supporting two upstreams, chosen per request via
 * ?provider=ors|tomtom. Keys live only in env vars (ORS_KEY / TOMTOM_KEY); the
 * browser never sees them. One request can ask for several time bands at once
 * (?mins=15,30,45,60) and always gets back the same normalised shape:
 *
 *   { provider, mode, features: [ { minutes, seconds, points, feature } ] }
 *
 * where `feature` is a GeoJSON Feature<Polygon|MultiPolygon> and `points` is the
 * boundary vertex count (so the UI can show how detailed each shape is).
 */

const ORS_PROFILE: Record<string, string> = {
  car: "driving-car",
  bicycle: "cycling-regular",
  pedestrian: "foot-walking",
};
const TT_MODES = ["car", "truck", "taxi", "bus", "van", "motorcycle", "bicycle", "pedestrian"];

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function countPoints(geom: any): number {
  if (!geom) return 0;
  if (geom.type === "Polygon") return geom.coordinates.reduce((s: number, r: any[]) => s + r.length, 0);
  if (geom.type === "MultiPolygon")
    return geom.coordinates.reduce((s: number, p: any[]) => s + p.reduce((a: number, r: any[]) => a + r.length, 0), 0);
  return 0;
}

async function fromTomTom(lat: number, lng: number, mode: string, mins: number[], key: string) {
  const calls = mins.map(async (m) => {
    const sec = m * 60;
    const u =
      `https://api.tomtom.com/routing/1/calculateReachableRange/${lat},${lng}/json` +
      `?key=${encodeURIComponent(key)}&timeBudgetInSec=${sec}&travelMode=${mode}&traffic=true`;
    const r = await fetch(u);
    const d: any = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = (d && (d?.error?.description || d?.detailedError?.message)) || `TomTom HTTP ${r.status}`;
      throw { status: r.status, msg };
    }
    const b = d?.reachableRange?.boundary;
    if (!Array.isArray(b) || b.length < 3) throw { status: 502, msg: `TomTom returned no area for ${m} min.` };
    const ring = b.map((p: any) => [p.longitude, p.latitude]);
    const f0 = ring[0];
    const fl = ring[ring.length - 1];
    if (f0[0] !== fl[0] || f0[1] !== fl[1]) ring.push([f0[0], f0[1]]);
    const geometry = { type: "Polygon", coordinates: [ring] };
    return {
      minutes: m,
      seconds: sec,
      points: countPoints(geometry),
      feature: { type: "Feature", properties: { minutes: m, seconds: sec, provider: "tomtom" }, geometry },
    };
  });
  return Promise.all(calls);
}

async function fromORS(lat: number, lng: number, mode: string, mins: number[], key: string) {
  const profile = ORS_PROFILE[mode];
  if (!profile) throw { status: 400, msg: "ORS does not support this travel mode." };
  const secs = mins.map((m) => m * 60);
  // smoothing:0 keeps maximum detail; one call returns one (nested) feature per range value.
  const r = await fetch(`https://api.openrouteservice.org/v2/isochrones/${profile}`, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/geo+json" },
    body: JSON.stringify({ locations: [[lng, lat]], range: secs, range_type: "time", smoothing: 0 }),
  });
  const d: any = await r.json().catch(() => null);
  if (!r.ok) {
    const e = d && d.error;
    const msg = (e && (e.message || e)) || `ORS HTTP ${r.status}`;
    throw { status: r.status, msg: typeof msg === "string" ? msg : JSON.stringify(msg) };
  }
  const feats = (d && d.features) || [];
  return mins.map((m) => {
    const sec = m * 60;
    const f = feats.find((x: any) => Math.abs((x.properties && x.properties.value) - sec) <= 1);
    if (!f) throw { status: 502, msg: `ORS returned no area for ${m} min.` };
    return {
      minutes: m,
      seconds: sec,
      points: countPoints(f.geometry),
      feature: { type: "Feature", properties: { minutes: m, seconds: sec, provider: "ors" }, geometry: f.geometry },
    };
  });
}

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get("lat") || "");
  const lng = parseFloat(url.searchParams.get("lng") || "");
  const mode = (url.searchParams.get("mode") || "car").toLowerCase();
  const provider = (url.searchParams.get("provider") || "tomtom").toLowerCase();
  const mins = (url.searchParams.get("mins") || "")
    .split(",")
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 1200);

  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return json({ error: "Missing or invalid lat/lng." }, 400);
  }
  if (!mins.length) return json({ error: "Provide ?mins as comma-separated minutes." }, 400);
  mins.sort((a, b) => a - b);

  try {
    let features;
    if (provider === "ors") {
      const key = Netlify.env.get("ORS_KEY");
      if (!key) return json({ error: "Server is not configured: ORS_KEY is missing." }, 500);
      features = await fromORS(lat, lng, mode, mins, key);
    } else if (provider === "tomtom") {
      if (!TT_MODES.includes(mode)) return json({ error: "Unsupported travel mode." }, 400);
      const key = Netlify.env.get("TOMTOM_KEY");
      if (!key) return json({ error: "Server is not configured: TOMTOM_KEY is missing." }, 500);
      features = await fromTomTom(lat, lng, mode, mins, key);
    } else {
      return json({ error: "Unknown provider (use ors or tomtom)." }, 400);
    }
    return json({ provider, mode, features }, 200);
  } catch (e: any) {
    const status = (e && e.status) || 502;
    const msg = (e && e.msg) || (e && e.message) || "Upstream request failed.";
    const code = status === 401 || status === 403 || status === 429 ? status : 502;
    return json({ error: msg, upstreamStatus: status, provider }, code);
  }
};

export const config: Config = {
  path: "/api/range",
};
