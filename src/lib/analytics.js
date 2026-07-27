const { tokenize } = require('./tokenize');
const MIN_KEYWORD_CHAR_LENGTH = 4;

function topEntries(map, limit = 5) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function classifyIntent(question) {
  const q = String(question || '').toLowerCase();
  if (q.includes('billing') || q.includes('invoice') || q.includes('refund')) return 'billing';
  if (q.includes('password') || q.includes('login') || q.includes('oauth')) return 'authentication';
  if (q.includes('cancel') || q.includes('upgrade') || q.includes('downgrade')) return 'subscription';
  if (q.includes('integrat') || q.includes('api') || q.includes('webhook')) return 'integration';
  return 'general';
}

function buildAnalytics(telemetryEvents) {
  const events = Array.isArray(telemetryEvents) ? telemetryEvents : [];
  const byQuestion = {};
  const unansweredByQuestion = {};
  const intentCounts = {};
  const missingKeywords = {};

  for (const event of events) {
    const question = String(event.question || '').trim();
    if (!question) continue;

    byQuestion[question] = (byQuestion[question] || 0) + 1;
    const intent = classifyIntent(question);
    intentCounts[intent] = (intentCounts[intent] || 0) + 1;

    if (!event.answered) {
      unansweredByQuestion[question] = (unansweredByQuestion[question] || 0) + 1;
      const keywords = tokenize(question).filter((x) => x.length >= MIN_KEYWORD_CHAR_LENGTH);
      for (const keyword of keywords) {
        missingKeywords[keyword] = (missingKeywords[keyword] || 0) + 1;
      }
    }
  }

  const unansweredCount = Object.values(unansweredByQuestion).reduce((a, b) => a + b, 0);
  const totalQuestions = Object.values(byQuestion).reduce((a, b) => a + b, 0);

  return {
    totalQuestions,
    answeredQuestions: totalQuestions - unansweredCount,
    unansweredQuestions: unansweredCount,
    answerRate: totalQuestions ? Number(((totalQuestions - unansweredCount) / totalQuestions).toFixed(3)) : 0,
    topQuestions: topEntries(byQuestion, 10),
    topUnansweredQuestions: topEntries(unansweredByQuestion, 10),
    intents: topEntries(intentCounts, 10),
    recommendations: topEntries(missingKeywords, 8).map((item) => ({
      topic: item.value,
      signalStrength: item.count,
      recommendation: `Add or improve documentation for '${item.value}'.`,
    })),
  };
}

module.exports = {
  buildAnalytics,
};
