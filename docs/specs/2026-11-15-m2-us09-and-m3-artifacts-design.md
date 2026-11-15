# Looma M2 收尾（US09）与 M3（ArtifactDraft）设计规范与分阶段实施计划

> 日期：2026-11-15  
> 基线：`codex/m0-baseline-cleanup`（`7571078`）  
> 关联总纲：[2026-11-07-looma-product-story-and-development.md](./2026-11-07-looma-product-story-and-development.md)

---

## 1. 背景与本次范围（A1 / A2 / A3 已确认决策）

基于 `7571078` 代码核查结果，M1（项目接续与字段依据）及 M2 核心链路（`ConditionIntent` 生成、条件修订、自动触发与半自动确认、`WorkBench` / `ProjectContinuation` 状态流转）均已在 `origin/main` 与 M0 基线中落地；当前尚缺：

1. **M2 收尾（US09 与底盘一致性修复）**：
   - `AppSettings` / `DEFAULT_PUBLIC_SETTINGS` / `SettingsModal` / `WorkBench` 缺少独立于 `remindersEnabled` 的工作建议与条件就绪高亮开关（`workSuggestionsEnabled`）。
   - `WorkBench` 已就绪条件缺少向 M3 准备交付草稿的直达入口。
   - **关键底盘对齐 Bug（核查发现）**：`src/persistence/indexedDb.ts` 的 `relations()` 仅索引 `engagementId` 等字段，遗漏了 `data.projectId` 与 `data.conditionId`（而 `electron/persistence.cjs` 已索引二者），直接影响 `Repository.query('work', 'artifact', { relatedId: projectId })`；同时 `indexedDb.ts` 的 `checkRemovedProjectLinks` 与 `restore` 外键校验尚未覆盖 `'artifact'`。
2. **M3 核心闭环（`ArtifactDraft` 成品草稿流水线 — US07）**：
   - 新增 `src/services/artifacts.ts`：纯本地确定性模板生成器（支持 `proposal_brief`、`material_checklist`、`meeting_brief` 三类成品），**零模型依赖、零网络外发、零猜测预算与客户确认**。
   - 新增混合型变更失效检测（Hybrid `needs_review`）：写库时按受影响项目与来源删改原子标记关联 `ArtifactDraft` 为 `needs_review`（保留用户已编辑正文）；读取/恢复备份时动态比对 `sourceSnapshot`，实时给出差异原因与可选重构/同步入口。
   - 打通 `Repository` 读写/删除接口、`ProjectContinuation` 草稿准备/编辑/审阅/复制/删除界面、`WorkBench` 就绪条件直达桥接，以及双端（IndexedDB + SQLite）+ UI 全量验证。

---

## 2. 详细设计

### 2.1 M2 收尾：US09 独立工作建议开关

#### 2.1.1 设置模型与老备份兼容

- **字段定义**：
  - [persistence-core.mjs](file:///d:/Desktop/personnal-agents/shared/persistence-core.mjs)：`DEFAULT_PUBLIC_SETTINGS` 新增 `workSuggestionsEnabled: true`。
  - [types.ts](file:///d:/Desktop/personnal-agents/src/types.ts)：`PublicAppSettings` 与 `AppSettings` 新增 `workSuggestionsEnabled?: boolean`。
- **备份兼容性**：
  - `validateSettings(settings, partial = false)` 将 `workSuggestionsEnabled` 与 `memoryModelEnabled` 一并豁免为全量恢复可缺省字段：`!['memoryModelEnabled', 'workSuggestionsEnabled'].includes(k)`。
  - 老版本导出的 v3/v4/v5 备份不含 `workSuggestionsEnabled` 时仍可顺利恢复，并通过 `{ ...DEFAULT_PUBLIC_SETTINGS, ...meta.settings }` 自动补全为 `true`。

#### 2.1.2 设置弹窗与工作台门控边界

- [SettingsModal.tsx](file:///d:/Desktop/personnal-agents/src/components/SettingsModal.tsx)：
  - 新增独立复选框（不绑定 `TodoService.configure`，不干扰生活待办与通知能力）：
    - 文案：`开启工作台主动建议与条件就绪提示（关闭仅隐藏主动提示，不删除条件记录，也不影响待办提醒）`
    - 受控值：`form.workSuggestionsEnabled ?? true`
- [App.tsx](file:///d:/Desktop/personnal-agents/src/App.tsx) 与 [WorkBench.tsx](file:///d:/Desktop/personnal-agents/src/components/WorkBench.tsx) / [ProjectContinuation.tsx](file:///d:/Desktop/personnal-agents/src/components/ProjectContinuation.tsx)：
  - `App.tsx` 向 `WorkBench` 传递 `workSuggestionsEnabled={settings.workSuggestionsEnabled ?? true}`（`WorkBenchProps` 默认按 `!== false` 兼容既有单测）。
  - 当 `workSuggestionsEnabled === false` 时：
    - 隐藏首页 `home-section--ready-condition`（“条件已就绪，可推进”）主动提示区块。
    - 隐藏 `ProjectContinuation` 中 `continuation-ready-conditions` 的主动突出推荐条幅；条件记录本身仍保留在“条件跟进”事实列表内，支持人工查看、手动切换状态与手动创建交付草稿。
  - 当 `workSuggestionsEnabled === true` 且 `ConditionIntent.status === 'ready'` 且关联有效 `engagementId` 时：
    - 在条件操作区增加 **“准备交付草稿”** 按钮，点击后跳转到该项目接续面板并预选对应 `conditionId` 打开交付草稿预览编辑器。

---

### 2.2 持久化一致性修复（IndexedDB ↔ SQLite Parity）

1. **`relations(data)` 索引补齐（`src/persistence/indexedDb.ts`）**：
   - 在 `relations(data)` 末尾补齐 `data.projectId` 与 `data.conditionId`，使其与 `electron/persistence.cjs` 对 `artifact.projectId` / `artifact.conditionId` 的 `relations` 索引完全一致。
2. **项目删除与备份恢复引用保护（`src/persistence/indexedDb.ts`）**：
   - `checkRemovedProjectLinks`：检查列表由 `['task', 'followup', 'condition']` 扩展为 `['task', 'followup', 'condition', 'artifact']`，阻止删除仍有关联成品草稿的 `engagement`（与 SQLite `validateLinks` 一致）。
   - `transaction` 预先读取 `targets` 时追加 `...(mutation.after?.projectId ? [['engagement', mutation.after.projectId]] : [])`，保证浏览器端也能通过 `validateTransaction` 对 `artifact.projectId` 的存在性检查。
   - `restore`（`indexedDb.ts`）：校验 `row.kind === 'artifact' && !engagements.has(row.data.projectId)`，若关联项目缺失则拒绝恢复并保留原资料，防止游离 `artifact` 破坏数据库完整性。

---

### 2.3 M3：`ArtifactDraft` 领域服务、失效机制与 UI 流程

#### 2.3.1 类型与字段边界

沿用 [types.ts](file:///d:/Desktop/personnal-agents/src/types.ts#L213-L235) 与 [persistence-core.mjs](file:///d:/Desktop/personnal-agents/shared/persistence-core.mjs#L138-L144) 已定义的 `ArtifactDraft`（`type`: `'proposal_brief' | 'material_checklist' | 'meeting_brief'`；`status`: `'draft' | 'needs_review' | 'ready'`；`sourceSnapshot`: `{ projectUpdatedAt, tasksCount, followUpsCount, conditionsCount }`；`version >= 1`）。

#### 2.3.2 纯本地确定性模板服务（`src/services/artifacts.ts`）

不依赖外网或大模型，全部函数纯确定性、可直接单测：

1. **输入快照**：
   - `computeSourceSnapshot(project, tasks, followUps, conditions)` 生成 `ArtifactDraft['sourceSnapshot']`。
2. **外发安全与不编造规则**：
   - **严格白名单**：只读取 `Engagement` 的 `clientName`、`title`、`stage`、`budgetAmount`、`shareableSummary`、`nextAction`、`updatedAt`，以及关联 `tasks`、`followUps`、`conditions`。
   - **硬性隔离**：`project.internalContext`（内部底线/备注）、无关项目或生活空间数据、原始未核对聊天全文**绝不写入 `ArtifactDraft.content`**。
   - **预算不猜测**：`budgetAmount === undefined` 时明确输出 `预算：待定（未录入，不向客户猜测报价）`。
   - **缺口透明化**：当公开摘要为空、无待办、无到期时间或无待确认事项时，显式列出“当前信息缺口（需人工补充后再发）”。
   - **零自动外发**：正文头部与状态文案均明确“本地工作草稿 · 需人工核对后手动复制，不代表客户已确认，系统不会自动发送”。
3. **三类成品生成器 `buildArtifactDraft(input)`**：
   - `proposal_brief`（方案 / 报价简报）：客户与项目概况、阶段与公开摘要、已约定/计划中下一步（我方行动）、客户等待与待定确认卡点、若绑定 `ConditionIntent` 则附带触发前因与约定后续动作、预算声明与信息缺口清单。
   - `material_checklist`（材料准备清单）：拆分为三栏清单——①“待向客户核实/索取（来自 `waiting` 与 `question`）”、②“我方需完成前置动作（来自未完成 `task` 与 `nextAction`）”、③“前置条件状态与缺口提醒”。
   - `meeting_brief`（沟通 / 对齐会议简报）：议程焦点（阶段 + 公开摘要 + 未定问题）、上轮遗留行动及责任人/原日期表达、本次需当面拍板的卡点与风险提示（附带安全声明）。
4. **状态机与动态新鲜度检查**：
   - `inspectArtifactStaleness(artifact, project, tasks, followUps, conditions)` -> `{ stale, persistedReview, snapshotChanged, reasons }`：
     - 同步检查持久化字段 `artifact.status === 'needs_review'`（带出 `artifact.reviewReason`）和当前现场事实与 `artifact.sourceSnapshot` 的增量变化（`projectUpdatedAt`、行动数、等待与未定数、条件数）。
   - `confirmArtifactReady(artifact, now)`：仅当用户明确点击“核对并标记可查看”时设 `status: 'ready'`、清除 `reviewReason`；若正文被修改或后续发生关联变化，自动退回 `'draft'` 或 `'needs_review'`。
   - `applyArtifactRebuild(existing, freshDraft, mode, now)`：
     - 模式 A（基于最新事实重构新版本）：`version = existing.version + 1`、`status = 'draft'`、清除 `reviewReason`、更新 `title`、`content`、`sourceSnapshot`。
     - 模式 B（保留用户已编辑正文仅重同步快照）：保持 `content`/`title` 不变、`version = existing.version + 1`、`status = 'draft'`、清除 `reviewReason`、更新 `sourceSnapshot`。

#### 2.3.3 混合型 `needs_review` 失效追踪（写入原子更新 + 读取实时兜底）

1. **写入时原子标记（`shared/persistence-core.mjs` + `indexedDb.ts` + `electron/persistence.cjs`）**：
   - 在 `shared/persistence-core.mjs` 新增纯辅助函数：
     - `collectAffectedWorkProjects(mutations)`：从 `'engagement'`、`'task'`、`'followup'`、`'condition'` 变更提取受影响的 `projectId`（含跨项目迁移或删除前后的 `before.engagementId` / `after.engagementId`）。
     - `staleReasonFor(kind)` / `markArtifactStale(artifact, reason, now)`：将 `status` 置于 `'needs_review'`、设置 `reviewReason`，**原样保留用户编辑后的 `content`、`title` 与旧 `sourceSnapshot`**（保留快照差值供 UI 展示变化明细）。
   - 在 **SQLite (`commitCapture` / `commit` / `undo`)** 与 **IndexedDB (`commitCapture` / `transaction` / `undo`)** 的同一事务末尾：
     - 计算本批受影响的 `projectId`；
     - 若存在 `redactSourceIds`（例如 `MemoryCenter` 删除来源 `message`）或被撤回的 `memory`（`status === 'retracted'`）：通过已有索引（`closure` 的 `sourceMessageId -> engagementIds`，或 `memory.engagementIds`）反查受影响项目并加入失效列表（理由为 `关联来源原文或记忆已清理，已保留草稿正文，请重新核对`）；
     - 查询该 `projectId` 下当前仍存在、且未在本批事务中显式写入的 `'artifact'` 记录，若尚未带有同一 `reviewReason` 则原子写回 `needs_review`（不向 `event.mutations` 追加额外记录，确保业务变更的后续 `undo()` 校验不受干扰）。
2. **读取时动态快照比对（`inspectArtifactStaleness`）**：
   - 当用户通过备份恢复、历史版本回滚等非事务途径载入数据后，UI 无需模型调用或二次写库，直接比对 `artifact.sourceSnapshot` 与当前已加载项目事实，实时显示“资料已变化（需核对）”与具体数量/时间差，确保无论从哪条路径变更事实都能被及时察觉。

#### 2.3.4 Repository 封装（`src/persistence/repository.ts`）

- `listProjectArtifacts(projectId: string): Promise<ArtifactDraft[]>`：通过 `query('work', 'artifact', { relatedId: projectId })` 查询并过滤 `item.projectId === projectId`。
- `saveArtifactDraft(draft: ArtifactDraft): Promise<MutationResult>`：校验后以 `{ event: false }` 提交 `transaction('work', ...)`（利用 `'artifact'` 已属于 `isBusinessKind` 的特性自增 `work.revision` 并刷新内存状态）。
- `deleteArtifactDraft(id: string): Promise<MutationResult>`：读取现存记录后原子删除（`after: null`）。

#### 2.3.5 UI/UX 交互与防误触边界（`ProjectContinuation.tsx`）

1. **数据加载**：[projectContinuation.ts](file:///d:/Desktop/personnal-agents/src/services/projectContinuation.ts) 的 `ProjectContinuationData` 新增 `artifacts: QueryPage<ArtifactDraft>`，`loadContinuationPage` 支持 `'artifact'`（按 `row.projectId === projectId` 过滤）。
2. **新建草稿与“取消不留半成品”保障**：
   - 点击 **“生成交付草稿”**（或在就绪条件卡片点击 **“准备交付草稿”**）仅在组件本地内存 state 打开**未落库预览编辑器**（`composer`），绑定当前 `viewKey`（切项目或恢复备份时自动清空）。
   - 用户可在预览区内切换模板类型、查看边界与缺口提示、编辑标题与正文；直接点击 **“取消”** 或 **“关闭预览”** 直接丢弃本地状态，**不触发任何写库操作，保证零幽灵草稿**。
   - 仅当用户点击 **“保存为草稿”** 时才调用 `Repository.saveArtifactDraft` 落库。
3. **已有成品卡片与操作**：
   - 在 `ProjectContinuation` 中新增 **“交付草稿（仅本地编辑与手动复制，不自动发送）”** 区块：
     - 展示每份草稿的类型徽章、版本号 `vN`、状态徽章（`草稿` / `需核对` / `已可查看`）与来源快照摘要。
     - 当处于 `needs_review` 或 `inspectArtifactStaleness(...).stale` 为真时，显示醒目提示框列出变更原因，并提供两项安全处理：
       - **“保留当前编辑并更新快照为最新事实”**（不覆写用户手改内容）；
       - **“按最新事实重新生成 vN+1”**（有明显确认提示后再覆写正文）。
     - **“标记可查看（Ready）”**：需用户明确勾选/确认“已核对事实与缺口，确认仅本地查看/手动复制，不代表客户确认”，不提供任何自动发送外链按钮。
     - **“复制全文”**（调用 `navigator.clipboard` 并回落提示手动复制）、**“编辑”**、**“删除草稿”**（需二次确认或明确删除按钮，删除后立即无残留）。

---

## 3. 分阶段 TDD 实施计划

每阶段遵循红灯（先写失败测试）→ 绿灯（最小干净实现）→ 局部验证；全部阶段完成后执行全量检查与构建。

### Stage 1：M2-US09 独立开关与 IndexedDB 底盘一致性修复

- **目标文件**：
  - `shared/persistence-core.mjs`、`src/types.ts`
  - `src/persistence/indexedDb.ts`
  - `src/components/SettingsModal.tsx`、`src/components/WorkBench.tsx`、`src/components/ProjectContinuation.tsx`、`src/App.tsx`
- **新增/更新测试（先红后绿）**：
  - [persistence-v5.test.cjs](file:///d:/Desktop/personnal-agents/tests/persistence-v5.test.cjs)：验证缺失 `workSuggestionsEnabled` 的老版本备份可顺利导入并默认补全为 `true`；显式关闭后再导出恢复仍保持 `false`。
  - IndexedDB 运行时单测（`tests/indexeddb-v5.runtime.cjs`）：验证 `relations()` 能按 `projectId` 与 `conditionId` 查回 `'artifact'`，验证删除仍有关联 `artifact` 的项目或恢复孤儿 `artifact` 会被拒绝。
  - [closure-ui.test.cjs](file:///d:/Desktop/personnal-agents/tests/closure-ui.test.cjs)：验证关闭 `workSuggestionsEnabled` 仅隐藏工作台/项目内的就绪主动提示，不删除条件记录，且 `remindersEnabled` 独立可控。

### Stage 2：M3 领域服务与双端混合 `needs_review` 失效引擎

- **目标文件**：
  - 新增 `src/services/artifacts.ts`
  - `shared/persistence-core.mjs`、`src/persistence/indexedDb.ts`、`electron/persistence.cjs`、`src/persistence/repository.ts`
- **新增/更新测试（先红后绿）**：
  - 新增 `tests/artifacts.test.ts`：覆盖 3 类 `ArtifactType` 生成、未知预算严禁编造、严禁泄露 `internalContext`、`sourceSnapshot` 计算、`inspectArtifactStaleness` 快照比对、重构保留/升级版本逻辑。
  - 扩充 `tests/persistence-v5.test.cjs` 与 `tests/repository-v5.test.ts`：验证 SQLite 与 IndexedDB 在更新行动/跟进/条件、执行 `undo()`、`MemoryCenter` 清理 `redactSourceIds` / 撤回记忆时，自动将关联 `artifact` 标记为 `needs_review` 且保留正文内容不被覆盖；同时验证取消前未保存不落库。

### Stage 3：M3 `ProjectContinuation` 与 `WorkBench` UI 闭环及端到端验证

- **目标文件**：
  - `src/services/projectContinuation.ts`
  - `src/components/ProjectContinuation.tsx`、`src/components/WorkBench.tsx`、`src/components/work-v5.css`
- **新增/更新测试（先红后绿）**：
  - `tests/project-continuation.test.ts`：验证 `loadProjectContinuation` 加载并按 `projectId` 过滤 `artifacts` 及其游标分页/读取护栏。
  - `tests/project-continuation-ui.test.cjs`：浏览器端 E2E 测试（IndexedDB 真实链路）：
    1. 点击“生成交付草稿”或从就绪条件点击“准备交付草稿”，预览检查边界后点 **“取消”**，刷新确认无幽灵草稿落库；
    2. 生成并保存 `proposal_brief`、`material_checklist`、`meeting_brief`，编辑正文并标记 `ready`（确认仅显示本地可查看文案、无自动发送按钮）；
    3. 完成关联行动或修改项目信息，验证该草稿自动进入 `needs_review` 并高亮提示差异，用户可保留自己编辑的正文重同步快照，也可重算新版本，并可复制与彻底删除。

### Stage 4：全量回归验证

按以下顺序逐项跑通并在最终交付中如实报告输出：
1. `npx tsc --noEmit`
2. `npm run test:native`（Node + SQLite 原生套件）
3. `LOOMA_UI_BROWSER=1 npm test`（全量测试与浏览器 UI 套件）
4. `node scripts/verify-project-continuation.cjs`（项目接续端到端自检脚本）
5. `npm run build`
