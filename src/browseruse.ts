/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const BROWSERUSE_API_BASE = 'https://api.browser-use.com/api/v2';

export interface BrowserUseOptions {
  apiKey: string;
}

interface BrowserUseSessionResponse {
  id: string;
  cdpUrl: string;
  status: string;
}

export interface BrowserUseSession {
  browserWs: string;
  sessionId: string;
  cleanup: () => Promise<void>;
}

async function browserUseRequest<T>(
  apiKey: string,
  path: string,
  {method = 'GET', body}: {method?: string; body?: unknown} = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'X-Browser-Use-API-Key': apiKey,
  };

  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${BROWSERUSE_API_BASE}${path}`, {
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
      `BrowserUse API ${method} ${path} failed: ${response.status} ${response.statusText}${text}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function createBrowserUseSession(
  options: BrowserUseOptions,
  log: (message: string) => void,
): Promise<BrowserUseSession> {
  log('Creating BrowserUse session...');

  const session = await browserUseRequest<BrowserUseSessionResponse>(
    options.apiKey,
    '/browsers',
    {
      method: 'POST',
      body: {},
    },
  );

  const sessionId = session.id;
  const cdpBaseUrl = session.cdpUrl;

  log(`BrowserUse session ready (ID ${sessionId}, status ${session.status}).`);
  log(`CDP Base URL: ${cdpBaseUrl}`);

  // Fetch the actual WebSocket URL from the CDP endpoint
  const versionUrl = `${cdpBaseUrl}/json/version`;
  const versionResponse = await fetch(versionUrl);

  if (!versionResponse.ok) {
    throw new Error(
      `Failed to fetch CDP version from ${versionUrl}: ${versionResponse.status} ${versionResponse.statusText}`,
    );
  }

  const versionData = await versionResponse.json();
  const browserWs = versionData.webSocketDebuggerUrl;

  if (!browserWs) {
    throw new Error(`No webSocketDebuggerUrl found in CDP version response from ${versionUrl}`);
  }

  log('BrowserUse DevTools endpoints:');
  log(`  Browser WS: ${browserWs}`);

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    try {
      await browserUseRequest(options.apiKey, `/browsers/${sessionId}`, {method: 'DELETE'});
      log(`BrowserUse session ${sessionId} cleaned up.`);
    } catch (error) {
      log(`Failed to clean up BrowserUse session ${sessionId}: ${String(error)}`);
    }
  };

  return {
    browserWs,
    sessionId,
    cleanup,
  };
}
