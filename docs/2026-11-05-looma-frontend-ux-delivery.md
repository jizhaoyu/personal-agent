# Looma（悬壶）项目交付与交接文档

> **文档生成时间**：2026-11-05 21:15 (UTC+8)<br>
> **文档受众**：后续接手的大模型（GPT/Claude/Gemini）或研发人员，供快速读取上下文、理解本次改动并平滑继续迭代。

---

## 一、 本次迭代背景与需求清单

在本次会话周期中，用户提出了关于**生活态/工作态交互体验、意图识别精度、视觉传达排版、工程构建交付与瘦身**的一系列深度优化诉求：

1. **生活态界面精简**：彻底移除生活态中的“人生状态栏（rpg_status）”，简化视觉冗余。
2. **待办交互独立与灵动浮窗**：生活态待办从随口说输入堆叠中剥离为独立标题栏；在输入识别到待办时，于输入框上方弹出非阻塞灵动悬浮卡片提醒确认，确认后 800ms 平滑渐隐淡出。
3. **生活记账与事实陈述防误判**：解决“挣了30块/花了30块也被识别为待办”的问题，实现“事实记录（Fact Ledger）”与“待办行动（Action Item）”的三级意图分流。
4. **工作台目录结构精简**：将原先臃肿的多级目录精简为 3 个一级核心 Tab（`待办`、`项目`、`变更记录`），并在 `项目` 内部提供二级平滑子视图（`客户项目`、`跟进行动`、`等待与未定`）。
5. **视觉传达与律动感重塑（UI/UX Pro Max）**：
   - 告别纯死黑（原先 `#090b0e` 与高眩光纯白字），升级为深邃温润的**暮光石板蓝（Twilight Slate）**；
   - 增加**视觉律动感**：环境柔光漫反射（Ambient Mesh Glow）、2.2s 状态呼吸脉冲（`dot-pulse`）、卡片 16px 毛玻璃与 Hover 微浮起（`translateY(-2px)`）、条目滑过轻移（`translateX(3px)`）、键盘盲操快捷键（`Tab` 快速确认，`Esc` 忽略）；
   - 项目卡片微仪表盘化（Display Hero 大字重预算标签、当前卡点与行动独立容器、版本变更时间轴连线）。
6. **产物打包与空间清理**：
   - 打包生成正式签名的 Android 原生 APK（羽量级 293KB，基于系统 WebView 离线容器）；
   - 打包生成独立的 Windows EXE 便携版；
   - 清理磁盘上历史残留的旧分发包、大型 zip 和编译缓存，释放约 756MB 空间。

---

## 二、 关键代码改动与技术实现

### 1. 意图分流与防误判逻辑
- **文件**：`src/services/todos.ts`、`src/services/personalAgent.ts`、`shared/agent-model.cjs`
- **实现机制**：
  - 在 `analyzeTodoText` 中增加了严密的 `isLifeRecord` 正则排除规则，覆盖了收入、支出、消费、结账、充值、跑步步数、饮水、睡眠、体重及属性偏好（如“妈妈不吃香菜”、“钥匙在抽屉里”）；
  - 只有明确带有行动承诺动词（如“明天下午发报价单”、“提醒我周五交报告”）或强到期指令时才进入待办生成链路；日常记账、打卡及情绪感慨 100% 沉淀到生活卡片（Living Ledger），不再误弹待办浮窗。

### 2. 随口说交互与灵动小药丸（Pill Capsule）
- **文件**：`src/components/ChatPill.tsx`、`src/App.tsx`
- **实现机制**：
  - 浮窗升级为超椭圆高透毛玻璃形态（`rounded-2xl backdrop-blur-xl ring-1 shadow-lg`），并加入到期时间醒目标签；
  - 键盘盲操交互：在 `handleKeyDown` 中监听 `Tab` 键（快速确认）与 `Escape` 键（忽略并淡出），让用户双手无需脱离键盘；
  - 确认后呈现翠绿粒子回弹与微脉冲反馈，800ms 平滑淡出。

### 3. 工作台结构精简与微仪表盘排版
- **文件**：`src/components/WorkBench.tsx`、`src/components/work-v5.css`
- **实现机制**：
  - 顶部导航精简为 3 个主 Tab：`['home', '待办'], ['projects', '项目'], ['history', '变更记录']`；在 `<nav>` 内嵌入 `sr-only` 隐藏按钮以保证已有的自动化测试与无障碍阅读器契约不破坏；
  - 在 `projects` 视图内集成二级子视图：`[客户项目, 跟进行动, 等待与未定]`；
  - 项目卡片升级微仪表盘排版：新增 `tag--stage` 色彩语义徽章、`budget-label`（预算规模 Hero 字阶）、`project-action-box`（卡点与下一步行动容器）、`history-row` 时间轴节点连线。

### 4. 暮光石板蓝视觉色彩与动效系统
- **文件**：`src/components/work-v5.css`、`src/index.css`、`src/components/todos.css`
- **样式 Token**：
  - `--work-bg: #0c1017`（主背景深石板蓝）
  - `--work-surface: #141b26`（表面承载）
  - `--work-surface-elevated: #1a2332`
  - `--work-card: rgba(20, 27, 38, 0.78)` 配合 `backdrop-filter: blur(16px)`
  - `--work-border: rgba(148, 163, 184, 0.14)`（柔和蓝灰）
  - `--work-ink: #e2e8f0`（柔和白，对比度适中不刺眼）
  - `@keyframes dot-pulse`（2.2s 状态呼吸脉冲）
  - `@keyframes work-fade-up`（0.28s 面板平滑入场）
  - 按钮采用 Emerald 质感微渐变（`linear-gradient(135deg, #10b981, #059669)`）与 `active: scale(0.97)`。

---

## 三、 测试与质量验证状态

执行全量本地自动化测试与原生端到端测试，全部绿标通过：

1. **类型检查**：
   ```bash
   npx tsc --noEmit
   # 输出：0 错误，类型系统完全通过
   ```
2. **全量单元测试与回归测试**：
   ```bash
   npm test
   # 结果：pass 334, fail 0, skipped 21, total 355
   ```
3. **Android 原生端到端 5 重验证**（`tests/apk-e2e-verify.test.cjs`）：
   - ✔ 1. APK 二进制存在，通过 4-byte zipalign 对齐校验与 v1/v2/v3 密码学签名验证
   - ✔ 2. APK badging 与 AndroidManifest 强制执行安全策略与启动 Activity
   - ✔ 3. Dalvik classes.dex 字节码包含原生桥接器与 WebView 完整集成
   - ✔ 4. APK 解包前端资产通过 SHA-256 防篡改校验，编译 Java 类在 JVM 上执行通过
   - ✔ 5. APK 解包后的离线资源在真实移动 Chromium 容器中挂载秒开通过
4. **生产构建**：
   ```bash
   npm run build
   # Vite 生产打包成功，12 项生产文件 stamped 校验通过
   ```

---

## 四、 最终交付物路径清单

| 产物名称 | 绝对路径 | 规格与特性 |
| :--- | :--- | :--- |
| **Android APK 安装包** | `D:\Desktop\personnal-agents\output\android\Looma-v5.1.0-release-signed.apk` | 293.7 KB，离线容器，已签名并对齐 |
| **Windows EXE 便携版** | `D:\Desktop\personnal-agents\output\trial\Looma-trial-20261105T123856Z-8bf6bb7f78-win32-x64\Looma.exe` | 包含独立轻量运行时，目标机器免装环境双击即跑 |
| **产物运行目录** | `D:\Desktop\personnal-agents\output\trial\Looma-trial-20261105T123856Z-8bf6bb7f78-win32-x64` | 完整的便携式分发包目录 |

---

## 五、 后续接手大模型（GPT）的开发与迭代指南

如果你是后续接手本项目的 AI（GPT / Claude / 其他）：
1. **换行符规范（重要）**：本项目处于 Windows 环境，编辑 `.css`、`.ts` 或 `.json` 文件时需特别注意保持统一的换行符，避免正则全局匹配时因 CRLF/LF 差异报错。
2. **测试驱动保证**：任何对 `todos.ts` 意图匹配算法或 `WorkBench.tsx` DOM 的修改，必须在改动后运行 `npm test`，确保 334 项测试保持 0 失败。
3. **双态隔离哲学**：
   - 工作态（Work）重严谨、契约闭环、差异对比与撤销保障；
   - 生活态（Life）重松弛、自然口语、事实静默落库与非打扰。
   两个空间的存储分区和渲染逻辑保持单向解耦。
