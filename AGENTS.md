# 发布与部署规则

当用户要求发布或部署 `@apixo/mcp-server` 时，必须把任务视为完成以下整条流程，而不是只推送 Git：

1. 先检查 `git status` 和差异范围；不要悄悄提交无关改动。
2. 同步 `package.json`、`package-lock.json` 与 `src/index.ts` 中的版本号。
3. 运行 `npm ci`、`npm run check`、`npm run build`、`npm audit --omit=dev`、`npm pack --dry-run --json`，并进行 MCP `initialize` / `tools/list` 冒烟测试。
4. 提交、推送发布分支、创建并合并发布 PR，使远端 `main` 与即将发布的 npm 包一致。
5. 在发布前主动检查 npm 登录状态、包版本是否已存在、dist-tag，以及 `npm publish --dry-run`。
6. 执行真实 `npm publish --access public --tag latest`。若遇到 npm 认证或一次性验证：
   - 先使用已登录的 npm CLI 或 npm 网页会话完成可操作的授权步骤；
   - 不得绕过 MFA、验证码或账户安全机制；
   - 若仍需要用户的验证码，主动打开一个**可见 PowerShell 发布窗口**，并在窗口中完成以下交接：打开 npm 登录/验证页 → 等待用户在浏览器完成验证并按 Enter → 执行发布 → 用 `Read-Host -AsSecureString` 在窗口内读取 OTP 并仅传给 `npm publish --otp`；
   - 用户应只在该可见窗口输入 OTP，Agent 不要求用户把 OTP 复制到对话中；用户完成后回到 Codex 告知结果；
   - 只有在确实无法打开交互窗口或需要无法自动操作的物理确认时，才准确说明卡在哪一步；
   - 不要仅因 `EOTP` 就直接结束发布流程。
7. 发布成功后验证 `npm view @apixo/mcp-server version`、`npm dist-tag ls @apixo/mcp-server`，并从全新的临时目录通过 `npx -y @apixo/mcp-server` 完成 MCP 协议与工具清单验证。
8. 创建并推送对应的 Git 标签 `v<version>`，最后确认工作区干净、`main` 已同步远端，再报告“部署完成”。

## 凭据与安全

- npm 发布凭据、OTP、API Key、MCP Token 只能保存在用户级安全配置、系统凭据库或受控 CI Secret 中，绝不能写进仓库、`.env.example`、文档或 Git 历史。
- 如团队希望无人值守发布，应由包所有者在 npm 中创建最小权限的自动化发布 Token，并保存到受控的用户级/CI Secret；Agent 可使用已提供的安全凭据，但不得自行降低 2FA 或创建超范围凭据。
