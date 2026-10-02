"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const development = require("../services/corporate-development");

test("corporate learning catalog has defined tracks, courses and server-side checks", () => {
  const catalog = development.publicCatalog();
  assert.equal(catalog.version, "2026.1");
  assert.equal(catalog.tracks.length, 4);
  assert.ok(catalog.tracks.every(track => track.courses.length >= 1));
  assert.ok(catalog.tracks.flatMap(track => track.courses)
    .every(course => course.modules.length >= 2 && course.durationMinutes > 0));
  assert.equal(catalog.summary.totalModules, 12);
  assert.equal(catalog.summary.completedModules, 0);
  assert.equal("answer" in catalog.tracks[0].courses[0].modules[0].quiz, false);
});

test("module completion rejects a wrong answer and accepts the expected answer", () => {
  const wrong = development.validateCompletion("sinais_de_sobrecarga", 0);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, "RESPOSTA_INCORRETA");

  const correct = development.validateCompletion("sinais_de_sobrecarga", 1);
  assert.equal(correct.ok, true);
  assert.equal(correct.item.course.id, "saude_mental_no_trabalho");
});

test("progress ignores unknown modules and calculates the real learning journey", () => {
  const progress = development.publicCatalog({ completedModules: {
    sinais_de_sobrecarga: 1760000000000,
    pausa_de_regulacao: 1760000010000,
    unknown_module: 1760000020000
  } });
  assert.equal(progress.summary.completedModules, 2);
  assert.equal(progress.summary.completedMinutes, 14);
  assert.equal(progress.summary.progressPercent, 17);
  const firstCourse = progress.tracks[0].courses[0];
  assert.equal(firstCourse.completedCount, 2);
  assert.equal(firstCourse.progressPercent, 100);
});

test("jornada pessoal não depende de cadastro corporativo e mantém progresso por conta", () => {
  const route = readFileSync(resolve(__dirname, "../routes/therapy.js"), "utf8");
  assert.match(route, /resolveLearningParticipant\(db, uid\)/);
  assert.match(route, /therapy_patient_accounts"\)\.doc\(uid\)/);
  assert.match(route, /patientSnap\.exists \? patientSnap\.data\(\) : \{\}/);
  assert.doesNotMatch(route, /if \(!patientSnap\.exists\) return corporate/);
  assert.match(route, /doc\(`account_\$\{uid\}`\)/);
  assert.match(route, /participantType: "personal"/);
  assert.match(route, /loadEmployeeDevelopmentProgress\(db, uid, participant\)/);
});


test("curso interativo 'Conversas difíceis' mantém ids (sem perder progresso) e expõe a história", () => {
  const dev = require("../services/corporate-development");
  const catalog = dev.publicCatalog({ completedModules: { conversas_dificeis: 1790000000000 } });
  const course = catalog.tracks.flatMap(t => t.courses).find(c => c.id === "comunicacao_assertiva");
  assert.equal(course.title, "Conversas difíceis");
  assert.equal(course.interactive, true);
  assert.deepEqual(course.modules.map(m => m.id), ["conversas_dificeis", "escuta_e_feedback"]);
  assert.ok(course.modules[0].completedAt, "conclusão anterior preservada");
  for (const module of course.modules) {
    assert.ok(module.story.length >= 5, "história com várias etapas");
    assert.ok(module.sections.length && module.quiz.options.length, "app nativo continua com texto + pergunta");
    assert.equal(module.quiz.answer, undefined, "resposta certa não vai ao navegador");
    for (const step of module.story) {
      for (const line of [...(step.lines || []), ...(step.options || []).flatMap(o => o.outcome?.lines || [])]) {
        assert.ok(module.cast[line.who], `personagem ${line.who} definido`);
      }
      if (step.type === "build") assert.deepEqual([...step.order].sort(), step.pieces.map(p => p.id).sort());
    }
  }
  assert.equal(dev.validateCompletion("conversas_dificeis", 1).ok, true);
  assert.equal(dev.validateCompletion("escuta_e_feedback", 0).ok, false);
});
