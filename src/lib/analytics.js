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
  const roleUsage = {};
  const departmentUsage = {};
  const confidenceBuckets = { high: 0, medium: 0, low: 0 };
  let unansweredTotal = 0;

  for (const event of events) {
    const question = String(event.question || '').trim();
    const intentFromEvent = String(event.intent || '').trim();
    if (!question && !intentFromEvent) continue;

    if (question) byQuestion[question] = (byQuestion[question] || 0) + 1;
    const intent = intentFromEvent || classifyIntent(question);
    intentCounts[intent] = (intentCounts[intent] || 0) + 1;
    const role = String(event.role || 'Customer');
    roleUsage[role] = (roleUsage[role] || 0) + 1;
    const department = String(event.department || 'Unknown');
    departmentUsage[department] = (departmentUsage[department] || 0) + 1;
    const confidence = Number(event.confidence || 0);
    if (confidence >= 0.75) confidenceBuckets.high += 1;
    else if (confidence >= 0.4) confidenceBuckets.medium += 1;
    else confidenceBuckets.low += 1;

    if (!event.answered) {
      unansweredTotal += 1;
      if (question) {
        unansweredByQuestion[question] = (unansweredByQuestion[question] || 0) + 1;
        const keywords = tokenize(question).filter((x) => x.length >= MIN_KEYWORD_CHAR_LENGTH);
        for (const keyword of keywords) {
          missingKeywords[keyword] = (missingKeywords[keyword] || 0) + 1;
        }
      }
    }
  }

  const unansweredCount = unansweredTotal;
  const totalQuestions = events.filter((event) => String(event.question || '').trim() || String(event.intent || '').trim()).length;

  return {
    totalQuestions,
    answeredQuestions: totalQuestions - unansweredCount,
    unansweredQuestions: unansweredCount,
    answerRate: totalQuestions ? Number(((totalQuestions - unansweredCount) / totalQuestions).toFixed(3)) : 0,
    topQuestions: topEntries(byQuestion, 10),
    topUnansweredQuestions: topEntries(unansweredByQuestion, 10),
    intents: topEntries(intentCounts, 10),
    roleUsage: topEntries(roleUsage, 10),
    departmentUsage: topEntries(departmentUsage, 10),
    confidence: confidenceBuckets,
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
