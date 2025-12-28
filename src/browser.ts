/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  Browser,
  ChromeReleaseChannel,
  ConnectOptions,
  LaunchOptions,
  Target,
} from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

import {BrowserUseCloud, type CreateSessionOptions} from './BrowserUseCloud.js';
import {logger} from './logger.js';

let browser: Browser | undefined;
let browserUseClient: BrowserUseCloud | undefined;

const ignoredPrefixes = new Set([
  'chrome://',
  'chrome-extension://',
  'chrome-untrusted://',
  'devtools://',
]);

function makeTargetFilter(): (target: Target) => boolean {
  return (target: Target): boolean => {
    if (target.url() === 'chrome://newtab/') {
      return true;
    }
    for (const prefix of ignoredPrefixes) {
      if (target.url().startsWith(prefix)) {
        return false;
      }
    }
    return true;
  };
}

function targetFilter(target: Target): boolean {
  return makeTargetFilter()(target);
}

const connectOptions: ConnectOptions = {
  targetFilter,
};

export async function ensureBrowserConnected(browserURL: string) {
  if (browser?.connected) {
    return browser;
  }
  browser = await puppeteer.connect({
    ...connectOptions,
    browserURL,
    defaultViewport: null,
  });
  return browser;
}

interface McpLaunchOptions {
  acceptInsecureCerts?: boolean;
  executablePath?: string;
  customDevTools?: string;
  channel?: Channel;
  userDataDir?: string;
  headless: boolean;
  isolated: boolean;
  logFile?: fs.WriteStream;
  viewport?: {
    width: number;
    height: number;
  };
  args?: string[];
}

export async function launch(options: McpLaunchOptions): Promise<Browser> {
  const {channel, executablePath, customDevTools, headless, isolated} = options;
  const profileDirName =
    channel && channel !== 'stable'
      ? `chrome-profile-${channel}`
      : 'chrome-profile';

  let userDataDir = options.userDataDir;
  if (!isolated && !userDataDir) {
    userDataDir = path.join(
      os.homedir(),
      '.cache',
      'chrome-devtools-mcp',
      profileDirName,
    );
    await fs.promises.mkdir(userDataDir, {
      recursive: true,
    });
  }

  const args: LaunchOptions['args'] = [
    ...(options.args ?? []),
    '--hide-crash-restore-bubble',
  ];
  if (customDevTools) {
    args.push(`--custom-devtools-frontend=file://${customDevTools}`);
  }
  if (headless) {
    args.push('--screen-info={3840x2160}');
  }
  let puppeteerChannel: ChromeReleaseChannel | undefined;
  if (!executablePath) {
    puppeteerChannel =
      channel && channel !== 'stable'
        ? (`chrome-${channel}` as ChromeReleaseChannel)
        : 'chrome';
  }

  try {
    const browser = await puppeteer.launch({
      channel: puppeteerChannel,
      targetFilter: makeTargetFilter(),
      executablePath,
      defaultViewport: null,
      userDataDir,
      pipe: true,
      headless,
      args,
      acceptInsecureCerts: options.acceptInsecureCerts,
    });
    if (options.logFile) {
      // FIXME: we are probably subscribing too late to catch startup logs. We
      // should expose the process earlier or expose the getRecentLogs() getter.
      browser.process()?.stderr?.pipe(options.logFile);
      browser.process()?.stdout?.pipe(options.logFile);
    }
    if (options.viewport) {
      const [page] = await browser.pages();
      // @ts-expect-error internal API for now.
      await page?.resize({
        contentWidth: options.viewport.width,
        contentHeight: options.viewport.height,
      });
    }
    return browser;
  } catch (error) {
    if (
      userDataDir &&
      ((error as Error).message.includes('The browser is already running') ||
        (error as Error).message.includes('Target closed') ||
        (error as Error).message.includes('Connection closed'))
    ) {
      throw new Error(
        `The browser is already running for ${userDataDir}. Use --isolated to run multiple browser instances.`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

export async function ensureBrowserLaunched(
  options: McpLaunchOptions,
): Promise<Browser> {
  if (browser?.connected) {
    return browser;
  }
  browser = await launch(options);
  return browser;
}

export type Channel = 'stable' | 'canary' | 'beta' | 'dev';

export interface BrowserUseCloudOptions {
  apiKey: string;
  sessionOptions?: CreateSessionOptions;
  devtools: boolean;
}

/**
 * Connects to a browser session in Browser Use Cloud.
 * Creates a new session if one doesn't exist.
 */
export async function ensureBrowserUseCloudConnected(
  options: BrowserUseCloudOptions,
): Promise<Browser> {
  if (browser?.connected) {
    return browser;
  }

  // Initialize the Browser Use Cloud client if needed
  if (!browserUseClient) {
    browserUseClient = new BrowserUseCloud(options.apiKey);
  }

  // Check if we have an active session, if not create one
  let session = browserUseClient.getCurrentSession();
  if (!session || session.status !== 'active') {
    session = await browserUseClient.createSession(options.sessionOptions);
  }

  const cdpUrl = session.cdpUrl;
  if (!cdpUrl) {
    throw new Error('Browser Use Cloud session does not have a CDP URL');
  }

  // Fetch /json/version to get the actual WebSocket URL
  logger(`Fetching WebSocket URL from ${cdpUrl}/json/version`);
  const versionResponse = await fetch(`${cdpUrl}/json/version`);
  if (!versionResponse.ok) {
    throw new Error(
      `Failed to get WebSocket URL from Browser Use Cloud: ${versionResponse.status}`,
    );
  }
  const versionData = (await versionResponse.json()) as {
    webSocketDebuggerUrl: string;
  };
  const wsUrl = versionData.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error('Browser Use Cloud did not return webSocketDebuggerUrl');
  }

  logger(`Connecting to Browser Use Cloud at ${wsUrl}`);
  console.error(`Live view URL: ${session.liveUrl}`);

  const connectOptions: Parameters<typeof puppeteer.connect>[0] = {
    browserWSEndpoint: wsUrl,
    targetFilter: makeTargetFilter(),
    defaultViewport: null,
  };

  try {
    browser = await puppeteer.connect(connectOptions);
  } catch (err) {
    throw new Error(
      `Could not connect to Browser Use Cloud. Session ID: ${session.id}`,
      {
        cause: err,
      },
    );
  }

  logger('Connected to Browser Use Cloud');
  return browser;
}

/**
 * Gets the current Browser Use Cloud client instance
 */
export function getBrowserUseClient(): BrowserUseCloud | undefined {
  return browserUseClient;
}

/**
 * Stops the current Browser Use Cloud session
 */
export async function stopBrowserUseSession(): Promise<void> {
  if (browserUseClient) {
    await browserUseClient.stopSession();
  }
}
