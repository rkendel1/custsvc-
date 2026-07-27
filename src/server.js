const path = require('path');
const { createApp } = require('./createApp');

const PORT = process.env.PORT || 3000;
const rootDir = path.resolve(__dirname, '..');

const app = createApp({
  rootDir,
  companyName: process.env.COMPANY_NAME || 'Acme Intelligence',
});

app.listen(PORT, () => {
  console.log(`Company Intelligence Runtime listening on http://localhost:${PORT}`);
});
