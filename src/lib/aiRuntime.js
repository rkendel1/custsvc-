const DEFAULT_ALLOWED_ACTIONS = ['start_process', 'retrieve_policy', 'ask_question'];
const INTENT_CONFIDENCE = {
  refund_request: 0.96,
  cancel_request: 0.9,
  billing_question: 0.86,
  general_question: 0.72,
};
const MIN_LOCAL_CONFIDENCE = 0.3;
const LOCAL_CONFIDENCE_ADJUSTMENT = 0.03;

function detectBackend(preferredBackend) {
  const preferred = String(preferredBackend || '').toLowerCase();
  if (preferred) return preferred;
  if (typeof navigator !== 'undefined' && navigator.gpu) return 'webgpu';
  return 'wasm-simd';
}

function inferIntent(question) {
  const q = String(question || '').toLowerCase();
  if (q.includes('refund')) return { intent: 'refund_request', confidence: INTENT_CONFIDENCE.refund_request };
  if (q.includes('cancel')) return { intent: 'cancel_request', confidence: INTENT_CONFIDENCE.cancel_request };
  if (q.includes('billing') || q.includes('invoice')) {
    return { intent: 'billing_question', confidence: INTENT_CONFIDENCE.billing_question };
  }
  return { intent: 'general_question', confidence: INTENT_CONFIDENCE.general_question };
}

function extractFields(text) {
  const input = String(text || '');
  // Lightweight extraction for local runtime hints (not strict RFC email validation).
  const email = input.match(/[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/i)?.[0] || null;
  const amount = input.match(/amount[\s:]*([\$]\d+(?:\.\d{2})?)/i)?.[1]
    || input.match(/([\$]\d+(?:\.\d{2})?)/)?.[1]
    || null;
  const orderId = input.match(/(?:order|ticket|case)[\s#:.-]*([a-z0-9-]{4,})/i)?.[1] || null;
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
      // Keep generation confidence slightly conservative relative to classifier confidence.
      confidence: Number(Math.max(MIN_LOCAL_CONFIDENCE, intent.confidence - LOCAL_CONFIDENCE_ADJUSTMENT).toFixed(3)),
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
