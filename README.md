# drive-time-overlap

Mobile-friendly web app to drop several locations on a map, give each its own
travel time, and measure where the reachable areas overlap.

- **Map / UI:** Leaflet + OpenStreetMap tiles, Nominatim search, bottom-sheet UI.
- **Geometry:** Turf.js for area and intersection.
- **Routing:** pluggable providers — Mapbox Isochrone, OpenRouteService (ORS),
  and TomTom *Calculate Reachable Range* — selectable per request.

## How it works

- Each location is an independent routing request, so its travel time is never
  shared with another location.
- Each location runs at up to three nested time bands; only the **outer** band
  is used for the overlap, the inner bands are drawn for context.
- The overlap of every location's outer area is shaded and its area is shown.
- Providers:
  - **Mapbox** — detailed shapes, fast; capped at 60 min (Mapbox limit).
  - **ORS** — detailed shapes; driving capped at 60 min, other modes up to 5 h.
  - **TomTom** — coarser, traffic-aware shapes; up to 5 h (3 h driving works).
  - **Auto** — prefers fast detailed Mapbox where allowed, falls back to TomTom
    for longer drives. The travel-time slider cap adjusts to the chosen provider.

## Architecture

This is a Cloudflare **Worker + Static Assets** project:

```
public/index.html         # the whole front-end (only this folder is published)
src/worker.js             # entry: routes /api/range, else serves public/ assets
src/range.js              # proxy logic: Mapbox / ORS / TomTom (hides keys)
wrangler.jsonc            # name, main, compatibility_date, assets binding
```

The Worker serves `/api/range` itself and falls through to the `public/` assets
binding for everything else. Only `public/` is published, so `.git/`, `src/`,
etc. are never exposed.

API keys are **never** in the page source. They live only in environment
variables on Cloudflare (`MAPBOX_TOKEN`, `ORS_KEY`, `TOMTOM_KEY`), and the
browser calls the same-origin `/api/range` proxy instead of the upstreams
directly. The proxy is a provider registry — adding a new provider (e.g. ArcGIS)
means adding one entry plus, if it should be auto-selectable, listing it in
`AUTO_ORDER`.

Why Cloudflare: its Workers runtime does not count time spent awaiting `fetch()`
against its limits, so slow upstreams (e.g. ORS's 60-min driving isochrone)
complete — unlike Netlify's hard 10 s function cap.

## Deploy

Git-connected Cloudflare Worker (free, no card). The build runs
`npx wrangler deploy`, which reads `wrangler.jsonc`.

1. **Workers & Pages → Create → Workers → Connect to Git** → pick this repo.
   No build settings to change — `wrangler.jsonc` defines everything.
2. In the Worker's **Settings → Variables and Secrets**, add (encrypt as
   Secret): `MAPBOX_TOKEN`, `ORS_KEY`, `TOMTOM_KEY`. Any provider whose key is
   missing is simply skipped. Re-deploy after adding so they take effect.
3. Open the site's `*.workers.dev` URL.

## Local development

```
npm i -g wrangler        # once
wrangler dev             # serves public/ + the /api/range route locally
```

Provide the keys to `wrangler dev` via a `.dev.vars` file in the repo root:

```
MAPBOX_TOKEN=...
ORS_KEY=...
TOMTOM_KEY=...
```
