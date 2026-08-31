import { isBotOrder, etDateKey, clamp } from "./config.js";

export function calculatePerformanceDetailed(orders) {
  const s = [...orders].filter(o => o.filled_at && o.filled_avg_price && isBotOrder(o)).sort((a, b) => String(a.filled_at).localeCompare(String(b.filled_at)));
  const inv = {}, pnls = [], bySetup = { pb: { trades: 0, pnl: 0, wins: 0 }, bo: { trades: 0, pnl: 0, wins: 0 }, other: { trades: 0, pnl: 0, wins: 0 } }, slips = [];
  let realizedPnl = 0, wins = 0, losses = 0, grossWin = 0, grossLoss = 0, consecLoss = 0, maxConsecLoss = 0;
  for (const o of s) {
    const q = Math.abs(+o.filled_qty), p = +o.filled_avg_price, lp = +o.limit_price;
    if (!(q > 0 && p > 0)) continue;
    if (lp > 0) slips.push(Math.abs(p - lp) / lp);
    const k = o.symbol; inv[k] ||= { qty: 0, cost: 0, setup: "other" }; const x = inv[k];
    if (o.side === "buy") {
      x.cost += q * p; x.qty += q;
      const id = String(o.client_order_id || "");
      if (id.includes("-pb-")) x.setup = "pb"; else if (id.includes("-bo-")) x.setup = "bo";
      continue;
    }
    if (x.qty <= 0) continue;
    const sold = Math.min(q, x.qty), avgCost = x.cost / x.qty, pnl = sold * (p - avgCost), setup = x.setup || "other";
    realizedPnl += pnl; pnls.push(pnl); x.qty -= sold; x.cost -= sold * avgCost;
    bySetup[setup].trades++; bySetup[setup].pnl += pnl;
    if (pnl > 0) { wins++; grossWin += pnl; consecLoss = 0; bySetup[setup].wins++; }
    else if (pnl < 0) { losses++; grossLoss += Math.abs(pnl); consecLoss++; maxConsecLoss = Math.max(maxConsecLoss, consecLoss); }
    if (x.qty < 1e-8) { x.qty = 0; x.cost = 0; x.setup = "other"; }
  }
  const trades = pnls.length, avgWin = wins ? grossWin / wins : 0, avgLoss = losses ? grossLoss / losses : 0;
  const expectancy = trades ? realizedPnl / trades : 0, profitFactor = grossLoss ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  const avgLimitDeviation = slips.length ? slips.reduce((a, b) => a + b, 0) / slips.length : 0;
  return { realizedPnl, trades, wins, losses, winRate: trades ? wins / trades : 0, grossWin, grossLoss, profitFactor, avgWin, avgLoss, expectancy, maxConsecLoss, avgLimitDeviation, bySetup, pnls };
}

export function botLotsFromOrders(orders) {
  const lots = {};
  const filled = [...orders].filter(o => o.status === "filled" && o.filled_avg_price && isBotOrder(o)).sort((a, b) => String(a.filled_at || "").localeCompare(String(b.filled_at || "")));
  for (const o of filled) {
    const q = Math.abs(+o.filled_qty || 0), p = +o.filled_avg_price || 0;
    if (!(q > 0 && p > 0)) continue;
    const x = lots[o.symbol] ||= { qty: 0, cost: 0, avgEntry: 0 };
    if (o.side === "buy") { x.cost += q * p; x.qty += q; }
    else if (x.qty > 0) { const sold = Math.min(q, x.qty), avgCost = x.cost / x.qty; x.qty -= sold; x.cost -= sold * avgCost; }
    if (x.qty < 1e-8) { x.qty = 0; x.cost = 0; x.avgEntry = 0; }
    else x.avgEntry = x.cost / x.qty;
  }
  return lots;
}

export function botInventoryFromOrders(orders) {
  const lots = botLotsFromOrders(orders), inv = {};
  for (const [symbol, lot] of Object.entries(lots)) inv[symbol] = lot.qty;
  return inv;
}

export function todayPerformance(orders, now) {
  const key = etDateKey(now);
  return calculatePerformanceDetailed(orders.filter(o => o.filled_at && etDateKey(o.filled_at) === key));
}

export function recentCooldowns(orders, now, minutes) {
  const cut = +now - minutes * 60000, blocked = new Set();
  for (const o of orders) {
    if (o.side !== "sell" || o.status !== "filled" || !isBotOrder(o)) continue;
    const t = Date.parse(o.filled_at || 0);
    if (Number.isFinite(t) && t >= cut) blocked.add(o.symbol);
  }
  return blocked;
}

export function adaptiveLearning(perf, baseScore) {
  if (perf.trades < 12) return { scoreThreshold: baseScore, riskMultiplier: 0.75, state: "learning_sample", walkForward: "waiting" };
  let d = 0, r = 1, wf = "insufficient";
  if (perf.profitFactor < 0.9 || perf.expectancy < 0) { d += 6; r *= 0.55; }
  else if (perf.profitFactor < 1.15) { d += 3; r *= 0.75; }
  else if (perf.profitFactor > 1.5 && perf.winRate > 0.5) { d -= 2; r *= 1.05; }
  if (perf.maxConsecLoss >= 3) { d += 3; r *= 0.65; }
  if (perf.pnls.length >= 20) {
    const w = perf.pnls.slice(-20), train = w.slice(0, 12), test = w.slice(12), mean = x => x.reduce((m, n) => m + n, 0) / Math.max(1, x.length);
    const ta = mean(train), va = mean(test);
    wf = ta > 0 && va > 0 ? "passed" : va < 0 ? "failed_validation" : "mixed";
    if (wf === "failed_validation") { d += 4; r *= 0.6; }
    else if (wf === "passed") r *= 1.02;
  }
  return { scoreThreshold: clamp(baseScore + d, 78, 94), riskMultiplier: clamp(r, 0.35, 1.05), state: "adaptive", walkForward: wf };
}
