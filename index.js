import express from "express";

const app = express();
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY || "CHANGE_ME";
let lastSignal = null;

// health check
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "ok" });
});

// receive signal
app.post("/signal", (req, res) => {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    return res.status(403).json({ error: "invalid key" });
  }

  const { cmd, symbol, id } = req.body;
  if (!cmd || !symbol || !id) {
    return res.status(400).json({ error: "missing fields" });
  }

  lastSignal = { cmd, symbol, id };
  res.json({ ok: true });
});

// fetch last signal
app.get("/last", (req, res) => {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    return res.status(403).json({ error: "invalid key" });
  }

  if (!lastSignal) {
    return res.json({ signal: null });
  }

  const s = lastSignal;
  lastSignal = null;
  res.json(s);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
