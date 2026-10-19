"use strict";
// Fonte única dos endpoints que NUNCA podem responder a um chamador anônimo
// com dados — a defesa contra o tipo de falha do relatório PsiConecta (regra
// de acesso aberta no servidor, filtro só no front). Usada pelo probe ao vivo
// (scripts/security/check-anonymous-access.js), que o workflow
// anonymous-access.yml roda todo dia contra produção e staging.
//
// Cada entrada é um GET de coleção/dados clínicos cujo handler chama
// verifyFirebaseToken / verifyAdminTherapy / authenticateRt ANTES de ler o
// banco. Acrescente aqui qualquer rota nova que devolva dado de paciente,
// profissional, prontuário, financeiro ou auditoria.
//
// Rotas públicas por desenho (… /publica, /profissional/publico/:uid,
// verificar-comprovante, health) NÃO entram aqui.

const DENIED = [
  // Profissional — dados próprios e de pacientes
  { path: "/therapy/profissional/me", label: "perfil do profissional" },
  { path: "/therapy/pacientes", label: "lista de pacientes" },
  { path: "/therapy/paciente/notas", label: "notas do paciente" },
  { path: "/therapy/paciente/diario", label: "diário/cápsulas do paciente (cifrado)" },
  // Prontuário cifrado (:patientId): o auth roda antes da busca por id, então
  // anônimo recebe 401 com qualquer id — por isso o placeholder _probe.
  { path: "/therapy/pacientes/_probe/prontuario", label: "prontuário do paciente" },
  { path: "/therapy/pacientes/_probe/prontuario/registros", label: "registros do prontuário" },
  { path: "/therapy/sessoes", label: "sessões" },
  { path: "/therapy/receitas", label: "receitas" },
  { path: "/therapy/documentos", label: "documentos clínicos" },
  { path: "/therapy/notifications", label: "notificações" },
  { path: "/therapy/nps", label: "respostas de NPS" },
  { path: "/therapy/waitlist", label: "lista de espera" },
  { path: "/therapy/agenda/notes", label: "notas de agenda" },
  { path: "/therapy/aniversarios", label: "aniversários de pacientes" },
  { path: "/therapy/profissional/audit", label: "auditoria do profissional" },
  { path: "/therapy/paciente/audit", label: "auditoria do paciente" },
  // Administração da plataforma
  { path: "/therapy/admin/dashboard", label: "dashboard admin" },
  { path: "/therapy/admin/profissionais", label: "admin: profissionais" },
  { path: "/therapy/admin/sessoes", label: "admin: sessões" },
  { path: "/therapy/admin/verificacoes", label: "admin: verificações" },
  { path: "/therapy/admin/denuncias", label: "admin: denúncias" },
  { path: "/therapy/admin/comprovantes-estudante", label: "admin: comprovantes estudante" },
  { path: "/therapy/admin/comprovantes-recem-formado", label: "admin: comprovantes recém-formado" },
  { path: "/therapy/admin/comprovantes-formacao", label: "admin: comprovantes formação" },
  { path: "/therapy/admin/empresa-pendentes", label: "admin: empresas pendentes" },
  // Responsável técnico
  { path: "/rt/me", label: "RT: perfil" },
  { path: "/rt/dashboard", label: "RT: dashboard" },
  { path: "/rt/profissionais", label: "RT: profissionais" },
  { path: "/rt/incidentes", label: "RT: incidentes" },
  { path: "/rt/supervisoes", label: "RT: supervisões" },
  { path: "/rt/checklist", label: "RT: checklist" },
  // Instituição / empresa
  { path: "/institution/overview", label: "instituição: visão geral" },
  { path: "/empresa/nr1/campaigns", label: "empresa: campanhas NR-1" },
];

// Controle positivo: rota pública de propósito. Se ela também fosse barrada,
// o probe estaria bloqueando tudo por engano e não provaria nada.
const PUBLIC_OK = [
  { path: "/health", label: "health" },
];

module.exports = { DENIED, PUBLIC_OK };
