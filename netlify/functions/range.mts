import type { Context, Config } from "@netlify/functions";

/**
 * TomTom "Calculate Reachable Range" proxy.
 *
 * The browser calls /api/range?lat=..&lng=..&sec=..&mode=car and never sees the
 * TomTom key — it lives only in the TOMTOM_KEY environment variable on Netlify.
 * One request returns exactly one reachable-range polygon, which we normalise
 * into a GeoJSON Feature the front-end can hand straight to Leaflet / Turf.
 */

const ALLOWED_MODES = [
  "car", "truck", "taxi", "bus", "van", "motorcycle", "bicycle", "pedestrian",
];

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get("lat") || "");
  const lng = parseFloat(url.searchParams.get("lng") || "");
  const sec = parseInt(url.searchParams.get("sec") || "", 10);
  const mode = (url.searchParams.get("mode") || "car").toLowerCase();

  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return json({ error: "Missing or invalid lat/lng." }, 400);
  }
  if (!Number.isFinite(sec) || sec <= 0 || sec > 100000) {
    return json({ error: "Missing or invalid time budget (sec)." }, 400);
  }
  if (!ALLOWED_MODES.includes(mode)) {
    return json({ error: "Unsupported travel mode." }, 400);
  }

  const key = Netlify.env.get("TOMTOM_KEY");
  if (!key) {
    return json({ error: "Server is not configured: TOMTOM_KEY is missing." }, 500);
  }

  const ttUrl =
    `https://api.tomtom.com/routing/1/calculateReachableRange/${lat},${lng}/json` +
    `?key=${encodeURIComponent(key)}` +
    `&timeBudgetInSec=${sec}` +
    `&travelMode=${mode}`;

  let resp: Response;
  try {
    resp = await fetch(ttUrl);
  } catch {
    return json({ error: "Could not reach TomTom." }, 502);
  }

  const data: any = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg =
      (data && (data?.error?.description || data?.detailedError?.message || data?.message)) ||
      `TomTom HTTP ${resp.status}`;
    // Surface auth/quota issues clearly; collapse the rest to 502.
    const status = resp.status === 401 || resp.status === 403 || resp.status === 429 ? resp.status : 502;
    return json({ error: msg, tomtomStatus: resp.status }, status);
  }

  const boundary = data?.reachableRange?.boundary;
  if (!Array.isArray(boundary) || boundary.length < 3) {
    return json({ error: "TomTom returned no reachable area for this point." }, 502);
  }

  // TomTom boundary is [{latitude, longitude}, ...]; GeoJSON wants [lng, lat] and a closed ring.
  const ring = boundary.map((pt: any) => [pt.longitude, pt.latitude]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);

  const feature = {
    type: "Feature",
    properties: { seconds: sec, mode },
    geometry: { type: "Polygon", coordinates: [ring] },
  };

  return json({ seconds: sec, mode, center: data.reachableRange.center, feature }, 200);
};

export const config: Config = {
  path: "/api/range",
};
