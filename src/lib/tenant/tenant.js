const TENANT_ROLES = ['Owner', 'Admin', 'Editor', 'Viewer'];

function slugifyCompanyName(companyName) {
  return String(companyName || 'tenant')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'tenant';
}

function createDefaultTenantStructure({ tenantId, companyName, ownerEmail, deploymentProfile = 'BOTH' }) {
  return {
    tenant_id: tenantId,
    company_name: companyName,
    owner: ownerEmail,
    deployment_profile: deploymentProfile,
    knowledge_space: {
      id: `${tenantId}-knowledge-space`,
      name: `${companyName} Knowledge Space`,
      documents: 0,
    },
    audiences: ['Customers', 'Employees', 'Managers', 'Executives'],
    roles: [...TENANT_ROLES],
    runtime_config: {
      mode: 'private-runtime',
      deployment_domain: `${tenantId}.knowledgeos.com`,
      default_audience: 'Customers',
      isolation: 'tenant-scoped',
    },
  };
}

module.exports = {
  TENANT_ROLES,
  slugifyCompanyName,
  createDefaultTenantStructure,
};
