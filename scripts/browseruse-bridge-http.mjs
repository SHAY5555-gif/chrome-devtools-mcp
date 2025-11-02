#!/usr/bin/env node

/**
 * Bridge BrowserUse → chrome-devtools-mcp (HTTP transport).
 * - Creates a BrowserUse session and fetches the WebSocket URL.
 * - Exposes it to the MCP server via env BROWSERUSE_BROWSER_WS.
 * - Starts the MCP HTTP server (node build/src/index.js) and proxies exit/cleanup.
 */

import {spawn} from 'node:child_process';
import path from 'node:path';

const API_KEY = process.env.BROWSERUSE_API_KEY || '';

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

async function request(path, {method = 'GET', body} = {}) {
  const res = await fetch(`https://api.browser-use.com/api/v2${path}`, {
    method,
    headers: body
      ? {
          'Content-Type': 'application/json',
          'X-Browser-Use-API-Key': API_KEY,
        }
      : {
          'X-Browser-Use-API-Key': API_KEY,
        },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `BrowserUse API ${method} ${path} failed: ${res.status} ${res.statusText}\n${text}`,
    );
  }
  if (res.status === 204) return null;
  return res.json();
}

async function main() {
  if (!API_KEY) {
    console.error('Missing BrowserUse API key. Set BROWSERUSE_API_KEY.');
    process.exit(1);
  }

  log('Creating BrowserUse session (HTTP bridge)...');
  const session = await request('/browsers', {
    method: 'POST',
    body: {},
  });

  const sessionId = session.id;
  const cdpBaseUrl = session.cdpUrl;

  log(`  Session ID: ${sessionId}`);
  log(`  Status:     ${session.status}`);
  log(`  CDP Base:   ${cdpBaseUrl}`);

  // Fetch the actual WebSocket URL from the CDP endpoint with retries
  const versionUrl = `${cdpBaseUrl}/json/version`;
  const maxRetries = 30;
  const retryDelay = 1000;
  let browserWs;

  log('Waiting for browser to be ready...');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const versionResponse = await fetch(versionUrl);

      if (versionResponse.ok) {
        const versionData = await versionResponse.json();
        if (versionData.webSocketDebuggerUrl) {
          browserWs = versionData.webSocketDebuggerUrl;
          log(`Browser ready after ${attempt} attempt(s)`);
          break;
        }
      }

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    } catch (error) {
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        throw error;
      }
    }
  }

  if (!browserWs) {
    throw new Error(
      `Browser did not become ready after ${maxRetries} attempts. CDP endpoint: ${versionUrl}`,
    );
  }

  log('\nConnect endpoint:');
  log(`  Browser WS: ${browserWs}`);

  // Launch MCP HTTP server with env fallback for browserUrl.
  const cliPath =
    process.env.BROWSERUSE_MCP_CLI ??
    path.resolve(process.cwd(), 'build', 'src', 'index.js');

  const childEnv = {
    ...process.env,
    TRANSPORT: 'http',
    // For debugging/observability:
    BROWSERUSE_SESSION_ID: sessionId,
    BROWSERUSE_BROWSER_WS: browserWs,
  };

  log('\nStarting MCP HTTP server...');
  const child = spawn(process.execPath, [cliPath], {
    env: childEnv,
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  let cleanedUp = false;
  const cleanup = async exitCode => {
    if (cleanedUp) return exitCode;
    cleanedUp = true;
    // Note: BrowserUse sessions expire automatically after timeout
    // There is no DELETE API endpoint available
    log(`BrowserUse session ${sessionId} will expire automatically.`);
    return exitCode;
  };

  const handleSignal = async signal => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  child.on('error', async err => {
    console.error('Failed to start MCP server:', err);
    const code = await cleanup(1);
    process.exit(code);
  });
  child.on('exit', async (code, signal) => {
    if (signal) log(`MCP server exited due to signal ${signal}`);
    const exitCode = signal ? 1 : code ?? 0;
    const cleaned = await cleanup(exitCode);
    process.exit(cleaned);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
