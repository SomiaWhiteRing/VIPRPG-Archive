# VIPRPG Archive

按年份整理 VIPRPG 祭典和作品的 Next.js 保存库。项目于 2026-10-15 重启；现有资料需要逐批复核，不能按旧抓取记录认定已完成。

- [重启记录与下一批工作](docs/restart.md)
- [重启后的逐祭典校对清单](docs/restart-progress.md)
- [74 个祭典的数据清点](catch/festival-scrape-status.md)
- [可供脚本读取的清点结果](catch/archive-audit.json)

## 运行

```powershell
npm ci
npm run dev
```

打开终端显示的本地地址。数据位于 `src/data/`，展示资源位于 `public/`，来源缓存位于 `catch/`。作品登记还需更新 `src/data/works/index.ts`。

## 维护

```powershell
npm run validate:data
npm run lint
npm run audit:data -- --write
npm run build
```

`validate:data` 检查 JSON 结构、所属祭典、重复标识和本地资源引用；`audit:data` 统计字段、缓存和资源缺口。两者都不能证明内容已与原站逐项对齐，也不检查外链可用性。

开发服务运行期间需要构建并预览生产版本时，在另一个 PowerShell 终端使用独立的输出目录，避免两个服务覆盖同一份路由清单：

```powershell
$env:VIPRPG_DIST_DIR = '.next-preview'
npm run build
npm run start -- --port 3100
```

构建和启动预览应使用相同的 `VIPRPG_DIST_DIR`；普通开发终端不设置该变量，继续使用 `.next`。

`npm run lint` 覆盖应用及本轮启用的维护脚本。历史抓取／补丁脚本保留供参考，使用 `npm run lint:legacy` 单独检查；其既有错误尚未逐个修复，不能直接当成当前批量抓取入口。

2006 夏之阵首批四个详情的本地恢复可重复执行：

```powershell
npx tsx scripts/recover-2006-summer.ts
```

该命令只读取已保存的快照，不进行网络抓取。来源及待恢复图片见 [recovery.json](catch/2006-summer/recovery.json)。

2014 GW 的 69 个详情、69 个图标、69 条作品的截图和 2 张原始横幅已本地保存；第二批 49 张截图直接取自仍可用的源站。恢复命令及当前代理环境的 Node.js 24 用法见[重启记录](docs/restart.md)。

2015 GW 的 71 个正式作品及 No.00 Sample 共 72 个详情已恢复，包含作者／主办留言、72 个图标、108 张展示截图和 2 张横幅。原站与已知迁移入口本次不可用，因此使用原站存档；重新恢复可运行 `npx tsx scripts/recover-2015-gw.ts`，抓取缺少响应时加 `--fetch`。源站可访问时优先源站。

祭典逐步提供“整理版”和“原貌版”两种视图；未完成原貌恢复的条目标示“原貌版整理中”。目前 2014 GW、2014 红白、2014 夏之阵、2015 GW、2015 红白、2015 夏之阵已完成双视图桌面验收，入口为 `/original/<slug>`。原貌版沿用原站 HTML、CSS、必要脚本和本地资源；来源、缺失资源和必要改动记录于各祭典的 `original-view.json`，两个视图的进度分别记入[校对清单](docs/restart-progress.md)。受限条目也保留列表、编号和完整详情骨架，采用固定受限文案及中性占位。
