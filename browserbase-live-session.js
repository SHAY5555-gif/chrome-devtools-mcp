#!/usr/bin/env node

/**
 * Creates a Browserbase session and prints helpful URLs/commands.
 *
 * Usage:
 *   BROWSERBASE_API_KEY=... node browserbase-live-session.js
 *
 * If BROWSERBASE_API_KEY is not provided, the default key (from the user request)
 * will be used. Override BROWSERBASE_PROJECT_ID to target a different project.
 */

const DEFAULT_API_KEY = 'bb_live_1dl_uqDytSMn3XfdRQov3ffSgyQ';
const DEFAULT_PROJECT_ID = '714e774c-9745-4383-99d5-f64df74919b9';

const API_KEY = process.env.BROWSERBASE_API_KEY || DEFAULT_API_KEY;
const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID || DEFAULT_PROJECT_ID;

if (!API_KEY) {
  console.error('Missing Browserbase API key. Set BROWSERBASE_API_KEY.');
  process.exit(1);
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.browserbase.com${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-bb-api-key': API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Browserbase API ${method} ${path} failed: ${res.status} ${res.statusText}\n${text}`);
  }

  return res.json();
}

function buildQuery(sessionId, signingKey) {
  const params = new URLSearchParams();
  params.set('sessionId', sessionId);
  params.set('signingKey', signingKey);
  params.set('apiKey', API_KEY);
  return params;
}

async function main() {
  console.log('Creating Browserbase session...');
  const session = await request('/v1/sessions', {
    method: 'POST',
    body: {
      projectId: PROJECT_ID,
      keepAlive: true,
      userMetadata: { mcp: 'true', stagehand: 'true' },
    },
  });

  const { id: sessionId, signingKey } = session;
  const query = buildQuery(sessionId, signingKey);

  const versionUrl = `https://connect.browserbase.com/json/version?${query.toString()}`;
  const version = await fetch(versionUrl).then(async (res) => {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch /json/version: ${res.status} ${res.statusText}\n${text}`);
    }
    return res.json();
  });

  const listUrl = `https://connect.browserbase.com/json/list?${query.toString()}`;
  const targets = await fetch(listUrl).then(async (res) => {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch /json/list: ${res.status} ${res.statusText}\n${text}`);
    }
    return res.json();
  });

  const pageTarget =
    targets.find((target) => target.type === 'page') ||
    targets.find((target) => target.type === 'tab');

  if (!pageTarget) {
    throw new Error('No page/tab target found in the session.');
  }

  const browserWs = `${version.webSocketDebuggerUrl.replace('ws://', 'wss://')}?${query.toString()}`;
  const pageWs = `${pageTarget.webSocketDebuggerUrl.replace('ws://', 'wss://')}?${query.toString()}`;

  const frontendBase = pageTarget.devtoolsFrontendUrl.startsWith('http')
    ? new URL(pageTarget.devtoolsFrontendUrl)
    : new URL(pageTarget.devtoolsFrontendUrl, 'https://chrome-devtools-frontend.appspot.com');
  const wsParamValue = `${new URL(browserWs).host}${new URL(pageWs).pathname}?${query.toString()}`;
  frontendBase.searchParams.set('ws', wsParamValue);

  const inspectorUrl = new URL('https://www.browserbase.com/devtools/inspector.html');
  inspectorUrl.searchParams.set('wss', `${new URL(pageWs).host}${new URL(pageWs).pathname}`);
  inspectorUrl.searchParams.set('sessionId', sessionId);
  inspectorUrl.searchParams.set('signingKey', signingKey);
  inspectorUrl.searchParams.set('apiKey', API_KEY);

  console.log('\nSession created successfully:');
  console.log(`  Session ID: ${sessionId}`);
  console.log(`  Region: ${session.region}`);
  console.log(`  Expires At: ${session.expiresAt}`);

  console.log('\nConnect endpoints:');
  console.log(`  Browser WS endpoint: ${browserWs}`);
  console.log(`  Page WS endpoint:    ${pageWs}`);

  console.log('\nDevTools viewers:');
  console.log(`  Chrome DevTools front-end: ${frontendBase.toString()}`);
  console.log(`  Browserbase inspector:     ${inspectorUrl.toString()}`);

  console.log('\nPowerShell snippet for chrome-devtools-mcp:');
  console.log(`  $env:BB_DEVTOOLS_WS = '${browserWs}';`);
  console.log('  npx -y chrome-devtools-mcp@latest --browserWSEndpoint $env:BB_DEVTOOLS_WS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

