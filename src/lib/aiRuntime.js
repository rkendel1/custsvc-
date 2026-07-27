const { createModelManager } = require('./modelManager');
const { createWasmAiEngine } = require('./wasmAiEngine');

const DEFAULT_ALLOWED_ACTIONS = ['start_process', 'retrieve_policy', 'ask_question', 'complete_step'];
const AI_MODES = {
  LOCAL: 'LOCAL',
  RETRIEVAL_ONLY: 'RETRIEVAL_ONLY',
  REMOTE_FALLBACK: 'REMOTE_FALLBACK',
  DISABLED: 'DISABLED',
};
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

function detectAICompatibility() {
  const hasNavigator = typeof navigator !== 'undefined';
  const memoryGb = hasNavigator && Number(navigator.deviceMemory) > 0 ? Number(navigator.deviceMemory) : 4;
  const memoryMb = Math.round(memoryGb * 1024);
  const webgpu = hasNavigator && Boolean(navigator.gpu);
  return {
    wasm: typeof WebAssembly !== 'undefined',
    wasm_simd: true,
    webgpu,
    memory_available_mb: memoryMb,
    recommended_model: memoryMb >= 4096 ? 'company-assistant-medium' : 'company-assistant-small',
  };
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
  const email = input.match(/[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/i)?.[0] || null;
  const amount = input.match(/amount[\s:]*([\$]\d+(?:\.\d{2})?)/i)?.[1]
    || input.match(/([\$]\d+(?:\.\d{2})?)/)?.[1]
    || null;
  const orderId = input.match(/(?:order|ticket|case)[\s#:.-]*([a-z0-9-]{4,})/i)?.[1] || null;
  return { email, amount, orderId };
}

function normalizeMode(value, fallback = AI_MODES.LOCAL) {
  const candidate = String(value || fallback).toUpperCase();
  return AI_MODES[candidate] || fallback;
}

function canRunLocally(model, compatibility) {
  if (!model) return false;
  if (!compatibility.wasm) return false;
  const requiredMemory = Number(model?.requirements?.memory_mb || 0);
  if (requiredMemory && requiredMemory > Number(compatibility.memory_available_mb || 0)) return false;
  if (model?.requirements?.wasm_simd && !compatibility.wasm_simd) return false;
  if (model?.requirements?.webgpu_required && !compatibility.webgpu) return false;
  return true;
}

function pickBestModel(models = [], compatibility = detectAICompatibility(), preferredModelId = null) {
  if (!Array.isArray(models) || !models.length) return null;
  if (preferredModelId) return models.find((item) => item.id === preferredModelId) || null;
  const localModels = models.filter((item) => item.type === 'llm' && item.runtime === 'wasm');
  const compatible = localModels.filter((item) => canRunLocally(item, compatibility));
  if (!compatible.length) return null;
  const sorted = [...compatible].sort((a, b) => Number(a?.requirements?.memory_mb || 0) - Number(b?.requirements?.memory_mb || 0));
  if (compatibility.memory_available_mb >= 4096) return sorted[sorted.length - 1];
  return sorted[0];
}

function createAIRuntime(options = {}) {
  const allowedActions = Array.isArray(options.allowedActions) && options.allowedActions.length
    ? options.allowedActions.map((item) => String(item))
    : [...DEFAULT_ALLOWED_ACTIONS];
  const modelManager = options.modelManager || createModelManager();
  const engine = options.engine || createWasmAiEngine();
  const state = {
    initialized: false,
    backend: detectBackend(options.preferredBackend),
    model: null,
    bundle: null,
    capabilities: new Set(),
    mode: normalizeMode(options.mode, AI_MODES.LOCAL),
    compatibility: detectAICompatibility(),
  };

  async function loadModel(bundle = {}, preferredModelId = null) {
    state.bundle = bundle || {};
    const models = Array.isArray(bundle?.models) ? bundle.models : [];
    state.model = pickBestModel(models, state.compatibility, preferredModelId);
    return state.model;
  }

  async function initialize(bundle = {}, runtimeOptions = {}) {
    state.backend = detectBackend(runtimeOptions.preferredBackend || options.preferredBackend);
    state.compatibility = detectAICompatibility();
    state.mode = normalizeMode(runtimeOptions.mode || options.mode, AI_MODES.LOCAL);
    modelManager.discoverModels(bundle);
    await loadModel(bundle, runtimeOptions.modelId || null);
    if (state.mode === AI_MODES.DISABLED) {
      state.initialized = true;
      state.capabilities = new Set(['disabled']);
      return getAIStatus();
    }

    const localReady = canRunLocally(state.model, state.compatibility);
    if (state.mode === AI_MODES.LOCAL && localReady && state.model) {
      await modelManager.downloadModel(state.model.id);
      await modelManager.verifyModel(state.model.id);
      await modelManager.initializeModel(state.model.id);
      await engine.initialize(state.model);
    } else if (state.mode === AI_MODES.LOCAL && !localReady) {
      state.mode = AI_MODES.RETRIEVAL_ONLY;
    }

    if (state.mode === AI_MODES.REMOTE_FALLBACK && !state.model) state.mode = AI_MODES.RETRIEVAL_ONLY;
    state.initialized = true;
    state.capabilities = new Set([state.backend]);
    if (state.model && state.mode === AI_MODES.LOCAL) state.capabilities.add('local-inference');
    return getAIStatus();
  }

  async function initializeAI(bundle = {}, runtimeOptions = {}) {
    return initialize(bundle, runtimeOptions);
  }

  function ensureInitialized() {
    if (!state.initialized) throw new Error('AI runtime not initialized');
  }

  function getModels() {
    return Array.isArray(state.bundle?.models) ? state.bundle.models : [];
  }

  async function downloadModel(modelId) {
    ensureInitialized();
    const target = modelId || state.model?.id;
    if (!target) throw new Error('model not found');
    return modelManager.downloadModel(target, state.bundle);
  }

  function removeModel(modelId) {
    ensureInitialized();
    const target = modelId || state.model?.id;
    if (!target) throw new Error('model not found');
    const removed = modelManager.removeModel(target);
    if (state.model?.id === target) state.model = null;
    return removed;
  }

  function getAIStatus() {
    return {
      initialized: state.initialized,
      backend: state.backend,
      model: state.model,
      tier: state.model ? 1 : 0,
      offlineReady: state.mode === AI_MODES.LOCAL && Boolean(state.model),
      mode: state.mode,
      compatibility: state.compatibility,
      capabilities: [...state.capabilities],
    };
  }

  async function generate({ question = '', context = [] } = {}) {
    ensureInitialized();
    const content = Array.isArray(context) ? context : [];
    const top = content[0] || null;
    if (state.mode === AI_MODES.DISABLED) {
      return {
        answer: 'AI is disabled for this runtime.',
        confidence: 0,
        mode: 'disabled',
      };
    }
    if (!state.model || state.mode !== AI_MODES.LOCAL) {
      return {
        answer: top?.text || "I don't have an answer for that yet.",
        confidence: top ? 0.6 : 0.15,
        mode: 'retrieval-only',
      };
    }
    const intent = inferIntent(question);
    const generated = await engine.generate({ prompt: question, context: content });
    return {
      answer: generated.text || top?.text || `Intent detected: ${intent.intent}`,
      confidence: Number(Math.max(MIN_LOCAL_CONFIDENCE, intent.confidence - LOCAL_CONFIDENCE_ADJUSTMENT).toFixed(3)),
      mode: 'local-llm',
      intent: intent.intent,
    };
  }

  async function embed(text) {
    ensureInitialized();
    if (!state.model || state.mode !== AI_MODES.LOCAL) {
      const tokens = String(text || '').toLowerCase().split(/\W+/).filter(Boolean);
      return tokens.map((token) => token.length / 20);
    }
    return engine.embed(text);
  }

  async function classify(input) {
    ensureInitialized();
    if (!state.model || state.mode !== AI_MODES.LOCAL) return inferIntent(input);
    return engine.classify(input);
  }

  async function extract(input) {
    ensureInitialized();
    if (!state.model || state.mode !== AI_MODES.LOCAL) return extractFields(input);
    const extracted = await engine.extract(input);
    return { ...extractFields(input), ...(extracted || {}) };
  }

  async function* stream({ question = '', context = [] } = {}) {
    if (state.model && state.mode === AI_MODES.LOCAL) {
      for await (const token of engine.stream({ prompt: question, context })) yield token;
      return;
    }
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

  function buildTelemetry(telemetryData = {}, options = {}) {
    const { intent, confidence, knowledgeGap = false, processStarted = false, duration = 0 } = telemetryData;
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
    initializeAI,
    getAIStatus,
    getModels,
    downloadModel,
    removeModel,
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
  AI_MODES,
  createAIRuntime,
  detectBackend,
  detectAICompatibility,
};
