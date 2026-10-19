"use strict";
// Modelo de cobertura de autorização anônima.
//
// Em vez de listar à mão cada rota protegida (elas mudam toda semana), o probe
// DESCOBRE as rotas a partir do próprio app (DUMP_ROUTES em server.js): toda
// rota GET sob um prefixo clínico DEVE negar o chamador anônimo (401/403),
// exceto as explicitamente listadas aqui como públicas.
//
// Assim, rota nova protegida já entra na ronda sozinha; rota nova pública
// precisa ser classificada aqui de propósito — senão o probe acusa. É esse o
// "vigia de portas novas".

// Prefixos cujas rotas GET devolvem, em geral, dado de paciente/profissional/
// clínica/admin. Fora destes, o probe não opina.
const CLINICAL_PREFIX = /^\/(therapy|rt|institution|empresa|public)(\/|$)/;

// Rotas GET sob os prefixos acima que são acessíveis SEM login de propósito:
// páginas públicas (diretório, health, geo) ou protegidas por um token/slug
// secreto no próprio link (documentos, agendamento, agenda .ics, pré-entrada).
// Conferidas uma a uma em 2026-10-19: nenhuma devolve dado de terceiro sem o
// token correspondente. Acrescente aqui uma rota só após confirmar que é
// mesmo pública por desenho.
const PUBLIC = [
  // Públicas (respondem 2xx sem login)
  "/public/profissionais",
  "/therapy/geo",
  "/therapy/health",
  // Diretório/verificação por slug ou token no link
  "/public/profissionais/:uid",
  "/public/empresa/:slug",
  "/public/empresa/verificar",
  "/public/aluno-consentimento/:token",
  "/public/aluno-privacidade/:token",
  "/public/programa-escolar/:slug",
  "/therapy/profissional/publico/:uid",
  "/therapy/comparecimento/verificar/:code",
  // Agendamento público (link do profissional)
  "/public/agendar/:slug",
  "/public/agendar/:slug/slots",
  "/public/agendar/:slug/disponibilidade",
  "/public/agendar/:requestId/status-pagamento",
  // Documentos/visualizações protegidos por token assinado no link
  "/therapy/anamnese/publica",
  "/therapy/escala/publica",
  "/therapy/documento/publica",
  "/therapy/receita/publica",
  "/therapy/recibo/publico",
  // Assinatura de agenda, pré-entrada e callback — token/segredo no link
  "/therapy/agenda/feed.ics",
  "/therapy/sessao/pre-join",
  "/therapy/mp/oauth/callback",
];

// Controle positivo: pública de propósito e responde 2xx. Se ela também fosse
// barrada, o probe estaria cego.
const PUBLIC_OK = [{ path: "/health", label: "health" }];

const isClinicalGet = route => route.method === "GET" && CLINICAL_PREFIX.test(route.path);
const publicSet = new Set(PUBLIC);

module.exports = { CLINICAL_PREFIX, PUBLIC, PUBLIC_OK, isClinicalGet, publicSet };
