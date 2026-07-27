function createAgentRuntime(options = {}) {
  const allowedActions = new Set(options.available_actions || ['start_process', 'retrieve_policy', 'ask_question']);

  async function reason({ question, intent, confidence }) {
    const safeIntent = intent || 'general_question';
    const safeConfidence = Number(confidence || 0);
    const needsClarification = safeConfidence < 0.5;
    return {
      question: String(question || ''),
      intent: safeIntent,
      confidence: safeConfidence,
      needsClarification,
    };
  }

  async function plan(reasoning) {
    if (reasoning.needsClarification) {
      return [{ action: 'ask_question', payload: { message: 'Can you clarify your request?' } }];
    }
    if (reasoning.intent === 'refund_request' && allowedActions.has('start_process')) {
      return [{ action: 'start_process', payload: { processId: 'refund_process' } }];
    }
    if (allowedActions.has('retrieve_policy')) {
      return [{ action: 'retrieve_policy', payload: { intent: reasoning.intent } }];
    }
    return [{ action: 'ask_question', payload: { message: 'How can I help?' } }];
  }

  async function execute(steps = [], handlers = {}) {
    const results = [];
    for (const step of steps) {
      if (!allowedActions.has(step.action)) throw new Error(`action not permitted: ${step.action}`);
      const handler = handlers[step.action];
      if (!handler) {
        results.push({ action: step.action, ok: false, reason: 'missing handler' });
        continue;
      }
      const result = await handler(step.payload || {});
      results.push({ action: step.action, ok: true, result });
    }
    return results;
  }

  async function verify(results = []) {
    const failed = results.filter((item) => !item.ok);
    return {
      ok: failed.length === 0,
      failed,
    };
  }

  return {
    reason,
    plan,
    execute,
    verify,
  };
}

module.exports = {
  createAgentRuntime,
};
