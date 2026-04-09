import express from "express";

const app = express();

app.use(express.text({ type: "*/*", limit: "1mb" }));

const SECRET_KEY = process.env.SECRET_KEY;

// ===== 共通設定 =====
const MAX_QUEUE = 200;
const SEEN_TTL_MS = 5 * 60 * 1000;
const AB_DEDUP_MS = 2000;

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

function pushQueue(queue, item) {
  queue.push(item);
  while (queue.length > MAX_QUEUE) queue.shift();
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

function handleSignal(req, res, queue, seen) {
  if (!requireKey(req, res)) return;

  let { cmd, symbol, id } = req.body;
  if (!cmd || !symbol || !id) {
    return res.status(400).json({ error: "missing fields" });
  }

  cmd = normalizeCmd(cmd);
  symbol = normalizeSymbol(symbol);
  id = String(id);

  if (!cmd) return res.status(400).json({ error: "invalid cmd" });
  if (!symbol) return res.status(400).json({ error: "invalid symbol" });

  cleanupSeen(seen);
  if (seen.has(id)) return res.json({ ok: true, deduped: true });
  seen.set(id, Date.now());

  pushQueue(queue, { cmd, symbol, id, ts: Date.now() });
  return res.json({ ok: true, queued: true });
}

function handleLast(req, res, queue) {
  if (!requireKey(req, res)) return;
  if (queue.length === 0) return res.json({ signal: null });
  return res.json(queue.shift());
}

function abMakeDedupKey({ channel, who, room, cmd, symbol, text }) {
  const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${channel}|${who}|${room}|${cmd}|${symbol}|${t}`;
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

// ===== Queue A/D/E/F/G =====
const queueA = [];
const seenA = new Map();

const queueD = [];
const seenD = new Map();

const queueE = [];
const seenE = new Map();

const queueF = [];
const seenF = new Map();

// ★追加：G
const queueG = [];
const seenG = new Map();

// ===== health =====
app.get("/health", (req, res) => res.json({ ok: true, status: "ok" }));

// ===== A/D/E/F/G：汎用フォーマット受信 =====
const jsonParser = express.json({ strict: true, limit: "1mb" });

app.post("/signal/a", jsonParser, (req, res) => handleSignal(req, res, queueA, seenA));
app.get("/last/a", (req, res) => handleLast(req, res, queueA));

app.post("/signal/d", jsonParser, (req, res) => handleSignal(req, res, queueD, seenD));
app.get("/last/d", (req, res) => handleLast(req, res, queueD));

app.post("/signal/e", jsonParser, (req, res) => handleSignal(req, res, queueE, seenE));
app.get("/last/e", (req, res) => handleLast(req, res, queueE));

app.post("/signal/f", jsonParser, (req, res) => handleSignal(req, res, queueF, seenF));
app.get("/last/f", (req, res) => handleLast(req, res, queueF));

// ★追加：G
app.post("/signal/g", jsonParser, (req, res) => handleSignal(req, res, queueG, seenG));
app.get("/last/g", (req, res) => handleLast(req, res, queueG));

// A専用
function detectDirectionA(text) {
  const t = String(text || "");
  if (t.includes("USDJPYロングエントリー")) return "BUY";
  if (t.includes("USDJPYショートエントリー")) return "SELL";
  return "";
}

// D専用
function detectDirectionD(text) {
  const t = String(text || "");
  if (t.includes("スタンバイサイン") && t.includes("BUY")) return "BUY";
  if (t.includes("スタンバイサイン") && t.includes("SELL")) return "SELL";
  return "";
}

// E専用
function detectDirectionE(text) {
  const t = String(text || "");
  if (t.includes("BUY signal")) return "BUY";
  if (t.includes("SELL signal")) return "SELL";
  return "";
}

// F専用
function detectDirectionF(text) {
  const t = String(text || "");
  if (t.includes("BUY signal")) return "BUY";
  if (t.includes("SELL signal")) return "SELL";
  return "";
}

// ★追加：G専用
function detectDirectionG(text) {
  const t = String(text || "");
  if (t.includes("BUY signal")) return "BUY";
  if (t.includes("SELL signal")) return "SELL";
  return "";
}

function queueASignal({ room, who, text, symbol }) {
  symbol = normalizeSymbol(symbol || "USDJPY");
  room = String(room || "");
  who = String(who || "");
  text = String(text || "");

  const cmd = detectDirectionA(text);
  if (!cmd) return { ok: true, ignored: "no_direction" };

  const item = {
    cmd,
    symbol,
    id: safeId("A"),
    room,
    who,
    ts: Date.now()
  };

  const dkey = abMakeDedupKey({ channel: "A", who, room, cmd, symbol, text });
  if (abIsDuplicateAndMark(dkey)) return { ok: true, deduped: true, reason: "short_window" };

  pushQueue(queueA, item);
  return { ok: true, queued: true, size: queueA.length };
}

function queueDSignal({ room, who, text, symbol }) {
  symbol = normalizeSymbol(symbol || "GOLDmicro");
  room = String(room || "");
  who = String(who || "");
  text = String(text || "");

  const cmd = detectDirectionD(text);
  if (!cmd) return { ok: true, ignored: "no_direction" };

  const item = {
    cmd,
    symbol,
    id: safeId("D"),
    room,
    who,
    ts: Date.now()
  };

  const dkey = abMakeDedupKey({ channel: "D", who, room, cmd, symbol, text });
  if (abIsDuplicateAndMark(dkey)) return { ok: true, deduped: true, reason: "short_window" };

  pushQueue(queueD, item);
  return { ok: true, queued: true, size: queueD.length };
}

function queueESignal({ room, who, text, symbol }) {
  symbol = normalizeSymbol(symbol || "GOLDmicro");
  room = String(room || "");
  who = String(who || "");
  text = String(text || "");

  const cmd = detectDirectionE(text);
  if (!cmd) return { ok: true, ignored: "no_direction" };

  const item = {
    cmd,
    symbol,
    id: safeId("E"),
    room,
    who,
    ts: Date.now()
  };

  const dkey = abMakeDedupKey({ channel: "E", who, room, cmd, symbol, text });
  if (abIsDuplicateAndMark(dkey)) return { ok: true, deduped: true, reason: "short_window" };

  pushQueue(queueE, item);
  return { ok: true, queued: true, size: queueE.length };
}

function queueFSignal({ room, who, text, symbol }) {
  symbol = normalizeSymbol(symbol || "GOLDmicro");
  room = String(room || "");
  who = String(who || "");
  text = String(text || "");

  const cmd = detectDirectionF(text);
  if (!cmd) return { ok: true, ignored: "no_direction" };

  const item = {
    cmd,
    symbol,
    id: safeId("F"),
    room,
    who,
    ts: Date.now()
  };

  const dkey = abMakeDedupKey({ channel: "F", who, room, cmd, symbol, text });
  if (abIsDuplicateAndMark(dkey)) return { ok: true, deduped: true, reason: "short_window" };

  pushQueue(queueF, item);
  return { ok: true, queued: true, size: queueF.length };
}

// ★追加：G
function queueGSignal({ room, who, text, symbol }) {
  symbol = normalizeSymbol(symbol || "USDJPYmicro");
  room = String(room || "");
  who = String(who || "");
  text = String(text || "");

  const cmd = detectDirectionG(text);
  if (!cmd) return { ok: true, ignored: "no_direction" };

  const item = {
    cmd,
    symbol,
    id: safeId("G"),
    room,
    who,
    ts: Date.now()
  };

  const dkey = abMakeDedupKey({ channel: "G", who, room, cmd, symbol, text });
  if (abIsDuplicateAndMark(dkey)) return { ok: true, deduped: true, reason: "short_window" };

  pushQueue(queueG, item);
  return { ok: true, queued: true, size: queueG.length };
}

// ===== A：Plain =====
app.post("/signal/a_plain", (req, res) => {
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

  const out = queueASignal({ room, who, text, symbol });
  return res.json(out);
});

// D
app.post("/signal/d_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.query.room || "");
  const who = String(req.query.who || "");
  const symbol = String(req.query.symbol || "GOLDmicro");
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  const out = queueDSignal({ room, who, text, symbol });
  return res.json(out);
});

// E
app.post("/signal/e_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.query.room || "");
  const who = String(req.query.who || "");
  const symbol = String(req.query.symbol || "GOLDmicro");
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  const out = queueESignal({ room, who, text, symbol });
  return res.json(out);
});

// F
app.post("/signal/f_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.query.room || "");
  const who = String(req.query.who || "");
  const symbol = String(req.query.symbol || "GOLDmicro");
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  const out = queueFSignal({ room, who, text, symbol });
  return res.json(out);
});

// ★追加：G
app.post("/signal/g_plain", (req, res) => {
  if (!requireKey(req, res)) return;

  const room = String(req.query.room || "");
  const who = String(req.query.who || "");
  const symbol = String(req.query.symbol || "USDJPYmicro");
  const text = typeof req.body === "string" ? req.body : "";

  if (!text) return res.status(400).json({ error: "missing body text" });

  const out = queueGSignal({ room, who, text, symbol });
  return res.json(out);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
