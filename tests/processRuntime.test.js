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

  execution = rollback(bundle, execution);
  assert.equal(execution.currentStepId, 'decision');

  execution = branch(bundle, execution, 'approve');
  execution = completeStep(bundle, execution);
  execution = completeStep(bundle, execution);
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
