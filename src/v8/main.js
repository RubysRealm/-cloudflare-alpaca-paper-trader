import stockApp, { TradingState } from "./index.js";
import { runCryptoCycle, cryptoStatus } from "./crypto.js";

export { TradingState };

const app = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/crypto/status") {
      try { return Response.json(await cryptoStatus(env), { headers: { "Cache-Control": "no-store" } }); }
      catch (error) { return Response.json({ strategy: "crypto-profitability-v1", enabled: false, endpoint: "paper", market: "24x7", error: error.message }, { status: 502, headers: { "Cache-Control": "no-store" } }); }
    }
    return stockApp.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof stockApp.scheduled === "function") stockApp.scheduled(controller, env, ctx);
    ctx.waitUntil(runCryptoCycle(env, controller.scheduledTime).catch(error => console.error(JSON.stringify({ event: "crypto_cycle_failed", message: error.message }))));
  }
};

export default app;
