# Looma 工作树交付｜2026-11-05

## 恢复代码

- 基线提交：`cf07d0ebfae9787d771d3c01fe2782587bffa9f0`。来源分支：`codex/project-continuity`。
- `workspace.patch` 包含该基线之后当前工作区的已跟踪改动和项目相关未跟踪文件，包括 Word 归档、项目接续、后台待办、随心记下、训练源码及测试。它不是提交，也不要求改动原工作树。
- 在**目标工作树**中执行以下命令。把交付 ZIP 解压到工作树外，下面以 Windows PowerShell、解压目录 `D:\looma-handoff` 为例；如不同只改 `$handoff`。

```powershell
$handoff = 'D:\looma-handoff'
git status --short
git rev-parse HEAD
git apply --check (Join-Path $handoff 'workspace.patch')
if ($LASTEXITCODE -ne 0) { throw '补丁检查失败；核对基线或目标工作树现有修改，不要强行覆盖。' }
git apply (Join-Path $handoff 'workspace.patch')
if ($LASTEXITCODE -ne 0) { throw '补丁未成功应用。' }
git status --short
```

目标工作树已有相关改动时，先人工比较；不要用 reset 或覆盖用户文件。补丁应用不创建提交。`delivery-manifest.json` 是交付内容 SHA-256 清单。没有打包 `node_modules`、个人资料库、签名密钥、环境变量、API Key、临时测试 profile 或无关目录 `-/`。

## 当前产品状态

- **项目接续**：工作项目详情有当前概况、我方行动、客户等待、未定问题和最近变化；只读来源区分当前保存值和历史依据。主要实现：`src/components/ProjectContinuation.tsx`、`src/services/projectContinuation.ts`。
- **双态待办**：明确提醒直接记；普通计划先建议；缺时间可以先记、不猜时刻。唯一匹配完成后从活跃列表静默移出，历史保留。Windows 托盘驻留，Android 原生闹钟与 SQLite；浏览器仅页面级提醒。Windows 真实 Toast 观察到 show，未做人眼点击验收；Android 无设备未真机复测。
- **随心记下**：工作首页无需选项目即可记录，模型做复杂口语候选，本地验证来源、实体、版本及范围；商业事实仍保留核对。主要入口：`src/services/personalAgent.ts`、`src/services/agentCapture.ts`、`shared/agent-model.cjs`、`src/App.tsx`。新模型及分类训练包不是同一组件。
- **发布证据**：Windows build `trial-20261105T081853Z-732aba972f` 的打包 EXE 验收 16/16（含真实 `gpt-6.1-sol` 多事项）；工程 329 pass / 20 skip / 0 fail，原生 32/32；真实口语全量 182/240，之后只重测 58 个失败用例，34 个通过、24 个仍失败。不能把两次评测相加当作同版本全量结果。报告在 `evidence/`。Windows 便携包未随交付携带；原路径 `D:\Desktop\personnal-agents\output\trial\Looma-trial-20261105T081853Z-732aba972f-win32-x64`。签名 APK 随交付携带；不包含签名密钥。

## 最近工作：等待云服务器的训练结果包

1. 云端上传 `artifacts/looma-intent-training-v2-auto.zip`，解压进入 `looma-intent-v2-auto`，执行 `python3 train_and_pack.py --include-examples`（仅合成或脱敏允许共享的评测语句使用该选项）。从 `downloads/` 下载生成的 `looma-intent-result-*.zip`，上传给接手助手。**当前尚未收到该结果包，不能声称已评审云端 v2。**
2. v2 是 CPU 字符 n-gram 朴素贝叶斯，192 训练 / 24 验证 / 32 原回归，另有 32 挑战样本。打包前本地挑战集 v1 首选 24/32，v2 29/32，v2 接受 17/32 且其中 17 条正确。合成小样本不等于真实用户准确率。无需 GPU、API Key 或 pip；没有微调 `gpt-6.1-sol`，也没有把小模型接进 EXE/APK。
3. 收到结果 ZIP 后，核对 `manifest.json` 的哈希和训练配置，读 `metrics.json` 分析**错却接受、对却拒判、误完成、覆盖率**及分意图结果；不能用低覆盖率换一个虚高的准确率。不要把训练例或同场景改写混到最终测试中。后续优先补脱敏真实口语、否定、暂缓和跨轮指代；是否接入由独立真实用例和最终数据库状态验收决定。

## 接手后重跑

在已安装项目依赖的目标工作树：`npm.cmd test`、`npm.cmd run test:native`、`npx.cmd tsc --noEmit`。若要打包再运行构建并生成 EXE/APK；构建会更新生成资产和 build-info，按需先备份。模型测试用 `scripts/evaluate-personal-agent.cjs`，凭据仅从 `LOOMA_REAL_API_KEY` 环境变量注入，不写入文件。打包 EXE 验证脚本 `scripts/verify-personal-agent-exe.cjs` 需 `LOOMA_EXE_DIR` 指向完整便携包。
