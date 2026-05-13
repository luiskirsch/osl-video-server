// Escalas clínicas — PHQ-9 (depressão) e GAD-7 (ansiedade). Schemas
// validados em pt-BR (versão Munhoz et al. 2013 / Spitzer 2006).
//
// Paciente preenche periodicamente (e.g. mensal) via link público. Score
// é calculado server-side ao receber respostas. Gráfico de evolução é
// montado client-side a partir de GET /therapy/escalas?patientId=.

const SCALE_OPTIONS = [
  { value: 0, label: "Nenhuma vez" },
  { value: 1, label: "Vários dias" },
  { value: 2, label: "Mais da metade dos dias" },
  { value: 3, label: "Quase todos os dias" }
];

const SCALE_PHQ9 = {
  id: "phq9",
  name: "PHQ-9 — Depressão",
  description: "Escala de rastreio de depressão. 9 perguntas sobre as últimas 2 semanas.",
  intro: "Nas últimas 2 semanas, com que frequência você foi incomodado por algum dos seguintes problemas?",
  options: SCALE_OPTIONS,
  questions: [
    { id: "q1", label: "Pouco interesse ou pouco prazer em fazer as coisas" },
    { id: "q2", label: "Se sentir para baixo, deprimido ou sem perspectiva" },
    { id: "q3", label: "Dificuldade para pegar no sono, permanecer dormindo, ou dormir mais do que de costume" },
    { id: "q4", label: "Se sentir cansado ou com pouca energia" },
    { id: "q5", label: "Falta de apetite ou comendo demais" },
    { id: "q6", label: "Se sentir mal consigo mesmo — ou achar que você é um fracasso ou que decepcionou sua família ou você mesmo" },
    { id: "q7", label: "Dificuldade para se concentrar nas coisas (ler o jornal, ver televisão, conversar)" },
    { id: "q8", label: "Se mover ou falar tão lentamente que outras pessoas notaram, OU o oposto: tão agitado/inquieto que ficou se movendo muito mais que de costume" },
    { id: "q9", label: "Pensar em se ferir de alguma maneira ou que seria melhor estar morto", flag: "suicide" }
  ],
  scoring: {
    bands: [
      { min: 0,  max: 4,  label: "Mínima", note: "Sintomas mínimos ou ausentes." },
      { min: 5,  max: 9,  label: "Leve", note: "Sintomas depressivos leves." },
      { min: 10, max: 14, label: "Moderada", note: "Depressão moderada — considerar abordagem clínica." },
      { min: 15, max: 19, label: "Moderadamente grave", note: "Depressão moderadamente grave — tratamento ativo indicado." },
      { min: 20, max: 27, label: "Grave", note: "Depressão grave — avaliação e tratamento imediatos." }
    ]
  }
};

const SCALE_GAD7 = {
  id: "gad7",
  name: "GAD-7 — Ansiedade",
  description: "Escala de rastreio de transtorno de ansiedade generalizada. 7 perguntas.",
  intro: "Nas últimas 2 semanas, com que frequência você foi incomodado pelos seguintes problemas?",
  options: SCALE_OPTIONS,
  questions: [
    { id: "q1", label: "Sentir-se nervoso, ansioso ou muito tenso" },
    { id: "q2", label: "Não conseguir parar ou controlar as preocupações" },
    { id: "q3", label: "Preocupar-se muito com diversas coisas" },
    { id: "q4", label: "Dificuldade para relaxar" },
    { id: "q5", label: "Inquietação ou impaciência tal que fica difícil ficar parado" },
    { id: "q6", label: "Ficar facilmente aborrecido ou irritável" },
    { id: "q7", label: "Sentir medo como se algo terrível fosse acontecer" }
  ],
  scoring: {
    bands: [
      { min: 0,  max: 4,  label: "Mínima", note: "Sintomas mínimos ou ausentes." },
      { min: 5,  max: 9,  label: "Leve", note: "Ansiedade leve." },
      { min: 10, max: 14, label: "Moderada", note: "Ansiedade moderada — avaliação adicional indicada." },
      { min: 15, max: 21, label: "Grave", note: "Ansiedade grave — tratamento ativo indicado." }
    ]
  }
};

const SCALES_BY_ID = {
  phq9: SCALE_PHQ9,
  gad7: SCALE_GAD7
};

function getScale(scaleType) {
  return SCALES_BY_ID[scaleType] || null;
}

function listScales() {
  return [
    { id: "phq9", name: SCALE_PHQ9.name, description: SCALE_PHQ9.description, questionCount: SCALE_PHQ9.questions.length },
    { id: "gad7", name: SCALE_GAD7.name, description: SCALE_GAD7.description, questionCount: SCALE_GAD7.questions.length }
  ];
}

// Valida respostas + computa score + band. responses esperado:
// { q1: 0|1|2|3, q2: ..., ... }
function validateAndScore(responses, scale) {
  if (!scale) return { ok: false, errors: ["ESCALA_INVALIDA"] };
  const r = responses && typeof responses === "object" ? responses : {};
  const clean = {};
  const errors = [];
  let total = 0;
  let suicideFlag = false;

  for (const q of scale.questions) {
    const raw = r[q.id];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 3) {
      errors.push(`${q.id}: resposta inválida (0-3 obrigatório)`);
      continue;
    }
    clean[q.id] = n;
    total += n;
    if (q.flag === "suicide" && n > 0) suicideFlag = true;
  }

  if (errors.length) return { ok: false, errors, clean };

  const band = scale.scoring.bands.find(b => total >= b.min && total <= b.max) || null;
  return {
    ok: true,
    clean,
    score: total,
    band: band ? { label: band.label, note: band.note, min: band.min, max: band.max } : null,
    suicideFlag
  };
}

module.exports = {
  getScale,
  listScales,
  validateAndScore
};
