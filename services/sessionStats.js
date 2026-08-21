function aggregateSessions(sessionsData) {
  let totalCards = 0;
  let totalTimeSec = 0;
  let totalPlayers = 0;
  let totalVotes = 0;
  let totalMissions = 0;
  let withSummary = 0;
  const emojiTally = {};

  for (const session of sessionsData) {
    const summary = session?.summary;
    if (!summary) continue;
    withSummary++;
    totalCards += summary.cardsRevealed || 0;
    totalTimeSec += summary.durationSec || 0;
    totalPlayers += summary.playerCount || 0;
    totalVotes += summary.votesTotal || 0;
    totalMissions += summary.missionsCompleted || 0;
    for (const [emoji, count] of Object.entries(summary.emojiTally || {})) {
      emojiTally[emoji] = (emojiTally[emoji] || 0) + Number(count);
    }
  }

  const topEmojiEntry = Object.entries(emojiTally).sort((left, right) => right[1] - left[1])[0];
  return {
    totalCardsRevealed: totalCards,
    totalPlayTimeSec: totalTimeSec,
    avgDurationSec: withSummary > 0 ? Math.round(totalTimeSec / withSummary) : 0,
    avgPlayers: withSummary > 0 ? Math.round((totalPlayers / withSummary) * 10) / 10 : 0,
    totalVotes,
    totalMissions,
    topEmoji: topEmojiEntry?.[0] || null,
    emojiTally,
  };
}

module.exports = { aggregateSessions };
