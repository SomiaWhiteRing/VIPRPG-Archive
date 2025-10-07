# VIPRPG GW祭2025 抓取速记

- 源网址：`https://itch.io/jam/vip-gw2025`。
- 下载的原始页面：
  - `catch/2025-gw/jam.html`（Overview，包含主办方提供的表格与指南）。
  - `catch/2025-gw/entries.html`（Submissions，静态列出 30 个 `div.game_cell`）。
  - `catch/2025-gw/screenshots.html`（Screenshots 面板，等待解析）。
- `entries.html` 中的脚本 `R.Jam.BrowseEntries({...})` 已提取为 `catch/2025-gw/entries-data.json`，内含 30 条 `jam_games`，字段覆盖：
  - `game.title / url / cover / short_text / user`，以及作品在 jam 内的 `rate` 页面。
  - `cover` 为 itch CDN 尺寸化 URL（需转换为原图或直接下载 300x240 版本）。

## 后续工作建议
1. **解析生成 works JSON**
   - 编写 `scripts/scrape-2025-gw.ts`，优先消费 `entries-data.json`，并在缺字段时回退抓取 `entries.html`。
   - 对每个 `game.url` 请求作品页，提取下载链接（zip/exe）、说明文本、平台标签。
   - 生成 `src/data/works/2025-gw.json`，字段结构参考 2010 紅白成果。
2. **资产抓取**
   - 下载封面图作为 banner/截图？（需确定 UI 使用方式）；至少保存 300x240 版本到 `public/screenshots/2025-gw/` 或新建 `covers/`。
   - 作品 icon 若缺失，可考虑截取封面或在 jam overview 表格寻找 32×32 图标。
3. **截图与多媒体**
   - `screenshots.html` 里含幻灯片（多图）。需要定位 `data-image_url` 或 `srcset`，下载并去重。
   - Itch 页面通常有多张截图；需在作品详情页内解析 `.screenshot_list`。
4. **下载包暂缓**
   - 仅在 summary 里记录作品的原始下载 URL，当前阶段不抓压缩包也不映射到本地。
   - 后续若要集中归档，再统一生成 `download` 字段或迁移到文件床。
5. **摘要与校验**
   - 完成抓取后生成 `catch/2025-gw-scrape-summary.json`，记录缺失与跳过原因。
   - 常规校验：`npm run validate:data`、`npm run lint`。

> 注意：Itch 资源多为 HTTPS CDN，大量请求时需关注速率限制；建议加入本地缓存与失败重试。
## 当前进度
- 已运行 `scripts/scrape-2025-gw.ts`，生成 `src/data/works/2025-gw.json` 与 `catch/2025-gw-scrape-summary.json`。
- 图标已下载至 `public/icons/2025-gw/`，截图按作品保留最多两张在 `public/screenshots/2025-gw/`。
- 下载包暂未处理，summary 中保留原始 itch.io 下载地址与 `download_url` 接口，后续可据此再补存档。
