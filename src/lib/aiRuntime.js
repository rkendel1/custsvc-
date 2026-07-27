const DEFAULT_ALLOWED_ACTIONS = ['start_process', 'retrieve_policy', 'ask_question'];

function detectBackend(preferredBackend) {
  const preferred = String(preferredBackend || '').toLowerCase();
  if (preferred) return preferred;
  if (typeof navigator !== 'undefined' && navigator.gpu) return 'webgpu';
  return 'wasm-simd';
}

function inferIntent(question) {
  const q = String(question || '').toLowerCase();
  if (q.includes('refund')) return { intent: 'refund_request', confidence: 0.96 };
  if (q.includes('cancel')) return { intent: 'cancel_request', confidence: 0.9 };
  if (q.includes('billing') || q.includes('invoice')) return { intent: 'billing_question', confidence: 0.86 };
  return { intent: 'general_question', confidence: 0.72 };
}

function extractFields(text) {
  const input = String(text || '');
  const email = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null;
  const amount = input.match(/amount[\s:]*([\$]\d+(?:\.\d{2})?)/i)?.[1]
    || input.match(/([\$]\d+(?:\.\d{2})?)/)?.[1]
    || null;
  const orderId = input.match(/\b(?:order|ticket|case)[\s#:.-]*([a-z0-9-]{4,})/i)?.[1] || null;
  return { email, amount, orderId };
}

function createAIRuntime(options = {}) {
  const allowedActions = Array.isArray(options.allowedActions) && options.allowedActions.length
    ? options.allowedActions.map((item) => String(item))
    : [...DEFAULT_ALLOWED_ACTIONS];
  const state = {
    initialized: false,
    backend: detectBackend(options.preferredBackend),
    model: null,
    bundle: null,
    capabilities: new Set(),
  };

  async function loadModel(bundle = {}, preferredModelId = null) {
    state.bundle = bundle || {};
    const models = Array.isArray(bundle?.models) ? bundle.models : [];
    const pick = preferredModelId
      ? models.find((item) => item.id === preferredModelId)
      : models.find((item) => item.type === 'llm' && item.runtime === 'wasm');
    state.model = pick || null;
    return state.model;
  }

  async function initialize(bundle = {}, runtimeOptions = {}) {
    state.backend = detectBackend(runtimeOptions.preferredBackend || options.preferredBackend);
    await loadModel(bundle, runtimeOptions.modelId || null);
    state.initialized = true;
    state.capabilities = new Set([state.backend]);
    if (state.model) state.capabilities.add('local-inference');
    return {
      initialized: true,
      backend: state.backend,
      model: state.model,
      tier: state.model ? 1 : 0,
      offlineReady: true,
    };
  }

  function ensureInitialized() {
    if (!state.initialized) throw new Error('AI runtime not initialized');
  }

  async function generate({ question = '', context = [] } = {}) {
    ensureInitialized();
    const content = Array.isArray(context) ? context : [];
    const top = content[0] || null;
    if (!state.model) {
      return {
        answer: top?.text || "I don't have an answer for that yet.",
        confidence: top ? 0.6 : 0.15,
        mode: 'retrieval-only',
      };
    }
    const intent = inferIntent(question);
    return {
      answer: top?.text || `Intent detected: ${intent.intent}`,
      confidence: Number(Math.max(0.3, intent.confidence - 0.03).toFixed(3)),
      mode: 'local-llm',
      intent: intent.intent,
    };
  }

  async function embed(text) {
    ensureInitialized();
    const tokens = String(text || '').toLowerCase().split(/\W+/).filter(Boolean);
    return tokens.map((token) => token.length / 20);
  }

  async function classify(input) {
    ensureInitialized();
    return inferIntent(input);
  }

  async function extract(input) {
    ensureInitialized();
    return extractFields(input);
  }

  async function* stream({ question = '', context = [] } = {}) {
    const response = await generate({ question, context });
    const words = String(response.answer || '').split(/\s+/).filter(Boolean);
    for (const word of words) {
      yield `${word} `;
    }
  }

  function allowed(action) {
    return allowedActions.includes(String(action || ''));
  }

  async function runAction(action, payload = {}) {
    ensureInitialized();
    if (!allowed(action)) throw new Error('action not permitted');
    return { action, payload, ok: true };
  }

  function buildTelemetry({ intent, confidence, knowledgeGap = false, processStarted = false, duration = 0 }, options = {}) {
    const entry = {
      intent: String(intent || 'general_question'),
      confidence: Number(confidence || 0),
      knowledge_gap: Boolean(knowledgeGap),
      process_started: Boolean(processStarted),
      duration: Number(duration || 0),
    };
    if (options.includeContent && options.question) entry.question = String(options.question);
    return entry;
  }

  return {
    loadModel,
    initialize,
    generate,
    embed,
    classify,
    extract,
    stream,
    runAction,
    buildTelemetry,
  };
}

module.exports = {
  createAIRuntime,
  detectBackend,
};
