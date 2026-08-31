import { DurableObject } from "cloudflare:workers";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});

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
      const symbols = [...new Set((body.symbols || []).map(s => String(s).toUpperCase()).filter(Boolean))].slice(0, 50);
      const feed = String(body.feed || "iex").toLowerCase();
      await this.ensureStream(symbols, feed);
      return json({ ok: true, connected: Boolean(this.ws && this.ws.readyState === 1), feed: this.streamConfig?.feed || feed, symbols: this.streamConfig?.symbols || symbols });
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
    if (request.method === "GET" && url.pathname === "/journal") {
      return json({ journals: (await this.ctx.storage.get("journals")) || [] });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      if (!Object.keys(this.market).length) this.market = (await this.ctx.storage.get("market")) || {};
      const lastMessageAt = Number(this.lastMessageAt || await this.ctx.storage.get("lastMessageAt") || 0);
      return json({
        connected: Boolean(this.ws && this.ws.readyState === 1),
        stream: this.streamConfig || await this.ctx.storage.get("streamConfig") || null,
        highWaterEquity: Number(await this.ctx.storage.get("highWaterEquity") || 0),
        symbolsTracked: Object.keys(this.market).length,
        lastMessageAt,
        messageAgeSeconds: lastMessageAt ? Math.max(0, Math.round((Date.now() - lastMessageAt) / 1000)) : null
      });
    }
    return json({ error: "not_found" }, 404);
  }

  async ensureStream(symbols, feed) {
    if (!symbols.length || !this.env.APCA_API_KEY_ID || !this.env.APCA_API_SECRET_KEY) return;
    const cfg = this.streamConfig || await this.ctx.storage.get("streamConfig");
    const connected = Boolean(this.ws && this.ws.readyState === 1);

    if (connected && cfg?.feed === feed) {
      const old = new Set(cfg.symbols || []), next = new Set(symbols);
      const add = symbols.filter(s => !old.has(s));
      const remove = [...old].filter(s => !next.has(s));
      try {
        if (remove.length) this.ws.send(JSON.stringify({ action: "unsubscribe", trades: remove, quotes: remove, bars: remove, statuses: remove, lulds: remove }));
        if (add.length) this.ws.send(JSON.stringify({ action: "subscribe", trades: add, quotes: add, bars: add, statuses: add, lulds: add }));
      } catch (error) {
        console.error(JSON.stringify({ event: "stream_resubscribe_failed", message: error.message }));
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
    try {
      ws = new WebSocket(`wss://stream.data.alpaca.markets/v2/${cfg.feed}`);
    } catch (error) {
      console.error(JSON.stringify({ event: "stream_connect_failed", message: error.message, feed: cfg.feed }));
      this.ctx.storage.setAlarm(Date.now() + 15_000).catch(() => {});
      return;
    }

    this.ws = ws;
    ws.addEventListener("open", () => {
      try {
        ws.send(JSON.stringify({ action: "auth", key: this.env.APCA_API_KEY_ID, secret: this.env.APCA_API_SECRET_KEY }));
      } catch (error) {
        console.error(JSON.stringify({ event: "stream_auth_send_failed", message: error.message }));
      }
    });
    ws.addEventListener("message", event => this.onMessage(event.data));
    ws.addEventListener("close", event => {
      if (this.ws === ws) this.ws = null;
      console.log(JSON.stringify({ event: "stream_closed", code: event.code, reason: event.reason || "" }));
      this.ctx.storage.setAlarm(Date.now() + 5_000).catch(() => {});
    });
    ws.addEventListener("error", event => {
      console.error(JSON.stringify({ event: "stream_error", message: String(event?.message || "websocket_error") }));
    });
  }

  onMessage(raw) {
    let events;
    try { events = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); }
    catch { return; }
    if (!Array.isArray(events)) events = [events];
    const now = Date.now();
    this.lastMessageAt = now;
    this.ctx.storage.put("lastMessageAt", now).catch(() => {});
    for (const event of events) {
      if (event?.T === "success" && event.msg === "authenticated") {
        const symbols = this.streamConfig?.symbols || [];
        this.ws?.send(JSON.stringify({
          action: "subscribe",
          trades: symbols,
          quotes: symbols,
          bars: symbols,
          statuses: symbols,
          lulds: symbols
        }));
        continue;
      }
      if (event?.T === "error") {
        console.error(JSON.stringify({ event: "alpaca_stream_error", code: event.code, message: event.msg }));
        if ((event.code === 401 || event.code === 403) && this.streamConfig?.feed !== "iex") {
          this.streamConfig = { ...this.streamConfig, feed: "iex", fallback: true, updatedAt: Date.now() };
          this.ctx.storage.put("streamConfig", this.streamConfig).catch(() => {});
          try { this.ws?.close(1000, "feed_fallback"); } catch {}
        }
        continue;
      }
      const symbol = event?.S;
      if (!symbol) continue;
      const item = this.market[symbol] || {};
      if (event.T === "q") item.quote = event;
      else if (event.T === "t") item.trade = event;
      else if (event.T === "b" || event.T === "u") item.bar = event;
      else if (event.T === "s") {
        item.status = event;
        item.halted = ["2", "H", "P"].includes(String(event.sc));
        if (["3", "Q", "T"].includes(String(event.sc))) item.halted = false;
      } else if (event.T === "l") item.luld = event;
      item.receivedAt = now;
      this.market[symbol] = item;
    }
    this.schedulePersist();
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.ctx.storage.put("market", this.market).catch(error =>
        console.error(JSON.stringify({ event: "market_persist_failed", message: error.message }))
      );
    }, 1500);
  }

  async alarm() {
    const cfg = this.streamConfig || await this.ctx.storage.get("streamConfig");
    if (cfg?.symbols?.length) {
      this.streamConfig = cfg;
      if (!this.ws || this.ws.readyState !== 1) this.connect();
      await this.ctx.storage.setAlarm(Date.now() + 8 * 60_000);
    }
  }
}