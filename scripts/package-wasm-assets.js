const fs = require('fs');
const path = require('path');

function packagePdfParserAssets(rootDir) {
  const sourceDir = path.join(rootDir, 'node_modules', 'pdf-parse', 'dist');
  const targetDir = path.join(rootDir, 'public', 'vendor', 'pdf-parse');

  if (!fs.existsSync(sourceDir)) {
    throw new Error('Missing source parser assets: node_modules/pdf-parse/dist');
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });

  const pkgPath = path.join(rootDir, 'node_modules', 'pdf-parse', 'package.json');
  let version = 'unknown';
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    version = String(pkg?.version || version);
  }

  const manifest = {
    parser: 'pdf-parse',
    version,
    packaged_at: new Date().toISOString(),
    source: 'node_modules/pdf-parse/dist',
    output: 'public/vendor/pdf-parse',
  };

  fs.writeFileSync(path.join(targetDir, 'wasm-package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Packaged parser assets to ${targetDir}`);
}

function main() {
  const rootDir = process.cwd();
  packagePdfParserAssets(rootDir);
}

main();
