"use strict";
// Optional UI acceptance check using a fresh, loopback-only browser profile.
// Pass only credentials of the synthetic staging account created by the caller.
const assert = require("node:assert/strict");

module.exports = async function checkStagingMfaBrowser({ port, customToken, code }) {
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, "INVALID_BROWSER_PORT");
  const root = `http://127.0.0.1:${port}`;
  const tabs = await (await fetch(root + "/json/list")).json();
  const tab = tabs.find(item => item.type === "page" && item.url === "about:blank");
  assert.ok(tab, "ISOLATED_BLANK_BROWSER_REQUIRED");
  const url = new URL(tab.webSocketDebuggerUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "LOOPBACK_BROWSER_REQUIRED");
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map(); let id = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const callback = pending.get(message.id); pending.delete(message.id);
      if (message.error) callback.reject(new Error("BROWSER_PROTOCOL_FAILED")); else callback.resolve(message.result);
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error("BROWSER_TIMEOUT")); }, 25_000);
      pending.set(requestId, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, "BROWSER_EVALUATION_FAILED");
    return result.result?.value;
  }
  async function until(expression, name) {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try { if (await evaluate(expression)) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(name);
  }
  try {
    await send("Page.enable");
    await send("Network.enable");
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Page.navigate", { url: "https://espacopreludio.com.br/staging/rt-login.html" });
    await until('location.pathname === "/staging/rt-login.html" && document.readyState === "complete"', "RT_LOGIN_NOT_READY");
    // No clinical contents, tokens or screenshots are returned to the caller.
    await evaluate(`(async () => {
      const { auth } = await import("./js/firebase-config.js");
      const { signInWithCustomToken } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js");
      await signInWithCustomToken(auth, ${JSON.stringify(customToken)});
      return true;
    })()`);
    await until('location.pathname === "/staging/2fa-verify.html" && !!document.getElementById("codeInput")', "MFA_CHALLENGE_NOT_REACHED");
    await evaluate(`(() => { const input = document.getElementById("codeInput"); input.value = ${JSON.stringify(code)}; input.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("verifyBtn").click(); return true; })()`);
    await until('location.pathname === "/staging/rt-painel.html" && document.querySelector("#rtApp")?.hidden === false', "MFA_RETURN_DID_NOT_LOAD_RT");
    return { name: "isolated browser: RT second-factor challenge, verify and return", passed: true };
  } finally { socket.close(); }
};
