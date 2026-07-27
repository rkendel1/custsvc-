function sanitizeDomainHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.local')) return true;

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return (
      host.startsWith('10.')
      || host.startsWith('127.')
      || host.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      || host.startsWith('169.254.')
    );
  }

  if (host.includes(':')) {
    return host === '::1' || host.startsWith('fc00:') || host.startsWith('fd00:') || host.startsWith('fe80:');
  }

  return false;
}

function resolvePublicOrigin(req, fallbackPort = 3000) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_ORIGIN || '').trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch (_error) {
      // Fall through to request-derived origin.
    }
  }

  const host = String(req?.get?.('host') || `127.0.0.1:${fallbackPort}`).trim();
  const forwardedProto = String(req?.get?.('x-forwarded-proto') || '').trim().toLowerCase();
  const protocol = forwardedProto || req?.protocol || 'http';
  return `${protocol}://${host}`;
}

function resolveTenantBaseDomain(req) {
  const configured = sanitizeDomainHost(
    process.env.TENANT_BASE_DOMAIN
      || process.env.APP_BASE_DOMAIN
      || process.env.PUBLIC_BASE_DOMAIN,
  );
  if (configured) return configured;

  const configuredPublicOrigin = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_ORIGIN || '').trim();
  if (configuredPublicOrigin) {
    try {
      const host = sanitizeDomainHost(new URL(configuredPublicOrigin).hostname || '');
      if (host && !isPrivateHost(host) && host !== 'localhost') return host;
    } catch (_error) {
      // Ignore invalid configured origin and fall back to request host.
    }
  }

  const hostHeader = String(req?.get?.('x-forwarded-host') || req?.get?.('host') || '').split(',')[0].trim();
  const candidate = sanitizeDomainHost(hostHeader);
  if (!candidate || isPrivateHost(candidate) || candidate === 'localhost') return '';
  const labels = candidate.split('.');
  if (labels.length < 2) return '';
  return labels.slice(-2).join('.');
}

function resolveTenantIdFromHost(req) {
  const baseDomain = resolveTenantBaseDomain(req);
  if (!baseDomain) return null;

  const hostHeader = String(req?.get?.('x-forwarded-host') || req?.get?.('host') || '').split(',')[0].trim();
  const host = sanitizeDomainHost(hostHeader);
  if (!host || host === baseDomain || host === `www.${baseDomain}`) return null;
  if (!host.endsWith(`.${baseDomain}`)) return null;

  const subdomain = host.slice(0, -(baseDomain.length + 1));
  if (!subdomain || subdomain.includes('.')) return null;
  if (!/^[a-z0-9-]{1,63}$/.test(subdomain)) return null;
  if (subdomain === 'www') return null;
  return subdomain;
}

function resolveTenantId(req) {
  const fromSubdomain = resolveTenantIdFromHost(req);
  return (
    req?.header?.('x-tenant-id')
    || req?.query?.tenant_id
    || req?.body?.tenant_id
    || req?.body?.tenantId
    || fromSubdomain
    || null
  );
}

function resolveTenantOrigin(req, tenantId, fallbackPort = 3000) {
  const normalizedTenantId = String(tenantId || '').trim().toLowerCase();
  if (!normalizedTenantId) return resolvePublicOrigin(req, fallbackPort);

  const baseDomain = resolveTenantBaseDomain(req);
  if (!baseDomain) return resolvePublicOrigin(req, fallbackPort);

  const configuredPublicOrigin = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_ORIGIN || '').trim();
  if (configuredPublicOrigin) {
    try {
      const proto = new URL(configuredPublicOrigin).protocol || 'https:';
      return `${proto}//${normalizedTenantId}.${baseDomain}`;
    } catch (_error) {
      // Fall through to request-derived protocol.
    }
  }

  const forwardedProto = String(req?.get?.('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProto || req?.protocol || 'http';
  return `${protocol}://${normalizedTenantId}.${baseDomain}`;
}

function resolveCookieDomain(req) {
  const baseDomain = resolveTenantBaseDomain(req);
  if (!baseDomain || isPrivateHost(baseDomain) || baseDomain === 'localhost') return '';
  return `.${baseDomain}`;
}

function resolveTenantRedirectUrl(req, tenantId, nextPath) {
  const pathValue = String(nextPath || '').trim();
  if (!pathValue) return '';
  if (/^https?:\/\//i.test(pathValue)) return pathValue;
  if (!pathValue.startsWith('/')) return pathValue;

  const origin = resolveTenantOrigin(req, tenantId, Number(process.env.APP_PORT || 3000));
  try {
    return new URL(pathValue, origin).toString();
  } catch (_error) {
    return pathValue;
  }
}

function validateEmbedTenantHost(req, tenantId) {
  const requestedTenantId = String(tenantId || '').trim().toLowerCase();
  if (!requestedTenantId) {
    return { ok: false, status: 400, error: 'tenant_id is required', reason: 'missing_tenant_id' };
  }

  const hostTenantId = String(resolveTenantIdFromHost(req) || '').trim().toLowerCase();
  if (!hostTenantId) return { ok: true };
  if (hostTenantId === requestedTenantId) return { ok: true };

  return {
    ok: false,
    status: 409,
    error: 'tenant_id does not match tenant subdomain',
    reason: 'tenant_host_mismatch',
    expected_tenant_id: hostTenantId,
    received_tenant_id: requestedTenantId,
  };
}

module.exports = {
  sanitizeDomainHost,
  resolvePublicOrigin,
  resolveTenantBaseDomain,
  resolveTenantIdFromHost,
  resolveTenantId,
  resolveTenantOrigin,
  resolveCookieDomain,
  resolveTenantRedirectUrl,
  validateEmbedTenantHost,
};
