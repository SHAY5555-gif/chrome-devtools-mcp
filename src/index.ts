#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from 'node:process';

const [major, minor] = version.substring(1).split('.').map(Number);

if (major === 20 && minor < 19) {
  console.error(
    `ERROR: \`chrome-devtools-mcp\` does not support Node ${process.version}. Please upgrade to Node 20.19.0 LTS or a newer LTS.`,
  );
  process.exit(1);
}

if (major === 22 && minor < 12) {
  console.error(
    `ERROR: \`chrome-devtools-mcp\` does not support Node ${process.version}. Please upgrade to Node 22.12.0 LTS or a newer LTS.`,
  );
  process.exit(1);
}

if (major < 20) {
  console.error(
    `ERROR: \`chrome-devtools-mcp\` does not support Node ${process.version}. Please upgrade to Node 20.19.0 LTS or a newer LTS.`,
  );
  process.exit(1);
}

async function start() {
  try {
    await import('./main.js');
  } catch (error) {
    console.error('Server error:', error);
    process.exit(1);
  }
}

void start();
