const test = require("node:test");
const assert = require("node:assert/strict");
const { getItem, entryIdFor, completionValidationError, summarize } = require("../services/student-development");

test("catálogo não aceita atividades inventadas pelo cliente", () => {
  assert.equal(getItem("points_9999"), null);
  assert.equal(entryIdFor("points_9999", "2026-08-29"), null);
});

test("prática diária pontua uma vez por data e curso apenas uma vez", () => {
  assert.equal(entryIdFor("breathe_60", "2026-08-29"), "breathe_60_2026-08-29");
  assert.equal(entryIdFor("course_peer_support", "2026-08-29"), "course_peer_support");
});

test("curso só pode ser concluído com a resposta correta", () => {
  assert.equal(completionValidationError("course_peer_support", null), "RESPOSTA_OBRIGATORIA");
  assert.equal(completionValidationError("course_peer_support", 0), "RESPOSTA_INCORRETA");
  assert.equal(completionValidationError("course_peer_support", 2), null);
  assert.equal(completionValidationError("breathe_60", null), null);
});

test("resumo calcula pontos, cursos, nível e sequência", () => {
  const summary = summarize([
    { activityId: "breathe_60", completionDate: "2026-08-27" },
    { activityId: "focus_5", completionDate: "2026-08-28" },
    { activityId: "gratitude_3", completionDate: "2026-08-29" },
    { activityId: "course_first_aid_awareness", completionDate: "2026-08-29" }
  ], "2026-08-29");
  assert.equal(summary.totalPoints, 135);
  assert.equal(summary.completedCourses, 1);
  assert.equal(summary.streakDays, 3);
  assert.deepEqual(summary.practicedToday, ["gratitude_3"]);
});
