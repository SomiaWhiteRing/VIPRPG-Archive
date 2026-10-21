# fes.viprpg.org 静态部署

本站由 Next.js `output: "export"` 导出到 `out/`，通过 Cloudflare Workers Static Assets 项目 `viprpg-fes` 提供整理版、原貌版和图片。原始抓取缓存 `catch/` 不上传。

`wrangler.jsonc` 没有 `main`，`assets.run_worker_first` 为 `false`，不绑定 D1、KV、R2 或其他 Worker。静态资源直接响应，不执行服务端 JavaScript，不消耗账号共享的 Workers 请求和 CPU 包含量。不要加入 SSR、Functions、Worker 代理或启用另行计费的 Workers Caching。

`public/_headers` 为原貌页资源保留跨域响应头，使沙箱 iframe 中的字体等资源可用；Next.js 开发服务器另保留同样的响应头配置。

## 自动发布

推送 `main` 或手动运行 `.github/workflows/deploy.yml` 会在 GitHub 标准 Linux 运行器上校验、构建并上传。公开仓库的标准运行器执行免费。工作流不保存构建 artifact 或 Actions 缓存，不使用 Cloudflare Builds。

仓库 Secret `CLOUDFLARE_API_TOKEN` 保存现有账号部署 token，通过加密 secret 提交；不提交 token 值或本机 OAuth 凭据。目前复用的 token 到期时间为 **2026-12-20 23:59:59 UTC**，届时需更新该 Secret；不撤销或改动其他项目使用的原 token。

本机：`npm ci`、`npm run build`、`npm start`（3100 端口）；正式发布：`npm run deploy`。Wrangler 使用现有登录或环境变量中的 token。

Workers Paid 单版本最多 100,000 个静态文件，单文件最多 25 MiB；上传器会校验限制。配置关闭 `workers.dev`、预览 URL 和日志观测，仅绑定 `fes.viprpg.org`，不更改主站路由。

失败时保留当前在线版本；回退可还原 Git 到所需版本后通过同一工作流重新构建发布。

参考：[Static Assets 计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[GitHub 公共仓库运行器](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
