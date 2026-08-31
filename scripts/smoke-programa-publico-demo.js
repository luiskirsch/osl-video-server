/**
 * Ensaio ponta a ponta do cenário público sintético contra a produção.
 *
 * O script se recusa a operar se o caso não estiver marcado como demonstração.
 * Ele avança triagem, cria sala, valida as duas credenciais LiveKit/E2EE e
 * encerra a sessão. Execute o seed novamente depois para restaurar o roteiro.
 */
require("dotenv").config();
const assert = require("node:assert/strict");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const backendBase = String(process.env.PUBLIC_PROGRAM_SMOKE_BACKEND || "https://osl-video-server-production.up.railway.app").replace(/\/$/, "");
const firebaseWebApiKey = String(process.env.FIREBASE_WEB_API_KEY || "AIzaSyC8sSvA7_1HPYRFGFgdgzstkP_yQHadY-c").trim();
const studentEmail = String(process.argv[2] || "luishenriquekirsch@hotmail.com").trim().toLowerCase();
const presenterEmail = String(process.argv[3] || process.env.PUBLIC_PROGRAM_DEMO_PRESENTER_EMAIL || "contato@preludiojogos.com.br").trim().toLowerCase();
const studentId = "demo_portal_2hOQGb2JzRO5ZiKrG3tnN3fleJg2";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "null");
if (!serviceAccount) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON não configurado.");
if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
const app = initializeApp({ credential: cert({
  projectId: serviceAccount.project_id,
  clientEmail: serviceAccount.client_email,
  privateKey: serviceAccount.private_key
}) });
const auth = getAuth(app);

async function idTokenForEmail(email) {
  const user = await auth.getUserByEmail(email);
  const customToken = await auth.createCustomToken(user.uid);
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(firebaseWebApiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.idToken) throw new Error(`Falha ao autenticar ${email}: ${data.error?.message || response.status}`);
  return data.idToken;
}

async function api(path, token, options = {}) {
  const response = await fetch(`${backendBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(`${path}: ${data.error || response.status}`);
  return data;
}

async function main() {
  const [studentToken, presenterToken] = await Promise.all([
    idTokenForEmail(studentEmail),
    idTokenForEmail(presenterEmail)
  ]);
  let detail = await api(`/therapy/programa-publico/casos/${studentId}`, presenterToken);
  assert.equal(detail.demo, true, "O ensaio só pode operar no caso sintético reservado.");
  assert.equal(detail.demoOperator, true, "A conta profissional não está autorizada como apresentadora.");
  assert.equal(detail.case.status, "pending_triage", "Restaure o seed antes do ensaio.");

  await api(`/therapy/programa-publico/casos/${studentId}/iniciar-triagem`, presenterToken, { method: "POST" });
  await api(`/therapy/programa-publico/casos/${studentId}/triagem`, presenterToken, {
    method: "POST",
    body: JSON.stringify({
      remoteViability: "suitable",
      urgencyLevel: "routine",
      assentStatus: "obtained",
      assentMethod: "Verbal durante ensaio sintético",
      referralSource: "Escola fictícia",
      referralNotes: "Demanda fictícia para validação do percurso.",
      clinicalDecisionReason: "Condições técnicas e de segurança confirmadas no cenário demonstrativo.",
      careConditions: "Manter ambiente privado e rede local de referência disponível.",
      expectedSessions: 4,
      privacyAvailable: true,
      deviceAvailable: true,
      connectivityAdequate: true,
      guardianSupportAdequate: true,
      accessibilityAddressed: true,
      emergencyAddressVerified: true,
      localNetworkVerified: true,
      riskFlags: {
        suicideOrSelfHarm: false,
        violenceOrRightsViolation: false,
        acutePsychiatric: false,
        substanceRisk: false,
        acuteMedical: false
      }
    })
  });

  const fiveMinutes = 5 * 60 * 1000;
  const scheduledAt = Math.ceil((Date.now() + 10 * 60 * 1000) / fiveMinutes) * fiveMinutes;
  const scheduled = await api(`/therapy/programa-publico/casos/${studentId}/agendar`, presenterToken, {
    method: "POST",
    body: JSON.stringify({ scheduledAt })
  });
  assert.equal(scheduled.demo, true);
  assert.equal(scheduled.videoRoomCreated, true);
  assert.ok(scheduled.joinCode);

  const portal = await api("/therapy/aluno/me", studentToken);
  const student = portal.items.find(item => item.id === studentId);
  const session = student?.sessions.find(item => item.id === scheduled.sessionId);
  assert.equal(session?.joinAvailable, true);
  assert.equal(session?.joinCode, scheduled.joinCode);

  const preJoinResponse = await fetch(`${backendBase}/therapy/sessao/pre-join?c=${encodeURIComponent(session.joinCode)}`);
  const preJoin = await preJoinResponse.json();
  assert.equal(preJoin.ok, true);
  assert.equal(preJoin.demoTechnicalRoom, true);
  assert.equal(preJoin.paymentRequired, false);

  const patientJoinResponse = await fetch(`${backendBase}/therapy/sessao/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ joinCode: session.joinCode, patientName: "Aluno de demonstração", consentLgpd: true })
  });
  const patientJoin = await patientJoinResponse.json();
  assert.equal(patientJoin.ok, true);
  assert.equal(patientJoin.demoTechnicalRoom, true);
  assert.ok(patientJoin.livekitToken);
  assert.ok(patientJoin.livekitUrl);
  assert.ok(patientJoin.e2eeKey);

  const professionalJoin = await api(`/therapy/sessao/${scheduled.sessionId}/livekit-token`, presenterToken, { method: "POST" });
  assert.equal(professionalJoin.demoTechnicalRoom, true);
  assert.ok(professionalJoin.livekitToken);
  assert.equal(professionalJoin.livekitRoom, patientJoin.livekitRoom);
  assert.equal(professionalJoin.e2eeKey, patientJoin.e2eeKey);

  await api(`/therapy/sessao/${scheduled.sessionId}/encerrar`, presenterToken, { method: "POST" });
  const finalPortal = await api("/therapy/aluno/me", studentToken);
  const finalSession = finalPortal.items.find(item => item.id === studentId)?.sessions.find(item => item.id === scheduled.sessionId);
  assert.equal(finalSession?.status, "completed");
  assert.equal(finalSession?.joinAvailable, false);

  console.log(JSON.stringify({
    ok: true,
    scenario: "public_program_demo_end_to_end",
    sessionId: scheduled.sessionId,
    checks: ["triage", "schedule", "student_portal", "patient_livekit", "professional_livekit", "e2ee_match", "completion"]
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
