# apixo-mcp-server

APiXO MCP server (stdio) for AI clients such as Codex, Cursor, and Claude Desktop.

## Features

- `apixo_generate_task`: submit a generation task to APiXO
- `apixo_get_task_status`: query task status/result by `taskId`
- `apixo_get_balance`: get current key balance
- `apixo_list_models`: list model metadata from schema index
- `apixo_get_model_schema`: fetch machine-readable schema for one model
- Automatic version update reminder (npm registry check with cache)

## Requirements

- Node.js `>= 20`
- npm `>= 9`
- APiXO API key

## Environment Variables

- `APIXO_API_KEY` (required): your APiXO key
- `APIXO_BASE_URL` (optional): default is `https://api.apixo.ai`
- `APIXO_MODEL_SCHEMA_INDEX_URL` (optional): default is `https://apixo.ai/docs/models/schemas/index.json`
- `APIXO_MODEL_SCHEMA_BASE_URL` (optional): default is `https://apixo.ai/docs`
- `APIXO_MODEL_SCHEMA_CACHE_TTL_MS` (optional): default `300000` (5 min cache)
- `APIXO_UPDATE_CHECK_ENABLED` (optional): default `true`
- `APIXO_UPDATE_CHECK_URL` (optional): default `https://registry.npmjs.org/%40apixo%2Fmcp-server/latest`
- `APIXO_UPDATE_CHECK_TTL_MS` (optional): default `21600000` (6 hour cache)

Windows PowerShell example:

```powershell
$env:APIXO_API_KEY = "your_apixo_key"
```

## Local Development

```bash
npm install
npm run check
npm run build
npm run dev
```

## Use As MCP Server (local package)

Build once:

```bash
npm run build
```

Then point your MCP client config to the built entry:

```json
{
  "mcpServers": {
    "apixo": {
      "command": "node",
      "args": ["F:/Program/apixo-mcp-server/dist/index.js"],
      "env": {
        "APIXO_API_KEY": "your_apixo_key"
      }
    }
  }
}
```

## Use As npm Package (after publish)

```json
{
  "mcpServers": {
    "apixo": {
      "command": "npx",
      "args": ["-y", "@apixo/mcp-server"],
      "env": {
        "APIXO_API_KEY": "your_apixo_key"
      }
    }
  }
}
```

## Publish Checklist

1. Make sure package name is available and owner has npm rights.
2. `npm login`
3. `npm run check && npm run build`
4. `npm publish --access public`

## Update Reminder Behavior

- The server checks the npm registry for the latest package version automatically.
- If a newer version exists, the server logs an update message on startup.
- Tool responses include an `update_notice` field only when an update is available.
- No manual "check update" tool is required.

## License

MIT
