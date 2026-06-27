# drive-time-overlap

Mobile-friendly web app to drop several locations on a map, give each its own
travel time, and measure where the reachable areas overlap.

- **Map / UI:** Leaflet + OpenStreetMap tiles, Nominatim search, bottom-sheet UI.
- **Geometry:** Turf.js for area and intersection.
- **Routing:** pluggable providers — Mapbox Isochrone, OpenRouteService (ORS),
  HERE Isoline, ArcGIS Service Areas, and TomTom *Calculate Reachable Range* —
  selectable per request.

## How it works

- Each location is an independent routing request, so its travel time is never
  shared with another location.
- Each location runs at up to three nested time bands; only the **outer** band
  is used for the overlap, the inner bands are drawn for context.
- The overlap of every location's outer area is shaded and its area is shown.
- Providers:
  - **Mapbox** — detailed shapes, fast; capped at 60 min (Mapbox limit).
  - **ORS** — detailed shapes; driving capped at 60 min, other modes up to 5 h.
  - **HERE** — detailed shapes, long range (up to 5 h).
  - **ArcGIS** — detailed drive-time service areas (driving only), long range.
  - **TomTom** — coarser, traffic-aware shapes; up to 5 h (3 h driving works).
  - **Auto** — prefers fast detailed Mapbox ≤60 min, then HERE/ORS/ArcGIS
    (detailed) and finally TomTom for long drives. The slider cap adjusts.
- **Compare** (⚖ on a location): runs *every* configured provider for that point
  and time, overlays each boundary on the map in its own colour, and ranks them
  by reachable area so you can see how the providers' extents differ.

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

The five keys read at runtime are `MAPBOX_TOKEN`, `ORS_KEY`, `HERE_KEY`,
`ARCGIS_KEY`, `TOMTOM_KEY`. **Any provider whose key is absent is simply
skipped**, so you can run with only the ones you have.

## Deploy

Git-connected Cloudflare Worker (free, no card). The build runs `wrangler deploy`,
which reads `wrangler.jsonc`.

1. **Workers & Pages → Create → Workers → Connect to Git** → pick this repo.
   No build settings to change — `wrangler.jsonc` defines everything.
2. Make the keys available to the running Worker. Either:
   - add them under **Settings → Variables and Secrets** (type Secret); or
   - set them as **Build variables** and pass them through in the deploy command:
     ```
     npx wrangler deploy --var MAPBOX_TOKEN:"$MAPBOX_TOKEN" --var ORS_KEY:"$ORS_KEY" \
       --var HERE_KEY:"$HERE_KEY" --var ARCGIS_KEY:"$ARCGIS_KEY" --var TOMTOM_KEY:"$TOMTOM_KEY"
     ```
   Re-deploy after changing keys so they take effect.
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
HERE_KEY=...
ARCGIS_KEY=...
TOMTOM_KEY=...
```
