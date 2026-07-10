# 在 Codex 中使用 APiXO MCP

给前端同事的最短使用流程：**拿到两个 Token → 把下面的话发给 Codex → 重启一次 → 直接使用。**

不需要自己安装 npm 包，也不需要手动编辑配置文件。

## 先准备两个值 🔑

向 APiXO 负责人领取：

- `APIXO_API_KEY`：正常调用 APiXO 模型、查余额时需要。
- `APIXO_MCP_TOKEN`：查询后台接口合约时需要。

`X-MCP-TOKEN` 是请求头名称，**不用自己配置**。只要把第二个值交给 Codex，它会配置为
`APIXO_MCP_TOKEN`，MCP 会自动带上 `X-MCP-TOKEN`。

> 请只把 Token 发给你自己的 Codex 对话，不要发到群聊、Issue 或代码仓库。

## 只做这一件事：把这段话发给 Codex 🚀

打开 Codex，创建一个新对话。将下面整段内容复制进去，再把两个占位符替换成你自己的值。

```text
请帮我在这台电脑的 Codex 中配置 APiXO MCP，并直接更新当前用户的 Codex 配置。

请使用 MCP 名称 apixo，启动命令为：
npx -y @apixo/mcp-server

请配置以下环境变量：
APIXO_API_KEY = "把这里替换成我的 APiXO API Key"
APIXO_MCP_TOKEN = "把这里替换成我的 APiXO MCP Token"

如果 apixo 已存在，请更新它，不要创建重复配置。
不要修改当前项目里的任何文件，不要写入 .env，不要 Git 提交，也不要在回复中输出我的 Token。
配置完成后，告诉我需要怎样重启 MCP，并确认配置的 MCP 名称是 apixo。
```

Codex 会把 MCP 配置到当前电脑的用户级配置中；`npx` 会在首次启动时自动下载并启动
`@apixo/mcp-server`，不需要手动安装 npm 包。

如果你**不需要查询后台接口合约**，可以删除提示词中的 `APIXO_MCP_TOKEN` 那一行。

## 高层管理员额外能力 🛡️

普通同事拿到的 `APIXO_MCP_TOKEN` 默认只用于查询后台接口合约。

如果负责人发给你的 token 带有 `mcp-token:manage` 权限，Codex 里还可以通过 APiXO MCP 管理 MCP 用户和 key：

- 创建 MCP 用户
- 给用户签发新的只读 `APIXO_MCP_TOKEN`
- 撤销某个 MCP token
- 停用某个 MCP 用户
- 查看最近 MCP 访问日志

通过 MCP 签发的新 token **只能读取后台接口合约**，不能继续签发新的管理员 token。

## 安全边界 🚧

APiXO MCP 只用于查询已发布的模型 schema、公开模型调用能力、已发布的前端后台接口合约，以及受限的
MCP 用户 / key 管理。

如果你问到以下内容，Codex 应该直接拒答，或引导你查看已发布 contract：

- 内部源码、私有仓库、后端实现逻辑
- 数据库连接、原始业务数据、部署 / SSH 信息
- API Key、MCP Token、hash、salt、上游供应商密钥
- 内部 provider endpoint、`real_model`、fallback 路由、缓存拓扑
- 计费内部实现、安全绕过方式

这条规则是 MCP 客户端侧的行为边界；真正的权限边界仍然由 APiXO 后端的 `X-MCP-TOKEN` scope 校验保证。

## 重启后直接开始用 ✅

1. 按 Codex 的提示重启 `apixo`；如果没有提示入口，直接重启 Codex。
2. 开一个新对话，发送：

   ```text
   请使用 APiXO MCP，查询当前可用的模型。
   ```

3. 需要查询后台接口列表时，发送：

   ```text
   请使用 APiXO MCP，列出我有权限查看的后台接口列表。
   ```

能成功返回合约列表，就表示 MCP 已连接，并且合约 Token 可用。

如果 Codex 提示没有 `apixo` 工具或无法连接：重启 Codex 后再试一次；如果提示找不到
`npx`，先安装 Node.js 20 或更高版本；仍不能使用时，把报错截图发给 APiXO 负责人即可。

更多安装说明可参考 [APiXO 官方安装文档](https://apixo.ai/docs/integrations/mcp/installation)。
