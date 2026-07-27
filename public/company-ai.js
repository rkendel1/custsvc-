(function () {
  const script = document.currentScript;
  const bundleUrl = script?.dataset?.bundleUrl || '/bundles/company.intelligence.bundle.json';
  const apiBase = script?.dataset?.apiBase || '';
  const widgetTitle = script?.dataset?.title || 'Company Intelligence';
  const remoteFallbackUrl = script?.dataset?.remoteFallbackUrl || '';
  const minAnswerConfidence = Number(script?.dataset?.minAnswerConfidence || 0.1);
  const role = script?.dataset?.role || 'Customer';
  const department = script?.dataset?.department || '';
  const permissions = (script?.dataset?.permissions || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  const state = {
    bundle: null,
    history: [],
    context: {
      role,
      department,
      permissions,
    },
  };
  const audiencePriority = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, EXECUTIVE: 3 };
  const confidenceWeights = {
    // Weighted toward retrieval relevance while still incorporating governance signals.
    semantic: 0.35,
    freshness: 0.2,
    agreement: 0.2,
    reviewer: 0.25,
  };

  function normalizeAudience(value) {
    const item = String(value || '').toUpperCase();
    if (item in audiencePriority) return item;
    return 'INTERNAL';
  }

  function roleAudiences(ctxRole, ctxPermissions = []) {
    const roleValue = String(ctxRole || 'Customer').toLowerCase();
    const perms = new Set((ctxPermissions || []).map((x) => String(x).toLowerCase()));
    const map = {
      customer: ['PUBLIC'],
      partner: ['PUBLIC', 'INTERNAL'],
      support: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
      sales: ['PUBLIC', 'INTERNAL'],
      engineering: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
      hr: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
      finance: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
      operations: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
      executive: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'EXECUTIVE'],
      administrator: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'EXECUTIVE'],
    };
    const allowed = new Set(map[roleValue] || ['PUBLIC']);
    if (perms.has('view:confidential')) allowed.add('CONFIDENTIAL');
    if (perms.has('view:executive')) allowed.add('EXECUTIVE');
    return allowed;
  }

  function simpleHash(value) {
    let hash = 0;
    const input = String(value || '');
    for (let i = 0; i < input.length; i += 1) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }

  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  function termFrequency(tokens) {
    const tf = {};
    for (const token of tokens) {
      tf[token] = (tf[token] || 0) + 1;
    }
    return tf;
  }

  function magnitude(tf) {
    let sum = 0;
    for (const value of Object.values(tf)) sum += value * value;
    return Math.sqrt(sum);
  }

  function similarity(queryTf, queryMag, chunk) {
    if (!queryMag || !chunk.magnitude) return 0;
    let dot = 0;
    for (const [token, count] of Object.entries(queryTf)) {
      if (chunk.tf[token]) dot += count * chunk.tf[token];
    }
    return dot / (queryMag * chunk.magnitude);
  }

  function isVisible(chunk, context) {
    const allowedAudiences = roleAudiences(context.role, context.permissions);
    const chunkAudience = normalizeAudience(chunk.audience || chunk.visibility);
    if (!allowedAudiences.has(chunkAudience)) return false;
    const chunkDepartment = String(chunk.department || '').toLowerCase();
    const userDepartment = String(context.department || '').toLowerCase();
    if (!chunkDepartment || !userDepartment || chunkDepartment === userDepartment) return true;
    return (context.permissions || []).map((x) => String(x).toLowerCase()).includes('cross_department');
  }

  function freshnessScore(chunk) {
    const reviewedAt = new Date(chunk.last_reviewed || 0).getTime();
    const reviewFrequency = Number(chunk.review_frequency || 90);
    if (!reviewedAt || !Number.isFinite(reviewFrequency) || reviewFrequency <= 0) return 0.5;
    const ageDays = (Date.now() - reviewedAt) / (24 * 60 * 60 * 1000);
    return Math.max(0, Math.min(1, 1 - ageDays / reviewFrequency));
  }

  function relationshipAgreement(best, bundle) {
    const adjacency = bundle?.graph?.adjacency?.[best.knowledgeId] || [];
    if (!adjacency.length) return 0.5;
    let positive = 0;
    let negative = 0;
    for (const edge of adjacency) {
      if (edge.type === 'SUPPORTS' || edge.type === 'RELATED' || edge.type === 'IMPLEMENTS') positive += 1;
      if (edge.type === 'CONTRADICTS' || edge.type === 'DUPLICATE_OF') negative += 1;
    }
    return Math.max(0, Math.min(1, (positive + 1) / (positive + negative + 1)));
  }

  async function loadBundle() {
    if (state.bundle) return state.bundle;

    const cacheScope = `${window.location.origin}:${bundleUrl}`;
    const cacheKey = `company-intelligence:${simpleHash(cacheScope)}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        state.bundle = JSON.parse(cached);
      } catch (_e) {
        // ignore bad cache
      }
    }

    if (!state.bundle) {
      const response = await fetch(bundleUrl);
      if (!response.ok) throw new Error(`Could not load bundle (${response.status})`);
      state.bundle = await response.json();
      localStorage.setItem(cacheKey, JSON.stringify(state.bundle));
    }

    return state.bundle;
  }

  async function remoteFallback(question) {
    if (!remoteFallbackUrl) return null;
    try {
      const response = await fetch(remoteFallbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!data?.answer) return null;
      return { answer: data.answer, score: Number(data.score || 0), topChunkId: null };
    } catch (_e) {
      return null;
    }
  }

  async function answerQuestion(question) {
    const bundle = await loadBundle();
    const queryTokens = tokenize(question);
    const queryTf = termFrequency(queryTokens);
    const queryMag = magnitude(queryTf);

    let best = null;
    for (const chunk of bundle.chunks || []) {
      if (!isVisible(chunk, state.context)) continue;
      const score = similarity(queryTf, queryMag, chunk);
      if (!best || score > best.score) best = { chunk, score };
    }

    if (best && best.score >= minAnswerConfidence) {
      const fresh = freshnessScore(best.chunk);
      const agreement = relationshipAgreement(best.chunk, bundle);
      const reviewerConfidence = Number(best.chunk.confidence || 0.7);
      const confidence = Number((
        best.score * confidenceWeights.semantic +
        fresh * confidenceWeights.freshness +
        agreement * confidenceWeights.agreement +
        reviewerConfidence * confidenceWeights.reviewer
      ).toFixed(3));
      return {
        answer: best.chunk.text,
        score: best.score,
        confidence,
        confidenceBreakdown: {
          semantic: Number(best.score.toFixed(3)),
          freshness: Number(fresh.toFixed(3)),
          agreement: Number(agreement.toFixed(3)),
          reviewer: Number(reviewerConfidence.toFixed(3)),
        },
        topChunkId: best.chunk.id,
        answered: true,
      };
    }

    const fallback = await remoteFallback(question);
    if (fallback) return { ...fallback, answered: true };

    return {
      answer: "I don't have an answer for that yet.",
      score: best ? best.score : 0,
      confidence: best ? Number(best.score.toFixed(3)) : 0,
      topChunkId: best?.chunk?.id || null,
      answered: false,
    };
  }

  async function sendTelemetry(entry) {
    try {
      await fetch(`${apiBase}/api/telemetry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry),
      });
    } catch (_e) {
      // no-op
    }
  }

  function appendMessage(container, who, text) {
    const node = document.createElement('div');
    node.style.margin = '0.5rem 0';
    const label = document.createElement('strong');
    label.textContent = `${who}: `;
    node.appendChild(label);
    node.appendChild(document.createTextNode(text));
    container.appendChild(node);
    container.scrollTop = container.scrollHeight;
  }

  function createWidget() {
    const button = document.createElement('button');
    button.textContent = 'Ask';
    Object.assign(button.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      border: 'none',
      borderRadius: '999px',
      background: '#111827',
      color: '#fff',
      padding: '0.7rem 1rem',
      cursor: 'pointer',
      zIndex: 99999,
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      right: '20px',
      bottom: '70px',
      width: '360px',
      height: '460px',
      background: '#fff',
      border: '1px solid #d1d5db',
      borderRadius: '12px',
      boxShadow: '0 12px 30px rgba(0,0,0,0.18)',
      display: 'none',
      zIndex: 99999,
      overflow: 'hidden',
      fontFamily: 'Arial, sans-serif',
    });

    const header = document.createElement('div');
    header.textContent = widgetTitle;
    Object.assign(header.style, {
      background: '#111827',
      color: '#fff',
      padding: '0.65rem 0.8rem',
      fontWeight: 'bold',
    });

    const messages = document.createElement('div');
    Object.assign(messages.style, {
      height: '330px',
      overflowY: 'auto',
      padding: '0.8rem',
      background: '#f9fafb',
      fontSize: '14px',
    });

    const inputWrap = document.createElement('div');
    Object.assign(inputWrap.style, {
      display: 'flex',
      gap: '0.4rem',
      borderTop: '1px solid #e5e7eb',
      padding: '0.6rem',
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Ask a question...';
    Object.assign(input.style, {
      flex: 1,
      padding: '0.45rem',
      border: '1px solid #d1d5db',
      borderRadius: '8px',
    });

    const send = document.createElement('button');
    send.textContent = 'Send';
    Object.assign(send.style, {
      padding: '0.45rem 0.75rem',
      border: 'none',
      borderRadius: '8px',
      background: '#2563eb',
      color: '#fff',
      cursor: 'pointer',
    });

    async function onSend() {
      const question = input.value.trim();
      if (!question) return;
      input.value = '';
      appendMessage(messages, 'You', question);

      try {
        const response = await answerQuestion(question);
        appendMessage(messages, 'AI', response.answer);

        const answered = response.answered;
        state.history.push({ question, ...response, answered, at: new Date().toISOString() });

        sendTelemetry({
          question,
          answered,
          score: response.score,
          confidence: response.confidence || 0,
          topChunkId: response.topChunkId,
          role: state.context.role,
          department: state.context.department,
          permissions: state.context.permissions,
        });
      } catch (error) {
        appendMessage(messages, 'AI', `Unable to answer right now: ${error.message}`);
      }
    }

    send.addEventListener('click', onSend);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') onSend();
    });

    inputWrap.appendChild(input);
    inputWrap.appendChild(send);
    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(inputWrap);

    button.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      if (panel.style.display === 'block' && !messages.dataset.welcome) {
        appendMessage(messages, 'AI', 'Hi! Ask me anything about this company.');
        messages.dataset.welcome = 'true';
      }
    });

    document.body.appendChild(button);
    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createWidget);
  } else {
    createWidget();
  }
})();
