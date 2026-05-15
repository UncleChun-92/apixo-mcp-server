# apixo-mcp-server

APiXO MCP server (stdio) for AI clients such as Codex, Cursor, and Claude Desktop.

## Features

- `apixo_generate_task`: submit a generation task to APiXO
- `apixo_get_task_status`: query task status/result by `taskId`
- `apixo_get_balance`: get current key balance

## Requirements

- Node.js `>= 20`
- npm `>= 9`
- APiXO API key

## Environment Variables

- `APIXO_API_KEY` (required): your APiXO key
- `APIXO_BASE_URL` (optional): default is `https://api.apixo.ai`

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

## License

MIT
