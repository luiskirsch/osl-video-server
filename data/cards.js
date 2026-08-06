// Dados de cartas do jogo (espelho CommonJS do constants.js do frontend)

const OSL_CARD_EFFECTS = {
  "Pressão Real":         { battlecry: { type: "force_player", target: "random", label: "deve responder sem fugir" }, deathrattle: { type: "give_xp", amount: 10 } },
  "Decisão Coletiva":     { battlecry: { type: "vote", question: "O grupo decide:", options: ["Revelar um segredo agora", "Continuar o ritual"] } },
  "Ruptura":              { deathrattle: { type: "give_xp", amount: 10 } },
  "Confissão Forçada":    { battlecry: { type: "force_player", target: "random", label: "deve confessar algo real" }, deathrattle: { type: "give_xp", amount: 15 } },
  "Voto da Sala":         { battlecry: { type: "vote", question: "Quem está sendo mais genuíno?" } },
  "Primeiro Suspeito":    { battlecry: { type: "force_player", target: "random", label: "está no banco dos suspeitos" } },
  "Conexão Obrigatória":  { battlecry: { type: "set_timer", duration: 90 } },
  "30 segundos":          { battlecry: { type: "force_player", target: "random", label: "deve responder sem fugir" }, deathrattle: { type: "give_xp", amount: 10 } },
  "Escolha do grupo":     { battlecry: { type: "vote", question: "O grupo decide:", options: ["Revelar um segredo agora", "Continuar o ritual"] } },
  "Confiança quebrada":   { deathrattle: { type: "give_xp", amount: 10 } },
  "Ponto em comum":       { battlecry: { type: "set_timer", duration: 120 } },
  "Silêncio compartilhado": { battlecry: { type: "set_timer", duration: 30 } },
  "Carta aberta":         { deathrattle: { type: "give_xp", amount: 15 } },
  "Inveja honesta":       { battlecry: { type: "force_player", target: "random", label: "está no centro das atenções" } },
  "Julgamento justo":     { battlecry: { type: "vote", question: "Quem está sendo mais autêntico?" } },
  "Contradição pessoal":  { deathrattle: { type: "give_xp", amount: 15 } },
  "Pergunta que temo":    { battlecry: { type: "force_player", target: "random", label: "faz a pergunta que teme" } },
  "Provocação direta":    { battlecry: { type: "force_player", target: "two_random", label: "devem se confrontar" } },
  "Interrogatório":       { battlecry: { type: "force_player", target: "random", label: "está no banco dos réus" } },
  "Voto de eliminação":   { battlecry: { type: "vote", question: "Quem sairia da sala agora?" } },
  "O mais fraco":         { battlecry: { type: "vote", question: "Quem parece mais hesitante hoje?" } },
  "Batalha de perspectivas": { battlecry: { type: "set_timer", duration: 90 } },
  "Eu não confio em você": { deathrattle: { type: "next_category", category: "Conexão" } },
  "Acusação pública":     { battlecry: { type: "force_player", target: "random", label: "será acusado" } },
  "Quem manda aqui":      { battlecry: { type: "set_timer", duration: 60 } },
  "O que nunca contei":   { deathrattle: { type: "give_xp", amount: 20 } },
  "Confissão sem nome":   { deathrattle: { type: "give_xp", amount: 15 } },
  "Fantasma do passado":  { battlecry: { type: "force_player", target: "random", label: "vai mergulhar no passado" } },
  "Versão sem filtro":    { battlecry: { type: "force_player", target: "random", label: "recebe a pergunta sem filtro" } },
  "Medo real":            { deathrattle: { type: "give_xp", amount: 15 } },
  "Meu medo de nós":      { deathrattle: { type: "give_xp", amount: 20 } },
  "Palavra que nos define": { battlecry: { type: "vote", question: "Qual palavra define a relação de vocês?", options: ["Amor", "Parceria", "Cumplicidade", "Desafio", "Confiança", "Transformação", "Liberdade", "Conexão"] } },
  "Expectativa não dita": { deathrattle: { type: "give_xp", amount: 15 } },
  "Pergunta que evito":   { battlecry: { type: "force_player", target: "random", label: "faz a pergunta que evita" }, deathrattle: { type: "give_xp", amount: 10 } }
};

const OSL_BASIC_CARDS = [
  { type: "Ritual",    title: "O Observador",      text: "Todos olham para a câmera em silêncio por 30 segundos. Depois, cada um diz em uma palavra o que sentiu.", rule: "Quem sorrir ou desviar o olhar perde a vez de falar.", phrase: "O silêncio revela mais do que as palavras." },
  { type: "Suspeita",  title: "Primeiro Suspeito",  text: "O anfitrião aponta: quem nesta sala parece estar escondendo algo? Cada jogador responde em 15 segundos.", rule: "O mais citado deve confirmar ou negar — com honestidade.", phrase: "Suspeita sem prova ainda é suspeita." },
  { type: "Confissão", title: "Confissão Forçada",  text: "Um voluntário revela algo desconfortável, real e que nunca contou ao grupo. O grupo ouve sem interromper.", phrase: "Coragem é falar mesmo com medo." },
  { type: "Decisão",   title: "Decisão Coletiva",   text: "O grupo tem 60 segundos para decidir: revelar um segredo agora ou seguir em frente. Unanimidade obrigatória.", rule: "Se não houver consenso, o anfitrião decide sozinho." },
  { type: "Pressão",   title: "Pressão Real",        text: "O anfitrião escolhe um jogador. O grupo faz uma pergunta direta. A resposta deve ter no mínimo 3 frases.", rule: "Sem desviar. Sem 'não sei'. Sem ironia.", phrase: "Presença é o que sobra quando a defesa cai." },
  { type: "Voto",      title: "Voto da Sala",        text: "Todos votam: quem está sendo mais genuíno nesta sessão? O mais votado pode fazer uma pergunta a qualquer pessoa.", phrase: "Autenticidade se reconhece antes de ser nomeada." },
  { type: "Vínculo",   title: "Conexão Obrigatória", text: "O grupo escolhe dois jogadores. Eles têm 90 segundos para descobrir algo que ninguém mais sabe sobre ambos." },
  { type: "Tensão",    title: "Ruptura",             text: "Cada jogador nomeia alguém em quem confiaria menos para guardar um segredo. Sem amenizar.", rule: "O mais citado responde: 'Por que acham isso?'", phrase: "Confiança é lenta. Traição é instantânea." }
];

const OSL_PACK_CARDS = {
  "pacote-conexao": [
    { type:"Conexão", title:"Memória que ficou",    text:"Cada jogador compartilha um momento com alguém desta sala que ainda lembra com nitidez.", rule:"Ninguém pode repetir o mesmo tipo de memória.", phrase:"O que fica não é o momento. É a sensação." },
    { type:"Conexão", title:"Primeira Impressão",   text:"O anfitrião escolhe um jogador. Os outros revelam, em 10 segundos cada, qual foi a primeira coisa que notaram nele.", rule:"O escolhido ouve tudo antes de reagir." },
    { type:"Conexão", title:"Obrigado",             text:"Alguém precisa agradecer outra pessoa desta sala por algo que nunca disse em voz alta. Com detalhes.", phrase:"Gratidão não dita nunca chega." },
    { type:"Conexão", title:"Uma Só Palavra",       text:"Cada jogador escolhe uma palavra que descreve como se sente agora. Nenhuma explicação. Nenhum comentário.", subrule:"Quando todos falarem, observem os padrões." },
    { type:"Conexão", title:"Quem Eu Admiro",       text:"Sem revelar o nome, cada pessoa descreve alguém que admira nesta sala. O grupo tenta adivinhar de quem se trata.", rule:"O admirado confirma ou nega ser quem descreveram." },
    { type:"Conexão", title:"Ponto em Comum",       text:"O grupo tem 2 minutos para descobrir algo que todos têm em comum — mas que nunca foi dito antes nesta sala.", phrase:"O que nos une supera o que nos separa." },
    { type:"Conexão", title:"Carta Aberta",         text:"Um voluntário formula uma frase que gostaria de dizer a alguém desta sala — e então diz em voz alta, de verdade." },
    { type:"Conexão", title:"30 Segundos de Presença", text:"Todos ficam em silêncio absoluto por 30 segundos, olhando para a câmera. Depois, cada um diz uma coisa que observou.", phrase:"Presença plena é o maior presente." },
    { type:"Conexão", title:"O Que Nos Une",        text:"O anfitrião aponta dois jogadores. Cada um diz algo que acredita ter em comum com o outro — sem combinar.", rule:"O outro confirma ou corrige com honestidade." },
    { type:"Conexão", title:"Apoio Visível",        text:"Cada jogador escreve no chat o nome de alguém da sala que mais precisa de apoio hoje. Sem explicações. Só os nomes.", phrase:"Ver alguém de verdade já é cuidado." },
    { type:"Conexão", title:"A Música da Sala",     text:"Se este grupo fosse uma música, qual seria? Cada um sugere uma e justifica em uma única frase." },
    { type:"Conexão", title:"Antes e Depois",       text:"Cada jogador completa: 'Antes de entrar aqui hoje eu estava... Agora estou...' Sem filtros.", phrase:"O encontro muda. Às vezes imperceptivelmente." }
  ],
  "pacote-verdades": [
    { type:"Verdade", title:"Mentira Favorita",       text:"Cada jogador confessa uma pequena mentira que conta com frequência — e por que ainda conta.", rule:"O grupo pode fazer uma única pergunta de acompanhamento." },
    { type:"Verdade", title:"O Que Eu Evito",         text:"Um voluntário revela algo sobre si mesmo que evita abordar em conversas. Deve ser real e atual.", rule:"O grupo pode fazer apenas uma pergunta — sem desvio permitido." },
    { type:"Verdade", title:"Discordância Silenciosa", text:"Há algo que você concorda publicamente mas discorda em privado? Quem tiver coragem fala agora.", phrase:"Silêncio pode ser a maior mentira." },
    { type:"Verdade", title:"Opinião Impopular",      text:"Cada jogador compartilha uma opinião que sabe que o grupo provavelmente não vai gostar de ouvir.", rule:"Ninguém pode responder imediatamente. Processem primeiro.", phrase:"A verdade incômoda vale mais." },
    { type:"Verdade", title:"Inveja Honesta",         text:"O anfitrião escolhe uma pessoa. Os outros revelam algo que invejam nela — sem elogios disfarçados.", rule:"O escolhido ouve em silêncio e depois diz o que sentiu." },
    { type:"Verdade", title:"O Que Não Disse",        text:"Houve algo que você pensou mas não disse durante esta sessão? Agora é sua última chance.", phrase:"As palavras não ditas costumam pesar mais." },
    { type:"Verdade", title:"Contradição Pessoal",    text:"Cada jogador revela algo que faz regularmente e que vai contra seus próprios valores declarados.", rule:"Sem justificativas. Apenas o reconhecimento." },
    { type:"Verdade", title:"Julgamento Justo",       text:"O grupo vota: quem está sendo mais autêntico nesta sessão? O mais votado responde: 'Por que acham isso?'", phrase:"Autenticidade se nota antes de ser dita." },
    { type:"Verdade", title:"A Pergunta que Temo",    text:"Um voluntário faz ao grupo uma pergunta que teme que alguém lhe faça. O grupo decide se devolve." },
    { type:"Verdade", title:"Ponto Fraco Real",       text:"Cada jogador revela um ponto fraco genuíno — não o fraquinho aceitável, mas o que raramente admite.", rule:"Vaidade e ironia não são respostas válidas.", phrase:"Força é trazer a vulnerabilidade à luz." },
    { type:"Verdade", title:"Reação Honesta",         text:"O anfitrião descreve uma situação difícil. Cada jogador diz honestamente como reagiria — mesmo que não goste." },
    { type:"Verdade", title:"Crença que Abandonei",   text:"Cada jogador compartilha algo em que acreditava com força e que hoje não acredita mais.", rule:"Sem defesa. Só a honestidade sobre a mudança." },
    { type:"Verdade", title:"Fronteira Testada",      text:"Cada um revela um limite pessoal que já deixou alguém ultrapassar — e se faria isso de novo.", phrase:"Fronteiras revelam mais do que virtudes." },
    { type:"Verdade", title:"Erro que Persiste",      text:"Alguém do grupo admite o último erro que cometeu e que ainda pensa nele com frequência.", rule:"O grupo não dá conselhos. Apenas ouve." },
    { type:"Verdade", title:"Espelho Duplo",          text:"Cada jogador descreve como acredita que os outros o veem — e depois diz como realmente se vê.", phrase:"A ilusão vive entre as duas versões." }
  ],
  "pacote-conflito": [
    { type:"Conflito", title:"Discordância Direta",    text:"O anfitrião escolhe dois jogadores. Cada um deve discordar ativamente da última coisa que o outro disse.", rule:"1 minuto cada. Sem interrupções. Sem amenizar." },
    { type:"Conflito", title:"Quem Manda Aqui",        text:"O grupo debate em 90 segundos quem está controlando a dinâmica desta sessão. A pessoa mais citada deve reagir.", phrase:"Poder sem consciência é o tipo mais perigoso." },
    { type:"Conflito", title:"Interrogatório",         text:"Um jogador escolhido pelo grupo responde 3 perguntas seguidas feitas pelos outros — sem desviar do assunto.", rule:"Respostas com menos de 2 frases não valem." },
    { type:"Conflito", title:"Acusação Pública",       text:"Cada jogador completa: 'Eu suspeito que [nome] está...' O nomeado pode se defender em 30 segundos.", phrase:"Toda acusação tem um grão de verdade." },
    { type:"Conflito", title:"Voto de Eliminação",     text:"Se alguém tivesse que sair da sala agora, quem seria? O grupo vota. O mais votado explica por que acha que foi escolhido.", rule:"O anfitrião não pode se abster." },
    { type:"Conflito", title:"O Mais Hesitante",       text:"Todos nomeiam quem parece mais evasivo nesta sessão. A pessoa indicada reage sem amenizar.", phrase:"Hesitação é uma verdade por dizer." },
    { type:"Conflito", title:"Linha Vermelha",         text:"Cada jogador declara o que considera absolutamente inaceitável em qualquer relação. O grupo debate se concorda.", rule:"Ninguém pode criticar a linha do outro. Só questionar." },
    { type:"Conflito", title:"Contra-argumento",       text:"O anfitrião escolhe uma afirmação dita nesta sessão. Cada jogador argumenta contra ela — mesmo que concorde.", rule:"Não é debate. É exercício de perspectiva.", phrase:"Defender o oposto revela o que realmente pensamos." },
    { type:"Conflito", title:"Aliança Revelada",       text:"O grupo tenta identificar quem está do mesmo lado nesta sala. As duplas citadas confirmam ou negam.", phrase:"Toda sala tem suas alianças invisíveis." },
    { type:"Conflito", title:"Incômodo Real",          text:"Cada jogador revela algo que outro participante faz — dentro ou fora do jogo — que o incomoda genuinamente.", rule:"Nomeie a pessoa. Nomeie o comportamento. Sem rodeios." },
    { type:"Conflito", title:"Batalha de Perspectivas", text:"O anfitrião escolhe um tema polêmico. Dois jogadores debatem lados opostos por 90 segundos — sem pausa.", rule:"O grupo vota quem foi mais convincente — não quem tem razão." },
    { type:"Conflito", title:"Desconfiança Declarada", text:"Alguém declara sem filtro por que desconfia de outra pessoa nesta sala. O nomeado ouve tudo antes de responder.", phrase:"Desconfiança em silêncio sempre cresce." },
    { type:"Conflito", title:"Dilema de Lealdade",     text:"O anfitrião cria um dilema: trair um amigo ou assumir uma consequência pública. Cada jogador escolhe e justifica.", rule:"Nenhuma resposta é julgada. Mas todas são ouvidas." },
    { type:"Conflito", title:"Parceiro Difícil",       text:"O grupo vota: quem seria mais difícil de ter como parceiro em um projeto sério? O mais votado reage — sem se defender.", phrase:"Dificuldade não é fraqueza. Mas ignorá-la é." },
    { type:"Conflito", title:"Ruptura Imaginada",      text:"Cada jogador descreve qual atitude de outra pessoa desta sala poderia encerrar a amizade ou relação para sempre.", rule:"Nomeie a pessoa. Descreva a atitude. Seja específico." }
  ],
  "pacote-segredos": [
    { type:"Segredo", title:"O Que Nunca Contei",      text:"Um voluntário revela algo que nunca contou para ninguém nesta sala. O grupo ouve em silêncio absoluto.", rule:"Sem perguntas após. Apenas aceitação.", phrase:"Segredos revelados perdem seu poder." },
    { type:"Segredo", title:"Duas Versões",            text:"Cada jogador descreve a versão de si mesmo que mostra ao mundo — e a versão que esconde com mais cuidado.", phrase:"A máscara protege. Mas também aprisiona." },
    { type:"Segredo", title:"Vergonha Enterrada",      text:"Alguém revela algo que fez e ainda carrega como peso. Nenhum julgamento é permitido — apenas presença.", rule:"O grupo permanece em silêncio por 10 segundos após." },
    { type:"Segredo", title:"Medo Real",               text:"Cada jogador revela seu maior medo — não o medo aceitável, mas o que realmente assusta quando está sozinho.", phrase:"O medo sem nome é o que mais controla." },
    { type:"Segredo", title:"Fantasma do Passado",     text:"O anfitrião escolhe um jogador. Essa pessoa descreve uma situação do passado que ainda define parte de quem ela é.", rule:"O grupo pode fazer apenas uma pergunta ao final." },
    { type:"Segredo", title:"O Que Eu Destruí",        text:"Um voluntário conta algo que destruiu — um relacionamento, uma chance, uma versão de si mesmo. Sem amenizar.", phrase:"Admitir é o primeiro ato de reconstrução." },
    { type:"Segredo", title:"Desejo Não Assumido",     text:"Cada jogador completa: 'Existe algo que desejo mas que nunca assumiria publicamente...' Ninguém pode julgar.", rule:"Quem interromper perde a vez de falar." },
    { type:"Segredo", title:"Performance Identificada", text:"O grupo debate qual comportamento de cada pessoa parece ser uma performance. Os apontados reagem com honestidade.", phrase:"Toda performance nasce de uma necessidade real." },
    { type:"Segredo", title:"Confissão Anônima",       text:"Cada jogador escreve uma confissão no chat sem assinar. O anfitrião lê em voz alta. O grupo tenta adivinhar quem escreveu.", rule:"Nenhuma confissão é comentada após ser revelada." },
    { type:"Segredo", title:"O Que Me Moldou",         text:"Cada jogador revela a experiência que mais moldou quem ele é — mesmo que nunca tenha falado sobre ela abertamente.", phrase:"Somos feitos de tudo que sobrevivemos." },
    { type:"Segredo", title:"Traição de Si Mesmo",     text:"Alguém revela uma vez em que fez algo contra seus próprios princípios — e não contou para ninguém até hoje.", rule:"O grupo não aconselha. Apenas testemunha." },
    { type:"Segredo", title:"Mensagem Não Enviada",    text:"Cada jogador pensa em uma mensagem que nunca enviou a alguém importante. Lê em voz alta — sem dizer para quem.", phrase:"O que nunca enviamos ainda mora em nós." },
    { type:"Segredo", title:"Momento de Covardia",     text:"Um voluntário conta uma situação em que deveria ter agido e não agiu — e o que essa omissão custou.", rule:"O grupo não oferece consolo imediato." },
    { type:"Segredo", title:"Ideia Fixa",              text:"Cada jogador revela algo que pensa com frequência mas nunca menciona — uma ideia recorrente, um medo, uma fantasia.", phrase:"O que pensamos em silêncio nos define." },
    { type:"Segredo", title:"Pergunta Sem Censura",    text:"O anfitrião escolhe um jogador. O grupo faz uma pergunta que normalmente seria inadequada. Uma. Só uma.", rule:"O escolhido pode responder, recusar ou devolver a pergunta." },
    { type:"Segredo", title:"Peso Emocional",          text:"Um voluntário descreve algo que ainda carrega emocionalmente de uma relação passada — sem identificar a pessoa.", phrase:"Carregamos pessoas muito depois de deixá-las ir." },
    { type:"Segredo", title:"Decisão Irreversível",    text:"Cada jogador revela uma decisão que tomou e que mudou o curso de sua vida — para bem ou para mal.", rule:"Sem arrependimento declarado. Só a verdade do que aconteceu." },
    { type:"Segredo", title:"Fronteira Invisível",     text:"Cada um revela um limite pessoal que nunca disse em voz alta mas que já foi cruzado várias vezes sem que ninguém soubesse.", phrase:"O que não nomeamos não pode ser respeitado." }
  ],
  "pacote-casais": [
    { type:"Casais", title:"O Momento Exato",         text:"Cada um conta o momento exato em que percebeu que o outro era diferente de qualquer pessoa que já conheceu.", phrase:"Há um antes e um depois. Tudo muda." },
    { type:"Casais", title:"O Não Dito",              text:"Cada parceiro revela algo que pensa sobre o relacionamento e que raramente ou nunca verbalizou. O outro só ouve.", rule:"Sem defesa. Sem explicações imediatas." },
    { type:"Casais", title:"Meu Maior Medo em Nós",   text:"Cada um completa: 'O que mais me assusta neste relacionamento é...' Sem minimizar. Sem tentar resolver agora.", phrase:"Medo compartilhado perde metade do peso." },
    { type:"Casais", title:"Me Surpreendeu Quando",   text:"Cada parceiro conta um momento em que o outro o surpreendeu — positiva ou negativamente. Com detalhes reais." },
    { type:"Casais", title:"O Que Não Pedi",          text:"Cada um revela algo que precisou do outro em algum momento mas não pediu. O outro ouve em silêncio absoluto.", rule:"Sem 'mas eu não sabia'. Só escuta.", phrase:"Pedir também é um ato de amor." },
    { type:"Casais", title:"A Versão que Você Não Viu", text:"Cada parceiro descreve uma versão de si mesmo que o outro ainda não conhece completamente.", phrase:"Nenhuma pessoa é completamente conhecida." },
    { type:"Casais", title:"Quase Tudo Diferente",    text:"Um voluntário conta uma situação em que a relação quase tomou outro rumo — e o que fez a diferença.", rule:"O outro ouve sem interromper." },
    { type:"Casais", title:"Expectativa Não Dita",    text:"Cada um revela uma expectativa sobre o relacionamento que nunca expressou claramente — mas que existe e pesa.", phrase:"Expectativas não ditas são cobranças disfarçadas." },
    { type:"Casais", title:"Aceito Mas Não Gosto",    text:"Cada parceiro revela algo no comportamento do outro que aceita, mas que preferiria que fosse diferente.", rule:"Sem ironia. Sem riso. Direto ao ponto." },
    { type:"Casais", title:"Por Que Eu Fico",         text:"Cada um responde: o que faz você escolher este relacionamento todos os dias — mesmo nos dias mais difíceis?", phrase:"Amor não é sentimento. É escolha repetida." },
    { type:"Casais", title:"O Período de Distância",  text:"Cada parceiro identifica um período em que se sentiu distante do outro. Sem culpa — apenas com honestidade.", rule:"O outro não pode contestar. Só receber." },
    { type:"Casais", title:"Uma Palavra Para Nós",    text:"Cada um escolhe uma palavra para descrever o estado atual do relacionamento. Nenhuma palavra é discutida por 2 minutos.", phrase:"Uma palavra às vezes diz mais do que tudo." },
    { type:"Casais", title:"A Pergunta que Evito",    text:"Cada parceiro revela uma pergunta que evita fazer ao outro. O outro decide se responde agora ou pede tempo." },
    { type:"Casais", title:"Como Eu Mudei",           text:"Cada um conta como mudou desde que está neste relacionamento — para melhor e para pior. Com exemplos reais.", phrase:"Toda relação nos transforma. A questão é: em quem?" },
    { type:"Casais", title:"O Que Ficou Para Trás",   text:"Cada parceiro revela algo que desejava no início da relação e que foi deixando de lado com o tempo.", rule:"O outro ouve sem explicar por que aconteceu.", phrase:"O que abrimos mão revela o que escolhemos." },
    { type:"Casais", title:"Se Eu Pudesse Recomeçar", text:"Cada um completa: 'Se eu pudesse voltar ao início desta relação, eu faria diferente...' Com honestidade real.", rule:"Não é crítica. É descoberta." },
    { type:"Casais", title:"Orgulho Real",            text:"Cada parceiro conta um momento em que sentiu orgulho genuíno do outro — algo que talvez nunca tenha dito em voz alta.", phrase:"Orgulho não dito é amor que não chegou." },
    { type:"Casais", title:"O Futuro que Imagino",    text:"Cada um descreve esta relação daqui a 5 anos — com honestidade sobre o que espera e o que teme.", phrase:"Falar sobre o futuro juntos já é construí-lo." }
  ]
};

const OSL_PACK_IDS = ["pacote-conexao","pacote-verdades","pacote-conflito","pacote-segredos","pacote-casais"];

// level = Math.floor(Math.sqrt(xp / 50)) + 1  (espelho de effects.js)
function levelFromXP(xp) { return Math.floor(Math.sqrt(Math.max(0, xp) / 50)) + 1; }

module.exports = { OSL_CARD_EFFECTS, OSL_BASIC_CARDS, OSL_PACK_CARDS, OSL_PACK_IDS, levelFromXP };
