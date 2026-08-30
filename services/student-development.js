const ITEMS = Object.freeze({
  breathe_60: Object.freeze({ kind: "practice", points: 10, repeatable: true }),
  focus_5: Object.freeze({ kind: "practice", points: 15, repeatable: true }),
  emotion_checkin: Object.freeze({ kind: "practice", points: 10, repeatable: true }),
  gratitude_3: Object.freeze({ kind: "practice", points: 10, repeatable: true }),
  active_pause: Object.freeze({ kind: "practice", points: 10, repeatable: true }),
  kindness_mission: Object.freeze({ kind: "mission", points: 20, repeatable: true }),
  course_emotional_literacy: Object.freeze({ kind: "course", points: 80, repeatable: false, correctAnswer: 1 }),
  course_focus_learning: Object.freeze({ kind: "course", points: 80, repeatable: false, correctAnswer: 1 }),
  course_first_aid_awareness: Object.freeze({ kind: "course", points: 100, repeatable: false, correctAnswer: 1 }),
  course_peer_support: Object.freeze({ kind: "course", points: 90, repeatable: false, correctAnswer: 2 }),
  course_digital_balance: Object.freeze({ kind: "course", points: 70, repeatable: false, correctAnswer: 1 }),
  course_citizenship: Object.freeze({ kind: "course", points: 70, repeatable: false, correctAnswer: 1 })
});

function getItem(id) {
  return ITEMS[String(id || "").trim()] || null;
}

function entryIdFor(itemId, completionDate) {
  const item = getItem(itemId);
  if (!item) return null;
  return item.repeatable ? `${itemId}_${completionDate}` : itemId;
}

function completionValidationError(itemId, answer) {
  const item = getItem(itemId);
  if (!item) return "ATIVIDADE_DESCONHECIDA";
  if (item.kind !== "course") return null;
  if (!Number.isInteger(answer)) return "RESPOSTA_OBRIGATORIA";
  return answer === item.correctAnswer ? null : "RESPOSTA_INCORRETA";
}

function previousDate(dateKey, days = 1) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function summarize(entries, today) {
  const valid = (Array.isArray(entries) ? entries : []).filter(entry => getItem(entry.activityId));
  const totalPoints = valid.reduce((sum, entry) => sum + getItem(entry.activityId).points, 0);
  const completedActivityIds = [...new Set(valid.filter(entry => !getItem(entry.activityId).repeatable).map(entry => entry.activityId))];
  const practicedToday = [...new Set(valid.filter(entry => getItem(entry.activityId).repeatable && entry.completionDate === today).map(entry => entry.activityId))];
  const activeDates = new Set(valid.map(entry => entry.completionDate).filter(Boolean));
  let streakDays = 0;
  let cursor = today;
  if (!activeDates.has(cursor)) cursor = previousDate(cursor);
  while (activeDates.has(cursor)) {
    streakDays += 1;
    cursor = previousDate(cursor);
  }
  return {
    totalPoints,
    level: Math.max(1, 1 + Math.floor(totalPoints / 250)),
    nextLevelAt: (1 + Math.floor(totalPoints / 250)) * 250,
    completedActivityIds,
    practicedToday,
    completedCourses: completedActivityIds.filter(id => getItem(id)?.kind === "course").length,
    streakDays,
    totalActions: valid.length
  };
}

module.exports = { ITEMS, getItem, entryIdFor, completionValidationError, summarize };
