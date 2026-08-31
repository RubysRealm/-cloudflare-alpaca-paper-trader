import { DurableObject } from "cloudflare:workers";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const STREAM_MAX = 10;
const streamSymbols = input => [...new Set((input || []).map(s => String(s).toUpperCase()).filter(Boolean))].slice(0, STREAM_MAX);
const sub = symbols => ({ trades: symbols, quotes: symbols });

export class TradingState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ws = null;
    this.market = {};
    this.streamConfig = null;
    this.persistTimer = null;
    this.lastMessageAt = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/ensure") {
      const body = await request.json();
      const symbols = streamSymbols(body.symbols);
      const feed = String(body.feed || "iex").toLowerCase();
      await this.ensureStream(symbols, feed);
      return json({ ok: true, connected: Boolean(this.ws && this.ws.readyState === 1), feed: this.streamConfig?.feed || feed, symbols: this.streamConfig?.symbols || symbols, streamMaxSymbols: STREAM_MAX });
    }
    if (request.method === "GET" && url.pathname === "/market") {
      if (!Object.keys(this.market).length) this.market = (await this.ctx.storage.get("market")) || {};
      return json({ market: this.market, stream: this.streamConfig || await this.ctx.storage.get("streamConfig") || null });
    }
    if (request.method === "POST" && url.pathname === "/equity") {
      const body = await request.json();
      const equity = Number(body.equity || 0);
      if (!(equity > 0)) return json({ error: "invalid_equity" }, 400);
      const prior = Number(await this.ctx.storage.get("highWaterEquity") || 0);
      const highWaterEquity = Math.max(prior, equity);
      await this.ctx.storage.put("highWaterEquity", highWaterEquity);
      return json({ highWaterEquity, drawdown: highWaterEquity > 0 ? equity / highWaterEquity - 1 : 0 });
    }
    if (request.method === "POST" && url.pathname === "/journal") {
      const entry = await request.json();
      const journals = (await this.ctx.storage.get("journals")) || [];
      journals.push(entry);
      while (journals.length > 100) journals.shift();
      await this.ctx.storage.put("journals", journals);
      return json({ ok: true, entries: journals.length });
    }
    if (request.method === "GET" && url.pathname === "/journal") return json({ journals: (await this.ctx.storage.get("journals")) || [] });
    if (request.method === "GET" && url.pathname === "/health") {
      if (!Object.keys(this.market).length) this.market = (await this.ctx.storage.get("market")) || {};
      const lastMessageAt = Number(this.lastMessageAt || await this.ctx.storage.get("lastMessageAt") || 0);
      return json({
        connected: Boolean(this.ws && this.ws.readyState === 1),
        readyState: this.ws?.readyState ?? null,
        stream: this.streamConfig || await this.ctx.storage.get("streamConfig") || null,
        streamMaxSymbols: STREAM_MAX,
        highWaterEquity: Number(await this.ctx.storage.get("highWaterEquity") || 0),
        symbolsTracked: Object.keys(this.market).length,
        lastMessageAt,
        messageAgeSeconds: lastMessageAt ? Math.max(0, Math.round((Date.now() - lastMessageAt) / 1000)) : null,
        lastControlEvent: await this.ctx.storage.get("lastControlEvent") || null,
        lastStreamError: await this.ctx.storage.get("lastStreamError") || null,
        lastStreamClose: await this.ctx.storage.get("lastStreamClose") || null
      });
    }
    return json({ error: "not_found" }, 404);
  }

  async ensureStream(symbols, feed) {
    symbols = streamSymbols(symbols);
    if (!symbols.length || !this.env.APCA_API_KEY_ID || !this.env.APCA_API_SECRET_KEY) return;
    const cfg = this.streamConfig || await this.ctx.storage.get("streamConfig");
    const connected = Boolean(this.ws && this.ws.readyState === 1);

    if (connected && cfg?.feed === feed) {
      const old = new Set(cfg.symbols || []), next = new Set(symbols);
      const add = symbols.filter(s => !old.has(s));
      const remove = [...old].filter(s => !next.has(s));
      try {
        if (remove.length) this.ws.send(JSON.stringify({ action: "unsubscribe", ...sub(remove) }));
        if (add.length) this.ws.send(JSON.stringify({ action: "subscribe", ...sub(add) }));
      } catch (error) {
        const diag = { at: Date.now(), event: "stream_resubscribe_failed", message: error.message };
        this.ctx.storage.put("lastStreamError", diag).catch(() => {});
      }
      this.streamConfig = { ...cfg, symbols, updatedAt: Date.now() };
      await this.ctx.storage.put("streamConfig", this.streamConfig);
      await this.ctx.storage.setAlarm(Date.now() + 8 * 60_000);
      return;
    }

    if (this.ws) {
      try { this.ws.close(1000, "feed_change_or_reconnect"); } catch {}
      this.ws = null;
    }
    this.streamConfig = { symbols, feed, updatedAt: Date.now() };
    await this.ctx.storage.put("streamConfig", this.streamConfig);
    this.connect();
    await this.ctx.storage.setAlarm(Date.now() + 8 * 60_000);
  }

  connect() {
    const cfg = this.streamConfig;
    if (!cfg?.symbols?.length) return;
    let ws;
    try { ws = new WebSocket(`wss://stream.data.alpaca.markets/v2/${cfg.feed}`); }
    catch (error) {
      const diag = { at: Date.now(), event: "stream_connect_failed", message: error.message, feed: cfg.feed };
      this.ctx.storage.put("lastStreamError", diag).catch(() => {});
      this.ctx.storage.setAlarm(Date.now() + 30_000).catch(() => {});
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.ctx.storage.put("lastControlEvent", { at: Date.now(), type: "socket_open", feed: cfg.feed }).catch(() => {});
      try { ws.send(JSON.stringify({ action: "auth", key: this.env.APCA_API_KEY_ID, secret: this.env.APCA_API_SECRET_KEY })); }
      catch (error) { this.ctx.storage.put("lastStreamError", { at: Date.now(), event: "stream_auth_send_failed", message: error.message }).catch(() => {}); }
    });
    ws.addEventListener("message", event => this.onMessage(event.data));
    ws.addEventListener("close", event => {
      if (this.ws === ws) this.ws = null;
      const diag = { at: Date.now(), code: event.code, reason: event.reason || "" };
      this.ctx.storage.put("lastStreamClose", diag).catch(() => {});
      const limited = /limit/i.test(String(event.reason || ""));
      this.ctx.storage.setAlarm(Date.now() + (limited ? 60_000 : 10_000)).catch(() => {});
    });
    ws.addEventListener("error", event => this.ctx.storage.put("lastStreamError", { at: Date.now(), event: "stream_error", message: String(event?.message || "websocket_error") }).catch(() => {}));
  }

  onMessage(raw) {
    let events;
    try { events = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (!Array.isArray(events)) events = [events];
    const now = Date.now();
    this.lastMessageAt = now;
    this.ctx.storage.put("lastMessageAt", now).catch(() => {});
    for (const event of events) {
      if (!event?.S) this.ctx.storage.put("lastControlEvent", { at: now, T: event?.T || null, msg: event?.msg || null, code: event?.code ?? null }).catch(() => {});
      if (event?.T === "success" && event.msg === "authenticated") {
        this.ctx.storage.delete("lastStreamError").catch(() => {});
        this.ws?.send(JSON.stringify({ action: "subscribe", ...sub(streamSymbols(this.streamConfig?.symbols)) }));
        continue;
      }
      if (event?.T === "error") {
        const diag = { at: now, code: event.code, message: event.msg || "alpaca_stream_error" };
        this.ctx.storage.put("lastStreamError", diag).catch(() => {});
        if ([405, 406].includes(Number(event.code)) || /limit/i.test(String(event.msg || ""))) {
          const ws = this.ws; this.ws = null;
          try { ws?.close(1000, "subscription_limit_backoff"); } catch {}
          this.ctx.storage.setAlarm(Date.now() + 60_000).catch(() => {});
        }
        continue;
      }
      const symbol = event?.S;
      if (!symbol) continue;
      const item = this.market[symbol] || {};
      if (event.T === "q") item.quote = event;
      else if (event.T === "t") item.trade = event;
      item.receivedAt = now;
      this.market[symbol] = item;
    }
    this.schedulePersist();
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.ctx.storage.put("market", this.market).catch(() => {});
    }, 1500);
  }

  async alarm() {
    const cfg = this.streamConfig || await this.ctx.storage.get("streamConfig");
    if (cfg?.symbols?.length) {
      this.streamConfig = { ...cfg, symbols: streamSymbols(cfg.symbols) };
      if (!this.ws || this.ws.readyState !== 1) this.connect();
      await this.ctx.storage.setAlarm(Date.now() + 8 * 60_000);
    }
  }
}