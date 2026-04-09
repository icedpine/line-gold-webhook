import express from "express";

const app = express();

app.use(express.text({ type: "*/*", limit: "1mb" }));

const SECRET_KEY = process.env.SECRET_KEY;

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

  const item = { cmd, symbol, id, ts: Date.now() };
  pushFamilyQueues(queues, item);

  return res.json({ ok: true, queued: true, copies: queues.length });
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

// ===== Queue families =====
// a = Bocchi
// b = Ayanobil
// c = Shabasu
// d = Yozakura
// e = Anyanical
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

// ===== health =====
app.get("/health", (req, res) => res.json({ ok: true, status: "ok" }));

// ===== JSON routes =====
const jsonParser = express.json({ strict: true, limit: "1mb" });

app.post("/signal/a", jsonParser, (req, res) => handleSignalFamily(req, res, queuesA, seenA));
app.post("/signal/b", jsonParser, (req, res) => handleSignalFamily(req, res, queuesB, seenB));
app.post("/signal/c", jsonParser, (req, res) => handleSignalFamily(req, res, queuesC, seenC));
app.post("/signal/d", jsonParser, (req, res) => handleSignalFamily(req, res, queuesD, seenD));
app.post("/signal/e", jsonParser, (req, res) => handleSignalFamily(req, res, queuesE, seenE));

for (let i = 1; i <= FAMILY_COPIES; i++) {
  app.get(`/last/a${i}`, (req, res) => handleLast(req, res, queuesA[i - 1]));
  app.get(`/last/b${i}`, (req, res) => handleLast(req, res, queuesB[i - 1]));
  app.get(`/last/c${i}`, (req, res) => handleLast(req, res, queuesC[i - 1]));
  app.get(`/last/d${i}`, (req, res) => handleLast(req, res, queuesD[i - 1]));
  app.get(`/last/e${i}`, (req, res) => handleLast(req, res, queuesE[i - 1]));
}

// ===== 判定関数 =====

// a = Bocchi
function detectDirectionA(text) {
  const t = String(text || "");
  if (t.includes("スタンバイサイン") && t.includes("BUY")) return "BUY";
  if (t.includes("スタンバイサイン") && t.includes("SELL")) return "SELL";
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

function queueFamilySignal({ channel, queues, room, who, text, symbol, cmd }) {
  symbol = normalizeSymbol(symbol);
  room = String(room || "");
  who = String(who || "");
  text = String(text || "");

  if (!cmd) return { ok: true, ignored: "no_direction" };

  const item = {
    cmd,
    symbol,
    id: safeId(channel.toUpperCase()),
    room,
    who,
    ts: Date.now()
  };

  const dkey = abMakeDedupKey({ channel, who, room, cmd, symbol, text });
  if (abIsDuplicateAndMark(dkey)) {
    return { ok: true, deduped: true, reason: "short_window" };
  }

  pushFamilyQueues(queues, item);
  return { ok: true, queued: true, copies: queues.length };
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
