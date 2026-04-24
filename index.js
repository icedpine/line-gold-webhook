import express from "express";
import { Client, GatewayIntentBits, Partials } from "discord.js";

const app = express();

app.use(express.text({ type: "*/*", limit: "1mb" }));

const SECRET_KEY = process.env.SECRET_KEY;

// ===== Discord Bot / GAS settings =====
// 追加：Discord通知を読み取り、GASへ送るための環境変数
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
const GAS_SECRET_KEY = process.env.GAS_SECRET_KEY;

// ===== 共通設定 =====
const MAX_QUEUE = 200;
const SEEN_TTL_MS = 5 * 60 * 1000;
const AB_DEDUP_MS = 2000;
const FAMILY_COPIES = 10;

function requireKey(req, res) {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    res.status(403).json({ error: "invalid key" });
    return false;
  }
  return true;
}

function normalizeCmd(cmd) {
  const c = String(cmd || "").trim().toUpperCase();
  return c === "BUY" || c === "SELL" ? c : "";
}

function normalizeSymbol(symbol) {
  let s = String(symbol || "").trim();
  const u = s.toUpperCase();

  // GOLD group
  if (u === "GOLD") return "GOLD";
  if (u === "GOLDMICRO") return "GOLDmicro";
  if (u === "GOLDS") return "GOLDs";
  if (u === "GOLDC") return "GOLDc";

  // XAUUSD group
  if (u === "XAUUSD") return "XAUUSD";
  if (u === "XAUUSDMICRO") return "XAUUSDmicro";
  if (u === "XAUUSDS") return "XAUUSDs";
  if (u === "XAUUSDC") return "XAUUSDc";

  // USDJPY group
  if (u === "USDJPY") return "USDJPY";
  if (u === "USDJPYMICRO") return "USDJPYmicro";
  if (u === "USDJPYS") return "USDJPYs";
  if (u === "USDJPYC") return "USDJPYc";

  // EURUSD group
  if (u === "EURUSD") return "EURUSD";
  if (u === "EURUSDMICRO") return "EURUSDmicro";
  if (u === "EURUSDS") return "EURUSDs";
  if (u === "EURUSDC") return "EURUSDc";

  // AUDUSD group
  if (u === "AUDUSD") return "AUDUSD";
  if (u === "AUDUSDMICRO") return "AUDUSDmicro";
  if (u === "AUDUSDS") return "AUDUSDs";
  if (u === "AUDUSDC") return "AUDUSDc";

  // GBPUSD group
  if (u === "GBPUSD") return "GBPUSD";
  if (u === "GBPUSDMICRO") return "GBPUSDmicro";
  if (u === "GBPUSDS") return "GBPUSDs";
  if (u === "GBPUSDC") return "GBPUSDc";

  // 旧互換
  if (u === "XAU/USD" || u === "XAUUSD#") return "XAUUSD";
  if (u === "USD/JPY") return "USDJPY";
  if (u === "EUR/USD") return "EURUSD";
  if (u === "AUD/USD") return "AUDUSD";
  if (u === "GBP/USD") return "GBPUSD";

  return s;
}

// ===== 修正：priceTag が空欄のとき 0.00 にならないようにする =====
function normalizePriceTag2(priceTag) {
  const raw = String(priceTag ?? "").trim();
  if (raw === "") return "";

  const n = Number(raw);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(2);
}

function pushQueue(queue, item) {
  queue.push(item);
  while (queue.length > MAX_QUEUE) queue.shift();
}

function pushFamilyQueues(queues, item) {
  for (let i = 0; i < queues.length; i++) {
    pushQueue(queues[i], { ...item });
  }
}

function safeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function cleanupSeen(seenMap) {
  const now = Date.now();
  for (const [id, ts] of seenMap.entries()) {
    if (now - ts > SEEN_TTL_MS) seenMap.delete(id);
  }
}

function handleSignalFamily(req, res, queues, seen) {
  if (!requireKey(req, res)) return;

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }

  // ===== 修正：positionSize も受け取る =====
  let { cmd, symbol, id, priceTag, positionSize } = body || {};

  if (!cmd || !symbol || !id) {
    return res.status(400).json({ error: "missing fields" });
  }

  cmd = normalizeCmd(cmd);
  symbol = normalizeSymbol(symbol);
  id = String(id);
  priceTag = priceTag == null ? "" : normalizePriceTag2(priceTag);
  positionSize = positionSize == null ? "" : String(positionSize);

  if (!cmd) return res.status(400).json({ error: "invalid cmd" });
  if (!symbol) return res.status(400).json({ error: "invalid symbol" });

  cleanupSeen(seen);
  if (seen.has(id)) return res.json({ ok: true, deduped: true });
  seen.set(id, Date.now());

  // ===== 修正：positionSize もキューに保存 =====
  const item = {
    cmd,
    symbol,
    id,
    priceTag,
    positionSize,
    ts: Date.now()
  };

  pushFamilyQueues(queues, item);

  return res.json({
    ok: true,
    queued: true,
    copies: queues.length,
    priceTag,
    positionSize
  });
}

function handleLast(req, res, queue) {
  if (!requireKey(req, res)) return;
  if (queue.length === 0) return res.json({ signal: null });
  return res.json(queue.shift());
}

function abMakeDedupKey({ channel, who, room, cmd, symbol, text, priceTag }) {
  const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const p = String(priceTag || "");
  return `${channel}|${who}|${room}|${cmd}|${symbol}|${p}|${t}`;
}

const abRecent = new Map();

function abIsDuplicateAndMark(key) {
  const now = Date.now();
  const prev = abRecent.get(key) || 0;

  for (const [k, ts] of abRecent.entries()) {
    if (now - ts > AB_DEDUP_MS * 5) abRecent.delete(k);
  }

  if (now - prev < AB_DEDUP_MS) return true;
  abRecent.set(key, now);
  return false;
}

// ===== Queue families =====
// a = Bocchi
// b = Ayanobil
// c = Shabasu
// d = Yozakura
// e = Anyanical
// f = TradingView REM BB Pullback Rider V3
// g = TradingView Wemof Strategy
const queuesA = Array.from({ length: FAMILY_COPIES }, () => []);
const seenA = new Map();

const queuesB = Array.from({ length: FAMILY_COPIES }, () => []);
const seenB = new Map();

const queuesC = Array.from({ length: FAMILY_COPIES }, () => []);
const seenC = new Map();

const queuesD = Array.from({ length: FAMILY_COPIES }, () => []);
const seenD = new Map();

const queuesE = Array.from({ length: FAMILY_COPIES }, () => []);
const seenE = new Map();

const queuesF = Array.from({ length: FAMILY_COPIES }, () => []);
const seenF = new Map();

// ===== 追加：Gグループ Wemof =====
const queuesG = Array.from({ length: FAMILY_COPIES }, () => []);
const seenG = new Map();

// ===== health =====
app.get("/health", (req, res) => res.json({ ok: true, status: "ok" }));

// ===== JSON routes =====
const jsonParser = express.json({ strict: true, limit: "1mb" });

app.post("/signal/a", jsonParser, (req, res) => handleSignalFamily(req, res, queuesA, seenA));
app.post("/signal/b", jsonParser, (req, res) => handleSignalFamily(req, res, queuesB, seenB));
app.post("/signal/c", jsonParser, (req, res) => handleSignalFamily(req, res, queuesC, seenC));
app.post("/signal/d", jsonParser, (req, res) => handleSignalFamily(req, res, queuesD, seenD));
app.post("/signal/e", jsonParser, (req, res) => handleSignalFamily(req, res, queuesE, seenE));
app.post("/signal/f", jsonParser, (req, res) => handleSignalFamily(req, res, queuesF, seenF));

// ===== 追加：Gグループ Wemof =====
app.post("/signal/g", jsonParser, (req, res) => handleSignalFamily(req, res, queuesG, seenG));

for (let i = 1; i <= FAMILY_COPIES; i++) {
  app.get(`/last/a${i}`, (req, res) => handleLast(req, res, queuesA[i - 1]));
  app.get(`/last/b${i}`, (req, res) => handleLast(req, res, queuesB[i - 1]));
  app.get(`/last/c${i}`, (req, res) => handleLast(req, res, queuesC[i - 1]));
  app.get(`/last/d${i}`, (req, res) => handleLast(req, res, queuesD[i - 1]));
  app.get(`/last/e${i}`, (req, res) => handleLast(req, res, queuesE[i - 1]));
  app.get(`/last/f${i}`, (req, res) => handleLast(req, res, queuesF[i - 1]));

  // ===== 追加：Gグループ Wemof =====
  app.get(`/last/g${i}`, (req, res) => handleLast(req, res, queuesG[i - 1]));
}

// ===== 判定関数 =====

// a = Bocchi
function detectDirectionA(text) {
  const t = String(text || "");
  if (t.includes("エントリーサイン") && t.includes("BUY")) return "BUY";
  if (t.includes("エントリーサイン") && t.includes("SELL")) return "SELL";
  return "";
}

// b = Ayanobil
function detectDirectionB(text) {
  const t = String(text || "");
  if (t.includes("BUY signal")) return "BUY";
  if (t.includes("SELL signal")) return "SELL";
  return "";
}

// c = Shabasu
function detectDirectionC(text) {
  const t = String(text || "");
  if (t.includes("BUY signal")) return "BUY";
  if (t.includes("SELL signal")) return "SELL";
  return "";
}

// d = Yozakura
function detectDirectionD(text) {
  const t = String(text || "");
  if (t.includes("USDJPYロングエントリー")) return "BUY";
  if (t.includes("USDJPYショートエントリー")) return "SELL";
  return "";
}

// e = Anyanical
function detectDirectionE(text) {
  const t = String(text || "");
  if (t.includes("BUY signal")) return "BUY";
  if (t.includes("SELL signal")) return "SELL";
  return "";
}

// f = TradingView REM BB Pullback Rider V3
function detectDirectionF(text) {
  const t = String(text || "");
  const m = t.match(/\b(buy|sell)\b\s*@/i);
  return m ? String(m[1]).toUpperCase() : "";
}

function extractPriceTagF(text) {
  const t = String(text || "");
  const m = t.match(/@\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!m) return "";
  return normalizePriceTag2(m[1]);
}

function detectSymbolF(text) {
  const t = String(text || "");
  const m = t.match(/:\s*([A-Za-z0-9\/#]+)\s*で\s*(?:buy|sell)\b/i);
  if (!m) return "";
  return normalizeSymbol(m[1]);
}

function queueFamilySignal({ channel, queues, room, who, text, symbol, cmd, priceTag }) {
  symbol = normalizeSymbol(symbol);
  room = String(room || "");
  who = String(who || "");
  text = String(text || "");
  priceTag = priceTag ? normalizePriceTag2(priceTag) : "";

  if (!cmd) return { ok: true, ignored: "no_direction" };

  const item = {
    cmd,
    symbol,
    id: safeId(channel.toUpperCase()),
    priceTag,
    room,
    who,
    ts: Date.now()
  };

  const dkey = abMakeDedupKey({ channel, who, room, cmd, symbol, text, priceTag });
  if (abIsDuplicateAndMark(dkey)) {
    return { ok: true, deduped: true, reason: "short_window" };
  }

  pushFamilyQueues(queues, item);
  return { ok: true, queued: true, copies: queues.length, priceTag };
}

// ===== Plain routes =====

// a = Bocchi
app.post("/signal/a_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.query.room || "");
  const who = String(req.query.who || "");
  const symbol = String(req.query.symbol || "GOLDmicro");
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  const cmd = detectDirectionA(text);
  const out = queueFamilySignal({
    channel: "a",
    queues: queuesA,
    room,
    who,
    text,
    symbol,
    cmd
  });
  return res.json(out);
});

// b = Ayanobil
app.post("/signal/b_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.query.room || "");
  const who = String(req.query.who || "");
  const symbol = String(req.query.symbol || "GOLDmicro");
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  const cmd = detectDirectionB(text);
  const out = queueFamilySignal({
    channel: "b",
    queues: queuesB,
    room,
    who,
    text,
    symbol,
    cmd
  });
  return res.json(out);
});

// c = Shabasu
app.post("/signal/c_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.query.room || "");
  const who = String(req.query.who || "");
  const symbol = String(req.query.symbol || "GOLDmicro");
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  const cmd = detectDirectionC(text);
  const out = queueFamilySignal({
    channel: "c",
    queues: queuesC,
    room,
    who,
    text,
    symbol,
    cmd
  });
  return res.json(out);
});

// d = Yozakura
app.post("/signal/d_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.query.room || "");
  const who = String(req.query.who || "");
  const symbol = String(req.query.symbol || "USDJPY");
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  if (room && room !== "【FXドル円】さくらサロンEA【裁量EA/自動売買】〈GOLD〉コピトレ") {
    return res.json({ ok: true, ignored: "room_mismatch", room });
  }
  if (who && who !== "春音 さくら") {
    return res.json({ ok: true, ignored: "who_mismatch", who });
  }

  const cmd = detectDirectionD(text);
  const out = queueFamilySignal({
    channel: "d",
    queues: queuesD,
    room,
    who,
    text,
    symbol,
    cmd
  });
  return res.json(out);
});

// e = Anyanical
app.post("/signal/e_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.query.room || "");
  const who = String(req.query.who || "");
  const symbol = String(req.query.symbol || "USDJPYmicro");
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  const cmd = detectDirectionE(text);
  const out = queueFamilySignal({
    channel: "e",
    queues: queuesE,
    room,
    who,
    text,
    symbol,
    cmd
  });
  return res.json(out);
});

// f = TradingView REM BB Pullback Rider V3
app.post("/signal/f_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.query.room || "");
  const who = String(req.query.who || "");
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  const cmd = detectDirectionF(text);
  const detectedSymbol = detectSymbolF(text);
  const symbol = String(req.query.symbol || detectedSymbol || "USDJPY");
  const priceTag = extractPriceTagF(text);

  if (!priceTag) {
    return res.json({ ok: true, ignored: "no_price_tag" });
  }

  const out = queueFamilySignal({
    channel: "f",
    queues: queuesF,
    room,
    who,
    text,
    symbol,
    cmd,
    priceTag
  });
  return res.json(out);
});

// ==================================================
// 追加：Discord Bot → GAS → Google Sheets
// ==================================================

function startDiscordTradeLoggerBot() {
  const ready =
    DISCORD_BOT_TOKEN &&
    DISCORD_CHANNEL_ID &&
    GAS_WEBAPP_URL &&
    GAS_SECRET_KEY;

  if (!ready) {
    console.log("[TradeLoggerBot] Disabled. Missing one or more env vars:", {
      DISCORD_BOT_TOKEN: Boolean(DISCORD_BOT_TOKEN),
      DISCORD_CHANNEL_ID: Boolean(DISCORD_CHANNEL_ID),
      GAS_WEBAPP_URL: Boolean(GAS_WEBAPP_URL),
      GAS_SECRET_KEY: Boolean(GAS_SECRET_KEY)
    });
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  client.once("ready", () => {
    console.log(`[TradeLoggerBot] Logged in as ${client.user.tag}`);
    console.log(`[TradeLoggerBot] Watching channel: ${DISCORD_CHANNEL_ID}`);
  });

  client.on("messageCreate", async (message) => {
    try {
      if (message.channelId !== DISCORD_CHANNEL_ID) return;

      // 自分自身の投稿だけ無視
      if (message.author?.id === client.user.id) return;

      const parsed = parseTradeNotice(message);

      if (!parsed) {
        console.log("[TradeLoggerBot] Ignored non-trade message.");
        return;
      }

      await sendToGas(parsed);

      console.log(
        "[TradeLoggerBot] Logged:",
        parsed.type,
        parsed.sourceName,
        parsed.symbol,
        parsed.identifier,
        parsed.profit || parsed.direction || ""
      );
    } catch (err) {
      console.error("[TradeLoggerBot] messageCreate error:", err);
    }
  });

  client.login(DISCORD_BOT_TOKEN).catch((err) => {
    console.error("[TradeLoggerBot] Discord login failed:", err);
  });
}

function parseTradeNotice(message) {
  const sourceName =
    message.author?.username ||
    message.webhookId ||
    "unknown";

  const parts = [];

  if (message.content) {
    parts.push(message.content);
  }

  for (const embed of message.embeds || []) {
    if (embed.title) {
      parts.push(embed.title);
    }

    if (embed.description) {
      parts.push(embed.description);
    }

    for (const field of embed.fields || []) {
      parts.push(`${field.name}: ${field.value}`);
    }

    if (embed.footer?.text) {
      parts.push(`footer: ${embed.footer.text}`);
    }
  }

  const rawText = parts.join("\n").trim();

  if (!rawText) return null;

  const isEntry =
    rawText.includes("エントリー検出") ||
    rawText.includes("方向:") ||
    rawText.includes("方向：");

  const isClose =
    rawText.includes("決済完了通知") ||
    rawText.includes("損益:") ||
    rawText.includes("損益：");

  if (!isEntry && !isClose) return null;

  return {
    type: isClose ? "close" : "entry",
    sourceName,
    eventTime: pickTradeValue(rawText, ["時刻"]),
    symbol: pickTradeValue(rawText, ["銘柄"]),
    direction: pickTradeValue(rawText, ["方向"]),
    price: pickTradeValue(rawText, ["価格"]),
    holding: pickTradeValue(rawText, ["保有"]),
    profit: pickTradeValue(rawText, ["損益"]),
    identifier: pickTradeValue(rawText, ["識別"]),
    rawText
  };
}

function pickTradeValue(text, labels) {
  for (const label of labels) {
    const re = new RegExp(`${escapeRegExpForTradeLogger(label)}\\s*[:：]\\s*([^\\n]+)`, "i");
    const m = String(text || "").match(re);

    if (m) {
      return m[1].trim();
    }
  }

  return "";
}

function escapeRegExpForTradeLogger(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sendToGas(payload) {
  const url = `${GAS_WEBAPP_URL}?key=${encodeURIComponent(GAS_SECRET_KEY)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`GAS HTTP ${res.status}: ${text}`);
  }

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid GAS response: ${text}`);
  }

  if (!json.ok) {
    throw new Error(`GAS error: ${text}`);
  }

  return json;
}

// ===== server start =====
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log("Server running on port", port);
  startDiscordTradeLoggerBot();
});
