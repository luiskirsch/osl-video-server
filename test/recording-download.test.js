"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

test("só libera o download quando o objeto existe, tem conteúdo e está no prazo", async t => {
  let status = 404;
  let length = 0;
  const methods = [];
  const server = http.createServer((req, res) => {
    methods.push(req.method);
    res.writeHead(status, { "content-length": length });
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  Object.assign(process.env, {
    S3_ENDPOINT: "http://127.0.0.1:" + server.address().port,
    S3_ACCESS_KEY: "local", S3_SECRET_KEY: "local", S3_BUCKET: "teste",
  });
  const { recordingDownloadUrl } = require("../video/webrtc");
  const key = "recordings/sala/partida.mp4";
  await assert.rejects(recordingDownloadUrl(key), e => e.$metadata.httpStatusCode === 404);
  status = 200;
  assert.equal(await recordingDownloadUrl(key), null);
  length = 128;
  assert.equal(await recordingDownloadUrl(key, 0), null);
  const url = new URL(await recordingDownloadUrl(key, 12));
  assert.equal(url.pathname, "/teste/" + key);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "12");
  assert.deepEqual(methods, ["HEAD", "HEAD", "HEAD"]);
});
