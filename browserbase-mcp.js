#!/usr/bin/env node

/**
 * Spin up a Browserbase session and bridge it to chrome-devtools-mcp.
 *
 * Usage:
 *   node browserbase-mcp.js [extra chrome-devtools-mcp args...]
 *
 * Configuration (CLI/env):
 *   --apiKey | BROWSERBASE_API_KEY | API_KEY
 *   --projectId | BROWSERBASE_PROJECT_ID | PROJECT_ID
 *   --contextId | BROWSERBASE_CONTEXT_ID | CONTEXT_ID
 *   --persist | BROWSERBASE_PERSIST | PERSIST (true/false)
 */

const { spawn } = require('child_process');
const path = require('path');

const DEFAULT_API_KEY = 'bb_live_1dl_uqDytSMn3XfdRQov3ffSgyQ';
const DEFAULT_PROJECT_ID = '714e774c-9745-4383-99d5-f64df74919b9';
const DEFAULT_CONTEXT_ID = '77909aa9-e5ff-47cc-a370-df4c2648fb64';
const DEFAULT_PERSIST = true;

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

function coerceBool(val, dflt) {
  if (val === undefined || val === null || val === '') return dflt;
  const s = String(val).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

const argvFlags = parseArgs(process.argv);

const API_KEY =
  argvFlags.apiKey || process.env.BROWSERBASE_API_KEY || process.env.API_KEY || DEFAULT_API_KEY;
const PROJECT_ID =
  argvFlags.projectId || process.env.BROWSERBASE_PROJECT_ID || process.env.PROJECT_ID || DEFAULT_PROJECT_ID;
const CONTEXT_ID =
  argvFlags.contextId || process.env.BROWSERBASE_CONTEXT_ID || process.env.CONTEXT_ID || DEFAULT_CONTEXT_ID;
const PERSIST = coerceBool(
  argvFlags.persist ?? process.env.BROWSERBASE_PERSIST ?? process.env.PERSIST,
  DEFAULT_PERSIST,
);

if (!API_KEY) {
  console.error('Missing Browserbase API key. Set BROWSERBASE_API_KEY.');
  process.exit(1);
}

async function request(path, { method = 'GET', body } = {}) {
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

function ensureWss(url) {
  if (url.startsWith('wss://')) return url;
  if (url.startsWith('ws://')) return `wss://${url.slice('ws://'.length)}`;
  return url;
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

function buildInspectorUrl(pageWs, sessionId, signingKey) {
  const inspector = new URL('https://www.browserbase.com/devtools/inspector.html');
  const wsUrl = new URL(pageWs);

  inspector.searchParams.set('wss', `${wsUrl.host}${wsUrl.pathname}`);
  inspector.searchParams.set('sessionId', sessionId);
  inspector.searchParams.set('signingKey', signingKey);
  inspector.searchParams.set('apiKey', API_KEY);

  return inspector.toString();
}

function buildFrontendUrl(pageWs) {
  const frontend = new URL('https://chrome-devtools-frontend.appspot.com/serve_rev/@c759967f1b8ca5857065acaa4f7b5cdb3a12df7b/inspector.html');
  const wsUrl = new URL(pageWs);
  const wsParam = `${wsUrl.host}${wsUrl.pathname}?${wsUrl.searchParams.toString()}`;
  frontend.searchParams.set('ws', wsParam);
  return frontend.toString();
}

const log = (...args) => {
  process.stderr.write(`${args.join(' ')}\n`);
};

async function main() {
  log('Creating Browserbase session (MCP bridge)...');

  const session = await request('/v1/sessions', {
    method: 'POST',
    body: {
      projectId: PROJECT_ID,
      keepAlive: true,
      browserSettings: {
        context: {
          id: CONTEXT_ID,
          persist: PERSIST,
        },
      },
      userMetadata: { mcp: 'true', stagehand: 'true' },
    },
  });

  const sessionId = session.id;
  const signingKey = session.signingKey;
  const query = buildQuery(sessionId, signingKey);
  // Forward any extra args intended for chrome-devtools-mcp (filter out our own flags)
  const ownFlags = new Set(['apiKey', 'projectId', 'contextId', 'persist']);
  const extraArgs = process.argv
    .slice(2)
    .filter((t, idx, arr) => {
      if (!t.startsWith('--')) return true;
      const key = t.replace(/^--/, '').split('=')[0];
      if (ownFlags.has(key)) {
        // skip this flag and its value if provided as separate token
        const next = arr[idx + 1];
        if (next && !next.startsWith('--')) {
          arr[idx + 1] = '--__consumed__';
        }
        return false;
      }
      return true;
    })
    .filter(t => t !== '--__consumed__');

  log(`  Session ID: ${sessionId}`);
  log(`  Region:     ${session.region}`);
  log(`  Expires:    ${session.expiresAt}`);
  log(`  Context ID: ${CONTEXT_ID}`);
  log(`  Persist:    ${PERSIST}`);

  const version = await fetchConnectJson('json/version', query);
  const targets = await fetchConnectJson('json/list', query);

  const pageTarget =
    targets.find((target) => target.type === 'page' || target.type === 'tab') ?? targets[0];

  if (!pageTarget) {
    throw new Error('No DevTools targets returned for the session.');
  }

  const browserWs = `${ensureWss(version.webSocketDebuggerUrl)}?${query.toString()}`;
  const pageWs = `${ensureWss(pageTarget.webSocketDebuggerUrl)}?${query.toString()}`;

  log('\nConnect endpoints:');
  log(`  Browser WS: ${browserWs}`);
  log(`  Page WS:    ${pageWs}`);

  log('\nDevTools viewers:');
  log(`  Chrome front-end: ${buildFrontendUrl(pageWs)}`);
  log(`  Browserbase UI:   ${buildInspectorUrl(pageWs, sessionId, signingKey)}`);

  const childEnv = {
    ...process.env,
    BROWSERBASE_SESSION_ID: sessionId,
    BROWSERBASE_SIGNING_KEY: signingKey,
    BROWSERBASE_BROWSER_WS: browserWs,
    BROWSERBASE_PAGE_WS: pageWs,
  };

  log('\nLaunching chrome-devtools-mcp...');

  let cleanedUp = false;
  const cleanup = async (exitCode) => {
    if (cleanedUp) return exitCode;
    cleanedUp = true;
    try {
      await request(`/v1/sessions/${sessionId}`, { method: 'DELETE' });
    } catch (err) {
      // Ignore cleanup errors; session will expire on its own.
    }
    return exitCode;
  };

  let child;

  const cliPath =
    process.env.BROWSERBASE_MCP_CLI ??
    path.resolve(__dirname, 'build', 'src', 'index.js');
  const spawnArgs = [cliPath, '--browserUrl', browserWs, ...extraArgs];
  child = spawn(process.execPath, spawnArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });

  if (child.stdin) {
    process.stdin.pipe(child.stdin);
    child.stdin.on('error', (err) => {
      if (err && err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
        log(`chrome-devtools-mcp stdin error: ${err.message}`);
      }
    });
  }

  if (child.stdout) {
    let handshakeStarted = false;
    let buffered = '';

    child.stdout.on('data', (chunk) => {
      if (handshakeStarted) {
        process.stdout.write(chunk);
        return;
      }

      buffered += chunk.toString('utf8');
      const firstBrace = (() => {
        const braceIndex = buffered.indexOf('{');
        const bracketIndex = buffered.indexOf('[');
        if (braceIndex === -1) return bracketIndex;
        if (bracketIndex === -1) return braceIndex;
        return Math.min(braceIndex, bracketIndex);
      })();

      if (firstBrace === -1) {
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            log(`[chrome-devtools-mcp] ${trimmed}`);
          }
        }
        return;
      }

      const prefix = buffered.slice(0, firstBrace);
      if (prefix) {
        const lines = prefix.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            log(`[chrome-devtools-mcp] ${trimmed}`);
          }
        }
      }

      const rest = buffered.slice(firstBrace);
      process.stdout.write(rest);
      handshakeStarted = true;
      buffered = '';
    });

    child.stdout.on('end', () => {
      if (!handshakeStarted) {
        const trimmed = buffered.trim();
        if (trimmed) {
          log(`[chrome-devtools-mcp stdout] ${trimmed}`);
        }
      }
    });
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      text
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .forEach((line) => log(`[chrome-devtools-mcp stderr] ${line}`));
    });
  }

  child.on('error', async (err) => {
    console.error('Failed to start chrome-devtools-mcp:', err);
    const code = await cleanup(1);
    process.exit(code);
  });

  child.on('exit', async (code, signal) => {
    if (signal) {
      log(`chrome-devtools-mcp exited due to signal ${signal}`);
    } else {
      log(`chrome-devtools-mcp exited with code ${code ?? 0}`);
    }
    const exitCode = signal ? 1 : code ?? 0;
    const cleaned = await cleanup(exitCode);
    process.exit(cleaned);
  });

  const handleSignal = async (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
