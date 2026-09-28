const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../services/ambient-weather");

function buildData() {
  const city = _test.newTable();
  const asn = _test.newTable();
  [
    '170.244.224.0,170.244.224.255,SA,BR,"Santa Catarina","Passo de Torres",-29.3211,-49.7243',
    '177.10.0.0,177.10.255.255,SA,BR,"São Paulo","São Paulo",-23.5475,-46.6361',
    '2804:38ec::,2804:38ec:ffff:ffff:ffff:ffff:ffff:ffff,SA,BR,"Santa Catarina","Passo de Torres",-29.3384,-49.7282',
    '8.8.8.0,8.8.8.255,NA,US,California,"Mountain View",37.4056,-122.078',
    '189.0.0.0,189.0.0.255,SA,BR,,,0,0'
  ].forEach(line => _test.parseCityLine(line, city));
  [
    '177.10.0.0,177.10.255.255,26615,"TIM S/A"',
    '170.244.224.0,170.244.224.255,264000,"Provedor Regional"'
  ].forEach(line => _test.parseAsnLine(line, asn));
  return { city: _test.freeze(city, Float32Array, Float32Array), asn: _test.freeze(asn, Int32Array, Int32Array) };
}

test("mantém só faixas do Brasil com coordenada válida", () => {
  const data = buildData();
  assert.equal(data.city.v4.starts.length, 2);
  assert.equal(data.city.v6.starts.length, 1);
  assert.equal(data.asn.v4.starts.length, 1, "só ASNs de operadora móvel ficam em memória");
});

test("localiza IPv4, IPv4 mapeado e IPv6", () => {
  const data = buildData();
  const v4 = _test.lookup("170.244.224.97", data);
  assert.ok(Math.abs(v4.lat - -29.3211) < 1e-3 && Math.abs(v4.lon - -49.7243) < 1e-3);
  assert.equal(v4.asn, null);
  assert.deepEqual(_test.lookup("::ffff:170.244.224.97", data), v4);
  const v6 = _test.lookup("2804:38ec:19f:b200:a902:7b3c:8c25:d892", data);
  assert.ok(Math.abs(v6.lat - -29.3384) < 1e-3);
  assert.equal(_test.lookup("177.10.5.5", data).asn, 26615);
  assert.equal(_test.lookup("8.8.8.8", data), null, "fora do Brasil não localiza");
  assert.equal(_test.lookup("189.0.0.10", data), null, "sem coordenada não localiza");
  assert.equal(_test.lookup("não-é-ip", data), null);
});

test("expande IPv6 abreviado e com IPv4 embutido", () => {
  assert.equal(_test.ipv6High64("2804:38ec::1"), 0x280438ec00000000n);
  assert.equal(_test.ipv6High64("::"), 0n);
  assert.equal(_test.ipv6High64("64:ff9b::1.2.3.4"), 0x0064ff9b00000000n);
  assert.equal(_test.ipv6High64("1:2:3:4:5:6:7:8:9"), null);
});

test("não arrisca clima em rede móvel", () => {
  const reliable = _test.isLocationReliable;
  assert.equal(reliable({ asn: null, connection: "", mobileDevice: false }), true, "PC em banda larga");
  assert.equal(reliable({ asn: 28573, connection: "", mobileDevice: false }), true, "PC na NET");
  assert.equal(reliable({ asn: 28573, connection: "", mobileDevice: true }), false, "celular na Claro sem saber a conexão");
  assert.equal(reliable({ asn: 28573, connection: "wifi", mobileDevice: true }), true, "celular no Wi-Fi da NET");
  assert.equal(reliable({ asn: 26615, connection: "", mobileDevice: false }), false, "TIM é só móvel");
  assert.equal(reliable({ asn: null, connection: "cellular", mobileDevice: true }), false, "Android em dados móveis");
});

test("traduz símbolos do MET Norway", () => {
  const c = _test.classifySymbol;
  assert.equal(c("clearsky_night"), "clear");
  assert.equal(c("fair_day"), "clear");
  assert.equal(c("partlycloudy_day"), "partly");
  assert.equal(c("cloudy"), "cloudy");
  assert.equal(c("fog"), "fog");
  assert.equal(c("heavyrain"), "rain");
  assert.equal(c("lightsleetshowers_day"), "rain");
  assert.equal(c("rainandthunder"), "storm");
  assert.equal(c("heavysnowshowersandthunder_night"), "storm");
  assert.equal(c("lightsnow"), "snow");
  assert.equal(c(undefined), null);
});

test("tenta o mês atual e o anterior da base DB-IP", () => {
  assert.deepEqual(_test.candidateMonths(new Date(Date.UTC(2026, 0, 1))), ["2026-01", "2025-12"]);
  assert.deepEqual(_test.candidateMonths(new Date(Date.UTC(2026, 8, 28))), ["2026-09", "2026-08"]);
});
