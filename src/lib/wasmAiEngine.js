function createDefaultAdapter() {
  return {
    async initialize(model) {
      return { ready: true, modelId: model?.id || null };
    },
    async generate({ prompt = '', context = [] } = {}) {
      const first = Array.isArray(context) ? context[0] : null;
      return { text: first?.text || String(prompt || '') };
    },
    async embed(text) {
      return String(text || '').split(/\W+/).filter(Boolean).map((token) => token.length / 20);
    },
    async classify(text) {
      const q = String(text || '').toLowerCase();
      if (q.includes('refund')) return { label: 'refund_request', confidence: 0.96 };
      if (q.includes('billing') || q.includes('invoice')) return { label: 'billing_question', confidence: 0.86 };
      return { label: 'general_question', confidence: 0.72 };
    },
    async extract(text) {
      const input = String(text || '');
      return {
        email: input.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0] || null,
      };
    },
    async dispose() {
      return { disposed: true };
    },
  };
}

function createWasmAiEngine(options = {}) {
  const adapter = options.adapter || createDefaultAdapter();
  const state = {
    initialized: false,
    model: null,
  };

  function ensureInitialized() {
    if (!state.initialized) throw new Error('WASM AI engine not initialized');
  }

  async function initialize(model) {
    const result = await adapter.initialize(model);
    state.model = model || null;
    state.initialized = true;
    return { initialized: true, ...result };
  }

  async function generate(input = {}) {
    ensureInitialized();
    const result = await adapter.generate(input);
    return { text: String(result?.text || '') };
  }

  async function embed(text) {
    ensureInitialized();
    return adapter.embed(text);
  }

  async function classify(text) {
    ensureInitialized();
    const result = await adapter.classify(text);
    return {
      intent: result?.intent || result?.label || 'general_question',
      confidence: Number(result?.confidence || 0),
    };
  }

  async function extract(text) {
    ensureInitialized();
    return adapter.extract(text);
  }

  async function* stream(input = {}) {
    const generated = await generate(input);
    const words = generated.text.split(/\s+/).filter(Boolean);
    for (const word of words) yield `${word} `;
  }

  async function dispose() {
    await adapter.dispose();
    state.initialized = false;
    state.model = null;
    return { disposed: true };
  }

  return {
    initialize,
    generate,
    embed,
    classify,
    extract,
    stream,
    dispose,
  };
}

module.exports = {
  createWasmAiEngine,
};
