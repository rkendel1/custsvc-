const DOWNLOAD_STATES = {
  missing: 'missing',
  downloading: 'downloading',
  paused: 'paused',
  available: 'available',
  initialized: 'initialized',
};

function parseSizeToBytes(size) {
  if (typeof size === 'number' && Number.isFinite(size)) return Math.max(0, Math.round(size));
  const text = String(size || '').trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2] || 'b';
  const unitMultipliers = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
  };
  const multiplier = unitMultipliers[unit] || 1;
  return Math.round(value * multiplier);
}

function createModelManager(options = {}) {
  const models = new Map();
  const state = new Map();
  const version = options.version || 'v1';

  function discoverModels(bundle = {}) {
    const discovered = Array.isArray(bundle.models) ? bundle.models : [];
    for (const model of discovered) {
      if (!model?.id) continue;
      models.set(model.id, model);
      if (!state.has(model.id)) {
        state.set(model.id, {
          id: model.id,
          downloaded: false,
          initialized: false,
          downloadState: DOWNLOAD_STATES.missing,
          bytesDownloaded: 0,
          bytesTotal: parseSizeToBytes(model.size),
          version,
        });
      }
    }
    return discovered;
  }

  function getModelStatus(modelId) {
    if (!state.has(modelId)) {
      return {
        id: modelId,
        downloaded: false,
        initialized: false,
        downloadState: DOWNLOAD_STATES.missing,
        bytesDownloaded: 0,
        bytesTotal: 0,
        version,
      };
    }
    return { ...state.get(modelId) };
  }

  async function downloadModel(modelId, bundle = null) {
    if (bundle) discoverModels(bundle);
    const model = models.get(modelId);
    if (!model) throw new Error(`model not found: ${modelId}`);
    const current = getModelStatus(modelId);
    current.downloadState = DOWNLOAD_STATES.downloading;
    state.set(modelId, current);
    current.downloaded = true;
    current.bytesTotal = parseSizeToBytes(model.size);
    current.bytesDownloaded = current.bytesTotal;
    current.downloadState = DOWNLOAD_STATES.available;
    state.set(modelId, current);
    return model;
  }

  function pauseDownload(modelId) {
    const current = getModelStatus(modelId);
    if (!current.id || current.downloadState !== DOWNLOAD_STATES.downloading) return current;
    current.downloadState = DOWNLOAD_STATES.paused;
    state.set(modelId, current);
    return current;
  }

  async function resumeDownload(modelId, bundle = null) {
    if (bundle) discoverModels(bundle);
    const current = getModelStatus(modelId);
    if (!current.id || current.downloadState !== DOWNLOAD_STATES.paused) return current;
    const model = models.get(modelId);
    if (!model) throw new Error(`model not found: ${modelId}`);
    return downloadModel(modelId);
  }

  function verifyModel(modelId) {
    const model = models.get(modelId);
    const current = getModelStatus(modelId);
    const hasChecksum = Boolean(model?.checksum?.algorithm && String(model?.checksum?.value || '').trim());
    return {
      id: modelId,
      ok: Boolean(current.downloaded && hasChecksum),
      algorithm: model?.checksum?.algorithm || null,
      checksum: model?.checksum?.value || null,
    };
  }

  async function initializeModel(modelOrId) {
    const modelId = typeof modelOrId === 'string' ? modelOrId : modelOrId?.id;
    const current = getModelStatus(modelId);
    if (!current.downloaded) throw new Error('model not downloaded');
    current.initialized = true;
    current.downloadState = DOWNLOAD_STATES.initialized;
    state.set(modelId, current);
    return { ...current };
  }

  function removeModel(modelId) {
    const current = getModelStatus(modelId);
    current.downloaded = false;
    current.initialized = false;
    current.downloadState = DOWNLOAD_STATES.missing;
    current.bytesDownloaded = 0;
    state.set(modelId, current);
    return current;
  }

  function getStorageUsage() {
    let usedBytes = 0;
    for (const item of state.values()) usedBytes += Number(item.bytesDownloaded || 0);
    return {
      usedBytes,
      modelCount: [...state.values()].filter((item) => item.downloaded).length,
    };
  }

  return {
    discoverModels,
    getModelStatus,
    downloadModel,
    pauseDownload,
    resumeDownload,
    verifyModel,
    initializeModel,
    removeModel,
    getStorageUsage,
  };
}

const ModelManager = createModelManager();

module.exports = {
  createModelManager,
  ModelManager,
  DOWNLOAD_STATES,
};
