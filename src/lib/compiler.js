const { tokenize, termFrequency, magnitude } = require('./tokenize');

const AUDIENCE_LEVELS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'EXECUTIVE'];
const ROLES = [
  'Customer',
  'Partner',
  'Support',
  'Sales',
  'Engineering',
  'HR',
  'Finance',
  'Operations',
  'Executive',
  'Administrator',
];
const SUPPORTED_RELATIONSHIPS = new Set([
  'SUPPORTS',
  'CONTRADICTS',
  'SUPERSEDES',
  'RELATED',
  'IMPLEMENTS',
  'DEPENDS_ON',
  'OWNED_BY',
  'REFERENCES',
  'DUPLICATE_OF',
  'DERIVED_FROM',
]);

function normalizeVisibility(visibility) {
  const value = String(visibility || 'BOTH').toUpperCase();
  if (value === 'BOTH') return 'PUBLIC';
  if (AUDIENCE_LEVELS.includes(value)) return value;
  return 'INTERNAL';
}

function normalizeAudience(audience) {
  const value = String(audience || '').toUpperCase();
  if (AUDIENCE_LEVELS.includes(value)) return value;
  return 'INTERNAL';
}

function normalizeRole(role) {
  const value = String(role || 'Customer').toLowerCase();
  return ROLES.find((item) => item.toLowerCase() === value) || 'Customer';
}

function roleAudiences(role, permissions = []) {
  const normalizedRole = normalizeRole(role);
  const perms = new Set((Array.isArray(permissions) ? permissions : []).map((x) => String(x).toLowerCase()));
  const baseByRole = {
    Customer: ['PUBLIC'],
    Partner: ['PUBLIC', 'INTERNAL'],
    Sales: ['PUBLIC', 'INTERNAL'],
    Support: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
    Engineering: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
    HR: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
    Finance: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
    Operations: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
    Executive: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'EXECUTIVE'],
    Administrator: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'EXECUTIVE'],
  };
  const audiences = new Set(baseByRole[normalizedRole] || ['PUBLIC']);
  if (perms.has('view:confidential')) audiences.add('CONFIDENTIAL');
  if (perms.has('view:executive')) audiences.add('EXECUTIVE');
  return [...audiences];
}

function normalizeRelationshipType(type) {
  const value = String(type || 'RELATED').toUpperCase();
  if (SUPPORTED_RELATIONSHIPS.has(value)) return value;
  return 'RELATED';
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return String(value)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseRelationships(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const text = String(value).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function parseReviewFrequency(value, fallback = 90) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return Math.round(num);
  return fallback;
}

function clamp01(value, fallback = 0.7) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function isKnowledgeVisibleForRole(knowledgeObject, context = {}) {
  const role = normalizeRole(context.role);
  const department = String(context.department || '').toLowerCase();
  const permissions = Array.isArray(context.permissions) ? context.permissions : [];
  const audiences = roleAudiences(role, permissions);
  const audience = normalizeAudience(knowledgeObject.audience || knowledgeObject.visibility);
  if (!audiences.includes(audience)) return false;

  const objectDepartment = String(knowledgeObject.department || '').toLowerCase();
  if (!objectDepartment || !department) return true;
  if (objectDepartment === department) return true;
  return permissions.map((x) => String(x).toLowerCase()).includes('cross_department');
}

function parseFaqContent(content) {
  const text = String(content || '').trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (!item || !item.question || !item.answer) return null;
          return `Q: ${item.question}\nA: ${item.answer}`;
        })
        .filter(Boolean);
    }
  } catch (_e) {
    // fall through
  }

  return text
    .split(/\n\s*\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function chunkText(text, maxLength = 450) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxLength) {
      chunks.push(paragraph);
      continue;
    }

    const sentences = paragraph.match(/[^.!?]+[.!?]?/g) || [paragraph];
    let current = '';
    for (const sentence of sentences) {
      if (!current) {
        current = sentence;
      } else if (`${current} ${sentence}`.length <= maxLength) {
        current = `${current} ${sentence}`;
      } else {
        chunks.push(current);
        current = sentence;
      }
    }
    if (current) chunks.push(current);
  }

  return chunks;
}

function toKnowledgeObject(document, index) {
  const id = document.id || `doc-${index + 1}`;
  const body = String(document.body || document.content || '');
  const lastReviewed = document.last_reviewed || document.lastReviewed || document.createdAt || new Date().toISOString();
  const parsedReviewDate = new Date(lastReviewed);
  const safeLastReviewed = Number.isNaN(parsedReviewDate.getTime())
    ? new Date().toISOString()
    : parsedReviewDate.toISOString();
  const sourceType = String(document.type || 'TEXT').toUpperCase();
  const relationships = parseRelationships(document.relationships)
    .map((relationship) => {
      if (!relationship || !relationship.target) return null;
      return {
        source: id,
        target: String(relationship.target),
        type: normalizeRelationshipType(relationship.type),
      };
    })
    .filter(Boolean);
  return {
    id,
    title: document.title || `Document ${index + 1}`,
    summary: String(document.summary || body.slice(0, 260)),
    body,
    visibility: normalizeVisibility(document.visibility),
    owner: document.owner || null,
    department: document.department || null,
    audience: normalizeAudience(document.audience || document.visibility),
    classification: String(document.classification || sourceType),
    status: String(document.status || 'ACTIVE').toUpperCase(),
    tags: parseList(document.tags),
    relationships,
    citations: parseList(document.citations || document.sourceUrl),
    last_reviewed: safeLastReviewed,
    review_frequency: parseReviewFrequency(document.review_frequency || document.reviewFrequency),
    confidence: clamp01(document.confidence, 0.7),
    embeddings: Array.isArray(document.embeddings) ? document.embeddings : [],
    sourceType,
  };
}

function toChunks(knowledgeObject, index) {
  const sourceType = String(knowledgeObject.sourceType || 'TEXT').toUpperCase();
  const sourceTitle = knowledgeObject.title || `Document ${index + 1}`;
  const baseContent = knowledgeObject.body || '';
  const entries = sourceType === 'FAQ' ? parseFaqContent(baseContent) : [baseContent];

  return entries.flatMap((entry, localIndex) => {
    const chunks = chunkText(entry);

    return chunks.map((text, chunkIndex) => {
      const tokens = tokenize(text);
      const tf = termFrequency(tokens);
      return {
        id: `${knowledgeObject.id || `doc-${index + 1}`}-${localIndex}-${chunkIndex}`,
        documentId: knowledgeObject.id || `doc-${index + 1}`,
        knowledgeId: knowledgeObject.id || `doc-${index + 1}`,
        sourceTitle,
        sourceType,
        visibility: knowledgeObject.visibility,
        audience: knowledgeObject.audience,
        department: knowledgeObject.department,
        last_reviewed: knowledgeObject.last_reviewed,
        review_frequency: knowledgeObject.review_frequency,
        confidence: knowledgeObject.confidence,
        text,
        tf,
        magnitude: magnitude(tf),
      };
    });
  });
}

function buildGraph(knowledge) {
  const byId = new Set(knowledge.map((item) => item.id));
  const edges = [];
  for (const item of knowledge) {
    for (const relationship of item.relationships || []) {
      if (!byId.has(relationship.target)) continue;
      edges.push({
        source: relationship.source || item.id,
        target: relationship.target,
        type: normalizeRelationshipType(relationship.type),
      });
    }
  }
  const adjacency = {};
  for (const node of knowledge) adjacency[node.id] = [];
  for (const edge of edges) {
    if (!adjacency[edge.source]) adjacency[edge.source] = [];
    adjacency[edge.source].push({ target: edge.target, type: edge.type });
  }
  return {
    nodes: knowledge.map((item) => ({ id: item.id, title: item.title, audience: item.audience })),
    edges,
    adjacency,
  };
}

function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(String(a || '')));
  const setB = new Set(tokenize(String(b || '')));
  if (!setA.size || !setB.size) return 0;
  let common = 0;
  for (const token of setA) if (setB.has(token)) common += 1;
  return common / (setA.size + setB.size - common);
}

function detectDuplicates(knowledge, threshold = 0.82) {
  const duplicates = [];
  for (let i = 0; i < knowledge.length; i += 1) {
    for (let j = i + 1; j < knowledge.length; j += 1) {
      const left = knowledge[i];
      const right = knowledge[j];
      const score = jaccardSimilarity(`${left.title}\n${left.body}`, `${right.title}\n${right.body}`);
      if (score >= threshold) {
        duplicates.push({
          knowledgeIds: [left.id, right.id],
          confidence: Number(score.toFixed(3)),
        });
      }
    }
  }
  return duplicates;
}

function extractRefundWindowDays(text) {
  const match = String(text || '').toLowerCase().match(/refund\w*[\s\S]{0,40}?(\d{1,3})\s*days?/);
  if (!match) return null;
  return Number(match[1]);
}

function detectContradictions(knowledge) {
  const contradictions = [];
  for (let i = 0; i < knowledge.length; i += 1) {
    for (let j = i + 1; j < knowledge.length; j += 1) {
      const left = knowledge[i];
      const right = knowledge[j];
      const leftDays = extractRefundWindowDays(left.body);
      const rightDays = extractRefundWindowDays(right.body);
      if (!leftDays || !rightDays) continue;
      if (leftDays === rightDays) continue;
      contradictions.push({
        type: 'KNOWLEDGE_CONFLICT',
        severity: 'HIGH',
        confidence: 0.95,
        relationship: 'CONTRADICTS',
        left: { id: left.id, title: left.title, refund_days: leftDays },
        right: { id: right.id, title: right.title, refund_days: rightDays },
      });
    }
  }
  return contradictions;
}

function calculateReviewSchedule(knowledge) {
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  let stale = 0;
  let dueNextWeek = 0;
  let orphaned = 0;
  for (const item of knowledge) {
    if (!item.owner) orphaned += 1;
    const reviewedAt = new Date(item.last_reviewed).getTime();
    const reviewMs = item.review_frequency * 24 * 60 * 60 * 1000;
    const expiresAt = reviewedAt + reviewMs;
    if (expiresAt < now) stale += 1;
    if (expiresAt >= now && expiresAt <= now + weekMs) dueNextWeek += 1;
  }
  return { stale, dueNextWeek, orphaned };
}

function compileBundle(documents, options = {}) {
  const safeDocs = Array.isArray(documents) ? documents : [];
  const company = options.company || 'Acme';
  const knowledge = safeDocs.map(toKnowledgeObject);
  const chunks = knowledge.flatMap((item, index) => toChunks(item, index));
  const graph = buildGraph(knowledge);
  const duplicates = detectDuplicates(knowledge);
  const contradictions = detectContradictions(knowledge);
  const reviewSchedule = calculateReviewSchedule(knowledge);
  const roleIndexes = {};
  for (const role of ROLES) {
    roleIndexes[role] = knowledge
      .filter((item) => isKnowledgeVisibleForRole(item, { role }))
      .map((item) => item.id);
  }
  const averageConfidence = knowledge.length
    ? Number((knowledge.reduce((sum, item) => sum + item.confidence, 0) / knowledge.length).toFixed(3))
    : 0;
  const generatedAt = new Date().toISOString();

  return {
    version: 2,
    format: 'company.intelligence.bundle',
    company,
    generatedAt,
    documentCount: safeDocs.length,
    chunkCount: chunks.length,
    knowledgeCount: knowledge.length,
    metadata: {
      company,
      generatedAt,
      documentCount: safeDocs.length,
      knowledgeCount: knowledge.length,
      chunkCount: chunks.length,
    },
    knowledge,
    relationships: graph.edges,
    audiences: AUDIENCE_LEVELS,
    roles: ROLES,
    review_schedule: reviewSchedule,
    graph,
    embeddings: [],
    indexes: {
      roles: roleIndexes,
      chunks: chunks.map((item) => item.id),
    },
    duplicates,
    contradictions,
    confidence: {
      average: averageConfidence,
      totalObjects: knowledge.length,
    },
    chunks,
  };
}

module.exports = {
  compileBundle,
  normalizeVisibility,
  normalizeAudience,
  roleAudiences,
  isKnowledgeVisibleForRole,
  detectContradictions,
  detectDuplicates,
  calculateReviewSchedule,
};
