import express from "express";

const app = express();
app.use(express.json());

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

function extractNumber(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return Number(m[1]);
  }
  return null;
}

function guessAdmin(admin, text) {
  const a = String(admin || "").trim();
  if (a) return a;

  // 通知本文から推定（MacroDroidが admin:"" なのでここ重要）
  if (text.includes("ゆな")) return "ゆな";
  if (text.includes("しおり")) return "しおり";
  // 「しおり(ゆなさんのパートナー」の表記揺れも吸収
  if (text.includes("パートナー") && text.includes("しおり")) return "しおり";
  return "unknown";
}

function detectDirection(text) {
  const t = String(text || "");

  // 必須条件：GOLDロング or GOLDショート が入ったときだけ反応させる（あなたの仕様通り）
  const hasGoldLong = t.includes("GOLDロング") || t.includes("GOLD ロング");
  const hasGoldShort = t.includes("GOLDショート") || t.includes("GOLD ショート");

  // 念のため英語表記も吸収（通知が変化する可能性対策）
  const hasLongEn = t.toUpperCase().includes("GOLD LONG");
  const hasShortEn = t.toUpperCase().includes("GOLD SHORT");

  const isLong = hasGoldLong || hasLongEn;
  const isShort = hasGoldShort || hasShortEn;

  if (!isLong && !isShort) return "";      // 方向なし
  if (isLong && isShort) return "";        // 両方入ってたら危険なので無視
  return isLong ? "BUY" : "SELL";
}

function parseEntrySlByAdmin(who, text) {
  // admin別に拾うキーを固定（仕様通り、他は完全無視）
  if (who === "ゆな") {
    const entry = extractNumber(text, [
      /エントリー\s*[⇒=>]\s*([0-9]+(?:\.[0-9]+)?)/i
    ]);
    const sl = extractNumber(text, [
      /損切\s*[⇒=>]\s*([0-9]+(?:\.[0-9]+)?)/i
    ]);
    return { entry, sl };
  }

  if (who === "しおり") {
    const entry = extractNumber(text, [
      /\bEN\s*[⇒=>]\s*([0-9]+(?:\.[0-9]+)?)/i
    ]);
    const sl = extractNumber(text, [
      /\bSL\s*[⇒=>]\s*([0-9]+(?:\.[0-9]+)?)/i
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

  // id は MacroDroid から来る想定だが、無い場合もサーバー側で作る（今回は重複防止しないので問題なし）
  id = String(id || "");
  if (!id) id = "C-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);

  if (!text) {
    return res.status(400).json({
      error: "missing fields",
      required: ["text"],
      received: req.body
    });
  }

  // direction（BUY/SELL）
  const cmd = detectDirection(text);
  if (!cmd) return res.json({ ok: true, ignored: "no_direction" });

  // admin 推定
  const who = guessAdmin(admin, text);

  // 今回は「ゆな」と「しおり」だけを拾う（仕様）
  if (who !== "ゆな" && who !== "しおり") {
    return res.json({ ok: true, ignored: "admin_not_allowed", who, room });
  }

  // entry / sl
  const { entry, sl } = parseEntrySlByAdmin(who, text);
  if (entry == null || sl == null || Number.isNaN(entry) || Number.isNaN(sl)) {
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

  // ★重要：重複防止はしない → seenCは使わない（連投も全部通す）
  pushQueue(queueC, {
    cmd,
    symbol: symbol || "GOLD",
    id,
    entry,
    sl,
    n,
    who,
    room,
    ts: Date.now()
  });

  return res.json({ ok: true, queued: true, size: queueC.length });
});

// 互換：旧 /signal/c_raw も /signal/c と同じ処理に流す
app.post("/signal/c_raw", (req, res) => {
  // 中身同じにしたいので /signal/c の処理を再利用したいが、
  // expressの都合上ここでは同処理を呼び直すのではなく、単純に同じ関数にしたい場合は上を関数化してください。
  // ここでは一番安全に、req.urlだけ差し替えて処理する簡易転送にしています。
  req.url = "/signal/c" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
  return app._router.handle(req, res, () => {});
});

app.get("/last/c", (req, res) => handleLast(req, res, queueC));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
