import { int, bool } from "./config.js";

const PAPER_API = "https://paper-api.alpaca.markets", DATA_API = "https://data.alpaca.markets";
const headers = env => ({ "APCA-API-KEY-ID": env.APCA_API_KEY_ID, "APCA-API-SECRET-KEY": env.APCA_API_SECRET_KEY, "Content-Type": "application/json" });

const DEFAULT_APPROVED = [
  "SPY","QQQ","IWM","DIA","VTI","SH","PSQ","RWM","XLK","XLF","XLE","XLI","XLY","XLP","XLV","XLU","XLB","XLRE","SMH","SOXX","XBI","KRE","TLT","GLD","SLV","USO","HYG",
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AMD","AVGO","NFLX","CRM","ORCL","INTC","MU","QCOM","ARM","PLTR","COIN","HOOD","JPM","BAC","GS","WFC","XOM","CVX","CAT","BA","UBER","DIS","WMT","COST","LLY","UNH","JNJ","PFE"
];
const CORE = ["SPY","QQQ","IWM","DIA","SH","PSQ","RWM","XLK","XLF","XLE","SMH","TLT","GLD"];

export async function alpaca(env, path, init = {}) {
  const r = await fetch(`${PAPER_API}${path}`, { ...init, headers: { ...headers(env), ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`alpaca_${r.status}_${path.split("?")[0]}`);
  return r.status === 204 ? null : r.json();
}

export async function marketDataRaw(env, path) {
  const r = await fetch(`${DATA_API}${path}`, { headers: headers(env) });
  if (!r.ok) throw new Error(`market_data_${r.status}_${path.split("?")[0]}`);
  return r.json();
}

export const preferredFeed = env => String(env.MARKET_DATA_FEED || "iex").toLowerCase();

export async function marketData(env, pathBuilder) {
  const pref = preferredFeed(env), feeds = pref === "iex" ? ["iex"] : [pref, "iex"];
  let err;
  for (const feed of feeds) {
    try { return { data: await marketDataRaw(env, pathBuilder(feed)), feed }; }
    catch (e) { err = e; if (!String(e.message || "").includes("market_data_403")) break; }
  }
  throw err;
}

export function staticUniverse(env) {
  const raw = String(env.SYMBOLS || DEFAULT_APPROVED.join(","));
  return [...new Set(raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))];
}

function approvedUniverse(env) {
  const raw = String(env.APPROVED_SCAN_SYMBOLS || DEFAULT_APPROVED.join(","));
  return new Set(raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean));
}

export async function dynamicUniverse(env) {
  const max = int(env.MAX_UNIVERSE_SYMBOLS, 30), base = staticUniverse(env), approved = approvedUniverse(env);
  if (!bool(env.DYNAMIC_SCANNER_ENABLED, true)) return [...new Set([...CORE, ...base])].filter(s => approved.has(s)).slice(0, max);
  const discovered = [];
  try {
    const x = await marketDataRaw(env, `/v1beta1/screener/stocks/most-actives?top=${int(env.SCANNER_MOST_ACTIVE_TOP, 50)}&by=volume`);
    for (const z of x?.most_actives || x?.mostActives || []) {
      const symbol = String(z.symbol || "").toUpperCase();
      if (approved.has(symbol)) discovered.push(symbol);
    }
  } catch (e) { console.log(JSON.stringify({ event: "scanner_degraded", source: "most_actives", message: e.message })); }
  try {
    const x = await marketDataRaw(env, `/v1beta1/screener/stocks/movers?top=${int(env.SCANNER_MOVERS_TOP, 25)}`);
    for (const z of [...(x?.gainers || []), ...(x?.losers || [])]) {
      const symbol = String(z.symbol || "").toUpperCase();
      if (approved.has(symbol)) discovered.push(symbol);
    }
  } catch (e) { console.log(JSON.stringify({ event: "scanner_degraded", source: "movers", message: e.message })); }
  return [...new Set([...CORE, ...discovered, ...base])].filter(s => approved.has(s)).slice(0, max);
}

export async function fetchBars(env, symbol, timeframe, limit) {
  const r = await marketData(env, f => `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&limit=${limit}&feed=${f}&adjustment=raw&sort=desc`);
  return { bars: Array.isArray(r.data?.bars) ? [...r.data.bars].reverse() : [], feed: r.feed };
}

export async function fetchSnapshots(env, symbols) {
  const s = symbols.map(encodeURIComponent).join(",");
  const r = await marketData(env, f => `/v2/stocks/snapshots?symbols=${s}&feed=${f}`);
  return { snapshots: r.data || {}, feed: r.feed };
}

export async function fetchAsset(env, symbol) {
  try { return await alpaca(env, `/v2/assets/${encodeURIComponent(symbol)}`); }
  catch (error) { console.log(JSON.stringify({ event: "asset_check_failed", symbol, message: error.message })); return null; }
}

export async function recentNewsRisk(env, symbols, now) {
  if (!bool(env.NEWS_RISK_FILTER_ENABLED, true) || !symbols.length) return new Set();
  const start = new Date(Number(now) - int(env.NEWS_LOOKBACK_MINUTES, 45) * 60000).toISOString();
  try {
    const d = await marketDataRaw(env, `/v1beta1/news?symbols=${symbols.join(",")}&start=${encodeURIComponent(start)}&limit=50&sort=desc`);
    const rx = /trading halt|halted|bankrupt|bankruptcy|delist|delisting|secondary offering|public offering|fraud|accounting investigation|chapter 11|going concern|default/i, blocked = new Set();
    for (const article of d?.news || []) if (rx.test(`${article.headline || ""} ${article.summary || ""}`)) for (const s of article.symbols || []) blocked.add(s);
    return blocked;
  } catch (e) { console.log(JSON.stringify({ event: "news_filter_degraded", message: e.message })); return new Set(); }
}