const { randomUUID } = require('crypto');

function normalizeOrigin(value, fallback = 'http://127.0.0.1:3000') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  try {
    return new URL(raw).origin;
  } catch (_error) {
    return fallback;
  }
}

function createDeployment({ tenantId, companyName, deploymentProfile = 'BOTH', audiences = [], runtimeOrigin = null } = {}) {
  if (!tenantId) throw new Error('tenant_id is required');

  const deploymentId = `deploy-${randomUUID()}`;
  const resolvedOrigin = normalizeOrigin(runtimeOrigin);
  const runtimeUrl = `${resolvedOrigin}/runtime/${tenantId}/${deploymentId}`;
  const apiKey = `kos_${randomUUID().replace(/-/g, '')}`;

  return {
    deployment_id: deploymentId,
    tenant_id: tenantId,
    company_name: companyName || tenantId,
    status: 'active',
    deployed_at: new Date().toISOString(),
    deployment_profile: deploymentProfile,
    runtime_url: runtimeUrl,
    audience_rules: Array.isArray(audiences) ? audiences : [],
    bundle: {
      name: 'knowledgeos.bundle.v6',
      format_legacy: 'knowledgeos.bundle.v5',
    },
    permissions: ['Owner', 'Admin', 'Editor', 'Viewer'],
    branding: {
      product: 'KnowledgeOS',
      tagline: "Your company's intelligence, deployed everywhere.",
    },
    embed_code: `<script src="${resolvedOrigin}/embed.js" data-tenant-id="${tenantId}" data-api-base="${resolvedOrigin}" data-title="Ask ${tenantId}"></script>`,
    api_key: apiKey,
  };
}

module.exports = {
  createDeployment,
};
