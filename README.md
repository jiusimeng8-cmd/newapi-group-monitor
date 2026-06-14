# New API Group Monitor

轻量的 New API 分组成功率监控页，适合本地开发、开源到 GitHub，再部署到 Cloudflare 免费层。

- 前端：Cloudflare Pages 静态页面
- API：Cloudflare Pages Functions，同一份逻辑也可作为 Worker 运行
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

- 统计页：<http://127.0.0.1:8788/>
- 配置页：<http://127.0.0.1:8788/admin.html>

`.dev.vars` 里放本地管理密码。真实密钥不要提交到 GitHub。

如果本地端口被占用，可以直接指定端口：

```bash
npx wrangler pages dev public --compatibility-date=2025-12-01 --d1=DB=newapi-group-monitor --binding ADMIN_PASSWORD=change-this-local-admin-password --persist-to=.wrangler/state --port 8793
```

Wrangler 本地不会自动触发 Cron；需要测试定时任务时访问：

```bash
curl http://127.0.0.1:8788/cdn-cgi/handler/scheduled
```

## Cloudflare 部署

1. 创建 D1 数据库：

```bash
npx wrangler d1 create newapi-group-monitor
```

2. 把返回的 `database_id` 写入 `wrangler.toml`。

3. 初始化远程 D1：

```bash
npm run db:init:remote
```

4. 设置 Pages Secret：

```bash
npx wrangler pages secret put ADMIN_PASSWORD
```

5. 部署 Pages：

```bash
npm run deploy
```

6. 在 Cloudflare Pages 项目里绑定同一个 D1 数据库，binding 名称必须是 `DB`。

### 定时刷新

Pages Functions 支持页面和 API 同域部署，手动刷新和缓存读取已经可用。若要开启 Cron 定时刷新，可以把 `src/worker.js` 作为独立 Worker 部署，并复用同一个 D1 数据库；`wrangler.toml` 已保留 `crons = ["*/5 * * * *"]`。

## 开源注意

- `.dev.vars`、`.wrangler/`、`node_modules/` 已加入 `.gitignore`。
- 仓库只提交 `.dev.vars.example`。
- 管理员密码通过 Cloudflare Secret 注入。
- New API 管理密钥只通过配置页提交到服务端，页面不会写入浏览器 localStorage。
- 如果你要公开仓库，先确认没有提交 `.dev.vars`、日志文件、真实 `database_id` 或任何 token。
