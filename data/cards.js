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

const OSL_PACK_IDS = ["pacote-conexao","pacote-verdades","pacote-conflito","pacote-segredos","pacote-casais"];

module.exports = { OSL_CARD_EFFECTS, OSL_BASIC_CARDS, OSL_PACK_IDS };
