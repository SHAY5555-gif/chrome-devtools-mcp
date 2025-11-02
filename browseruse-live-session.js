#!/usr/bin/env node

/**
 * Creates a BrowserUse session and prints helpful URLs/commands.
 *
 * Usage:
 *   BROWSERUSE_API_KEY=... node browseruse-live-session.js
 *
 * If BROWSERUSE_API_KEY is not provided, the default key will be used.
 */

const DEFAULT_API_KEY = 'bu_PADcJkMV3f1fqJJpuPuV71dIwntRHeCvcZSkGrOjZHc';

function parseArgs(argv) {
  const out = {};
  const arr = argv.slice(2);
  for (let i = 0; i < arr.length; i++) {
    const token = arr[i];
    if (!token.startsWith('--')) continue;
    const [key, maybeVal] = token.replace(/^--/, '').split('=');
    if (maybeVal !== undefined) {
      out[key] = maybeVal;
      continue;
    }
    const next = arr[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

const argvFlags = parseArgs(process.argv);

const API_KEY = argvFlags.apiKey || process.env.BROWSERUSE_API_KEY || process.env.API_KEY || DEFAULT_API_KEY;

if (!API_KEY) {
  console.error('Missing BrowserUse API key. Set BROWSERUSE_API_KEY.');
  process.exit(1);
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.browser-use.com/api/v2${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Browser-Use-API-Key': API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BrowserUse API ${method} ${path} failed: ${res.status} ${res.statusText}\n${text}`);
  }

  return res.json();
}

async function main() {
  console.log('Creating BrowserUse session...');
  const session = await request('/browsers', {
    method: 'POST',
    body: {},
  });

  const sessionId = session.id;
  const cdpBaseUrl = session.cdpUrl;

  console.log('\nSession created successfully:');
  console.log(`  Session ID: ${sessionId}`);
  console.log(`  Status:     ${session.status}`);
  console.log(`  CDP Base:   ${cdpBaseUrl}`);

  // Fetch the actual WebSocket URL with retries
  console.log('\nWaiting for browser to be ready...');
  const versionUrl = `${cdpBaseUrl}/json/version`;
  const maxRetries = 30;
  const retryDelay = 1000; // 1 second
  let versionData;
  let wsUrl;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const versionResponse = await fetch(versionUrl);

      if (versionResponse.ok) {
        versionData = await versionResponse.json();
        if (versionData.webSocketDebuggerUrl) {
          wsUrl = versionData.webSocketDebuggerUrl;
          console.log(`Browser ready after ${attempt} attempt(s)`);
          break;
        }
      }

      if (attempt < maxRetries) {
        process.stdout.write(`  Attempt ${attempt}/${maxRetries}...\r`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    } catch (error) {
      if (attempt < maxRetries) {
        process.stdout.write(`  Attempt ${attempt}/${maxRetries} (error: ${error.message})...\r`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        throw error;
      }
    }
  }

  if (!wsUrl) {
    throw new Error(`Browser did not become ready after ${maxRetries} attempts`);
  }

  console.log('\nConnect endpoints:');
  console.log(`  CDP Base URL: ${cdpBaseUrl}`);
  console.log(`  WebSocket URL: ${wsUrl}`);

  console.log('\nPowerShell snippet for chrome-devtools-mcp:');
  console.log(`  $env:BU_WS_URL = '${wsUrl}';`);
  console.log('  npx -y chrome-devtools-mcp@latest --browserUrl $env:BU_WS_URL');

  console.log('\nTo clean up this session later, run:');
  console.log(`  curl -X DELETE https://api.browser-use.com/api/v2/browsers/${sessionId} \\`);
  console.log(`       -H "X-Browser-Use-API-Key: ${API_KEY}"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
