(function initSourcesFlow() {
  const authContext = window.KnowledgeOSAuthContext || {};

  const params = new URLSearchParams(window.location.search);
  let sessionToken = String(params.get('session_token') || localStorage.getItem('knowledgeos_admin_session_token') || '').trim();
  let tenantId = String(params.get('tenant_id') || localStorage.getItem('knowledgeos_active_tenant_id') || '').trim();
  let tenantOrigin = '';
  let templates = [];

  const tenantInput = document.getElementById('tenantInput');
  const sourceType = document.getElementById('sourceType');
  const sourceName = document.getElementById('sourceName');
  const sourceUrlWrap = document.getElementById('sourceUrlWrap');
  const sourceUrl = document.getElementById('sourceUrl');
  const credentialFields = document.getElementById('credentialFields');
  const starterTitle = document.getElementById('starterTitle');
  const starterBody = document.getElementById('starterBody');
  const addAndSyncBtn = document.getElementById('addAndSyncBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const statusBox = document.getElementById('statusBox');
  const embedScript = document.getElementById('embedScript');
  const copyScriptBtn = document.getElementById('copyScriptBtn');
  const openTesterBtn = document.getElementById('openTesterBtn');
  const sourceList = document.getElementById('sourceList');
  const authState = document.getElementById('authState');
  const signOutBtn = document.getElementById('signOutBtn');

  function normalizeTenant(value) {
    if (typeof authContext.normalizeTenant === 'function') {
      return authContext.normalizeTenant(value);
    }
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  }

  function setStatus(message) {
    statusBox.textContent = String(message || '');
  }

  function setAuthState(text, ok) {
    authState.textContent = String(text || '');
    authState.style.background = ok ? '#e9f7ef' : '#fff3f3';
    authState.style.color = ok ? '#1f6b3a' : '#8f2e2e';
    authState.style.borderColor = ok ? '#b8e4c8' : '#f0d0d0';
  }

  async function requestJson(url, options) {
    const headers = {
      ...((options && options.headers) || {}),
    };

    if (tenantId && !headers['x-tenant-id']) {
      headers['x-tenant-id'] = tenantId;
    }
    if (sessionToken && !headers['x-session-token']) {
      headers['x-session-token'] = sessionToken;
    }

    const response = await fetch(url, {
      ...(options || {}),
      headers,
    });

    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_error) {
        if (!response.ok) throw new Error('Request failed');
      }
    }

    if (!response.ok) {
      throw new Error(data.error || ('Request failed (' + response.status + ')'));
    }

    return data;
  }

  function getSelectedTemplate() {
    const type = String(sourceType.value || '').toUpperCase();
    return templates.find((item) => String(item.type || '').toUpperCase() === type) || null;
  }

  function renderEmbedScript() {
    const safeTenant = normalizeTenant(tenantId || tenantInput.value);
    if (!safeTenant) {
      embedScript.value = 'Set your workspace ID to generate script.';
      return;
    }
    const origin = typeof authContext.resolveTenantOrigin === 'function'
      ? (authContext.resolveTenantOrigin(safeTenant, tenantOrigin) || window.location.origin)
      : window.location.origin;
    embedScript.value = '<script src="' + origin + '/embed.js" data-tenant-id="' + safeTenant + '"><\\/script>';
  }

  function renderCredentialFields() {
    const template = getSelectedTemplate();
    const fields = Array.isArray(template && template.fields) ? template.fields : [];
    const blocks = [];
    for (const field of fields) {
      const requiredMark = field.required ? ' *' : '';
      const requiredAttr = field.required ? 'required' : '';
      const inputType = field.input_type || 'text';
      blocks.push(
        '<label>' + field.label + requiredMark
          + '<input type="' + inputType + '" name="cred__' + field.key + '" ' + requiredAttr + ' /></label>',
      );
    }
    credentialFields.innerHTML = blocks.join('');

    const type = String(sourceType.value || '').toUpperCase();
    const isWebsite = type === 'WEBSITE';
    sourceUrlWrap.style.display = isWebsite ? 'block' : 'none';
    sourceUrl.required = isWebsite;
    if (isWebsite && !String(sourceName.value || '').trim()) {
      sourceName.value = 'Website';
    }
  }

  function collectCredentials() {
    const creds = {};
    credentialFields.querySelectorAll('input[name^="cred__"]').forEach((input) => {
      creds[input.name.slice(6)] = String(input.value || '').trim();
    });
    return creds;
  }

  async function refreshSources() {
    const data = await requestJson('/api/sources');
    const sources = Array.isArray(data.sources) ? data.sources : [];
    sourceList.innerHTML = '';
    if (!sources.length) {
      sourceList.innerHTML = '<li>No sources yet.</li>';
      return;
    }

    for (const source of sources) {
      const li = document.createElement('li');
      const line = String(source.name || source.type || 'source')
        + ' | ' + String(source.type || '')
        + ' | sync: ' + String(source.last_sync_status || 'never')
        + ' | docs: ' + String(source.documents_synced || 0);
      li.textContent = line;
      sourceList.appendChild(li);
    }
  }

  async function refreshAccessStatus() {
    try {
      const status = await requestJson('/api/access/status');
      tenantOrigin = String(status.tenant_origin || '').trim();
      const tenantFromAuth = normalizeTenant(status.authenticated_tenant_id);

      if (tenantFromAuth) {
        tenantId = tenantFromAuth;
        localStorage.setItem('knowledgeos_active_tenant_id', tenantId);
        if (typeof authContext.maybeRedirectToTenantHost === 'function') {
          if (authContext.maybeRedirectToTenantHost(tenantId, tenantOrigin)) return;
        }
      }

      if (tenantId) {
        setAuthState('Workspace: ' + tenantId, true);
      } else if (!status.password_required || status.authenticated) {
        setAuthState('Access: signed in', true);
      } else {
        setAuthState('Workspace session required', false);
      }

      if (status.password_required && !status.authenticated && typeof authContext.buildAccessUrl === 'function') {
        window.location.href = authContext.buildAccessUrl('/sources.html');
        return;
      }
    } catch (_error) {
      setAuthState('Workspace status unavailable', false);
    }
  }

  async function loadTemplates() {
    const data = await requestJson('/api/sources/templates');
    templates = Array.isArray(data.templates) ? data.templates : [];
    sourceType.innerHTML = templates
      .map((item) => {
        const value = String(item.type || '').toUpperCase();
        const label = String(item.display_name || value);
        return '<option value="' + value + '">' + label + '</option>';
      })
      .join('');

    if (!sourceType.value) {
      sourceType.value = 'WEBSITE';
    }
    if (!sourceType.value && templates.length) {
      sourceType.value = String(templates[0].type || '').toUpperCase();
    }
    renderCredentialFields();
  }

  async function addSourceAndSync() {
    const safeTenant = normalizeTenant(tenantInput.value || tenantId);
    if (!safeTenant) {
      setStatus('Workspace ID is required.');
      return;
    }

    tenantId = safeTenant;
    localStorage.setItem('knowledgeos_active_tenant_id', tenantId);
    tenantInput.value = tenantId;
    renderEmbedScript();

    const selectedType = String(sourceType.value || 'WEBSITE').toUpperCase();
    const selectedName = String(sourceName.value || '').trim() || (selectedType === 'WEBSITE' ? 'Website' : selectedType + ' source');

    const payload = {
      name: selectedName,
      type: selectedType,
      site_url: String(sourceUrl.value || '').trim() || null,
      poll_minutes: 60,
      credentials: collectCredentials(),
    };

    addAndSyncBtn.disabled = true;
    addAndSyncBtn.textContent = 'Adding...';

    try {
      setStatus('Adding source...');
      const created = await requestJson('/api/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const sourceId = String(created && created.source && created.source.source_id || '').trim();
      if (!sourceId) throw new Error('Source was created but missing source_id.');

      const starter = String(starterBody.value || '').trim();
      const docs = starter
        ? [{
          title: String(starterTitle.value || 'Starter answer').trim(),
          body: starter,
          type: selectedType === 'WEBSITE' ? 'URL' : 'TEXT',
          visibility: selectedType === 'WEBSITE' ? 'PUBLIC' : 'INTERNAL',
          source_url: payload.site_url || undefined,
        }]
        : [];

      setStatus('Syncing source...');
      const syncResult = await requestJson('/api/sources/' + encodeURIComponent(sourceId) + '/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documents: docs }),
      });

      const syncedCount = Number(syncResult.synced_count || 0);
      setStatus('Ready. Source connected and synced.\nSource ID: ' + sourceId + '\nDocuments synced: ' + syncedCount + '\nYour embed can use this content now.');
      await refreshSources();
      renderEmbedScript();
    } catch (error) {
      setStatus('Could not complete source setup: ' + error.message);
    } finally {
      addAndSyncBtn.disabled = false;
      addAndSyncBtn.textContent = 'Add source and sync';
    }
  }

  tenantInput.addEventListener('change', () => {
    tenantId = normalizeTenant(tenantInput.value);
    tenantInput.value = tenantId;
    if (tenantId) localStorage.setItem('knowledgeos_active_tenant_id', tenantId);
    renderEmbedScript();
  });

  sourceType.addEventListener('change', renderCredentialFields);
  addAndSyncBtn.addEventListener('click', addSourceAndSync);

  refreshBtn.addEventListener('click', async () => {
    try {
      await refreshSources();
      setStatus('Sources refreshed.');
    } catch (error) {
      setStatus('Could not refresh sources: ' + error.message);
    }
  });

  copyScriptBtn.addEventListener('click', async () => {
    try {
      const script = String(embedScript.value || '').trim();
      if (!script) {
        setStatus('No embed script available yet.');
        return;
      }
      await navigator.clipboard.writeText(script);
      setStatus('Embed script copied.');
    } catch (_error) {
      setStatus('Could not copy script automatically.');
    }
  });

  openTesterBtn.addEventListener('click', () => {
    const safeTenant = normalizeTenant(tenantId || tenantInput.value);
    if (!safeTenant) {
      setStatus('Workspace ID is required to open the tester.');
      return;
    }
    window.location.href = '/embed-test.html?tenant_id=' + encodeURIComponent(safeTenant);
  });

  signOutBtn.addEventListener('click', async () => {
    try {
      await requestJson('/api/access/logout', { method: 'POST' });
      setAuthState('Access: signed out', false);
      if (typeof authContext.buildAccessUrl === 'function') {
        window.location.href = authContext.buildAccessUrl('/sources.html');
      } else {
        window.location.href = '/access.html?next=/sources.html';
      }
    } catch (_error) {
      setStatus('Could not sign out right now.');
    }
  });

  (async () => {
    tenantId = normalizeTenant(tenantId);
    if (tenantId) {
      tenantInput.value = tenantId;
      localStorage.setItem('knowledgeos_active_tenant_id', tenantId);
    }
    if (sessionToken) {
      localStorage.setItem('knowledgeos_admin_session_token', sessionToken);
    }

    renderEmbedScript();
    await refreshAccessStatus();
    if (tenantId) tenantInput.value = tenantId;
    renderEmbedScript();
    await loadTemplates();
    await refreshSources();
    setStatus('Ready. Add a source and sync.');
  })();
})();
