import express from "express";

const app = express();
app.use(express.json({ strict: true, limit: "1mb" }));

const SECRET_KEY = process.env.SECRET_KEY;

// ===== 共通設定 =====
const MAX_QUEUE = 200;

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
  let s = String(symbol || "").trim().toUpperCase();
  if (s === "XAUUSD" || s === "XAUUSD#" || s === "XAU/USD" || s === "GOLD") s = "GOLD";
  return s;
}

function pushQueue(queue, item) {
  queue.push(item);
  while (queue.length > MAX_QUEUE) queue.shift();
}

// ===== Queue A/B =====
const queueA = [];
const seenA = new Map();
const queueB = [];
const seenB = new Map();

// ===== Queue C =====
const queueC = [];

// ===== health =====
app.get("/health", (req, res) => res.json({ ok: true, status: "ok" }));

// ===== A/B：汎用フォーマット受信（なるべく変更しない） =====
const SEEN_TTL_MS = 5 * 60 * 1000;

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
    return res.status(400).json({
      error: "missing fields",
      required: ["cmd", "symbol", "id"],
      received: req.body
    });
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
  return res.json({ ok: true, queued: true, size: queue.length });
}

function handleLast(req, res, queue) {
  if (!requireKey(req, res)) return;
  if (queue.length === 0) return res.json({ signal: null });
  return res.json(queue.shift());
}

app.post("/signal/a", (req, res) => handleSignal(req, res, queueA, seenA));
app.get("/last/a", (req, res) => handleLast(req, res, queueA));

app.post("/signal/b", (req, res) => handleSignal(req, res, queueB, seenB));
app.get("/last/b", (req, res) => handleLast(req, res, queueB));


// ===== C：raw本文を受け取り、admin別に entry/sl を抽出して queueC へ積む =====

// Renderログで切り分けできるようにする（必要なら false に）
const DEBUG_C = true;

function cLog(...args) {
  if (DEBUG_C) console.log(...args);
}

function extractNumber(text, patterns) {
  for (const re of patterns) {
    const m = String(text || "").match(re);
    if (m && m[1]) return Number(m[1]);
  }
  return null;
}

function guessAdmin(admin, text) {
  const a = String(admin || "").trim();
  if (a) return a;

  const t = String(text || "");

  // MacroDroid通知の省略/揺れを吸収
  if (t.includes("ゆな")) return "ゆな";
  if (t.includes("しおり")) return "しおり";
  if (t.includes("パートナー") && t.includes("しおり")) return "しおり";

  return "unknown";
}

function detectDirection(text) {
  const t = String(text || "");
  const u = t.toUpperCase();

  // 通知は「GOLDロング」じゃなく「ロング」だけのことがあるので緩く判定
  const isLong =
    t.includes("ロング") ||
    u.includes("GOLD LONG") ||
    u.includes("LONG") ||
    u.includes("BUY") ||
    t.includes("買い");

  const isShort =
    t.includes("ショート") ||
    u.includes("GOLD SHORT") ||
    u.includes("SHORT") ||
    u.includes("SELL") ||
    t.includes("売り");

  // 両方入ってたら危険なので無視
  if (isLong && isShort) return "";
  if (!isLong && !isShort) return "";

  return isLong ? "BUY" : "SELL";
}

function parseEntrySlByAdmin(who, text) {
  const t = String(text || "");
  // 記号揺れ：⇒ => → : ： を全部許容
  const arrow = "[:：⇒=>→]";

  if (who === "ゆな") {
    const entry = extractNumber(t, [
      new RegExp(`エントリー\\s*${arrow}\\s*([0-9]+(?:\\.[0-9]+)?)`, "i")
    ]);
    const sl = extractNumber(t, [
      new RegExp(`損切\\s*${arrow}\\s*([0-9]+(?:\\.[0-9]+)?)`, "i")
    ]);
    return { entry, sl };
  }

  if (who === "しおり") {
    const entry = extractNumber(t, [
      new RegExp(`\\bEN\\s*${arrow}\\s*([0-9]+(?:\\.[0-9]+)?)`, "i")
    ]);
    const sl = extractNumber(t, [
      new RegExp(`\\bSL\\s*${arrow}\\s*([0-9]+(?:\\.[0-9]+)?)`, "i")
    ]);
    return { entry, sl };
  }

  return { entry: null, sl: null };
}

// ★★★ C本命：/signal/c ★★★
app.post("/signal/c", (req, res) => {
  if (!requireKey(req, res)) return;

  let { room, admin, text, id, symbol } = req.body;

  room = String(room || "");
  admin = String(admin || "");
  text = String(text || "");
  symbol = normalizeSymbol(symbol || "GOLD");

  // id が無い場合は作る（今回は重複防止しない）
  id = String(id || "");
  if (!id) id = "C-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);

  if (!text) {
    cLog("[C] bad_request missing_text", { id, room, admin });
    return res.status(400).json({
      error: "missing fields",
      required: ["text"],
      received: req.body
    });
  }

  // direction（BUY/SELL）
  const cmd = detectDirection(text);
  if (!cmd) {
    cLog("[C] ignored no_direction", { id, room, admin, text });
    return res.json({ ok: true, ignored: "no_direction" });
  }

  // admin 推定
  const who = guessAdmin(admin, text);

  // 今回は「ゆな」「しおり」だけ
  if (who !== "ゆな" && who !== "しおり") {
    cLog("[C] ignored admin_not_allowed", { id, room, who, admin, text });
    return res.json({ ok: true, ignored: "admin_not_allowed", who, room });
  }

  // entry / sl（admin別のキーで拾う：仕様通り）
  const { entry, sl } = parseEntrySlByAdmin(who, text);

  if (entry == null || sl == null || Number.isNaN(entry) || Number.isNaN(sl)) {
    cLog("[C] parse_failed", { id, room, who, cmd, text });
    return res.status(400).json({
      error: "parse_failed",
      need: ["entry", "sl"],
      who,
      room,
      received_text: text
    });
  }

  // n=3固定（仕様）
  const n = 3;

  // ★重複防止はしない → 連投も全部通す
  const item = {
    cmd,
    symbol: symbol || "GOLD",
    id,
    entry,
    sl,
    n,
    who,
    room,
    ts: Date.now()
  };

  pushQueue(queueC, item);

  cLog("[C] queued", item);
  return res.json({ ok: true, queued: true, size: queueC.length });
});

// 互換：旧 /signal/c_raw も /signal/c と同じ処理に流す
app.post("/signal/c_raw", (req, res) => {
  req.url = "/signal/c" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
  return app._router.handle(req, res, () => {});
});

app.get("/last/c", (req, res) => handleLast(req, res, queueC));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
