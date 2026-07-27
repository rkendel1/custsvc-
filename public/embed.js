(function () {
  const script = document.currentScript;
  if (!script) return;

  const tenantId = String(script.dataset.tenantId || '').trim().toLowerCase();
  const runtimeUrl = String(script.dataset.runtimeUrl || '').trim();
  const explicitApiBase = String(script.dataset.apiBase || '').trim();
  const explicitBundleUrl = String(script.dataset.bundleUrl || '').trim();
  const explicitLoaderSrc = String(script.dataset.loaderSrc || '').trim();

  let scriptOrigin = window.location.origin;
  try {
    scriptOrigin = new URL(script.src, window.location.href).origin;
  } catch (_error) {
    // Keep current origin fallback if script src parsing fails.
  }

  let runtimeOrigin = scriptOrigin;
  if (runtimeUrl) {
    try {
      runtimeOrigin = new URL(runtimeUrl, window.location.href).origin;
    } catch (_error) {
      // Keep script origin fallback if runtime URL parsing fails.
    }
  }

  function sanitizeHost(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .replace(/\.$/, '');
  }

  function resolveTenantFromHost(host, runtimeHost) {
    const currentHost = sanitizeHost(host);
    const baseHost = sanitizeHost(runtimeHost);
    if (!currentHost || !baseHost) return '';

    const baseLabels = baseHost.split('.').filter(Boolean);
    if (baseLabels.length < 2) return '';
    const baseDomain = baseLabels.slice(-2).join('.');
    if (currentHost === baseDomain || currentHost === `www.${baseDomain}`) return '';
    if (!currentHost.endsWith(`.${baseDomain}`)) return '';

    const sub = currentHost.slice(0, -(baseDomain.length + 1));
    if (!sub || sub.includes('.')) return '';
    if (!/^[a-z0-9-]{1,63}$/.test(sub) || sub === 'www') return '';
    return sub;
  }

  const runtimeHost = (() => {
    try {
      return new URL(runtimeOrigin).hostname;
    } catch (_error) {
      return '';
    }
  })();
  const tenantFromHost = resolveTenantFromHost(window.location.hostname, runtimeHost);
  if (tenantId && tenantFromHost && tenantFromHost !== tenantId) {
    // Never auto-correct across tenants. A mismatch indicates unsafe embed configuration.
    console.error(
      `[KnowledgeOS] Embed blocked: tenant mismatch (host=${tenantFromHost}, data-tenant-id=${tenantId}).`,
    );
    return;
  }

  const effectiveTenantId = tenantId || tenantFromHost;

  const apiBase = explicitApiBase || runtimeOrigin;
  const bundleUrl = explicitBundleUrl || (effectiveTenantId
    ? `${apiBase}/api/embed/bundle?tenant_id=${encodeURIComponent(effectiveTenantId)}`
    : `${apiBase}/bundles/knowledgeos.bundle.json`);
  const loaderSrc = explicitLoaderSrc || `${apiBase}/company-ai.js`;

  const loader = document.createElement('script');
  loader.src = loaderSrc;
  loader.async = true;

  const passthroughKeys = [
    'title',
    'remoteFallbackUrl',
    'aiMode',
    'telemetryIncludeContent',
    'minAnswerConfidence',
    'role',
    'department',
    'permissions',
    'pgliteModuleUrl',
    'preloadModel',
    'modelEngineUrl',
  ];

  loader.dataset.bundleUrl = bundleUrl;
  loader.dataset.apiBase = apiBase;
  if (effectiveTenantId) loader.dataset.tenantId = effectiveTenantId;

  if (!script.dataset.title && effectiveTenantId) {
    loader.dataset.title = `Ask ${effectiveTenantId}`;
  }

  for (const key of passthroughKeys) {
    const value = script.dataset[key];
    if (typeof value === 'string' && value.length > 0) {
      loader.dataset[key] = value;
    }
  }

  const target = document.head || document.body || document.documentElement;
  target.appendChild(loader);
})();
