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
        title: "Conversas difíceis",
        description: "Uma história interativa: você decide o que dizer, vê o efeito de cada escolha e sai com frases prontas para usar no trabalho.",
        interactive: true,
        modules: [
          {
            id: "conversas_dificeis",
            title: "A reunião que saiu do controle",
            durationMinutes: 10,
            objective: "Conduzir uma conversa difícil com fato, impacto e pedido — sem atacar e sem se calar.",
            sections: [
              ["Descreva o fato", "Fale do comportamento observável, sem rótulos ou suposições sobre intenção."],
              ["Explique o impacto", "Mostre como a situação afeta a tarefa, o prazo, a equipe ou sua condição de trabalho."],
              ["Faça um pedido", "Proponha uma mudança específica e confirme o entendimento. Se não houver segurança, use um canal formal."]
            ],
            cast: {
              voce: { name: "Você", tone: "teal" },
              carla: { name: "Carla", role: "colega de equipe", tone: "coral" },
              narrador: { name: "", tone: "muted" }
            },
            story: [
              { type: "scene", title: "Terça, 10h — reunião de planejamento", chat: { title: "Planejamento Q4", subtitle: "Você, Carla, Diego e Ana · chat da reunião" }, lines: [
                { who: "narrador", text: "A reunião é por vídeo e a discussão acontece no chat. Você abre a proposta que levou a semana inteira para montar." },
                { who: "voce", text: "Pessoal, vou compartilhar a proposta de entrega para o Q4 🙂", typo: { at: 22, wrong: "propsota", right: "proposta" } },
                { who: "voce", text: "A ideia é dividir em duas fases: assim reduzimos o risco e conseguimos validar com o cliente antes de", interrupted: true },
                { who: "carla", text: "Na verdade isso não vai funcionar. Deixa eu explicar como eu faria.", mood: "firme" },
                { who: "carla", text: "Faz uma fase só e pronto, a gente não tem tempo pra isso." },
                { who: "narrador", text: "Sua mensagem fica no rascunho, sem ser enviada. É a terceira vez neste mês que isso acontece — e a reunião segue no ritmo dela." }
              ] },
              { type: "slider", prompt: "Agora, sinceramente: quanto isso mexeu com você?", min: "Nada", max: "Muito", tips: [
                "Mesmo que tenha passado rápido, situações que se repetem costumam pesar com o tempo. Vale tratar enquanto é pequeno.",
                "Incômodo moderado é um bom momento para conversar: você está com clareza suficiente e ainda sem raiva acumulada.",
                "Com a emoção alta, a conversa tende a virar ataque ou silêncio. Antes de falar, vale uma pausa curta — vamos fazer uma já já."
              ] },
              { type: "choice", prompt: "Depois da reunião, a Carla te chama no chat: \"Achei boa a reunião, né?\". O que você responde?", options: [
                { text: "\"Ótima.\" (e segue o dia guardando o incômodo)", meter: -1,
                  outcome: { lines: [
                    { who: "carla", text: "Que bom! Amanhã apresento a minha versão para a diretoria então 👍" },
                    { who: "narrador", text: "O silêncio evitou um atrito agora — mas a situação continua, e a sua proposta saiu da mesa." }
                  ], note: "Evitar a conversa protege no curto prazo, mas costuma fazer o problema crescer." } },
                { text: "\"Pra você, né? Você não deixa ninguém falar.\"", meter: -2,
                  outcome: { lines: [
                    { who: "carla", text: "Nossa. Eu só estava tentando ajudar o projeto. Não precisava disso.", mood: "magoada" },
                    { who: "narrador", text: "A conversa virou uma discussão sobre quem a Carla é — e não sobre o que aconteceu." }
                  ], note: "Rótulos (\"você nunca\", \"você não deixa\") colocam a outra pessoa na defensiva." } },
                { text: "\"Podemos conversar 10 minutos sobre a reunião? Queria te falar uma coisa.\"", meter: 2,
                  outcome: { lines: [
                    { who: "carla", text: "Claro… aconteceu alguma coisa?" },
                    { who: "narrador", text: "Você abriu espaço para a conversa sem acusar — e com tempo combinado." }
                  ], note: "Combinar um momento e um tempo curto reduz a tensão dos dois lados." } }
              ] },
              { type: "breath", seconds: 24, text: "Antes de falar, uma pausa curta. Acompanhe o círculo: inspire quando ele cresce, solte o ar devagar quando ele diminui." },
              { type: "build", prompt: "Monte a sua fala para a Carla. Toque nas partes na ordem que faz mais sentido.", pieces: [
                { id: "fato", text: "\"Nas três últimas reuniões, minha apresentação foi interrompida antes do fim.\"", label: "Fato" },
                { id: "impacto", text: "\"Com isso, a proposta não chega inteira ao grupo e eu perco a chance de defender o que preparei.\"", label: "Impacto" },
                { id: "pedido", text: "\"Você topa me deixar concluir e trazer seus pontos logo em seguida?\"", label: "Pedido" }
              ], order: ["fato", "impacto", "pedido"],
                success: "Fato → impacto → pedido. Você descreveu o que aconteceu, mostrou o efeito e propôs algo concreto — sem julgar quem ela é.",
                hint: "Comece pelo que aconteceu (o fato), depois o efeito, e só então o pedido." },
              { type: "choice", prompt: "A Carla responde: \"Eu interrompo porque a gente tem pouco tempo e eu já sei onde vai dar\". E agora?", options: [
                { text: "\"Tudo bem, esquece então.\"", meter: -1,
                  outcome: { lines: [
                    { who: "narrador", text: "Recuar no primeiro obstáculo devolve tudo ao ponto de partida." }
                  ], note: "Você pode reconhecer o argumento dela sem abrir mão do seu pedido." } },
                { text: "\"Entendo a preocupação com o tempo. Que tal eu fazer em 5 minutos e você comentar no fim?\"", meter: 2,
                  outcome: { lines: [
                    { who: "carla", text: "Justo. Cinco minutos e eu seguro meus comentários pro final. Combinado." },
                    { who: "narrador", text: "Você reconheceu o lado dela e propôs um caminho que atende os dois." }
                  ], note: "Validar a preocupação do outro + propor um combinado concreto costuma destravar a conversa." } },
                { text: "\"Isso é desrespeito. Vou reclamar com o gestor.\"", meter: -1,
                  outcome: { lines: [
                    { who: "carla", text: "Tá bom, faz o que você achar melhor.", mood: "fechada" },
                    { who: "narrador", text: "Levar ao gestor pode ser necessário — mas, como primeira reação, encerrou a conversa." }
                  ], note: "Canal formal é o caminho certo quando há humilhação, ameaça, assédio ou quando a conversa direta não é segura. Aqui, ainda havia espaço para combinar." } }
              ] },
              { type: "reflect", title: "Quando a conversa não é o caminho", text: "Se a situação envolve humilhação, ameaça, exposição repetida, assédio ou discriminação, você não precisa resolver sozinho(a) numa conversa. Procure seu gestor, o RH ou o canal de denúncia da empresa — e registre datas e fatos." }
            ],
            takeaway: "\"Quando [fato], [impacto]. Você topa [pedido]?\"",
            quiz: {
              question: "Desafio final: qual destas falas segue fato, impacto e pedido?",
              options: ["Você nunca faz nada certo", "Quando o prazo muda sem aviso, não consigo reorganizar as entregas; podemos combinar um aviso?", "É melhor não falar nada"],
              answer: 1,
              explanation: "A frase descreve fato, impacto e pedido sem atacar a pessoa."
            }
          },
          {
            id: "escuta_e_feedback",
            title: "O feedback que doeu",
            durationMinutes: 8,
            objective: "Receber e dar feedback separando pessoa de trabalho, sem humilhação e sem defensiva.",
            sections: [
              ["Separe pessoa e trabalho", "Feedback deve tratar de comportamentos e resultados, nunca diminuir identidade, dignidade ou valor pessoal."],
              ["Cheque entendimento", "Escute a outra perspectiva e confirme o que ficou combinado."],
              ["Observe o contexto", "Exposição pública, ameaça, constrangimento ou repetição podem exigir proteção e canal formal, não apenas uma conversa informal."]
            ],
            cast: {
              voce: { name: "Você", tone: "teal" },
              rafael: { name: "Rafael", role: "gestor", tone: "blue" },
              bruno: { name: "Bruno", role: "colega novo", tone: "gold" },
              narrador: { name: "", tone: "muted" }
            },
            story: [
              { type: "scene", title: "Quinta, 17h — chamada rápida", visual: "call", lines: [
                { who: "rafael", text: "O relatório chegou com dois números errados. O cliente percebeu antes da gente.", mood: "sério" },
                { who: "narrador", text: "Você sente o rosto esquentar. Foi uma semana pesada." }
              ] },
              { type: "choice", prompt: "Qual é a sua primeira reação?", options: [
                { text: "\"Não fui eu, a planilha veio errada do financeiro.\"", meter: -1,
                  outcome: { lines: [
                    { who: "rafael", text: "Pode ser, mas o relatório saiu com o seu nome. Precisamos entender o que aconteceu." },
                    { who: "narrador", text: "Defender-se antes de entender faz o outro insistir mais." }
                  ], note: "A defensiva é uma reação natural — perceber que ela chegou já ajuda a escolher outra resposta." } },
                { text: "\"Entendi. Pode me mostrar quais números? Quero entender onde errei.\"", meter: 2,
                  outcome: { lines: [
                    { who: "rafael", text: "Claro. Linha 14 e 22 — vieram do mês anterior." },
                    { who: "voce", text: "Já vejo: a fonte não atualizou. Corrijo hoje e coloco uma conferência antes de enviar." }
                  ], note: "Perguntar antes de se defender transforma crítica em informação útil." } },
                { text: "Ficar em silêncio e só concordar com tudo.", meter: 0,
                  outcome: { lines: [
                    { who: "rafael", text: "…Tudo bem? Você ficou quieto(a)." },
                    { who: "narrador", text: "Concordar com tudo encerra rápido, mas você sai sem saber exatamente o que mudar." }
                  ], note: "Uma pergunta de esclarecimento já é suficiente para a conversa render." } }
              ] },
              { type: "scene", title: "No dia seguinte", visual: "office", lines: [
                { who: "narrador", text: "Agora é você quem precisa dar um feedback. O Bruno, que entrou há um mês, mandou ao cliente um e-mail em tom ríspido." }
              ] },
              { type: "build", prompt: "Monte um feedback para o Bruno. Toque nas partes na ordem certa.", pieces: [
                { id: "abre", text: "\"Bruno, posso te dar um retorno sobre o e-mail de ontem?\"", label: "Pedir licença" },
                { id: "fato", text: "\"A frase 'como já expliquei' soou impaciente para o cliente.\"", label: "Fato" },
                { id: "impacto", text: "\"Ele respondeu irritado e a negociação travou.\"", label: "Impacto" },
                { id: "pedido", text: "\"Na próxima, que tal revisarmos juntos antes de enviar?\"", label: "Pedido" }
              ], order: ["abre", "fato", "impacto", "pedido"],
                success: "Você pediu licença, falou do e-mail (não do Bruno), mostrou o efeito e ofereceu apoio. Isso é feedback que ajuda.",
                hint: "Antes do fato, peça licença para dar o retorno — isso prepara a pessoa para ouvir." },
              { type: "choice", prompt: "Onde você dá esse feedback?", options: [
                { text: "Na reunião de equipe, para todos aprenderem com o erro.", meter: -2,
                  outcome: { lines: [
                    { who: "bruno", text: "(em silêncio, olhando para baixo)", mood: "constrangido" },
                    { who: "narrador", text: "Mesmo com boa intenção, a exposição pública humilha e ensina pouco." }
                  ], note: "Correção em público tende a constranger. Ajustes individuais se fazem em particular." } },
                { text: "Numa conversa rápida e reservada, só vocês dois.", meter: 2,
                  outcome: { lines: [
                    { who: "bruno", text: "Valeu por me falar assim. Eu nem tinha percebido o tom. Topo revisar junto, sim." }
                  ], note: "Em particular, a pessoa consegue ouvir sem precisar se defender da plateia." } }
              ] },
              { type: "reflect", title: "Feedback não é humilhação", text: "Gritos, ironia, exposição pública repetida ou ataques à pessoa não são feedback — podem ser assédio moral. Nesses casos, registre o que aconteceu e procure o RH ou o canal de denúncia." }
            ],
            takeaway: "\"Posso te dar um retorno sobre [situação]? Percebi [fato], que causou [impacto]. Que tal [pedido]?\"",
            quiz: {
              question: "Desafio final: feedback profissional deve se concentrar em quê?",
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
        // Módulos interativos (história com escolhas): o app nativo segue
        // usando sections + quiz; o portal web usa story/cast/takeaway.
        ...(module.story ? { story: module.story, cast: module.cast, takeaway: module.takeaway || null } : {}),
        completedAt: completed[module.id] || null
      }));
      const completedCount = modules.filter(module => module.completedAt).length;
      return { id: course.id, title: course.title, description: course.description, interactive: Boolean(course.interactive),
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
