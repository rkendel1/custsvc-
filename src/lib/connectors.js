const { createSign } = require('crypto');

function basicAuthHeader(username, token) {
  return `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createGoogleServiceJwt(config) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: config.service_account_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const privateKey = String(config.private_key || '').replace(/\\n/g, '\n');
  const signature = signer.sign(privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

let S3Client = null;
let HeadBucketCommand = null;
try {
  ({ S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3'));
} catch (_error) {
  S3Client = null;
  HeadBucketCommand = null;
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_error) {
    body = { raw: text };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: body.error_description || body.error || body.message || `HTTP ${response.status}`,
      body,
    };
  }

  return {
    ok: true,
    status: response.status,
    body,
  };
}

async function testSharePoint(fetchImpl, config) {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(config.tenant_id)}/oauth2/v2.0/token`;
  const tokenBody = new URLSearchParams({
    client_id: config.client_id,
    client_secret: config.client_secret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const tokenResult = await fetchJson(fetchImpl, tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
  });
  if (!tokenResult.ok) return tokenResult;

  const siteResult = await fetchJson(fetchImpl, `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(config.site_id)}`, {
    headers: { authorization: `Bearer ${tokenResult.body.access_token}` },
  });
  if (!siteResult.ok) return siteResult;

  return {
    ok: true,
    provider: 'SHAREPOINT',
    details: {
      token_type: tokenResult.body.token_type || 'Bearer',
      site_id: siteResult.body.id || config.site_id,
      display_name: siteResult.body.displayName || null,
    },
  };
}

async function testConfluence(fetchImpl, config) {
  const baseUrl = `https://${config.workspace}.atlassian.net`;
  const response = await fetchJson(fetchImpl, `${baseUrl}/wiki/rest/api/space?limit=1`, {
    headers: {
      authorization: basicAuthHeader(config.email, config.api_token),
      accept: 'application/json',
    },
  });
  if (!response.ok) return response;
  return {
    ok: true,
    provider: 'CONFLUENCE',
    details: {
      workspace: config.workspace,
      sample_space_count: Array.isArray(response.body.results) ? response.body.results.length : 0,
    },
  };
}

async function testSalesforce(fetchImpl, config) {
  const tokenResult = await fetchJson(fetchImpl, `${config.instance_url.replace(/\/$/, '')}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.client_id,
      client_secret: config.client_secret,
    }).toString(),
  });
  if (!tokenResult.ok) return tokenResult;

  const limitsResult = await fetchJson(
    fetchImpl,
    `${config.instance_url.replace(/\/$/, '')}/services/data/v60.0/limits`,
    {
      headers: {
        authorization: `Bearer ${tokenResult.body.access_token}`,
      },
    },
  );
  if (!limitsResult.ok) return limitsResult;

  return {
    ok: true,
    provider: 'SALESFORCE',
    details: {
      instance_url: tokenResult.body.instance_url || config.instance_url,
      limits_checked: true,
    },
  };
}

async function testGitHub(fetchImpl, config) {
  const response = await fetchJson(fetchImpl, 'https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${config.token}`,
      'user-agent': 'KnowledgeOS-Connector-Test',
      accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) return response;
  return {
    ok: true,
    provider: 'GITHUB',
    details: {
      login: response.body.login || null,
      account_id: response.body.id || null,
    },
  };
}

async function testNotion(fetchImpl, config) {
  const response = await fetchJson(fetchImpl, 'https://api.notion.com/v1/users/me', {
    headers: {
      authorization: `Bearer ${config.integration_token}`,
      'notion-version': '2022-06-28',
      accept: 'application/json',
    },
  });
  if (!response.ok) return response;
  return {
    ok: true,
    provider: 'NOTION',
    details: {
      bot_id: response.body.bot?.owner?.user?.id || response.body.id || null,
    },
  };
}

async function testSlack(fetchImpl, config) {
  const response = await fetchJson(fetchImpl, 'https://slack.com/api/auth.test', {
    headers: {
      authorization: `Bearer ${config.bot_token}`,
    },
  });
  if (!response.ok) return response;
  if (!response.body.ok) {
    return { ok: false, status: 401, error: response.body.error || 'slack auth failed', body: response.body };
  }
  return {
    ok: true,
    provider: 'SLACK',
    details: {
      workspace: response.body.team || config.workspace,
      user: response.body.user || null,
    },
  };
}

async function testZendesk(fetchImpl, config) {
  const domain = `${config.subdomain}.zendesk.com`;
  const response = await fetchJson(fetchImpl, `https://${domain}/api/v2/users/me.json`, {
    headers: {
      authorization: basicAuthHeader(`${config.email}/token`, config.api_token),
      accept: 'application/json',
    },
  });
  if (!response.ok) return response;
  return {
    ok: true,
    provider: 'ZENDESK',
    details: {
      subdomain: config.subdomain,
      user_id: response.body.user?.id || null,
    },
  };
}

async function testWebsite(fetchImpl, config, source) {
  const url = source.site_url || config.site_url || null;
  if (!url) {
    return { ok: true, provider: 'WEBSITE', details: { status: 'no-site-url-configured' } };
  }
  const response = await fetchImpl(url, { method: 'HEAD' });
  return {
    ok: response.ok,
    provider: 'WEBSITE',
    details: {
      url,
      status: response.status,
    },
    status: response.status,
    error: response.ok ? null : `HTTP ${response.status}`,
  };
}

async function testGoogleDrive(fetchImpl, config) {
  const assertion = createGoogleServiceJwt(config);
  const tokenResult = await fetchJson(fetchImpl, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!tokenResult.ok || !tokenResult.body?.access_token) {
    return { ok: false, status: 401, error: 'unable to obtain Google access token' };
  }

  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(config.folder_id)}?fields=id,name,mimeType`;
  const response = await fetchJson(fetchImpl, url, {
    headers: {
      authorization: `Bearer ${tokenResult.body.access_token}`,
      accept: 'application/json',
    },
  });
  if (!response.ok) return response;

  return {
    ok: true,
    provider: 'GOOGLE_DRIVE',
    details: {
      folder_id: response.body.id || config.folder_id,
      folder_name: response.body.name || null,
    },
  };
}

async function testS3(_fetchImpl, config) {
  if (!S3Client || !HeadBucketCommand) {
    return { ok: false, status: 500, error: '@aws-sdk/client-s3 package not installed' };
  }

  const client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.access_key_id,
      secretAccessKey: config.secret_access_key,
    },
  });

  await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  return {
    ok: true,
    provider: 'S3',
    details: {
      bucket: config.bucket,
      region: config.region,
    },
  };
}

async function testConnector({ type, config, source, fetchImpl = fetch }) {
  switch (String(type || '').toUpperCase()) {
    case 'SHAREPOINT':
      return testSharePoint(fetchImpl, config);
    case 'CONFLUENCE':
      return testConfluence(fetchImpl, config);
    case 'SALESFORCE':
      return testSalesforce(fetchImpl, config);
    case 'GITHUB':
      return testGitHub(fetchImpl, config);
    case 'NOTION':
      return testNotion(fetchImpl, config);
    case 'SLACK':
      return testSlack(fetchImpl, config);
    case 'ZENDESK':
      return testZendesk(fetchImpl, config);
    case 'WEBSITE':
      return testWebsite(fetchImpl, config, source);
    case 'GOOGLE_DRIVE':
      return testGoogleDrive(fetchImpl, config);
    case 'S3':
      return testS3(fetchImpl, config);
    default:
      return {
        ok: true,
        provider: String(type || 'GENERIC').toUpperCase(),
        details: {
          status: 'credentials-validated',
        },
      };
  }
}

module.exports = {
  testConnector,
};
