/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import './polyfill.js';

import assert from 'node:assert';
import crypto, {createHash} from 'node:crypto';
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
import {connectOrLaunchBrowser} from './browserManager.js';
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
import {createBrowserUseSession} from './browseruse.js';

const PORT = Number(process.env['PORT'] ?? 8081);
const TRANSPORT = process.env['TRANSPORT'] ?? 'stdio';

const app = express();
app.disable('x-powered-by');
// CORS: allow all origins and reflect requested headers; also handle preflight
app.use(
  cors({
    origin: '*',
    exposedHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    // Do not restrict allowedHeaders; let cors reflect Access-Control-Request-Headers automatically
  }),
);
app.options('*', cors());
app.use(express.json());

// Expose a well-known JSON Schema for external/self-hosted clients.
// This enables Configure UI when using the Well-Known Endpoint approach.
app.get('/.well-known/mcp-config', (_req: Request, res: Response) => {
  res.json({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://server.smithery.ai/.well-known/mcp-config',
    title: 'MCP Session Configuration',
    description: 'Configuration for connecting to the Chrome DevTools MCP server',
    'x-query-style': 'dot+bracket',
    type: 'object',
    additionalProperties: true,
    properties: {
      headless: {type: 'boolean', default: true},
      isolated: {type: 'boolean', default: true},
      viewport: {type: 'string'},
      browserUrl: {type: 'string', format: 'uri'},
      browserbase: {
        type: 'object',
        additionalProperties: false,
        properties: {
          apiKey: {type: 'string', title: 'API Key'},
          projectId: {type: 'string', title: 'Project ID'},
          contextId: {type: 'string', title: 'Context ID'},
          persist: {type: 'boolean', title: 'Persist Context', default: true},
        },
        required: ['apiKey'],
      },
      browseruse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          apiKey: {type: 'string', title: 'API Key'},
        },
        required: ['apiKey'],
      },
    },
  });
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
    browserbase: z
      .object({
        apiKey: z.string().min(1, 'Browserbase API key is required.'),
        projectId: z.string().optional(),
        contextId: z.string().optional(),
        persist: z.boolean().optional(),
      })
      .optional(),
    browseruse: z
      .object({
        apiKey: z.string().min(1, 'BrowserUse API key is required.'),
        proxyCountryCode: z.string().optional(),
        profileId: z.string().optional(),
        timeout: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

type ServerConfig = z.infer<typeof configSchema>;

interface ChromeDevtoolsServer {
  server: McpServer;
  logDisclaimers: () => void;
  close: () => void;
}

function readPackageJson(): {version?: string} {
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');
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

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }
  const cookies: Record<string, string> = {};
  for (const cookie of cookieHeader.split(';')) {
    const [name, ...rest] = cookie.split('=');
    if (name && rest.length > 0) {
      cookies[name.trim()] = rest.join('=').trim();
    }
  }
  return cookies;
}

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
  const sanitizedConfig: Record<string, unknown> = {
    ...config,
    viewport: normalizeViewport(config.viewport),
  };

  if (sanitizedConfig.browserbase && typeof sanitizedConfig.browserbase === 'object') {
    const browserbase = sanitizedConfig.browserbase as {
      apiKey?: string;
      [key: string]: unknown;
    };
    if (browserbase.apiKey) {
      const hash = createHash('sha256').update(browserbase.apiKey).digest('hex');
      sanitizedConfig.browserbase = {
        ...browserbase,
        apiKey: `sha256:${hash}`,
      };
    }
  }

  const normalizedEntries = Object.entries(sanitizedConfig)
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
  const headless = config.headless ?? false;
  if (headless) {
    argv.push('--headless');
  } else {
    argv.push('--no-headless');
  }
  if (config.executablePath) {
    argv.push('--executablePath', config.executablePath);
  }
  const isolated = config.isolated ?? false;
  if (isolated) {
    argv.push('--isolated');
  } else {
    argv.push('--no-isolated');
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

type BrowserUseConfig = {
  apiKey: string;
  proxyCountryCode?: string;
  profileId?: string;
  timeout?: number;
};

function initializeServer(
  args: CliArgs,
  _unusedBrowserbaseConfig: undefined,
  browseruseConfig?: BrowserUseConfig,
): ChromeDevtoolsServer {
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

  let browseruseStarted = false;
  let browseruseCleanup: (() => Promise<void>) | undefined;

  async function getContext(): Promise<McpContext> {
    const extraArgs: string[] = (args.chromeArg ?? []).map(String);
    if (args.proxyServer) {
      extraArgs.push(`--proxy-server=${args.proxyServer}`);
    }
    const devtools = args.experimentalDevtools ?? false;
    const currentBrowser =
      context?.browser && context.browser.connected ? context.browser : undefined;

    // If browser disconnected and we had a BrowserUse session, reset to create new one
    if (!currentBrowser && browseruseStarted) {
      logger(`Browser disconnected, resetting BrowserUse session state to create new session`);
      console.log(`Browser disconnected, will create new BrowserUse session`);
      browseruseStarted = false;
      args.browserUrl = undefined;
      if (browseruseCleanup) {
        void browseruseCleanup().catch(() => {});
      }
    }

    // Lazily create a BrowserUse session if configured and not yet started
    if (!args.browserUrl && browseruseConfig && !browseruseStarted) {
      try {
        const session = await createBrowserUseSession(browseruseConfig, message => {
          console.log(message);
          logger(message);
        });
        args.browserUrl = session.browserWs;
        browseruseCleanup = session.cleanup;
        browseruseStarted = true;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('Failed to create BrowserUse session:', errorMsg);
        logger(`Failed to create BrowserUse session: ${errorMsg}`);
        throw new Error(`BrowserUse session creation failed: ${errorMsg}`);
      }
    }
    const browser = await connectOrLaunchBrowser({
      browserUrl: args.browserUrl,
      headless: args.headless,
      executablePath: args.executablePath,
      customDevTools: args.customDevtools,
      channel: args.channel as Channel | undefined,
      isolated: args.isolated,
      logFile,
      viewport: args.viewport,
      chromeArgs: extraArgs,
      acceptInsecureCerts: args.acceptInsecureCerts,
      devtools,
      currentBrowser,
      log: logger,
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
      if (browseruseCleanup) {
        void browseruseCleanup().catch(error => {
          console.error(`Failed to clean up BrowserUse session: ${String(error)}`);
        });
      }
    },
  };
}

async function createServer(config: ServerConfig): Promise<ChromeDevtoolsServer> {
  // Prepare optional BrowserUse config from request config or environment variables
  let buConfig: BrowserUseConfig | undefined = config.browseruse
    ? {
        apiKey: config.browseruse.apiKey,
        proxyCountryCode: config.browseruse.proxyCountryCode,
        profileId: config.browseruse.profileId,
        timeout: config.browseruse.timeout,
      }
    : undefined;

  if (!buConfig && process.env['BROWSERUSE_API_KEY']) {
    buConfig = {
      apiKey: String(process.env['BROWSERUSE_API_KEY']),
      proxyCountryCode: process.env['BROWSERUSE_PROXY_COUNTRY_CODE'],
      profileId: process.env['BROWSERUSE_PROFILE_ID'],
      timeout: process.env['BROWSERUSE_TIMEOUT'] ? parseInt(process.env['BROWSERUSE_TIMEOUT'], 10) : undefined,
    };
  }

  // Do not create BrowserUse sessions during initialization; defer to first tool use
  return initializeServer(argsFromConfig(config), undefined, buConfig);
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

    // Determine if this is a tools/call request and specifically a new_page call
    const body = req.body;
    const isToolsCall = body?.method === 'tools/call';
    const toolName = isToolsCall ? body.params?.name : undefined;
    const isNewPageCall = toolName === 'new_page' || toolName === 'new_page_default';

    // Try to get session ID from multiple sources (for maximum compatibility):
    // 1. mcp-session-id header (standard MCP header, sent by most clients)
    // 2. cookie (fallback for browsers/clients that support cookies)
    let sessionId: string | undefined = req.header('mcp-session-id') ?? undefined;

    const cookies = parseCookies(req.header('cookie') ?? undefined);
    let cookieSessionId: string | undefined = cookies['mcp_session'];

    // Prefer header-based session ID (more reliable for MCP clients like Claude)
    if (!sessionId) {
      sessionId = cookieSessionId;
    }

    if (isNewPageCall) {
      // Force a brand-new session for every new_page call
      sessionId = crypto.randomUUID();
      cookieSessionId = sessionId;
      // Keep cookie scoped to this path; avoid Secure for local dev
      res.setHeader('Set-Cookie', `mcp_session=${cookieSessionId}; Path=/mcp; HttpOnly; SameSite=Lax`);
      // Also set as response header for clients that use mcp-session-id
      res.setHeader('Mcp-Session-Id', sessionId);
    }

    cacheKey = sessionId
      ? `${configCacheKey(config)}|session:${sessionId}`
      : configCacheKey(config);
    cacheEntry = httpServerCache.get(cacheKey);

    if (!cacheEntry) {
      let server: ChromeDevtoolsServer;
      try {
        server = await createServer(config);
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

    // Be permissive for scanners: if Accept header misses text/event-stream,
    // synthesize it so Streamable HTTP validation passes. We'll respond as JSON.
    const accepts = req.headers['accept'];
    if (!accepts || !accepts.includes('text/event-stream')) {
      req.headers['accept'] = accepts ? `${accepts}, text/event-stream` : 'application/json, text/event-stream';
    }

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
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

  // Read browseruse config from environment variables
  let buConfig: BrowserUseConfig | undefined;
  if (process.env['BROWSERUSE_API_KEY']) {
    buConfig = {
      apiKey: String(process.env['BROWSERUSE_API_KEY']),
      proxyCountryCode: process.env['BROWSERUSE_PROXY_COUNTRY_CODE'],
      profileId: process.env['BROWSERUSE_PROFILE_ID'],
      timeout: process.env['BROWSERUSE_TIMEOUT'] ? parseInt(process.env['BROWSERUSE_TIMEOUT'], 10) : undefined,
    };
  }

  const server = initializeServer(parseArguments(version), undefined, buConfig);
  const transport = new StdioServerTransport();
  await server.server.connect(transport);
  logger('Chrome DevTools MCP Server connected');
  server.logDisclaimers();
}

main().catch(error => {
  console.error('Server error:', error);
  process.exit(1);
});
