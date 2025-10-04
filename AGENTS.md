# Repository Guidelines

## 项目结构与模块组织
- 仓库根目录即 Next.js 应用根目录，保留资料文档（如 `保存库设计刚要.md`、`修改建议*.md`）与配置文件（`package.json`、`tsconfig.json` 等）。
- `src/app/[locale]/` 负责多语言路由、根布局与页面骨架，`src/app/globals.css` 定义全局样式。
- `src/components/` 收录共享组件（例如 `festival-board.tsx`、语言切换工具栏等）。
- `src/data/` 存储业务数据：`festival-list.json`（源列表）、`festivals.json`（生成配置）、`works/`（按 `<slug>.json` 记录作品）。
- `src/lib/` 提供类型定义、数据工具与上下文逻辑。
- 静态资源位于 `public/`，横幅、图标、截图等请放入 `public/banners`、`public/icons`、`public/screenshots` 并保持与数据路径一致。
- 实用脚本集中在 `scripts/`，如 `validate-data.ts` 用于校验祭典与作品 JSON 的模式。

## 构建、测试与开发命令
- `npm run dev` —— 在仓库根目录启动 TurboPack 开发服务器。
- `npm run build` —— 生成生产构建，执行前先确保数据与 lint 通过。
- `npm run lint` —— 运行 ESLint（TypeScript + JSX）。
- `npm run validate:data` —— 调用 Ajv 校验全部祭典/作品 JSON。

## 编码风格与命名规范
- 统一使用 TypeScript，缩进 2 个空格；编辑器可启用 Prettier 默认格式。
- 采用 React 函数组件与 Hooks；涉及状态的组件需加 `"use client"`。
- 使用 `@/` 别名引用 `src`；JSON slug 遵循 `YYYY-keyword`，如 `2024-summer` 对应 `works/<slug>.json`。
- 全局样式存放于 `src/app/globals.css`；保持 BEM 风格命名并兼顾可访问性属性。

## 测试指南
- 目前尚无自动化测试；修改 JSON 后务必运行 `npm run validate:data`，修改 TypeScript/CSS 后运行 `npm run lint`。
- 手动验证：执行 `npm run dev`，检查祭典大纲、手风琴动画与多语言在桌面/移动端的表现。
- 若新增测试，建议与组件同级建立 `__tests__` 目录，文件命名为 `*.test.ts(x)`，可按需配置 Vitest/Jest。

## 提交与合并请求规范
- 提交信息保持祈使句、简洁明确（如 `fix: 对齐图标列宽`），数据更新与代码调整尽量拆分。
- 合并请求需说明用户可见的改动、列出已运行的验证命令，并在涉及 UI 时附截图或动图。
- 关联相关的修改建议文档（`修改建议*.md`）或追踪条目，并邀请熟悉对应语言/数据的维护者评审。

## 数据与本地化提示
- 尽量通过脚本更新 `src/data/festivals.json`，每个祭典都须指向现有的 `works/<slug>.json`。
- UI 文案源自语言字典；数据内容保持单语，界面翻译通过语言上下文提供。
