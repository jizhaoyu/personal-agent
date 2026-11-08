# Looma 生活态事实与行动分流 Implementation Plan

> 执行方式：使用 superpowers:executing-plans 在当前会话逐步实现。

**Goal:** 修复生活态错入账、重复入账和误建待办，同时保留明确的事实和行动。

**Architecture:** 一个纯分流函数标记已发生事实、明确行动、上下文变更和仅留原话。生活态入口分开提交事实和行动，沿用来源 ID、数据库和目标校验。

**Tech Stack:** TypeScript、现有 Node 测试、Electron SQLite、Android WebView 与雷电。

**Spec:** docs/superpowers/specs/2026-11-05-looma-life-fact-routing-design.md

## Global Constraints

- 工作态、数据库格式、通知调度不改；不增加运行依赖。
- 不确定只留原话；不向远程模型发送真实账本，不保存密钥。
- 成品、源码回归、模型对照、雷电分别记录证据。

## Review Focus

千分位、跨逗号否定、独立肯定事实、同金额不同事件、缺目标的跨轮指代。

## Tasks

- [ ] 先写并运行生活态账务与待办回归，冻结新增输入；确认旧实现能复现错误。
- [ ] 新建 lifeRouting.ts；让 stateEngine.ts 的每条金额片段只进一个类别；让 todos.ts 和 personalAgent.ts 共享生活态分流，保留工作态旧路径。
- [ ] 在 App.tsx 接通混合输入和静默归档；核对来源 ID、重试、待办版本和空间隔离。
- [ ] 运行 TypeScript、既有回归、新用例、204 条旧成品基线；有错写先修，泛化不足则比较模型拆句候选。
- [ ] 验证 Windows 和雷电 APK；分别汇总错写、漏写、未覆盖及复现证据。
