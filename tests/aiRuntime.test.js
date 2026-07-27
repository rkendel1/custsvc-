const test = require('node:test');
const assert = require('node:assert/strict');
const { createAIRuntime } = require('../src/lib/aiRuntime');

test('aiRuntime initializes with wasm model metadata and local inference mode', async () => {
  const runtime = createAIRuntime();
  const status = await runtime.initialize({
    models: [{ id: 'company-assistant-small', type: 'llm', runtime: 'wasm', quantization: 'int4', size: '350mb' }],
  });
  assert.equal(status.initialized, true);
  assert.equal(status.model.id, 'company-assistant-small');
  assert.equal(status.offlineReady, true);
});

test('aiRuntime falls back to retrieval-only when no model is present', async () => {
  const runtime = createAIRuntime();
  await runtime.initialize({ models: [] });
  const response = await runtime.generate({ question: 'hello', context: [{ text: 'Known answer from bundle.' }] });
  assert.equal(response.mode, 'retrieval-only');
  assert.match(response.answer, /Known answer/i);
});

test('aiRuntime supports classify, extract, and stream lifecycle', async () => {
  const runtime = createAIRuntime();
  await runtime.initialize({
    models: [{ id: 'company-assistant-small', type: 'llm', runtime: 'wasm' }],
  });

  const intent = await runtime.classify('I need a refund for my order');
  assert.equal(intent.intent, 'refund_request');
  assert.ok(intent.confidence > 0.9);

  const extracted = await runtime.extract('Order #ABCD-1234 for user@example.com amount $42.00');
  assert.equal(extracted.email, 'user@example.com');
  assert.equal(extracted.amount, '$42.00');
  assert.equal(extracted.orderId, 'ABCD-1234');

  const chunks = [];
  for await (const token of runtime.stream({ context: [{ text: 'hello world' }] })) chunks.push(token);
  assert.ok(chunks.join('').includes('hello'));
});

test('aiRuntime enforces model action permission boundaries', async () => {
  const runtime = createAIRuntime({ allowedActions: ['ask_question'] });
  await runtime.initialize({ models: [{ id: 'm1', type: 'llm', runtime: 'wasm' }] });
  const allowed = await runtime.runAction('ask_question', { message: 'Need more detail' });
  assert.equal(allowed.ok, true);
  await assert.rejects(() => runtime.runAction('start_process', { processId: 'refund_process' }), /not permitted/i);
});

test('aiRuntime telemetry defaults to privacy-preserving payload', async () => {
  const runtime = createAIRuntime();
  await runtime.initialize({ models: [] });
  const payload = runtime.buildTelemetry({
    intent: 'refund_request',
    confidence: 0.91,
    knowledgeGap: true,
    processStarted: true,
    duration: 45,
  });

  assert.equal(payload.intent, 'refund_request');
  assert.equal(payload.confidence, 0.91);
  assert.equal(payload.knowledge_gap, true);
  assert.equal(payload.process_started, true);
  assert.equal(payload.duration, 45);
  assert.equal(Object.hasOwn(payload, 'question'), false);
});
