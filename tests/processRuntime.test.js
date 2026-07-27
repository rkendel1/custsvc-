const test = require('node:test');
const assert = require('node:assert/strict');
const { compileBundle } = require('../src/lib/compiler');
const {
  startProcess,
  resumeProcess,
  completeStep,
  validateStep,
  branch,
  rollback,
  cancel,
  approve,
  listCapabilities,
  getExecutionHistory,
  CompanyIntelligenceRuntime,
  simulateProcess,
} = require('../src/lib/processRuntime');

function buildBundle() {
  return compileBundle([{ id: 'policy-refund', title: 'Refund Policy', body: 'Refund policy text' }], {
    processes: [
      {
        id: 'refund',
        roles: ['Support', 'Manager'],
        required_capabilities: ['Upload', 'Email'],
        required_documents: ['policy-refund'],
        policies: ['policy-refund'],
        steps: [
          { id: 'collect', type: 'Collect Data', required_capability: 'Upload', next: ['decision'], expected_duration: 2 },
          { id: 'decision', type: 'Decision', next: ['approve', 'escalate'], expected_duration: 1 },
          { id: 'approve', type: 'Approval', required_role: 'Manager', next: ['finish'], expected_duration: 2 },
          { id: 'escalate', type: 'Notify', next: ['finish'], expected_duration: 1 },
          { id: 'finish', type: 'Finish', next: [], expected_duration: 0 },
        ],
      },
    ],
  });
}

test('runtime supports start/validate/complete transitions', () => {
  const bundle = buildBundle();
  let execution = startProcess(bundle, 'refund');
  assert.equal(execution.currentStepId, 'collect');

  const failedValidation = validateStep(bundle, execution, { capabilities: [] });
  assert.equal(failedValidation.ok, false);

  const successfulValidation = validateStep(bundle, execution, { capabilities: ['Upload'] });
  assert.equal(successfulValidation.ok, true);

  execution = completeStep(bundle, execution, { capabilities: ['Upload'] });
  assert.equal(execution.currentStepId, 'decision');
  assert.equal(execution.status, 'ACTIVE');
});

test('runtime supports branch, rollback, and finish completion', () => {
  const bundle = buildBundle();
  let execution = startProcess(bundle, 'refund');
  execution = completeStep(bundle, execution, { capabilities: ['Upload'] });
  execution = branch(bundle, execution, 'approve');
  assert.equal(execution.currentStepId, 'approve');

  execution = rollback(execution);
  assert.equal(execution.currentStepId, 'decision');

  execution = branch(bundle, execution, 'approve');
  execution = completeStep(bundle, execution, { capabilities: ['Upload', 'Email'] });
  const pendingApproval = execution.approvals.find((item) => item.decision === 'PENDING');
  assert.ok(pendingApproval);
  execution = approve(execution, pendingApproval.id, { decided_by: 'manager@company.com' });
  execution = completeStep(bundle, execution, { capabilities: ['Upload', 'Email'] });
  execution = completeStep(bundle, execution, { capabilities: ['Upload', 'Email'] });
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.currentStepId, 'finish');
});

test('runtime supports pause/resume and cancel behavior', () => {
  const bundle = buildBundle();
  let execution = startProcess(bundle, 'refund');
  execution.status = 'PAUSED';
  execution = resumeProcess(execution);
  assert.equal(execution.status, 'ACTIVE');

  execution = cancel(execution);
  assert.equal(execution.status, 'CANCELLED');
});

test('simulation reports estimate and warnings', () => {
  const bundle = buildBundle();
  const simulation = simulateProcess(bundle, 'refund', { role: 'Support' });
  assert.equal(simulation.stepCount, 5);
  assert.equal(simulation.approvals, 1);
  assert.equal(simulation.estimatedMinutes, 6);
  assert.equal(simulation.warnings.length, 0);
});

test('action capability execution and approval gates are tracked', () => {
  const bundle = compileBundle([{ id: 'policy-refund', title: 'Refund Policy', body: 'Refund policy text' }], {
    capabilities: [
      {
        id: 'crm.create_ticket',
        provider: 'salesforce',
        permissions: ['create.ticket'],
        execution_mode: 'external',
      },
    ],
    processes: [
      {
        id: 'ticket-process',
        roles: ['Support', 'Manager'],
        required_capabilities: ['crm.create_ticket'],
        steps: [
          { id: 'collect', type: 'Collect Data', next: ['action'] },
          { id: 'action', type: 'Action', capability: 'crm.create_ticket', input_mapping: { 'context.customer.email': 'contact.email' }, next: ['approve'] },
          { id: 'approve', type: 'Approval', required_role: 'Manager', next: ['finish'] },
          { id: 'finish', type: 'Finish' },
        ],
      },
    ],
  });

  const runtime = new CompanyIntelligenceRuntime(bundle, {
    providers: {
      salesforce: {
        validate: () => ({ ok: true }),
        execute: (inputs) => ({ outputs: { ticket_id: 'T-100', ...inputs }, external_ref: 'sf:T-100' }),
      },
    },
  });
  let execution = runtime.startProcess('ticket-process', { customer: { email: 'customer@example.com' } });
  execution = runtime.completeStep(execution.id);
  execution = runtime.completeStep(execution.id);
  assert.equal(execution.outputs['crm.create_ticket'].ticket_id, 'T-100');
  assert.equal(execution.outputs['crm.create_ticket'].contact.email, 'customer@example.com');

  execution = runtime.completeStep(execution.id);
  assert.equal(execution.status, 'WAITING_APPROVAL');
  const pendingApproval = execution.approvals.find((item) => item.decision === 'PENDING');
  assert.ok(pendingApproval);
  execution = runtime.approve(execution.id, pendingApproval.id, { decided_by: 'manager@company.com', reason: 'within policy' });
  execution = runtime.completeStep(execution.id);
  execution = runtime.completeStep(execution.id);
  assert.equal(execution.status, 'COMPLETED');
  assert.ok(getExecutionHistory(execution).length >= 5);
});

test('capabilities are permission-filtered for runtime views', () => {
  const bundle = compileBundle([{ id: 'doc-1', title: 'Doc', body: 'Body' }], {
    capabilities: [
      { id: 'read.support_articles', permissions: [] },
      { id: 'issue.small_refund', permissions: ['issue.small_refund'] },
    ],
  });
  const visible = listCapabilities(bundle, { permissions: ['issue.small_refund'] });
  const hidden = listCapabilities(bundle, { permissions: [] });
  assert.equal(visible.length, 2);
  assert.equal(hidden.length, 1);
});
