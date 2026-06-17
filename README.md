# New API Group Monitor

轻量的 New API 分组成功率监控页，适合本地开发、开源到 GitHub，再部署到 Cloudflare 免费层。

- 前端：Cloudflare Workers Static Assets
- API：Cloudflare Worker
- 缓存：Cloudflare D1
- 统计口径：New API 日志 `type=2` 算成功，`type=5` 算失败
- 认证：远端 New API 使用 `Authorization: Bearer <token>` 和 `New-Api-User: <user_id>`

## 本地开发

```bash
npm install
copy .dev.vars.example .dev.vars
npm run db:init
npm run dev
```

打开：

- 统计页：<http://127.0.0.1:8813/>
- 管理登录：<http://127.0.0.1:8813/admin>

`.dev.vars` 里放本地管理密码。真实密钥不要提交到 GitHub。

如果本地端口被占用，可以直接指定端口：

```bash
npx wrangler dev src/worker.js --local --persist-to=.wrangler/state --port 8813
```

Wrangler 本地不会自动触发 Cron；需要测试定时任务时访问：

```bash
curl http://127.0.0.1:8813/cdn-cgi/handler/scheduled
```

## Cloudflare Workers 部署

1. 创建 D1 数据库：

```bash
npx wrangler d1 create newapi-group-monitor
```

2. 把返回的 `database_id` 写入 `wrangler.toml`。

3. 初始化远程 D1：

```bash
npm run db:init:remote
```

4. 设置 Worker Secret：

```bash
npx wrangler secret put ADMIN_PASSWORD
```

5. 部署 Worker：

```bash
npm run deploy
```

### 定时刷新

Cloudflare Cron Triggers 会定时调用 `scheduled()` 刷新快照。需要开启时在 `wrangler.toml` 增加：

```toml
[triggers]
crons = ["*/5 * * * *"]
```

## 开源注意

- `.dev.vars`、`.wrangler/`、`node_modules/` 已加入 `.gitignore`。
- 仓库只提交 `.dev.vars.example`。
- 管理员密码通过 Cloudflare Secret 注入；后台修改后的密码只保存服务端哈希。
- New API 管理密钥只通过配置页提交到服务端，页面不会写入浏览器 localStorage。
- 如果你要公开仓库，先确认没有提交 `.dev.vars`、日志文件、真实 `database_id` 或任何 token。
