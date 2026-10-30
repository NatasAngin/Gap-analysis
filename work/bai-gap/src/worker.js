import { onRequest } from "../functions/api/[[path]].js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Keep API requests on the existing authenticated D1-backed handler.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return onRequest({
        request,
        env,
        params: {},
        data: {},
        waitUntil: ctx.waitUntil.bind(ctx),
      });
    }

    // Serve the existing static frontend from the Workers Assets binding.
    return env.ASSETS.fetch(request);
  },
};
