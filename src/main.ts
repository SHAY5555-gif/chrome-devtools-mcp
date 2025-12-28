/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import './polyfill.js';

import assert from 'node:assert';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {SetLevelRequestSchema} from '@modelcontextprotocol/sdk/types.js';

// Helper to check if a message is an initialize request
function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    'method' in body &&
    body.method === 'initialize'
  );
}

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

export const args = parseArguments(version);

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

let context: McpContext;
async function getContext(): Promise<McpContext> {
  const extraArgs: string[] = [];
  if (args.proxyServer) {
    extraArgs.push(`--proxy-server=${args.proxyServer}`);
  }
  const browser = args.browserUrl
    ? await ensureBrowserConnected(args.browserUrl)
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
      });

  if (context?.browser !== browser) {
    context = await McpContext.from(browser, logger);
  }
  return context;
}

const logDisclaimers = () => {
  console.error(
    `chrome-devtools-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.`,
  );
};

const toolMutex = new Mutex();

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
        const context = await getContext();
        const response = new McpResponse();
        await tool.handler(
          {
            params,
          },
          response,
          context,
        );
        try {
          const content = await response.handle(tool.name, context);
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

// HTTP mode - run MCP server over HTTP for remote AI connections
if (args.httpPort) {
  const port = args.httpPort;
  const host = args.httpHost || '0.0.0.0';

  // Store active transports
  const streamableTransports: Record<string, StreamableHTTPServerTransport> =
    {};
  const sseTransports: Record<string, SSEServerTransport> = {};

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      // CORS headers for all requests
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, DELETE, OPTIONS',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, mcp-session-id',
      );
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health check endpoint
      if (url.pathname === '/health') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({status: 'ok', version}));
        return;
      }

      // Modern Streamable HTTP endpoint
      if (url.pathname === '/mcp') {
        try {
          // Parse JSON body for POST requests
          let body: unknown = {};
          if (req.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(chunk);
            }
            const rawBody = Buffer.concat(chunks).toString();
            if (rawBody) {
              body = JSON.parse(rawBody);
            }
          }

          const sessionId = req.headers['mcp-session-id'] as string | undefined;
          let transport = sessionId
            ? streamableTransports[sessionId]
            : undefined;

          if (!transport) {
            if (!isInitializeRequest(body)) {
              res.writeHead(400, {'Content-Type': 'application/json'});
              res.end(
                JSON.stringify({
                  error:
                    'Missing or unknown mcp-session-id. Send an initialize request to start a session.',
                }),
              );
              return;
            }

            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (newSessionId: string) => {
                streamableTransports[newSessionId] = transport!;
                logger(`New MCP session created: ${newSessionId}`);
              },
            });

            transport.onclose = () => {
              if (transport?.sessionId) {
                delete streamableTransports[transport.sessionId];
                logger(`MCP session closed: ${transport.sessionId}`);
              }
            };

            await server.connect(transport);
          }

          await transport.handleRequest(req, res, body);
        } catch (err) {
          logger('HTTP /mcp error:', err);
          res.writeHead(500, {'Content-Type': 'application/json'});
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }

      // Legacy SSE endpoint
      if (url.pathname === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        sseTransports[transport.sessionId] = transport;
        logger(`New SSE session: ${transport.sessionId}`);

        res.on('close', () => {
          delete sseTransports[transport.sessionId];
          logger(`SSE session closed: ${transport.sessionId}`);
        });

        await server.connect(transport);
        return;
      }

      // Legacy SSE messages endpoint
      if (url.pathname === '/messages' && req.method === 'POST') {
        const sessionId = url.searchParams.get('sessionId') || '';
        const transport = sseTransports[sessionId];

        if (!transport) {
          res.writeHead(400, {'Content-Type': 'text/plain'});
          res.end('No transport found for sessionId');
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());

        await transport.handlePostMessage(req, res, body);
        return;
      }

      // 404 for unknown paths
      res.writeHead(404, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          error: 'Not found',
          endpoints: {
            '/mcp': 'Streamable HTTP MCP endpoint (POST)',
            '/sse': 'Legacy SSE endpoint (GET)',
            '/messages': 'Legacy SSE messages (POST)',
            '/health': 'Health check (GET)',
          },
        }),
      );
    },
  );

  httpServer.listen(port, host, () => {
    logger(
      `Chrome DevTools MCP Server v${version} listening on http://${host}:${port}`,
    );
    console.error(`MCP HTTP Server running on http://${host}:${port}`);
    console.error('Endpoints:');
    console.error(`  - POST http://${host}:${port}/mcp (Streamable HTTP)`);
    console.error(`  - GET  http://${host}:${port}/sse (Legacy SSE)`);
    console.error(`  - GET  http://${host}:${port}/health (Health check)`);
    logDisclaimers();
  });
} else {
  // Default stdio mode
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger('Chrome DevTools MCP Server connected');
  logDisclaimers();
}
