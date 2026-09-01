import stockApp, { TradingState } from "./index.js";
import { runCryptoCycle, cryptoStatus } from "./crypto.js";
import { runCryptoOpportunityCycle, cryptoOpportunityProbe } from "./crypto-opportunity.js";
import { alpaca } from "./api.js";

export { TradingState };

const CRYPTO_ENTRY_BUILD = "crypto-entry-fix-v2";

function cryptoExecutionEnv(env) {
  return { ...env, CRYPTO_MIN_DOLLAR_VOLUME_USD: "0" };
}

async function cryptoLiveState(env) {
  const [positions, orders, account] = await Promise.all([
    alpaca(env, "/v2/positions"),
    alpaca(env, "/v2/orders?status=all&limit=500&direction=desc&nested=false"),
    alpaca(env, "/v2/account")
  ]);
  const cryptoOrders = (Array.isArray(orders) ? orders : []).filter(o => String(o.client_order_id || "").startsWith("papercrypto-"));
  const cryptoPositions = (Array.isArray(positions) ? positions : []).filter(p => String(p.asset_class || "").toLowerCase() === "crypto" || String(p.symbol || "").includes("/")).map(p => ({
    symbol: p.symbol,
    qty: +(p.qty || 0),
    marketValue: +(p.market_value || 0),
    avgEntryPrice: +(p.avg_entry_price || 0),
    currentPrice: +(p.current_price || 0),
    unrealizedPl: +(p.unrealized_pl || 0),
    unrealizedPlpc: +(p.unrealized_plpc || 0)
  }));
  return {
    endpoint: "paper",
    cryptoEntryBuild: CRYPTO_ENTRY_BUILD,
    cryptoAccountStatus: account?.crypto_status || null,
    cryptoPositionCount: cryptoPositions.length,
    cryptoPositions,
    cryptoBotOrderCount: cryptoOrders.length,
    lastCryptoBotOrderAt: cryptoOrders[0]?.submitted_at || null,
    recentCryptoBotOrders: cryptoOrders.slice(0, 20).map(o => ({
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      status: o.status,
      submittedAt: o.submitted_at,
      filledAt: o.filled_at || null,
      filledAvgPrice: +(o.filled_avg_price || 0),
      filledQty: +(o.filled_qty || 0),
      notional: +(o.notional || 0),
      clientOrderId: o.client_order_id
    }))
  };
}

const app = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/crypto/status") {
      try { return Response.json({ ...(await cryptoStatus(env)), cryptoEntryBuild: CRYPTO_ENTRY_BUILD }, { headers: { "Cache-Control": "no-store" } }); }
      catch (error) { return Response.json({ strategy: "crypto-profitability-v1", enabled: false, endpoint: "paper", market: "24x7", cryptoEntryBuild: CRYPTO_ENTRY_BUILD, error: error.message }, { status: 502, headers: { "Cache-Control": "no-store" } }); }
    }
    if (request.method === "GET" && url.pathname === "/api/crypto/live") {
      try { return Response.json(await cryptoLiveState(env), { headers: { "Cache-Control": "no-store" } }); }
      catch (error) { return Response.json({ endpoint: "paper", cryptoEntryBuild: CRYPTO_ENTRY_BUILD, error: error.message }, { status: 502, headers: { "Cache-Control": "no-store" } }); }
    }
    if (request.method === "GET" && url.pathname === "/api/crypto/opportunity") {
      try { return Response.json({ ...(await cryptoOpportunityProbe(cryptoExecutionEnv(env))), cryptoEntryBuild: CRYPTO_ENTRY_BUILD }, { headers: { "Cache-Control": "no-store" } }); }
      catch (error) { return Response.json({ endpoint: "paper", cryptoEntryBuild: CRYPTO_ENTRY_BUILD, error: error.message }, { status: 502, headers: { "Cache-Control": "no-store" } }); }
    }
    return stockApp.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof stockApp.scheduled === "function") stockApp.scheduled(controller, env, ctx);
    ctx.waitUntil((async () => {
      const primary = await runCryptoCycle(env, controller.scheduledTime);
      const bought = Array.isArray(primary?.actions) && primary.actions.some(a => a.action === "crypto_buy");
      if (!bought) await runCryptoOpportunityCycle(cryptoExecutionEnv(env), controller.scheduledTime);
    })().catch(error => console.error(JSON.stringify({ event: "crypto_cycle_failed", build: CRYPTO_ENTRY_BUILD, message: error.message }))));
  }
};

export default app;
