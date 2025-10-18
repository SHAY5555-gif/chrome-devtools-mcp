#!/usr/bin/env node

/**
 * Bridge Browserbase → chrome-devtools-mcp (HTTP transport).
 * - Creates a Browserbase session and computes the signed browser WS URL.
 * - Exposes it to the MCP server via env BROWSERBASE_BROWSER_WS.
 * - Starts the MCP HTTP server (node build/src/index.js) and proxies exit/cleanup.
 */

import {spawn} from 'node:child_process';
import path from 'node:path';

const API_KEY = process.env.BROWSERBASE_API_KEY || '';
const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID || '';
const CONTEXT_ID = process.env.BROWSERBASE_CONTEXT_ID || '';
const PERSIST =
  process.env.BROWSERBASE_PERSIST !== undefined
    ? process.env.BROWSERBASE_PERSIST === 'true'
    : true;

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

function ensureWss(url) {
  if (url.startsWith('wss://')) return url;
  if (url.startsWith('ws://')) return `wss://${url.slice('ws://'.length)}`;
  return url;
}

async function request(path, {method = 'GET', body} = {}) {
  const res = await fetch(`https://api.browserbase.com${path}`, {
    method,
    headers: body
      ? {
          'Content-Type': 'application/json',
          'x-bb-api-key': API_KEY,
        }
      : {
          'x-bb-api-key': API_KEY,
        },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Browserbase API ${method} ${path} failed: ${res.status} ${res.statusText}\n${text}`,
    );
  }
  if (res.status === 204) return null;
  return res.json();
}

function buildQuery(sessionId, signingKey) {
  const params = new URLSearchParams();
  params.set('sessionId', sessionId);
  params.set('signingKey', signingKey);
  params.set('apiKey', API_KEY);
  return params;
}

async function fetchConnectJson(endpoint, query) {
  const url = `https://connect.browserbase.com/${endpoint}?${query.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to fetch ${endpoint}: ${res.status} ${res.statusText}\n${text}`);
  }
  return res.json();
}

async function main() {
  if (!API_KEY) {
    console.error('Missing Browserbase API key. Set BROWSERBASE_API_KEY.');
    process.exit(1);
  }
  if (!PROJECT_ID) {
    console.error('Missing Browserbase project id. Set BROWSERBASE_PROJECT_ID.');
    process.exit(1);
  }

  log('Creating Browserbase session (HTTP bridge)...');
  const session = await request('/v1/sessions', {
    method: 'POST',
    body: {
      projectId: PROJECT_ID,
      keepAlive: true,
      browserSettings: {
        context: CONTEXT_ID
          ? {
              id: CONTEXT_ID,
              persist: !!PERSIST,
            }
          : undefined,
      },
      userMetadata: {mcp: 'true', bridge: 'http'},
    },
  });

  const sessionId = session.id;
  const signingKey = session.signingKey;
  const query = buildQuery(sessionId, signingKey);

  log(`  Session ID: ${sessionId}`);
  if (session.region) log(`  Region:     ${session.region}`);
  if (session.expiresAt) log(`  Expires:    ${session.expiresAt}`);
  if (CONTEXT_ID) log(`  Context ID: ${CONTEXT_ID}`);
  log(`  Persist:    ${PERSIST}`);

  const version = await fetchConnectJson('json/version', query);
  const targets = await fetchConnectJson('json/list', query);
  const pageTarget =
    targets.find(t => t.type === 'page' || t.type === 'tab') ?? targets[0];
  if (!pageTarget) {
    throw new Error('No DevTools targets returned for the session.');
  }

  const browserWs = `${ensureWss(version.webSocketDebuggerUrl)}?${query.toString()}`;
  const pageWs = `${ensureWss(pageTarget.webSocketDebuggerUrl)}?${query.toString()}`;

  log('\nConnect endpoints:');
  log(`  Browser WS: ${browserWs}`);
  log(`  Page WS:    ${pageWs}`);

  // Launch MCP HTTP server with env fallback for browserUrl.
  const cliPath =
    process.env.BROWSERBASE_MCP_CLI ??
    path.resolve(process.cwd(), 'build', 'src', 'index.js');

  const childEnv = {
    ...process.env,
    TRANSPORT: 'http',
    // For debugging/observability if desired:
    BROWSERBASE_SESSION_ID: sessionId,
    BROWSERBASE_SIGNING_KEY: signingKey,
    BROWSERBASE_BROWSER_WS: browserWs,
    BROWSERBASE_PAGE_WS: pageWs,
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
    try {
      await request(`/v1/sessions/${sessionId}`, {method: 'DELETE'});
    } catch {
      // ignore
    }
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

