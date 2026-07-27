const { tokenize, termFrequency, magnitude } = require('./tokenize');

function normalizeVisibility(visibility) {
  const value = String(visibility || 'BOTH').toUpperCase();
  if (value === 'PUBLIC' || value === 'INTERNAL' || value === 'BOTH') return value;
  return 'BOTH';
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

function toChunks(document, index) {
  const visibility = normalizeVisibility(document.visibility);
  const sourceType = String(document.type || 'TEXT').toUpperCase();
  const sourceTitle = document.title || `Document ${index + 1}`;
  const baseContent = document.content || '';
  const entries = sourceType === 'FAQ' ? parseFaqContent(baseContent) : [baseContent];

  return entries.flatMap((entry, localIndex) => {
    const chunks = chunkText(entry);

    return chunks.map((text, chunkIndex) => {
      const tokens = tokenize(text);
      const tf = termFrequency(tokens);
      return {
        id: `${document.id || `doc-${index + 1}`}-${localIndex}-${chunkIndex}`,
        documentId: document.id || `doc-${index + 1}`,
        sourceTitle,
        sourceType,
        visibility,
        text,
        tf,
        magnitude: magnitude(tf),
      };
    });
  });
}

function compileBundle(documents, options = {}) {
  const safeDocs = Array.isArray(documents) ? documents : [];
  const company = options.company || 'Acme';
  const chunks = safeDocs.flatMap((doc, index) => toChunks(doc, index));

  return {
    version: 1,
    company,
    generatedAt: new Date().toISOString(),
    documentCount: safeDocs.length,
    chunkCount: chunks.length,
    chunks,
  };
}

module.exports = {
  compileBundle,
  normalizeVisibility,
};
