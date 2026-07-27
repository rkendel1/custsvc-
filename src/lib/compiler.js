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
const DUPLICATE_SIMILARITY_THRESHOLD = 0.82;
const PROCESS_STEP_TYPES = new Set([
  'DECISION',
  'APPROVAL',
  'COLLECT_DATA',
  'ASK_QUESTION',
  'GENERATE_DOCUMENT',
  'RUN_TOOL',
  'UPLOAD_FILE',
  'VERIFY',
  'NOTIFY',
  'WAIT',
  'BRANCH',
  'FINISH',
]);

function normalizeVisibility(visibility) {
  const value = String(visibility || 'INTERNAL').toUpperCase();
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
  const body = String(document.body || '');
  const lastReviewed = document.last_reviewed || new Date().toISOString();
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
    review_frequency: parseReviewFrequency(document.review_frequency),
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

function detectDuplicates(knowledge, threshold = DUPLICATE_SIMILARITY_THRESHOLD) {
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
  const match = String(text || '')
    .toLowerCase()
    .match(/refund(?:s|ing)?(?:\s+(?:within|in|for|eligible|allowed|are|is|must|be|processed|requested|submitted|a|the|up|to)){0,8}\s+(\d{1,3})\s*days?/);
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

function normalizeStepType(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, '_');
  if (PROCESS_STEP_TYPES.has(normalized)) return normalized;
  return 'COLLECT_DATA';
}

function normalizeProcessStep(step, index) {
  const id = String(step?.id || `step-${index + 1}`);
  const next = step?.next;
  const nextSteps = Array.isArray(next)
    ? next.map((item) => String(item || '').trim()).filter(Boolean)
    : String(next || '').trim()
      ? [String(next).trim()]
      : [];
  return {
    id,
    title: String(step?.title || `Step ${index + 1}`),
    description: String(step?.description || ''),
    type: normalizeStepType(step?.type),
    actor: step?.actor || null,
    required_role: step?.required_role || null,
    required_capability: step?.required_capability || null,
    expected_duration: Number(step?.expected_duration || 0),
    automation: step?.automation || null,
    validation: step?.validation || null,
    next: nextSteps,
    intentional_cycle: Boolean(step?.intentional_cycle),
  };
}

function normalizeProcess(process, index) {
  const id = String(process?.id || `process-${index + 1}`);
  const steps = Array.isArray(process?.steps) ? process.steps.map(normalizeProcessStep) : [];
  return {
    id,
    name: String(process?.name || `Process ${index + 1}`),
    description: String(process?.description || ''),
    purpose: String(process?.purpose || ''),
    owner: process?.owner || null,
    department: process?.department || null,
    audience: normalizeAudience(process?.audience),
    status: String(process?.status || 'DRAFT').toUpperCase(),
    entry_conditions: parseList(process?.entry_conditions),
    completion_conditions: parseList(process?.completion_conditions),
    steps,
    roles: parseList(process?.roles),
    required_documents: parseList(process?.required_documents),
    required_capabilities: parseList(process?.required_capabilities),
    policies: parseList(process?.policies),
    outputs: parseList(process?.outputs),
    metrics: parseList(process?.metrics),
  };
}

function buildProcessGraph(processes) {
  const nodes = [];
  const edges = [];
  const adjacency = {};

  for (const process of processes) {
    for (const step of process.steps) {
      const stepId = `${process.id}:${step.id}`;
      nodes.push({ id: stepId, processId: process.id, stepId: step.id, type: step.type, title: step.title });
      adjacency[stepId] = [];
    }
  }

  for (const process of processes) {
    const byStepId = new Set(process.steps.map((step) => step.id));
    for (const step of process.steps) {
      const source = `${process.id}:${step.id}`;
      for (const next of step.next) {
        if (!byStepId.has(next)) continue;
        const target = `${process.id}:${next}`;
        edges.push({ source, target, processId: process.id });
        adjacency[source].push({ target, processId: process.id });
      }
    }
  }

  return { nodes, edges, adjacency };
}

function detectProcessCycles(process) {
  const byId = new Map(process.steps.map((step) => [step.id, step]));
  const visited = new Set();
  const inStack = new Set();
  const cycles = [];
  function dfs(stepId, path = []) {
    if (inStack.has(stepId)) {
      cycles.push([...path, stepId]);
      return;
    }
    if (visited.has(stepId)) return;
    visited.add(stepId);
    inStack.add(stepId);
    const step = byId.get(stepId);
    for (const next of step?.next || []) dfs(next, [...path, stepId]);
    inStack.delete(stepId);
  }
  for (const step of process.steps) dfs(step.id);
  return cycles;
}

function validateProcesses(processes, knowledge) {
  const safeProcesses = Array.isArray(processes) ? processes.map(normalizeProcess) : [];
  const byKnowledgeId = new Set((knowledge || []).map((item) => item.id));
  const issues = {
    dead_ends: [],
    unreachable_steps: [],
    branch_errors: [],
    missing_approvals: [],
    invalid_role_transitions: [],
    orphaned_processes: [],
    missing_capabilities: [],
    invalid_links: [],
    cycles: [],
  };

  for (const process of safeProcesses) {
    if (!process.steps.length) {
      issues.orphaned_processes.push({ processId: process.id });
      continue;
    }

    const byStepId = new Map(process.steps.map((step) => [step.id, step]));
    const roleSet = new Set(process.roles.map((role) => String(role)));
    const capabilitySet = new Set(process.required_capabilities.map((capability) => String(capability)));

    for (const step of process.steps) {
      if (step.type !== 'FINISH' && step.next.length === 0) {
        issues.dead_ends.push({ processId: process.id, stepId: step.id });
      }
      if ((step.type === 'DECISION' || step.type === 'BRANCH') && step.next.length < 2) {
        issues.branch_errors.push({ processId: process.id, stepId: step.id });
      }
      if (step.type === 'APPROVAL' && !step.required_role) {
        issues.missing_approvals.push({ processId: process.id, stepId: step.id });
      }
      if (step.required_role && roleSet.size && !roleSet.has(String(step.required_role))) {
        issues.invalid_role_transitions.push({ processId: process.id, stepId: step.id, role: step.required_role });
      }
      if (
        step.required_capability &&
        capabilitySet.size &&
        !capabilitySet.has(String(step.required_capability))
      ) {
        issues.missing_capabilities.push({
          processId: process.id,
          stepId: step.id,
          capability: step.required_capability,
        });
      }
      for (const next of step.next) {
        if (!byStepId.has(next)) issues.dead_ends.push({ processId: process.id, stepId: step.id, target: next });
      }
    }

    const start = process.steps[0];
    const reachable = new Set();
    const queue = [start.id];
    while (queue.length) {
      const currentId = queue.shift();
      if (!currentId || reachable.has(currentId)) continue;
      reachable.add(currentId);
      const current = byStepId.get(currentId);
      for (const next of current?.next || []) queue.push(next);
    }
    for (const step of process.steps) {
      if (!reachable.has(step.id)) issues.unreachable_steps.push({ processId: process.id, stepId: step.id });
    }

    const cycles = detectProcessCycles(process);
    for (const cycle of cycles) {
      const intentional = cycle.some((stepId) => byStepId.get(stepId)?.intentional_cycle);
      if (!intentional) issues.cycles.push({ processId: process.id, path: cycle });
    }

    for (const ref of [...process.required_documents, ...process.policies]) {
      if (!byKnowledgeId.has(ref)) issues.invalid_links.push({ processId: process.id, knowledgeId: ref });
    }
  }

  return issues;
}

function compileBundle(documents, options = {}) {
  const safeDocs = Array.isArray(documents) ? documents : [];
  const company = options.company || 'Acme';
  const safeProcesses = Array.isArray(options.processes) ? options.processes : [];
  const knowledge = safeDocs.map(toKnowledgeObject);
  const chunks = knowledge.flatMap((item, index) => toChunks(item, index));
  const graph = buildGraph(knowledge);
  const processes = safeProcesses.map(normalizeProcess);
  const processGraph = buildProcessGraph(processes);
  const processValidation = validateProcesses(processes, knowledge);
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
  const roleViews = {};
  for (const role of ROLES) {
    roleViews[role] = {
      knowledge: roleIndexes[role],
      processes: processes
        .filter((item) => !item.roles.length || item.roles.includes(role))
        .map((item) => item.id),
    };
  }
  const capabilitySet = new Set();
  for (const process of processes) {
    for (const capability of process.required_capabilities) capabilitySet.add(capability);
  }

  return {
    version: 3,
    format: 'company.intelligence.bundle.v3',
    format_legacy: 'company.intelligence.bundle',
    company,
    generatedAt,
    documentCount: safeDocs.length,
    chunkCount: chunks.length,
    knowledgeCount: knowledge.length,
    processCount: processes.length,
    metadata: {
      company,
      generatedAt,
      documentCount: safeDocs.length,
      knowledgeCount: knowledge.length,
      chunkCount: chunks.length,
      processCount: processes.length,
    },
    knowledge,
    relationships: graph.edges,
    processes,
    process_graph: processGraph,
    audiences: AUDIENCE_LEVELS,
    roles: ROLES,
    role_views: roleViews,
    review_schedule: reviewSchedule,
    review: {
      knowledge: reviewSchedule,
      processes: processValidation,
    },
    graph,
    embeddings: [],
    indexes: {
      roles: roleIndexes,
      chunks: chunks.map((item) => item.id),
      processes: processes.map((item) => item.id),
    },
    capabilities: [...capabilitySet],
    analytics: {
      processes: {
        total: processes.length,
        validation_issues: Object.values(processValidation).reduce((sum, items) => sum + items.length, 0),
      },
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
  validateProcesses,
};
