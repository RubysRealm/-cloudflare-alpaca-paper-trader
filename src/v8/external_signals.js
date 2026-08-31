import { bool, int, num, clamp } from "./config.js";

const API = "https://discord.com/api/v10";
const INVERSE = { SPY: "SH", QQQ: "PSQ", IWM: "RWM" };

function parseChannels(raw) {
  const out = [];
  for (const item of String(raw || "").split(",").map(x => x.trim()).filter(Boolean)) {
    const [id, labelRaw, weightRaw] = item.split("|").map(x => x?.trim());
    if (!/^\d+$/.test(id || "")) continue;
    const label = (labelRaw || `discord_${id.slice(-5)}`).slice(0, 40);
    const weight = clamp(num(weightRaw, 1), 0.25, 2);
    out.push({ id, label, weight });
  }
  return out.slice(0, 8);
}

function direction(text) {
  const t = String(text || "").toLowerCase();
  const bullish = /\b(buy|long|bullish|calls?|breakout|entry)\b/.test(t);
  const bearish = /\b(short|bearish|puts?|sell|fade|breakdown)\b/.test(t);
  if (bullish === bearish) return null;
  return bullish ? "long" : "short";
}

function symbolsIn(text, allowed) {
  const t = String(text || "").toUpperCase();
  const found = new Set();
  for (const match of t.matchAll(/\$([A-Z]{1,5})\b/g)) if (allowed.has(match[1])) found.add(match[1]);
  for (const token of t.match(/\b[A-Z]{1,5}\b/g) || []) if (allowed.has(token)) found.add(token);
  return [...found].slice(0, 6);
}

function addVote(map, symbol, side, source, weight, messageId) {
  const x = map.get(symbol) || { longWeight: 0, shortWeight: 0, longSources: new Set(), shortSources: new Set(), messageIds: [] };
  if (side === "long") { x.longWeight += weight; x.longSources.add(source); }
  else { x.shortWeight += weight; x.shortSources.add(source); }
  if (messageId) x.messageIds.push(messageId);
  map.set(symbol, x);
}

export async function discordConsensus(env, universe, now) {
  const enabled = bool(env.DISCORD_SIGNAL_ENABLED, true);
  const channels = parseChannels(env.DISCORD_SIGNAL_CHANNELS);
  const token = String(env.DISCORD_BOT_TOKEN || "").trim();
  const allowed = new Set(universe);
  for (const x of Object.values(INVERSE)) allowed.add(x);
  const votes = new Map();

  if (!enabled || !token || !channels.length) return { configured: false, channels: 0, votes };

  const cutoff = Number(now) - int(env.DISCORD_SIGNAL_LOOKBACK_MINUTES, 15) * 60_000;
  await Promise.all(channels.map(async channel => {
    try {
      const r = await fetch(`${API}/channels/${channel.id}/messages?limit=35`, {
        headers: { Authorization: `Bot ${token}`, "User-Agent": "AlpacaPaperGuard/8.1" }
      });
      if (!r.ok) {
        console.log(JSON.stringify({ event: "discord_source_failed", source: channel.label, status: r.status }));
        return;
      }
      const messages = await r.json();
      for (const m of messages || []) {
        const ts = Date.parse(m.timestamp || 0);
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        const text = `${m.content || ""} ${(m.embeds || []).map(e => `${e.title || ""} ${e.description || ""}`).join(" ")}`;
        const side = direction(text);
        if (!side) continue;
        for (const symbol of symbolsIn(text, allowed)) {
          addVote(votes, symbol, side, channel.label, channel.weight, m.id);
          if (side === "short" && INVERSE[symbol]) addVote(votes, INVERSE[symbol], "long", channel.label, channel.weight * 0.9, m.id);
        }
      }
    } catch (error) {
      console.log(JSON.stringify({ event: "discord_source_failed", source: channel.label, message: error.message }));
    }
  }));

  return { configured: true, channels: channels.length, votes };
}

export function applyDiscordConsensus(signal, vote) {
  if (!vote) return { ...signal, discord: { longSources: 0, shortSources: 0, longWeight: 0, shortWeight: 0, boost: 0 } };
  const longSources = vote.longSources.size, shortSources = vote.shortSources.size;
  const longWeight = vote.longWeight, shortWeight = vote.shortWeight;
  const longBoost = longSources >= 2 ? Math.min(14, 4 + longWeight * 3) : Math.min(3, longWeight * 2);
  const shortBoost = shortSources >= 2 ? Math.min(14, 4 + shortWeight * 3) : Math.min(3, shortWeight * 2);
  return {
    ...signal,
    score: signal.score + longBoost - shortBoost,
    shortScore: signal.shortScore + shortBoost - longBoost,
    discord: {
      longSources,
      shortSources,
      longWeight: Number(longWeight.toFixed(2)),
      shortWeight: Number(shortWeight.toFixed(2)),
      boost: Number((longBoost - shortBoost).toFixed(2))
    }
  };
}
