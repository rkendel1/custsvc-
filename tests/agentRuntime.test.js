const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRuntime } = require('../src/lib/agentRuntime');

test('agentRuntime reasons, plans, executes, and verifies a refund flow', async () => {
  const agent = createAgentRuntime();
  const reasoning = await agent.reason({ question: 'I need a refund', intent: 'refund_request', confidence: 0.96 });
  assert.equal(reasoning.needsClarification, false);

  const plan = await agent.plan(reasoning);
  assert.equal(plan[0].action, 'start_process');

  const results = await agent.execute(plan, {
    start_process: async ({ processId }) => ({ started: processId }),
  });
  assert.equal(results[0].ok, true);
  const verification = await agent.verify(results);
  assert.equal(verification.ok, true);
});

test('agentRuntime blocks actions outside the allowed action list', async () => {
  const agent = createAgentRuntime({ available_actions: ['ask_question'] });
  await assert.rejects(
    () => agent.execute([{ action: 'retrieve_policy', payload: {} }], { retrieve_policy: async () => ({}) }),
    /not permitted/i,
  );
});
