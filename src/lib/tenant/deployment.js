const { randomUUID } = require('crypto');

function createDeployment({ tenantId, companyName, deploymentProfile = 'BOTH', audiences = [] } = {}) {
  if (!tenantId) throw new Error('tenant_id is required');

  const deploymentId = `deploy-${randomUUID()}`;
  const runtimeUrl = `https://${tenantId}.knowledgeos.com/runtime/${deploymentId}`;
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
      name: 'company.intelligence.bundle.v6',
      format_legacy: 'company.intelligence.bundle.v5',
    },
    permissions: ['Owner', 'Admin', 'Editor', 'Viewer'],
    branding: {
      product: 'KnowledgeOS',
      tagline: "Your company's intelligence, deployed everywhere.",
    },
    embed_code: `<script src="https://cdn.knowledgeos.com/embed.js" data-tenant-id="${tenantId}" data-runtime-url="${runtimeUrl}"></script>`,
    api_key: apiKey,
  };
}

module.exports = {
  createDeployment,
};
