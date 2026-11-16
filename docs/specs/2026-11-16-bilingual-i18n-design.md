# Looma 中英文双语切换（zh-CN / en）架构设计与实施计划

> 日期：2026-11-16
>
> 关联基线：`codex/m0-baseline-cleanup`（含本地桌面端防黑屏修复）
>
> 路径分类：Architectural（跨模块新增功能）

---

## 1. 目标与已确认边界

根据用户确认的产品边界，本次中英文切换遵循以下 4 项约定：

1. **全界面双语覆盖（A1）**：覆盖全部 14 个 React 组件、`App.tsx`、伴侣状态文案、操作提示、外发纪要（`AlignmentModal`）、交付草稿生成器（`artifacts.ts`）与试用问题报告（`trialInfo.ts`）。底层存储枚举值（如商机阶段 `'初步接触' | '需求确认' | '方案报价' | '商务谈判' | '赢单成交'`、卡片类型等）保持不变，仅在 UI 展示层与外发模板中做双语映射；现有中文口语自然语言解析规则保持不变。
2. **双入口即时切换（A2）**：在顶部导航右侧工具栏新增快捷切换按钮（`EN` / `中`），同时在设置弹窗（`SettingsModal`）提供语言下拉选择器；切换后无需刷新页面立即生效，并持久化保存。
3. **默认简体中文与向后兼容（A3）**：默认语言固定为 `'zh-CN'`，确保既有本地数据库、历史 JSON/JSONL 备份及全部 397 项既有测试 100% 向后兼容。
4. **模板切换、原文保留（A4）**：切换为英文时，外发客户对齐纪要（`AlignmentModal`）、边界说明卡、交付草稿结构框架及问题记录模板均切换为英文输出；用户已经录入的项目名称、客户姓名、沟通原文、随手记与自定义打卡标题保留原文不做机器翻译。

---

## 2. 架构设计

### 2.1 语言类型与设置持久化

- **`AppLanguage` 类型**（`src/types.ts`）：
  ```ts
  export type AppLanguage = 'zh-CN' | 'en';
  ```
- **`AppSettings` 与共享校验**（`src/types.ts`、`shared/persistence-core.mjs`）：
  - `AppSettings` 新增可选字段 `language?: AppLanguage`。
  - `DEFAULT_PUBLIC_SETTINGS` 新增默认值 `language: 'zh-CN'`。
  - `OPTIONAL_SETTINGS_KEYS` 纳入 `'language'`，保证不含 `language` 的历史 v3/v4/v5 备份均可正常校验并通过 `{ ...DEFAULT_PUBLIC_SETTINGS, ...meta.settings }` 补全为 `'zh-CN'`。
  - `validateSettings` 在 `language !== undefined` 时严格校验仅允许 `'zh-CN'` 或 `'en'`，拒绝非法语言代码入库。
- **冷启动防闪烁缓存**：
  - 语言切换成功后除写入 `Repository.saveSettings({ ...settings, language })`（落盘至 SQLite / IndexedDB），同步记录一份只用于首屏提示的 `localStorage['looma_language']` 缓存（仅接受 `'zh-CN' | 'en'`）。
  - 在 `Repository.initialize()` 返回前，加载占位页（“正在打开本地工作区…”）与错误恢复页 `RecoveryScreen` 可提前按该语言渲染；一旦 `Repository.initialize()` 完成，以持久化快照中的 `snapshot.settings.language` 为最终权威源。

---

### 2.2 轻量无 Context 约束的 i18n 核心层（`src/i18n/`）

#### 关键工程约束
代码核查显示：`tests/closure-ui.test.cjs`、`tests/practice-ui.test.cjs`、`tests/todo-ui.test.cjs`、`tests/trial-info-ui.test.cjs`、`tests/life-ui.test.cjs`、`tests/project-continuation-ui.test.cjs`、`tests/effortless-workbench.test.cjs` 均在 `vm.runInNewContext` 中直接将函数组件作为普通 JS 函数调用（仅注入了 mock 的 `useState` / `useRef` / `useEffect`，**未注入 `useContext` 或 `useSyncExternalStore` Dispatcher**）。

因此，`useI18n()` **禁止依赖 `React.useContext` 或 `React.useSyncExternalStore`**，而采用极简可订阅 Store + `useState`/`useEffect` 方案：

1. **`src/i18n/zh.ts` 与 `src/i18n/en.ts`**：
   - 使用结构化键值词典模块拆分各域文案（`common`、`header`、`work`、`proposal`、`closure`、`continuation`、`alignment`、`life`、`todo`、`checkin`、`cards`、`companion`、`memory`、`settings`、`practice`、`trial`、`domain`、`errors`）。
   - 通过 TypeScript 类型约束保证 `en.ts` 与 `zh.ts` 的键结构 100% 严格对齐，编译期（`tsc --noEmit`）即可发现漏翻或键名漂移。
2. **`src/i18n/store.ts`**：
   - 维护模块级 `currentLanguage: AppLanguage`（默认 `'zh-CN'`）及订阅者集合 `Set<() => void>`。
   - 导出：
     - `getLanguage(): AppLanguage`
     - `setLanguage(next: AppLanguage): AppLanguage`（更新语言、同步 `document.documentElement.lang` 与 `document.title`、更新 `localStorage['looma_language']`（仅浏览器/安全环境下）、通知所有订阅组件重渲染）
     - `subscribeLanguage(listener: () => void): () => void`
3. **`src/i18n/index.ts`**：
   - 导出 `t(key, params?)`、`translate(lang, key, params?)`（支持 `{count}` 等具名占位符替换）。
   - 导出 `useI18n()`：内部仅调用 `useState(getLanguage)` 与 `useEffect(() => subscribeLanguage(setLang), [])`，返回 `{ lang, isEn, t }`；在真实 Vite/Electron 与全部 Node VM 测试沙盒中均可直接运行。
   - 导出统一领域映射辅助（`src/i18n/domain.ts`）：
     - `formatDealStage(stage, lang)`：`'初步接触' -> 'Initial Contact'` 等 5 个阶段 UI 映射。
     - `formatDateTime(value, lang, options?)`：保留北京时间（`Asia/Shanghai`）口径，按 `'zh-CN'` / `'en-US'` 格式化日期时间与时间段标签。
     - `formatCurrency(amount, lang)`：按千分位展示金额（保留原币种数值，避免擅自换算汇率；中文 `¥120,000` / 英文 `CNY 120,000` 或 `¥120,000` 保持数值一致）。
4. **测试加载器适配**：
   - `scripts/test.mjs` 会自动把 `src/**/*.ts` 转译到临时测试目录 `out/src/**/*.js`。
   - 对使用白名单 `require(dep)` 的 6 个 `*-ui.test.cjs` 沙盒补齐 `../i18n` 模块映射（直接加载编译后的 `src/i18n`），不改变原有默认 `'zh-CN'` 断言。

---

### 2.3 界面与服务双语化明细

| 层级 | 涉及文件 | 改造要点 |
| --- | --- | --- |
| 入口与导航 | [App.tsx](file:///d:/Desktop/personnal-agents/src/App.tsx)、[index.css](file:///d:/Desktop/personnal-agents/src/index.css) | 顶部栏 `.header-tools` 增加 `EN` / `中` 快捷切换按钮（桌面小巧图标按钮、移动端保证 ≥42px 触控热区）；全部导航页签、页脚、Alert、Toast、工作空间切换、`RecoveryScreen` 接入 `useI18n()`；同步 `snapshot.settings.language` 并持久化。 |
| 设置面板 | [SettingsModal.tsx](file:///d:/Desktop/personnal-agents/src/components/SettingsModal.tsx) | “使用偏好”新增语言选择下拉框（简体中文 / English）；全部区块标题、说明、按钮、权限状态、导出/恢复反馈双语化；保存时同步调用 `setLanguage(...)`。 |
| 工作台与核对闭环 | [WorkBench.tsx](file:///d:/Desktop/personnal-agents/src/components/WorkBench.tsx)、[ProposalReview.tsx](file:///d:/Desktop/personnal-agents/src/components/ProposalReview.tsx)、[ClosureReceipt.tsx](file:///d:/Desktop/personnal-agents/src/components/ClosureReceipt.tsx)、[ProjectContinuation.tsx](file:///d:/Desktop/personnal-agents/src/components/ProjectContinuation.tsx) | 工作台页签、输入引导/占位、示例填词、草稿保存状态、核对区四栏、商机阶段展示映射、收尾回执、接续事实卡片、字段依据来源标签与交付草稿编辑器完整双语化。 |
| 外发纪要与交付草稿 | [AlignmentModal.tsx](file:///d:/Desktop/personnal-agents/src/components/AlignmentModal.tsx)、[aiService.ts](file:///d:/Desktop/personnal-agents/src/services/aiService.ts)、[artifacts.ts](file:///d:/Desktop/personnal-agents/src/services/artifacts.ts) | `inspectAlignmentBoundary`、`createAlignmentDraft`、`alignmentText`、`buildArtifactDraft`、`inspectArtifactStaleness` 增加可选参数 `lang: AppLanguage = 'zh-CN'`，默认行为不变；`lang === 'en'` 时生成英文外发模板、边界核验说明、交付草稿标题/小节/待补充缺口提示与导出 PNG 文件名。 |
| 生活空间 | [ChatPill.tsx](file:///d:/Desktop/personnal-agents/src/components/ChatPill.tsx)、[TodoPanel.tsx](file:///d:/Desktop/personnal-agents/src/components/TodoPanel.tsx)、[CheckinBoard.tsx](file:///d:/Desktop/personnal-agents/src/components/CheckinBoard.tsx)、[LivingCardsBoard.tsx](file:///d:/Desktop/personnal-agents/src/components/LivingCardsBoard.tsx) | 随口说引导、待办分组与操作按钮、每日打卡全部表单/格子/限制提示、生活卡片（钱包/心愿/状态/人脉）双语化；支持展示记录汇总或系统回复的英文格式化视图，用户自填卡片名称与原文保持原样。 |
| 伴侣与记忆、演练、问题报告 | [Companion.tsx](file:///d:/Desktop/personnal-agents/src/components/Companion.tsx)、[MemoryCenter.tsx](file:///d:/Desktop/personnal-agents/src/components/MemoryCenter.tsx)、[PracticeModal.tsx](file:///d:/Desktop/personnal-agents/src/components/PracticeModal.tsx)、[TrialInfoModal.tsx](file:///d:/Desktop/personnal-agents/src/components/TrialInfoModal.tsx)、[trialInfo.ts](file:///d:/Desktop/personnal-agents/src/services/trialInfo.ts) | 伴侣状态/胶囊文案、记忆中心检索/置顶/纠正/忘记交互、独立演练外壳按钮、问题记录弹窗及 `buildTrialReport(..., lang = 'zh-CN')` 完整双语化。 |
| 业务服务用户提示对齐 | [checkins.ts](file:///d:/Desktop/personnal-agents/src/services/checkins.ts)、[todos.ts](file:///d:/Desktop/personnal-agents/src/services/todos.ts)、[stateEngine.ts](file:///d:/Desktop/personnal-agents/src/services/stateEngine.ts)、[personalAgent.ts](file:///d:/Desktop/personnal-agents/src/services/personalAgent.ts)、[agentCapture.ts](file:///d:/Desktop/personnal-agents/src/services/agentCapture.ts) | 核心中文口语理解逻辑不变；服务层向 UI 抛出的校验异常、操作摘要与系统回复支持按可选 `lang` 参数或 UI 提示映射在英文模式下显示英文提示（保持默认 `'zh-CN'` 与现有单元测试 100% 兼容）。 |

---

## 3. 分阶段实施计划（Implementation Plan）

### Phase 1：基础架构与持久化扩展
1. 扩展 `src/types.ts`、`shared/persistence-core.mjs`（`DEFAULT_PUBLIC_SETTINGS.language = 'zh-CN'`、`OPTIONAL_SETTINGS_KEYS` 与枚举校验）。
2. 新建 `src/i18n/` 模块：`store.ts`、`domain.ts`、`zh.ts`、`en.ts`、`index.ts`。
3. 在 `tests/persistence-v5.test.cjs` 补充 `language` 枚举校验、老备份恢复兼容及 SQLite 持久化测试。

### Phase 2：核心入口、设置与服务模板双语化
1. 改造 `src/App.tsx`（顶部快捷切换 `EN` / `中`、语言初始化与保存、全局文案与错误提示）及 `src/index.css`（切换按钮视觉及移动端 42px 热区适配）。
2. 改造 `src/components/SettingsModal.tsx` 与 `src/components/Companion.tsx`。
3. 扩展 `src/services/aiService.ts`（`alignmentText` / `inspectAlignmentBoundary` / `chinaTime`）、`src/services/artifacts.ts` 与 `src/services/trialInfo.ts` 支持 `lang = 'zh-CN' | 'en'`，并保证所有缺省调用沿用 `'zh-CN'`。

### Phase 3：工作态与生活态全组件落地
1. 改造工作态组件：`WorkBench.tsx`、`ProposalReview.tsx`、`ClosureReceipt.tsx`、`ProjectContinuation.tsx`、`AlignmentModal.tsx`、`PracticeModal.tsx`。
2. 改造生活态及通用组件：`ChatPill.tsx`、`TodoPanel.tsx`、`CheckinBoard.tsx`、`LivingCardsBoard.tsx`、`MemoryCenter.tsx`、`TrialInfoModal.tsx`。
3. 对齐服务返回至界面的提示文案（`checkins.ts`、`agentCapture.ts` 等在调用链支持英文展示）。
4. 更新 6 个 UI VM 单测加载白名单以正确解析 `../i18n`。

### Phase 4：专项测试与全量构建验证
1. 新增 `tests/i18n.test.ts`：校验 `zh.ts` 与 `en.ts` 键完整对等、`alignmentText('en')`、`buildArtifactDraft(..., 'en')`、`buildTrialReport(..., 'en')`、`formatDealStage` 映射。
2. 新增端到端浏览器测试（Headless Edge Playwright）：点击顶部 `EN` 按钮验证实时无刷新切换（导航、工作台、生活态、打卡、`AlignmentModal` 英文模板预览），刷新页面后确认语言持久化生效，并能切回中文。
3. 执行完整验证链：`npx tsc --noEmit`、`npm run build`、`npm test`、`npm run test:native`、`LOOMA_UI_BROWSER=1` Playwright 浏览器测试、以及 `npm run build:android` 同步校验。
