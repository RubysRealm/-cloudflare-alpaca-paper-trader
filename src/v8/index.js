import { STRATEGY, TECH, INVERSE, BULL_LEVERAGED, num, pct, int, bool, round, isBotOrder, etParts, entryWindowOpen, inConfiguredBlackout } from "./config.js";
import { alpaca, dynamicUniverse, fetchBars, fetchSnapshots, fetchAsset, recentNewsRisk, preferredFeed } from "./api.js";
import { timeframeSignal, combineSignals, marketRegime } from "./signals.js";
import { calculatePerformanceDetailed, botLotsFromOrders, todayPerformance, recentCooldowns, adaptiveLearning } from "./performance.js";
import { cancelStaleBotOrders, exitDecision, placeLimitSell, placeLimitBuy, positionNotional } from "./execution.js";
import { ensureRealtimeState, getRealtimeMarket, overlayRealtimeSnapshot, updateHighWater, persistJournal, stateHealth } from "./state_client.js";
import { discordConsensus, applyDiscordConsensus } from "./external_signals.js";
export { TradingState } from "./state.js";

function directionBucket(symbol) {
  if (INVERSE.has(symbol)) return "inverse";
  if (BULL_LEVERAGED.has(symbol)) return "bull_leveraged";
  return "regular";
}

function requiredScore(candidate, regime, learning) {
  const base = Math.max(78, learning.scoreThreshold || 82);
  const bucket = directionBucket(candidate.symbol);
  if (bucket === "inverse") {
    if (regime.mode === "bear") return Math.max(base, 82);
    if (regime.mode === "sideways" && regime.breadth <= -0.05) return Math.max(base + 6, 88);
    return Infinity;
  }
  if (bucket === "bull_leveraged") {
    return regime.mode === "bull" ? Math.max(base + 3, 85) : Infinity;
  }
  if (regime.mode === "bull") return base;
  if (regime.mode === "sideways") return Math.max(base + 6, 88);
  if (regime.mode === "bear") return Math.max(base + 12, 94);
  return Math.max(base + 4, 86);
}

function regimeExit(position, signal, regime) {
  const bucket = directionBucket(position.symbol);
  if (bucket === "inverse" && regime.mode === "bull") return "regime_conflict";
  if (bucket === "bull_leveraged" && regime.mode !== "bull") return "regime_conflict";
  if (bucket === "regular" && regime.mode === "bear" && (!signal || signal.score < 94 || !signal.longAligned)) return "regime_weakness";
  return null;
}

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
      const merged = overlayRealtimeSnapshot(snap.snapshots[symbol], liveMarket[symbol]);
      return combineSignals(symbol, timeframeSignal(symbol, m1.bars), timeframeSignal(symbol, m5.bars), timeframeSignal(symbol, m15.bars), merged);
    } catch (error) {
      console.log(JSON.stringify({ event: "symbol_data_failed", symbol, message: error.message }));
      return { symbol, valid: false };
    }
  }));

  const rawSignals = bundles.filter(s => s.valid);
  const discord = await discordConsensus(env, symbols, scheduledTime);
  const signals = rawSignals.map(s => applyDiscordConsensus(s, discord.votes.get(s.symbol)));
  const map = new Map(signals.map(s => [s.symbol, s]));
  const regime = marketRegime(map);

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
    const actualQty = Math.abs(+position.qty || 0), botQty = Math.min(actualQty, lot.qty);
    if (!(botQty > 1e-8)) return [];
    return [{ ...position, qty: String(botQty), avg_entry_price: String(lot.avgEntry || position.avg_entry_price), current_price: String(map.get(position.symbol)?.price || position.current_price) }];
  });
  const botOpen = new Set(openOrders.filter(isBotOrder).map(o => o.symbol));

  for (const position of botPositions) {
    if (botOpen.has(position.symbol)) continue;
    const signal = map.get(position.symbol);
    const forcedReason = regimeExit(position, signal, regime);
    const decision = forcedReason ? { exit: true, reason: forcedReason, pnlPct: (+position.avg_entry_price > 0 ? (+position.current_price / +position.avg_entry_price - 1) : 0) } : exitDecision(position, signal, env, scheduledTime, etParts);
    if (!decision.exit) continue;
    try {
      await placeLimitSell(env, position, signal, scheduledTime, decision.reason);
      actions.push({ action: "sell", symbol: position.symbol, reason: decision.reason, pnlPct: round(decision.pnlPct, 5), botQty: +position.qty });
      botOpen.add(position.symbol);
    } catch (error) {
      console.log(JSON.stringify({ event: "exit_failed", symbol: position.symbol, reason: decision.reason, message: error.message }));
    }
  }

  const equity = Math.max(1, +account.equity || 1), last = Math.max(1, +account.last_equity || equity);
  const intradayDraw = Math.min(0, equity / last - 1);
  const persistent = await updateHighWater(env, equity);
  const highWaterDraw = Number.isFinite(+persistent?.drawdown) ? Math.min(0, +persistent.drawdown) : intradayDraw;
  const draw = Math.min(intradayDraw, highWaterDraw);
  const dd = draw <= -0.10 ? 0 : draw <= -0.06 ? 0.35 : draw <= -0.035 ? 0.65 : 1;

  const perf = calculatePerformanceDetailed(recentOrders);
  const daily = todayPerformance(recentOrders, scheduledTime);
  const learn = adaptiveLearning(perf, num(env.MIN_ENTRY_SCORE, 82));
  const dailyLoss = daily.realizedPnl <= -(equity * pct(env.MAX_DAILY_LOSS_PCT, 0.0125));
  const lossCount = daily.losses >= int(env.MAX_DAILY_LOSING_EXITS, 4);
  const consec = daily.maxConsecLoss >= int(env.MAX_CONSECUTIVE_LOSSES, 3);
  const cooldowns = recentCooldowns(recentOrders, scheduledTime, int(env.SYMBOL_COOLDOWN_MINUTES, 10));

  const maxSpread = pct(env.MAX_SPREAD_PCT, 0.003), maxAge = int(env.MAX_QUOTE_AGE_SECONDS, 20), minDollarVolume = num(env.MIN_DOLLAR_VOLUME_USD, 10_000_000), minQuoteSize = num(env.MIN_QUOTE_SIZE, 1), minPrice = num(env.MIN_PRICE_USD, 1);
  const occupied = new Set(botPositions.map(p => p.symbol));
  const canRisk = entryWindowOpen(scheduledTime) && !inConfiguredBlackout(env, scheduledTime) && !dailyLoss && !lossCount && !consec && dd > 0 && !regime.shock;

  const ranked = signals.filter(s => !occupied.has(s.symbol) && !botOpen.has(s.symbol) && !cooldowns.has(s.symbol) && !s.halted && !s.nearLuld && s.price >= minPrice && s.dollarVolume >= minDollarVolume && s.bidSize >= minQuoteSize && s.askSize >= minQuoteSize && s.spreadPct <= maxSpread && s.quoteAgeSec <= maxAge && !s.chop).sort((a, b) => b.score - a.score);
  const newsBlocked = await recentNewsRisk(env, ranked.slice(0, 16).map(s => s.symbol), scheduledTime);

  const currentExposure = botPositions.reduce((sum, p) => sum + Math.abs((+p.qty || 0) * (+p.current_price || 0)), 0);
  const maxPositions = int(env.MAX_CONCURRENT_POSITIONS, 4), maxTotal = num(env.MAX_TOTAL_EXPOSURE_USD, 100000), maxNew = int(env.MAX_NEW_ENTRIES_PER_CYCLE, 1);
  let slots = Math.max(0, maxPositions - botPositions.length), remaining = Math.max(0, maxTotal - currentExposure), techCount = botPositions.filter(p => TECH.has(p.symbol)).length, newEntries = 0;
  const buyingPower = Math.max(0, +account.buying_power || 0), assetCache = new Map();
  let inverseHeld = botPositions.some(p => INVERSE.has(p.symbol));
  let directionalHeld = botPositions.some(p => !INVERSE.has(p.symbol));

  for (const candidate of ranked) {
    if (!canRisk || slots <= 0 || remaining < 1 || newEntries >= maxNew) break;
    if (newsBlocked.has(candidate.symbol) || !candidate.longConfirmed) continue;
    const threshold = requiredScore(candidate, regime, learn);
    if (!Number.isFinite(threshold) || candidate.score < threshold) continue;

    const bucket = directionBucket(candidate.symbol);
    if (bucket === "inverse" && directionalHeld) continue;
    if (bucket !== "inverse" && inverseHeld) continue;
    if (TECH.has(candidate.symbol) && techCount >= int(env.MAX_TECH_POSITIONS, 2)) continue;

    let asset = assetCache.get(candidate.symbol);
    if (asset === undefined) { asset = await fetchAsset(env, candidate.symbol); assetCache.set(candidate.symbol, asset); }
    if (!asset || asset.tradable === false || asset.fractionable === false || asset.status === "inactive") continue;

    const notional = Math.min(positionNotional(equity, candidate, env, learn, dd), remaining, buyingPower);
    if (notional < 1) continue;
    try {
      await placeLimitBuy(env, candidate, notional, scheduledTime);
      actions.push({ action: "buy", symbol: candidate.symbol, reason: candidate.discord?.longSources >= 2 ? "consensus_edge" : "ranked_edge", score: round(candidate.score, 1), threshold: round(threshold, 1), regime: regime.mode, spreadPct: round(candidate.spreadPct, 5), notional: round(notional, 2) });
      slots--; remaining -= notional; newEntries++; botOpen.add(candidate.symbol);
      if (TECH.has(candidate.symbol)) techCount++;
      if (bucket === "inverse") inverseHeld = true; else directionalHeld = true;
    } catch (error) {
      console.log(JSON.stringify({ event: "entry_failed", symbol: candidate.symbol, message: error.message }));
    }
  }

  const journal = { event: "decision_journal", ts: new Date(+scheduledTime).toISOString(), strategy: STRATEGY, feed: snap.feed, regime, learning: learn, perf: { trades: perf.trades, winRate: round(perf.winRate, 3), profitFactor: round(perf.profitFactor, 2), expectancy: round(perf.expectancy, 4) }, daily: { pnl: round(daily.realizedPnl, 2), losses: daily.losses, maxConsecLoss: daily.maxConsecLoss }, risk: { intradayDrawdown: round(intradayDraw, 4), highWaterDrawdown: round(highWaterDraw, 4), drawdownMultiplier: dd, dailyLossGuard: dailyLoss, lossCountGuard: lossCount, consecutiveLossGuard: consec, exposure: round(currentExposure, 2), maxExposure: maxTotal }, leaders: ranked.slice(0, 10).map(s => ({ symbol: s.symbol, score: round(s.score,1), confirmed: Boolean(s.longConfirmed), spread: round(s.spreadPct,5), rvol: round(s.rvol,2), dollarVolume: round(s.dollarVolume,0), bucket: directionBucket(s.symbol) })), actions };
  console.log(JSON.stringify(journal));
  await persistJournal(env, journal);
  return { status: actions.length ? "acted" : "hold", endpoint: "paper", strategy: STRATEGY, feed: snap.feed, regime, learning: learn, daily: journal.daily, risk: journal.risk, actions, leaders: journal.leaders };
}

const esc = v => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const money = v => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(+v || 0);
async function digest(v){return new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)))}
async function secureEqual(l,r){const[a,b]=await Promise.all([digest(l),digest(r)]);if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];return d===0}
async function auth(req,env){if(!env.DASHBOARD_PASSWORD)return false;const a=req.headers.get("Authorization");if(!a?.startsWith("Basic "))return false;try{const d=atob(a.slice(6)),i=d.indexOf(":");return i>=0&&secureEqual(d.slice(i+1),env.DASHBOARD_PASSWORD)}catch{return false}}

async function dashboard(env){
  const [orders,positions,account]=await Promise.all([alpaca(env,"/v2/orders?status=all&limit=500&direction=desc&nested=false"),alpaca(env,"/v2/positions"),alpaca(env,"/v2/account")]);
  const perf=calculatePerformanceDetailed(orders),lots=botLotsFromOrders(orders),botPositions=positions.filter(p=>lots[p.symbol]?.qty>1e-8),state=await stateHealth(env);
  const rows=orders.filter(isBotOrder).slice(0,40).map(o=>`<tr><td>${esc(o.symbol)}</td><td>${esc(o.side)}</td><td>${esc(o.status)}</td><td>${o.filled_avg_price?money(o.filled_avg_price):"—"}</td></tr>`).join("");
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>${STRATEGY}</title><style>body{font:15px system-ui;background:#0b1020;color:#eef3ff;margin:0;padding:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card{background:#151c32;padding:16px;border-radius:12px}table{width:100%;margin-top:20px;border-collapse:collapse}td,th{padding:9px;border-bottom:1px solid #2a3557;text-align:left}</style></head><body><h1>${STRATEGY}</h1><div class="grid"><div class="card">Equity<br><b>${money(account.equity)}</b></div><div class="card">Buying power<br><b>${money(account.buying_power)}</b></div><div class="card">Bot positions<br><b>${botPositions.length}</b></div><div class="card">Realized P&L<br><b>${money(perf.realizedPnl)}</b></div><div class="card">Profit factor<br><b>${Number(perf.profitFactor||0).toFixed(2)}</b></div><div class="card">Data mode<br><b>${esc(state?.mode||preferredFeed(env))}</b></div></div><table><thead><tr><th>Symbol</th><th>Side</th><th>Status</th><th>Fill</th></tr></thead><tbody>${rows}</tbody></table></body></html>`,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});
}

const app={
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method!=="GET")return Response.json({error:"not_found"},{status:404});
    if(url.pathname==="/api/status"){
      const state=await stateHealth(env);
      return Response.json({service:"alpaca-paper-guard",strategy:STRATEGY,status:String(env.TRADING_ENABLED)==="true"?"armed":"disabled",endpoint:"paper",features:{dynamicScanner:bool(env.DYNAMIC_SCANNER_ENABLED,true),profitabilityFirst:true,conflictAwareExposure:true,marketDataFeed:preferredFeed(env),realtimeWebSocketRelay:bool(env.REALTIME_STREAM_ENABLED,false),realtimeStreamConnected:Boolean(state?.connected),persistentState:bool(env.PERSISTENT_STATE_ENABLED,false),multiTimeframe:["1Min","5Min","15Min"],liveQuoteGuard:true,spreadGuard:true,staleQuoteGuard:true,liquidityGuard:true,haltLuldGuard:true,assetEligibilityGuard:true,marketableLimitOrders:true,dynamicRiskSizing:true,dynamicAtrExits:true,regimeFilter:true,chopFilter:true,newsRiskFilter:bool(env.NEWS_RISK_FILTER_ENABLED,true),adaptiveLearning:true,rollingWalkForward:true,drawdownGovernor:true,botPositionIsolation:true},safeguards:{minEntryScore:num(env.MIN_ENTRY_SCORE,82),maxConcurrentPositions:int(env.MAX_CONCURRENT_POSITIONS,4),maxUniverseSymbols:int(env.MAX_UNIVERSE_SYMBOLS,100),maxDailyLossPct:pct(env.MAX_DAILY_LOSS_PCT,0.0125),maxDailyLosingExits:int(env.MAX_DAILY_LOSING_EXITS,4),maxConsecutiveLosses:int(env.MAX_CONSECUTIVE_LOSSES,3),symbolCooldownMinutes:int(env.SYMBOL_COOLDOWN_MINUTES,10),maxSpreadPct:pct(env.MAX_SPREAD_PCT,0.003),maxQuoteAgeSeconds:int(env.MAX_QUOTE_AGE_SECONDS,20),minDollarVolume:num(env.MIN_DOLLAR_VOLUME_USD,10000000),minQuoteSize:num(env.MIN_QUOTE_SIZE,1),minPriceUsd:num(env.MIN_PRICE_USD,1),maxTotalExposureUsd:num(env.MAX_TOTAL_EXPOSURE_USD,100000),orderNotionalUsd:num(env.ORDER_NOTIONAL_USD,25000),maxNewEntriesPerCycle:int(env.MAX_NEW_ENTRIES_PER_CYCLE,1)}} ,{headers:{"Cache-Control":"no-store"}});
    }
    if(url.pathname==="/api/state")return Response.json(await stateHealth(env)||{connected:false},{headers:{"Cache-Control":"no-store"}});
    if(url.pathname!=="/")return Response.json({error:"not_found"},{status:404});
    if(!env.DASHBOARD_PASSWORD)return Response.json({error:"dashboard_password_not_configured"},{status:503});
    if(!await auth(request,env))return new Response("Authentication required",{status:401,headers:{"WWW-Authenticate":'Basic realm="Alpaca Paper Guard"'}});
    try{return await dashboard(env)}catch(error){return Response.json({error:"dashboard_unavailable",message:error.message},{status:502})}
  },
  async scheduled(controller,env,ctx){ctx.waitUntil(runCycle(env,controller.scheduledTime).then(result=>console.log(JSON.stringify({event:"cycle_complete",...result}))).catch(error=>console.error(JSON.stringify({event:"cycle_failed",message:error.message}))))}
};

export default app;
