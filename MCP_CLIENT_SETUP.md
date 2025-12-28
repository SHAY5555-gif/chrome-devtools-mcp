# Chrome DevTools MCP Server - Client Connection Guide

## 🚀 Server Deployment

**Production Server URL:** `https://chrome-devtools-mcp-ai-sdk-production.up.railway.app`

This MCP server is deployed on Railway and provides Chrome DevTools functionality through the Model Context Protocol.

---

## 📡 Available Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | **Streamable HTTP MCP endpoint** (recommended for Vercel AI SDK) |
| `/sse` | GET | Legacy SSE endpoint |
| `/messages` | POST | Legacy SSE messages endpoint |
| `/health` | GET | Health check endpoint |

---

## 🔌 Integration with Vercel AI SDK

### Installation

```bash
npm install ai @ai-sdk/mcp @ai-sdk/openai
```

### Basic Setup

```typescript
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { streamText, generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

// Create MCP client
const mcpClient = await createMCPClient({
  transport: {
    type: 'http',
    url: 'https://chrome-devtools-mcp-ai-sdk-production.up.railway.app/mcp',
  },
});

// Get all available tools
const tools = await mcpClient.tools();

// Use with AI SDK
const result = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'Navigate to https://example.com and take a screenshot',
});

// Don't forget to close the client when done
await mcpClient.close();
```

### With Explicit Schema Definition (Better DX)

```typescript
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { z } from 'zod';

const mcpClient = await createMCPClient({
  transport: {
    type: 'http',
    url: 'https://chrome-devtools-mcp-ai-sdk-production.up.railway.app/mcp',
  },
});

// Define specific tools with TypeScript type safety
const tools = await mcpClient.tools({
  schemas: {
    'navigate_page': {
      inputSchema: z.object({
        url: z.string(),
        timeout: z.number().optional(),
      }),
    },
    'take_screenshot': {
      inputSchema: z.object({
        filePath: z.string().optional(),
        format: z.enum(['png', 'jpeg', 'webp']).optional(),
        fullPage: z.boolean().optional(),
      }),
    },
  },
});
```

### Streaming Example (Next.js API Route)

```typescript
// app/api/chat/route.ts
import { createMCPClient } from '@ai-sdk/mcp';
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

export async function POST(req: Request) {
  const { prompt } = await req.json();

  const mcpClient = await createMCPClient({
    transport: {
      type: 'http',
      url: 'https://chrome-devtools-mcp-ai-sdk-production.up.railway.app/mcp',
    },
  });

  const tools = await mcpClient.tools();

  const response = await streamText({
    model: openai('gpt-4o'),
    tools,
    prompt,
    onFinish: async () => {
      await mcpClient.close();
    },
  });

  return response.toDataStreamResponse();
}
```

---

## 🔧 Direct HTTP API Usage

### Initialize Session

```bash
curl -X POST https://chrome-devtools-mcp-ai-sdk-production.up.railway.app/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {
        "name": "my-client",
        "version": "1.0.0"
      }
    },
    "id": 1
  }'
```

Response includes `mcp-session-id` header - use this for subsequent requests.

### Call a Tool (with session ID)

```bash
curl -X POST https://chrome-devtools-mcp-ai-sdk-production.up.railway.app/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: YOUR_SESSION_ID_HERE" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "navigate_page",
      "arguments": {
        "url": "https://example.com"
      }
    },
    "id": 2
  }'
```

---

## 🛠️ Available Chrome DevTools Tools

The MCP server exposes all Chrome DevTools MCP tools:

### Page Management
- `list_pages` - List all open browser pages
- `new_page` - Create a new browser page
- `select_page` - Select a page for subsequent operations
- `close_page` - Close a specific page
- `navigate_page` - Navigate to a URL

### Inspection & Debugging
- `take_snapshot` - Take a text snapshot of the page
- `take_screenshot` - Take a screenshot (PNG/JPEG/WebP)
- `evaluate_script` - Execute JavaScript in page context
- `list_console_messages` - Get console logs

### Network & Performance
- `list_network_requests` - List network requests
- `get_network_request` - Get details of specific request
- `performance_start_trace` - Start performance profiling
- `performance_stop_trace` - Stop profiling and get results

### Input & Emulation
- `click` - Click on elements
- `fill` - Fill input fields
- `fill_form` - Fill multiple form fields
- `hover` - Hover over elements
- `drag` - Drag and drop
- `emulate_network` - Throttle network
- `emulate_cpu` - Throttle CPU

---

## 🌐 Claude Desktop Integration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "transport": {
        "type": "http",
        "url": "https://chrome-devtools-mcp-ai-sdk-production.up.railway.app/mcp"
      }
    }
  }
}
```

---

## 📝 Environment Variables (Railway Deployment)

The server is configured with:

| Variable | Value | Description |
|----------|-------|-------------|
| `PORT` | Auto-set by Railway | HTTP port |
| `BROWSER_USE_API_KEY` | **REQUIRED** | Browser Use Cloud API key (get from https://browseruse.com) |

### Setting Environment Variables in Railway

1. Go to your Railway project dashboard
2. Navigate to **Variables** tab
3. Click **New Variable**
4. Add `BROWSER_USE_API_KEY` with your API key from Browser Use Cloud
5. The server will automatically use Browser Use Cloud instead of local Chrome

### CLI Arguments

The server runs with these command-line arguments:
- `--httpPort $PORT` - HTTP port (set by Railway)
- `--httpHost 0.0.0.0` - Bind to all interfaces
- `--browserUseCloud` - Use Browser Use Cloud instead of local Chrome

---

## 🔍 Testing the Server

### Health Check
```bash
curl https://chrome-devtools-mcp-ai-sdk-production.up.railway.app/health
```

Expected response:
```json
{
  "status": "ok",
  "version": "0.6.1"
}
```

### Get Available Endpoints
```bash
curl https://chrome-devtools-mcp-ai-sdk-production.up.railway.app/unknown
```

Returns list of all available endpoints.

---

## 📚 Resources

- [Vercel AI SDK MCP Documentation](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)
- [Model Context Protocol Specification](https://modelcontextprotocol.io)
- [Chrome DevTools MCP GitHub](https://github.com/ChromeDevTools/chrome-devtools-mcp)

---

## 🚨 Important Notes

### Security Considerations
- This server exposes Chrome DevTools capabilities to MCP clients
- Only use with trusted AI applications
- Avoid sharing sensitive or personal information
- The server runs in headless mode on Railway

### Session Management
- Sessions are stateful and managed via `mcp-session-id` header
- Each client connection gets a unique session ID
- Sessions persist across requests until explicitly closed

### CORS
- CORS is enabled for all origins (`*`)
- Suitable for development and AI integrations
- Consider restricting in production if needed

---

## 💡 Example Use Cases

### Web Scraping
```typescript
const result = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'Go to https://news.ycombinator.com and get the top 5 story titles',
});
```

### Automated Testing
```typescript
const result = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'Test the login flow on https://example.com with username "test" and password "demo123"',
});
```

### Performance Analysis
```typescript
const result = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'Analyze the performance of https://example.com and report Core Web Vitals',
});
```

---

**Deployed:** December 28, 2025
**Branch:** AI-SDK
**Platform:** Railway
**Generated with:** [Claude Code](https://claude.com/claude-code)
