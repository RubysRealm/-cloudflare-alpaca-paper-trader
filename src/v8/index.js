import { STRATEGY, TECH, INVERSE, BULL_LEVERAGED, num, pct, int, bool, clamp, round, isBotOrder, etParts, entryWindowOpen, inConfiguredBlackout } from "./config.js";
import { alpaca, dynamicUniverse, fetchBars, fetchSnapshots, fetchAsset, recentNewsContext, preferredFeed } from "./api.js";
import { timeframeSignal, combineSignals, marketRegime } from "./signals.js";
import { calculatePerformanceDetailed, botLotsFromOrders, todayPerformance, recentCooldowns, adaptiveLearning } from "./performance.js";
import { cancelStaleBotOrders, exitDecision, placeLimitSell, placeLimitBuy, positionNotional } from "./execution.js";
import { ensureRealtimeState, getRealtimeMarket, overlayRealtimeSnapshot, updateHighWater, persistJournal, stateHealth } from "./state_client.js";
export { TradingState } from "./state.js";

function directionBucket(symbol) {
  if (INVERSE.has(symbol)) return "inverse";
  if (BULL_LEVERAGED.has(symbol)) return "bull_leveraged";
  return "regular";
}

function stockEconomics(signal, env) {
  const entrySlip = pct(env.MAX_ENTRY_SLIPPAGE_PCT, 0.001);
  const exitSlip = pct(env.MAX_EXIT_SLIPPAGE_PCT, 0.0012);
  const roundTripCost = Math.max(0, signal?.spreadPct || 0) + entrySlip + exitSlip;
  const expectedGrossMove = clamp(Math.max(
    (signal?.atrPct || 0) * 1.8,
    Math.max(0, signal?.s5?.ret3 || 0) * 1.45,
    Math.max(0, signal?.s15?.ret3 || 0) * 1.2,
    Math.max(0, signal?.h1?.ret1 || 0) * 0.8,
    0.0005
  ), 0.0005, 0.05);
  const expectedNetEdge = expectedGrossMove - roundTripCost;
  return { roundTripCost, expectedGrossMove, expectedNetEdge, ok: expectedNetEdge > 0 };
}

function deepenStockSignal(base, h1, env) {
  if (!base?.valid) return base;
  const h1Valid = Boolean(h1?.valid);
  const higherBoost = !h1Valid ? -14 : (h1.trend ? 12 : h1.downTrend ? -16 : 0) + (h1.trendSlope ? 6 : h1.downSlope ? -7 : 0) + (h1.aboveVwap ? 4 : 0);
  const convictionScore = base.score + higherBoost + (base.longAligned ? 6 : 0);
  const higherTimeframeConfirmed = Boolean(h1Valid && !h1.downTrend && (h1.trend || h1.trendSlope || h1.price >= h1.ema21));
  const flow = Boolean(
    (base.s1?.ret1 > 0 && base.s1?.ret3 > 0) ||
    (base.s5?.ret1 > 0 && base.s5?.ret3 > 0) ||
    (base.s5?.ret3 > 0 && base.s15?.ret3 > 0)
  );
  const setup = Boolean(base.longContinuation || base.s5?.pullback || base.s5?.breakout || base.s5?.momentum || base.trendVotes >= 5);
  const notOverextended = (base.rsi ?? 50) < 86;
  const out = { ...base, h1, convictionScore, higherTimeframeConfirmed, opportunityFlow: flow, opportunitySetup: setup };
  out.entryEconomics = stockEconomics(out, env);
  out.convictionConfirmed = Boolean(higherTimeframeConfirmed && flow && setup && base.trendVotes >= 4 && notOverextended && out.entryEconomics.ok);
  return out;
}

function applyOpportunityResearch(signal, news) {
  const catalystScore = news?.score || 0;
  const adjustedConviction = signal.convictionScore + catalystScore;
  const probability = clamp(
    0.43 + Math.max(0, adjustedConviction - 65) * 0.0042 + (signal.trendVotes || 0) * 0.02 +
    (signal.h1?.trend ? 0.055 : 0) + (signal.longAligned ? 0.035 : 0) +
    (signal.opportunityFlow ? 0.045 : 0) + (signal.opportunitySetup ? 0.035 : 0) +
    clamp(catalystScore / 100, -0.18, 0.12),
    0.20, 0.93
  );
  const movementOpportunity = Math.max(
    signal.atrPct || 0,
    Math.max(0, signal.s1?.ret3 || 0) * 1.5,
    Math.max(0, signal.s5?.ret3 || 0) * 1.25,
    Math.max(0, signal.s15?.ret3 || 0)
  );
  const movementMultiplier = 1 + clamp(movementOpportunity * 50, 0, 2.75);
  const opportunityScore = Math.max(0, signal.entryEconomics?.expectedNetEdge || 0) * probability * movementMultiplier;
  return { ...signal, convictionScore: adjustedConviction, probability, movementOpportunity, opportunityScore, catalyst: news || { score: 0, positive: 0, negative: 0, severe: false, headlines: [] } };
}

function regimeExit(position, signal, regime) {
  const bucket = directionBucket(position.symbol);
  if (bucket === "inverse" && regime.mode === "bull") return "regime_conflict";
  if (bucket === "bull_leveraged" && regime.mode !== "bull") return "regime_conflict";
  if (bucket === "regular" && regime.mode === "bear" && (!signal || signal.convictionScore < 90 || !signal.higherTimeframeConfirmed)) return "regime_weakness";
  return null;
}

function selectiveExitDecision(position, signal, regime, bestAlternative, env, scheduledTime) {
  const entry = +position.avg_entry_price || 0, price = +(signal?.bid || signal?.price || position.current_price || 0);
  const pnlPct = entry > 0 && price > 0 ? price / entry - 1 : 0;
  const forced = regimeExit(position, signal, regime);
  if (forced) return { exit: true, reason: forced, pnlPct };

  const legacyRisk = exitDecision(position, signal, env, scheduledTime, etParts);
  if (["end_of_day_flatten", "session_open_reset"].includes(legacyRisk.reason)) return legacyRisk;

  if (pnlPct > 0) {
    const rollover = Boolean(signal && signal.s1?.ret1 < 0 && (signal.s1?.ret3 < 0 || signal.s5?.ret1 <= 0));
    const convictionFading = Boolean(!signal?.higherTimeframeConfirmed || !signal?.opportunityFlow || signal.catalyst?.severe);
    const currentOpportunity = signal?.opportunityScore || 0;
    const alternativeOpportunity = bestAlternative?.opportunityScore || 0;
    const materiallyBetter = Boolean(bestAlternative && bestAlternative.symbol !== position.symbol && alternativeOpportunity > Math.max(currentOpportunity * 1.25, currentOpportunity + 0.00015));
    if (materiallyBetter) return { exit: true, reason: "rotate_stronger_opportunity", pnlPct };
    if (rollover || convictionFading) return { exit: true, reason: "profit_edge_fading", pnlPct };
    return { exit: false, reason: "hold_best_opportunity", pnlPct };
  }

  if (legacyRisk.exit && ["dynamic_stop", "thesis_failed", "trend_failure"].includes(legacyRisk.reason)) return legacyRisk;
  return { exit: false, reason: "hold_research_thesis", pnlPct };
}

function strategyEpochOrders(orders, env) {
  const epoch = Date.parse(String(env.STRATEGY_EPOCH_UTC || ""));
  if (!Number.isFinite(epoch)) return orders;
  return orders.filter(o => {
    const t = Date.parse(o.submitted_at || o.created_at || o.filled_at || 0);
    return Number.isFinite(t) && t >= epoch;
  });
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
      const [m1, m5, m15, m60] = await Promise.all([
        fetchBars(env, symbol, "1Min", 55),
        fetchBars(env, symbol, "5Min", 80),
        fetchBars(env, symbol, "15Min", 70),
        fetchBars(env, symbol, "1Hour", 45)
      ]);
      const merged = overlayRealtimeSnapshot(snap.snapshots[symbol], liveMarket[symbol]);
      const base = combineSignals(symbol, timeframeSignal(symbol, m1.bars), timeframeSignal(symbol, m5.bars), timeframeSignal(symbol, m15.bars), merged);
      return deepenStockSignal(base, timeframeSignal(symbol, m60.bars), env);
    } catch (error) {
      console.log(JSON.stringify({ event: "symbol_data_failed", symbol, message: error.message }));
      return { symbol, valid: false };
    }
  }));

  const baseSignals = bundles.filter(s => s.valid);
  const baseMap = new Map(baseSignals.map(s => [s.symbol, s]));
  const regime = marketRegime(baseMap);
  const news = await recentNewsContext(env, baseSignals.map(s => s.symbol), scheduledTime, 120);
  const signals = baseSignals.map(s => applyOpportunityResearch(s, news.get(s.symbol)));
  const map = new Map(signals.map(s => [s.symbol, s]));
  const maxSpread = pct(env.MAX_SPREAD_PCT, 0.003), maxAge = int(env.MAX_QUOTE_AGE_SECONDS, 20), minDollarVolume = num(env.MIN_DOLLAR_VOLUME_USD, 5_000_000), minQuoteSize = num(env.MIN_QUOTE_SIZE, 1), minPrice = num(env.MIN_PRICE_USD, 1);

  const marketLeaders = signals.filter(s =>
    !s.halted && !s.nearLuld && !s.catalyst?.severe && s.price >= minPrice && s.dollarVolume >= minDollarVolume &&
    s.bidSize >= minQuoteSize && s.askSize >= minQuoteSize && s.spreadPct <= maxSpread && s.quoteAgeSec <= maxAge &&
    s.convictionConfirmed && s.entryEconomics?.ok && (!s.chop || s.movementOpportunity >= 0.004 || (s.catalyst?.positive || 0) > 0)
  ).sort((a, b) => (b.opportunityScore - a.opportunityScore) || (b.probability - a.probability) || (b.convictionScore - a.convictionScore));

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
    const bestAlternative = marketLeaders.find(x => x.symbol !== position.symbol) || null;
    const decision = selectiveExitDecision(position, signal, regime, bestAlternative, env, scheduledTime);
    if (!decision.exit) continue;
    try {
      await placeLimitSell(env, position, signal, scheduledTime, decision.reason);
      actions.push({ action: "sell", symbol: position.symbol, reason: decision.reason, pnlPct: round(decision.pnlPct, 5), botQty: +position.qty, alternative: bestAlternative?.symbol || null });
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

  const epochOrders = strategyEpochOrders(recentOrders, env);
  const perf = calculatePerformanceDetailed(epochOrders);
  const daily = todayPerformance(epochOrders, scheduledTime);
  const learn = adaptiveLearning(perf, num(env.MIN_ENTRY_SCORE, 82));
  const dailyLoss = daily.realizedPnl <= -(equity * pct(env.MAX_DAILY_LOSS_PCT, 0.0125));
  const lossCount = daily.losses >= int(env.MAX_DAILY_LOSING_EXITS, 4);
  const consec = daily.maxConsecLoss >= int(env.MAX_CONSECUTIVE_LOSSES, 3);
  const cooldowns = recentCooldowns(epochOrders, scheduledTime, int(env.SYMBOL_COOLDOWN_MINUTES, 10));

  const occupied = new Set(botPositions.map(p => p.symbol));
  const canRisk = entryWindowOpen(scheduledTime) && !inConfiguredBlackout(env, scheduledTime) && !dailyLoss && !lossCount && !consec && dd > 0 && !regime.shock;
  const ranked = marketLeaders.filter(s => !occupied.has(s.symbol) && !botOpen.has(s.symbol) && !cooldowns.has(s.symbol));

  const currentExposure = botPositions.reduce((sum, p) => sum + Math.abs((+p.qty || 0) * (+p.current_price || 0)), 0);
  const maxPositions = int(env.MAX_CONCURRENT_POSITIONS, 2), maxTotal = num(env.MAX_TOTAL_EXPOSURE_USD, 70000), maxNew = int(env.MAX_NEW_ENTRIES_PER_CYCLE, 1);
  let slots = Math.max(0, maxPositions - botPositions.length), remaining = Math.max(0, maxTotal - currentExposure), techCount = botPositions.filter(p => TECH.has(p.symbol)).length, newEntries = 0;
  const buyingPower = Math.max(0, +account.buying_power || 0), assetCache = new Map();
  let inverseHeld = botPositions.some(p => INVERSE.has(p.symbol));
  let directionalHeld = botPositions.some(p => !INVERSE.has(p.symbol));

  for (let rank = 0; rank < ranked.length; rank++) {
    const candidate = ranked[rank];
    if (!canRisk || slots <= 0 || remaining < 1 || newEntries >= maxNew) break;

    const bucket = directionBucket(candidate.symbol);
    if (bucket === "inverse" && directionalHeld) continue;
    if (bucket !== "inverse" && inverseHeld) continue;
    if (bucket === "inverse" && !(regime.mode === "bear" || (regime.mode === "sideways" && regime.breadth < -0.03))) continue;
    if (bucket === "bull_leveraged" && regime.mode === "bear") continue;
    if (TECH.has(candidate.symbol) && techCount >= int(env.MAX_TECH_POSITIONS, 2)) continue;

    let asset = assetCache.get(candidate.symbol);
    if (asset === undefined) { asset = await fetchAsset(env, candidate.symbol); assetCache.set(candidate.symbol, asset); }
    if (!asset || asset.tradable === false || asset.fractionable === false || asset.status === "inactive") continue;

    const sized = { ...candidate, score: Math.max(70, candidate.convictionScore) };
    const convictionScale = clamp(0.75 + candidate.probability * 0.45 + Math.min(0.35, candidate.movementOpportunity * 18), 0.75, 1.35);
    const notional = Math.min(positionNotional(equity, sized, env, learn, dd) * convictionScale, num(env.MAX_POSITION_USD, 35000), remaining, buyingPower);
    if (notional < 1) continue;
    try {
      await placeLimitBuy(env, candidate, notional, scheduledTime);
      actions.push({ action: "buy", symbol: candidate.symbol, reason: "best_relative_probability_weighted_opportunity", relativeRank: rank + 1, convictionScore: round(candidate.convictionScore, 1), regime: regime.mode, probability: round(candidate.probability, 3), opportunityScore: round(candidate.opportunityScore, 6), expectedNetEdgePct: round(candidate.entryEconomics.expectedNetEdge, 5), expectedGrossMovePct: round(candidate.entryEconomics.expectedGrossMove, 5), movementOpportunity: round(candidate.movementOpportunity, 5), catalystScore: round(candidate.catalyst?.score || 0, 2), spreadPct: round(candidate.spreadPct, 5), notional: round(notional, 2) });
      slots--; remaining -= notional; newEntries++; botOpen.add(candidate.symbol);
      if (TECH.has(candidate.symbol)) techCount++;
      if (bucket === "inverse") inverseHeld = true; else directionalHeld = true;
    } catch (error) {
      console.log(JSON.stringify({ event: "entry_failed", symbol: candidate.symbol, message: error.message }));
    }
  }

  const journal = { event: "decision_journal", ts: new Date(+scheduledTime).toISOString(), strategy: STRATEGY, feed: snap.feed, regime, learning: learn, perf: { trades: perf.trades, winRate: round(perf.winRate, 3), profitFactor: round(perf.profitFactor, 2), expectancy: round(perf.expectancy, 4) }, daily: { pnl: round(daily.realizedPnl, 2), losses: daily.losses, maxConsecLoss: daily.maxConsecLoss }, risk: { intradayDrawdown: round(intradayDraw, 4), highWaterDrawdown: round(highWaterDraw, 4), drawdownMultiplier: dd, dailyLossGuard: dailyLoss, lossCountGuard: lossCount, consecutiveLossGuard: consec, exposure: round(currentExposure, 2), maxExposure: maxTotal }, universeCount: symbols.length, validSignals: signals.length, eligibleOpportunities: marketLeaders.length, leaders: marketLeaders.slice(0, 10).map((s,i) => ({ rank:i+1, symbol: s.symbol, convictionScore: round(s.convictionScore,1), probability: round(s.probability,3), opportunityScore: round(s.opportunityScore,6), expectedNetEdgePct: round(s.entryEconomics?.expectedNetEdge || 0,5), expectedGrossMovePct: round(s.entryEconomics?.expectedGrossMove || 0,5), movementOpportunity: round(s.movementOpportunity,5), catalystScore: round(s.catalyst?.score || 0,2), catalystHeadlines: (s.catalyst?.headlines || []).slice(0,2), higherTimeframeConfirmed: Boolean(s.higherTimeframeConfirmed), spread: round(s.spreadPct,5), rvol: round(s.rvol,2), dollarVolume: round(s.dollarVolume,0), bucket: directionBucket(s.symbol) })), actions };
  console.log(JSON.stringify(journal));
  await persistJournal(env, journal);
  return { status: actions.length ? "acted" : "hold", endpoint: "paper", strategy: STRATEGY, feed: snap.feed, regime, learning: learn, daily: journal.daily, risk: journal.risk, universeCount: symbols.length, eligibleOpportunities: marketLeaders.length, actions, leaders: journal.leaders };
}

const esc = v => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const money = v => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(+v || 0);
async function digest(v){return new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)))}
async function secureEqual(l,r){const[a,b]=await Promise.all([digest(l),digest(r)]);if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];return d===0}
async function auth(req,env){if(!env.DASHBOARD_PASSWORD)return false;const a=req.headers.get("Authorization");if(!a?.startsWith("Basic "))return false;try{const d=atob(a.slice(6)),i=d.indexOf(":");return i>=0&&secureEqual(d.slice(i+1),env.DASHBOARD_PASSWORD)}catch{return false}}

async function dashboard(env){
  const [orders,positions,account]=await Promise.all([alpaca(env,"/v2/orders?status=all&limit=500&direction=desc&nested=false"),alpaca(env,"/v2/positions"),alpaca(env,"/v2/account")]);
  const perf=calculatePerformanceDetailed(strategyEpochOrders(orders, env)),lots=botLotsFromOrders(orders),botPositions=positions.filter(p=>lots[p.symbol]?.qty>1e-8),state=await stateHealth(env);
  const rows=orders.filter(isBotOrder).slice(0,40).map(o=>`<tr><td>${esc(o.symbol)}</td><td>${esc(o.side)}</td><td>${esc(o.status)}</td><td>${o.filled_avg_price?money(o.filled_avg_price):"—"}</td></tr>`).join("");
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>${STRATEGY}</title><style>body{font:15px system-ui;background:#0b1020;color:#eef3ff;margin:0;padding:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card{background:#151c32;padding:16px;border-radius:12px}table{width:100%;margin-top:20px;border-collapse:collapse}td,th{padding:9px;border-bottom:1px solid #2a3557;text-align:left}</style></head><body><h1>${STRATEGY}</h1><div class="grid"><div class="card">Equity<br><b>${money(account.equity)}</b></div><div class="card">Buying power<br><b>${money(account.buying_power)}</b></div><div class="card">Bot positions<br><b>${botPositions.length}</b></div><div class="card">Realized P&L<br><b>${money(perf.realizedPnl)}</b></div><div class="card">Profit factor<br><b>${Number(perf.profitFactor||0).toFixed(2)}</b></div><div class="card">Data mode<br><b>${esc(state?.mode||preferredFeed(env))}</b></div></div><table><thead><tr><th>Symbol</th><th>Side</th><th>Status</th><th>Fill</th></tr></thead><tbody>${rows}</tbody></table></body></html>`,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});
}

const app={
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method!=="GET")return Response.json({error:"not_found"},{status:404});
    if(url.pathname==="/api/status"){
      const state=await stateHealth(env);
      return Response.json({service:"alpaca-paper-guard",strategy:STRATEGY,status:String(env.TRADING_ENABLED)==="true"?"armed":"disabled",endpoint:"paper",features:{dynamicScanner:bool(env.DYNAMIC_SCANNER_ENABLED,true),selectiveConviction:true,relativeOpportunityRanking:true,absoluteScoreGate:false,tradeVolumeObjective:false,probabilityWeightedRanking:true,movementOpportunityRanking:true,catalystAware:true,fixedProfitThreshold:false,positiveNetEdgeRequired:true,opportunityCostExit:true,profitabilityFirst:true,conflictAwareExposure:true,marketDataFeed:preferredFeed(env),realtimeWebSocketRelay:bool(env.REALTIME_STREAM_ENABLED,false),realtimeStreamConnected:Boolean(state?.connected),persistentState:bool(env.PERSISTENT_STATE_ENABLED,false),multiTimeframe:["1Min","5Min","15Min","1Hour"],liveQuoteGuard:true,spreadGuard:true,staleQuoteGuard:true,liquidityGuard:true,haltLuldGuard:true,assetEligibilityGuard:true,marketableLimitOrders:true,dynamicRiskSizing:true,regimeFilter:true,chopFilter:"soft",newsRiskFilter:bool(env.NEWS_RISK_FILTER_ENABLED,true),adaptiveLearning:true,drawdownGovernor:true,botPositionIsolation:true},safeguards:{maxConcurrentPositions:int(env.MAX_CONCURRENT_POSITIONS,2),maxUniverseSymbols:int(env.MAX_UNIVERSE_SYMBOLS,200),maxDailyLossPct:pct(env.MAX_DAILY_LOSS_PCT,0.0125),maxDailyLosingExits:int(env.MAX_DAILY_LOSING_EXITS,4),maxConsecutiveLosses:int(env.MAX_CONSECUTIVE_LOSSES,3),symbolCooldownMinutes:int(env.SYMBOL_COOLDOWN_MINUTES,10),maxSpreadPct:pct(env.MAX_SPREAD_PCT,0.003),maxQuoteAgeSeconds:int(env.MAX_QUOTE_AGE_SECONDS,20),minDollarVolume:num(env.MIN_DOLLAR_VOLUME_USD,5000000),minQuoteSize:num(env.MIN_QUOTE_SIZE,1),minPriceUsd:num(env.MIN_PRICE_USD,1),maxTotalExposureUsd:num(env.MAX_TOTAL_EXPOSURE_USD,70000),orderNotionalUsd:num(env.ORDER_NOTIONAL_USD,35000),maxNewEntriesPerCycle:int(env.MAX_NEW_ENTRIES_PER_CYCLE,1),strategyEpochUtc:String(env.STRATEGY_EPOCH_UTC||"")}} ,{headers:{"Cache-Control":"no-store"}});
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
