const path = require('path');
const { createApp } = require('./createApp');

const PORT = process.env.PORT || 3000;
const rootDir = path.resolve(__dirname, '..');

const app = createApp({
  rootDir,
  companyName: process.env.COMPANY_NAME || 'KnowledgeOS',
});

app.listen(PORT, () => {
  console.log(`KnowledgeOS listening on http://localhost:${PORT}`);
});
