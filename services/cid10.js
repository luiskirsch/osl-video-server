// Subset relevante do CID-10 BR — foco em transtornos mentais e
// comportamentais (capítulo V, F00-F99) + Z-codes mais usados em
// psicologia/psiquiatria. ~150 entradas.
//
// Fonte: CID-10 da OMS, tradução oficial do Ministério da Saúde
// (domínio público — datasus.saude.gov.br/cid-10).
//
// Estrutura: { code, description, chapter? }
// chapter: "F0" (orgânicos), "F1" (substâncias), "F2" (psicose),
//          "F3" (humor), "F4" (ansiedade), "F5" (comportamental),
//          "F6" (personalidade), "F7" (intelectual), "F8" (desenvolvimento),
//          "F9" (infância), "Z" (fatores).

const CID10_DATASET = [
  // F0 — Transtornos mentais orgânicos
  { code: "F00",   chapter: "F0", description: "Demência na doença de Alzheimer" },
  { code: "F00.0", chapter: "F0", description: "Demência na doença de Alzheimer de início precoce" },
  { code: "F00.1", chapter: "F0", description: "Demência na doença de Alzheimer de início tardio" },
  { code: "F00.2", chapter: "F0", description: "Demência na doença de Alzheimer, forma atípica ou mista" },
  { code: "F01",   chapter: "F0", description: "Demência vascular" },
  { code: "F02",   chapter: "F0", description: "Demência em outras doenças classificadas em outra parte" },
  { code: "F03",   chapter: "F0", description: "Demência não especificada" },
  { code: "F04",   chapter: "F0", description: "Síndrome amnésica orgânica não induzida por álcool ou outras substâncias psicoativas" },
  { code: "F05",   chapter: "F0", description: "Delirium não induzido por álcool ou outras substâncias psicoativas" },
  { code: "F06",   chapter: "F0", description: "Outros transtornos mentais devidos a lesão e disfunção cerebral e a doença física" },
  { code: "F07",   chapter: "F0", description: "Transtornos de personalidade e do comportamento devidos a doença, lesão ou disfunção cerebral" },
  { code: "F09",   chapter: "F0", description: "Transtorno mental orgânico ou sintomático não especificado" },

  // F1 — Substâncias psicoativas
  { code: "F10",   chapter: "F1", description: "Transtornos mentais e comportamentais devidos ao uso de álcool" },
  { code: "F10.1", chapter: "F1", description: "Uso nocivo de álcool" },
  { code: "F10.2", chapter: "F1", description: "Síndrome de dependência de álcool" },
  { code: "F11",   chapter: "F1", description: "Transtornos mentais e comportamentais devidos ao uso de opiáceos" },
  { code: "F12",   chapter: "F1", description: "Transtornos mentais e comportamentais devidos ao uso de canabinoides" },
  { code: "F13",   chapter: "F1", description: "Transtornos mentais e comportamentais devidos ao uso de sedativos e hipnóticos" },
  { code: "F14",   chapter: "F1", description: "Transtornos mentais e comportamentais devidos ao uso de cocaína" },
  { code: "F15",   chapter: "F1", description: "Transtornos mentais e comportamentais devidos ao uso de outros estimulantes (inclui cafeína)" },
  { code: "F16",   chapter: "F1", description: "Transtornos mentais e comportamentais devidos ao uso de alucinógenos" },
  { code: "F17",   chapter: "F1", description: "Transtornos mentais e comportamentais devidos ao uso de fumo (tabaco)" },
  { code: "F18",   chapter: "F1", description: "Transtornos mentais e comportamentais devidos ao uso de solventes voláteis" },
  { code: "F19",   chapter: "F1", description: "Transtornos mentais e comportamentais devidos ao uso de múltiplas drogas e outras substâncias psicoativas" },

  // F2 — Esquizofrenia / psicoses
  { code: "F20",   chapter: "F2", description: "Esquizofrenia" },
  { code: "F20.0", chapter: "F2", description: "Esquizofrenia paranoide" },
  { code: "F20.1", chapter: "F2", description: "Esquizofrenia hebefrênica" },
  { code: "F20.2", chapter: "F2", description: "Esquizofrenia catatônica" },
  { code: "F20.3", chapter: "F2", description: "Esquizofrenia indiferenciada" },
  { code: "F20.5", chapter: "F2", description: "Esquizofrenia residual" },
  { code: "F21",   chapter: "F2", description: "Transtorno esquizotípico" },
  { code: "F22",   chapter: "F2", description: "Transtornos delirantes persistentes" },
  { code: "F23",   chapter: "F2", description: "Transtornos psicóticos agudos e transitórios" },
  { code: "F25",   chapter: "F2", description: "Transtornos esquizoafetivos" },
  { code: "F28",   chapter: "F2", description: "Outros transtornos psicóticos não orgânicos" },
  { code: "F29",   chapter: "F2", description: "Psicose não orgânica não especificada" },

  // F3 — Humor (afetivos)
  { code: "F30",   chapter: "F3", description: "Episódio maníaco" },
  { code: "F30.1", chapter: "F3", description: "Mania sem sintomas psicóticos" },
  { code: "F30.2", chapter: "F3", description: "Mania com sintomas psicóticos" },
  { code: "F31",   chapter: "F3", description: "Transtorno afetivo bipolar" },
  { code: "F31.0", chapter: "F3", description: "Transtorno afetivo bipolar, episódio atual hipomaníaco" },
  { code: "F31.3", chapter: "F3", description: "Transtorno afetivo bipolar, episódio atual depressivo leve ou moderado" },
  { code: "F31.5", chapter: "F3", description: "Transtorno afetivo bipolar, episódio atual depressivo grave com sintomas psicóticos" },
  { code: "F32",   chapter: "F3", description: "Episódios depressivos" },
  { code: "F32.0", chapter: "F3", description: "Episódio depressivo leve" },
  { code: "F32.1", chapter: "F3", description: "Episódio depressivo moderado" },
  { code: "F32.2", chapter: "F3", description: "Episódio depressivo grave sem sintomas psicóticos" },
  { code: "F32.3", chapter: "F3", description: "Episódio depressivo grave com sintomas psicóticos" },
  { code: "F32.9", chapter: "F3", description: "Episódio depressivo não especificado" },
  { code: "F33",   chapter: "F3", description: "Transtorno depressivo recorrente" },
  { code: "F33.0", chapter: "F3", description: "Transtorno depressivo recorrente, episódio atual leve" },
  { code: "F33.1", chapter: "F3", description: "Transtorno depressivo recorrente, episódio atual moderado" },
  { code: "F33.2", chapter: "F3", description: "Transtorno depressivo recorrente, episódio atual grave sem sintomas psicóticos" },
  { code: "F33.4", chapter: "F3", description: "Transtorno depressivo recorrente, atualmente em remissão" },
  { code: "F34",   chapter: "F3", description: "Transtornos persistentes do humor (afetivos)" },
  { code: "F34.0", chapter: "F3", description: "Ciclotimia" },
  { code: "F34.1", chapter: "F3", description: "Distimia" },
  { code: "F38",   chapter: "F3", description: "Outros transtornos do humor (afetivos)" },
  { code: "F39",   chapter: "F3", description: "Transtorno do humor (afetivo) não especificado" },

  // F4 — Ansiedade, estresse, somatoformes
  { code: "F40",   chapter: "F4", description: "Transtornos fóbico-ansiosos" },
  { code: "F40.0", chapter: "F4", description: "Agorafobia" },
  { code: "F40.1", chapter: "F4", description: "Fobias sociais" },
  { code: "F40.2", chapter: "F4", description: "Fobias específicas (isoladas)" },
  { code: "F41",   chapter: "F4", description: "Outros transtornos ansiosos" },
  { code: "F41.0", chapter: "F4", description: "Transtorno de pânico" },
  { code: "F41.1", chapter: "F4", description: "Ansiedade generalizada" },
  { code: "F41.2", chapter: "F4", description: "Transtorno misto ansioso e depressivo" },
  { code: "F42",   chapter: "F4", description: "Transtorno obsessivo-compulsivo (TOC)" },
  { code: "F43",   chapter: "F4", description: "Reações ao 'stress' grave e transtornos de adaptação" },
  { code: "F43.0", chapter: "F4", description: "Reação aguda ao 'stress'" },
  { code: "F43.1", chapter: "F4", description: "Estado de 'stress' pós-traumático (TEPT)" },
  { code: "F43.2", chapter: "F4", description: "Transtornos de adaptação" },
  { code: "F44",   chapter: "F4", description: "Transtornos dissociativos (de conversão)" },
  { code: "F45",   chapter: "F4", description: "Transtornos somatoformes" },
  { code: "F45.0", chapter: "F4", description: "Transtorno de somatização" },
  { code: "F45.2", chapter: "F4", description: "Transtorno hipocondríaco" },
  { code: "F45.3", chapter: "F4", description: "Disfunção autonômica somatoforme" },
  { code: "F45.4", chapter: "F4", description: "Transtorno doloroso somatoforme persistente" },
  { code: "F48",   chapter: "F4", description: "Outros transtornos neuróticos (inclui neurastenia, despersonalização)" },

  // F5 — Síndromes comportamentais associadas a perturbações fisiológicas
  { code: "F50",   chapter: "F5", description: "Transtornos da alimentação" },
  { code: "F50.0", chapter: "F5", description: "Anorexia nervosa" },
  { code: "F50.2", chapter: "F5", description: "Bulimia nervosa" },
  { code: "F50.8", chapter: "F5", description: "Outros transtornos alimentares (inclui compulsão alimentar)" },
  { code: "F51",   chapter: "F5", description: "Transtornos não orgânicos do sono" },
  { code: "F51.0", chapter: "F5", description: "Insônia não orgânica" },
  { code: "F51.1", chapter: "F5", description: "Hipersonia não orgânica" },
  { code: "F51.5", chapter: "F5", description: "Pesadelos" },
  { code: "F52",   chapter: "F5", description: "Disfunção sexual não causada por transtorno orgânico" },
  { code: "F53",   chapter: "F5", description: "Transtornos mentais e comportamentais associados ao puerpério" },
  { code: "F54",   chapter: "F5", description: "Fatores psicológicos e comportamentais associados a doenças classificadas em outra parte" },

  // F6 — Personalidade
  { code: "F60",   chapter: "F6", description: "Transtornos específicos da personalidade" },
  { code: "F60.0", chapter: "F6", description: "Personalidade paranoide" },
  { code: "F60.1", chapter: "F6", description: "Personalidade esquizoide" },
  { code: "F60.2", chapter: "F6", description: "Personalidade dissocial (antissocial)" },
  { code: "F60.3", chapter: "F6", description: "Personalidade emocionalmente instável (inclui borderline)" },
  { code: "F60.4", chapter: "F6", description: "Personalidade histriônica" },
  { code: "F60.5", chapter: "F6", description: "Personalidade anancástica (obsessivo-compulsiva)" },
  { code: "F60.6", chapter: "F6", description: "Personalidade ansiosa (esquiva)" },
  { code: "F60.7", chapter: "F6", description: "Personalidade dependente" },
  { code: "F61",   chapter: "F6", description: "Transtornos mistos da personalidade e outros transtornos da personalidade" },
  { code: "F63",   chapter: "F6", description: "Transtornos de hábitos e impulsos (cleptomania, piromania, jogo patológico)" },
  { code: "F63.0", chapter: "F6", description: "Jogo patológico" },
  { code: "F64",   chapter: "F6", description: "Transtornos de identidade sexual" },
  { code: "F65",   chapter: "F6", description: "Transtornos da preferência sexual (parafilias)" },
  { code: "F68",   chapter: "F6", description: "Outros transtornos da personalidade e comportamento do adulto" },

  // F7 — Intelectual (retardo mental)
  { code: "F70",   chapter: "F7", description: "Retardo mental leve" },
  { code: "F71",   chapter: "F7", description: "Retardo mental moderado" },
  { code: "F72",   chapter: "F7", description: "Retardo mental grave" },
  { code: "F73",   chapter: "F7", description: "Retardo mental profundo" },
  { code: "F79",   chapter: "F7", description: "Retardo mental não especificado" },

  // F8 — Desenvolvimento
  { code: "F80",   chapter: "F8", description: "Transtornos específicos do desenvolvimento da fala e da linguagem" },
  { code: "F81",   chapter: "F8", description: "Transtornos específicos do desenvolvimento das habilidades escolares" },
  { code: "F82",   chapter: "F8", description: "Transtorno específico do desenvolvimento motor" },
  { code: "F83",   chapter: "F8", description: "Transtornos específicos misto do desenvolvimento" },
  { code: "F84",   chapter: "F8", description: "Transtornos globais do desenvolvimento (inclui autismo)" },
  { code: "F84.0", chapter: "F8", description: "Autismo infantil" },
  { code: "F84.5", chapter: "F8", description: "Síndrome de Asperger" },

  // F9 — Infância e adolescência
  { code: "F90",   chapter: "F9", description: "Transtornos hipercinéticos (TDAH)" },
  { code: "F90.0", chapter: "F9", description: "Distúrbios da atividade e da atenção (TDAH desatento)" },
  { code: "F90.1", chapter: "F9", description: "Transtorno hipercinético de conduta" },
  { code: "F91",   chapter: "F9", description: "Transtornos de conduta" },
  { code: "F92",   chapter: "F9", description: "Transtornos mistos de conduta e das emoções" },
  { code: "F93",   chapter: "F9", description: "Transtornos emocionais com início específico na infância" },
  { code: "F93.0", chapter: "F9", description: "Transtorno de ansiedade de separação na infância" },
  { code: "F94",   chapter: "F9", description: "Transtornos do funcionamento social com início específico na infância" },
  { code: "F95",   chapter: "F9", description: "Tiques (inclui síndrome de Tourette)" },
  { code: "F95.2", chapter: "F9", description: "Síndrome de Tourette" },
  { code: "F98",   chapter: "F9", description: "Outros transtornos comportamentais e emocionais com início na infância" },
  { code: "F98.0", chapter: "F9", description: "Enurese de origem não orgânica" },
  { code: "F98.5", chapter: "F9", description: "Gagueira (tartamudez)" },

  // F99
  { code: "F99",   chapter: "F9", description: "Transtorno mental não especificado em outra parte" },

  // Z-codes — fatores influenciam estado de saúde / motivo de consulta
  { code: "Z63",   chapter: "Z",  description: "Outras dificuldades relacionadas com o grupo primário de apoio, inclusive a família" },
  { code: "Z63.0", chapter: "Z",  description: "Problemas no relacionamento entre cônjuges ou parceiros" },
  { code: "Z63.4", chapter: "Z",  description: "Desaparecimento ou morte de membro da família (luto)" },
  { code: "Z63.5", chapter: "Z",  description: "Dissolução da família por separação ou divórcio" },
  { code: "Z65",   chapter: "Z",  description: "Outras dificuldades em circunstâncias psicossociais" },
  { code: "Z70",   chapter: "Z",  description: "Aconselhamento relativo a atitude, comportamento e orientação em matéria de sexualidade" },
  { code: "Z73",   chapter: "Z",  description: "Problemas relacionados com a organização de seu modo de vida (inclui burnout)" },
  { code: "Z73.0", chapter: "Z",  description: "Esgotamento (burnout)" },
  { code: "Z73.2", chapter: "Z",  description: "Falta de relaxamento e de lazer" }
];

// Normaliza string pra busca (sem acentos, lower).
function normalize(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Busca por código (prefix match) OU descrição (substring).
// q ≥ 2 chars. Retorna até `limit` resultados ordenados (match exato/prefix
// de código vem primeiro, depois match de descrição).
function search(query, limit = 20) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  const qn = normalize(q);
  const qUpper = q.toUpperCase();
  const codeMatches = [];
  const descMatches = [];
  for (const item of CID10_DATASET) {
    if (item.code.toUpperCase().startsWith(qUpper)) {
      codeMatches.push(item);
    } else if (normalize(item.description).includes(qn)) {
      descMatches.push(item);
    }
    if (codeMatches.length + descMatches.length >= limit * 3) break; // safety
  }
  return [...codeMatches, ...descMatches].slice(0, limit);
}

function getByCode(code) {
  const c = String(code || "").toUpperCase().trim();
  return CID10_DATASET.find(x => x.code === c) || null;
}

module.exports = {
  CID10_DATASET,
  search,
  getByCode
};
