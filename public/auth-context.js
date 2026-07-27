(function initKnowledgeOSAuthContext() {
  function normalizeTenant(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  }

  function normalizeOrigin(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    try {
      return new URL(input).origin;
    } catch (_error) {
      return '';
    }
  }

  function getLikelyBaseDomainFromHost(hostname) {
    const host = String(hostname || '').trim().toLowerCase();
    if (!host) return '';
    const labels = host.split('.').filter(Boolean);
    if (labels.length < 2) return '';
    return labels.slice(-2).join('.');
  }

  function resolveTenantOrigin(tenantId, tenantOrigin = '') {
    const safeTenant = normalizeTenant(tenantId);
    if (!safeTenant) return '';

    const originFromApi = normalizeOrigin(tenantOrigin);
    if (originFromApi) return originFromApi;

    const baseDomain = getLikelyBaseDomainFromHost(window.location.hostname || '');
    if (!baseDomain) return '';
    return `${window.location.protocol}//${safeTenant}.${baseDomain}`;
  }

  function maybeRedirectToTenantHost(tenantId, tenantOrigin = '') {
    const safeTenant = normalizeTenant(tenantId);
    if (!safeTenant) return false;

    const targetOrigin = resolveTenantOrigin(safeTenant, tenantOrigin);
    if (!targetOrigin || targetOrigin === window.location.origin) return false;

    const nextUrl = new URL(window.location.href);
    const target = new URL(targetOrigin);
    nextUrl.protocol = target.protocol;
    nextUrl.host = target.host;
    nextUrl.searchParams.set('tenant_id', safeTenant);
    window.location.replace(nextUrl.toString());
    return true;
  }

  function sanitizeRequestedNext(value) {
    const candidate = String(value || '').trim();
    if (!candidate || candidate === '/') return '';
    if (!candidate.startsWith('/')) return '';
    if (candidate.startsWith('//')) return '';
    if (candidate.startsWith('/access.html')) return '';
    return candidate;
  }

  function isAllowedAbsoluteRedirect(urlValue) {
    const candidate = String(urlValue || '').trim();
    if (!candidate) return false;
    try {
      const parsed = new URL(candidate);
      if (!/^https?:$/.test(parsed.protocol)) return false;
      const currentBaseDomain = getLikelyBaseDomainFromHost(window.location.hostname || '');
      const targetBaseDomain = getLikelyBaseDomainFromHost(parsed.hostname || '');
      return Boolean(currentBaseDomain && targetBaseDomain && currentBaseDomain === targetBaseDomain);
    } catch (_error) {
      return false;
    }
  }

  function resolveRedirectUrl({ serverNextUrl = '', fallback = '/', tenantOrigin = '', requestedNext = '' } = {}) {
    const serverNext = String(serverNextUrl || '').trim();
    if (isAllowedAbsoluteRedirect(serverNext)) return serverNext;
    if (serverNext.startsWith('/') && !serverNext.startsWith('//')) {
      const origin = normalizeOrigin(tenantOrigin);
      if (origin) {
        try {
          return new URL(serverNext, origin).toString();
        } catch (_error) {
          return serverNext;
        }
      }
      return serverNext;
    }

    const requested = sanitizeRequestedNext(requestedNext);
    if (requested) return requested;
    return fallback;
  }

  function buildAccessUrl(nextPath) {
    const next = String(nextPath || window.location.pathname || '/');
    return `/access.html?next=${encodeURIComponent(next)}`;
  }

  window.KnowledgeOSAuthContext = {
    normalizeTenant,
    normalizeOrigin,
    getLikelyBaseDomainFromHost,
    resolveTenantOrigin,
    maybeRedirectToTenantHost,
    sanitizeRequestedNext,
    resolveRedirectUrl,
    buildAccessUrl,
  };
})();
