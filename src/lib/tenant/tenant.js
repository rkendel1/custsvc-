const TENANT_ROLES = ['Owner', 'Admin', 'Editor', 'Viewer'];
const MAX_SUBDOMAIN_LABEL_LENGTH = 48;

function slugifyCompanyName(companyName) {
  const slug = String(companyName || 'tenant')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SUBDOMAIN_LABEL_LENGTH);

  return slug || 'tenant';
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
