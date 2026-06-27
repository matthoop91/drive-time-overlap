/**
 * Worker entry for the drive-time overlap app (Cloudflare Workers + Static Assets).
 *
 * Routing:
 *   /api/range            -> handleRange() proxy (keys read from env, never exposed)
 *   everything else       -> static files from the `public/` assets binding
 *
 * Static assets are served from ./public (configured in wrangler.jsonc), so the
 * repo's .git/, src/, etc. are never published.
 */
import { handleRange } from "./range.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/range") return handleRange(request, env);
    return env.ASSETS.fetch(request);
  },
};
