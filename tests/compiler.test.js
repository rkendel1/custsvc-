const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compileBundle,
  isKnowledgeVisibleForRole,
  detectContradictions,
  detectDuplicates,
  calculateReviewSchedule,
  validateProcesses,
} = require('../src/lib/compiler');
const { buildAnalytics } = require('../src/lib/analytics');

test('compileBundle v3 creates knowledge, chunks, and metadata', () => {
  const bundle = compileBundle([
    {
      id: 'doc-1',
      title: 'Refund policy',
      type: 'POLICY',
      visibility: 'PUBLIC',
      audience: 'PUBLIC',
      body: 'We offer refunds within 30 days. Enterprise exceptions require approval.',
    },
  ], { company: 'TestCo' });

  assert.equal(bundle.version, 3);
  assert.equal(bundle.format, 'company.intelligence.bundle.v3');
  assert.equal(bundle.format_legacy, 'company.intelligence.bundle');
  assert.equal(bundle.company, 'TestCo');
  assert.equal(bundle.documentCount, 1);
  assert.equal(bundle.knowledgeCount, 1);
  assert.ok(bundle.chunkCount >= 1);
  assert.equal(bundle.chunks[0].visibility, 'PUBLIC');
  assert.equal(bundle.chunks[0].audience, 'PUBLIC');
  assert.ok(bundle.chunks[0].tf.within > 0);
  assert.equal(bundle.metadata.company, 'TestCo');
  assert.equal(bundle.processCount, 0);
  assert.ok(bundle.process_graph && Array.isArray(bundle.process_graph.nodes));
  assert.ok(bundle.role_views && bundle.role_views.Customer);
});

test('compileBundle parses FAQ JSON arrays into chunks', () => {
  const bundle = compileBundle([
    {
      id: 'doc-faq',
      title: 'FAQ',
      type: 'FAQ',
      visibility: 'INTERNAL',
      body: JSON.stringify([
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

test('visibility enforces strict v2 audience levels', () => {
  const bundle = compileBundle([
    { id: 'doc-1', title: 'Strict visibility', body: 'Body', visibility: 'BOTH', audience: 'BOTH' },
  ]);
  assert.equal(bundle.knowledge[0].visibility, 'INTERNAL');
  assert.equal(bundle.knowledge[0].audience, 'INTERNAL');
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

test('compiler requires v2 body field and does not infer from legacy content field', () => {
  const bundle = compileBundle([{ title: 'Legacy', content: 'Legacy content only' }], { company: 'LegacyCo' });
  assert.equal(bundle.knowledge[0].body, '');
  assert.equal(bundle.chunkCount, 0);
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

test('process graph and process validations are compiled into bundle', () => {
  const bundle = compileBundle(
    [{ id: 'refund-policy', title: 'Refund Policy', body: 'Policy body' }],
    {
      processes: [
        {
          id: 'refund',
          name: 'Refund',
          roles: ['Support', 'Manager'],
          required_capabilities: ['Upload', 'Email'],
          required_documents: ['refund-policy'],
          policies: ['refund-policy'],
          steps: [
            { id: 'start', title: 'Start', type: 'Collect Data', required_role: 'Support', next: ['decision'] },
            { id: 'decision', title: 'Within policy', type: 'Decision', next: ['approve', 'escalate'] },
            { id: 'approve', title: 'Approve', type: 'Approval', required_role: 'Manager', next: 'finish' },
            { id: 'escalate', title: 'Escalate', type: 'Notify', required_capability: 'Email', next: 'finish' },
            { id: 'finish', title: 'Finish', type: 'Finish' },
          ],
        },
      ],
    },
  );

  assert.equal(bundle.processCount, 1);
  assert.ok(bundle.process_graph.nodes.length >= 5);
  assert.ok(bundle.process_graph.edges.length >= 4);
  assert.equal(bundle.review.processes.dead_ends.length, 0);
  assert.equal(bundle.review.processes.unreachable_steps.length, 0);
  assert.equal(bundle.review.processes.invalid_links.length, 0);
});

test('process validation catches dead ends, unreachable steps, branches, roles, capabilities, and links', () => {
  const knowledge = [{ id: 'k1' }];
  const issues = validateProcesses(
    [
      {
        id: 'p1',
        roles: ['Support'],
        required_capabilities: ['Upload'],
        required_documents: ['missing-doc'],
        policies: ['missing-policy'],
        steps: [
          { id: 's1', type: 'Decision', next: ['s2'] },
          { id: 's2', type: 'Approval', required_role: null, next: [] },
          { id: 's3', type: 'Collect Data', required_role: 'Manager', required_capability: 'OCR', next: [] },
        ],
      },
      { id: 'empty', steps: [] },
    ],
    knowledge,
  );

  assert.ok(issues.branch_errors.length >= 1);
  assert.ok(issues.missing_approvals.length >= 1);
  assert.ok(issues.unreachable_steps.find((item) => item.stepId === 's3'));
  assert.ok(issues.invalid_role_transitions.find((item) => item.role === 'Manager'));
  assert.ok(issues.missing_capabilities.find((item) => item.capability === 'OCR'));
  assert.ok(issues.invalid_links.length >= 2);
  assert.ok(issues.orphaned_processes.find((item) => item.processId === 'empty'));
});

test('process validation allows intentional cycles', () => {
  const issues = validateProcesses([
    {
      id: 'loop',
      steps: [
        { id: 'a', type: 'Wait', next: ['b'], intentional_cycle: true },
        { id: 'b', type: 'Branch', next: ['a', 'c'] },
        { id: 'c', type: 'Finish', next: [] },
      ],
    },
  ]);

  assert.equal(issues.cycles.length, 0);
});

test('bundle keeps v2-compatible knowledge and chunk fields', () => {
  const bundle = compileBundle([{ id: 'd1', title: 'Legacy', body: 'Legacy body' }]);
  assert.ok(Array.isArray(bundle.knowledge));
  assert.ok(Array.isArray(bundle.chunks));
  assert.ok(Array.isArray(bundle.relationships));
  assert.ok(bundle.graph && bundle.indexes && bundle.review_schedule);
});

test('bundle exposes v3 format with explicit v2 compatibility markers', () => {
  const bundle = compileBundle([{ id: 'd2', title: 'Doc', body: 'Body' }], { processes: [] });
  assert.equal(bundle.version, 3);
  assert.equal(bundle.format, 'company.intelligence.bundle.v3');
  assert.equal(bundle.format_legacy, 'company.intelligence.bundle');
  assert.ok(bundle.metadata && typeof bundle.metadata.knowledgeCount === 'number');
  assert.ok(Array.isArray(bundle.knowledge));
  assert.ok(Array.isArray(bundle.chunks));
});
