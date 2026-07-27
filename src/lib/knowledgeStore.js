class KnowledgeStore {
  async initialize() { return true; }

  async search() { return []; }

  async get() { return null; }

  async insert() { throw new Error('insert not implemented'); }

  async update() { throw new Error('update not implemented'); }

  async delete() { return false; }

  /**
   * Returns a deterministic fallback embedding as normalized token lengths.
   * This is intended for local development/testing; production providers should override with real embeddings.
   */
  async embed(text = '') {
    return String(text || '')
      .toLowerCase()
      .split(/\W+/)
      .filter(Boolean)
      .map((token) => token.length / 20);
  }

  async graph() { return { nodes: [], edges: [] }; }

  async permissions() { return { allowed: true, reason: null }; }

  async health() { return { ok: true }; }
}

class BrowserLocalKnowledgeStore extends KnowledgeStore {
  constructor(options = {}) {
    super();
    this.id = options.id || 'browser-local';
    this.audiences = Array.isArray(options.audiences) ? options.audiences : ['customer'];
    this.records = new Map();
  }

  async initialize() {
    return { ok: true, provider: 'browser-local' };
  }

  async search(query = '') {
    const tokens = String(query || '').toLowerCase().split(/\W+/).filter(Boolean);
    const results = [];
    for (const record of this.records.values()) {
      const text = String(record.text || '').toLowerCase();
      const score = tokens.reduce((sum, token) => (text.includes(token) ? sum + 1 : sum), 0);
      if (score > 0) results.push({ ...record, score, source: this.id });
    }
    return results.sort((a, b) => b.score - a.score);
  }

  async get(id) {
    return this.records.get(id) || null;
  }

  async insert(record = {}) {
    const id = String(record.id || `record-${this.records.size + 1}`);
    const value = { ...record, id };
    this.records.set(id, value);
    return value;
  }

  async update(id, updates = {}) {
    const current = this.records.get(id);
    if (!current) return null;
    const merged = { ...current, ...updates, id };
    this.records.set(id, merged);
    return merged;
  }

  async delete(id) {
    return this.records.delete(id);
  }
}

class ManagedCloudKnowledgeStore extends KnowledgeStore {
  constructor(options = {}) {
    super();
    this.id = options.id || 'managed-cloud';
    this.client = options.client || null;
    this.audiences = Array.isArray(options.audiences) ? options.audiences : ['employee', 'manager', 'executive'];
  }

  async initialize() {
    if (this.client?.initialize) return this.client.initialize();
    return { ok: true, provider: 'managed-cloud' };
  }

  async search(query, context = {}) {
    if (this.client?.search) return this.client.search(query, context);
    return [];
  }

  async get(id, context = {}) {
    if (this.client?.get) return this.client.get(id, context);
    return null;
  }

  async insert(record, context = {}) {
    if (this.client?.insert) return this.client.insert(record, context);
    return { ...record };
  }

  async update(id, updates = {}, context = {}) {
    if (this.client?.update) return this.client.update(id, updates, context);
    return { id, ...updates };
  }

  async delete(id, context = {}) {
    if (this.client?.delete) return this.client.delete(id, context);
    return true;
  }

  async graph(context = {}) {
    if (this.client?.graph) return this.client.graph(context);
    return { nodes: [], edges: [] };
  }

  async permissions(context = {}) {
    if (this.client?.permissions) return this.client.permissions(context);
    return { allowed: true, reason: null };
  }

  async health() {
    if (this.client?.health) return this.client.health();
    return { ok: true, provider: 'managed-cloud' };
  }
}

class CustomerManagedKnowledgeStore extends ManagedCloudKnowledgeStore {
  constructor(options = {}) {
    super(options);
    this.id = options.id || 'customer-managed';
    this.audiences = Array.isArray(options.audiences) ? options.audiences : ['employee', 'manager', 'executive'];
  }

  async initialize() {
    if (this.client?.initialize) return this.client.initialize();
    return { ok: true, provider: 'customer-managed' };
  }

  async health() {
    if (this.client?.health) return this.client.health();
    return { ok: true, provider: 'customer-managed' };
  }
}

function createKnowledgeStore(config = {}) {
  const type = String(config.type || 'browser-local').toLowerCase();
  if (type === 'managed-cloud') return new ManagedCloudKnowledgeStore(config);
  if (type === 'customer-managed') return new CustomerManagedKnowledgeStore(config);
  return new BrowserLocalKnowledgeStore(config);
}

module.exports = {
  KnowledgeStore,
  BrowserLocalKnowledgeStore,
  ManagedCloudKnowledgeStore,
  CustomerManagedKnowledgeStore,
  createKnowledgeStore,
};
