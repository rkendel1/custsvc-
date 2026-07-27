const test = require('node:test');
const assert = require('node:assert/strict');
const { createWasmAiEngine } = require('../src/lib/wasmAiEngine');

test('wasmAiEngine supports initialize, inference methods, streaming, and dispose', async () => {
  const engine = createWasmAiEngine();
  const init = await engine.initialize({ id: 'company-assistant-small' });
  assert.equal(init.initialized, true);

  const generation = await engine.generate({ prompt: 'hello', context: [{ text: 'hello world' }] });
  assert.match(generation.text, /hello/i);

  const embedding = await engine.embed('hello world');
  assert.ok(Array.isArray(embedding));
  assert.ok(embedding.length > 0);

  const classification = await engine.classify('Need refund');
  assert.equal(classification.intent, 'refund_request');
  assert.ok(classification.confidence > 0.9);

  const extraction = await engine.extract('Contact me at user@example.com');
  assert.equal(extraction.email, 'user@example.com');

  const chunks = [];
  for await (const token of engine.stream({ prompt: 'hello world' })) chunks.push(token);
  assert.ok(chunks.join('').includes('hello'));

  const disposed = await engine.dispose();
  assert.equal(disposed.disposed, true);
});
