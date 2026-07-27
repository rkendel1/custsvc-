const test = require('node:test');
const assert = require('node:assert/strict');
const { compileBundle } = require('../src/lib/compiler');
const { buildAnalytics } = require('../src/lib/analytics');

test('compileBundle creates chunks with visibility and tf metadata', () => {
  const bundle = compileBundle([
    {
      id: 'doc-1',
      title: 'Refund policy',
      type: 'POLICY',
      visibility: 'PUBLIC',
      content: 'We offer refunds within 30 days. Enterprise exceptions require approval.',
    },
  ], { company: 'TestCo' });

  assert.equal(bundle.company, 'TestCo');
  assert.equal(bundle.documentCount, 1);
  assert.ok(bundle.chunkCount >= 1);
  assert.equal(bundle.chunks[0].visibility, 'PUBLIC');
  assert.ok(bundle.chunks[0].tf.within > 0);
});

test('compileBundle parses FAQ JSON arrays into chunks', () => {
  const bundle = compileBundle([
    {
      id: 'doc-faq',
      title: 'FAQ',
      type: 'FAQ',
      visibility: 'BOTH',
      content: JSON.stringify([
        { question: 'How do I reset my password?', answer: 'Click forgot password.' },
      ]),
    },
  ]);

  assert.ok(bundle.chunkCount >= 1);
  assert.match(bundle.chunks[0].text, /reset my password/i);
});

test('buildAnalytics surfaces unanswered questions and recommendations', () => {
  const analytics = buildAnalytics([
    { question: 'How do I change my billing address?', answered: false },
    { question: 'How do I change my billing address?', answered: false },
    { question: 'How do I reset my password?', answered: true },
  ]);

  assert.equal(analytics.totalQuestions, 3);
  assert.equal(analytics.unansweredQuestions, 2);
  assert.equal(analytics.topUnansweredQuestions[0].value, 'How do I change my billing address?');
  assert.ok(analytics.recommendations.length >= 1);
});
