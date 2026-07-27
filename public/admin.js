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
        body: JSON.stringify({ name: 'company.intelligence.bundle.json' }),
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

function main() {
  wireTextDocForm();
  wireUrlDocForm();
  wirePdfDocForm();
  wireCompile();

  document.getElementById('refreshDocs').addEventListener('click', refreshDocuments);
  document.getElementById('refreshAnalytics').addEventListener('click', refreshAnalytics);

  refreshDocuments();
  refreshAnalytics();
}

main();
