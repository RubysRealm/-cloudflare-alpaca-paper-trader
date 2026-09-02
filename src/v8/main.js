import stockApp, { TradingState } from "./index.js";
import { runCryptoCycle, cryptoStatus, CRYPTO_STRATEGY, CRYPTO_ORDER_PREFIX } from "./crypto-revenue.js";
import { alpaca } from "./api.js";

export { TradingState };

const CRYPTO_ENTRY_BUILD = "crypto-revenue-v4";

function cryptoOrderPerformance(orders) {
  const inv = {}, closed = [];
  for (const o of [...orders].filter(o => o.status === "filled" && o.filled_at && o.filled_avg_price).sort((a,b) => String(a.filled_at).localeCompare(String(b.filled_at)))) {
    const symbol = String(o.symbol || "").replace("/", "").toUpperCase();
    const qty = Math.abs(+o.filled_qty || 0), price = +o.filled_avg_price || 0;
    if (!(qty > 0 && price > 0)) continue;
    const x = inv[symbol] ||= { qty: 0, cost: 0 };
    if (o.side === "buy") { x.qty += qty; x.cost += qty * price; continue; }
    if (!(x.qty > 0)) continue;
    const sold = Math.min(qty, x.qty), avg = x.cost / x.qty, pnl = sold * (price - avg);
    closed.push({ symbol, pnl, at: o.filled_at });
    x.qty -= sold; x.cost -= sold * avg;
    if (x.qty < 1e-8) { x.qty = 0; x.cost = 0; }
  }
  const wins = closed.filter(x => x.pnl > 0), losses = closed.filter(x => x.pnl < 0);
  const grossWin = wins.reduce((a,x) => a + x.pnl, 0), grossLoss = losses.reduce((a,x) => a + Math.abs(x.pnl), 0), realizedPnl = closed.reduce((a,x) => a + x.pnl, 0);
  return {
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    realizedPnl,
    expectancy: closed.length ? realizedPnl / closed.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin > 0 ? 99 : 0
  };
}

async function cryptoLiveState(env) {
  const [positions, orders, account] = await Promise.all([
    alpaca(env, "/v2/positions"),
    alpaca(env, "/v2/orders?status=all&limit=500&direction=desc&nested=false"),
    alpaca(env, "/v2/account")
  ]);
  const allBotOrders = (Array.isArray(orders) ? orders : []).filter(o => String(o.client_order_id || "").startsWith("papercrypto-"));
  const currentOrders = allBotOrders.filter(o => String(o.client_order_id || "").startsWith(CRYPTO_ORDER_PREFIX));
  const legacyOrders = allBotOrders.filter(o => !String(o.client_order_id || "").startsWith(CRYPTO_ORDER_PREFIX));
  const rawCryptoPositions = (Array.isArray(positions) ? positions : []).filter(p => String(p.asset_class || "").toLowerCase() === "crypto" || String(p.symbol || "").includes("/"));
  const cryptoPositions = rawCryptoPositions.map(p => ({
    symbol: p.symbol,
    qty: +(p.qty || 0),
    marketValue: +(p.market_value || 0),
    avgEntryPrice: +(p.avg_entry_price || 0),
    currentPrice: +(p.current_price || 0),
    unrealizedPl: +(p.unrealized_pl || 0),
    unrealizedPlpc: +(p.unrealized_plpc || 0)
  }));
  const meaningful = cryptoPositions.filter(p => Math.abs(p.marketValue || p.qty * p.currentPrice) > 1);
  return {
    endpoint: "paper",
    strategy: CRYPTO_STRATEGY,
    cryptoEntryBuild: CRYPTO_ENTRY_BUILD,
    orderPrefix: CRYPTO_ORDER_PREFIX,
    exitPolicy: "normal_exits_require_net_profit",
    legacyExecutionActive: false,
    cryptoAccountStatus: account?.crypto_status || null,
    cryptoPositionCount: meaningful.length,
    rawCryptoPositionCount: cryptoPositions.length,
    cryptoPositions: meaningful,
    dustPositions: cryptoPositions.filter(p => Math.abs(p.marketValue || p.qty * p.currentPrice) <= 1),
    currentStrategyOrderCount: currentOrders.length,
    legacyHistoricalOrderCount: legacyOrders.length,
    lastCurrentStrategyOrderAt: currentOrders[0]?.submitted_at || null,
    performance: cryptoOrderPerformance(currentOrders),
    recentCurrentStrategyOrders: currentOrders.slice(0, 20).map(o => ({
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      status: o.status,
      submittedAt: o.submitted_at,
      filledAt: o.filled_at || null,
      filledAvgPrice: +(o.filled_avg_price || 0),
      filledQty: +(o.filled_qty || 0),
      notional: +(o.notional || 0),
      limitPrice: +(o.limit_price || 0),
      clientOrderId: o.client_order_id
    }))
  };
}

const app = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/crypto/status") {
      try { return Response.json({ ...(await cryptoStatus(env)), cryptoEntryBuild: CRYPTO_ENTRY_BUILD }, { headers: { "Cache-Control": "no-store" } }); }
      catch (error) { return Response.json({ strategy: CRYPTO_STRATEGY, enabled: false, endpoint: "paper", market: "24x7", cryptoEntryBuild: CRYPTO_ENTRY_BUILD, error: error.message }, { status: 502, headers: { "Cache-Control": "no-store" } }); }
    }
    if (request.method === "GET" && url.pathname === "/api/crypto/live") {
      try { return Response.json(await cryptoLiveState(env), { headers: { "Cache-Control": "no-store" } }); }
      catch (error) { return Response.json({ strategy: CRYPTO_STRATEGY, endpoint: "paper", cryptoEntryBuild: CRYPTO_ENTRY_BUILD, error: error.message }, { status: 502, headers: { "Cache-Control": "no-store" } }); }
    }
    if (request.method === "GET" && url.pathname === "/api/portfolio/history") {
      try {
        const history = await alpaca(env, "/v2/account/portfolio/history?period=1D&timeframe=1Min&intraday_reporting=continuous&pnl_reset=no_reset");
        return Response.json(history, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        return Response.json({ endpoint: "paper", error: error.message }, { status: 502, headers: { "Cache-Control": "no-store" } });
      }
    }
    return stockApp.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof stockApp.scheduled === "function") stockApp.scheduled(controller, env, ctx);
    ctx.waitUntil(runCryptoCycle(env, controller.scheduledTime).catch(error => console.error(JSON.stringify({ event: "crypto_cycle_failed", build: CRYPTO_ENTRY_BUILD, message: error.message }))));
  }
};

export default app;
