async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
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

async function refreshDocuments() {
  const output = document.getElementById('docsOutput');
  try {
    const data = await requestJson('/api/documents');
    output.textContent = format(data.documents);
  } catch (error) {
    output.textContent = error.message;
  }
}

async function refreshAnalytics() {
  const output = document.getElementById('analyticsOutput');
  try {
    const data = await requestJson('/api/admin/analytics');
    output.textContent = format(data.analytics);
  } catch (error) {
    output.textContent = error.message;
  }
}

async function refreshSources() {
  const output = document.getElementById('sourcesOutput');
  try {
    const data = await requestJson('/api/sources');
    output.textContent = format(data.sources);
  } catch (error) {
    output.textContent = error.message;
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

    try {
      await requestJson('/api/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      form.reset();
      await refreshDocuments();
    } catch (error) {
      alert(error.message);
    }
  });
}

function wireUrlDocForm() {
  const form = document.getElementById('urlDocForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    try {
      await requestJson('/api/documents/url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      form.reset();
      await refreshDocuments();
    } catch (error) {
      alert(error.message);
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
      await refreshDocuments();
    } catch (error) {
      alert(error.message);
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
      alert(`Invalid JSON: ${error.message}`);
      return;
    }

    try {
      const result = await requestJson('/api/documents/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      alert(`Imported ${result.inserted_count} documents (${result.rejected_count} rejected).`);
      await refreshDocuments();
    } catch (error) {
      alert(error.message);
    }
  });
}

function wireSourceForm() {
  const form = document.getElementById('sourceForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    payload.poll_minutes = Number(payload.poll_minutes || 60);

    try {
      await requestJson('/api/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      form.reset();
      await refreshSources();
    } catch (error) {
      alert(error.message);
    }
  });
}

function wireSourceSync() {
  const button = document.getElementById('syncSourceBtn');
  button.addEventListener('click', async () => {
    const sourceId = String(document.getElementById('syncSourceId').value || '').trim();
    if (!sourceId) {
      alert('source id is required');
      return;
    }

    const rawDocs = String(document.getElementById('syncDocuments').value || '').trim();
    let documents = [];
    if (rawDocs) {
      try {
        const parsed = JSON.parse(rawDocs);
        if (!Array.isArray(parsed)) throw new Error('must be an array');
        documents = parsed;
      } catch (error) {
        alert(`Invalid sync JSON: ${error.message}`);
        return;
      }
    }

    try {
      await requestJson(`/api/sources/${encodeURIComponent(sourceId)}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documents }),
      });
      await refreshSources();
      await refreshDocuments();
    } catch (error) {
      alert(error.message);
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

function main() {
  wireConsoleWizard();
  wireTextDocForm();
  wireUrlDocForm();
  wirePdfDocForm();
  wireBulkDocForm();
  wireSourceForm();
  wireSourceSync();
  wireCompile();

  document.getElementById('refreshDocs').addEventListener('click', refreshDocuments);
  document.getElementById('refreshAnalytics').addEventListener('click', refreshAnalytics);
  document.getElementById('refreshSources').addEventListener('click', refreshSources);

  refreshDocuments();
  refreshAnalytics();
  refreshSources();
}

main();
