function buildStepMap(process) {
  const map = new Map();
  for (const step of process?.steps || []) map.set(step.id, step);
  return map;
}

function normalizeStepType(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '_');
}

function resolveCapability(bundle, capabilityId) {
  const capabilities = Array.isArray(bundle?.capabilities) ? bundle.capabilities : [];
  return capabilities.find((item) => {
    if (typeof item === 'string') return item === capabilityId;
    return item?.id === capabilityId;
  }) || null;
}

function getPath(source, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), source);
}

function setPath(target, path, value) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) return target;
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
  return target;
}

/**
 * Maps internal execution fields into external action payload fields using dot-notation paths.
 * mapping shape: { "context.customer.email": "contact.email" }.
 */
function mapActionInputs(execution, mapping = {}, payloadInputs = {}) {
  const mapped = { ...payloadInputs };
  for (const [internalPath, externalPath] of Object.entries(mapping)) {
    if (!externalPath) continue;
    const value = getPath(
      {
        context: execution.context || {},
        variables: execution.variables || {},
        outputs: execution.outputs || {},
      },
      internalPath,
    );
    if (typeof value === 'undefined') continue;
    setPath(mapped, externalPath, value);
  }
  return mapped;
}

function appendTimeline(execution, event, details = {}) {
  return {
    ...execution,
    timeline: [...(execution.timeline || []), { at: new Date().toISOString(), event, ...details }],
  };
}

function startProcess(bundle, processId, context = {}) {
  const process = (bundle?.processes || []).find((item) => item.id === processId);
  if (!process) throw new Error('process not found');
  if (!process.steps?.length) throw new Error('process has no steps');
  return appendTimeline({
    id: `${processId}:${Date.now()}`,
    processId,
    status: 'ACTIVE',
    context,
    currentStepId: process.steps[0].id,
    history: [],
    approvals: [],
    variables: context.variables && typeof context.variables === 'object' ? { ...context.variables } : {},
    outputs: {},
    external_refs: {},
    startedAt: new Date().toISOString(),
    pausedAt: null,
  }, 'PROCESS_STARTED', { processId });
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
  if (execution.status === 'WAITING_APPROVAL') {
    const approval = (execution.approvals || []).find(
      (item) => item.stepId === step.id && item.decision === 'PENDING',
    );
    if (approval) return { ok: false, reason: 'approval pending' };
  }
  if (step.required_capability && !(payload.capabilities || []).includes(step.required_capability)) {
    return { ok: false, reason: `missing capability: ${step.required_capability}` };
  }
  if (normalizeStepType(step.type) === 'ACTION' && step.capability && !resolveCapability(bundle, step.capability)) {
    return { ok: false, reason: `missing capability definition: ${step.capability}` };
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
  return appendTimeline({
    ...execution,
    currentStepId: nextStepId,
    history: [...execution.history, { stepId: current.id, action: 'BRANCH', at: new Date().toISOString() }],
  }, 'STEP_BRANCHED', { stepId: current.id, nextStepId });
}

function executeCapability(bundle, execution, capabilityId, payload = {}) {
  const capability = resolveCapability(bundle, capabilityId);
  if (!capability) throw new Error(`unknown capability: ${capabilityId}`);
  const providers = payload.providers && typeof payload.providers === 'object' ? payload.providers : {};
  const providerId = typeof capability === 'string' ? null : capability.provider;
  const provider = providerId ? providers[providerId] : null;
  if (providerId && !provider) {
    throw new Error(`missing capability provider: ${providerId}; ensure it is configured in payload.providers`);
  }
  if (provider?.authenticate) provider.authenticate(payload.credentials || null, capability);
  const validation = provider?.validate ? provider.validate(payload.inputs || {}, capability) : { ok: true };
  if (validation && validation.ok === false) throw new Error(validation.reason || 'capability validation failed');
  const result = provider?.execute
    ? provider.execute(payload.inputs || {}, capability)
    : { outputs: payload.inputs || {}, external_ref: null };
  const executionWithResult = appendTimeline({
    ...execution,
    outputs: {
      ...(execution.outputs || {}),
      [capabilityId]: result?.outputs || result || {},
    },
    external_refs: {
      ...(execution.external_refs || {}),
      [capabilityId]: [
        ...((execution.external_refs || {})[capabilityId] || []),
        result?.external_ref || null,
      ].filter(Boolean),
    },
    history: [...execution.history, { stepId: execution.currentStepId, action: 'EXECUTE_CAPABILITY', capabilityId, at: new Date().toISOString() }],
  }, 'CAPABILITY_EXECUTED', { capabilityId, provider: providerId || 'internal' });
  return { execution: executionWithResult, result };
}

function completeStep(bundle, execution, payload = {}) {
  const check = validateStep(bundle, execution, payload);
  if (!check.ok) throw new Error(check.reason);
  const process = (bundle?.processes || []).find((item) => item.id === execution.processId);
  const steps = buildStepMap(process);
  const current = steps.get(execution.currentStepId);
  let nextExecution = execution;
  if (normalizeStepType(current.type) === 'APPROVAL') {
    const approvalsForStep = (execution.approvals || []).filter((item) => item.stepId === current.id);
    const existing = approvalsForStep.find((item) => item.decision === 'PENDING');
    if (existing) throw new Error('approval pending');
    const approved = approvalsForStep.find((item) => item.decision === 'APPROVED');
    if (approved) {
      nextExecution = appendTimeline({
        ...execution,
        status: 'ACTIVE',
        pausedAt: null,
      }, 'APPROVAL_CONFIRMED', { approvalId: approved.id, stepId: current.id });
    } else if (approvalsForStep.find((item) => item.decision === 'REJECTED')) {
      throw new Error('approval rejected');
    } else {
      const approval = {
        id: `${execution.id}:${current.id}:${Date.now()}`,
        stepId: current.id,
        requested_by: payload.requested_by || 'runtime',
        assigned_role: current.required_role || payload.assigned_role || null,
        context: payload.approval_context || {},
        deadline: payload.deadline || null,
        decision: 'PENDING',
        reason: null,
        createdAt: new Date().toISOString(),
      };
      return appendTimeline({
        ...execution,
        status: 'WAITING_APPROVAL',
        pausedAt: new Date().toISOString(),
        approvals: [...(execution.approvals || []), approval],
        history: [...execution.history, { stepId: current.id, action: 'REQUEST_APPROVAL', at: new Date().toISOString() }],
      }, 'APPROVAL_REQUESTED', { approvalId: approval.id, stepId: current.id });
    }
  }
  if (normalizeStepType(current.type) === 'ACTION' && current.capability) {
    const mappedInputs = mapActionInputs(nextExecution, current.input_mapping || {}, payload.inputs || {});
    const executed = executeCapability(bundle, nextExecution, current.capability, {
      ...payload,
      inputs: mappedInputs,
    });
    nextExecution = executed.execution;
  }
  const nextStepId = current.next[0] || null;
  const isFinished = normalizeStepType(current.type) === 'FINISH' || !nextStepId;
  return appendTimeline({
    ...nextExecution,
    status: isFinished ? 'COMPLETED' : nextExecution.status,
    currentStepId: isFinished ? current.id : nextStepId,
    completedAt: isFinished ? new Date().toISOString() : nextExecution.completedAt,
    history: [...nextExecution.history, { stepId: current.id, action: 'COMPLETE', at: new Date().toISOString() }],
  }, 'STEP_COMPLETED', { stepId: current.id, nextStepId });
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
  return appendTimeline({ ...execution, status: 'CANCELLED', cancelledAt: new Date().toISOString() }, 'PROCESS_CANCELLED');
}

function listCapabilities(bundle, context = {}) {
  const capabilities = Array.isArray(bundle?.capabilities) ? bundle.capabilities : [];
  const userPermissions = new Set((context.permissions || []).map((item) => String(item)));
  return capabilities.filter((capability) => {
    if (typeof capability === 'string') return true;
    if (!capability.permissions?.length) return true;
    return capability.permissions.some((permission) => userPermissions.has(permission));
  });
}

function getExecutionHistory(execution) {
  return [...(execution.timeline || [])];
}

function decideApproval(execution, approvalId, decision, payload = {}) {
  const approvals = [...(execution.approvals || [])];
  const index = approvals.findIndex((item) => item.id === approvalId);
  if (index < 0) throw new Error('approval not found');
  if (approvals[index].decision !== 'PENDING') throw new Error('approval already decided');
  approvals[index] = {
    ...approvals[index],
    decision,
    reason: payload.reason || null,
    decided_by: payload.decided_by || null,
    decidedAt: new Date().toISOString(),
  };
  const status = decision === 'APPROVED' ? 'ACTIVE' : 'CANCELLED';
  return appendTimeline({
    ...execution,
    status,
    pausedAt: null,
    approvals,
    history: [...execution.history, { stepId: execution.currentStepId, action: decision, approvalId, at: new Date().toISOString() }],
  }, `APPROVAL_${decision}`, { approvalId });
}

function approve(execution, approvalId, payload = {}) {
  return decideApproval(execution, approvalId, 'APPROVED', payload);
}

function reject(execution, approvalId, payload = {}) {
  return decideApproval(execution, approvalId, 'REJECTED', payload);
}

class CompanyIntelligenceRuntime {
  constructor(bundle, options = {}) {
    this.bundle = bundle;
    this.options = options;
    this.executions = {};
  }

  startProcess(processId, context = {}) {
    const execution = startProcess(this.bundle, processId, context);
    this.executions[execution.id] = execution;
    return execution;
  }

  resumeProcess(executionId) {
    const execution = resumeProcess(this.executions[executionId]);
    this.executions[executionId] = execution;
    return execution;
  }

  validateStep(executionId, payload = {}) {
    return validateStep(this.bundle, this.executions[executionId], payload);
  }

  completeStep(executionId, payload = {}) {
    const execution = completeStep(this.bundle, this.executions[executionId], { ...payload, providers: this.options.providers });
    this.executions[executionId] = execution;
    return execution;
  }

  branch(executionId, nextStepId) {
    const execution = branch(this.bundle, this.executions[executionId], nextStepId);
    this.executions[executionId] = execution;
    return execution;
  }

  rollback(executionId) {
    const execution = rollback(this.executions[executionId]);
    this.executions[executionId] = execution;
    return execution;
  }

  cancel(executionId) {
    const execution = cancel(this.executions[executionId]);
    this.executions[executionId] = execution;
    return execution;
  }

  executeCapability(executionId, capabilityId, payload = {}) {
    const execution = this.executions[executionId];
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    const executed = executeCapability(this.bundle, execution, capabilityId, {
      ...payload,
      providers: this.options.providers,
    });
    this.executions[executionId] = executed.execution;
    return executed.result;
  }

  listCapabilities(context = {}) {
    return listCapabilities(this.bundle, context);
  }

  getExecutionHistory(executionId) {
    return getExecutionHistory(this.executions[executionId]);
  }

  approve(executionId, approvalId, payload = {}) {
    const execution = approve(this.executions[executionId], approvalId, payload);
    this.executions[executionId] = execution;
    return execution;
  }

  reject(executionId, approvalId, payload = {}) {
    const execution = reject(this.executions[executionId], approvalId, payload);
    this.executions[executionId] = execution;
    return execution;
  }
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
  executeCapability,
  listCapabilities,
  getExecutionHistory,
  approve,
  reject,
  simulateProcess,
  CompanyIntelligenceRuntime,
};
