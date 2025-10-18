/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {WriteStream} from 'node:fs';

import type {Browser} from 'puppeteer-core';

import type {Channel} from './browser.js';
import {ensureBrowserConnected, ensureBrowserLaunched} from './browser.js';

export interface ConnectOrLaunchOptions {
  browserUrl?: string;
  headless: boolean;
  executablePath?: string;
  customDevTools?: string;
  channel?: Channel;
  isolated: boolean;
  logFile?: WriteStream;
  viewport?: {
    width: number;
    height: number;
  };
  chromeArgs: string[];
  acceptInsecureCerts?: boolean;
  devtools: boolean;
  currentBrowser?: Browser;
  log: (message: string) => void;
  connectExisting?: typeof ensureBrowserConnected;
  launchBrowser?: typeof ensureBrowserLaunched;
}

export function isRecoverableBrowserConnectError(error: unknown): boolean {
  const recoverableCodes = new Set([
    'ECONNREFUSED',
    'ERR_CONNECTION_REFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
  ]);
  const seen = new Set<unknown>();

  const hasRecoverableCode = (value: unknown): boolean => {
    if (!value || seen.has(value)) {
      return false;
    }
    seen.add(value);

    if (typeof value === 'object') {
      const code = (value as {code?: unknown}).code;
      if (typeof code === 'string' && recoverableCodes.has(code)) {
        return true;
      }
      const cause = (value as {cause?: unknown}).cause;
      if (cause && hasRecoverableCode(cause)) {
        return true;
      }
    }

    if (value instanceof Error) {
      const message = value.message.toLowerCase();
      return (
        message.includes('connection refused') ||
        message.includes('failed to fetch') ||
        message.includes('target closed') ||
        message.includes('connection closed') ||
        message.includes('timed out') ||
        message.includes('404')
      );
    }

    if (typeof value === 'string') {
      const lowered = value.toLowerCase();
      return (
        lowered.includes('connection refused') ||
        lowered.includes('failed to fetch') ||
        lowered.includes('target closed') ||
        lowered.includes('connection closed') ||
        lowered.includes('timed out') ||
        lowered.includes('404')
      );
    }

    return false;
  };

  return hasRecoverableCode(error);
}

export async function connectOrLaunchBrowser(
  options: ConnectOrLaunchOptions,
): Promise<Browser> {
  let browser =
    options.currentBrowser && options.currentBrowser.connected
      ? options.currentBrowser
      : undefined;

  const connectExisting = options.connectExisting ?? ensureBrowserConnected;
  const launchBrowser = options.launchBrowser ?? ensureBrowserLaunched;

  if (options.browserUrl && !browser) {
    try {
      browser = await connectExisting({
        browserURL: options.browserUrl,
        devtools: options.devtools,
      });
    } catch (error) {
      if (isRecoverableBrowserConnectError(error)) {
        const message =
          error instanceof Error ? error.message : String(error);
        options.log(
          `Unable to connect to Chrome at ${options.browserUrl}: ${message}. Launching a managed browser instead.`,
        );
      } else {
        throw error;
      }
    }
  }

  if (!browser) {
    const channel = options.channel ?? 'stable';
    browser = await launchBrowser({
      headless: options.headless,
      executablePath: options.executablePath,
      customDevTools: options.customDevTools,
      channel,
      isolated: options.isolated,
      logFile: options.logFile,
      viewport: options.viewport,
      args: options.chromeArgs,
      acceptInsecureCerts: options.acceptInsecureCerts,
      devtools: options.devtools,
    });
  }

  return browser;
}
