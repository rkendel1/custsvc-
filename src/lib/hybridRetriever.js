function normalizeAudience(value) {
  return String(value || 'customer').toLowerCase();
}

function deriveAudienceFromContext(context = {}) {
  const role = String(context.role || 'customer').toLowerCase();
  if (role === 'customer' || role === 'partner') return 'customer';
  if (role === 'executive' || role === 'administrator') return 'executive';
  if (role === 'manager') return 'manager';
  return 'employee';
}

function createDeploymentProfile(profile = {}) {
  const mode = String(profile.mode || 'browser-local').toLowerCase();
  const stores = Array.isArray(profile.stores) ? profile.stores : [];
  return {
    mode,
    stores: stores.map((store, index) => ({
      id: String(store?.id || `store-${index + 1}`),
      type: String(store?.type || 'browser-local').toLowerCase(),
      audiences: Array.isArray(store?.audiences)
        ? store.audiences.map((item) => normalizeAudience(item))
        : ['customer'],
      permissions: Array.isArray(store?.permissions) ? store.permissions : [],
      priority: Number(store?.priority || index),
    })),
  };
}

function canAccessStore(store, context = {}) {
  if (!store.permissions?.length) return true;
  const perms = new Set((context.permissions || []).map((item) => String(item).toLowerCase()));
  return store.permissions.every((item) => perms.has(String(item).toLowerCase()));
}

function selectStores(profile, context = {}) {
  const safeProfile = createDeploymentProfile(profile);
  const audience = normalizeAudience(context.audience || deriveAudienceFromContext(context));
  return safeProfile.stores
    .filter((store) => store.audiences.includes(audience))
    .filter((store) => canAccessStore(store, context))
    .sort((a, b) => a.priority - b.priority);
}

function createHybridRetriever(options = {}) {
  const storesById = options.storesById || {};
  const deploymentProfile = createDeploymentProfile(options.deploymentProfile || {});

  async function retrieve(query, context = {}) {
    const selected = selectStores(deploymentProfile, context);
    const resultsByStore = await Promise.all(selected.map(async (store) => {
      const provider = storesById[store.id];
      if (!provider?.search) return [];
      const entries = await provider.search(query, context);
      return (Array.isArray(entries) ? entries : []).map((entry, index) => ({
        ...entry,
        sourceStoreId: store.id,
        retrievalOrder: index,
      }));
    }));
    return resultsByStore
      .flat()
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  }

  return {
    retrieve,
    search: retrieve,
    selectStores: (context = {}) => selectStores(deploymentProfile, context),
    getDeploymentProfile: () => deploymentProfile,
  };
}

module.exports = {
  createHybridRetriever,
  createDeploymentProfile,
  selectStores,
  deriveAudienceFromContext,
};
