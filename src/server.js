const path = require('path');
const { createApp } = require('./createApp');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const rootDir = path.resolve(__dirname, '..');

const app = createApp({
  rootDir,
  companyName: process.env.COMPANY_NAME || 'KnowledgeOS',
});

app.listen(PORT, HOST, () => {
  console.log(`KnowledgeOS listening on http://${HOST}:${PORT}`);
});
