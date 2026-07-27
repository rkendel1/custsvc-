function buildStepMap(process) {
  const map = new Map();
  for (const step of process?.steps || []) map.set(step.id, step);
  return map;
}

function normalizeStepType(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '_');
}

function startProcess(bundle, processId, context = {}) {
  const process = (bundle?.processes || []).find((item) => item.id === processId);
  if (!process) throw new Error('process not found');
  if (!process.steps?.length) throw new Error('process has no steps');
  return {
    id: `${processId}:${Date.now()}`,
    processId,
    status: 'ACTIVE',
    context,
    currentStepId: process.steps[0].id,
    history: [],
    startedAt: new Date().toISOString(),
    pausedAt: null,
  };
}

function resumeProcess(execution) {
  if (execution.status === 'CANCELLED') throw new Error('process is cancelled');
  if (execution.status === 'COMPLETED') throw new Error('process is completed');
  return { ...execution, status: 'ACTIVE', pausedAt: null };
}

function validateStep(bundle, execution, payload = {}) {
  const process = (bundle?.processes || []).find((item) => item.id === execution.processId);
  if (!process) return { ok: false, reason: 'process not found' };
  const steps = buildStepMap(process);
  const step = steps.get(execution.currentStepId);
  if (!step) return { ok: false, reason: 'step not found' };
  if (step.required_capability && !(payload.capabilities || []).includes(step.required_capability)) {
    return { ok: false, reason: `missing capability: ${step.required_capability}` };
  }
  return { ok: true };
}

function branch(bundle, execution, nextStepId) {
  const process = (bundle?.processes || []).find((item) => item.id === execution.processId);
  if (!process) throw new Error('process not found');
  const steps = buildStepMap(process);
  const current = steps.get(execution.currentStepId);
  if (!current) throw new Error('step not found');
  if (!current.next.includes(nextStepId)) throw new Error('invalid branch target');
  return {
    ...execution,
    currentStepId: nextStepId,
    history: [...execution.history, { stepId: current.id, action: 'BRANCH', at: new Date().toISOString() }],
  };
}

function completeStep(bundle, execution, payload = {}) {
  const check = validateStep(bundle, execution, payload);
  if (!check.ok) throw new Error(check.reason);
  const process = (bundle?.processes || []).find((item) => item.id === execution.processId);
  const steps = buildStepMap(process);
  const current = steps.get(execution.currentStepId);
  const nextStepId = current.next[0] || null;
  const isFinished = normalizeStepType(current.type) === 'FINISH' || !nextStepId;
  return {
    ...execution,
    status: isFinished ? 'COMPLETED' : execution.status,
    currentStepId: isFinished ? current.id : nextStepId,
    completedAt: isFinished ? new Date().toISOString() : execution.completedAt,
    history: [...execution.history, { stepId: current.id, action: 'COMPLETE', at: new Date().toISOString() }],
  };
}

function rollback(execution) {
  const history = [...execution.history];
  const previous = history.pop();
  if (!previous) return execution;
  return {
    ...execution,
    status: 'ACTIVE',
    currentStepId: previous.stepId,
    history,
    completedAt: null,
  };
}

function cancel(execution) {
  if (execution.status === 'COMPLETED') throw new Error('completed process cannot be cancelled');
  return { ...execution, status: 'CANCELLED', cancelledAt: new Date().toISOString() };
}

function simulateProcess(bundle, processId, options = {}) {
  const process = (bundle?.processes || []).find((item) => item.id === processId);
  if (!process) throw new Error('process not found');
  const stepCount = process.steps.length;
  const approvals = process.steps.filter((step) => normalizeStepType(step.type) === 'APPROVAL').length;
  const estimatedMinutes = process.steps.reduce(
    (sum, step) => sum + (Number.isFinite(step.expected_duration) ? step.expected_duration : 0),
    0,
  );
  const warnings = [];
  if (!approvals) warnings.push('No approval steps detected');
  if (options.role && process.roles.length && !process.roles.includes(options.role)) {
    warnings.push(`Role '${options.role}' not in process roles: ${process.roles.join(', ')}`);
  }
  return { processId, stepCount, approvals, estimatedMinutes, warnings };
}

module.exports = {
  startProcess,
  resumeProcess,
  completeStep,
  validateStep,
  branch,
  rollback,
  cancel,
  simulateProcess,
};
