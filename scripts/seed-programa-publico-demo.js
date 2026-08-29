/**
 * Cria um percurso municipal inteiramente fictício e idempotente.
 *
 * Segurança:
 * - nunca substitui documentos reais nos IDs reservados da demonstração;
 * - todos os registros carregam syntheticData=true e clinicalUseAllowed=false;
 * - e-mails fictícios usam o domínio reservado .invalid;
 * - a conta informada vira apenas operadora da demonstração, nunca psicóloga verificada.
 */
require("dotenv").config();
const crypto = require("crypto");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const operatorEmail = String(process.argv[2] || "luishenriquekirsch@hotmail.com").trim().toLowerCase();
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "null");
if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON não configurado.");
if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
const app = initializeApp({ credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }) });
const db = getFirestore(app);
const auth = getAuth(app);

const IDS = Object.freeze({
  program: "demo_programa_aurora_2026",
  school: "demo_escola_aurora",
  student: "demo_portal_2hOQGb2JzRO5ZiKrG3tnN3fleJg2"
});
const publicSlug = "programa-aurora-demo-2026";
const registrationCode = crypto.randomBytes(24).toString("base64url");
const hashCode = value => crypto.createHash("sha256").update(value).digest("hex");
const now = FieldValue.serverTimestamp();
const demoDate = daysAgo => {
  const date = new Date(Date.now() - daysAgo * 86400000);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
};

async function refuseRealDocument(ref, label) {
  const snap = await ref.get();
  if (snap.exists && snap.data()?.syntheticData !== true) {
    throw new Error(`${label} já existe e não é sintético; operação interrompida.`);
  }
}

async function main() {
  const user = await auth.getUserByEmail(operatorEmail);
  if (!user.emailVerified) throw new Error("A conta operadora precisa ter o e-mail verificado.");
  const providerRef = db.collection("therapy_public_provider").doc("demo_config");
  const liveProviderRef = db.collection("therapy_public_provider").doc("config");
  const programRef = db.collection("therapy_public_programs").doc(IDS.program);
  const schoolRef = db.collection("therapy_schools").doc(IDS.school);
  const studentRef = db.collection("therapy_estudantes").doc(IDS.student);
  const caseRef = db.collection("therapy_student_cases").doc(IDS.student);
  await Promise.all([
    refuseRealDocument(providerRef, "Configuração da prestadora"),
    refuseRealDocument(programRef, "Programa de demonstração"),
    refuseRealDocument(schoolRef, "Escola de demonstração"),
    refuseRealDocument(studentRef, "Aluno de demonstração"),
    refuseRealDocument(caseRef, "Caso de demonstração")
  ]);

  const oldSessions = await db.collection("therapy_sessions").where("studentId", "==", IDS.student).limit(100).get();
  const liveProviderSnap = await liveProviderRef.get();
  const batch = db.batch();
  for (const doc of oldSessions.docs) if (doc.data()?.syntheticData === true) batch.delete(doc.ref);
  // Uma prestadora fictícia nunca pode ocupar o documento operacional usado
  // para ativar contratos reais. Remove apenas o registro sintético deste seed.
  if (liveProviderSnap.exists && liveProviderSnap.data()?.syntheticData === true) batch.delete(liveProviderRef);

  batch.set(providerRef, {
    legalName: "Espaço Prelúdio Demonstração Ltda. — DADO FICTÍCIO", tradeName: "Espaço Prelúdio — Ambiente de Demonstração",
    cnpj: "99999999000199", crpPjRegistration: "DEMO-NÃO-VÁLIDO", technicalResponsibleName: "Responsável técnico fictício",
    technicalResponsibleCrp: "CRP-DEMO-NÃO-VÁLIDO", clinicalCoordinatorName: "Coordenação clínica fictícia",
    clinicalCoordinatorEmail: "coordenacao@aurora.invalid", clinicalCoordinatorPhone: "(48) 99999-0001",
    dpoName: "Encarregado fictício", dpoEmail: "dpo@aurora.invalid", incidentEmail: "incidentes@aurora.invalid",
    securityOfficerName: "Responsável de segurança fictício", securityOfficerEmail: "seguranca@aurora.invalid",
    serviceAddress: "Rua da Demonstração, 100 — Aurora do Vale/SC — endereço fictício",
    privacyNoticeVersion: "DEMO-1.0", clinicalProtocolVersion: "DEMO-1.0", emergencyProtocolVersion: "DEMO-1.0",
    businessContinuityPlanVersion: "DEMO-1.0", incidentResponsePlanVersion: "DEMO-1.0",
    clinicalRecordCustodian: "Custódia fictícia — não armazena prontuário real",
    emergencyCoverageDescription: "Simulação sem cobertura assistencial. Em situação real, aplicar a rede pactuada e os protocolos vigentes.",
    ready: true, syntheticData: true, demoMode: true, clinicalUseAllowed: false, schemaVersion: 1, updatedAt: now
  });

  batch.set(programRef, {
    name: "Programa Aurora — Cuidado Psicológico Escolar (DEMONSTRAÇÃO)", contractingAuthorityName: "Prefeitura Municipal de Aurora do Vale — FICTÍCIA",
    contractingAuthorityCnpj: "99999998000198", municipality: "Aurora do Vale", state: "SC", contractNumber: "CPSI-DEMO-001/2026",
    processNumber: "PROC-DEMO-2026/001", legalInstrument: "CPSI — demonstração", legalBasis: "Simulação do Marco Legal das Startups; não é instrumento jurídico válido",
    contractingModel: "CPSI — ambiente fictício", innovationChallenge: "Ampliar, em caráter experimental, o acesso protegido de estudantes à atenção psicológica remota.",
    solutionHypothesis: "Um portal escolar com consentimento auditável, triagem de viabilidade e teleatendimento pode reduzir barreiras de acesso.",
    experimentScope: "Piloto fictício com uma escola, até 120 estudantes e operação totalmente sintética.",
    successMetrics: "Tempo até triagem; adesão; encaminhamentos concluídos; satisfação; incidentes de privacidade.",
    milestones: "M1 preparação; M2 cadastro; M3 triagem; M4 cuidado; M5 avaliação.", startDate: "2026-01-01", endDate: "2027-12-31",
    targetDescription: "Estudantes da rede municipal fictícia, com consentimento e avaliação individual de viabilidade.", minAge: 12, maxAge: 21,
    maxStudents: 120, maxSessionsPerStudent: 8, maxMonthlySessions: 160, sessionDurationMinutes: 50,
    publicManagerName: "Marina de Almeida — gestora fictícia", publicManagerEmail: "gestora@aurora.invalid", publicManagerPhone: "(48) 99999-0101",
    publicDpoName: "Paulo Nunes — DPO fictício", publicDpoEmail: "dpo.prefeitura@aurora.invalid",
    controllerRoleDescription: "Município fictício como controlador das finalidades administrativas e de elegibilidade.",
    processorRoleDescription: "Prestadora fictícia como operadora dos dados necessários à execução assistencial simulada.",
    dataSharingAgreementReference: "ACT-DEMO-001/2026", retentionPolicyReference: "RET-DEMO-001/2026",
    serviceLevelDescription: "Triagem simulada em até cinco dias úteis; disponibilidade meramente demonstrativa.", supportHours: "Segunda a sexta, 8h às 18h — fictício", incidentSlaHours: 24,
    healthNetworkReference: "UBS Central de Aurora do Vale — referência fictícia — (48) 3333-0101",
    emergencyNetworkReference: "SAMU 192, emergência 190 e rede local pactuada — cenário demonstrativo",
    privacyNoticeVersion: "DEMO-1.0", consentTermVersion: "DEMO-1.0", assentTermVersion: "DEMO-1.0", clinicalProtocolVersion: "DEMO-1.0",
    emergencyProtocolVersion: "DEMO-1.0", ripdReference: "RIPD-DEMO-001/2026", therapistUids: [user.uid], publicSlug,
    status: "active", registrationOpen: true, aiEnabledForMinors: false, totalStudents: 1, totalSchools: 1, totalSessions: 0, demoProviderId: "demo_config",
    syntheticData: true, demoMode: true, clinicalUseAllowed: false, schemaVersion: 1, activatedAt: now, updatedAt: now
  });

  batch.set(schoolRef, {
    programId: IDS.program, programName: "Programa Aurora — Cuidado Psicológico Escolar (DEMONSTRAÇÃO)",
    contractingAuthorityName: "Prefeitura Municipal de Aurora do Vale — FICTÍCIA", name: "Escola Municipal Caminhos do Sol — DEMONSTRAÇÃO",
    inepCode: "00000000", network: "Municipal fictícia", educationStages: ["Ensino Fundamental II", "Ensino Médio"],
    addressStreet: "Rua das Acácias", addressNumber: "120", addressComplement: "Prédio fictício", addressNeighborhood: "Centro",
    addressCity: "Aurora do Vale", addressState: "SC", addressPostalCode: "88000-000",
    coordinatorName: "Helena Martins — coordenadora fictícia", coordinatorEmail: "helena.martins@aurora.invalid", coordinatorPhone: "(48) 99999-0202",
    healthReferenceName: "UBS Central de Aurora do Vale — fictícia", healthReferencePhone: "(48) 3333-0101",
    safeguardingContactName: "Rafael Costa — proteção escolar fictícia", safeguardingContactPhone: "(48) 99999-0303",
    privacyContactEmail: "privacidade.escola@aurora.invalid", maxStudents: 120, status: "active", totalStudents: 1,
    registrationCodeHash: hashCode(registrationCode), registrationCodeLast4: registrationCode.slice(-4), registrationCodeRotatedAt: now,
    syntheticData: true, demoMode: true, clinicalUseAllowed: false, schemaVersion: 1, updatedAt: now
  });

  const common = {
    programId: IDS.program, programName: "Programa Aurora — Cuidado Psicológico Escolar (DEMONSTRAÇÃO)", contractNumber: "CPSI-DEMO-001/2026",
    contractingAuthorityName: "Prefeitura Municipal de Aurora do Vale — FICTÍCIA", schoolId: IDS.school,
    schoolName: "Escola Municipal Caminhos do Sol — DEMONSTRAÇÃO", schoolInepCode: "00000000", caseId: IDS.student, caseCode: "EP-DEMO-3103E981",
    syntheticData: true, demoMode: true, nonClinicalDemo: true, clinicalUseAllowed: false, schemaVersion: 1
  };
  batch.set(studentRef, {
    ...common, nome: "Luis Henrique", nomeSocial: null, dataNascimento: "2007-04-15", idade: 19, isMenor: false,
    escola: "Escola Municipal Caminhos do Sol — DEMONSTRAÇÃO", anoSerie: "3º ano do Ensino Médio — turma fictícia", turma: "3º A", turno: "Matutino",
    cidade: "Aurora do Vale", municipio: "Aurora do Vale", estado: "SC", email: operatorEmail, telefone: "(48) 99999-0404",
    studentEmail: operatorEmail, preferredContactChannel: "email", emergencyContact: { name: "Contato de emergência fictício", relationship: "Familiar", phone: "(48) 99999-0505" },
    residenceAddress: { street: "Rua da Jornada", number: "42", complement: "Casa fictícia", neighborhood: "Centro", city: "Aurora do Vale", state: "SC", postalCode: "88000-000" },
    accessibilityNeeds: "Nenhuma informada no cenário fictício", communicationNeeds: "Nenhuma informada no cenário fictício",
    consentimentoParental: true, participationConsentStatus: "confirmed", consentimentoVersion: "DEMO-1.0", privacyNoticeVersion: "DEMO-1.0",
    assentTermVersion: "DEMO-1.0", emergencyProtocolVersion: "DEMO-1.0", consentimentoAt: now,
    portalAccountUid: user.uid, portalAccountEmail: operatorEmail, portalLinkedAt: now,
    profissionalUid: user.uid, profissionalNome: "Operador de demonstração", status: "pending_triage", updatedAt: now
  });
  batch.set(caseRef, {
    ...common, studentId: IDS.student, status: "pending_triage", assignedTherapistUid: user.uid,
    assignedTherapistName: "Operador de demonstração", assignedAt: now, assignedBy: "seed_demo",
    completedSessions: 0, scheduledSessions: 0, remoteViability: null, urgencyLevel: null, updatedAt: now
  });
  batch.set(db.collection("therapists").doc(user.uid), {
    demoProgramOperator: true, demoProgramOperatorScope: [IDS.program], demoProgramOperatorEnabledAt: now, updatedAt: now
  }, { merge: true });
  batch.set(db.collection("therapy_student_events").doc(`demo_reset_${IDS.student}`), {
    studentId: IDS.student, caseId: IDS.student, programId: IDS.program, schoolId: IDS.school, type: "demo_journey_reset",
    actorUid: user.uid, actorEmail: operatorEmail, actorRole: "demo_operator", detail: { syntheticData: true, clinicalUseAllowed: false }, createdAt: now
  });
  const learningRef = db.collection("therapy_student_learning").doc(`${user.uid}_${IDS.student}`);
  const demoLearning = [
    ["course_emotional_literacy", "course", 80, 3], ["course_focus_learning", "course", 80, 2], ["course_digital_balance", "course", 70, 1],
    ["breathe_60", "practice", 10, 0], ["focus_5", "practice", 15, 0], ["gratitude_3", "practice", 10, 0],
    ["breathe_60", "practice", 10, 1], ["focus_5", "practice", 15, 1], ["emotion_checkin", "practice", 10, 1],
    ["breathe_60", "practice", 10, 2], ["active_pause", "practice", 10, 2], ["kindness_mission", "mission", 20, 2],
    ["focus_5", "practice", 15, 3], ["gratitude_3", "practice", 10, 3]
  ];
  batch.set(learningRef, { uid: user.uid, studentId: IDS.student, programId: IDS.program, schoolId: IDS.school, syntheticData: true, updatedAt: now });
  for (const [activityId, kind, points, daysAgo] of demoLearning) {
    const completionDate = demoDate(daysAgo);
    const completionId = kind === "course" ? activityId : `${activityId}_${completionDate}`;
    batch.set(learningRef.collection("completions").doc(completionId), { activityId, kind, points, completionDate, completedAt: now, syntheticData: true });
  }
  await batch.commit();
  const frontendBase = "https://espacopreludio.com.br";
  const registrationUrl = `${frontendBase}/aluno-cadastro.html?programa=${encodeURIComponent(publicSlug)}&escola=${encodeURIComponent(IDS.school)}&convite=${encodeURIComponent(registrationCode)}`;
  console.log(JSON.stringify({ ok: true, operatorEmail, operatorUid: user.uid, ids: IDS, registrationCode, registrationUrl,
    studentPortalUrl: `${frontendBase}/aluno-painel.html`,
    adminStudentsUrl: `${frontendBase}/admin-estudantes.html`,
    casesUrl: `${frontendBase}/casos-publicos.html?id=${IDS.student}` }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
