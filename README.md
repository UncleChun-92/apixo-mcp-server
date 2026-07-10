# apixo-mcp-server

APiXO MCP server (stdio) for AI clients such as Codex, Cursor, and Claude Desktop.

## Features

- `apixo_generate_task`: submit a generation task to APiXO
- `apixo_get_task_status`: query task status/result by `taskId`
- `apixo_get_balance`: get current key balance
- `apixo_list_models`: list model metadata from schema index
- `apixo_get_model_schema`: fetch machine-readable schema for one model
- `apixo_list_admin_contracts`: list published frontend-facing admin API contracts
- `apixo_get_admin_contract`: fetch one published admin API contract
- `apixo_search_admin_contracts`: search published admin API contracts
- Automatic version update reminder (npm registry check with cache)

## Requirements

- Node.js `>= 20`
- npm `>= 9`
- APiXO API key

## Environment Variables

- `APIXO_API_KEY` (required): your APiXO key
- `APIXO_MCP_TOKEN` (optional): contract-read token for `apixo_*_admin_contract*` tools
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
$env:APIXO_MCP_TOKEN = "your_mcp_contract_token"
```

`APIXO_MCP_TOKEN` is separate from `APIXO_API_KEY`. Existing public model tools continue to use
`APIXO_API_KEY`; admin contract tools use `APIXO_MCP_TOKEN` and only read published frontend-facing
admin API contracts.

## Distribution Model

This project is distributed as an npm package; it is not deployed as a long-running MCP web service.

- GitHub stores and reviews the source code.
- The npm registry hosts the public `@apixo/mcp-server` package.
- `npx` downloads the package and starts it as a local stdio child process of the user's MCP client.
- The running MCP process calls the hosted APiXO API, model documentation, and npm registry as needed.

`.env.example` is documentation only. The server does not load it automatically; MCP clients must
provide environment variables through their `env` configuration or the parent process environment.

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
        "APIXO_API_KEY": "your_apixo_key",
        "APIXO_MCP_TOKEN": "your_optional_mcp_contract_token"
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
        "APIXO_API_KEY": "your_apixo_key",
        "APIXO_MCP_TOKEN": "your_optional_mcp_contract_token"
      }
    }
  }
}
```

## Release Process (Maintainers)

Published npm versions are immutable. Complete the following steps in order and never reuse a version
that already exists on npm.

### 1. Prepare a release branch

Start from an up-to-date, clean `main` branch:

```bash
git switch main
git pull --ff-only origin main
git status --short
git switch -c release/v0.2.0
```

Replace `0.2.0` in this guide with the intended release version. Use semantic versioning:

- patch (`0.2.0` -> `0.2.1`) for compatible fixes
- minor (`0.2.0` -> `0.3.0`) for compatible features
- major (`0.x` -> `1.0.0`, then `1.x` -> `2.0.0`) for stable breaking changes

### 2. Synchronize every version source

Update `package.json` and `package-lock.json` without creating a Git tag:

```bash
npm version 0.2.0 --no-git-tag-version
npm install --package-lock-only --ignore-scripts
```

Then update `SERVER_VERSION` near the top of `src/index.ts` to the same value. Verify all three values:

```bash
node -p "require('./package.json').version"
node -p "require('./package-lock.json').version"
rg "SERVER_VERSION" src/index.ts
```

The values must match. A mismatch makes MCP server metadata and automatic update notices incorrect.

### 3. Run release checks

Install strictly from the lockfile, then check, build, audit, and preview the package:

```bash
npm ci
npm run check
npm run build
npm audit
npm pack --dry-run --json
npm publish --dry-run --access public
git diff --check
```

The package preview should contain `package.json`, `README.md`, `dist/index.js`, and
`dist/index.d.ts`. Configure a local MCP client to run `node dist/index.js`, then verify:

1. MCP `initialize` succeeds and reports the new version.
2. `tools/list` includes the expected tools.
3. Read-only tools work with test credentials.
4. Missing or invalid credentials return controlled errors.

Avoid generation calls during routine release smoke tests because they may incur cost.

### 4. Review and merge the source

Commit only the intended release files, push the branch, open a pull request, and merge it into `main`:

```bash
git add package.json package-lock.json src/index.ts README.md
git commit -m "release: v0.2.0"
git push -u origin release/v0.2.0
```

Include any other intentional feature files in the same pull request. Do not publish from an unmerged
or dirty working tree.

### 5. Authenticate and publish from `main`

After the pull request is merged, publish the exact merged commit:

```bash
git switch main
git pull --ff-only origin main
git status --short
npm ci
npm run check
npm run build
npm login --auth-type=web
npm whoami
npm owner ls @apixo/mcp-server
npm view @apixo/mcp-server versions --json
npm publish --access public
```

The working tree must be clean, `npm whoami` must show an authorized maintainer, `npm owner ls` must
confirm package access, and the intended version must not already appear in the published version list.
Complete any npm browser or two-factor authentication prompt. Never put an npm token in this repository,
README, shell history, MCP config, or a committed project-level `.npmrc`.

For a higher-risk release, publish under a temporary tag first:

```bash
npm publish --access public --tag next
npm dist-tag add @apixo/mcp-server@0.2.0 latest
```

Only promote `latest` after the pinned `next` version passes the post-publish checks below.

### 6. Verify the public release

Confirm the registry version, tags, and tarball metadata:

```bash
npm view @apixo/mcp-server version dist-tags --json
npm view @apixo/mcp-server@0.2.0 dist.integrity dist.tarball --json
```

Configure a clean MCP client with a pinned package version:

```json
{
  "command": "npx",
  "args": ["-y", "@apixo/mcp-server@0.2.0"]
}
```

Restart the client and verify MCP `initialize`, `tools/list`, and safe read-only tool calls. After the
registry verification succeeds, create and push the matching Git tag:

```bash
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

### 7. Roll back safely

npm does not allow overwriting a published version. If a release must be rolled back, point `latest`
to the previous good version and deprecate the bad version:

```bash
npm dist-tag add @apixo/mcp-server@0.1.0 latest
npm deprecate @apixo/mcp-server@0.2.0 "Rolled back: see the repository for details"
```

Pin affected clients to the previous version, fix the issue, and publish a new patch such as `0.2.1`.
Avoid `npm unpublish` except for an urgent security or legal incident.

Common failures:

- `E401` / `E403`: log in again and confirm npm package or organization permissions and 2FA.
- `EPUBLISHCONFLICT`: the version already exists; increment it and rerun the complete release checks.
- `npm ci` lockfile error: run `npm install --package-lock-only --ignore-scripts`, review the diff, and retry.
- Interrupted publish with an unclear result: check `npm view @apixo/mcp-server@0.2.0 version` before
  retrying. If the version exists, do not publish it again.

## Update Reminder Behavior

- The server checks the npm registry for the latest package version automatically.
- If a newer version exists, the server logs an update message on startup.
- Tool responses include an `update_notice` field only when an update is available.
- No manual "check update" tool is required.

## License

MIT
