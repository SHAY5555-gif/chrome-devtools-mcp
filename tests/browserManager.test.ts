/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {Browser} from 'puppeteer-core';

import {
  connectOrLaunchBrowser,
  isRecoverableBrowserConnectError,
} from '../src/browserManager.js';

describe('browserManager', () => {
  it('reuses an existing connected browser instance', async () => {
    const existingBrowser = {connected: true} as unknown as Browser;

    const result = await connectOrLaunchBrowser({
      headless: false,
      isolated: false,
      chromeArgs: [],
      devtools: false,
      log: () => {},
      currentBrowser: existingBrowser,
      connectExisting: async () => {
        throw new Error('connect should not be called when browser exists');
      },
      launchBrowser: async () => {
        throw new Error('launch should not be called when browser exists');
      },
    });

    assert.strictEqual(result, existingBrowser);
  });

  it('launches a managed browser when remote connection is unavailable', async () => {
    const logs: string[] = [];
    const recoverableError = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:9222'),
      {code: 'ECONNREFUSED'},
    );

    let connectCalls = 0;
    let launchCalls = 0;
    let forwardedOptions: unknown;
    const launchedBrowser = {connected: true} as unknown as Browser;
    const logFile = {} as unknown as import('node:fs').WriteStream;
    const viewport = {width: 1440, height: 900};
    const chromeArgs = ['--proxy-server=http://proxy.local:8080'];

    const result = await connectOrLaunchBrowser({
      browserUrl: 'http://127.0.0.1:9222',
      headless: true,
      executablePath: '/custom/chrome',
      customDevTools: '/tmp/devtools',
      channel: 'beta',
      isolated: false,
      logFile,
      viewport,
      chromeArgs,
      acceptInsecureCerts: true,
      devtools: true,
      log: message => {
        logs.push(message);
      },
      connectExisting: async () => {
        connectCalls += 1;
        throw recoverableError;
      },
      launchBrowser: async options => {
        launchCalls += 1;
        forwardedOptions = options;
        return launchedBrowser;
      },
    });

    assert.strictEqual(result, launchedBrowser);
    assert.strictEqual(connectCalls, 1);
    assert.strictEqual(launchCalls, 1);
    assert.strictEqual(logs.length, 1);
    assert.match(logs[0], /Unable to connect to Chrome/i);
    assert.deepStrictEqual(forwardedOptions, {
      headless: true,
      executablePath: '/custom/chrome',
      customDevTools: '/tmp/devtools',
      channel: 'beta',
      isolated: false,
      logFile,
      viewport,
      args: chromeArgs,
      acceptInsecureCerts: true,
      devtools: true,
    });
  });

  it('rethrows non-recoverable remote connection errors', async () => {
    const nonRecoverableError = new Error('authentication failed');
    let launchCalls = 0;

    await assert.rejects(async () => {
      await connectOrLaunchBrowser({
        browserUrl: 'http://127.0.0.1:9222',
        headless: false,
        isolated: false,
        chromeArgs: [],
        devtools: false,
        log: () => {},
        connectExisting: async () => {
          throw nonRecoverableError;
        },
        launchBrowser: async () => {
          launchCalls += 1;
          return {connected: true} as unknown as Browser;
        },
      });
    }, nonRecoverableError);

    assert.strictEqual(launchCalls, 0);
  });

  it('detects recoverable connection errors', () => {
    const recoverableByCode = Object.assign(new Error('boom'), {
      code: 'ECONNREFUSED',
    });
    assert.strictEqual(
      isRecoverableBrowserConnectError(recoverableByCode),
      true,
    );

    const recoverableByMessage = new Error('Failed to fetch target closed');
    assert.strictEqual(
      isRecoverableBrowserConnectError(recoverableByMessage),
      true,
    );

    const nonRecoverable = new Error('permission denied');
    assert.strictEqual(
      isRecoverableBrowserConnectError(nonRecoverable),
      false,
    );
  });
});
