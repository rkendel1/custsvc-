const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compileBundle,
  isKnowledgeVisibleForRole,
  detectContradictions,
  detectDuplicates,
  calculateReviewSchedule,
} = require('../src/lib/compiler');
const { buildAnalytics } = require('../src/lib/analytics');

test('compileBundle v2 creates knowledge, chunks, and metadata', () => {
  const bundle = compileBundle([
    {
      id: 'doc-1',
      title: 'Refund policy',
      type: 'POLICY',
      visibility: 'PUBLIC',
      audience: 'PUBLIC',
      content: 'We offer refunds within 30 days. Enterprise exceptions require approval.',
    },
  ], { company: 'TestCo' });

  assert.equal(bundle.version, 2);
  assert.equal(bundle.format, 'company.intelligence.bundle');
  assert.equal(bundle.company, 'TestCo');
  assert.equal(bundle.documentCount, 1);
  assert.equal(bundle.knowledgeCount, 1);
  assert.ok(bundle.chunkCount >= 1);
  assert.equal(bundle.chunks[0].visibility, 'PUBLIC');
  assert.equal(bundle.chunks[0].audience, 'PUBLIC');
  assert.ok(bundle.chunks[0].tf.within > 0);
  assert.equal(bundle.metadata.company, 'TestCo');
});

test('compileBundle parses FAQ JSON arrays into chunks', () => {
  const bundle = compileBundle([
    {
      id: 'doc-faq',
      title: 'FAQ',
      type: 'FAQ',
      visibility: 'INTERNAL',
      content: JSON.stringify([
        { question: 'How do I reset my password?', answer: 'Click forgot password.' },
      ]),
    },
  ]);

  assert.ok(bundle.chunkCount >= 1);
  assert.match(bundle.chunks[0].text, /reset my password/i);
});

test('relationship graph integrity and traversal adjacency are compiled', () => {
  const bundle = compileBundle([
    {
      id: 'refund-policy',
      title: 'Refund Policy',
      body: 'Refunds within 30 days.',
      relationships: [{ type: 'supports', target: 'returns-policy' }],
    },
    {
      id: 'returns-policy',
      title: 'Returns Policy',
      body: 'Returns allowed with receipt.',
    },
  ]);

  assert.equal(bundle.relationships.length, 1);
  assert.equal(bundle.relationships[0].type, 'SUPPORTS');
  assert.equal(bundle.graph.adjacency['refund-policy'][0].target, 'returns-policy');
});

test('role filtering and visibility enforcement works', () => {
  const executiveOnly = {
    audience: 'EXECUTIVE',
    visibility: 'EXECUTIVE',
    department: 'Finance',
  };
  assert.equal(isKnowledgeVisibleForRole(executiveOnly, { role: 'Customer' }), false);
  assert.equal(isKnowledgeVisibleForRole(executiveOnly, { role: 'Executive', department: 'Finance' }), true);
  assert.equal(
    isKnowledgeVisibleForRole(executiveOnly, {
      role: 'Support',
      department: 'Support',
      permissions: ['view:executive', 'cross_department'],
    }),
    true,
  );
});

test('contradiction detection finds conflicting refund windows', () => {
  const contradictions = detectContradictions([
    { id: 'a', title: 'Policy A', body: 'Refunds within 14 days.' },
    { id: 'b', title: 'Policy B', body: 'Refunds within 30 days.' },
  ]);
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].severity, 'HIGH');
});

test('duplicate detection flags similar policies', () => {
  const duplicates = detectDuplicates([
    { id: 'a', title: 'Refund Policy', body: 'Refunds within 30 days with receipt.' },
    { id: 'b', title: 'Refund Policy', body: 'Refunds within 30 days with receipt.' },
  ]);
  assert.equal(duplicates.length, 1);
  assert.ok(duplicates[0].confidence >= 0.9);
});

test('review scheduling counts stale, due soon, and orphaned objects', () => {
  const now = Date.now();
  const schedule = calculateReviewSchedule([
    {
      owner: null,
      last_reviewed: new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString(),
      review_frequency: 30,
    },
    {
      owner: 'ops@company.com',
      last_reviewed: new Date(now - 25 * 24 * 60 * 60 * 1000).toISOString(),
      review_frequency: 30,
    },
  ]);
  assert.equal(schedule.stale, 1);
  assert.equal(schedule.dueNextWeek, 1);
  assert.equal(schedule.orphaned, 1);
});

test('bundle backward compatibility keeps legacy fields', () => {
  const bundle = compileBundle([{ title: 'Legacy', content: 'Legacy content' }], { company: 'LegacyCo' });
  assert.equal(bundle.company, 'LegacyCo');
  assert.ok(Array.isArray(bundle.chunks));
  assert.equal(bundle.documentCount, 1);
  assert.ok(bundle.generatedAt);
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
