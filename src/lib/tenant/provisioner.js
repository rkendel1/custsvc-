const { randomUUID } = require('crypto');
const { createDefaultTenantStructure, slugifyCompanyName } = require('./tenant');

function provisionTenant(input = {}) {
  const companyName = String(input.companyName || input.company_name || '').trim();
  const ownerEmail = String(input.ownerEmail || input.owner || input.email || '').trim().toLowerCase();

  if (!companyName) throw new Error('company is required');
  if (!ownerEmail || !ownerEmail.includes('@')) throw new Error('valid owner email is required');

  const normalizedTenantId = (String(input.tenantId || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')) || slugifyCompanyName(companyName);
  const tenantId = normalizedTenantId.slice(0, 63) || `tenant-${randomUUID()}`;
  const deploymentProfile = String(input.deploymentProfile || 'BOTH').toUpperCase();

  return {
    ...createDefaultTenantStructure({
      tenantId,
      companyName,
      ownerEmail,
      deploymentProfile,
    }),
    created_at: new Date().toISOString(),
    company_size: input.companySize || null,
    primary_use_case: input.primaryUseCase || null,
    status: 'active',
  };
}

module.exports = {
  provisionTenant,
};
