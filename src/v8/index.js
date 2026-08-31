import { STRATEGY, TECH, num, pct, int, bool, round, isBotOrder, etParts, entryWindowOpen, inConfiguredBlackout } from "./config.js";
import { alpaca, dynamicUniverse, fetchBars, fetchSnapshots, fetchAsset, recentNewsRisk, preferredFeed } from "./api.js";
import { timeframeSignal, combineSignals, marketRegime } from "./signals.js";
import { calculatePerformanceDetailed, botInventoryFromOrders, botLotsFromOrders, todayPerformance, recentCooldowns, adaptiveLearning } from "./performance.js";
import { cancelStaleBotOrders, exitDecision, placeLimitSell, placeLimitBuy, positionNotional } from "./execution.js";
import { ensureRealtimeState, getRealtimeMarket, overlayRealtimeSnapshot, updateHighWater, persistJournal, stateHealth } from "./state_client.js";
export { TradingState } from "./state.js";

async function runCycle(env, scheduledTime) {
  if (!env.APCA_API_KEY_ID || !env.APCA_API_SECRET_KEY) throw new Error("missing_alpaca_secrets");
  if (String(env.TRADING_ENABLED) !== "true") return { status: "disabled", endpoint: "paper", strategy: STRATEGY };

  const clock = await alpaca(env, "/v2/clock");
  if (!clock.is_open) return { status: "market_closed", endpoint: "paper", strategy: STRATEGY };

  const symbols = await dynamicUniverse(env);
  const snap = await fetchSnapshots(env, symbols);

  await ensureRealtimeState(env, symbols, snap.feed);
  const liveMarket = await getRealtimeMarket(env);

  const bundles = await Promise.all(symbols.map(async symbol => {
    try {
      const [m1, m5, m15] = await Promise.all([
        fetchBars(env, symbol, "1Min", 55),
        fetchBars(env, symbol, "5Min", 80),
        fetchBars(env, symbol, "15Min", 70)
      ]);
      const mergedSnapshot = overlayRealtimeSnapshot(snap.snapshots[symbol], liveMarket[symbol]);
      return [symbol, combineSignals(
        symbol,
        timeframeSignal(symbol, m1.bars),
        timeframeSignal(symbol, m5.bars),
        timeframeSignal(symbol, m15.bars),
        mergedSnapshot
      )];
    } catch (error) {
      console.log(JSON.stringify({ event: "symbol_data_failed", symbol, message: error.message }));
      return [symbol, { symbol, valid: false }];
    }
  }));

  const signals = bundles.map(x => x[1]).filter(s => s.valid);
  const map = new Map(signals.map(s => [s.symbol, s]));

  const [positions, openOrders, recentOrders, account] = await Promise.all([
    alpaca(env, "/v2/positions"),
    alpaca(env, "/v2/orders?status=open&direction=desc&nested=false"),
    alpaca(env, "/v2/orders?status=all&limit=500&direction=desc&nested=false"),
    alpaca(env, "/v2/account")
  ]);

  const actions = await cancelStaleBotOrders(env, openOrders, scheduledTime);
  const lots = botLotsFromOrders(recentOrders);
  const botPositions = positions.flatMap(position => {
    const lot = lots[position.symbol];
    if (!lot || !(lot.qty > 1e-8)) return [];
    const actualQty = Math.abs(+position.qty || 0);
    const botQty = Math.min(actualQty, lot.qty);
    if (!(botQty > 1e-8)) return [];
    return [{
      ...position,
      qty: String(botQty),
      avg_entry_price: String(lot.avgEntry || position.avg_entry_price),
      current_price: String(map.get(position.symbol)?.price || position.current_price)
    }];
  });
  const botOpen = new Set(openOrders.filter(isBotOrder).map(o => o.symbol));

  for (const position of botPositions) {
    if (botOpen.has(position.symbol)) continue;
    const decision = exitDecision(position, map.get(position.symbol), env, scheduledTime, etParts);
    if (decision.exit) {
      await placeLimitSell(env, position, map.get(position.symbol), scheduledTime, decision.reason);
      actions.push({ action: "sell", symbol: position.symbol, reason: decision.reason, pnlPct: round(decision.pnlPct, 5), botQty: +position.qty });
      botOpen.add(position.symbol);
    }
  }

  const equity = Math.max(1, +account.equity || 1);
  const last = Math.max(1, +account.last_equity || equity);
  const intradayDraw = Math.min(0, equity / last - 1);
  const persistent = await updateHighWater(env, equity);
  const highWaterDraw = Number.isFinite(+persistent?.drawdown) ? Math.min(0, +persistent.drawdown) : intradayDraw;
  const draw = Math.min(intradayDraw, highWaterDraw);

  const dd = draw <= -0.12 ? 0
    : draw <= -0.08 ? 0.35
    : draw <= -0.04 ? 0.65
    : 1;

  const perf = calculatePerformanceDetailed(recentOrders);
  const daily = todayPerformance(recentOrders, scheduledTime);
  const learn = adaptiveLearning(perf, num(env.MIN_ENTRY_SCORE, 82));

  const dailyLoss = daily.realizedPnl <= -(equity * pct(env.MAX_DAILY_LOSS_PCT, 0.01));
  const lossCount = daily.losses >= int(env.MAX_DAILY_LOSING_EXITS, 3);
  const consec = daily.maxConsecLoss >= int(env.MAX_CONSECUTIVE_LOSSES, 3);

  const regime = marketRegime(map);
  const cooldowns = recentCooldowns(recentOrders, scheduledTime, int(env.SYMBOL_COOLDOWN_MINUTES, 45));

  const maxSpread = pct(env.MAX_SPREAD_PCT, 0.0025);
  const maxAge = int(env.MAX_QUOTE_AGE_SECONDS, 20);
  const minDollarVolume = num(env.MIN_DOLLAR_VOLUME_USD, 25_000_000);
  const minQuoteSize = num(env.MIN_QUOTE_SIZE, 1);
  const minPrice = num(env.MIN_PRICE_USD, 5);

  const occupied = new Set(botPositions.map(p => p.symbol));
  const canRisk = entryWindowOpen(scheduledTime) &&
    !inConfiguredBlackout(env, scheduledTime) &&
    !dailyLoss && !lossCount && !consec &&
    dd > 0 && !regime.shock;

  const ranked = signals
    .filter(s =>
      !occupied.has(s.symbol) &&
      !botOpen.has(s.symbol) &&
      !cooldowns.has(s.symbol) &&
      !s.halted && !s.nearLuld &&
      s.price >= minPrice &&
      s.dollarVolume >= minDollarVolume &&
      s.bidSize >= minQuoteSize &&
      s.askSize >= minQuoteSize &&
      s.spreadPct <= maxSpread &&
      s.quoteAgeSec <= maxAge &&
      !s.chop
    )
    .sort((a, b) => Math.max(b.score, b.shortScore) - Math.max(a.score, a.shortScore));

  const newsBlocked = await recentNewsRisk(env, ranked.slice(0, 8).map(s => s.symbol), scheduledTime);
  const currentExposure = botPositions.reduce((sum, p) => sum + Math.abs((+p.qty || 0) * (+p.current_price || 0)), 0);
  const maxPositions = int(env.MAX_CONCURRENT_POSITIONS, 2);
  const maxTotal = num(env.MAX_TOTAL_EXPOSURE_USD, 10);

  let slots = Math.max(0, maxPositions - botPositions.length);
  let remaining = Math.max(0, maxTotal - currentExposure);
  let techCount = botPositions.filter(p => TECH.has(p.symbol)).length;
  const buyingPower = Math.max(0, +account.buying_power || 0);
  const assetCache = new Map();

  for (const candidate of ranked) {
    if (!canRisk || slots <= 0 || remaining < 1) break;
    if (newsBlocked.has(candidate.symbol)) continue;

    const longOk = regime.longOk && candidate.longConfirmed && candidate.score >= learn.scoreThreshold;
    const shortOk = bool(env.SHORTS_ENABLED, false) && regime.shortOk && candidate.shortConfirmed && candidate.shortScore >= learn.scoreThreshold;
    if (!longOk && !shortOk) continue;

    // The short signal framework is deliberately separate from the long execution path.
    // Fractional short sales are not used; short execution remains disabled until whole-share
    // sizing and a dedicated validation sample meet the configured risk limits.
    if (shortOk) continue;

    if (TECH.has(candidate.symbol) && techCount >= int(env.MAX_TECH_POSITIONS, 1)) continue;

    let asset = assetCache.get(candidate.symbol);
    if (asset === undefined) {
      asset = await fetchAsset(env, candidate.symbol);
      assetCache.set(candidate.symbol, asset);
    }
    if (!asset || asset.tradable === false || asset.fractionable === false || asset.status === "inactive") continue;

    const notional = Math.min(positionNotional(equity, candidate, env, learn, dd), remaining, buyingPower);
    if (notional < 1) continue;

    await placeLimitBuy(env, candidate, notional, scheduledTime);
    actions.push({
      action: "buy",
      symbol: candidate.symbol,
      reason: candidate.s5.pullback ? "mtf_pullback" : "mtf_breakout",
      score: round(candidate.score, 1),
      spreadPct: round(candidate.spreadPct, 5),
      notional: round(notional, 2)
    });

    slots--;
    remaining -= notional;
    botOpen.add(candidate.symbol);
    if (TECH.has(candidate.symbol)) techCount++;
  }

  const journal = {
    event: "decision_journal",
    ts: new Date(+scheduledTime).toISOString(),
    strategy: STRATEGY,
    feed: snap.feed,
    realtimeStream: Boolean(liveMarket && Object.keys(liveMarket).length),
    universe: symbols,
    regime,
    learning: learn,
    perf: {
      trades: perf.trades,
      winRate: round(perf.winRate, 3),
      profitFactor: round(perf.profitFactor, 2),
      expectancy: round(perf.expectancy, 4),
      avgLimitDeviation: round(perf.avgLimitDeviation, 5),
      bySetup: perf.bySetup
    },
    daily: {
      pnl: round(daily.realizedPnl, 2),
      losses: daily.losses,
      maxConsecLoss: daily.maxConsecLoss
    },
    risk: {
      intradayDrawdown: round(intradayDraw, 4),
      highWaterDrawdown: round(highWaterDraw, 4),
      drawdownMultiplier: dd,
      dailyLossGuard: dailyLoss,
      lossCountGuard: lossCount,
      consecutiveLossGuard: consec
    },
    leaders: ranked.slice(0, 6).map(s => ({
      symbol: s.symbol,
      score: round(s.score, 1),
      shortScore: round(s.shortScore, 1),
      spread: round(s.spreadPct, 5),
      rvol: round(s.rvol, 2),
      rsi: round(s.rsi, 1),
      dollarVolume: round(s.dollarVolume, 0),
      halted: s.halted,
      nearLuld: s.nearLuld
    })),
    actions
  };

  console.log(JSON.stringify(journal));
  await persistJournal(env, journal);

  return {
    status: actions.length ? "acted" : "hold",
    endpoint: "paper",
    strategy: STRATEGY,
    feed: snap.feed,
    realtimeStream: journal.realtimeStream,
    universe: symbols,
    regime,
    learning: learn,
    daily: journal.daily,
    risk: journal.risk,
    actions,
    leaders: journal.leaders
  };
}

const esc = v => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const money = v => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(+v || 0);
const percent = v => `${((+v || 0) * 100).toFixed(2)}%`;

async function digest(v) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))); }
async function secureEqual(l, r) {
  const [a, b] = await Promise.all([digest(l), digest(r)]);
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function auth(req, env) {
  if (!env.DASHBOARD_PASSWORD) return false;
  const a = req.headers.get("Authorization");
  if (!a?.startsWith("Basic ")) return false;
  try {
    const d = atob(a.slice(6)), i = d.indexOf(":");
    return i >= 0 && secureEqual(d.slice(i + 1), env.DASHBOARD_PASSWORD);
  } catch { return false; }
}

async function dashboard(env) {
  const [orders, positions, account] = await Promise.all([
    alpaca(env, "/v2/orders?status=all&limit=500&direction=desc&nested=false"),
    alpaca(env, "/v2/positions"),
    alpaca(env, "/v2/account")
  ]);
  const perf = calculatePerformanceDetailed(orders), lots = botLotsFromOrders(orders);
  const botPositions = positions.filter(p => lots[p.symbol]?.qty > 1e-8);
  const unrealized = botPositions.reduce((sum, p) => {
    const lot = lots[p.symbol], qty = Math.min(Math.abs(+p.qty || 0), lot?.qty || 0), price = +p.current_price || 0;
    return sum + qty * (price - (lot?.avgEntry || price));
  }, 0);
  const state = await stateHealth(env);
  const rows = orders.filter(isBotOrder).slice(0, 40).map(o =>
    `<tr><td>${esc(o.submitted_at ? new Date(o.submitted_at).toLocaleString("en-US", { timeZone: "America/New_York" }) : "—")}</td><td>${esc(o.symbol)}</td><td>${esc(String(o.side || "").toUpperCase())}</td><td>${esc(o.type)}</td><td>${esc(o.status)}</td><td>${o.filled_avg_price ? money(o.filled_avg_price) : "—"}</td></tr>`
  ).join("");

  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>Adaptive Paper Trader v8</title><style>:root{color-scheme:dark;--bg:#0b1020;--card:#151c32;--line:#2a3557;--text:#eef3ff;--muted:#9eabc9;--green:#2dd4a8}*{box-sizing:border-box}body{margin:0;background:var(--bg);font:15px system-ui;color:var(--text)}main{max-width:1250px;margin:auto;padding:28px 18px 50px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:17px}.label{color:var(--muted);font-size:12px;text-transform:uppercase}.value{font-size:23px;font-weight:750;margin-top:7px}.small{font-size:13px;color:var(--muted);margin-top:7px}header{display:flex;justify-content:space-between;gap:15px;align-items:center;margin-bottom:22px}.badge{border:1px solid var(--green);color:var(--green);padding:7px 11px;border-radius:999px;font-weight:700}table{width:100%;border-collapse:collapse;background:var(--card);margin-top:22px}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px}</style></head><body><main><header><div><h1>Alpaca Adaptive Intraday Guard v8</h1><div class="small">Paper-only · realtime stream + 1m/5m/15m confirmation · spread/liquidity/halt protection · adaptive risk</div></div><div class="badge">${String(env.TRADING_ENABLED) === "true" ? "ARMED" : "DISABLED"}</div></header><div class="grid"><div class="card"><div class="label">Paper equity</div><div class="value">${money(account.equity)}</div><div class="small">Buying power ${money(account.buying_power)}</div></div><div class="card"><div class="label">Realized bot P&L</div><div class="value">${money(perf.realizedPnl)}</div><div class="small">${perf.trades} completed exits</div></div><div class="card"><div class="label">Open bot P&L</div><div class="value">${money(unrealized)}</div><div class="small">${botPositions.length} isolated bot positions</div></div><div class="card"><div class="label">Win rate</div><div class="value">${percent(perf.winRate)}</div><div class="small">${perf.wins} wins / ${perf.losses} losses</div></div><div class="card"><div class="label">Profit factor</div><div class="value">${Number(perf.profitFactor || 0).toFixed(2)}</div><div class="small">Expectancy ${money(perf.expectancy)}</div></div><div class="card"><div class="label">Realtime stream</div><div class="value">${state?.connected ? "LIVE" : "FALLBACK"}</div><div class="small">${esc((state?.stream?.feed || preferredFeed(env)).toUpperCase())} · high-water ${money(state?.highWaterEquity || 0)}</div></div></div><table><thead><tr><th>Time ET</th><th>Symbol</th><th>Side</th><th>Order</th><th>Status</th><th>Fill</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No bot orders yet.</td></tr>'}</tbody></table><div class="small" style="margin-top:16px">Paper simulation only. No strategy can guarantee profit.</div></main></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const app = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return Response.json({ error: "not_found" }, { status: 404 });

    if (url.pathname === "/api/status") {
      const state = await stateHealth(env);
      return Response.json({
        service: "alpaca-paper-guard",
        strategy: STRATEGY,
        status: String(env.TRADING_ENABLED) === "true" ? "armed" : "disabled",
        endpoint: "paper",
        features: {
          dynamicScanner: bool(env.DYNAMIC_SCANNER_ENABLED, true),
          marketDataFeed: preferredFeed(env),
          realtimeWebSocketRelay: bool(env.REALTIME_STREAM_ENABLED, true),
          realtimeStreamConnected: Boolean(state?.connected),
          persistentState: bool(env.PERSISTENT_STATE_ENABLED, true),
          multiTimeframe: ["1Min", "5Min", "15Min"],
          liveQuoteGuard: true,
          spreadGuard: true,
          staleQuoteGuard: true,
          liquidityGuard: true,
          haltLuldGuard: true,
          assetEligibilityGuard: true,
          marketableLimitOrders: true,
          dynamicRiskSizing: true,
          dynamicAtrExits: true,
          regimeFilter: true,
          chopFilter: true,
          newsRiskFilter: bool(env.NEWS_RISK_FILTER_ENABLED, true),
          adaptiveLearning: true,
          rollingWalkForward: true,
          drawdownGovernor: true,
          persistentHighWater: true,
          durableDecisionJournal: true,
          botPositionIsolation: true,
          shortStrategyFramework: bool(env.SHORTS_ENABLED, false)
        },
        safeguards: {
          minEntryScore: num(env.MIN_ENTRY_SCORE, 82),
          maxConcurrentPositions: int(env.MAX_CONCURRENT_POSITIONS, 2),
          maxDailyLossPct: pct(env.MAX_DAILY_LOSS_PCT, 0.01),
          maxDailyLosingExits: int(env.MAX_DAILY_LOSING_EXITS, 3),
          maxConsecutiveLosses: int(env.MAX_CONSECUTIVE_LOSSES, 3),
          symbolCooldownMinutes: int(env.SYMBOL_COOLDOWN_MINUTES, 45),
          maxSpreadPct: pct(env.MAX_SPREAD_PCT, 0.0025),
          maxQuoteAgeSeconds: int(env.MAX_QUOTE_AGE_SECONDS, 20),
          minDollarVolume: num(env.MIN_DOLLAR_VOLUME_USD, 25_000_000),
          minQuoteSize: num(env.MIN_QUOTE_SIZE, 1),
          minPriceUsd: num(env.MIN_PRICE_USD, 5)
        }
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/state") {
      return Response.json(await stateHealth(env) || { connected: false, persistentState: false }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname !== "/") return Response.json({ error: "not_found" }, { status: 404 });
    if (!env.DASHBOARD_PASSWORD) return Response.json({ error: "dashboard_password_not_configured" }, { status: 503 });
    if (!await auth(request, env)) return new Response("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Alpaca Paper Guard"', "Cache-Control": "no-store" } });

    try { return await dashboard(env); }
    catch (error) {
      console.error(JSON.stringify({ event: "dashboard_failed", message: error.message }));
      return Response.json({ error: "dashboard_unavailable" }, { status: 502 });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCycle(env, controller.scheduledTime)
      .then(result => console.log(JSON.stringify({ event: "cycle_complete", ...result })))
      .catch(error => console.error(JSON.stringify({ event: "cycle_failed", message: error.message }))));
  }
};

export default app;
