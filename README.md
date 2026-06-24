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

This is a static `index.html` plus one Cloudflare Pages Function:

```
index.html                # the whole front-end
functions/api/range.js    # proxy: /api/range -> Mapbox / ORS / TomTom (hides keys)
```

API keys are **never** in the page source. They live only in environment
variables on Cloudflare (`MAPBOX_TOKEN`, `ORS_KEY`, `TOMTOM_KEY`), and the
browser calls the same-origin `/api/range` proxy instead of the upstreams
directly. The proxy is a provider registry — adding a new provider (e.g. ArcGIS)
means adding one entry plus, if it should be auto-selectable, listing it in
`AUTO_ORDER`.

Why Cloudflare Pages: its Workers runtime does not count time spent awaiting
`fetch()` against its limits, so slow upstreams (e.g. ORS's 60-min driving
isochrone) complete — unlike Netlify's hard 10 s function cap.

## Deploy

1. Create a Cloudflare Pages project connected to this repo (free, no card).
   - **Build command:** none. **Build output directory:** `/` (repo root).
2. In Pages → Settings → Environment variables, add (Production + Preview):
   - `MAPBOX_TOKEN` = your Mapbox access token
   - `ORS_KEY` = your OpenRouteService API key
   - `TOMTOM_KEY` = your TomTom API key
   - (Any provider whose key is missing is simply skipped.)
3. Open the site's `*.pages.dev` URL. (The `/api/range` proxy only runs when
   served by Pages, so opening `index.html` as a local file won't fetch areas.)

## Local development

```
npm i -g wrangler              # once
wrangler pages dev .           # serves index.html and functions/ locally
```

Provide the keys to `wrangler pages dev` via a `.dev.vars` file in the repo root:

```
MAPBOX_TOKEN=...
ORS_KEY=...
TOMTOM_KEY=...
```
