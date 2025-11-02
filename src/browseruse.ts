/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const BROWSERUSE_API_BASE = 'https://api.browser-use.com/api/v2';

export interface BrowserUseOptions {
  apiKey: string;
  proxyCountryCode?: string;
  startUrl?: string;
  profileId?: string;
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

  // Build request body with optional parameters
  const requestBody: Record<string, string> = {};
  if (options.proxyCountryCode) {
    requestBody.proxyCountryCode = options.proxyCountryCode;
    log(`Using proxy country code: ${options.proxyCountryCode}`);
  }
  if (options.startUrl) {
    requestBody.startUrl = options.startUrl;
    log(`Starting with URL: ${options.startUrl}`);
  }
  if (options.profileId) {
    requestBody.profileId = options.profileId;
    log(`Using profile ID: ${options.profileId}`);
  }

  const session = await browserUseRequest<BrowserUseSessionResponse>(
    options.apiKey,
    '/browsers',
    {
      method: 'POST',
      body: requestBody,
    },
  );

  const sessionId = session.id;
  const cdpBaseUrl = session.cdpUrl;

  log(`BrowserUse session ready (ID ${sessionId}, status ${session.status}).`);
  log(`CDP Base URL: ${cdpBaseUrl}`);

  // Fetch the actual WebSocket URL from the CDP endpoint with retries
  // The browser might take a few seconds to start up
  const versionUrl = `${cdpBaseUrl}/json/version`;
  const maxRetries = 30;
  const retryDelay = 1000; // 1 second
  let versionData: {webSocketDebuggerUrl?: string} | undefined;

  log('Waiting for browser to be ready...');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const versionResponse = await fetch(versionUrl);

      if (versionResponse.ok) {
        const data = await versionResponse.json();
        if (data && typeof data === 'object' && 'webSocketDebuggerUrl' in data) {
          versionData = data as {webSocketDebuggerUrl?: string};
          if (versionData.webSocketDebuggerUrl) {
            log(`Browser ready after ${attempt} attempt(s)`);
            break;
          }
        }
      }

      if (attempt < maxRetries) {
        log(`Browser not ready yet (attempt ${attempt}/${maxRetries}), retrying in ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    } catch (error) {
      if (attempt < maxRetries) {
        log(`Error connecting (attempt ${attempt}/${maxRetries}): ${String(error)}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        throw error;
      }
    }
  }

  if (!versionData?.webSocketDebuggerUrl) {
    throw new Error(
      `Browser did not become ready after ${maxRetries} attempts. CDP endpoint: ${versionUrl}`,
    );
  }

  const browserWs = versionData.webSocketDebuggerUrl;

  log('BrowserUse DevTools endpoints:');
  log(`  Browser WS: ${browserWs}`);

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    // Note: BrowserUse sessions expire automatically after timeout
    // There is no DELETE API endpoint available
    log(`BrowserUse session ${sessionId} will expire automatically at timeout.`);
  };

  return {
    browserWs,
    sessionId,
    cleanup,
  };
}
