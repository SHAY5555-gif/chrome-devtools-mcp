# BrowserUse Integration

This project now supports BrowserUse as a remote browser provider, similar to Browserbase.

## Overview

BrowserUse allows you to run Chrome instances remotely and connect to them via Chrome DevTools Protocol (CDP).

## Usage

### Method 1: Using the wrapper script (Recommended)

The `browseruse-mcp.js` script automatically creates a BrowserUse session and launches chrome-devtools-mcp connected to it:

```bash
node browseruse-mcp.js
```

This script:
1. Creates a new BrowserUse session
2. Gets the CDP URL from the session
3. Launches chrome-devtools-mcp with `--browserUrl` pointing to that CDP URL
4. Automatically cleans up the session when done

#### Configuration

Set your BrowserUse API key via environment variable or CLI flag:

```bash
# Via environment variable
export BROWSERUSE_API_KEY="bu_your_api_key_here"
node browseruse-mcp.js

# Via CLI flag
node browseruse-mcp.js --apiKey bu_your_api_key_here
```

You can pass additional arguments to chrome-devtools-mcp:

```bash
node browseruse-mcp.js --headless --viewport 1920x1080
```

### Method 2: Manual session creation

Use `browseruse-live-session.js` to create a session and get connection details:

```bash
export BROWSERUSE_API_KEY="bu_your_api_key_here"
node browseruse-live-session.js
```

This will output:
- Session ID
- CDP URL
- Example commands to connect

Then manually connect:

```bash
npx chrome-devtools-mcp@latest --browserUrl "wss://your-session-cdp-url"
```

### Method 3: HTTP Config (Smithery/MCP Servers)

Configure BrowserUse in your MCP server config:

```json
{
  "browseruse": {
    "apiKey": "bu_your_api_key_here"
  }
}
```

Or via environment variables:

```bash
export BROWSERUSE_API_KEY="bu_your_api_key_here"
export TRANSPORT=http
npm start
```

The server will automatically create a BrowserUse session on the first tool use and clean it up when the server closes.

## API Information

- **Base URL**: `https://api.browser-use.com/api/v2`
- **Create Session**: `POST /browsers`
- **Delete Session**: `DELETE /browsers/{sessionId}`
- **Authentication**: `X-Browser-Use-API-Key` header

## Files

- `src/browseruse.ts` - TypeScript module for BrowserUse session management
- `browseruse-mcp.js` - Wrapper script that creates a session and launches MCP
- `browseruse-live-session.js` - Helper to create a session and print connection info
- `smithery.yaml` - Configuration schema includes `browseruse` section
- `src/main.ts` - Main server includes BrowserUse integration

## Differences from Browserbase

BrowserUse is simpler than Browserbase:
- No project ID needed
- No context/persistence options
- Single CDP URL returned directly
- Simpler API structure

## Troubleshooting

### Session not cleaning up

If the MCP process crashes, sessions may not be cleaned up automatically. You can manually delete them:

```bash
curl -X DELETE https://api.browser-use.com/api/v2/browsers/{sessionId} \
     -H "X-Browser-Use-API-Key: your_api_key"
```

### Connection issues

Make sure:
1. Your API key is valid
2. The CDP URL is accessible (firewall/proxy settings)
3. The session is still active (sessions may expire)
