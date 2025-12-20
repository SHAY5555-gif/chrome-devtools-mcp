# Chrome DevTools MCP + Browser Use Cloud Integration

This branch (`browser-use`) adds support for [Browser Use Cloud](https://browser-use.com) - a cloud-hosted browser service that allows AI models to control browsers remotely.

## Overview

This integration enables:
- **Browser Use Cloud connection** - Control cloud-hosted browsers instead of local Chrome
- **HTTP/SSE transport** - Expose MCP server over HTTP for remote AI connections
- **Full MCP tooling** - All 25+ Chrome DevTools MCP tools work with cloud browsers

## Quick Start

```bash
# Set your Browser Use Cloud API key
export BROWSER_USE_API_KEY="your-api-key"

# Run with Browser Use Cloud + HTTP transport
npx chrome-devtools-mcp@latest --browser-use-cloud --http-port 3000
```

Then connect your AI model to `http://localhost:3000/mcp`

## New CLI Flags

| Flag | Description |
|------|-------------|
| `--browser-use-cloud` | Connect to Browser Use Cloud instead of local browser |
| `--browser-use-api-key` | API key (or use `BROWSER_USE_API_KEY` env var) |
| `--browser-use-timeout` | Session timeout in minutes (default: 15) |
| `--browser-use-width` | Browser screen width |
| `--browser-use-height` | Browser screen height |
| `--browser-use-proxy` | Proxy country code (e.g., "US", "DE") |
| `--http-port` / `-p` | Run MCP over HTTP on specified port |
| `--http-host` | Host to bind HTTP server (default: 0.0.0.0) |

## HTTP Endpoints

When running with `--http-port`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | Streamable HTTP MCP endpoint |
| `/sse` | GET | Legacy SSE endpoint |
| `/messages` | POST | Legacy SSE messages |
| `/health` | GET | Health check |

## Architecture

```
AI Model (Claude, GPT, etc.)
    |
    | HTTP/MCP Protocol
    v
Chrome DevTools MCP Server (this project)
    |
    | CDP WebSocket
    v
Browser Use Cloud
    |
    | Manages
    v
Cloud Chrome Browser
```

---

# Implementation Details

## Files Modified

### 1. `src/cli.ts`
Added new CLI options for Browser Use Cloud and HTTP transport.

**Key changes:**
- Added `browserUseCloud`, `browserUseApiKey`, `browserUseTimeout`, `browserUseWidth`, `browserUseHeight`, `browserUseProxy` options
- Added `httpPort` and `httpHost` options
- Added validation to require API key when using Browser Use Cloud
- Added usage examples

### 2. `src/browser.ts`
Added `ensureBrowserUseCloudConnected()` function to connect to Browser Use Cloud.

**Key changes:**
- Import `BrowserUseCloud` client
- Create new function that:
  1. Creates a Browser Use Cloud session via API
  2. Fetches `/json/version` to get the actual WebSocket URL
  3. Connects Puppeteer using `webSocketDebuggerUrl`

### 3. `src/BrowserUseCloud.ts` (NEW FILE)
API client for Browser Use Cloud REST API.

**Features:**
- `createSession()` - Create new browser session
- `getSession()` - Get session details
- `stopSession()` - Stop session
- `getCdpUrl()` / `getLiveUrl()` - Get URLs

### 4. `src/main.ts`
Added HTTP server mode with Streamable HTTP and SSE transports.

**Key changes:**
- Import HTTP transports from MCP SDK
- Add HTTP server creation when `--http-port` is specified
- Implement `/mcp`, `/sse`, `/messages`, `/health` endpoints
- Add CORS headers for cross-origin requests
- Handle MCP session management

### 5. `src/third_party/index.ts`
Exported additional MCP SDK modules.

**Added exports:**
- `StreamableHTTPServerTransport`
- `SSEServerTransport`
- `isInitializeRequest`

---

# Development Journey: What Worked and What Didn't

## Attempt 1: Direct HTTPS to WSS Conversion (FAILED)

**What I tried:**
Browser Use Cloud API returns a `cdpUrl` like:
```
https://abc123.cdp0.browser-use.com
```

I tried converting it directly to WSS:
```javascript
cdpUrl = cdpUrl.replace('https://', 'wss://');
// Result: wss://abc123.cdp0.browser-use.com
```

**Why it failed:**
```
Error: Protocol error (Target.getBrowserContexts): Target closed
```

The WebSocket connection was established but immediately closed. The URL format was incorrect.

## Attempt 2: Using the cdpUrl as-is (FAILED)

**What I tried:**
Pass the HTTPS URL directly to Puppeteer's `browserWSEndpoint`.

**Why it failed:**
Puppeteer expects a WebSocket URL (`ws://` or `wss://`), not HTTPS.

## Attempt 3: Fetching /json/version (SUCCESS!)

**The solution:**
The CDP protocol has a standard endpoint `/json/version` that returns browser metadata including the actual WebSocket URL.

```javascript
// 1. Get session from Browser Use Cloud API
const session = await browserUseClient.createSession();
// session.cdpUrl = "https://abc123.cdp0.browser-use.com"

// 2. Fetch /json/version
const response = await fetch(`${session.cdpUrl}/json/version`);
const data = await response.json();
// data.webSocketDebuggerUrl = "wss://abc123.cdp0.browser-use.com/devtools/browser/xyz789"

// 3. Connect Puppeteer with the correct URL
const browser = await puppeteer.connect({
  browserWSEndpoint: data.webSocketDebuggerUrl
});
```

**Why it works:**
- The `/json/version` endpoint is a standard Chrome DevTools Protocol feature
- It returns the full WebSocket path including the browser ID
- The path `/devtools/browser/{browser-id}` is required for CDP connections

### Key Insight

The `cdpUrl` from Browser Use Cloud is the **base URL** for the CDP server, not the WebSocket endpoint. You must:
1. Append `/json/version` to get browser metadata
2. Extract `webSocketDebuggerUrl` from the response
3. Use that URL for Puppeteer connection

---

# Testing the Integration

## 1. Direct Puppeteer Test

```javascript
const puppeteer = require('puppeteer-core');

async function test() {
  // Create session
  const response = await fetch('https://api.browser-use.com/api/v2/browsers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Browser-Use-API-Key': process.env.BROWSER_USE_API_KEY
    },
    body: JSON.stringify({ timeout: 15 })
  });
  const session = await response.json();

  // Get WebSocket URL
  const versionResp = await fetch(session.cdpUrl + '/json/version');
  const version = await versionResp.json();

  // Connect
  const browser = await puppeteer.connect({
    browserWSEndpoint: version.webSocketDebuggerUrl
  });

  // Navigate
  const [page] = await browser.pages();
  await page.goto('https://www.youtube.com');
  console.log('Title:', await page.title());

  await browser.disconnect();
}

test();
```

## 2. MCP Server Test

```bash
# Start server
export BROWSER_USE_API_KEY="your-key"
node build/src/main.js --browser-use-cloud --http-port 4000

# In another terminal:

# Initialize session
curl -X POST http://localhost:4000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# Note the mcp-session-id from response headers

# Navigate to YouTube
curl -X POST http://localhost:4000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: YOUR-SESSION-ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"navigate_page","arguments":{"url":"https://www.youtube.com"}}}'
```

---

# Available MCP Tools

All Chrome DevTools MCP tools work with Browser Use Cloud:

- `navigate_page` - Navigate to URL
- `take_snapshot` - Get page DOM tree
- `take_screenshot` - Capture page screenshot
- `click` - Click on elements
- `fill` - Fill form inputs
- `evaluate_script` - Run JavaScript
- `list_pages` - List browser tabs
- `emulate_network` - Throttle network
- `emulate_cpu` - Throttle CPU
- `performance_start_trace` / `performance_stop_trace` - Performance profiling
- And 15+ more...

---

# Troubleshooting

## "Target closed" error
This usually means the WebSocket URL is incorrect. Make sure you're fetching `/json/version` and using `webSocketDebuggerUrl`.

## "API key required" error
Set the `BROWSER_USE_API_KEY` environment variable or use `--browser-use-api-key` flag.

## Session timeout
Browser Use Cloud sessions have a default 15-minute timeout. Use `--browser-use-timeout` to extend.

## Port already in use
Use a different port with `--http-port 4000` or kill the process using that port.

---

# Keeping Up with Upstream

This branch is designed to receive updates from the main `chrome-devtools-mcp` repository:

```bash
# Add upstream remote (one time)
git remote add upstream https://github.com/anthropics/chrome-devtools-mcp.git

# Fetch and merge updates
git fetch upstream
git merge upstream/main
```

The Browser Use Cloud integration is isolated to specific files, minimizing merge conflicts.

---

# License

Same as the original chrome-devtools-mcp project - Apache 2.0
