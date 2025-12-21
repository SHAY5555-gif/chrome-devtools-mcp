/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Smithery MCP Server Entry Point
 *
 * This file exports the configuration schema and server factory
 * for deployment on Smithery.ai
 */

import {z} from 'zod';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {ensureBrowserUseCloudConnected} from './browser.js';
import {loadIssueDescriptions} from './issue-descriptions.js';
import {logger} from './logger.js';
import {McpContext} from './McpContext.js';
import {McpResponse} from './McpResponse.js';
import {Mutex} from './Mutex.js';
import {SetLevelRequestSchema, type CallToolResult} from './third_party/index.js';
import {ToolCategory} from './tools/categories.js';
import type {ToolDefinition} from './tools/ToolDefinition.js';
import {tools} from './tools/tools.js';

// Version must match package.json
const VERSION = '0.12.1';

/**
 * Configuration schema for Smithery
 * This schema defines what users can configure when connecting to the MCP server
 */
export const configSchema = z.object({
  browserUseApiKey: z
    .string()
    .min(1)
    .describe('Your Browser Use Cloud API key. Get one at https://browser-use.com'),
  browserUseTimeout: z
    .number()
    .min(1)
    .max(60)
    .default(15)
    .optional()
    .describe('Session timeout in minutes (default: 15, max: 60)'),
  browserUseWidth: z
    .number()
    .min(800)
    .max(3840)
    .default(1280)
    .optional()
    .describe('Browser screen width in pixels (default: 1280)'),
  browserUseHeight: z
    .number()
    .min(600)
    .max(2160)
    .default(720)
    .optional()
    .describe('Browser screen height in pixels (default: 720)'),
  browserUseProxy: z
    .string()
    .optional()
    .describe('Proxy country code (e.g., "US", "DE", "GB")'),
  categoryEmulation: z
    .boolean()
    .default(true)
    .optional()
    .describe('Enable emulation tools (CPU/network throttling)'),
  categoryPerformance: z
    .boolean()
    .default(true)
    .optional()
    .describe('Enable performance tracing tools'),
  categoryNetwork: z
    .boolean()
    .default(true)
    .optional()
    .describe('Enable network inspection tools'),
});

export type SmitheryConfig = z.infer<typeof configSchema>;

/**
 * Creates the MCP server for Smithery
 */
export default async function createServer({
  config,
}: {
  config: SmitheryConfig;
}) {
  const server = new McpServer(
    {
      name: 'chrome_devtools',
      title: 'Chrome DevTools MCP Server (Browser Use Cloud)',
      version: VERSION,
    },
    {capabilities: {logging: {}}},
  );

  server.server.setRequestHandler(SetLevelRequestSchema, () => {
    return {};
  });

  const toolMutex = new Mutex();
  let context: McpContext | null = null;

  async function getContext(): Promise<McpContext> {
    const browser = await ensureBrowserUseCloudConnected({
      apiKey: config.browserUseApiKey,
      devtools: false,
      sessionOptions: {
        timeout: config.browserUseTimeout ?? 15,
        browserScreenWidth: config.browserUseWidth ?? 1280,
        browserScreenHeight: config.browserUseHeight ?? 720,
        proxyCountryCode: config.browserUseProxy,
      },
    });

    if (context?.browser !== browser) {
      context = await McpContext.from(browser, logger, {
        experimentalDevToolsDebugging: false,
        experimentalIncludeAllPages: false,
      });
    }
    return context;
  }

  function registerTool(tool: ToolDefinition): void {
    if (
      tool.annotations.category === ToolCategory.EMULATION &&
      config.categoryEmulation === false
    ) {
      return;
    }
    if (
      tool.annotations.category === ToolCategory.PERFORMANCE &&
      config.categoryPerformance === false
    ) {
      return;
    }
    if (
      tool.annotations.category === ToolCategory.NETWORK &&
      config.categoryNetwork === false
    ) {
      return;
    }

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
          const ctx = await getContext();
          logger(`${tool.name} context: resolved`);
          await ctx.detectOpenDevToolsWindows();
          const response = new McpResponse();
          await tool.handler({params}, response, ctx);
          const content = await response.handle(tool.name, ctx);
          return {content};
        } catch (err) {
          logger(`${tool.name} error:`, err, (err as Error)?.stack);
          let errorText =
            err && 'message' in (err as Error)
              ? (err as Error).message
              : String(err);
          if ('cause' in (err as Error) && (err as Error).cause) {
            errorText += `\nCause: ${((err as Error).cause as Error).message}`;
          }
          return {
            content: [{type: 'text', text: errorText}],
            isError: true,
          };
        } finally {
          guard.dispose();
        }
      },
    );
  }

  for (const tool of tools) {
    registerTool(tool);
  }

  await loadIssueDescriptions();

  return server.server;
}
