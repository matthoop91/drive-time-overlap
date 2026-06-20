# drive-time-overlap

Mobile-friendly web app to drop several locations on a map, give each its own
travel time, and measure where the reachable areas overlap.

- **Map / UI:** Leaflet + OpenStreetMap tiles, Nominatim search, bottom-sheet UI.
- **Geometry:** Turf.js for area and intersection.
- **Routing:** TomTom Routing API — *Calculate Reachable Range*.

## How it works

- Each location is an independent TomTom request, so its travel time is never
  shared with another location.
- TomTom returns one polygon per request, so each visual band (15 / 30 / 60 / …
  minutes) is its own call. Only the **outer** band is used for the overlap.
- The overlap of every location's outer area is shaded and its area is shown.

## Architecture

This is a static `index.html` plus one Netlify serverless function:

```
index.html                     # the whole front-end
netlify/functions/range.mts    # proxy: /api/range -> TomTom (hides the key)
netlify.toml                   # publish dir + functions dir
```

The TomTom key is **never** in the page source. It lives only in the
`TOMTOM_KEY` environment variable on Netlify, and the browser calls the
`/api/range` proxy instead of TomTom directly.

## Deploy

1. Deploy this repo to Netlify (static site; functions are auto-detected).
2. In Netlify → Site configuration → Environment variables, add:
   - `TOMTOM_KEY` = your TomTom API key.
3. Open the site's Netlify URL. (The `/api/range` proxy only runs on Netlify,
   so opening `index.html` as a local file won't fetch areas.)

## Local development

```
npm i -g netlify-cli   # once
netlify dev            # serves index.html and the function locally
```
Set `TOMTOM_KEY` in your environment or a local `.env` for `netlify dev`.
