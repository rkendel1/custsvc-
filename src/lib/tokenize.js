function tokenize(text = '') {
  return String(text)
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
  for (const count of Object.values(tf)) {
    sum += count * count;
  }
  return Math.sqrt(sum);
}

function similarity(queryTf, queryMag, chunkTf, chunkMag) {
  if (!queryMag || !chunkMag) return 0;
  let dot = 0;
  for (const [token, count] of Object.entries(queryTf)) {
    if (chunkTf[token]) dot += count * chunkTf[token];
  }
  return dot / (queryMag * chunkMag);
}

module.exports = {
  tokenize,
  termFrequency,
  magnitude,
  similarity,
};
