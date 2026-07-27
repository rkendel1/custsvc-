(function () {
  const script = document.currentScript;
  const bundleUrl = script?.dataset?.bundleUrl || '/bundles/knowledgeos.bundle.json';
  const apiBase = script?.dataset?.apiBase || '';
  const tenantId = String(script?.dataset?.tenantId || '').trim().toLowerCase();
  const widgetTitle = script?.dataset?.title || 'KnowledgeOS Assistant';
  const remoteFallbackUrl = script?.dataset?.remoteFallbackUrl || '';
  const aiModeSetting = String(script?.dataset?.aiMode || 'RETRIEVAL_ONLY').toUpperCase();
  const telemetryIncludeContent = String(script?.dataset?.telemetryIncludeContent || '').toLowerCase() === 'true';
  const minAnswerConfidence = Number(script?.dataset?.minAnswerConfidence || 0.1);
  const role = script?.dataset?.role || 'Customer';
  const department = script?.dataset?.department || '';
  const pgliteModuleUrl = script?.dataset?.pgliteModuleUrl || '/vendor/pglite/index.js';
  const preloadModel = String(script?.dataset?.preloadModel || 'true').toLowerCase() !== 'false';
  const modelEngineUrl = script?.dataset?.modelEngineUrl || 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
  const permissions = (script?.dataset?.permissions || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  function resolveApiBaseFromBundleUrl() {
    if (apiBase) return apiBase;
    if (!tenantId) return '';
    if (!String(bundleUrl || '').includes('/api/embed/bundle')) return '';
    try {
      const parsed = new URL(bundleUrl, window.location.href);
      return parsed.origin;
    } catch (_error) {
      return '';
    }
  }

  const effectiveApiBase = resolveApiBaseFromBundleUrl();

  const state = {
    bundle: null,
    history: [],
    session: {
      turns: [],
      subject: null,
      topics: [],
    },
    executions: {},
    context: {
      role,
      department,
      permissions,
    },
    ai: {
      initialized: false,
      model: null,
      mode: aiModeSetting,
      modelStatus: {},
      localEngine: null,
    },
    pglite: {
      initialized: false,
      ready: false,
      rows: 0,
      error: null,
      db: null,
      chunkById: new Map(),
    },
    warmup: {
      started: false,
      completed: false,
      error: null,
    },
    embedSession: {
      token: null,
      expiresAt: 0,
    },
  };
    async function getEmbedSessionToken(forceRefresh = false) {
      if (!tenantId || !effectiveApiBase) return null;
      const now = Date.now();
      if (!forceRefresh && state.embedSession.token && state.embedSession.expiresAt - now > 5_000) {
        return state.embedSession.token;
      }

      const response = await fetch(`${effectiveApiBase}/api/embed/session?tenant_id=${encodeURIComponent(tenantId)}`);
      if (!response.ok) {
        throw new Error(`Unable to establish secure embed session (${response.status})`);
      }
      const data = await response.json();
      const expiresAt = Date.parse(String(data?.expires_at || ''));
      state.embedSession.token = String(data?.token || '');
      state.embedSession.expiresAt = Number.isFinite(expiresAt) ? expiresAt : now + 5 * 60 * 1000;
      return state.embedSession.token || null;
    }

  const AI_MODE = {
    LOCAL: 'LOCAL',
    RETRIEVAL_ONLY: 'RETRIEVAL_ONLY',
    REMOTE_FALLBACK: 'REMOTE_FALLBACK',
    DISABLED: 'DISABLED',
  };
  // 4GB is the minimum threshold used by the runtime for selecting medium local models.
  const MIN_MEMORY_GB_FOR_MEDIUM_MODEL = 4;

  function normalizeAiMode(value) {
    const candidate = String(value || AI_MODE.LOCAL).toUpperCase();
    return AI_MODE[candidate] ? candidate : AI_MODE.LOCAL;
  }

  state.ai.mode = normalizeAiMode(state.ai.mode);
  const audiencePriority = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, EXECUTIVE: 3 };
  const confidenceWeights = {
    // Weighted toward retrieval relevance while still incorporating governance signals.
    semantic: 0.35,
    freshness: 0.2,
    agreement: 0.2,
    reviewer: 0.25,
  };
  const intentConfidence = {
    refund_request: 0.96,
    cancel_request: 0.9,
    billing_question: 0.86,
    general_question: 0.72,
  };

  function normalizeAudience(value) {
    const item = String(value || '').toUpperCase();
    if (item in audiencePriority) return item;
    return 'INTERNAL';
  }

  function normalizeStepType(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '_');
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

  function getAudienceContext(context = state.context) {
    const roleValue = String(context.role || 'Customer').toLowerCase();
    if (roleValue === 'customer' || roleValue === 'partner') return 'customer';
    if (roleValue === 'executive' || roleValue === 'administrator') return 'executive';
    if (roleValue === 'manager') return 'manager';
    return 'employee';
  }

  function getStorageProfile(bundle = state.bundle) {
    if (bundle?.storage_profile && Array.isArray(bundle.storage_profile.stores)) return bundle.storage_profile;
    return {
      mode: 'browser-local',
      stores: [{ id: 'public', type: 'browser-local', audiences: ['customer'] }],
    };
  }

  function hasStorePermission(store, context = state.context) {
    const required = Array.isArray(store?.permissions) ? store.permissions : [];
    if (!required.length) return true;
    const available = new Set((context.permissions || []).map((item) => String(item).toLowerCase()));
    return required.every((item) => available.has(String(item).toLowerCase()));
  }

  function storeSupportsAudience(store, audience) {
    const audiences = Array.isArray(store?.audiences) ? store.audiences : [];
    if (!audiences.length) return true;
    return audiences.map((item) => String(item).toLowerCase()).includes(String(audience).toLowerCase());
  }

  function getKnowledgeSource(chunk, bundle = state.bundle) {
    const profile = getStorageProfile(bundle);
    const chunkAudience = normalizeAudience(chunk?.audience || chunk?.visibility).toLowerCase();
    const stores = (profile.stores || []).map((store) => ({
      ...store,
      normalizedAudiences: (Array.isArray(store?.audiences) ? store.audiences : [])
        .map((item) => String(item).toLowerCase()),
    }));
    const mapped = stores.find((store) => {
      if (!store.normalizedAudiences?.length) return false;
      return store.normalizedAudiences.includes(chunkAudience);
    });
    return mapped || stores[0] || { id: 'public', type: 'browser-local', audiences: ['customer'] };
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

  function decodeHtmlEntities(text) {
    const value = String(text || '');
    if (!value || typeof document === 'undefined') return value;
    const node = document.createElement('textarea');
    node.innerHTML = value;
    return String(node.value || '');
  }

  function cleanRetrievedText(text) {
    const decoded = decodeHtmlEntities(text);
    return decoded
      .replace(/\bContext:\s*/gi, ' ')
      .replace(/\bQuestion:\s*/gi, ' ')
      .replace(/\bAnswer:\s*/gi, ' ')
      .replace(/\bYou are a concise company assistant\.?/gi, ' ')
      .replace(/\bAnswer only from the provided context\.?/gi, ' ')
      .replace(/form\.antibot[^\n]*?/gi, ' ')
      .replace(/\(function\(w,d,s,l,i\)\{[\s\S]*?\}\)\(window,document,'script','dataLayer','GTM-[A-Z0-9]+'\);?/gi, ' ')
      .replace(/"@context"\s*:\s*"https:\/\/schema\.org"[\s\S]{0,2500}/gi, ' ')
      .replace(/\{\s*"@type"\s*:\s*"(?:WebPage|WebSite|Article|WebApplication)"[\s\S]{0,1400}\}/gi, ' ')
      .replace(/\b(skip to main content|breadcrumb|dmv practice tests|permit practice test|road signs practice test)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();
  }

  function splitIntoSentences(text) {
    const input = cleanRetrievedText(text);
    if (!input) return [];
    return input
      .split(/(?<=[.!?])\s+|\s+[-|]\s+|\s*\n+\s*/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function normalizeSentence(line) {
    return cleanRetrievedText(line)
      .replace(/^[-*•\u2022\s]+/, '')
      .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hasSuspiciousTruncation(line) {
    const value = String(line || '').trim();
    if (!value) return true;
    const lower = value.toLowerCase();
    if (/--\s*\d+\s*of\s*\d+\s*--/i.test(lower)) return true;
    if (/(\b(and|or|with|including|into|to|for|in|on|at)\s*)$/i.test(value)) return true;

    // Ends with an unusually short dangling token without punctuation, often from clipped text.
    if (!/[.!?)]$/.test(value)) {
      const lastTokenMatch = value.match(/([a-z0-9]{1,3})$/i);
      if (lastTokenMatch && !['api', 'ai', 'ml', 'aws', 'ios'].includes(lastTokenMatch[1].toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  function ensureTerminalPunctuation(line) {
    const value = String(line || '').trim();
    if (!value) return value;
    if (/[.!?)]$/.test(value)) return value;
    return `${value}.`;
  }

  function isLikelyBoilerplateLine(line) {
    const normalized = String(line || '').toLowerCase();
    if (!normalized) return true;
    if (normalized.length < 18) return true;
    return (
      normalized.includes('/ work / about / accomplishments / contact')
      || normalized.includes('you are a concise company assistant')
      || normalized.includes('answer only from the provided context')
      || normalized.includes('available for new work')
      || normalized.includes('view work get in touch')
      || normalized.includes('knowledgeos is live on this page')
      || normalized.includes('use the ask button to ask questions')
      || normalized.includes('live trythissoftware')
      || normalized.includes('backendvoid')
      || normalized.includes('web3 digital assets')
      || normalized.includes('run button for the internet')
      || normalized.includes('hide your secrets within your messages')
      || normalized.includes('local-first privacy web workers wasm')
      || normalized.includes('form.antibot')
      || normalized.includes('googletagmanager')
      || normalized.includes('dataLayer')
      || normalized.includes('@context')
      || normalized.includes('schema.org')
      || normalized.includes('breadcrumb')
      || normalized.includes('skip to main content')
      || normalized.includes('dmv practice tests')
      || normalized.includes('practice test')
      || normalized.includes('motorcycle permit')
      || normalized.includes('multiple-choice questions')
      || normalized.includes('questions you answered incorrectly')
    );
  }

  function looksLowQualityGeneratedAnswer(text) {
    const value = cleanRetrievedText(text);
    const lower = value.toLowerCase();
    if (!value) return true;
    if (lower.includes('you are a concise company assistant') || lower.includes('context:')) return true;
    const tokens = tokenize(value);
    if (tokens.length < 8) return false;

    // Detect repeated 6-token sequences to suppress looping generations.
    const seen = new Set();
    for (let i = 0; i <= tokens.length - 6; i += 1) {
      const phrase = tokens.slice(i, i + 6).join(' ');
      if (seen.has(phrase)) return true;
      seen.add(phrase);
    }
    return false;
  }

  function extractYearsExperience(question, chunkText) {
    const q = String(question || '').toLowerCase();
    const asksYears = q.includes('year') && (q.includes('experience') || q.includes('exp'));
    if (!asksYears) return null;

    const cleaned = cleanRetrievedText(chunkText);
    const patterns = [
      /(\d+\+?)\s+years?\b[^.]{0,90}(building|experience|leading|scaling)/i,
      /(\d+\+?)\s+years?\b/i,
    ];
    for (const pattern of patterns) {
      const match = cleaned.match(pattern);
      if (match?.[1]) {
        return `Randy has ${match[1]} years of experience.`;
      }
    }
    return null;
  }

  function extractQuestionKeywords(question) {
    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'does', 'have', 'what', 'how', 'many',
      'much', 'tell', 'me', 'is', 'are', 'in', 'on', 'at', 'to', 'of', 'a', 'an', 'it', 'as', 'by', 'be', 'has', 'who',
      'need', 'needs', 'want', 'wants', 'old', 'older', 'get', 'getting', 'like', 'just', 'can', 'could',
    ]);
    return tokenize(question).filter((token) => token.length > 2 && !stopWords.has(token));
  }

  function extractAnchorKeywords(question) {
    const weakKeywords = new Set([
      'question', 'questions', 'answer', 'answers', 'help', 'information', 'details', 'general', 'company',
      'policy', 'process', 'thing', 'things', 'need', 'want', 'know', 'tell',
    ]);
    return extractQuestionKeywords(question)
      .filter((token) => token.length >= 4)
      .filter((token) => !weakKeywords.has(token));
  }

  function sentenceRelevance(question, sentence) {
    const questionKeywords = extractQuestionKeywords(question);
    const anchorKeywords = extractAnchorKeywords(question);
    const sentenceTokenSet = new Set(tokenize(sentence));

    let overlap = 0;
    for (const token of questionKeywords) {
      if (sentenceTokenSet.has(token)) overlap += 1;
    }

    let anchorOverlap = 0;
    for (const token of anchorKeywords) {
      if (sentenceTokenSet.has(token)) anchorOverlap += 1;
    }

    const coverage = questionKeywords.length ? overlap / questionKeywords.length : 0;
    return { overlap, anchorOverlap, coverage, anchorCount: anchorKeywords.length };
  }

  function isResultRelevantToQuestion(question, text, score = 0) {
    const normalizedQuestion = String(question || '').toLowerCase();
    const normalizedText = String(text || '').toLowerCase();
    const asksExperience = normalizedQuestion.includes('experience') || normalizedQuestion.includes('exp');
    if (asksExperience && /\b\d+\+?\s+years?\b/i.test(normalizedText)) return true;

    const stats = sentenceRelevance(question, text);
    if (stats.anchorCount > 0) {
      if (stats.anchorOverlap >= 1) return true;
      if (stats.overlap >= 2 && stats.coverage >= 0.35) return true;
      return Number(score || 0) >= 0.88;
    }
    if (stats.overlap >= 2 && stats.coverage >= 0.3) return true;
    return Number(score || 0) >= 0.9;
  }

  function hasExplicitSubject(question) {
    const value = String(question || '').trim();
    if (!value) return false;
    if (/\brandy\b/i.test(value)) return true;
    return /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/.test(value);
  }

  function isFollowUpQuestion(question) {
    const value = String(question || '').trim();
    if (!value) return false;
    const lower = value.toLowerCase();
    if (/\b(he|she|they|him|her|them|his|their|it|this|that|those|these)\b/.test(lower)) return true;
    if (/^(and|also|what about|how about|can you expand|tell me more)/.test(lower)) return true;
    const keywords = extractQuestionKeywords(value);
    return !hasExplicitSubject(value) && keywords.length <= 8;
  }

  function extractSubjectFromText(text) {
    const value = String(text || '');
    if (!value) return null;
    if (/\brandy\s+kendel\b/i.test(value)) return 'Randy Kendel';
    if (/\brandy\b/i.test(value)) return 'Randy';

    const match = value.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
    if (!match?.[1]) return null;
    const candidate = String(match[1]).trim();
    if (['Here', 'Based', 'Question', 'Answer', 'Context'].includes(candidate)) return null;
    return candidate;
  }

  function updateSessionMemory(question, response = {}) {
    const turn = {
      question: String(question || '').trim(),
      answer: String(response?.answer || '').trim(),
      intent: String(response?.intent || 'general_question'),
      at: new Date().toISOString(),
    };
    state.session.turns.push(turn);
    if (state.session.turns.length > 12) {
      state.session.turns = state.session.turns.slice(-12);
    }

    const subject = extractSubjectFromText(turn.question) || extractSubjectFromText(turn.answer);
    if (subject) state.session.subject = subject;

    const nextTopics = [...extractQuestionKeywords(turn.question), ...extractQuestionKeywords(turn.answer)].slice(0, 20);
    const topicSet = new Set([...(state.session.topics || []), ...nextTopics]);
    state.session.topics = [...topicSet].slice(-30);
  }

  function buildSessionAwareQuestion(question) {
    const input = String(question || '').trim();
    if (!input) return input;
    if (!isFollowUpQuestion(input)) return input;

    const subject = String(state.session.subject || '').trim();
    const topicHints = (state.session.topics || []).slice(-6).join(' ');
    let effective = input;

    if (subject && !new RegExp(`\\b${subject.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(input)) {
      effective = `${input} about ${subject}`;
    }

    if (topicHints && !/\babout\b/i.test(effective)) {
      effective = `${effective} (${topicHints})`;
    }

    return effective;
  }

  function isLikelyPromotionalNoise(line) {
    const normalized = String(line || '').toLowerCase();
    const noiseMarkers = [
      'live',
      'try this',
      'trythissoftware',
      'run button',
      'zero infrastructure',
      'saas without servers',
      'hide secrets',
      'product',
      'platform',
    ];
    let hits = 0;
    for (const marker of noiseMarkers) {
      if (normalized.includes(marker)) hits += 1;
    }
    return hits >= 2;
  }

  function scoreSentence(question, sentence) {
    const normalizedQuestion = String(question || '').toLowerCase();
    const normalizedSentence = String(sentence || '').toLowerCase();
    const questionKeywords = extractQuestionKeywords(normalizedQuestion);
    const sentenceTokens = new Set(tokenize(normalizedSentence));
    const { anchorOverlap, anchorCount } = sentenceRelevance(normalizedQuestion, normalizedSentence);

    let overlap = 0;
    for (const token of questionKeywords) {
      if (sentenceTokens.has(token)) overlap += 1;
    }

    let score = overlap * 3;
    if (normalizedQuestion.includes('randy') && normalizedSentence.includes('randy')) score += 3;
    if (normalizedQuestion.includes('experience') && normalizedSentence.includes('year')) score += 3;
    if (normalizedQuestion.includes('experience') && /\b\d+\+?\s+years?\b/i.test(sentence)) score += 5;
    if (normalizedQuestion.includes('experience') && /\b(email|contact|linkedin|github)\b/i.test(normalizedSentence)) score -= 5;
    if (normalizedQuestion.includes('project management') && normalizedSentence.includes('project')) score += 3;
    if (normalizedQuestion.includes('project management') && normalizedSentence.includes('program management')) score += 2;
    if (/\b\d+\+?\s+years?\b/i.test(sentence)) score += 2;
    if (isLikelyPromotionalNoise(sentence)) score -= 4;
    if (isLikelyBoilerplateLine(sentence)) score -= 6;
    if (anchorCount > 0 && anchorOverlap === 0) score -= 5;
    return score;
  }

  function chooseBestSentences(question, corpusText, limit = 3) {
    const seen = new Set();
    const candidates = splitIntoSentences(corpusText)
      .map((line) => normalizeSentence(line))
      .filter(Boolean)
      .filter((line) => !isLikelyBoilerplateLine(line))
      .filter((line) => !hasSuspiciousTruncation(line))
      .filter((line) => isResultRelevantToQuestion(question, line, 0))
      .map((line) => ({ line, score: scoreSentence(question, line) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const selected = [];
    for (const item of candidates) {
      const key = item.line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(item.line);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  function buildProductsAnswer(question, corpusText) {
    const normalizedQuestion = String(question || '').toLowerCase();
    const asksProducts = (
      normalizedQuestion.includes('product')
      || normalizedQuestion.includes('products')
      || normalizedQuestion.includes('created')
      || normalizedQuestion.includes('built')
      || normalizedQuestion.includes('launched')
    );
    if (!asksProducts) return null;

    const candidates = chooseBestSentences(question, corpusText, 10)
      .filter((line) => {
        const lower = line.toLowerCase();
        return (
          lower.includes('created')
          || lower.includes('built')
          || lower.includes('launched')
          || lower.includes('shipped')
          || lower.includes('platform')
          || lower.includes('product')
        );
      });

    const picked = [];
    for (const line of candidates) {
      const normalized = ensureTerminalPunctuation(normalizeSentence(line));
      if (!normalized || hasSuspiciousTruncation(normalized)) continue;
      if (picked.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) continue;
      picked.push(normalized);
      if (picked.length >= 3) break;
    }

    if (!picked.length) return null;
    return `Based on the indexed profile, here are the products and initiatives mentioned:\n- ${picked.join('\n- ')}`;
  }

  function buildExperienceAnswer(question, corpusText) {
    const normalizedQuestion = String(question || '').toLowerCase();
    if (!normalizedQuestion.includes('experience')) return null;

    const fullCorpus = cleanRetrievedText(corpusText);
    const directMatch = fullCorpus.match(/\b(\d+\+?)\s+years?\b[^.]{0,120}(experience|building|leading|scaling|engineering|software|product|delivery)?/i);
    if (directMatch?.[1]) {
      if (normalizedQuestion.includes('project management') || normalizedQuestion.includes('program management')) {
        return `Randy has ${directMatch[1]} years of experience, including hands-on project and program management.`;
      }
      return `Randy has ${directMatch[1]} years of experience.`;
    }

    const sentences = chooseBestSentences(question, corpusText, 6);
    for (const sentence of sentences) {
      const yearsMatch = sentence.match(/\b(\d+\+?)\s+years?\b/i);
      if (!yearsMatch?.[1]) continue;

      if (normalizedQuestion.includes('project management') || normalizedQuestion.includes('program management')) {
        return `Randy has ${yearsMatch[1]} years of experience, including hands-on project and program management.`;
      }
      return `Randy has ${yearsMatch[1]} years of experience.`;
    }
    return null;
  }

  function formatDeterministicAnswer(question, chunkText) {
    const yearsAnswer = extractYearsExperience(question, chunkText);
    if (yearsAnswer) return yearsAnswer;

    const experienceAnswer = buildExperienceAnswer(question, chunkText);
    if (experienceAnswer) return experienceAnswer;

    const productsAnswer = buildProductsAnswer(question, chunkText);
    if (productsAnswer) return productsAnswer;

    const candidates = chooseBestSentences(question, chunkText, 6);

    const picked = [];
    for (const line of candidates) {
      if (picked.some((existing) => existing.toLowerCase() === line.toLowerCase())) continue;
      picked.push(line);
      if (picked.length >= 3) break;
    }

    if (!picked.length) {
      return "I don't have an answer for that yet.";
    }

    const complete = picked
      .map((line) => ensureTerminalPunctuation(normalizeSentence(line)))
      .filter((line) => line && !hasSuspiciousTruncation(line));
    return `Here is what I found:\n- ${complete.join('\n- ')}`;
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
    const cacheKey = `knowledgeos:${simpleHash(cacheScope)}`;
    let cachedBundle = null;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        cachedBundle = JSON.parse(cached);
      } catch (_e) {
        // ignore bad cache
      }
    }

    async function fetchBundleOnce(forceSessionRefresh = false) {
      const headers = {};
      if (tenantId && bundleUrl.includes('/api/embed/bundle')) {
        const token = await getEmbedSessionToken(forceSessionRefresh);
        if (token) headers['x-embed-token'] = token;
      }
      return fetch(bundleUrl, { headers, cache: 'no-store' });
    }

    try {
      let response = await fetchBundleOnce(false);
      if (response.status === 401 && tenantId && bundleUrl.includes('/api/embed/bundle')) {
        state.embedSession.token = null;
        state.embedSession.expiresAt = 0;
        response = await fetchBundleOnce(true);
      }
      if (!response.ok) throw new Error(`Could not load bundle (${response.status})`);
      state.bundle = await response.json();
      localStorage.setItem(cacheKey, JSON.stringify(state.bundle));
    } catch (error) {
      if (cachedBundle) {
        state.bundle = cachedBundle;
      } else {
        throw error;
      }
    }

    return state.bundle;
  }

  async function initializePGlite(bundle) {
    if (state.pglite.initialized) return state.pglite;
    state.pglite.initialized = true;

    if (typeof indexedDB === 'undefined') {
      state.pglite.error = 'indexeddb_unavailable';
      return state.pglite;
    }

    try {
      const module = await import(pgliteModuleUrl);
      const PGlite = module?.PGlite;
      if (!PGlite) throw new Error('PGlite export not found');

      const dbName = `idb://knowledgeos-${simpleHash(bundle?.company || 'default')}`;
      const db = new PGlite(dbName);
      await db.query(`
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
          id TEXT PRIMARY KEY,
          knowledge_id TEXT,
          text TEXT,
          audience TEXT,
          visibility TEXT,
          department TEXT,
          confidence REAL,
          last_reviewed TEXT,
          review_frequency INTEGER
        )
      `);
      await db.query('DELETE FROM knowledge_chunks');

      const chunks = Array.isArray(bundle?.chunks) ? bundle.chunks : [];
      for (const chunk of chunks) {
        await db.query(
          `INSERT INTO knowledge_chunks (id, knowledge_id, text, audience, visibility, department, confidence, last_reviewed, review_frequency)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            String(chunk.id || ''),
            String(chunk.knowledgeId || ''),
            String(chunk.text || ''),
            String(chunk.audience || ''),
            String(chunk.visibility || ''),
            String(chunk.department || ''),
            Number(chunk.confidence || 0.7),
            chunk.last_reviewed ? String(chunk.last_reviewed) : null,
            Number(chunk.review_frequency || 90),
          ],
        );
      }

      const byId = new Map();
      for (const chunk of chunks) byId.set(String(chunk.id), chunk);

      state.pglite.db = db;
      state.pglite.ready = true;
      state.pglite.rows = chunks.length;
      state.pglite.chunkById = byId;
      return state.pglite;
    } catch (error) {
      state.pglite.error = error?.message || 'pglite_init_failed';
      return state.pglite;
    }
  }

  async function warmupRuntime() {
    if (state.warmup.started) return;
    state.warmup.started = true;
    try {
      const bundle = await loadBundle();
      await initializeAI();
      if (preloadModel && state.ai.model && state.ai.mode !== AI_MODE.DISABLED) {
        try {
          await downloadModel();
        } catch (_error) {
          // Keep retrieval runtime available even if model preload fails.
        }
      }
      await initializePGlite(bundle);
      state.warmup.completed = true;
    } catch (error) {
      state.warmup.error = error?.message || 'runtime_warmup_failed';
    }
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

  function getProcess(bundle, processId) {
    return (bundle?.processes || []).find((item) => item.id === processId) || null;
  }

  function getCapability(bundle, capabilityId) {
    return (bundle?.capabilities || []).find((item) => matchesCapabilityId(item, capabilityId)) || null;
  }

  function matchesCapabilityId(item, capabilityId) {
    return typeof item === 'string' ? item === capabilityId : item?.id === capabilityId;
  }

  function listCapabilities(context = state.context) {
    const bundle = state.bundle || {};
    const userPermissions = new Set((context.permissions || []).map((item) => String(item)));
    return (bundle.capabilities || []).filter((capability) => {
      if (typeof capability === 'string') return true;
      if (!capability.permissions || capability.permissions.length === 0) return true;
      return capability.permissions.some((permission) => userPermissions.has(permission));
    });
  }

  function getExecutionHistory(executionId) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    return [...(execution.timeline || [])];
  }

  function executeCapability(executionId, capabilityId, input = {}) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    const capability = getCapability(state.bundle || {}, capabilityId);
    if (!capability) throw new Error(`unknown capability: ${capabilityId}`);
    const result = { outputs: input, external_ref: null };
    execution.outputs = { ...(execution.outputs || {}), [capabilityId]: result.outputs };
    execution.history.push({ stepId: execution.currentStepId, action: 'EXECUTE_CAPABILITY', capabilityId, at: new Date().toISOString() });
    execution.timeline = execution.timeline || [];
    execution.timeline.push({ event: 'CAPABILITY_EXECUTED', capabilityId, at: new Date().toISOString() });
    return result;
  }

  function updateApproval(executionId, approvalId, decision, reason = null) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    const approvals = execution.approvals || [];
    const approval = approvals.find((item) => item.id === approvalId);
    if (!approval) throw new Error('approval not found');
    if (approval.decision !== 'PENDING') throw new Error('approval already decided');
    approval.decision = decision;
    approval.reason = reason;
    approval.decidedAt = new Date().toISOString();
    execution.status = decision === 'APPROVED' ? 'ACTIVE' : 'CANCELLED';
    execution.timeline = execution.timeline || [];
    execution.timeline.push({ event: `APPROVAL_${decision}`, approvalId, at: new Date().toISOString() });
    return execution;
  }

  function approve(executionId, approvalId, reason = null) {
    return updateApproval(executionId, approvalId, 'APPROVED', reason);
  }

  function reject(executionId, approvalId, reason = null) {
    return updateApproval(executionId, approvalId, 'REJECTED', reason);
  }

  async function startProcess(processId, context = {}) {
    const bundle = await loadBundle();
    const process = getProcess(bundle, processId);
    if (!process) throw new Error('process not found');
    if (!process.steps?.length) throw new Error('process has no steps');
    const executionId = `${processId}:${Date.now()}`;
    const execution = {
      id: executionId,
      processId,
      status: 'ACTIVE',
      context,
      currentStepId: process.steps[0].id,
      history: [],
      approvals: [],
      outputs: {},
      timeline: [{ event: 'PROCESS_STARTED', at: new Date().toISOString(), processId }],
      startedAt: new Date().toISOString(),
    };
    state.executions[executionId] = execution;
    return execution;
  }

  function resumeProcess(executionId) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    if (execution.status === 'CANCELLED') throw new Error('process is cancelled');
    if (execution.status === 'COMPLETED') throw new Error('process is completed');
    execution.status = 'ACTIVE';
    return execution;
  }

  async function validateStep(executionId, payload = {}) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    const bundle = await loadBundle();
    const process = getProcess(bundle, execution.processId);
    const current = (process?.steps || []).find((step) => step.id === execution.currentStepId);
    if (!current) return { ok: false, reason: 'step not found' };
    if (current.required_capability && !(payload.capabilities || []).includes(current.required_capability)) {
      return { ok: false, reason: `missing capability: ${current.required_capability}` };
    }
    return { ok: true };
  }

  async function completeStep(executionId, payload = {}) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    const validation = await validateStep(executionId, payload);
    if (!validation.ok) throw new Error(validation.reason);
    const bundle = await loadBundle();
    const process = getProcess(bundle, execution.processId);
    const current = (process?.steps || []).find((step) => step.id === execution.currentStepId);
    if (normalizeStepType(current?.type) === 'APPROVAL') {
      const approvalsForStep = (execution.approvals || []).filter((item) => item.stepId === current.id);
      const pending = approvalsForStep.find((item) => item.decision === 'PENDING');
      if (pending) throw new Error('approval pending');
      const approved = approvalsForStep.find((item) => item.decision === 'APPROVED');
      if (!approved) {
        const approval = {
          id: `${execution.id}:${current.id}:${Date.now()}`,
          stepId: current.id,
          assigned_role: current.required_role || null,
          decision: 'PENDING',
          reason: null,
          createdAt: new Date().toISOString(),
        };
        execution.approvals.push(approval);
        execution.status = 'WAITING_APPROVAL';
        execution.history.push({ stepId: execution.currentStepId, action: 'REQUEST_APPROVAL', at: new Date().toISOString() });
        execution.timeline = [...(execution.timeline || []), { event: 'APPROVAL_REQUESTED', approvalId: approval.id, at: new Date().toISOString() }];
        return execution;
      }
      execution.status = 'ACTIVE';
    }
    if (normalizeStepType(current?.type) === 'ACTION' && current?.capability) {
      executeCapability(executionId, current.capability, payload.inputs || {});
    }
    const nextStepId = current?.next?.[0] || null;
    execution.history.push({ stepId: execution.currentStepId, action: 'COMPLETE', at: new Date().toISOString() });
    if (!nextStepId || normalizeStepType(current?.type) === 'FINISH') {
      execution.status = 'COMPLETED';
      execution.completedAt = new Date().toISOString();
      return execution;
    }
    execution.currentStepId = nextStepId;
    return execution;
  }

  async function branch(executionId, nextStepId) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    const bundle = await loadBundle();
    const process = getProcess(bundle, execution.processId);
    const current = (process?.steps || []).find((step) => step.id === execution.currentStepId);
    if (!current?.next?.includes(nextStepId)) throw new Error('invalid branch target');
    execution.history.push({ stepId: execution.currentStepId, action: 'BRANCH', at: new Date().toISOString() });
    execution.currentStepId = nextStepId;
    return execution;
  }

  function rollback(executionId) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    const history = [...execution.history];
    const previous = history.pop();
    if (!previous) return execution;
    execution.history = history;
    execution.status = 'ACTIVE';
    execution.currentStepId = previous.stepId;
    execution.completedAt = null;
    return execution;
  }

  function cancel(executionId) {
    const execution = state.executions[executionId];
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    execution.status = 'CANCELLED';
    execution.cancelledAt = new Date().toISOString();
    return execution;
  }

  function detectIntent(question) {
    const q = String(question || '').toLowerCase();
    if (q.includes('refund')) return { intent: 'refund_request', confidence: intentConfidence.refund_request };
    if (q.includes('cancel')) return { intent: 'cancel_request', confidence: intentConfidence.cancel_request };
    if (q.includes('billing') || q.includes('invoice')) {
      return { intent: 'billing_question', confidence: intentConfidence.billing_question };
    }
    return { intent: 'general_question', confidence: intentConfidence.general_question };
  }

  function initializeAiIfNeeded(bundle) {
    if (state.ai.initialized) return;
    state.ai.model = (bundle?.models || []).find((item) => item.runtime === 'wasm' && item.type === 'llm') || null;
    state.ai.mode = normalizeAiMode(state.ai.mode);
    state.ai.initialized = true;
  }

  function detectAICompatibility() {
    return {
      wasm: typeof WebAssembly !== 'undefined',
      wasm_simd: true,
      webgpu: Boolean(navigator.gpu),
      memory_available_mb: Math.round(Number(navigator.deviceMemory || 4) * 1024),
      recommended_model: Number(navigator.deviceMemory || 4) >= MIN_MEMORY_GB_FOR_MEDIUM_MODEL
        ? 'company-assistant-medium'
        : 'company-assistant-small',
    };
  }

  async function initializeAI() {
    const bundle = await loadBundle();
    initializeAiIfNeeded(bundle);
    if (!state.ai.model) state.ai.mode = AI_MODE.RETRIEVAL_ONLY;
    if (state.ai.model && !isTransformersModel(state.ai.model)) state.ai.mode = AI_MODE.RETRIEVAL_ONLY;
    if (state.ai.mode === AI_MODE.DISABLED) state.ai.model = null;
    return getAIStatus();
  }

  function isTransformersModel(model) {
    const engine = String(model?.engine || '').toLowerCase();
    return engine === 'transformers.js' || engine === 'transformersjs';
  }

  async function ensureTransformersEngine(model = state.ai.model) {
    if (!model) throw new Error('model not found');
    if (!isTransformersModel(model)) return null;

    if (state.ai.localEngine && state.ai.localEngine.modelId === model.id) {
      return state.ai.localEngine;
    }

    const moduleUrl = model.engine_url || modelEngineUrl;
    const modelRepo = model.model_repo || model?.artifact?.repository;
    if (!modelRepo) throw new Error('model repository is not configured');

    const transformers = await import(moduleUrl);
    if (typeof transformers.pipeline !== 'function') {
      throw new Error('transformers pipeline API unavailable');
    }

    const task = model.task || 'text-generation';
    const pipeline = await transformers.pipeline(task, modelRepo);
    state.ai.localEngine = {
      modelId: model.id,
      task,
      modelRepo,
      moduleUrl,
      pipeline,
    };
    return state.ai.localEngine;
  }

  async function generateWithLocalModel(question, contextText = '') {
    const model = state.ai.model;
    if (!model || state.ai.mode !== AI_MODE.LOCAL) return null;
    if (!isTransformersModel(model)) return null;

    const runtime = await ensureTransformersEngine(model);
    const prompt = [
      'You are a concise company assistant. Answer only from the provided context.',
      `Context: ${String(contextText || '').slice(0, 1800)}`,
      `Question: ${question}`,
      'Answer:',
    ].join('\n');

    const output = await runtime.pipeline(prompt, {
      max_new_tokens: Number(model?.generation?.max_new_tokens || 96),
      temperature: Number(model?.generation?.temperature || 0.2),
      top_p: Number(model?.generation?.top_p || 0.95),
      do_sample: true,
    });

    const generatedText = Array.isArray(output)
      ? String(output[0]?.generated_text || '')
      : String(output?.generated_text || output || '');
    if (!generatedText) return null;

    const normalized = generatedText.startsWith(prompt)
      ? generatedText.slice(prompt.length).trim()
      : generatedText.trim();
    return normalized || null;
  }

  async function downloadModel(modelId) {
    await initializeAI();
    const id = modelId || state.ai.model?.id;
    if (!id) throw new Error('model not found');
    const model = (state.bundle?.models || []).find((item) => item.id === id) || state.ai.model || { id };
    if (!isTransformersModel(model)) {
      state.ai.mode = AI_MODE.RETRIEVAL_ONLY;
      throw new Error('local artifact models are not supported in browser runtime');
    }
    const artifactPath = model?.artifact?.weights || model?.artifact?.manifest || model?.artifact?.repository || null;
    let artifactUrl = null;
    let bytes = 0;
    if (isTransformersModel(model)) {
      await ensureTransformersEngine(model);
    } else if (artifactPath) {
      artifactUrl = new URL(String(artifactPath), window.location.origin).toString();
      const response = await fetch(artifactUrl, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`model artifact fetch failed (${response.status})`);
      const buffer = await response.arrayBuffer();
      bytes = buffer.byteLength;
      if ('caches' in window) {
        try {
          const cache = await caches.open('knowledgeos-model-artifacts-v1');
          await cache.put(artifactUrl, new Response(buffer, { headers: response.headers }));
        } catch (_error) {
          // Cache API may be unavailable in some environments.
        }
      }
    }
    state.ai.modelStatus[id] = {
      id,
      downloaded: true,
      initialized: true,
      artifactPath,
      artifactUrl,
      bytes,
      provider: isTransformersModel(model) ? 'transformers.js' : 'artifact-url',
      downloadedAt: new Date().toISOString(),
    };
    return state.ai.model || model;
  }

  function getModels() {
    return state.bundle?.models || [];
  }

  function removeModel(modelId) {
    const id = modelId || state.ai.model?.id;
    if (!id) return { removed: false };
    state.ai.modelStatus[id] = null;
    if (state.ai.model?.id === id) state.ai.model = null;
    return { removed: true, id };
  }

  function getAIStatus() {
    return {
      initialized: Boolean(state.ai.initialized),
      mode: state.ai.mode,
      model: state.ai.model,
      modelStatus: state.ai.model ? state.ai.modelStatus[state.ai.model.id] || null : null,
      localEngineReady: Boolean(state.ai.localEngine),
      compatibility: detectAICompatibility(),
    };
  }

  async function generate(input = {}) {
    const result = await answerQuestion(input.question || '');
    return { ...result, mode: state.ai.model ? 'local-llm' : 'retrieval-only' };
  }

  function embed(text = '') {
    return tokenize(text).map((token) => token.length / 20);
  }

  function classify(text = '') {
    return detectIntent(text);
  }

  function extract(text = '') {
    const input = String(text);
    return {
      email: input.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0] || null,
    };
  }

  async function search(query, options = {}) {
    const limit = Number(options.limit || 5);
    const remoteMatches = await searchViaEmbedApi(query, { limit, context: options.context || state.context });
    if (remoteMatches.length) {
      return remoteMatches;
    }

    const bundle = await loadBundle();
    const context = options.context || state.context;
    const queryTokens = tokenize(query);
    const queryTf = termFrequency(queryTokens);
    const queryMag = magnitude(queryTf);
    const profile = getStorageProfile(bundle);
    const audience = getAudienceContext(context);
    const stores = (profile.stores || []).filter((store) => {
      return storeSupportsAudience(store, audience) && hasStorePermission(store, context);
    });
    const allowedStoreIds = new Set(stores.map((store) => store.id));

    const results = [];
    if (state.pglite.ready && state.pglite.db && queryTokens.length) {
      const hitScores = new Map();
      for (const token of queryTokens) {
        const tokenRows = await state.pglite.db.query(
          `SELECT id, text, audience, visibility, department, confidence, last_reviewed, review_frequency
           FROM knowledge_chunks
           WHERE lower(text) LIKE ('%' || lower($1) || '%')
           LIMIT 500`,
          [token],
        );
        for (const row of tokenRows.rows || []) {
          const id = String(row.id || '');
          hitScores.set(id, (hitScores.get(id) || 0) + 1);
        }
      }

      for (const [chunkId, hitScore] of hitScores.entries()) {
        const original = state.pglite.chunkById.get(chunkId);
        const fallback = {
          id: chunkId,
          text: '',
          audience: 'INTERNAL',
          visibility: 'INTERNAL',
          department: null,
          confidence: 0.7,
        };
        const chunk = original || fallback;
        if (!isVisible(chunk, context)) continue;

        const source = getKnowledgeSource(chunk, bundle);
        if (!allowedStoreIds.has(source.id)) continue;

        const semantic = similarity(queryTf, queryMag, {
          tf: termFrequency(tokenize(chunk.text || '')),
          magnitude: magnitude(termFrequency(tokenize(chunk.text || ''))),
        });
        const score = Math.max(semantic, hitScore / Math.max(1, queryTokens.length));
        if (score <= 0) continue;
        results.push({ chunk, score, source });
      }
    }

    if (!results.length) {
    for (const chunk of bundle.chunks || []) {
      if (!isVisible(chunk, context)) continue;
      const source = getKnowledgeSource(chunk, bundle);
      if (!allowedStoreIds.has(source.id)) continue;
      const score = similarity(queryTf, queryMag, chunk);
      if (score <= 0) continue;
      results.push({ chunk, score, source });
    }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async function searchViaEmbedApi(query, options = {}) {
    if (!effectiveApiBase || !tenantId) return [];
    const input = String(query || '').trim();
    if (!input) return [];

    try {
      async function requestSearch(forceSessionRefresh = false) {
        const token = await getEmbedSessionToken(forceSessionRefresh);
        if (!token) return null;
        return fetch(`${effectiveApiBase}/api/embed/search`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-embed-token': token,
          },
          body: JSON.stringify({
            tenant_id: tenantId,
            query: input,
            limit: Number(options.limit || 5),
            role: options.context?.role || state.context.role,
            department: options.context?.department || state.context.department,
            permissions: options.context?.permissions || state.context.permissions,
          }),
        });
      }

      let response = await requestSearch(false);
      if (!response) return [];
      if (response.status === 401) {
        state.embedSession.token = null;
        state.embedSession.expiresAt = 0;
        response = await requestSearch(true);
        if (!response) return [];
      }
      if (!response.ok) return [];
      const payload = await response.json();
      const matches = Array.isArray(payload?.matches) ? payload.matches : [];

      return matches
        .map((match) => {
          const text = String(match?.excerpt || match?.summary || '').trim();
          if (!text) return null;
          return {
            chunk: {
              id: String(match.id || ''),
              knowledgeId: String(match.id || ''),
              text,
              audience: String(match.audience || match.visibility || 'PUBLIC'),
              visibility: String(match.visibility || 'PUBLIC'),
              department: null,
              confidence: Number(match?.scores?.semantic || match.score || 0.7),
              last_reviewed: null,
              review_frequency: 90,
            },
            score: Number(match.score || 0),
            source: {
              id: String(match.source_id || 'server-hybrid'),
              type: 'embed-search-api',
            },
          };
        })
        .filter(Boolean);
    } catch (_error) {
      return [];
    }
  }

  async function answerQuestion(question) {
    const bundle = await loadBundle();
    initializeAiIfNeeded(bundle);
    const effectiveQuestion = buildSessionAwareQuestion(question);
    const intentResult = detectIntent(effectiveQuestion);
    const results = await search(effectiveQuestion, { limit: 5 });
    const relevantResults = results.filter((item) => {
      const text = String(item?.chunk?.text || '');
      return isResultRelevantToQuestion(effectiveQuestion, text, item?.score || 0);
    });
    if (!relevantResults.length) {
      const response = {
        answer: "I don't have an answer for that yet.",
        score: results[0] ? Number(results[0].score || 0) : 0,
        confidence: 0,
        intent: intentResult.intent,
        process_started: false,
        topChunkId: null,
        answered: false,
        effectiveQuestion,
      };
      updateSessionMemory(question, response);
      return response;
    }
    const answerResults = relevantResults;
    const best = answerResults[0] || null;

    if (best && best.score >= minAnswerConfidence && state.ai.mode === AI_MODE.LOCAL) {
      try {
        const generated = await generateWithLocalModel(effectiveQuestion, best.chunk.text || '');
        if (generated && !looksLowQualityGeneratedAnswer(generated)) {
          const response = {
            answer: cleanRetrievedText(generated),
            score: best.score,
            confidence: Number(Math.max(0.4, Math.min(0.99, best.score)).toFixed(3)),
            intent: intentResult.intent,
            process_started: false,
            topChunkId: best.chunk.id,
            sourceStoreId: best.source.id,
            sourceStoreType: best.source.type,
            answered: true,
            generated_by: 'local-transformers',
            effectiveQuestion,
          };
          updateSessionMemory(question, response);
          return response;
        }
      } catch (_error) {
        // Fall back to deterministic retrieval answer when local generation fails.
      }
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
      const evidenceCorpus = answerResults.map((item) => String(item?.chunk?.text || '')).join('\n');
      const formattedAnswer = formatDeterministicAnswer(effectiveQuestion, evidenceCorpus || best.chunk.text || '');
      const response = {
        answer: formattedAnswer,
        score: best.score,
        confidence,
        confidenceBreakdown: {
          semantic: Number(best.score.toFixed(3)),
          freshness: Number(fresh.toFixed(3)),
          agreement: Number(agreement.toFixed(3)),
          reviewer: Number(reviewerConfidence.toFixed(3)),
        },
        intent: intentResult.intent,
        process_started: false,
        topChunkId: best.chunk.id,
        sourceStoreId: best.source.id,
        sourceStoreType: best.source.type,
        answered: true,
        effectiveQuestion,
      };
      updateSessionMemory(question, response);
      return response;
    }

    const fallback = await remoteFallback(effectiveQuestion);
    if (fallback) {
      const response = { ...fallback, answered: true, intent: intentResult.intent, process_started: false, effectiveQuestion };
      updateSessionMemory(question, response);
      return response;
    }

    const response = {
      answer: "I don't have an answer for that yet.",
      score: best ? best.score : 0,
      confidence: best ? Number(best.score.toFixed(3)) : 0,
      intent: intentResult.intent,
      process_started: false,
      topChunkId: best?.chunk?.id || null,
      answered: false,
      effectiveQuestion,
    };
    updateSessionMemory(question, response);
    return response;
  }

  async function sendTelemetry(entry) {
    try {
      const headers = { 'content-type': 'application/json' };
      if (tenantId) {
        const token = await getEmbedSessionToken();
        if (token) headers['x-embed-token'] = token;
      }

      await fetch(`${apiBase}/api/telemetry`, {
        method: 'POST',
        headers,
        body: JSON.stringify(entry),
      });
    } catch (_e) {
      // no-op
    }
  }

  function appendMessage(container, who, text) {
    const node = document.createElement('div');
    const isUser = String(who || '').toLowerCase() === 'you';
    Object.assign(node.style, {
      margin: '0.5rem 0',
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
    });

    const bubble = document.createElement('div');
    Object.assign(bubble.style, {
      maxWidth: '86%',
      padding: '0.55rem 0.65rem',
      borderRadius: '11px',
      lineHeight: '1.35',
      whiteSpace: 'pre-wrap',
      border: isUser ? '1px solid #9ec5ff' : '1px solid #e4e8f0',
      background: isUser ? '#eaf3ff' : '#ffffff',
      color: isUser ? '#143a74' : '#202a3a',
    });

    const label = document.createElement('div');
    label.textContent = isUser ? 'You' : 'AI';
    Object.assign(label.style, {
      fontSize: '11px',
      fontWeight: '700',
      letterSpacing: '0.02em',
      marginBottom: '0.18rem',
      color: isUser ? '#1a4f95' : '#5a667a',
    });

    const content = document.createElement('div');
    content.textContent = String(text || '');
    bubble.appendChild(label);
    bubble.appendChild(content);
    node.appendChild(bubble);
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
    Object.assign(header.style, {
      background: '#111827',
      color: '#fff',
      padding: '0.65rem 0.8rem',
      fontWeight: 'bold',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    });

    const headerTitle = document.createElement('span');
    headerTitle.textContent = widgetTitle;

    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close assistant');
    close.textContent = 'X';
    Object.assign(close.style, {
      border: '1px solid rgba(255,255,255,0.45)',
      background: 'rgba(255,255,255,0.14)',
      color: '#fff',
      width: '24px',
      height: '24px',
      borderRadius: '999px',
      fontSize: '14px',
      fontWeight: '700',
      lineHeight: '1',
      cursor: 'pointer',
      padding: '0',
      marginLeft: '0.5rem',
    });
    close.addEventListener('click', () => {
      panel.style.display = 'none';
    });
    header.appendChild(headerTitle);
    header.appendChild(close);

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
      background: '#ffffff',
      color: '#111827',
      caretColor: '#111827',
      opacity: '1',
      WebkitTextFillColor: '#111827',
    });
    input.setAttribute('aria-label', 'Ask a question');

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
      const startedAt = Date.now();
      input.value = '';
      appendMessage(messages, 'You', question);

      try {
        const response = await answerQuestion(question);
        appendMessage(messages, 'AI', response.answer);

        const answered = response.answered;
        state.history.push({ question, ...response, answered, at: new Date().toISOString() });
        if (state.history.length > 100) state.history = state.history.slice(-100);

        const telemetryPayload = {
          intent: response.intent || 'general_question',
          answered,
          score: response.score,
          confidence: response.confidence || 0,
          knowledge_gap: !answered,
          process_started: Boolean(response.process_started),
          duration: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
          topChunkId: response.topChunkId,
          role: state.context.role,
          department: state.context.department,
          permissions: state.context.permissions,
          includeContent: telemetryIncludeContent,
          ...(telemetryIncludeContent ? { question } : {}),
        };
        sendTelemetry(telemetryPayload);
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
    document.addEventListener('DOMContentLoaded', () => {
      createWidget();
      warmupRuntime();
    });
  } else {
    createWidget();
    warmupRuntime();
  }

  window.KnowledgeOSRuntime = {
    askQuestion: answerQuestion,
    getStorageStatus: async () => {
      const bundle = await loadBundle();
      const profile = getStorageProfile(bundle);
      const audience = getAudienceContext();
      return {
        mode: profile.mode,
        audience,
        stores: profile.stores.map((store) => ({
          ...store,
          allowed: hasStorePermission(store),
          active: storeSupportsAudience(store, audience),
        })),
      };
    },
    getAudienceContext: () => ({
      audience: getAudienceContext(),
      role: state.context.role,
      department: state.context.department,
      permissions: state.context.permissions,
    }),
    getSessionMemory: () => ({
      subject: state.session.subject,
      topics: [...state.session.topics],
      turns: [...state.session.turns],
    }),
    clearSessionMemory: () => {
      state.session.subject = null;
      state.session.topics = [];
      state.session.turns = [];
      return { ok: true };
    },
    search,
    getKnowledgeSource,
    getAIStatus,
    getRuntimeDiagnostics: async () => ({
      warmup: { ...state.warmup },
      ai: getAIStatus(),
      pglite: {
        initialized: state.pglite.initialized,
        ready: state.pglite.ready,
        rows: state.pglite.rows,
        error: state.pglite.error,
        moduleUrl: pgliteModuleUrl,
      },
      bundleLoaded: Boolean(state.bundle),
    }),
    downloadModel,
    initializeAI,
    generate,
    embed,
    classify,
    extract,
    getModels,
    removeModel,
    startProcess,
    resumeProcess,
    completeStep,
    validateStep,
    branch,
    rollback,
    cancel,
    executeCapability,
    listCapabilities,
    getExecutionHistory,
    approve,
    reject,
  };
})();
