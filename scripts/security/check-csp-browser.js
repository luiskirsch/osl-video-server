"use strict";
const assert = require("node:assert/strict");
module.exports = async function checkCspBrowser({ port, origin = "https://espacopreludio.com.br", prefix = "/staging" }) {
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
  assert.ok(["https://espacopreludio.com.br", "https://www.espacopreludio.com.br"].includes(origin));
  assert.ok(["", "/staging"].includes(prefix));
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const tab = tabs.find(item => item.type === "page" && item.url === "about:blank");
  assert.ok(tab, "ISOLATED_BLANK_BROWSER_REQUIRED");
  const endpoint = new URL(tab.webSocketDebuggerUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(endpoint.hostname));
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0, documentPolicy, fulfillDocument, interceptionError;
  const pending = new Map();
  socket.addEventListener("message", async event => {
    const result = JSON.parse(event.data);
    if (result.method === "Fetch.requestPaused" && fulfillDocument) {
      try { await fulfillDocument(result.params.requestId); } catch { interceptionError = true; }
      return;
    }
    if (result.method === "Network.responseReceived" && result.params.type === "Document") {
      const headers = result.params.response.headers;
      documentPolicy = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-security-policy")?.[1];
    }
    if (pending.has(result.id)) { const resolve = pending.get(result.id); pending.delete(result.id); resolve(result); }
  });
  async function send(method, params = {}) {
    const requestId = ++id;
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error("CSP_BROWSER_TIMEOUT")); }, 25000);
      pending.set(requestId, value => { clearTimeout(timeout); resolve(value); });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    if (result.error) throw new Error("CSP_BROWSER_PROTOCOL_FAILED");
    return result.result;
  }
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error("CSP_BROWSER_EVALUATION_FAILED");
    return result.result?.value;
  }
  async function waitFor(expression) {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try { if (await evaluate(expression)) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error("CSP_PAGE_NOT_READY");
  }
  try {
    await send("Page.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__cspViolations.push(e.effectiveDirective));" });
    const source = await fetch(origin + prefix + "/login.html", { cache: "no-store" });
    const original = await source.text();
    const injected = original.replace("</body>", '<script>window.__cspInjectedScript=true</script><button id="cspInjectedButton" style="position:fixed;top:8px;left:8px;z-index:2147483647;width:120px;height:35px" onclick="window.__cspInjectedHandler=true">CSP TEST</button></body>');
    const responseHeaders = [...source.headers.entries()].filter(([name]) => !["content-encoding", "content-length", "transfer-encoding"].includes(name.toLowerCase())).map(([name, value]) => ({ name, value }));
    fulfillDocument = requestId => send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders, body: Buffer.from(injected).toString("base64") });
    // Insert the benign attack into the browser response after the edge has
    // nonced trusted markup. DevTools evaluation itself bypasses some CSP checks;
    // parser-created scripts and real input events are the meaningful boundary.
    await send("Fetch.enable", { patterns: [{ urlPattern: origin + prefix + "/login.html", requestStage: "Request" }] });
    await send("Page.navigate", { url: origin + prefix + "/login.html" });
    await waitFor('document.readyState === "complete" && !!document.getElementById("loginForm") && !!window.EP_BACKEND_BASE_URL');
    await send("Fetch.disable"); assert.ok(!interceptionError, "DOCUMENT_INTERCEPTION_FAILED");
    assert.ok(documentPolicy, "MISSING_CSP");
    assert.match(documentPolicy, /'strict-dynamic'/); assert.match(documentPolicy, /script-src-attr 'none'/);
    assert.doesNotMatch(documentPolicy, /script-src[^;]*'unsafe-inline'/);
    const nonce = /'nonce-([^']+)'/.exec(documentPolicy)?.[1]; assert.ok(nonce, "MISSING_NONCE");
    assert.ok(await evaluate(`Array.from(document.scripts).some(s=>s.nonce===${JSON.stringify(nonce)})`));
    const refreshed = await evaluate('(async()=>{const r=await fetch(location.href,{cache:"no-store"});return r.headers.get("Content-Security-Policy");})()');
    assert.notEqual(/'nonce-([^']+)'/.exec(refreshed)?.[1], nonce, "NONCE_REUSED");
    const point = await evaluate('(()=>{const r=document.getElementById("cspInjectedButton").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    await new Promise(resolve => setTimeout(resolve, 300));
    const blocked = await evaluate('({script:!!window.__cspInjectedScript,handler:!!window.__cspInjectedHandler,violations:window.__cspViolations})');
    assert.equal(blocked.script, false, "INJECTED_SCRIPT_EXECUTED"); assert.equal(blocked.handler, false, "INJECTED_HANDLER_EXECUTED");
    assert.ok(blocked.violations.includes("script-src-elem")); assert.ok(blocked.violations.includes("script-src-attr"));
    await send("Page.navigate", { url: origin + prefix + "/recibo-publico.html" });
    await waitFor('document.readyState === "complete" && !!document.querySelector("[data-csp-action=print]")');
    await evaluate('window.print=()=>{window.__cspPrintWorked=true};document.querySelector("[data-csp-action=print]").click();true');
    assert.equal(await evaluate('!!window.__cspPrintWorked'), true, "TRUSTED_PRINT_ACTION_FAILED");
    return { strictCsp: true, freshNonce: true, legitimateLoginScriptsLoaded: true, injectedScriptBlocked: true,
      injectedHandlerBlocked: true, trustedPrintActionWorks: true, origin, prefix };
  } finally { socket.close(); }
};
if (require.main === module) (async () => {
  let data = ""; for await (const chunk of process.stdin) data += chunk;
  const report = await module.exports(JSON.parse(data));
  if (process.argv[2]) require("node:fs").writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error instanceof assert.AssertionError
  ? "CSP_ASSERTION: " + error.message.split("\n")[0].slice(0, 200)
  : /^[A-Z_]+$/.test(error.message) ? error.message : "CSP_BROWSER_CHECK_FAILED"); process.exitCode = 1; });
