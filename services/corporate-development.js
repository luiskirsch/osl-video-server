"use strict";

// Conteúdo educativo do portal corporativo. O catálogo fica no servidor para
// que conclusão, carga horária e respostas corretas não sejam controladas pelo
// navegador. Não há conteúdo clínico ou diagnóstico nesta jornada.
const TRACKS = [
  {
    id: "bem_estar_sustentavel",
    title: "Bem-estar sustentável",
    eyebrow: "Trilha essencial",
    description: "Recursos práticos para reconhecer sobrecarga, recuperar energia e pedir apoio no momento certo.",
    color: "teal",
    courses: [
      {
        id: "saude_mental_no_trabalho",
        title: "Saúde mental no trabalho",
        description: "Reconheça sinais, fatores do trabalho e caminhos seguros de cuidado.",
        modules: [
          {
            id: "sinais_de_sobrecarga",
            title: "Sinais de sobrecarga",
            durationMinutes: 8,
            objective: "Perceber mudanças persistentes sem transformar desconforto em autodiagnóstico.",
            sections: [
              ["Observe padrões", "Cansaço que não melhora, irritabilidade, dificuldade de concentração, sono alterado e sensação de incapacidade podem indicar que algo precisa de atenção."],
              ["Olhe para o trabalho", "Volume, ritmo, jornadas, clareza das tarefas, autonomia, suporte e conflitos são condições relevantes. O foco preventivo deve estar também na organização do trabalho."],
              ["Procure apoio", "Converse com alguém de confiança e busque atendimento profissional quando o sofrimento persistir, aumentar ou afetar sua segurança e rotina."]
            ],
            quiz: {
              question: "Qual é a resposta mais segura diante de sinais persistentes de sobrecarga?",
              options: ["Ignorar até que desapareçam", "Observar o padrão e buscar apoio", "Assumir sozinho que existe um diagnóstico"],
              answer: 1,
              explanation: "Observar o padrão e buscar apoio evita autodiagnóstico e permite cuidado oportuno."
            }
          },
          {
            id: "pausa_de_regulacao",
            title: "Pausa de regulação",
            durationMinutes: 6,
            objective: "Usar uma pausa breve para reduzir ativação e retomar a tarefa com mais clareza.",
            sections: [
              ["Pare por um instante", "Afaste-se de notificações e apoie os pés no chão. Se estiver dirigindo ou operando equipamento, faça a prática somente em local seguro."],
              ["Respire sem forçar", "Inspire de forma confortável e solte o ar um pouco mais devagar. Repita por alguns ciclos, sem prender a respiração."],
              ["Escolha o próximo passo", "Nomeie uma prioridade pequena e possível. Se não houver condição de continuar, peça suporte e reorganize a demanda."]
            ],
            quiz: {
              question: "Depois de uma pausa breve, qual atitude ajuda a retomar com segurança?",
              options: ["Tentar resolver tudo ao mesmo tempo", "Definir um próximo passo possível", "Esconder que precisa de suporte"],
              answer: 1,
              explanation: "Um próximo passo concreto reduz a sobrecarga e facilita pedir ajuda quando necessário."
            }
          }
        ]
      },
      {
        id: "limites_e_recuperacao",
        title: "Limites e recuperação",
        description: "Organize prioridades, comunique capacidade e proteja períodos de recuperação.",
        modules: [
          {
            id: "prioridade_e_capacidade",
            title: "Prioridade e capacidade",
            durationMinutes: 9,
            objective: "Tornar conflitos de prioridade visíveis antes que virem sobrecarga silenciosa.",
            sections: [
              ["Liste o que compete", "Quando várias tarefas são urgentes, registre prazos, impacto e dependências."],
              ["Peça decisão", "Apresente o conflito a quem coordena o trabalho e pergunte qual entrega deve ter prioridade."],
              ["Registre o combinado", "Uma confirmação simples reduz ambiguidades e protege a continuidade do trabalho."]
            ],
            quiz: {
              question: "Se duas entregas incompatíveis forem tratadas como prioridade máxima, o que fazer?",
              options: ["Trabalhar indefinidamente", "Esconder o conflito", "Apresentar o conflito e pedir priorização"],
              answer: 2,
              explanation: "A priorização é uma decisão de organização do trabalho e deve ficar explícita."
            }
          },
          {
            id: "recuperacao_entre_jornadas",
            title: "Recuperação entre jornadas",
            durationMinutes: 7,
            objective: "Construir uma transição realista entre trabalho e descanso.",
            sections: [
              ["Feche o ciclo", "Reserve alguns minutos para registrar pendências e o primeiro passo do dia seguinte."],
              ["Reduza gatilhos", "Quando possível, silencie alertas de trabalho fora do horário e combine canais para urgências reais."],
              ["Proteja o básico", "Sono, alimentação, movimento e vínculos de apoio não resolvem riscos organizacionais, mas ajudam na recuperação."]
            ],
            quiz: {
              question: "Qual prática ajuda na transição para o descanso?",
              options: ["Manter todos os alertas ativos", "Registrar pendências e encerrar o ciclo", "Levar todas as tarefas para casa"],
              answer: 1,
              explanation: "Registrar o próximo passo diminui a necessidade de manter tudo mentalmente ativo."
            }
          }
        ]
      }
    ]
  },
  {
    id: "relacoes_seguras",
    title: "Relações profissionais seguras",
    eyebrow: "Convivência e proteção",
    description: "Comunicação respeitosa, segurança psicológica e resposta responsável a conflitos e violência.",
    color: "gold",
    courses: [
      {
        id: "comunicacao_assertiva",
        title: "Comunicação assertiva",
        description: "Converse sobre fatos, impactos e necessidades sem agressão ou silenciamento.",
        modules: [
          {
            id: "conversas_dificeis",
            title: "Conversas difíceis",
            durationMinutes: 10,
            objective: "Estruturar uma conversa profissional com clareza e respeito.",
            sections: [
              ["Descreva o fato", "Fale do comportamento observável, sem rótulos ou suposições sobre intenção."],
              ["Explique o impacto", "Mostre como a situação afeta a tarefa, o prazo, a equipe ou sua condição de trabalho."],
              ["Faça um pedido", "Proponha uma mudança específica e confirme o entendimento. Se não houver segurança, use um canal formal."]
            ],
            quiz: {
              question: "Qual frase é mais assertiva?",
              options: ["Você nunca faz nada certo", "Quando o prazo muda sem aviso, não consigo reorganizar as entregas; podemos combinar um aviso?", "É melhor não falar nada"],
              answer: 1,
              explanation: "A frase descreve fato, impacto e pedido sem atacar a pessoa."
            }
          },
          {
            id: "escuta_e_feedback",
            title: "Escuta e feedback",
            durationMinutes: 8,
            objective: "Oferecer e receber feedback sem humilhação.",
            sections: [
              ["Separe pessoa e trabalho", "Feedback deve tratar de comportamentos e resultados, nunca diminuir identidade, dignidade ou valor pessoal."],
              ["Cheque entendimento", "Escute a outra perspectiva e confirme o que ficou combinado."],
              ["Observe o contexto", "Exposição pública, ameaça, constrangimento ou repetição podem exigir proteção e canal formal, não apenas uma conversa informal."]
            ],
            quiz: {
              question: "Feedback profissional deve se concentrar em quê?",
              options: ["Na dignidade da pessoa", "Em comportamento e resultado observáveis", "Em rumores da equipe"],
              answer: 1,
              explanation: "Foco observável permite melhoria sem ataque pessoal."
            }
          }
        ]
      },
      {
        id: "prevencao_e_protecao",
        title: "Prevenção e proteção",
        description: "Reconheça situações inadequadas e saiba como preservar evidências e procurar canais seguros.",
        modules: [
          {
            id: "assedio_e_violencia",
            title: "Assédio e violência no trabalho",
            durationMinutes: 12,
            objective: "Reconhecer condutas que exigem atenção e usar canais de proteção.",
            sections: [
              ["Não normalize", "Humilhações, ameaças, intimidação, isolamento deliberado, discriminação e condutas sexuais indesejadas não devem ser tratados como parte normal do trabalho."],
              ["Registre com segurança", "Anote datas, locais, fatos, mensagens e possíveis testemunhas. Preserve documentos sem se colocar em risco."],
              ["Procure proteção", "Use os canais institucionais adequados. Em ameaça imediata ou violência, afaste-se do risco e acione os serviços de emergência."]
            ],
            quiz: {
              question: "Diante de ameaça imediata, qual deve ser a prioridade?",
              options: ["Confrontar sozinho", "Afastar-se do risco e acionar ajuda", "Apagar todas as evidências"],
              answer: 1,
              explanation: "A segurança vem primeiro; investigação e registro acontecem sem aumentar a exposição ao risco."
            }
          },
          {
            id: "apoio_a_colega",
            title: "Como apoiar um colega",
            durationMinutes: 8,
            objective: "Acolher sem assumir o papel de terapeuta ou investigador.",
            sections: [
              ["Escute sem pressionar", "Demonstre respeito, evite julgamento e não exija detalhes que a pessoa não queira contar."],
              ["Não prometa segredo absoluto", "Se houver risco de vida ou violência, explique que será necessário buscar ajuda adequada."],
              ["Conecte com apoio", "Ajude a pessoa a acessar atendimento, liderança segura, RH, canal de denúncia ou emergência conforme a situação."]
            ],
            quiz: {
              question: "Apoiar um colega significa:",
              options: ["Resolver o caso sozinho", "Escutar e conectar com ajuda adequada", "Investigar todos os envolvidos"],
              answer: 1,
              explanation: "Acolher e facilitar acesso é mais seguro do que assumir funções clínicas ou investigativas."
            }
          }
        ]
      }
    ]
  },
  {
    id: "cultura_de_prevencao",
    title: "Cultura de prevenção",
    eyebrow: "Trabalho saudável",
    description: "Participe da melhoria das condições de trabalho e compreenda a escuta de riscos psicossociais.",
    color: "blue",
    courses: [
      {
        id: "participacao_nr1",
        title: "Participação e NR-1",
        description: "Entenda o foco da avaliação e participe sem confundir pesquisa de trabalho com diagnóstico clínico.",
        modules: [
          {
            id: "riscos_psicossociais_trabalho",
            title: "Riscos psicossociais relacionados ao trabalho",
            durationMinutes: 11,
            objective: "Diferenciar condições de trabalho, efeitos percebidos e avaliação clínica individual.",
            sections: [
              ["O foco é o trabalho", "A avaliação considera concepção, organização e gestão do trabalho: demandas, autonomia, suporte, relações, jornadas e outras condições."],
              ["Não é diagnóstico", "A pesquisa não avalia personalidade, vida privada ou diagnóstico de saúde mental de cada trabalhador."],
              ["Participação importa", "Respostas sinceras, observação do trabalho e diálogo com trabalhadores ajudam a identificar prioridades de prevenção."]
            ],
            quiz: {
              question: "Na avaliação de riscos psicossociais da NR-1, o foco principal é:",
              options: ["A personalidade do trabalhador", "As condições e a organização do trabalho", "O prontuário clínico individual"],
              answer: 1,
              explanation: "O processo preventivo examina fatores relacionados ao trabalho, não a vida privada ou prontuários."
            }
          },
          {
            id: "pesquisa_confidencial",
            title: "Como funciona a escuta confidencial",
            durationMinutes: 7,
            objective: "Responder pesquisas corporativas com consciência sobre finalidade e privacidade.",
            sections: [
              ["Leia o aviso", "Confira finalidade, período, contato de privacidade, retenção e como os resultados serão apresentados."],
              ["Responda sobre a experiência recente", "Considere tarefas, recursos, relações e organização do trabalho no período indicado."],
              ["Resultados agregados", "No Espaço Prelúdio, a empresa recebe resultados agrupados somente após o encerramento e com proteção para grupos pequenos."]
            ],
            quiz: {
              question: "O que a empresa deve receber desta escuta no Espaço Prelúdio?",
              options: ["Respostas individuais identificadas", "Prontuários dos colaboradores", "Resultados agregados com proteção de grupos pequenos"],
              answer: 2,
              explanation: "O desenho separa participação na pesquisa de conteúdo clínico individual."
            }
          }
        ]
      }
    ]
  },
  {
    id: "primeiros_socorros",
    title: "Primeiros socorros",
    eyebrow: "Resposta a emergências",
    description: "Saiba reconhecer uma emergência, acionar o socorro certo e agir com segurança até a ajuda especializada chegar.",
    color: "coral",
    courses: [
      {
        id: "primeiros_socorros_no_trabalho",
        title: "Primeiros socorros no trabalho",
        description: "Reconheça emergências e aja com segurança até a chegada do socorro especializado.",
        modules: [
          {
            id: "reconhecendo_uma_emergencia",
            title: "Reconhecendo uma emergência",
            durationMinutes: 8,
            objective: "Identificar sinais de emergência e acionar o socorro adequado sem perder tempo.",
            sections: [
              ["Observe a cena antes de agir", "Antes de se aproximar, verifique se há risco (fogo, eletricidade, trânsito, gás). Sua segurança vem primeiro — socorrista ferido não ajuda ninguém."],
              ["Reconheça sinais graves", "Perda de consciência, dificuldade grave para respirar, sangramento intenso, dor no peito, convulsão ou queda com impacto forte pedem ajuda profissional imediata."],
              ["Acione o serviço certo", "Ligue 192 (SAMU) para emergências de saúde. Para incêndio ou risco estrutural, acione a brigada do local e o corpo de bombeiros. Informe o endereço exato e o que aconteceu, e siga as orientações de quem atender até a equipe chegar."]
            ],
            quiz: {
              question: "Ao se deparar com uma emergência, qual deve ser o primeiro passo?",
              options: ["Agir imediatamente, mesmo sem avaliar o risco", "Verificar se o local é seguro antes de se aproximar", "Esperar alguém mais experiente chegar sem fazer nada"],
              answer: 1,
              explanation: "Avaliar a segurança da cena evita que quem ajuda também se machuque, o que só agrava a situação."
            }
          },
          {
            id: "enquanto_o_socorro_chega",
            title: "Enquanto o socorro chega",
            durationMinutes: 7,
            objective: "Oferecer apoio seguro a alguém em emergência até a chegada de socorro especializado, sem realizar procedimentos que exigem treinamento certificado.",
            sections: [
              ["Este conteúdo não substitui um curso certificado", "Manobras como reanimação cardiopulmonar exigem treinamento presencial certificado. Aqui o foco é o que fazer com segurança enquanto o socorro não chega."],
              ["Mantenha a pessoa segura e calma", "Não mova quem sofreu uma queda ou acidente, a menos que haja risco iminente (fogo, afogamento, trânsito). Fale com calma, mantenha a pessoa consciente e monitore a respiração."],
              ["Não ofereça comida, bebida ou remédio", "Uma pessoa ferida ou com alteração de consciência pode se engasgar. Espere a avaliação de quem está capacitado antes de oferecer qualquer coisa."]
            ],
            quiz: {
              question: "Uma pessoa caiu e está machucada, mas consciente e em local seguro. O que fazer enquanto o socorro não chega?",
              options: ["Movê-la imediatamente para uma posição mais confortável", "Mantê-la parada, calma e monitorada, sem mover", "Oferecer água para ela se acalmar"],
              answer: 1,
              explanation: "Mover uma pessoa ferida sem necessidade pode agravar lesões; o mais seguro é mantê-la parada e monitorada até a chegada do socorro."
            }
          }
        ]
      }
    ]
  }
];

const moduleMap = new Map();
for (const track of TRACKS) for (const course of track.courses) {
  for (const module of course.modules) moduleMap.set(module.id, { track, course, module });
}

function cleanCompleted(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, at]) =>
    moduleMap.has(id) && Number.isFinite(Number(at)) && Number(at) > 0));
}

function publicCatalog(progress = {}) {
  const completed = cleanCompleted(progress.completedModules);
  const tracks = TRACKS.map(track => ({
    id: track.id, title: track.title, eyebrow: track.eyebrow,
    description: track.description, color: track.color,
    courses: track.courses.map(course => {
      const modules = course.modules.map(module => ({
        id: module.id, title: module.title, durationMinutes: module.durationMinutes,
        objective: module.objective, sections: module.sections,
        quiz: { question: module.quiz.question, options: module.quiz.options },
        completedAt: completed[module.id] || null
      }));
      const completedCount = modules.filter(module => module.completedAt).length;
      return { id: course.id, title: course.title, description: course.description,
        durationMinutes: modules.reduce((sum, module) => sum + module.durationMinutes, 0),
        completedCount, totalModules: modules.length,
        progressPercent: Math.round((completedCount / modules.length) * 100), modules };
    })
  }));
  const totalModules = moduleMap.size;
  const completedModules = Object.keys(completed).length;
  const completedMinutes = [...moduleMap.values()].reduce((sum, item) =>
    sum + (completed[item.module.id] ? item.module.durationMinutes : 0), 0);
  return { version: "2026.1", tracks, summary: {
    totalModules, completedModules, completedMinutes,
    progressPercent: Math.round((completedModules / totalModules) * 100)
  } };
}

function validateCompletion(moduleId, answer) {
  const item = moduleMap.get(String(moduleId || ""));
  if (!item) return { ok: false, error: "MODULO_NAO_ENCONTRADO" };
  const selected = Number(answer);
  if (!Number.isInteger(selected) || selected < 0 || selected >= item.module.quiz.options.length) {
    return { ok: false, error: "RESPOSTA_OBRIGATORIA" };
  }
  if (selected !== item.module.quiz.answer) {
    return { ok: false, error: "RESPOSTA_INCORRETA",
      explanation: item.module.quiz.explanation };
  }
  return { ok: true, item, explanation: item.module.quiz.explanation };
}

function prerequisiteFor(moduleId) {
  const item = moduleMap.get(String(moduleId || ""));
  if (!item) return null;
  const index = item.course.modules.findIndex(module => module.id === item.module.id);
  return index > 0 ? item.course.modules[index - 1].id : null;
}

module.exports = { TRACKS, cleanCompleted, publicCatalog, validateCompletion, prerequisiteFor };
