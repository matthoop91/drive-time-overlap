/**
 * Reachable-range proxy — Cloudflare Pages Function (route: /api/range).
 *
 * Picks an upstream per request via ?provider=auto|mapbox|ors|tomtom. Keys live
 * only in env vars (MAPBOX_TOKEN / ORS_KEY / TOMTOM_KEY); the browser never sees
 * them. One request can ask for several time bands at once (?mins=15,30,45,60)
 * and always gets back the same normalised shape:
 *
 *   { provider, mode, features: [ { minutes, seconds, points, feature } ] }
 *
 * `provider` in the response is the one that actually produced the result
 * (auto may resolve to any usable provider). `feature` is a GeoJSON
 * Feature<Polygon|MultiPolygon>; `points` is the boundary vertex count.
 *
 * Why Cloudflare Pages and not Netlify: Netlify hard-kills functions at 10s,
 * which ORS's 60-min driving isochrone can exceed. The Workers runtime does not
 * count time spent awaiting fetch() against its limits, so slow upstreams finish.
 *
 * Add &debug=1 for diagnostics (key presence as booleans only, timing).
 *
 * Adding a provider later (e.g. ArcGIS): add one entry to PROVIDERS (keyEnv,
 * cap, modes, run) and — if it should be auto-selectable — list it in AUTO_ORDER.
 */

// No Netlify 10s cap here; keep generous timeouts so slow upstreams complete.
const SOLO_TIMEOUT_MS = 15000; // explicit single-provider request
const AUTO_TIMEOUT_MS = 12000; // per attempt while auto walks its fallback chain

// Provider registry. `cap(mode)` is the max minutes the provider serves for a
// mode; `modes` maps our travel modes to the provider's profile string; `run`
// returns the normalised feature array.
const PROVIDERS = {
  mapbox: {
    keyEnv: "MAPBOX_TOKEN",
    cap: () => 60, // Mapbox Isochrone hard limit: 60 min, 4 contours per call
    modes: { car: "driving", bicycle: "cycling", pedestrian: "walking" },
    run: fromMapbox,
  },
  ors: {
    keyEnv: "ORS_KEY",
    cap: (mode) => (mode === "car" ? 60 : 300),
    modes: { car: "driving-car", bicycle: "cycling-regular", pedestrian: "foot-walking" },
    run: fromORS,
  },
  tomtom: {
    keyEnv: "TOMTOM_KEY",
    cap: () => 300,
    modes: {
      car: "car", truck: "truck", taxi: "taxi", bus: "bus",
      van: "van", motorcycle: "motorcycle", bicycle: "bicycle", pedestrian: "pedestrian",
    },
    run: fromTomTom,
  },
};
// auto preference: fast+detailed first, long-range last.
const AUTO_ORDER = ["mapbox", "ors", "tomtom"];

const PRETTY = { mapbox: "Mapbox", ors: "ORS", tomtom: "TomTom" };

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function countPoints(geom) {
  if (!geom) return 0;
  if (geom.type === "Polygon") return geom.coordinates.reduce((s, r) => s + r.length, 0);
  if (geom.type === "MultiPolygon")
    return geom.coordinates.reduce((s, p) => s + p.reduce((a, r) => a + r.length, 0), 0);
  return 0;
}

// fetch with a hard timeout; turns a hang into a clean 504 instead of a 502.
async function timedFetch(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === "AbortError") throw { status: 504, msg: `Upstream timed out after ${ms} ms.` };
    throw { status: 502, msg: (e && e.message) || "Network error contacting upstream." };
  } finally {
    clearTimeout(t);
  }
}

async function fromMapbox(lat, lng, profile, mins, token, timeoutMs) {
  // One GET returns every contour (Mapbox allows up to 4, each <= 60 min).
  const csv = mins.join(",");
  const u =
    `https://api.mapbox.com/isochrone/v1/mapbox/${profile}/${lng},${lat}` +
    `?contours_minutes=${csv}&polygons=true&denoise=1&access_token=${encodeURIComponent(token)}`;
  const r = await timedFetch(u, {}, timeoutMs);
  const d = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (d && d.message) || `Mapbox HTTP ${r.status}`;
    throw { status: r.status, msg };
  }
  const feats = (d && d.features) || [];
  return mins.map((m) => {
    const sec = m * 60;
    const f = feats.find((x) => x.properties && Math.round(x.properties.contour) === m);
    if (!f || !f.geometry) throw { status: 502, msg: `Mapbox returned no area for ${m} min.` };
    return {
      minutes: m,
      seconds: sec,
      points: countPoints(f.geometry),
      feature: { type: "Feature", properties: { minutes: m, seconds: sec, provider: "mapbox" }, geometry: f.geometry },
    };
  });
}

async function fromORS(lat, lng, profile, mins, key, timeoutMs) {
  const secs = mins.map((m) => m * 60);
  // smoothing:0 keeps maximum detail; one call returns one feature per range value.
  const r = await timedFetch(
    `https://api.openrouteservice.org/v2/isochrones/${profile}`,
    {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/geo+json" },
      body: JSON.stringify({ locations: [[lng, lat]], range: secs, range_type: "time", smoothing: 0 }),
    },
    timeoutMs,
  );
  const d = await r.json().catch(() => null);
  if (!r.ok) {
    const e = d && d.error;
    const msg = (e && (e.message || e)) || `ORS HTTP ${r.status}`;
    throw { status: r.status, msg: typeof msg === "string" ? msg : JSON.stringify(msg) };
  }
  const feats = (d && d.features) || [];
  return mins.map((m) => {
    const sec = m * 60;
    const f = feats.find((x) => Math.abs((x.properties && x.properties.value) - sec) <= 1);
    if (!f) throw { status: 502, msg: `ORS returned no area for ${m} min.` };
    return {
      minutes: m,
      seconds: sec,
      points: countPoints(f.geometry),
      feature: { type: "Feature", properties: { minutes: m, seconds: sec, provider: "ors" }, geometry: f.geometry },
    };
  });
}

async function fromTomTom(lat, lng, travelMode, mins, key, timeoutMs) {
  const calls = mins.map(async (m) => {
    const sec = m * 60;
    const u =
      `https://api.tomtom.com/routing/1/calculateReachableRange/${lat},${lng}/json` +
      `?key=${encodeURIComponent(key)}&timeBudgetInSec=${sec}&travelMode=${travelMode}&traffic=true`;
    const r = await timedFetch(u, {}, timeoutMs);
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = (d && (d?.error?.description || d?.detailedError?.message)) || `TomTom HTTP ${r.status}`;
      throw { status: r.status, msg };
    }
    const b = d?.reachableRange?.boundary;
    if (!Array.isArray(b) || b.length < 3) throw { status: 502, msg: `TomTom returned no area for ${m} min.` };
    const ring = b.map((p) => [p.longitude, p.latitude]);
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

// usable = key present, mode supported, and every requested band within the cap.
function usable(name, env, mode, mins) {
  const p = PROVIDERS[name];
  if (!p || !env[name] || !p.modes[mode]) return false;
  const cap = p.cap(mode);
  return mins.every((m) => m <= cap);
}

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat") || "");
  const lng = parseFloat(url.searchParams.get("lng") || "");
  const mode = (url.searchParams.get("mode") || "car").toLowerCase();
  const provider = (url.searchParams.get("provider") || "auto").toLowerCase();
  const debug = url.searchParams.get("debug") === "1";
  const mins = (url.searchParams.get("mins") || "")
    .split(",")
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 1200);

  // Resolve keys once; expose presence as booleans only (never the values).
  const keyOf = (name) => env[PROVIDERS[name].keyEnv] || "";
  const present = {};
  for (const name of Object.keys(PROVIDERS)) present[name] = !!keyOf(name);
  const dbg = (extra) => (debug ? extra : {});

  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return json({ error: "Missing or invalid lat/lng.", ...dbg({ env: present }) }, 400);
  }
  if (!mins.length) return json({ error: "Provide ?mins as comma-separated minutes.", ...dbg({ env: present }) }, 400);
  mins.sort((a, b) => a - b);

  const started = Date.now();
  let fellBack = false;

  try {
    let used, features;

    if (PROVIDERS[provider]) {
      // Explicit provider — give clear, specific errors instead of a generic fail.
      const p = PROVIDERS[provider];
      if (!present[provider])
        return json({ error: `Server is not configured: ${p.keyEnv} is missing.`, ...dbg({ env: present }) }, 500);
      if (!p.modes[mode])
        return json({ error: `${PRETTY[provider]} does not support this travel mode.`, ...dbg({ env: present }) }, 400);
      const cap = p.cap(mode);
      if (mins.some((m) => m > cap))
        return json({ error: `${PRETTY[provider]} supports up to ${cap} min for this mode.`, ...dbg({ env: present }) }, 400);
      used = provider;
      features = await p.run(lat, lng, p.modes[mode], mins, keyOf(provider), SOLO_TIMEOUT_MS);
    } else {
      // auto: walk the preference chain over providers usable for this request.
      const order = AUTO_ORDER.filter((n) => usable(n, present, mode, mins));
      if (!order.length)
        return json(
          { error: "No usable provider for this request (check keys, travel mode, or time limit).", ...dbg({ env: present }) },
          500,
        );
      let lastErr;
      for (let i = 0; i < order.length; i++) {
        const name = order[i];
        try {
          used = name;
          features = await PROVIDERS[name].run(lat, lng, PROVIDERS[name].modes[mode], mins, keyOf(name), AUTO_TIMEOUT_MS);
          fellBack = i > 0;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          features = null;
          console.error(`auto: ${name} failed (${e?.status} ${e?.msg}); trying next`);
        }
      }
      if (!features) throw lastErr || { status: 502, msg: "All providers failed." };
    }

    return json({ provider: used, mode, features, ...dbg({ _diag: { env: present, fellBack, ms: Date.now() - started } }) }, 200);
  } catch (e) {
    const status = (e && e.status) || 502;
    const msg = (e && e.msg) || (e && e.message) || "Upstream request failed.";
    const code = status === 401 || status === 403 || status === 429 || status === 504 ? status : 502;
    console.error(`range proxy failure: provider=${provider} mode=${mode} status=${status} msg=${msg}`);
    return json({ error: msg, upstreamStatus: status, provider, ...dbg({ env: present, ms: Date.now() - started }) }, code);
  }
};
