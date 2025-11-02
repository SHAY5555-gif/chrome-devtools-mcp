#!/usr/bin/env node

/**
 * Spin up a BrowserUse session and bridge it to chrome-devtools-mcp.
 *
 * Usage:
 *   node browseruse-mcp.js [extra chrome-devtools-mcp args...]
 *
 * Configuration (CLI/env):
 *   --apiKey | BROWSERUSE_API_KEY | API_KEY
 */

const { spawn } = require('child_process');
const path = require('path');

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

const API_KEY =
  argvFlags.apiKey || process.env.BROWSERUSE_API_KEY || process.env.API_KEY || DEFAULT_API_KEY;

if (!API_KEY) {
  console.error('Missing BrowserUse API key. Set BROWSERUSE_API_KEY.');
  process.exit(1);
}

async function request(path, { method = 'GET', body } = {}) {
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

const log = (...args) => {
  process.stderr.write(`${args.join(' ')}\n`);
};

async function main() {
  log('Creating BrowserUse session (MCP bridge)...');

  const session = await request('/browsers', {
    method: 'POST',
    body: {},
  });

  log('Session response:', JSON.stringify(session, null, 2));

  const sessionId = session.id;
  const cdpBaseUrl = session.cdpUrl;

  if (!cdpBaseUrl) {
    throw new Error('No CDP URL returned from BrowserUse API. Response: ' + JSON.stringify(session));
  }

  // Fetch the actual WebSocket URL from the CDP endpoint with retries
  // The browser might take a few seconds to start up
  const versionUrl = `${cdpBaseUrl}/json/version`;
  const maxRetries = 30;
  const retryDelay = 1000; // 1 second
  let versionData;
  let browserWs;

  log('Waiting for browser to be ready...');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const versionResponse = await fetch(versionUrl);

      if (versionResponse.ok) {
        versionData = await versionResponse.json();
        if (versionData.webSocketDebuggerUrl) {
          browserWs = versionData.webSocketDebuggerUrl;
          log(`Browser ready after ${attempt} attempt(s)`);
          break;
        }
      }

      if (attempt < maxRetries) {
        log(`Browser not ready yet (attempt ${attempt}/${maxRetries}), retrying in ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    } catch (error) {
      if (attempt < maxRetries) {
        log(`Error connecting (attempt ${attempt}/${maxRetries}): ${error.message}, retrying...`);
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

  // Forward any extra args intended for chrome-devtools-mcp (filter out our own flags)
  const ownFlags = new Set(['apiKey']);
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
  log(`  Status:     ${session.status}`);
  log(`  CDP URL:    ${browserWs}`);

  const childEnv = {
    ...process.env,
    BROWSERUSE_SESSION_ID: sessionId,
    BROWSERUSE_BROWSER_WS: browserWs,
  };

  log('\nLaunching chrome-devtools-mcp...');

  let cleanedUp = false;
  const cleanup = async (exitCode) => {
    if (cleanedUp) return exitCode;
    cleanedUp = true;
    // Note: BrowserUse sessions expire automatically after timeout
    // There is no DELETE API endpoint available
    log(`BrowserUse session ${sessionId} will expire automatically.`);
    return exitCode;
  };

  let child;

  const cliPath =
    process.env.BROWSERUSE_MCP_CLI ??
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
