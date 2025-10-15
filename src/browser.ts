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
  LaunchOptions,
  Page,
  Target,
} from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

let browser: Browser | undefined;

function makeTargetFilter(devtools: boolean) {
  const ignoredPrefixes = new Set([
    'chrome://',
    'chrome-extension://',
    'chrome-untrusted://',
  ]);

  if (!devtools) {
    ignoredPrefixes.add('devtools://');
  }

  return function targetFilter(target: Target): boolean {
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

async function attachToExistingBrowserInstance(options: {
  userDataDir: string;
  devtools: boolean;
}): Promise<Browser | undefined> {
  try {
    const activePortPath = path.join(options.userDataDir, 'DevToolsActivePort');
    const content = await fs.promises.readFile(activePortPath, 'utf-8');
    const [portLine, wsPath] = content.trim().split('\n');
    if (!portLine || !wsPath) {
      return undefined;
    }
    const port = Number.parseInt(portLine, 10);
    if (!Number.isFinite(port)) {
      return undefined;
    }
    const browserWSEndpoint = `ws://127.0.0.1:${port}${wsPath}`;
    return await puppeteer.connect({
      browserWSEndpoint,
      targetFilter: makeTargetFilter(options.devtools),
      defaultViewport: null,
      // @ts-expect-error Older puppeteer-core typings do not expose this option yet.
      handleDevToolsAsPage: options.devtools,
    });
  } catch {
    return undefined;
  }
}

const STEALTH_SYMBOL = Symbol('chrome-devtools-mcp:stealth');

function stealthScript() {
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
  });

  // Ensure window.chrome is defined to mimic regular Chrome.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  window.chrome ??= {runtime: {}} as typeof window.chrome;

  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });

  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });

  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = parameters => {
    if (parameters.name === 'notifications') {
      return Promise.resolve({
        state: Notification.permission,
        onchange: null,
      } as PermissionStatus);
    }
    return originalQuery(parameters);
  };
}

async function applyStealthToPage(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(stealthScript);
  try {
    await page.evaluate(stealthScript);
  } catch {
    // Ignore pages (like chrome://) where script evaluation is disallowed.
  }
}

async function enableStealthMode(browserInstance: Browser): Promise<void> {
  const browserWithFlag = browserInstance as Browser & {
    [STEALTH_SYMBOL]?: boolean;
  };
  if (browserWithFlag[STEALTH_SYMBOL]) {
    return;
  }
  browserWithFlag[STEALTH_SYMBOL] = true;

  const applyToTarget = async (target: Target) => {
    try {
      const page = await target.page();
      if (page) {
        await applyStealthToPage(page);
      }
    } catch {
      // Ignore targets that cannot produce a page.
    }
  };

  const pages = await browserInstance.pages();
  await Promise.all(pages.map(page => applyStealthToPage(page)));

  browserInstance.on('targetcreated', target => {
    void applyToTarget(target);
  });
}

export async function ensureBrowserConnected(options: {
  browserURL: string;
  devtools: boolean;
}) {
  if (browser?.connected) {
    return browser;
  }

  browser = await puppeteer.connect({
    targetFilter: makeTargetFilter(options.devtools),
    browserURL: options.browserURL,
    defaultViewport: null,
    // @ts-expect-error Older puppeteer-core typings do not expose this option yet.
    handleDevToolsAsPage: options.devtools,
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
  devtools: boolean;
}

export async function launch(options: McpLaunchOptions): Promise<Browser> {
  const {channel, customDevTools, devtools, headless, isolated} = options;
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

  if (userDataDir) {
    const existingBrowser = await attachToExistingBrowserInstance({
      userDataDir,
      devtools,
    });
    if (existingBrowser) {
      await enableStealthMode(existingBrowser);
      return existingBrowser;
    }
  }

  const args: LaunchOptions['args'] = [
    ...(options.args ?? []),
    '--hide-crash-restore-bubble',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
  ];
  if (devtools) {
    args.push('--auto-open-devtools-for-tabs');
  }
  if (customDevTools) {
    args.push(`--custom-devtools-frontend=file://${customDevTools}`);
  }
  if (headless) {
    args.push('--screen-info={3840x2160}');
  }
  let puppeteerChannel: ChromeReleaseChannel | undefined;
  let executablePath =
    options.executablePath ?? process.env['PUPPETEER_EXECUTABLE_PATH'];
  if (!executablePath) {
    try {
      const puppeteerFull = await import('puppeteer');
      executablePath = puppeteerFull.executablePath();
    } catch {
      executablePath = undefined;
    }
  }
  if (!executablePath) {
    puppeteerChannel =
      channel && channel !== 'stable'
        ? (`chrome-${channel}` as ChromeReleaseChannel)
        : 'chrome';
  }

  try {
    const launchedBrowser = await puppeteer.launch({
      channel: puppeteerChannel,
      targetFilter: makeTargetFilter(devtools),
      executablePath,
      defaultViewport: null,
      userDataDir,
      pipe: false,
      headless,
      args,
      acceptInsecureCerts: options.acceptInsecureCerts,
      ignoreDefaultArgs: ['--enable-automation'],
      // @ts-expect-error Older puppeteer-core typings do not expose this option yet.
      handleDevToolsAsPage: devtools,
    });
    if (options.logFile) {
      // FIXME: we are probably subscribing too late to catch startup logs. We
      // should expose the process earlier or expose the getRecentLogs() getter.
      launchedBrowser.process()?.stderr?.pipe(options.logFile);
      launchedBrowser.process()?.stdout?.pipe(options.logFile);
    }
    if (options.viewport) {
      const [page] = await launchedBrowser.pages();
      // @ts-expect-error internal API for now.
      await page?.resize({
        contentWidth: options.viewport.width,
        contentHeight: options.viewport.height,
      });
    }

    await enableStealthMode(launchedBrowser);
    return launchedBrowser;
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
