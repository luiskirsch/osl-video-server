async function atualizar() {
  const status = document.getElementById("status");
  const logs = document.getElementById("logs");

  try {
    const healthRes = await fetch("/health?ts=" + Date.now());
    const health = await healthRes.json();

    status.textContent =
      "ONLINE - Porta " + health.port + " - Uptime " + health.uptimeSec + "s";

    const logsRes = await fetch("/logs?ts=" + Date.now());
    const logsJson = await logsRes.json();

    if (Array.isArray(logsJson)) {
      logs.textContent = logsJson.join("\n");
    } else {
      logs.textContent = "Sem logs.";
    }
  } catch (e) {
    status.textContent = "ERRO: " + String(e.message || e);
  }
}

atualizar();
setInterval(atualizar, 2000);
