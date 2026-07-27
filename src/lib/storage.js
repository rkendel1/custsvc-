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
  } catch (error) {
    console.error(`Failed to parse JSON file ${filePath}: ${error.message}`);
    return defaultValue;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createStorage(baseDir) {
  const MAX_BUNDLE_NAME_LENGTH = 120;
  const dataDir = path.join(baseDir, 'data');
  const bundlesDir = path.join(baseDir, 'bundles');
  ensureDir(dataDir);
  ensureDir(bundlesDir);

  const docsPath = path.join(dataDir, 'documents.json');
  const telemetryPath = path.join(dataDir, 'telemetry.json');
  const tenantsPath = path.join(dataDir, 'tenants.json');
  const usersPath = path.join(dataDir, 'users.json');
  const membershipsPath = path.join(dataDir, 'tenant_memberships.json');
  const subscriptionsPath = path.join(dataDir, 'subscriptions.json');
  const deploymentsPath = path.join(dataDir, 'deployments.json');
  const runtimeInstancesPath = path.join(dataDir, 'runtime_instances.json');
  const onboardingPath = path.join(dataDir, 'onboarding.json');

  ensureJsonFile(docsPath, []);
  ensureJsonFile(telemetryPath, []);
  ensureJsonFile(tenantsPath, []);
  ensureJsonFile(usersPath, []);
  ensureJsonFile(membershipsPath, []);
  ensureJsonFile(subscriptionsPath, []);
  ensureJsonFile(deploymentsPath, []);
  ensureJsonFile(runtimeInstancesPath, []);
  ensureJsonFile(onboardingPath, []);

  function sanitizeBundleName(name) {
    let raw = String(name || 'company.intelligence.bundle.json');
    try {
      raw = decodeURIComponent(raw);
    } catch (_e) {
      // Keep raw when decode fails.
    }
    const fileName = path.basename(raw);
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, MAX_BUNDLE_NAME_LENGTH);
    return safeName || 'company.intelligence.bundle.json';
  }

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
    listTenants() {
      return readJson(tenantsPath, []);
    },
    saveTenants(tenants) {
      writeJson(tenantsPath, tenants);
    },
    listUsers() {
      return readJson(usersPath, []);
    },
    saveUsers(users) {
      writeJson(usersPath, users);
    },
    listTenantMemberships() {
      return readJson(membershipsPath, []);
    },
    saveTenantMemberships(memberships) {
      writeJson(membershipsPath, memberships);
    },
    listSubscriptions() {
      return readJson(subscriptionsPath, []);
    },
    saveSubscriptions(subscriptions) {
      writeJson(subscriptionsPath, subscriptions);
    },
    listDeployments() {
      return readJson(deploymentsPath, []);
    },
    saveDeployments(deployments) {
      writeJson(deploymentsPath, deployments);
    },
    listRuntimeInstances() {
      return readJson(runtimeInstancesPath, []);
    },
    saveRuntimeInstances(instances) {
      writeJson(runtimeInstancesPath, instances);
    },
    listOnboarding() {
      return readJson(onboardingPath, []);
    },
    saveOnboarding(onboardingItems) {
      writeJson(onboardingPath, onboardingItems);
    },
    writeBundle(name, bundle) {
      const safeName = sanitizeBundleName(name);
      const bundlePath = path.resolve(bundlesDir, safeName);
      const bundleRoot = path.resolve(bundlesDir) + path.sep;
      if (!bundlePath.startsWith(bundleRoot)) {
        throw new Error('invalid bundle path');
      }
      writeJson(bundlePath, bundle);
      return { bundlePath, safeName };
    },
  };
}

module.exports = {
  createStorage,
};
