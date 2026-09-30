"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { askBot, _test } = require("../services/support-bot");

// Cliente falso: devolve as respostas em sequência e guarda cada request.
function fakeClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        async create(params) {
          requests.push(JSON.parse(JSON.stringify(params)));
          const next = responses[requests.length - 1];
          if (next instanceof Error) throw next;
          return { usage: { input_tokens: 100, output_tokens: 20 }, ...next };
        }
      }
    }
  };
}

const agendaTool = {
  definitions: [{ name: "ver_agenda" }],
  calls: [],
  async run(name, input) { this.calls.push({ name, input }); return { isError: false, content: '{"total":1}' }; }
};

test("consulta a ferramenta, devolve o resultado e responde com o texto final", async () => {
  const client = fakeClient([
    { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "" }, { type: "tool_use", id: "tu_1", name: "ver_agenda", input: { dias_futuros: 1, dias_passados: 0 } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Amanhã você atende a Maria S. às 15:00." }] }
  ]);
  agendaTool.calls = [];
  const result = await askBot({ userMessage: "quem atendo amanhã?", tools: agendaTool, client, page: "/agenda.html", now: Date.UTC(2026, 8, 30, 16) });

  assert.equal(result.ok, true);
  assert.equal(result.reply, "Amanhã você atende a Maria S. às 15:00.");
  assert.deepEqual(result.toolsUsed, ["ver_agenda"]);
  assert.deepEqual(agendaTool.calls, [{ name: "ver_agenda", input: { dias_futuros: 1, dias_passados: 0 } }]);

  const [first, second] = client.requests;
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.fallbacks, "default");
  assert.deepEqual(first.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(first.output_config.effort, "low");
  assert.equal(first.system[0].cache_control.type, "ephemeral");
  assert.match(first.system[1].text, /tela: Agenda/);
  assert.equal(second.messages[1].role, "assistant");
  assert.equal(second.messages[1].content[0].type, "thinking", "raciocínio volta intacto no ciclo");
  assert.deepEqual(second.messages[2].content, [{ type: "tool_result", tool_use_id: "tu_1", content: '{"total":1}' }]);
});

test("recusa do modelo vira resposta amigável", async () => {
  const client = fakeClient([{ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }]);
  const result = await askBot({ userMessage: "x", client });
  assert.equal(result.ok, true);
  assert.match(result.reply, /Não consigo ajudar/);
});

test("para depois do limite de rodadas de ferramenta", async () => {
  const loop = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "ver_agenda", input: {} }] };
  const client = fakeClient(Array(10).fill(loop));
  const result = await askBot({ userMessage: "x", tools: agendaTool, client });
  assert.equal(result.ok, false);
  assert.equal(result.error, "LIMITE_FERRAMENTAS");
  assert.equal(client.requests.length, 5);
});

test("erro da API não vaza detalhes", async () => {
  const result = await askBot({ userMessage: "x", client: fakeClient([new Error("boom")]) });
  assert.deepEqual(result, { ok: false, error: "ANTHROPIC_FALHOU" });
});

test("após fallback no meio da resposta, descarta raciocínio e tool_use anteriores à troca", () => {
  const content = [
    { type: "thinking", thinking: "" },
    { type: "tool_use", id: "velho" },
    { type: "text", text: "parcial" },
    { type: "fallback", from: { model: "a" }, to: { model: "b" } },
    { type: "tool_use", id: "novo" }
  ];
  assert.deepEqual(_test.echoableContent(content).map(b => b.id || b.type), ["text", "fallback", "novo"]);
});

test("tela desconhecida ou fora do padrão não entra no contexto", () => {
  assert.equal(_test.pageLabel("/staging/agenda.html"), "Agenda");
  assert.equal(_test.pageLabel("/qualquer.html"), null);
  const context = _test.buildContext({ userName: "Luis Henrique", isFirstMessage: true, page: "/perfil.html", now: Date.UTC(2026, 8, 30, 16) });
  assert.match(context, /Oi, Luis!/);
  assert.match(context, /tela: Perfil/);
  assert.match(context, /13:00/);
});

test("histórico que começa pela assistente é aparado", async () => {
  const client = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }]);
  await askBot({ userMessage: "oi", history: [{ role: "assistant", content: "boas-vindas" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }], client });
  assert.equal(client.requests[0].messages[0].role, "user");
});
