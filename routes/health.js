const express = require("express");
const fs      = require("fs");
const { APP_START_TIME, LOG_FILE } = require("../logger");
const { PORT } = require("../config");
const { getDb } = require("../services/firestore");

const router = express.Router();

router.get("/", (req, res) => {
  return res.status(200).json({
    ok: true,
    service: "osl-video-server",
    message: "Servidor do O SextoLugar está online.",
    port: PORT
  });
});

router.get("/health", (req, res) => {
  return res.status(200).json({
    ok: true,
    service: "osl-video-server",
    uptimeSec: Math.round(process.uptime()),
    startedAt: new Date(APP_START_TIME).toISOString(),
    now: new Date().toISOString(),
    firebaseConfigured: !!getDb(),
    environment: process.env.NODE_ENV || "development"
  });
});

router.get("/panel", (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>OSL Server</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { margin:0; background:#050507; color:#e6c07b; font-family:monospace; display:flex; flex-direction:column; height:100vh; }
      .header { padding:20px; border-bottom:1px solid rgba(255,255,255,0.1); font-size:18px; letter-spacing:1px; }
      .status { padding:16px 20px; color:#82d996; border-bottom:1px solid rgba(255,255,255,0.06); }
      .logs   { flex:1; overflow-y:auto; padding:20px; font-size:12px; color:#ccc; white-space:pre-wrap; word-break:break-word; }
      .log    { margin-bottom:6px; padding:6px 8px; border-left:2px solid rgba(230,192,123,0.35); background:rgba(255,255,255,0.02); }
      .ok  { color:#82d996; }
      .bad { color:#ff6b6b; }
    </style>
  </head>
  <body>
    <div class="header">OSL VIDEO SERVER</div>
    <div class="status" id="status">Conectando...</div>
    <div class="logs"   id="logs"></div>
    <script>
      const statusEl = document.getElementById("status");
      const logsEl   = document.getElementById("logs");

      function addLogLine(text) {
        if (!text || !String(text).trim()) return;
        const div = document.createElement("div");
        div.className = "log";
        div.textContent = text;
        logsEl.appendChild(div);
        while (logsEl.children.length > 300) logsEl.removeChild(logsEl.firstChild);
        logsEl.scrollTop = logsEl.scrollHeight;
      }

      async function updateStatus() {
        try {
          const res  = await fetch("/health");
          const data = await res.json();
          statusEl.innerHTML = '<span class="ok">🟢 ONLINE</span> - Porta ${PORT} - Uptime ' + data.uptimeSec + 's';
        } catch (e) {
          statusEl.innerHTML = '<span class="bad">🔴 OFFLINE</span>';
        }
      }

      const source      = new EventSource("/logs/stream");
      const panelSource = new EventSource("/panel/stream");

      panelSource.addEventListener("rooms", (event) => {
        console.log("Atualização do painel:", JSON.parse(event.data));
      });

      source.addEventListener("bootstrap", (event) => {
        try { const lines = JSON.parse(event.data); logsEl.innerHTML = ""; lines.forEach(addLogLine); } catch (e) {}
      });

      source.addEventListener("log", (event) => {
        addLogLine(event.data);
      });

      setInterval(updateStatus, 5000);
      updateStatus();
    </script>
  </body>
  </html>
  `);
});

router.get("/logs", (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json([]);
    const data  = fs.readFileSync(LOG_FILE, "utf-8");
    const lines = data.split("\n").filter(Boolean);
    return res.json(lines);
  } catch {
    return res.json([]);
  }
});

router.get("/logs/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const sendEvent   = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
  const sendLogLine = (line) => { if (!line || !String(line).trim()) return; sendEvent("log", String(line).replace(/\n/g, " ")); };

  let lastSize = 0;

  try {
    if (fs.existsSync(LOG_FILE)) {
      const initialLines = fs.readFileSync(LOG_FILE, "utf-8").split("\n").filter(Boolean).slice(-100);
      sendEvent("bootstrap", JSON.stringify(initialLines));
      lastSize = fs.statSync(LOG_FILE).size;
    } else {
      sendEvent("bootstrap", JSON.stringify([]));
    }
  } catch {
    sendEvent("bootstrap", JSON.stringify([]));
  }

  const watcher = (curr) => {
    try {
      if (!fs.existsSync(LOG_FILE)) return;
      if (curr.size < lastSize) lastSize = 0;
      if (curr.size > lastSize) {
        const stream = fs.createReadStream(LOG_FILE, { encoding: "utf-8", start: lastSize, end: curr.size });
        let chunk = "";
        stream.on("data", (data) => { chunk += data; });
        stream.on("end",  ()     => { chunk.split("\n").filter(Boolean).forEach(sendLogLine); lastSize = curr.size; });
        stream.on("error", () => {});
      }
    } catch {}
  };

  if (!fs.existsSync(LOG_FILE)) {
    try { fs.writeFileSync(LOG_FILE, ""); } catch (_) {}
  }

  fs.watchFile(LOG_FILE, { interval: 1000 }, watcher);

  const heartbeat = setInterval(() => { res.write(": ping\n\n"); }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    fs.unwatchFile(LOG_FILE, watcher);
    res.end();
  });
});

module.exports = router;
