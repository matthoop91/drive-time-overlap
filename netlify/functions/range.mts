import type { Context, Config } from "@netlify/functions";

/**
 * Reachable-range proxy supporting two upstreams, chosen per request via
 * ?provider=auto|ors|tomtom. Keys live only in env vars (ORS_KEY / TOMTOM_KEY);
 * the browser never sees them. One request can ask for several time bands at
 * once (?mins=15,30,45,60) and always gets back the same normalised shape:
 *
 *   { provider, mode, features: [ { minutes, seconds, points, feature } ] }
 *
 * `provider` in the response is the one that actually produced the result
 * (auto may resolve to ors or tomtom). `feature` is a GeoJSON
 * Feature<Polygon|MultiPolygon>; `points` is the boundary vertex count.
 *
 * auto: use detailed ORS where it's allowed and fast enough; if ORS is too
 * slow, errors, or can't serve the request (e.g. >60 min driving), fall back
 * to TomTom — all within Netlify's 10s function cap. Add &debug=1 for
 * diagnostics (key presence as booleans only, upstream status, timing).
 */

const ORS_PROFILE: Record<string, string> = {
  car: "driving-car",
  bicycle: "cycling-regular",
  pedestrian: "foot-walking",
};
const TT_MODES = ["car", "truck", "taxi", "bus", "van", "motorcycle", "bicycle", "pedestrian"];

// Budgets stay under Netlify's 10s function cap. In auto we give ORS a short
// window and keep room for a TomTom fallback (5.5 + 3.5 = 9s < 10s).
const SOLO_TIMEOUT_MS = 9000; // explicit single-provider request — use most of the 10s cap
const AUTO_ORS_TIMEOUT_MS = 5500;
const AUTO_TT_TIMEOUT_MS = 3500;

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

// fetch with a hard timeout; turns a hang into a clean 504 instead of a platform 502.
async function timedFetch(url: string, opts: RequestInit, ms: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e: any) {
    if (e && e.name === "AbortError") throw { status: 504, msg: `Upstream timed out after ${ms} ms.` };
    throw { status: 502, msg: (e && e.message) || "Network error contacting upstream." };
  } finally {
    clearTimeout(t);
  }
}

async function fromTomTom(lat: number, lng: number, mode: string, mins: number[], key: string, timeoutMs: number) {
  const calls = mins.map(async (m) => {
    const sec = m * 60;
    const u =
      `https://api.tomtom.com/routing/1/calculateReachableRange/${lat},${lng}/json` +
      `?key=${encodeURIComponent(key)}&timeBudgetInSec=${sec}&travelMode=${mode}&traffic=true`;
    const r = await timedFetch(u, {}, timeoutMs);
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

async function fromORS(lat: number, lng: number, mode: string, mins: number[], key: string, timeoutMs: number) {
  const profile = ORS_PROFILE[mode];
  if (!profile) throw { status: 400, msg: "ORS does not support this travel mode." };
  const secs = mins.map((m) => m * 60);
  // smoothing:0 keeps maximum detail; one call returns one (nested) feature per range value.
  const r = await timedFetch(
    `https://api.openrouteservice.org/v2/isochrones/${profile}`,
    {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/geo+json" },
      body: JSON.stringify({ locations: [[lng, lat]], range: secs, range_type: "time", smoothing: 0 }),
    },
    timeoutMs,
  );
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
  const provider = (url.searchParams.get("provider") || "auto").toLowerCase();
  const debug = url.searchParams.get("debug") === "1";
  const mins = (url.searchParams.get("mins") || "")
    .split(",")
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 1200);

  // booleans only — never the key values themselves.
  const orsKey = Netlify.env.get("ORS_KEY") || "";
  const ttKey = Netlify.env.get("TOMTOM_KEY") || "";
  const env = { ors: !!orsKey, tomtom: !!ttKey };
  const dbg = (extra: Record<string, unknown>) => (debug ? extra : {});

  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return json({ error: "Missing or invalid lat/lng.", ...dbg({ env }) }, 400);
  }
  if (!mins.length) return json({ error: "Provide ?mins as comma-separated minutes.", ...dbg({ env }) }, 400);
  mins.sort((a, b) => a - b);

  const ttUsable = env.tomtom && TT_MODES.includes(mode);
  const orsUsable = env.ors && !!ORS_PROFILE[mode];
  const started = Date.now();
  let fellBack = false;

  try {
    let used: string;
    let features;

    if (provider === "ors") {
      if (!env.ors) return json({ error: "Server is not configured: ORS_KEY is missing.", ...dbg({ env }) }, 500);
      used = "ors";
      features = await fromORS(lat, lng, mode, mins, orsKey, SOLO_TIMEOUT_MS);
    } else if (provider === "tomtom") {
      if (!TT_MODES.includes(mode)) return json({ error: "Unsupported travel mode.", ...dbg({ env }) }, 400);
      if (!env.tomtom) return json({ error: "Server is not configured: TOMTOM_KEY is missing.", ...dbg({ env }) }, 500);
      used = "tomtom";
      features = await fromTomTom(lat, lng, mode, mins, ttKey, SOLO_TIMEOUT_MS);
    } else {
      // auto: prefer detailed ORS where allowed (driving only up to 60 min); else / on
      // any ORS failure, fall back to TomTom so the user always gets a result.
      const orsAllowed = orsUsable && (mode !== "car" || mins.every((m) => m <= 60));
      if (orsAllowed) {
        try {
          used = "ors";
          features = await fromORS(lat, lng, mode, mins, orsKey, ttUsable ? AUTO_ORS_TIMEOUT_MS : SOLO_TIMEOUT_MS);
        } catch (e: any) {
          if (!ttUsable) throw e;
          console.error(`auto: ORS failed (${e?.status} ${e?.msg}); falling back to TomTom`);
          fellBack = true;
          used = "tomtom";
          features = await fromTomTom(lat, lng, mode, mins, ttKey, AUTO_TT_TIMEOUT_MS);
        }
      } else if (ttUsable) {
        used = "tomtom";
        features = await fromTomTom(lat, lng, mode, mins, ttKey, SOLO_TIMEOUT_MS);
      } else {
        return json({ error: "No usable provider for this request (check ORS_KEY / TOMTOM_KEY).", ...dbg({ env }) }, 500);
      }
    }

    return json({ provider: used, mode, features, ...dbg({ _diag: { env, fellBack, ms: Date.now() - started } }) }, 200);
  } catch (e: any) {
    const status = (e && e.status) || 502;
    const msg = (e && e.msg) || (e && e.message) || "Upstream request failed.";
    const code = status === 401 || status === 403 || status === 429 || status === 504 ? status : 502;
    console.error(`range proxy failure: provider=${provider} mode=${mode} status=${status} msg=${msg}`);
    return json({ error: msg, upstreamStatus: status, provider, ...dbg({ env, ms: Date.now() - started }) }, code);
  }
};

export const config: Config = {
  path: "/api/range",
};
