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

  const apiBase = explicitApiBase || runtimeOrigin;
  const bundleUrl = explicitBundleUrl || (tenantId
    ? `${apiBase}/bundles/${encodeURIComponent(tenantId)}.knowledgeos.bundle.json`
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

  if (!script.dataset.title && tenantId) {
    loader.dataset.title = `Ask ${tenantId}`;
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
