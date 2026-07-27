const adminParams = new URLSearchParams(window.location.search);
const adminSessionToken = adminParams.get('session_token') || localStorage.getItem('knowledgeos_admin_session_token') || '';
let adminTenantId = adminParams.get('tenant_id') || localStorage.getItem('knowledgeos_active_tenant_id') || '';

if (adminTenantId) {
  adminTenantId = String(adminTenantId).trim().toLowerCase();
  localStorage.setItem('knowledgeos_active_tenant_id', adminTenantId);
}

if (adminSessionToken) {
  localStorage.setItem('knowledgeos_admin_session_token', adminSessionToken);
}

async function requestJson(url, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };
  if (adminTenantId && !headers['x-tenant-id']) {
    headers['x-tenant-id'] = adminTenantId;
  }
  if (adminSessionToken && !headers.authorization && !headers['x-session-token']) {
    headers['x-session-token'] = adminSessionToken;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_error) {
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      throw new Error('Server returned malformed JSON');
    }
  }
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function format(value) {
  return JSON.stringify(value, null, 2);
}

function setPanelText(elementId, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = String(message || '');
}

function setAuthState(text, isAuthenticated) {
  const chip = document.getElementById('authState');
  if (!chip) return;
  chip.textContent = String(text || '');
  chip.style.background = isAuthenticated ? '#e9f7ef' : '#fff3f3';
  chip.style.color = isAuthenticated ? '#1f6b3a' : '#8f2e2e';
  chip.style.borderColor = isAuthenticated ? '#b8e4c8' : '#f0d0d0';
}

async function refreshAccessStatus() {
  try {
    const status = await requestJson('/api/access/status');
    const tenantFromAuth = String(status?.authenticated_tenant_id || '').trim().toLowerCase();
    if (tenantFromAuth && tenantFromAuth !== adminTenantId) {
      adminTenantId = tenantFromAuth;
      localStorage.setItem('knowledgeos_active_tenant_id', adminTenantId);
    }
    if (tenantFromAuth) {
      setAuthState(`Workspace: ${tenantFromAuth}`, true);
      return;
    }
    if (!status.password_required || status.authenticated) {
      setAuthState('Workspace: ready', true);
      return;
    }
    setAuthState('Workspace session required', false);
  } catch (_error) {
    setAuthState('Workspace status unavailable', false);
  }
}

function wireSignOut() {
  const button = document.getElementById('signOutBtn');
  if (!button) return;

  button.addEventListener('click', async () => {
    try {
      await requestJson('/api/access/logout', { method: 'POST' });
      setAuthState('Access: signed out', false);
      window.location.href = '/access.html?next=/admin.html';
    } catch (error) {
      setPanelText('compileOutput', `Could not sign out: ${error.message}`);
    }
  });
}

function parseMaybeJsonArray(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

let sourceTemplates = [];
const EMBEDDING_MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_ENGINE_URL = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
let embeddingPipeline = null;

async function ensureEmbeddingPipeline() {
  if (embeddingPipeline) return embeddingPipeline;
  const transformers = await import(EMBEDDING_ENGINE_URL);
  embeddingPipeline = await transformers.pipeline('feature-extraction', EMBEDDING_MODEL_REPO);
  return embeddingPipeline;
}

function flattenEmbedding(output) {
  if (!output) return [];
  if (Array.isArray(output?.data)) {
    return output.data.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  }
  if (Array.isArray(output)) {
    return output.flat(Infinity).map((item) => Number(item)).filter((item) => Number.isFinite(item));
  }
  return [];
}

async function createEmbedding(text) {
  const input = String(text || '').trim();
  if (!input) return [];
  try {
    const pipeline = await ensureEmbeddingPipeline();
    const output = await pipeline(input, { pooling: 'mean', normalize: true });
    return flattenEmbedding(output);
  } catch (_error) {
    return [];
  }
}

function getSourceTemplate(type) {
  const normalizedType = String(type || 'GENERIC').toUpperCase();
  return sourceTemplates.find((template) => template.type === normalizedType) || null;
}

function renderSourceCredentialFields(type) {
  const container = document.getElementById('sourceCredentialFields');
  if (!container) return;
  const template = getSourceTemplate(type);
  if (!template || !Array.isArray(template.fields) || !template.fields.length) {
    container.innerHTML = '';
    return;
  }

  const labels = template.fields
    .map((field) => {
      const inputType = field.input_type || 'text';
      const requiredAttr = field.required ? 'required' : '';
      const requiredSuffix = field.required ? ' *' : '';
      return `<label>${field.label}${requiredSuffix}<input name="cred__${field.key}" type="${inputType}" ${requiredAttr} /></label>`;
    })
    .join('');

  container.innerHTML = `<div class="stack"><strong>Credentials for ${template.display_name}</strong>${labels}</div>`;
}

async function loadSourceTemplates() {
  const data = await requestJson('/api/sources/templates');
  sourceTemplates = Array.isArray(data.templates) ? data.templates : [];
}

async function refreshDocuments() {
  const output = document.getElementById('docsOutput');
  try {
    const data = await requestJson('/api/documents');
    output.textContent = format(data.documents);
  } catch (error) {
    output.textContent = `Unable to load knowledge objects: ${error.message}`;
  }
}

async function refreshAnalytics() {
  const output = document.getElementById('analyticsOutput');
  try {
    const data = await requestJson('/api/admin/analytics');
    output.textContent = format(data.analytics);
  } catch (error) {
    output.textContent = `Unable to load analytics: ${error.message}`;
  }
}

async function refreshSources() {
  const output = document.getElementById('sourcesOutput');
  try {
    const data = await requestJson('/api/sources');
    output.textContent = format(data.sources);
  } catch (error) {
    output.textContent = `Unable to load sources: ${error.message}`;
  }
}

async function refreshSourceAudit() {
  const output = document.getElementById('sourcesOutput');
  try {
    const data = await requestJson('/api/sources/audit?limit=100');
    output.textContent = format(data.events || []);
  } catch (error) {
    output.textContent = `Unable to load source audit: ${error.message}`;
  }
}

function wireTextDocForm() {
  const form = document.getElementById('textDocForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    payload.tags = String(payload.tags || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    payload.relationships = parseMaybeJsonArray(payload.relationships);
    payload.review_frequency = Number(payload.review_frequency || 90);
    payload.confidence = Number(payload.confidence || 0.7);
    payload.embeddings = await createEmbedding(`${payload.title || ''}\n${payload.body || ''}`);

    try {
      await requestJson('/api/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      form.reset();
      setPanelText('compileOutput', 'Knowledge object saved.');
      await refreshDocuments();
    } catch (error) {
      setPanelText('compileOutput', `Could not save knowledge object: ${error.message}`);
    }
  });
}

function wireUrlDocForm() {
  const form = document.getElementById('urlDocForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    payload.embeddings = await createEmbedding(`${payload.title || ''}\n${payload.content || ''}`);

    try {
      await requestJson('/api/documents/url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      form.reset();
      setPanelText('compileOutput', 'URL knowledge object saved.');
      await refreshDocuments();
    } catch (error) {
      setPanelText('compileOutput', `Could not save URL object: ${error.message}`);
    }
  });
}

function wirePdfDocForm() {
  const form = document.getElementById('pdfDocForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);

    try {
      await requestJson('/api/documents/pdf', {
        method: 'POST',
        body: formData,
      });
      form.reset();
      setPanelText('compileOutput', 'PDF knowledge object saved.');
      await refreshDocuments();
    } catch (error) {
      setPanelText('compileOutput', `Could not save PDF object: ${error.message}`);
    }
  });
}

function wireBulkDocForm() {
  const form = document.getElementById('bulkDocForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const raw = String(formData.get('items') || '').trim();
    let items = [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('items must be a JSON array');
      items = parsed;
    } catch (error) {
      setPanelText('compileOutput', `Invalid bulk JSON: ${error.message}`);
      return;
    }

    try {
      const embeddedItems = await Promise.all(items.map(async (item) => {
        const text = `${item?.title || ''}\n${item?.body || ''}`;
        return {
          ...item,
          embeddings: await createEmbedding(text),
        };
      }));

      const result = await requestJson('/api/documents/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: embeddedItems }),
      });
      setPanelText('compileOutput', `Imported ${result.inserted_count} object(s), skipped ${result.rejected_count}.`);
      await refreshDocuments();
    } catch (error) {
      setPanelText('compileOutput', `Could not run bulk import: ${error.message}`);
    }
  });
}

function wireSourceForm() {
  const form = document.getElementById('sourceForm');
  const typeInput = form.querySelector('select[name="type"]');

  typeInput.addEventListener('change', () => {
    renderSourceCredentialFields(typeInput.value);
  });

  renderSourceCredentialFields(typeInput.value);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = {};
    const credentials = {};
    for (const [key, value] of formData.entries()) {
      if (String(key).startsWith('cred__')) {
        credentials[String(key).slice(6)] = String(value || '');
      } else {
        payload[key] = value;
      }
    }
    payload.poll_minutes = Number(payload.poll_minutes || 60);
    payload.credentials = credentials;

    try {
      await requestJson('/api/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      form.reset();
      renderSourceCredentialFields('GENERIC');
      setPanelText('sourcesOutput', 'Source registered successfully. Refreshing list...');
      await refreshSources();
    } catch (error) {
      setPanelText('sourcesOutput', `Could not register source: ${error.message}`);
    }
  });
}

function wireSourceSync() {
  const button = document.getElementById('syncSourceBtn');
  button.addEventListener('click', async () => {
    const sourceId = String(document.getElementById('syncSourceId').value || '').trim();
    if (!sourceId) {
      setPanelText('sourcesOutput', 'Source ID is required for sync.');
      return;
    }

    const rawDocs = String(document.getElementById('syncDocuments').value || '').trim();
    let documents = [];
    if (rawDocs) {
      try {
        const parsed = JSON.parse(rawDocs);
        if (!Array.isArray(parsed)) throw new Error('must be an array');
        documents = await Promise.all(parsed.map(async (item) => ({
          ...item,
          embeddings: Array.isArray(item?.embeddings)
            ? item.embeddings
            : await createEmbedding(`${item?.title || ''}\n${item?.body || ''}`),
        })));
      } catch (error) {
        setPanelText('sourcesOutput', `Invalid sync JSON: ${error.message}`);
        return;
      }
    }

    try {
      await requestJson(`/api/sources/${encodeURIComponent(sourceId)}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documents }),
      });
      setPanelText('sourcesOutput', 'Source sync completed. Refreshing source and knowledge views...');
      await refreshSources();
      await refreshDocuments();
    } catch (error) {
      setPanelText('sourcesOutput', `Could not sync source: ${error.message}`);
    }
  });
}

function collectSourceCredentialsFromForm() {
  const credentials = {};
  document.querySelectorAll('#sourceCredentialFields input[name^="cred__"]').forEach((input) => {
    credentials[input.name.slice(6)] = input.value || '';
  });
  return credentials;
}

function wireSourceTest() {
  const button = document.getElementById('testSourceBtn');
  if (!button) return;

  button.addEventListener('click', async () => {
    const sourceId = String(document.getElementById('syncSourceId').value || '').trim();
    if (!sourceId) {
      setPanelText('sourcesOutput', 'Source ID is required for connection test.');
      return;
    }

    try {
      const data = await requestJson(`/api/sources/${encodeURIComponent(sourceId)}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      document.getElementById('sourcesOutput').textContent = format(data);
      await refreshSources();
    } catch (error) {
      setPanelText('sourcesOutput', `Connection test failed: ${error.message}`);
    }
  });
}

function wireSourceUpdate() {
  const button = document.getElementById('updateSourceBtn');
  const form = document.getElementById('sourceForm');
  if (!button || !form) return;

  button.addEventListener('click', async () => {
    const sourceId = String(document.getElementById('syncSourceId').value || '').trim();
    if (!sourceId) {
      setPanelText('sourcesOutput', 'Source ID is required for update.');
      return;
    }

    const formData = new FormData(form);
    const payload = {
      credentials: collectSourceCredentialsFromForm(),
    };
    const name = String(formData.get('name') || '').trim();
    const type = String(formData.get('type') || '').trim();
    const siteUrl = String(formData.get('site_url') || '').trim();
    const pollMinutes = Number(formData.get('poll_minutes') || 60);
    if (name) payload.name = name;
    if (type) payload.type = type;
    if (siteUrl) payload.site_url = siteUrl;
    if (Number.isFinite(pollMinutes)) payload.poll_minutes = pollMinutes;

    try {
      const data = await requestJson(`/api/sources/${encodeURIComponent(sourceId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      document.getElementById('sourcesOutput').textContent = format(data);
      await refreshSources();
    } catch (error) {
      setPanelText('sourcesOutput', `Could not update source: ${error.message}`);
    }
  });
}

function wireCompile() {
  const button = document.getElementById('compileBtn');
  const output = document.getElementById('compileOutput');
  const graphOutput = document.getElementById('graphOutput');
  const reviewOutput = document.getElementById('reviewOutput');
  button.addEventListener('click', async () => {
    try {
      const data = await requestJson('/api/compile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'knowledgeos.bundle.json' }),
      });
      output.textContent = format(data);
      graphOutput.textContent = format({
        relationships: data.bundleSummary.relationships,
        duplicates: data.bundleSummary.duplicates,
        contradictions: data.bundleSummary.contradictions,
      });
      reviewOutput.textContent = format(data.bundleSummary.review_schedule || {});
    } catch (error) {
      output.textContent = error.message;
      graphOutput.textContent = error.message;
      reviewOutput.textContent = error.message;
    }
  });
}

function resolveTenantForQuickActions() {
  const fallbackTenant = String(adminTenantId || localStorage.getItem('knowledgeos_active_tenant_id') || '').trim().toLowerCase();
  const tenantId = fallbackTenant;
  if (tenantId) {
    adminTenantId = tenantId;
    localStorage.setItem('knowledgeos_active_tenant_id', tenantId);
  }
  return tenantId;
}

function getTenantForDashboardActions() {
  const tenantId = resolveTenantForQuickActions();
  if (tenantId) return tenantId;
  setQuickStatus('Workspace tenant is unavailable. Refresh this page to reconnect your session.');
  return '';
}

function setQuickStatus(message) {
  const node = document.getElementById('quickStatus');
  if (!node) return;
  node.textContent = String(message || '');
}

async function refreshQuickStats() {
  const docsChip = document.getElementById('quickDocsCount');
  const sourcesChip = document.getElementById('quickSourcesCount');
  const tenantId = getTenantForDashboardActions();
  if (!tenantId) return;

  try {
    const [docs, sources] = await Promise.all([
      requestJson('/api/documents'),
      requestJson('/api/sources'),
    ]);
    const docCount = Array.isArray(docs?.documents) ? docs.documents.length : 0;
    const sourceCount = Array.isArray(sources?.sources) ? sources.sources.length : 0;

    if (docsChip) docsChip.textContent = `Knowledge objects: ${docCount}`;
    if (sourcesChip) sourcesChip.textContent = `Connected sources: ${sourceCount}`;

    setQuickStatus(`Ready: ${docCount} knowledge objects and ${sourceCount} connected sources for tenant ${tenantId}.`);
  } catch (error) {
    setQuickStatus(`Could not load quick stats: ${error.message}`);
  }
}

function wireQuickStart() {
  const openEmbedTesterBtn = document.getElementById('openEmbedTester');
  const refreshQuickStatsBtn = document.getElementById('refreshQuickStats');
  const toggleAdvancedBtn = document.getElementById('toggleAdvanced');

  openEmbedTesterBtn?.addEventListener('click', () => {
    const tenantId = getTenantForDashboardActions();
    if (!tenantId) return;
    window.location.href = `/embed-test.html?tenant_id=${encodeURIComponent(tenantId)}`;
  });

  refreshQuickStatsBtn?.addEventListener('click', () => {
    refreshQuickStats();
  });

  toggleAdvancedBtn?.addEventListener('click', () => {
    const showing = document.body.classList.toggle('show-advanced');
    toggleAdvancedBtn.textContent = showing ? 'Hide advanced tools' : 'Show advanced tools';
  });
}

function wireConsoleWizard() {
  const panes = [...document.querySelectorAll('.wizard-step')];
  const prev = document.getElementById('prevAdminStep');
  const next = document.getElementById('nextAdminStep');
  if (!panes.length || !prev || !next) return;

  let step = 1;

  function render() {
    panes.forEach((pane, index) => {
      pane.classList.toggle('active', index + 1 === step);
    });
    prev.style.visibility = step === 1 ? 'hidden' : 'visible';
    next.textContent = step === panes.length ? 'Review Ready' : 'Next';
  }

  prev.addEventListener('click', () => {
    step = Math.max(1, step - 1);
    render();
  });

  next.addEventListener('click', () => {
    step = Math.min(panes.length, step + 1);
    render();
  });

  render();
}

async function bootstrapAdmin() {
  await loadSourceTemplates();

  wireQuickStart();
  wireConsoleWizard();
  wireTextDocForm();
  wireUrlDocForm();
  wirePdfDocForm();
  wireBulkDocForm();
  wireSourceForm();
  wireSourceSync();
  wireSourceTest();
  wireSourceUpdate();
  wireCompile();
  wireSignOut();

  document.getElementById('refreshDocs').addEventListener('click', refreshDocuments);
  document.getElementById('refreshAnalytics').addEventListener('click', refreshAnalytics);
  document.getElementById('refreshSources').addEventListener('click', refreshSources);
  document.getElementById('refreshSourceAudit').addEventListener('click', refreshSourceAudit);

  await refreshAccessStatus();
  await refreshQuickStats();
  await refreshDocuments();
  await refreshAnalytics();
  await refreshSources();
}

bootstrapAdmin().catch((error) => {
  setAuthState('Workspace status unavailable', false);
  setPanelText('compileOutput', error.message || 'Failed to initialize admin console');
});
