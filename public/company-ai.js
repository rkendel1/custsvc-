(function () {
  const script = document.currentScript;
  const bundleUrl = script?.dataset?.bundleUrl || '/bundles/company.intelligence.bundle.json';
  const apiBase = script?.dataset?.apiBase || '';
  const widgetTitle = script?.dataset?.title || 'Company Intelligence';
  const remoteFallbackUrl = script?.dataset?.remoteFallbackUrl || '';
  const aiModeSetting = String(script?.dataset?.aiMode || 'LOCAL').toUpperCase();
  const telemetryIncludeContent = String(script?.dataset?.telemetryIncludeContent || '').toLowerCase() === 'true';
  const minAnswerConfidence = Number(script?.dataset?.minAnswerConfidence || 0.1);
  const role = script?.dataset?.role || 'Customer';
  const department = script?.dataset?.department || '';
  const permissions = (script?.dataset?.permissions || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  const state = {
    bundle: null,
    history: [],
    executions: {},
    context: {
      role,
      department,
      permissions,
    },
    ai: {
      initialized: false,
      model: null,
      mode: aiModeSetting,
      modelStatus: {},
    },
  };
  const AI_MODE = {
    LOCAL: 'LOCAL',
    RETRIEVAL_ONLY: 'RETRIEVAL_ONLY',
    REMOTE_FALLBACK: 'REMOTE_FALLBACK',
    DISABLED: 'DISABLED',
  };
  // 4GB is the minimum threshold used by the runtime for selecting medium local models.
  const MIN_MEMORY_GB_FOR_MEDIUM_MODEL = 4;

  function normalizeAiMode(value) {
    const candidate = String(value || AI_MODE.LOCAL).toUpperCase();
    return AI_MODE[candidate] ? candidate : AI_MODE.LOCAL;
  }

  state.ai.mode = normalizeAiMode(state.ai.mode);
  const audiencePriority = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, EXECUTIVE: 3 };
  const confidenceWeights = {
    // Weighted toward retrieval relevance while still incorporating governance signals.
    semantic: 0.35,
    freshness: 0.2,
    agreement: 0.2,
    reviewer: 0.25,
  };
  const intentConfidence = {
    refund_request: 0.96,
    cancel_request: 0.9,
    billing_question: 0.86,
    general_question: 0.72,
  };

  function normalizeAudience(value) {
    const item = String(value || '').toUpperCase();
    if (item in audiencePriority) return item;
    return 'INTERNAL';
  }

  function normalizeStepType(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '_');
  }

  function roleAudiences(ctxRole, ctxPermissions = []) {
    const roleValue = String(ctxRole || 'Customer').toLowerCase();
    const perms = new Set((ctxPermissions || []).map((x) => String(x).toLowerCase()));
    const map = {
      customer: ['PUBLIC'],
      partner: ['PUBLIC', 'INTERNAL'],
      support: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
      sales: ['PUBLIC', 'INTERNAL'],
      engineering: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
      hr: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
      finance: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
      operations: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
      executive: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'EXECUTIVE'],
      administrator: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'EXECUTIVE'],
    };
    const allowed = new Set(map[roleValue] || ['PUBLIC']);
    if (perms.has('view:confidential')) allowed.add('CONFIDENTIAL');
    if (perms.has('view:executive')) allowed.add('EXECUTIVE');
    return allowed;
  }

  function getAudienceContext(context = state.context) {
    const roleValue = String(context.role || 'Customer').toLowerCase();
    if (roleValue === 'customer' || roleValue === 'partner') return 'customer';
    if (roleValue === 'executive' || roleValue === 'administrator') return 'executive';
    if (roleValue === 'manager') return 'manager';
    return 'employee';
  }

  function getStorageProfile(bundle = state.bundle) {
    if (bundle?.storage_profile && Array.isArray(bundle.storage_profile.stores)) return bundle.storage_profile;
    return {
      mode: 'browser-local',
      stores: [{ id: 'public', type: 'browser-local', audiences: ['customer'] }],
    };
  }

  function hasStorePermission(store, context = state.context) {
    const required = Array.isArray(store?.permissions) ? store.permissions : [];
    if (!required.length) return true;
    const available = new Set((context.permissions || []).map((item) => String(item).toLowerCase()));
    return required.every((item) => available.has(String(item).toLowerCase()));
  }

  function storeSupportsAudience(store, audience) {
    const audiences = Array.isArray(store?.audiences) ? store.audiences : [];
    if (!audiences.length) return true;
    return audiences.map((item) => String(item).toLowerCase()).includes(String(audience).toLowerCase());
  }

  function getKnowledgeSource(chunk, bundle = state.bundle) {
    const profile = getStorageProfile(bundle);
    const chunkAudience = normalizeAudience(chunk?.audience || chunk?.visibility).toLowerCase();
    const mapped = profile.stores.find((store) => {
      const audiences = Array.isArray(store?.audiences) ? store.audiences : [];
      if (!audiences.length) return false;
      return audiences.map((item) => String(item).toLowerCase()).includes(chunkAudience);
    });
    return mapped || profile.stores[0] || { id: 'public', type: 'browser-local', audiences: ['customer'] };
  }

  function simpleHash(value) {
    let hash = 0;
    const input = String(value || '');
    for (let i = 0; i < input.length; i += 1) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }

  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  function termFrequency(tokens) {
    const tf = {};
    for (const token of tokens) {
      tf[token] = (tf[token] || 0) + 1;
    }
    return tf;
  }

  function magnitude(tf) {
    let sum = 0;
    for (const value of Object.values(tf)) sum += value * value;
    return Math.sqrt(sum);
  }

  function similarity(queryTf, queryMag, chunk) {
    if (!queryMag || !chunk.magnitude) return 0;
    let dot = 0;
    for (const [token, count] of Object.entries(queryTf)) {
      if (chunk.tf[token]) dot += count * chunk.tf[token];
    }
    return dot / (queryMag * chunk.magnitude);
  }

  function isVisible(chunk, context) {
    const allowedAudiences = roleAudiences(context.role, context.permissions);
    const chunkAudience = normalizeAudience(chunk.audience || chunk.visibility);
    if (!allowedAudiences.has(chunkAudience)) return false;
    const chunkDepartment = String(chunk.department || '').toLowerCase();
    const userDepartment = String(context.department || '').toLowerCase();
    if (!chunkDepartment || !userDepartment || chunkDepartment === userDepartment) return true;
    return (context.permissions || []).map((x) => String(x).toLowerCase()).includes('cross_department');
  }

  function freshnessScore(chunk) {
    const reviewedAt = new Date(chunk.last_reviewed || 0).getTime();
    const reviewFrequency = Number(chunk.review_frequency || 90);
    if (!reviewedAt || !Number.isFinite(reviewFrequency) || reviewFrequency <= 0) return 0.5;
    const ageDays = (Date.now() - reviewedAt) / (24 * 60 * 60 * 1000);
    return Math.max(0, Math.min(1, 1 - ageDays / reviewFrequency));
  }

  function relationshipAgreement(best, bundle) {
    const adjacency = bundle?.graph?.adjacency?.[best.knowledgeId] || [];
    if (!adjacency.length) return 0.5;
    let positive = 0;
    let negative = 0;
    for (const edge of adjacency) {
      if (edge.type === 'SUPPORTS' || edge.type === 'RELATED' || edge.type === 'IMPLEMENTS') positive += 1;
      if (edge.type === 'CONTRADICTS' || edge.type === 'DUPLICATE_OF') negative += 1;
    }
    return Math.max(0, Math.min(1, (positive + 1) / (positive + negative + 1)));
  }

  async function loadBundle() {
    if (state.bundle) return state.bundle;

    const cacheScope = `${window.location.origin}:${bundleUrl}`;
    const cacheKey = `company-intelligence:${simpleHash(cacheScope)}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        state.bundle = JSON.parse(cached);
      } catch (_e) {
        // ignore bad cache
      }
    }

    if (!state.bundle) {
      const response = await fetch(bundleUrl);
      if (!response.ok) throw new Error(`Could not load bundle (${response.status})`);
      state.bundle = await response.json();
      localStorage.setItem(cacheKey, JSON.stringify(state.bundle));
    }

    return state.bundle;
  }

  async function remoteFallback(question) {
    if (!remoteFallbackUrl) return null;
    try {
      const response = await fetch(remoteFallbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!data?.answer) return null;
      return { answer: data.answer, score: Number(data.score || 0), topChunkId: null };
    } catch (_e) {
      return null;
    }
  }

  function getProcess(bundle, processId) {
    return (bundle?.processes || []).find((item) => item.id === processId) || null;
  }

  async function startProcess(processId, context = {}) {
    const bundle = await loadBundle();
    const process = getProcess(bundle, processId);
    if (!process) throw new Error('process not found');
    if (!process.steps?.length) throw new Error('process has no steps');
    const executionId = `${processId}:${Date.now()}`;
    const execution = {
      id: executionId,
      processId,
      status: 'ACTIVE',
      context,
      currentStepId: process.steps[0].id,
      history: [],
      startedAt: new Date().toISOString(),
    };
    state.executions[executionId] = execution;
    return execution;
  }

  function resumeProcess(executionId) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error('execution not found');
    if (execution.status === 'CANCELLED') throw new Error('process is cancelled');
    if (execution.status === 'COMPLETED') throw new Error('process is completed');
    execution.status = 'ACTIVE';
    return execution;
  }

  async function validateStep(executionId, payload = {}) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error('execution not found');
    const bundle = await loadBundle();
    const process = getProcess(bundle, execution.processId);
    const current = (process?.steps || []).find((step) => step.id === execution.currentStepId);
    if (!current) return { ok: false, reason: 'step not found' };
    if (current.required_capability && !(payload.capabilities || []).includes(current.required_capability)) {
      return { ok: false, reason: `missing capability: ${current.required_capability}` };
    }
    return { ok: true };
  }

  async function completeStep(executionId, payload = {}) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error('execution not found');
    const validation = await validateStep(executionId, payload);
    if (!validation.ok) throw new Error(validation.reason);
    const bundle = await loadBundle();
    const process = getProcess(bundle, execution.processId);
    const current = (process?.steps || []).find((step) => step.id === execution.currentStepId);
    const nextStepId = current?.next?.[0] || null;
    execution.history.push({ stepId: execution.currentStepId, action: 'COMPLETE', at: new Date().toISOString() });
    if (!nextStepId || normalizeStepType(current?.type) === 'FINISH') {
      execution.status = 'COMPLETED';
      execution.completedAt = new Date().toISOString();
      return execution;
    }
    execution.currentStepId = nextStepId;
    return execution;
  }

  async function branch(executionId, nextStepId) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error('execution not found');
    const bundle = await loadBundle();
    const process = getProcess(bundle, execution.processId);
    const current = (process?.steps || []).find((step) => step.id === execution.currentStepId);
    if (!current?.next?.includes(nextStepId)) throw new Error('invalid branch target');
    execution.history.push({ stepId: execution.currentStepId, action: 'BRANCH', at: new Date().toISOString() });
    execution.currentStepId = nextStepId;
    return execution;
  }

  function rollback(executionId) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error('execution not found');
    const history = [...execution.history];
    const previous = history.pop();
    if (!previous) return execution;
    execution.history = history;
    execution.status = 'ACTIVE';
    execution.currentStepId = previous.stepId;
    execution.completedAt = null;
    return execution;
  }

  function cancel(executionId) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error('execution not found');
    execution.status = 'CANCELLED';
    execution.cancelledAt = new Date().toISOString();
    return execution;
  }

  function detectIntent(question) {
    const q = String(question || '').toLowerCase();
    if (q.includes('refund')) return { intent: 'refund_request', confidence: intentConfidence.refund_request };
    if (q.includes('cancel')) return { intent: 'cancel_request', confidence: intentConfidence.cancel_request };
    if (q.includes('billing') || q.includes('invoice')) {
      return { intent: 'billing_question', confidence: intentConfidence.billing_question };
    }
    return { intent: 'general_question', confidence: intentConfidence.general_question };
  }

  function initializeAiIfNeeded(bundle) {
    if (state.ai.initialized) return;
    state.ai.model = (bundle?.models || []).find((item) => item.runtime === 'wasm' && item.type === 'llm') || null;
    state.ai.mode = normalizeAiMode(state.ai.mode);
    state.ai.initialized = true;
  }

  function detectAICompatibility() {
    return {
      wasm: typeof WebAssembly !== 'undefined',
      wasm_simd: true,
      webgpu: Boolean(navigator.gpu),
      memory_available_mb: Math.round(Number(navigator.deviceMemory || 4) * 1024),
      recommended_model: Number(navigator.deviceMemory || 4) >= MIN_MEMORY_GB_FOR_MEDIUM_MODEL
        ? 'company-assistant-medium'
        : 'company-assistant-small',
    };
  }

  async function initializeAI() {
    const bundle = await loadBundle();
    initializeAiIfNeeded(bundle);
    if (!state.ai.model) state.ai.mode = AI_MODE.RETRIEVAL_ONLY;
    if (state.ai.mode === AI_MODE.DISABLED) state.ai.model = null;
    return getAIStatus();
  }

  async function downloadModel(modelId) {
    await initializeAI();
    const id = modelId || state.ai.model?.id;
    if (!id) throw new Error('model not found');
    state.ai.modelStatus[id] = { id, downloaded: true, initialized: true };
    return state.ai.model || { id };
  }

  function getModels() {
    return state.bundle?.models || [];
  }

  function removeModel(modelId) {
    const id = modelId || state.ai.model?.id;
    if (!id) return { removed: false };
    state.ai.modelStatus[id] = null;
    if (state.ai.model?.id === id) state.ai.model = null;
    return { removed: true, id };
  }

  function getAIStatus() {
    return {
      initialized: Boolean(state.ai.initialized),
      mode: state.ai.mode,
      model: state.ai.model,
      compatibility: detectAICompatibility(),
    };
  }

  async function generate(input = {}) {
    const result = await answerQuestion(input.question || '');
    return { ...result, mode: state.ai.model ? 'local-llm' : 'retrieval-only' };
  }

  function embed(text = '') {
    return tokenize(text).map((token) => token.length / 20);
  }

  function classify(text = '') {
    return detectIntent(text);
  }

  function extract(text = '') {
    const input = String(text);
    return {
      email: input.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0] || null,
    };
  }

  async function search(question, options = {}) {
    const bundle = await loadBundle();
    const queryTokens = tokenize(question);
    const queryTf = termFrequency(queryTokens);
    const queryMag = magnitude(queryTf);
    const profile = getStorageProfile(bundle);
    const audience = getAudienceContext(options.context || state.context);
    const stores = (profile.stores || []).filter((store) => {
      const context = options.context || state.context;
      return storeSupportsAudience(store, audience) && hasStorePermission(store, context);
    });
    const allowedStoreIds = new Set(stores.map((store) => store.id));

    const results = [];
    for (const chunk of bundle.chunks || []) {
      if (!isVisible(chunk, options.context || state.context)) continue;
      const source = getKnowledgeSource(chunk, bundle);
      if (allowedStoreIds.size && !allowedStoreIds.has(source.id)) continue;
      const score = similarity(queryTf, queryMag, chunk);
      if (score <= 0) continue;
      results.push({ chunk, score, source });
    }
    results.sort((a, b) => b.score - a.score);
    const limit = Number(options.limit || 5);
    return results.slice(0, limit);
  }

  async function answerQuestion(question) {
    const bundle = await loadBundle();
    initializeAiIfNeeded(bundle);
    const intentResult = detectIntent(question);
    const results = await search(question, { limit: 5 });
    const best = results[0] || null;

    if (best && best.score >= minAnswerConfidence) {
      const fresh = freshnessScore(best.chunk);
      const agreement = relationshipAgreement(best.chunk, bundle);
      const reviewerConfidence = Number(best.chunk.confidence || 0.7);
      const confidence = Number((
        best.score * confidenceWeights.semantic +
        fresh * confidenceWeights.freshness +
        agreement * confidenceWeights.agreement +
        reviewerConfidence * confidenceWeights.reviewer
      ).toFixed(3));
      return {
        answer: best.chunk.text,
        score: best.score,
        confidence,
        confidenceBreakdown: {
          semantic: Number(best.score.toFixed(3)),
          freshness: Number(fresh.toFixed(3)),
          agreement: Number(agreement.toFixed(3)),
          reviewer: Number(reviewerConfidence.toFixed(3)),
        },
        intent: intentResult.intent,
        process_started: false,
        topChunkId: best.chunk.id,
        sourceStoreId: best.source.id,
        sourceStoreType: best.source.type,
        answered: true,
      };
    }

    const fallback = await remoteFallback(question);
    if (fallback) return { ...fallback, answered: true, intent: intentResult.intent, process_started: false };

    return {
      answer: "I don't have an answer for that yet.",
      score: best ? best.score : 0,
      confidence: best ? Number(best.score.toFixed(3)) : 0,
      intent: intentResult.intent,
      process_started: false,
      topChunkId: best?.chunk?.id || null,
      answered: false,
    };
  }

  async function sendTelemetry(entry) {
    try {
      await fetch(`${apiBase}/api/telemetry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry),
      });
    } catch (_e) {
      // no-op
    }
  }

  function appendMessage(container, who, text) {
    const node = document.createElement('div');
    node.style.margin = '0.5rem 0';
    const label = document.createElement('strong');
    label.textContent = `${who}: `;
    node.appendChild(label);
    node.appendChild(document.createTextNode(text));
    container.appendChild(node);
    container.scrollTop = container.scrollHeight;
  }

  function createWidget() {
    const button = document.createElement('button');
    button.textContent = 'Ask';
    Object.assign(button.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      border: 'none',
      borderRadius: '999px',
      background: '#111827',
      color: '#fff',
      padding: '0.7rem 1rem',
      cursor: 'pointer',
      zIndex: 99999,
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      right: '20px',
      bottom: '70px',
      width: '360px',
      height: '460px',
      background: '#fff',
      border: '1px solid #d1d5db',
      borderRadius: '12px',
      boxShadow: '0 12px 30px rgba(0,0,0,0.18)',
      display: 'none',
      zIndex: 99999,
      overflow: 'hidden',
      fontFamily: 'Arial, sans-serif',
    });

    const header = document.createElement('div');
    header.textContent = widgetTitle;
    Object.assign(header.style, {
      background: '#111827',
      color: '#fff',
      padding: '0.65rem 0.8rem',
      fontWeight: 'bold',
    });

    const messages = document.createElement('div');
    Object.assign(messages.style, {
      height: '330px',
      overflowY: 'auto',
      padding: '0.8rem',
      background: '#f9fafb',
      fontSize: '14px',
    });

    const inputWrap = document.createElement('div');
    Object.assign(inputWrap.style, {
      display: 'flex',
      gap: '0.4rem',
      borderTop: '1px solid #e5e7eb',
      padding: '0.6rem',
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Ask a question...';
    Object.assign(input.style, {
      flex: 1,
      padding: '0.45rem',
      border: '1px solid #d1d5db',
      borderRadius: '8px',
    });

    const send = document.createElement('button');
    send.textContent = 'Send';
    Object.assign(send.style, {
      padding: '0.45rem 0.75rem',
      border: 'none',
      borderRadius: '8px',
      background: '#2563eb',
      color: '#fff',
      cursor: 'pointer',
    });

    async function onSend() {
      const question = input.value.trim();
      if (!question) return;
      const startedAt = Date.now();
      input.value = '';
      appendMessage(messages, 'You', question);

      try {
        const response = await answerQuestion(question);
        appendMessage(messages, 'AI', response.answer);

        const answered = response.answered;
        state.history.push({ question, ...response, answered, at: new Date().toISOString() });

        const telemetryPayload = {
          intent: response.intent || 'general_question',
          answered,
          score: response.score,
          confidence: response.confidence || 0,
          knowledge_gap: !answered,
          process_started: Boolean(response.process_started),
          duration: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
          topChunkId: response.topChunkId,
          role: state.context.role,
          department: state.context.department,
          permissions: state.context.permissions,
          includeContent: telemetryIncludeContent,
          ...(telemetryIncludeContent ? { question } : {}),
        };
        sendTelemetry(telemetryPayload);
      } catch (error) {
        appendMessage(messages, 'AI', `Unable to answer right now: ${error.message}`);
      }
    }

    send.addEventListener('click', onSend);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') onSend();
    });

    inputWrap.appendChild(input);
    inputWrap.appendChild(send);
    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(inputWrap);

    button.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      if (panel.style.display === 'block' && !messages.dataset.welcome) {
        appendMessage(messages, 'AI', 'Hi! Ask me anything about this company.');
        messages.dataset.welcome = 'true';
      }
    });

    document.body.appendChild(button);
    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createWidget);
  } else {
    createWidget();
  }

  window.CompanyIntelligenceRuntime = {
    askQuestion: answerQuestion,
    getStorageStatus: async () => {
      const bundle = await loadBundle();
      const profile = getStorageProfile(bundle);
      const audience = getAudienceContext();
      return {
        mode: profile.mode,
        audience,
        stores: profile.stores.map((store) => ({
          ...store,
          allowed: hasStorePermission(store),
          active: storeSupportsAudience(store, audience),
        })),
      };
    },
    getAudienceContext: () => ({
      audience: getAudienceContext(),
      role: state.context.role,
      department: state.context.department,
      permissions: state.context.permissions,
    }),
    search,
    getKnowledgeSource,
    getAIStatus,
    downloadModel,
    initializeAI,
    generate,
    embed,
    classify,
    extract,
    getModels,
    removeModel,
    startProcess,
    resumeProcess,
    completeStep,
    validateStep,
    branch,
    rollback,
    cancel,
  };
})();
