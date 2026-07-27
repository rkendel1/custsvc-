const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureJsonFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

function readJson(filePath, defaultValue) {
  ensureJsonFile(filePath, defaultValue);
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return defaultValue;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createStorage(baseDir) {
  const dataDir = path.join(baseDir, 'data');
  const bundlesDir = path.join(baseDir, 'bundles');
  ensureDir(dataDir);
  ensureDir(bundlesDir);

  const docsPath = path.join(dataDir, 'documents.json');
  const telemetryPath = path.join(dataDir, 'telemetry.json');

  ensureJsonFile(docsPath, []);
  ensureJsonFile(telemetryPath, []);

  return {
    dataDir,
    bundlesDir,
    listDocuments() {
      return readJson(docsPath, []);
    },
    saveDocuments(documents) {
      writeJson(docsPath, documents);
    },
    listTelemetry() {
      return readJson(telemetryPath, []);
    },
    saveTelemetry(events) {
      writeJson(telemetryPath, events);
    },
    writeBundle(name, bundle) {
      const bundlePath = path.join(bundlesDir, name);
      writeJson(bundlePath, bundle);
      return bundlePath;
    },
  };
}

module.exports = {
  createStorage,
};
