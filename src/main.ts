/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import './polyfill.js';

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import cors from 'cors';
import express, {type Request, type Response} from 'express';
import {parseAndValidateConfig} from '@smithery/sdk';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {SetLevelRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';

import type {Channel} from './browser.js';
import {ensureBrowserConnected, ensureBrowserLaunched} from './browser.js';
import {parseArguments} from './cli.js';
import {logger, saveLogsToFile} from './logger.js';
import {McpContext} from './McpContext.js';
import {McpResponse} from './McpResponse.js';
import {Mutex} from './Mutex.js';
import * as consoleTools from './tools/console.js';
import * as emulationTools from './tools/emulation.js';
import * as inputTools from './tools/input.js';
import * as networkTools from './tools/network.js';
import * as pagesTools from './tools/pages.js';
import * as performanceTools from './tools/performance.js';
import * as screenshotTools from './tools/screenshot.js';
import * as scriptTools from './tools/script.js';
import * as snapshotTools from './tools/snapshot.js';
import type {ToolDefinition} from './tools/ToolDefinition.js';

const PORT = Number(process.env['PORT'] ?? 8081);
const TRANSPORT = process.env['TRANSPORT'] ?? 'stdio';

const app = express();
app.use(
  cors({
    origin: '*',
    exposedHeaders: ['Mcp-Session-Id', 'mcp-protocol-version'],
    allowedHeaders: ['Content-Type', 'mcp-session-id'],
  }),
);
app.use(express.json());

// Expose JSON Schema for session configuration (for external/container hosting)
// This enables Smithery and hosting platforms to discover configurable fields
// without authentication to validate that CONFIGURE UI is available.
app.get('/.well-known/mcp-config', (_req: Request, res: Response) => {
  const schema = {
    type: 'object',
    // Keep in sync with smithery.yaml; allow extra provider-specific keys
    additionalProperties: true,
    properties: {
      apiKey: {
        type: 'string',
        description: 'Your API key',
      },
      browserUrl: {
        type: 'string',
        format: 'uri',
        description: 'Existing Chrome WebSocket debugging URL to connect to.',
      },
      headless: {
        type: 'boolean',
        description: 'Run Chrome in headless mode.',
        default: true,
      },
      executablePath: {
        type: 'string',
        description: 'Absolute path to a Chrome executable inside the container.',
      },
      isolated: {
        type: 'boolean',
        description: 'Launch Chrome with an isolated user data dir.',
        default: true,
      },
      customDevtools: {
        type: 'string',
        description: 'Path to a custom DevTools frontend bundle.',
      },
      channel: {
        type: 'string',
        enum: ['stable', 'beta', 'canary', 'dev'],
        description: 'Chrome channel to use when launching the bundled browser.',
      },
      logFile: {
        type: 'string',
        description:
          'Optional path inside the container where debug logs should be written.',
      },
      viewport: {
        type: 'string',
        description:
          'Viewport size for launched Chrome instances, for example 1280x720.',
      },
      proxyServer: {
        type: 'string',
        description:
          'Proxy server definition to forward Chrome network traffic through.',
      },
      acceptInsecureCerts: {
        type: 'boolean',
        description: 'Ignore TLS certificate errors when launching Chrome.',
      },
      experimentalDevtools: {
        type: 'boolean',
        description: 'Enable DevTools automation targets (experimental).',
      },
      chromeArg: {
        type: 'array',
        description: 'Additional command-line switches to pass to Chrome.',
        items: {type: 'string'},
      },
      browserbase: {
        type: 'object',
        description: 'Launch a remote Chrome via Browserbase (scanner-friendly).',
        additionalProperties: false,
        properties: {
          apiKey: {
            type: 'string',
            description: 'Browserbase API key used to create sessions.',
          },
          projectId: {
            type: 'string',
            description: 'Browserbase project ID to associate sessions with.',
          },
          contextId: {
            type: 'string',
            description: 'Optional persistent context ID.',
          },
          persist: {
            type: 'boolean',
            description: 'Whether to persist the Browserbase context.',
            default: true,
          },
        },
      },
    },
  } as const;

  res.json(schema);
});

interface HttpServerCacheEntry {
  server: ChromeDevtoolsServer;
  logDisclaimersShown: boolean;
  mutex: Mutex;
}

const httpServerCache = new Map<string, HttpServerCacheEntry>();

type CliArgs = ReturnType<typeof parseArguments>;

const viewportSchema = z
  .union([
    z
      .string()
      .regex(/^\d+x\d+$/u, 'Expected format WIDTHxHEIGHT, for example 1280x720'),
    z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  ])
  .optional();

export const configSchema = z
  .object({
    browserUrl: z.string().url().optional(),
    headless: z.boolean().optional(),
    executablePath: z.string().optional(),
    isolated: z.boolean().optional(),
    customDevtools: z.string().optional(),
    channel: z.enum(['stable', 'canary', 'beta', 'dev']).optional(),
    logFile: z.string().optional(),
    viewport: viewportSchema,
    proxyServer: z.string().optional(),
    acceptInsecureCerts: z.boolean().optional(),
    experimentalDevtools: z.boolean().optional(),
    chromeArg: z.array(z.string()).optional(),
  })
  .passthrough();

type ServerConfig = z.infer<typeof configSchema>;

interface ChromeDevtoolsServer {
  server: McpServer;
  logDisclaimers: () => void;
  close: () => void;
}

function readPackageJson(): {version?: string} {
  const currentDir = import.meta.dirname;
  const packageJsonPath = path.join(currentDir, '..', '..', 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return {};
  }
  try {
    const json = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    assert.strict(json['name'], 'chrome-devtools-mcp');
    return json;
  } catch {
    return {};
  }
}

const version = readPackageJson().version ?? 'unknown';

function normalizeViewport(viewport?: ServerConfig['viewport']): string | undefined {
  if (!viewport) {
    return undefined;
  }
  if (typeof viewport === 'string') {
    return viewport;
  }
  return `${viewport.width}x${viewport.height}`;
}

function configCacheKey(config: ServerConfig): string {
  const normalizedEntries = Object.entries({
    ...config,
    viewport: normalizeViewport(config.viewport),
  })
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  return JSON.stringify(normalizedEntries);
}

function shutdownHttpServers() {
  for (const entry of httpServerCache.values()) {
    entry.server.close();
  }
  httpServerCache.clear();
}

process.on('exit', shutdownHttpServers);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdownHttpServers();
  });
}

function argsFromConfig(config: ServerConfig): CliArgs {
  const argv = ['node', 'server'];

  if (config.browserUrl) {
    argv.push('--browserUrl', config.browserUrl);
  }
  const headless = config.headless ?? true;
  if (headless) {
    argv.push('--headless');
  } else {
    argv.push('--no-headless');
  }
  if (config.executablePath) {
    argv.push('--executablePath', config.executablePath);
  }
  const isolated = config.isolated ?? true;
  if (isolated) {
    argv.push('--isolated');
  }
  if (config.customDevtools) {
    argv.push('--customDevtools', config.customDevtools);
  }
  if (config.experimentalDevtools) {
    argv.push('--experimentalDevtools');
  }
  if (config.chromeArg) {
    for (const value of config.chromeArg) {
      argv.push('--chrome-arg', value);
    }
  }
  if (config.channel) {
    argv.push('--channel', config.channel);
  }
  if (config.logFile) {
    argv.push('--logFile', config.logFile);
  }
  const viewport = normalizeViewport(config.viewport);
  if (viewport) {
    argv.push('--viewport', viewport);
  }
  if (config.proxyServer) {
    argv.push('--proxyServer', config.proxyServer);
  }
  if (config.acceptInsecureCerts === true) {
    argv.push('--acceptInsecureCerts');
  } else if (config.acceptInsecureCerts === false) {
    argv.push('--no-acceptInsecureCerts');
  }

  return parseArguments(version, argv);
}

function initializeServer(args: CliArgs): ChromeDevtoolsServer {
  const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;

  logger(`Starting Chrome DevTools MCP Server v${version}`);
  const server = new McpServer(
    {
      name: 'chrome_devtools',
      title: 'Chrome DevTools MCP server',
      version,
    },
    {capabilities: {logging: {}}},
  );
  server.server.setRequestHandler(SetLevelRequestSchema, () => {
    return {};
  });

  let context: McpContext | undefined;
  const toolMutex = new Mutex();

  async function getContext(): Promise<McpContext> {
    const extraArgs: string[] = (args.chromeArg ?? []).map(String);
    if (args.proxyServer) {
      extraArgs.push(`--proxy-server=${args.proxyServer}`);
    }
    const devtools = args.experimentalDevtools ?? false;
    const browser = args.browserUrl
      ? await ensureBrowserConnected({
          browserURL: args.browserUrl,
          devtools,
        })
      : await ensureBrowserLaunched({
          headless: args.headless,
          executablePath: args.executablePath,
          customDevTools: args.customDevtools,
          channel: args.channel as Channel,
          isolated: args.isolated,
          logFile,
          viewport: args.viewport,
          args: extraArgs,
          acceptInsecureCerts: args.acceptInsecureCerts,
          devtools,
        });

    if (!context || context.browser !== browser) {
      context = await McpContext.from(browser, logger);
    }
    return context;
  }

  const logDisclaimers = () => {
    console.error(
      `chrome-devtools-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,\ndebug, and modify any data in the browser or DevTools.\nAvoid sharing sensitive or personal information that you do not want to share with MCP clients.`,
    );
  };

  function registerTool(tool: ToolDefinition): void {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
        annotations: tool.annotations,
      },
      async (params): Promise<CallToolResult> => {
        const guard = await toolMutex.acquire();
        try {
          logger(`${tool.name} request: ${JSON.stringify(params, null, '  ')}`);
          const toolContext = await getContext();
          const response = new McpResponse();
          await tool.handler(
            {
              params,
            },
            response,
            toolContext,
          );
          try {
            const content = await response.handle(tool.name, toolContext);
            return {
              content,
            };
          } catch (error) {
            const errorText =
              error instanceof Error ? error.message : String(error);

            return {
              content: [
                {
                  type: 'text',
                  text: errorText,
                },
              ],
              isError: true,
            };
          }
        } finally {
          guard.dispose();
        }
      },
    );
  }

  const tools = [
    ...Object.values(consoleTools),
    ...Object.values(emulationTools),
    ...Object.values(inputTools),
    ...Object.values(networkTools),
    ...Object.values(pagesTools),
    ...Object.values(performanceTools),
    ...Object.values(screenshotTools),
    ...Object.values(scriptTools),
    ...Object.values(snapshotTools),
  ];
  for (const tool of tools) {
    registerTool(tool as unknown as ToolDefinition);
  }

  return {
    server,
    logDisclaimers,
    close: () => {
      void context?.browser.close().catch(error => {
        logger(`Failed to close browser: ${String(error)}`);
      });
      server.server.close();
      logFile?.end();
    },
  };
}

function createServer(config: ServerConfig): ChromeDevtoolsServer {
  const args = argsFromConfig(config);
  return initializeServer(args);
}

app.all('/mcp', async (req: Request, res: Response) => {
  let transport: StreamableHTTPServerTransport | undefined;
  let cacheEntry: HttpServerCacheEntry | undefined;
  let cacheKey: string | undefined;
  let guard: {dispose: () => void} | undefined;
  let isNewEntry = false;

  const releaseGuard = () => {
    if (guard) {
      guard.dispose();
      guard = undefined;
    }
  };

  res.on('close', releaseGuard);

  try {
    const result = parseAndValidateConfig(req, configSchema);
    if (!result.ok) {
      res.status(result.error.status).json(result.error);
      return;
    }

    const config = result.value;
    cacheKey = configCacheKey(config);
    cacheEntry = httpServerCache.get(cacheKey);

    if (!cacheEntry) {
      let server: ChromeDevtoolsServer;
      try {
        server = createServer(config);
      } catch (error) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32602,
            message:
              error instanceof Error ? error.message : 'Invalid configuration provided.',
          },
          id: null,
        });
        return;
      }

      cacheEntry = {
        server,
        logDisclaimersShown: false,
        mutex: new Mutex(),
      };
      httpServerCache.set(cacheKey, cacheEntry);
      isNewEntry = true;
    }

    guard = await cacheEntry.mutex.acquire();

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await cacheEntry.server.server.connect(transport);
    logger('Chrome DevTools MCP Server connected');
    if (!cacheEntry.logDisclaimersShown) {
      cacheEntry.server.logDisclaimers();
      cacheEntry.logDisclaimersShown = true;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }

    if (cacheKey && cacheEntry && isNewEntry && !transport) {
      cacheEntry.server.close();
      httpServerCache.delete(cacheKey);
    }
  } finally {
    releaseGuard();
  }
});

async function main() {
  if (TRANSPORT === 'http') {
    app.listen(PORT, () => {
      console.log(`MCP HTTP Server listening on port ${PORT}`);
    });
    return;
  }

  const server = initializeServer(parseArguments(version));
  const transport = new StdioServerTransport();
  await server.server.connect(transport);
  logger('Chrome DevTools MCP Server connected');
  server.logDisclaimers();
}

main().catch(error => {
  console.error('Server error:', error);
  process.exit(1);
});
