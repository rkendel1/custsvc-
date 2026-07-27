const adminParams = new URLSearchParams(window.location.search);
const adminSessionToken = adminParams.get('session_token') || localStorage.getItem('knowledgeos_admin_session_token') || '';
let adminTenantId = adminParams.get('tenant_id') || localStorage.getItem('knowledgeos_active_tenant_id') || '';
const authContext = window.KnowledgeOSAuthContext || {};

function normalizeTenant(value) {
  if (typeof authContext.normalizeTenant === 'function') {
    return authContext.normalizeTenant(value);
  }
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function maybeRedirectToTenantHost(tenantId, tenantOrigin = '') {
  if (typeof authContext.maybeRedirectToTenantHost === 'function') {
    return authContext.maybeRedirectToTenantHost(tenantId, tenantOrigin);
  }
  return false;
}

if (adminTenantId) {
  adminTenantId = normalizeTenant(adminTenantId);
  localStorage.setItem('knowledgeos_active_tenant_id', adminTenantId);
  maybeRedirectToTenantHost(adminTenantId);
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
    const tenantFromAuth = normalizeTenant(status?.authenticated_tenant_id || '');
    if (tenantFromAuth && tenantFromAuth !== adminTenantId) {
      adminTenantId = tenantFromAuth;
      localStorage.setItem('knowledgeos_active_tenant_id', adminTenantId);
    }
    if (tenantFromAuth) {
      if (maybeRedirectToTenantHost(tenantFromAuth, status?.tenant_origin || '')) return;
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
let cachedSources = [];
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
    cachedSources = Array.isArray(data.sources) ? data.sources : [];
    output.textContent = format(data.sources);
    refreshIngestSourceSuggestions();
  } catch (error) {
    output.textContent = `Unable to load sources: ${error.message}`;
  }
}

function refreshIngestSourceSuggestions() {
  const datalist = document.getElementById('sourceIdSuggestions');
  if (!datalist) return;

  datalist.innerHTML = '';
  for (const source of cachedSources) {
    const sourceId = String(source?.source_id || '').trim();
    if (!sourceId) continue;
    const option = document.createElement('option');
    option.value = sourceId;
    option.label = `${sourceId} (${String(source?.name || source?.type || 'source')})`;
    datalist.appendChild(option);
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
  if (!form) return;
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
  if (!form) return;
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
  if (!form) return;
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
  if (!form) return;
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

function wireDirectIngestForm() {
  const form = document.getElementById('directIngestForm');
  if (!form) return;

  const modeInput = document.getElementById('directIngestMode');
  const typeInput = document.getElementById('directIngestType');
  const titleInput = document.getElementById('directIngestTitle');
  const bodyInput = document.getElementById('directIngestBody');
  const contentInput = document.getElementById('directIngestContent');
  const urlInput = document.getElementById('directIngestUrl');
  const fileInput = document.getElementById('directIngestFile');
  const itemsInput = document.getElementById('directIngestItems');
  const visibilityInput = document.getElementById('directIngestVisibility');

  const commonWrap = document.getElementById('directIngestCommonFields');
  const bodyWrap = document.getElementById('directIngestBodyWrap');
  const urlWrap = document.getElementById('directIngestUrlWrap');
  const urlContentWrap = document.getElementById('directIngestUrlContentWrap');
  const pdfWrap = document.getElementById('directIngestPdfWrap');
  const bulkWrap = document.getElementById('directIngestBulkWrap');

  if (!modeInput || !typeInput || !titleInput || !bodyInput || !contentInput || !urlInput || !fileInput || !itemsInput || !visibilityInput) return;
  if (!commonWrap || !bodyWrap || !urlWrap || !urlContentWrap || !pdfWrap || !bulkWrap) return;

  function syncModeUi() {
    const mode = String(modeInput.value || 'text').toLowerCase();
    const isText = mode === 'text';
    const isUrl = mode === 'url';
    const isPdf = mode === 'pdf';
    const isBulk = mode === 'bulk';

    commonWrap.style.display = isBulk ? 'none' : 'block';
    bodyWrap.style.display = isText ? 'block' : 'none';
    urlWrap.style.display = isUrl ? 'block' : 'none';
    urlContentWrap.style.display = isUrl ? 'block' : 'none';
    pdfWrap.style.display = isPdf ? 'block' : 'none';
    bulkWrap.style.display = isBulk ? 'block' : 'none';

    bodyInput.required = isText;
    urlInput.required = isUrl;
    contentInput.required = isUrl;
    fileInput.required = isPdf;
    itemsInput.required = isBulk;

    if (isUrl) typeInput.value = 'URL';
    if (isPdf) typeInput.value = 'PDF';
    typeInput.disabled = isUrl || isPdf;
    if (isBulk) visibilityInput.value = 'INTERNAL';
  }

  modeInput.addEventListener('change', syncModeUi);
  fileInput.addEventListener('change', () => {
    if (!String(titleInput.value || '').trim() && fileInput.files?.[0]?.name) {
      titleInput.value = String(fileInput.files[0].name).replace(/\.[a-z0-9]+$/i, '').trim();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const mode = String(modeInput.value || 'text').toLowerCase();

    try {
      if (mode === 'bulk') {
        const raw = String(itemsInput.value || '').trim();
        let items = [];
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) throw new Error('items must be a JSON array');
          items = parsed;
        } catch (error) {
          setPanelText('compileOutput', `Invalid bulk JSON: ${error.message}`);
          return;
        }

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
        form.reset();
        syncModeUi();
        await refreshDocuments();
        return;
      }

      if (mode === 'pdf') {
        if (!fileInput.files?.length) {
          setPanelText('compileOutput', 'Select a PDF file first.');
          return;
        }

        const data = new FormData();
        data.set('file', fileInput.files[0]);
        data.set('visibility', String(visibilityInput.value || 'INTERNAL'));
        if (String(titleInput.value || '').trim()) data.set('title', String(titleInput.value).trim());

        await requestJson('/api/documents/pdf', { method: 'POST', body: data });
        setPanelText('compileOutput', 'PDF knowledge object saved.');
        form.reset();
        syncModeUi();
        await refreshDocuments();
        return;
      }

      if (mode === 'url') {
        const payload = {
          url: String(urlInput.value || '').trim(),
          title: String(titleInput.value || '').trim(),
          content: String(contentInput.value || '').trim(),
          visibility: String(visibilityInput.value || 'INTERNAL'),
        };
        payload.embeddings = await createEmbedding(`${payload.title || ''}\n${payload.content || ''}`);

        await requestJson('/api/documents/url', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        setPanelText('compileOutput', 'URL knowledge object saved.');
        form.reset();
        syncModeUi();
        await refreshDocuments();
        return;
      }

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

      await requestJson('/api/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setPanelText('compileOutput', 'Knowledge object saved.');
      form.reset();
      syncModeUi();
      await refreshDocuments();
    } catch (error) {
      setPanelText('compileOutput', `Could not run direct ingest: ${error.message}`);
    }
  });

  syncModeUi();
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

function wireSourceIngestForm() {
  const form = document.getElementById('sourceIngestForm');
  if (!form) return;

  const sourceIdInput = document.getElementById('ingestSourceId');
  const modeInput = document.getElementById('sourceIngestMode');
  const titleInput = document.getElementById('sourceIngestTitle');
  const bodyInput = document.getElementById('sourceIngestBody');
  const typeInput = document.getElementById('sourceIngestType');
  const visibilityInput = document.getElementById('sourceIngestVisibility');
  const urlInput = document.getElementById('sourceIngestUrl');
  const pdfInput = document.getElementById('sourceIngestFile');
  const urlWrap = document.getElementById('sourceIngestUrlWrap');
  const bodyWrap = document.getElementById('sourceIngestBodyWrap');
  const pdfWrap = document.getElementById('sourceIngestPdfWrap');

  if (!sourceIdInput || !modeInput || !titleInput || !bodyInput || !typeInput || !visibilityInput || !urlInput || !pdfInput || !urlWrap || !bodyWrap || !pdfWrap) {
    return;
  }

  function inferTitleFromUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      const segment = String(parsed.pathname || '').split('/').filter(Boolean).pop() || parsed.hostname;
      return decodeURIComponent(segment).replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
    } catch (_error) {
      return '';
    }
  }

  function selectedSource() {
    const sourceId = String(sourceIdInput.value || '').trim();
    return cachedSources.find((item) => String(item?.source_id || '').trim() === sourceId) || null;
  }

  function defaultVisibilityForSource(source) {
    const sourceType = String(source?.type || '').toUpperCase();
    return sourceType === 'WEBSITE' ? 'PUBLIC' : 'INTERNAL';
  }

  function syncModeUi() {
    const mode = String(modeInput.value || 'text').toLowerCase();
    const source = selectedSource();

    const isPdf = mode === 'pdf';
    const isUrl = mode === 'url';

    urlWrap.style.display = isUrl ? 'block' : 'none';
    bodyWrap.style.display = isPdf ? 'none' : 'block';
    pdfWrap.style.display = isPdf ? 'block' : 'none';

    bodyInput.required = !isPdf;
    urlInput.required = isUrl;
    pdfInput.required = isPdf;

    if (isPdf) {
      typeInput.value = 'PDF';
      typeInput.disabled = true;
    } else if (isUrl) {
      typeInput.disabled = false;
      typeInput.value = 'URL';
    } else {
      typeInput.disabled = false;
      typeInput.value = (String(source?.type || '').toUpperCase() === 'WEBSITE') ? 'URL' : 'TEXT';
    }

    visibilityInput.value = defaultVisibilityForSource(source);

    if (!String(titleInput.value || '').trim()) {
      if (isPdf && pdfInput.files?.[0]?.name) {
        titleInput.value = String(pdfInput.files[0].name).replace(/\.[a-z0-9]+$/i, '').trim();
      } else if (isUrl) {
        titleInput.value = inferTitleFromUrl(urlInput.value) || String(source?.name || 'Source URL').trim();
      } else if (source?.name) {
        titleInput.value = `${String(source.name).trim()} note`;
      }
    }
  }

  sourceIdInput.addEventListener('change', syncModeUi);
  sourceIdInput.addEventListener('input', syncModeUi);
  modeInput.addEventListener('change', syncModeUi);
  urlInput.addEventListener('change', () => {
    if (!String(titleInput.value || '').trim()) {
      titleInput.value = inferTitleFromUrl(urlInput.value) || titleInput.value;
    }
  });
  pdfInput.addEventListener('change', () => {
    if (!String(titleInput.value || '').trim() && pdfInput.files?.[0]?.name) {
      titleInput.value = String(pdfInput.files[0].name).replace(/\.[a-z0-9]+$/i, '').trim();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const sourceId = String(sourceIdInput.value || document.getElementById('syncSourceId')?.value || '').trim();
    if (!sourceId) {
      setPanelText('sourcesIngestOutput', 'Source ID is required to ingest a document.');
      return;
    }

    const mode = String(modeInput.value || 'text').toLowerCase();
    const source = selectedSource();
    const visibility = String(visibilityInput.value || defaultVisibilityForSource(source));
    const title = String(titleInput.value || '').trim();

    try {
      if (mode === 'pdf') {
        if (!pdfInput.files?.length) {
          setPanelText('sourcesIngestOutput', 'Select a PDF file first.');
          return;
        }
        const formData = new FormData();
        formData.set('visibility', visibility);
        formData.set('file', pdfInput.files[0]);
        if (title) formData.set('title', title);

        const data = await requestJson(`/api/sources/${encodeURIComponent(sourceId)}/documents/pdf`, {
          method: 'POST',
          body: formData,
        });
        form.reset();
        syncModeUi();
        setPanelText('sourcesIngestOutput', `Source PDF ingested: ${data?.document?.id || 'created'}`);
      } else {
        const body = String(bodyInput.value || '').trim();
        if (!body) {
          setPanelText('sourcesIngestOutput', 'Document body is required.');
          return;
        }

        const sourceUrl = mode === 'url'
          ? String(urlInput.value || '').trim()
          : String(source?.site_url || '');

        const payload = {
          title: title || (mode === 'url' ? inferTitleFromUrl(sourceUrl) : 'Imported document'),
          body,
          type: String(typeInput.value || (mode === 'url' ? 'URL' : 'TEXT')),
          visibility,
          source_url: sourceUrl || undefined,
        };
        payload.embeddings = await createEmbedding(`${payload.title || ''}\n${payload.body || ''}`);

        const data = await requestJson(`/api/sources/${encodeURIComponent(sourceId)}/documents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        form.reset();
        syncModeUi();
        setPanelText('sourcesIngestOutput', `Source document ingested: ${data?.document?.id || 'created'}`);
      }

      await refreshSources();
      await refreshDocuments();
    } catch (error) {
      setPanelText('sourcesIngestOutput', `Could not ingest source document: ${error.message}`);
    }
  });

  syncModeUi();
}

function wireSourceScreens() {
  const screens = {
    connect: document.getElementById('sourceScreenConnect'),
    health: document.getElementById('sourceScreenHealth'),
    ingest: document.getElementById('sourceScreenIngest'),
  };
  const buttons = {
    connect: document.getElementById('sourceScreenConnectBtn'),
    health: document.getElementById('sourceScreenHealthBtn'),
    ingest: document.getElementById('sourceScreenIngestBtn'),
  };

  if (!screens.connect || !screens.health || !screens.ingest) return;
  if (!buttons.connect || !buttons.health || !buttons.ingest) return;

  function activate(screenName) {
    for (const [name, node] of Object.entries(screens)) {
      node.classList.toggle('active', name === screenName);
    }
    for (const [name, button] of Object.entries(buttons)) {
      const active = name === screenName;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.classList.toggle('btn-primary', active);
      button.classList.toggle('btn-ghost', !active);
    }
  }

  buttons.connect.addEventListener('click', () => activate('connect'));
  buttons.health.addEventListener('click', () => activate('health'));
  buttons.ingest.addEventListener('click', () => activate('ingest'));
  activate('connect');
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
  wireDirectIngestForm();
  wireSourceForm();
  wireSourceSync();
  wireSourceTest();
  wireSourceUpdate();
  wireSourceScreens();
  wireSourceIngestForm();
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
