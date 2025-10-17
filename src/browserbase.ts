/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const BROWSERBASE_API_BASE = 'https://api.browserbase.com';
const BROWSERBASE_CONNECT_BASE = 'https://connect.browserbase.com';

export const DEFAULT_BROWSERBASE_PROJECT_ID = 'bc914a3df39095025464368c5cabf0af8ae97b1f';

export interface BrowserbaseOptions {
  apiKey: string;
  projectId?: string;
  contextId?: string;
  persist?: boolean;
}

interface BrowserbaseSessionResponse {
  id: string;
  signingKey: string;
  region: string;
  expiresAt: string;
}

interface BrowserbaseVersionResponse {
  webSocketDebuggerUrl: string;
}

interface BrowserbaseTargetResponse {
  type?: string;
  webSocketDebuggerUrl?: string;
}

export interface BrowserbaseSession {
  browserWs: string;
  pageWs: string;
  inspectorUrl: string;
  frontendUrl: string;
  sessionId: string;
  cleanup: () => Promise<void>;
}

async function browserbaseRequest<T>(
  apiKey: string,
  path: string,
  {method = 'GET', body}: {method?: string; body?: unknown} = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'x-bb-api-key': apiKey,
  };

  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${BROWSERBASE_API_BASE}${path}`, {
    method,
    headers,
    body: payload,
  });

  if (!response.ok) {
    const text = await response
      .text()
      .catch(() => '')
      .then(contents => (contents ? `\n${contents}` : ''));
    throw new Error(
      `Browserbase API ${method} ${path} failed: ${response.status} ${response.statusText}${text}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function ensureWss(url: string): string {
  if (url.startsWith('wss://')) {
    return url;
  }
  if (url.startsWith('ws://')) {
    return `wss://${url.slice('ws://'.length)}`;
  }
  return url;
}

function buildQuery(sessionId: string, signingKey: string, apiKey: string): URLSearchParams {
  const params = new URLSearchParams();
  params.set('sessionId', sessionId);
  params.set('signingKey', signingKey);
  params.set('apiKey', apiKey);
  return params;
}

async function fetchConnectJson<T>(endpoint: string, query: URLSearchParams): Promise<T> {
  const url = `${BROWSERBASE_CONNECT_BASE}/${endpoint}?${query.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    const text = await response
      .text()
      .catch(() => '')
      .then(contents => (contents ? `\n${contents}` : ''));
    throw new Error(
      `Browserbase connect ${endpoint} failed: ${response.status} ${response.statusText}${text}`,
    );
  }

  return (await response.json()) as T;
}

function buildInspectorUrl(
  pageWs: string,
  sessionId: string,
  signingKey: string,
  apiKey: string,
): string {
  const inspector = new URL('https://www.browserbase.com/devtools/inspector.html');
  const wsUrl = new URL(pageWs);

  inspector.searchParams.set('wss', `${wsUrl.host}${wsUrl.pathname}`);
  inspector.searchParams.set('sessionId', sessionId);
  inspector.searchParams.set('signingKey', signingKey);
  inspector.searchParams.set('apiKey', apiKey);

  return inspector.toString();
}

function buildFrontendUrl(pageWs: string): string {
  const frontend = new URL(
    'https://chrome-devtools-frontend.appspot.com/serve_rev/@c759967f1b8ca5857065acaa4f7b5cdb3a12df7b/inspector.html',
  );
  const wsUrl = new URL(pageWs);
  const wsParam = `${wsUrl.host}${wsUrl.pathname}?${wsUrl.searchParams.toString()}`;
  frontend.searchParams.set('ws', wsParam);
  return frontend.toString();
}

export async function createBrowserbaseSession(
  options: BrowserbaseOptions,
  log: (message: string) => void,
): Promise<BrowserbaseSession> {
  const projectId = options.projectId ?? DEFAULT_BROWSERBASE_PROJECT_ID;
  const hasContext = Boolean(options.contextId);
  const persist = options.persist ?? true;

  log(
    `Creating Browserbase session (project ${projectId}${
      hasContext ? `, context ${options.contextId}` : ''
    })...`,
  );

  const sessionBody: Record<string, unknown> = {
    projectId,
    keepAlive: true,
    userMetadata: {mcp: 'true', stagehand: 'true'},
  };

  if (hasContext) {
    sessionBody.browserSettings = {
      context: {
        id: options.contextId,
        persist,
      },
    };
  }

  const session = await browserbaseRequest<BrowserbaseSessionResponse>(
    options.apiKey,
    '/v1/sessions',
    {
      method: 'POST',
      body: sessionBody,
    },
  );

  const sessionId = session.id;
  const signingKey = session.signingKey;
  const query = buildQuery(sessionId, signingKey, options.apiKey);

  log(`Browserbase session ready (ID ${sessionId}, region ${session.region}, expires ${session.expiresAt}).`);
  if (hasContext) {
    log(`Context ID: ${options.contextId}, persist: ${persist}`);
  }

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    try {
      await browserbaseRequest(options.apiKey, `/v1/sessions/${sessionId}`, {method: 'DELETE'});
    } catch (error) {
      log(`Failed to clean up Browserbase session ${sessionId}: ${String(error)}`);
    }
  };

  try {
    const version = await fetchConnectJson<BrowserbaseVersionResponse>('json/version', query);
    const targets = await fetchConnectJson<BrowserbaseTargetResponse[]>('json/list', query);

    const pageTarget =
      targets.find(target => target.type === 'page' || target.type === 'tab') ?? targets[0];

    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error('No DevTools targets returned for the Browserbase session.');
    }

    const browserWs = `${ensureWss(version.webSocketDebuggerUrl)}?${query.toString()}`;
    const pageWs = `${ensureWss(pageTarget.webSocketDebuggerUrl)}?${query.toString()}`;
    const inspectorUrl = buildInspectorUrl(pageWs, sessionId, signingKey, options.apiKey);
    const frontendUrl = buildFrontendUrl(pageWs);

    log('Browserbase DevTools endpoints:');
    log(`  Browser WS: ${browserWs}`);
    log(`  Page WS:    ${pageWs}`);
    log('Browserbase viewers:');
    log(`  Chrome front-end: ${frontendUrl}`);
    log(`  Browserbase UI:   ${inspectorUrl}`);

    return {
      browserWs,
      pageWs,
      inspectorUrl,
      frontendUrl,
      sessionId,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
