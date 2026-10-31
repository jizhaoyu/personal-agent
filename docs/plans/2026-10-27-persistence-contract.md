# v4 实施接口契约

此文档冻结并行工作的连接点，不扩展用户范围。

## 持久化请求

`backend.request(command): Promise<any>`（SQLite内部可同步，IPC包装为异步）；所有业务命令使用 `space: 'life'|'work'`。

- `op:'init'` → `{ready:boolean, mode, settings}`，ready表示已有成功迁移或新库初始化标记；未ready时前端提交一次v3迁移。
- `op:'migrate', snapshot, fingerprint` → `{ok,already?}`。snapshot是完整v3且不含Key；原数据不删除，记录幂等迁移标记。
- `op:'bootstrap', space` → `{snapshot,stats}`。snapshot兼容v3字段形状但仅含最近50条各集合，schemaVersion=4；events和messages按时间升序以兼容界面。stats含每类总量、openTasks、dueTasks、storageBytes。不得全库返回。
- `op:'list', space, kind, limit?, cursor?, query?, ids?, names?, relatedId?` → `{items,nextCursor,total?}`，limit默认50、上限200，游标基于(at,id)。query支持中文2字与姓名/项目精确匹配，单字查询要求过滤。ids/names精确读取用于纯解析上下文；relatedId是项目或来源ID。
- `op:'get',space,kind,id` → 实体或null。
- `op:'transaction',space,id,baseRevision?,sourceMessageId?,sourceText?,mutations,event?` → `{ok,error?,receipts?}`。mutations是`{kind,id,before,after}`数组；before/after为实体或null。比较revision及before，事务全成全败；同id幂等。event=true时记录可撤销事件；仅原文/摘要更新不提升业务revision。事务内部事件与业务同写。
- `op:'undo',space` → `{ok,error?}`，倒序撤销最近有效业务事件。
- `op:'settings', patch?` → 无Key公开设置（patch缺省只读）；`op:'mode',space`保存当前模式。
- `op:'stats',space` → 同bootstrap.stats。
- `op:'exportPage',cursor?,limit?` → `{records,nextCursor,settings,mode}`，仅备份用，跨区明确导出。
- `op:'restore',records,settings,mode` → `{ok,error?}`，全部校验后一次替换；正常大文件桌面走主进程文件流，不把全库交给UI。

kind枚举：`message,event,engagement,task,memory,summary,expense,person,journal,custom,wallet,rpg`。wallet仅配置无entries，entries独立expense集合；rpg为单条当前状态。所有行统一`{space,kind,id,data,at}`。settings不属于业务行，不能写入Key。记录数据仍兼容旧实体字段。

新增memory可选字段：`status:'active'|'superseded'|'retracted'`、`subject`、`topic`、`pinned`、`sourceIds:string[]`、`supersedesId`、`validFrom`；旧MemoryItem字段保留。summary含`id,mode,content,sourceIds,createdAt,status`。所有派生记录有sourceIds。

## SQLite / IndexedDB职责

主进程模块 `electron/persistence.cjs` 导出异步 `createPersistence({filePath})`，结果含request、close、exportToFile/restoreFromFile（JSONL交换格式）、filename；实现只暴露白名单协议，不接受原始SQL。

共享纯校验/归一化放 `shared/persistence-core.mjs`，导出 `DEFAULT_PUBLIC_SETTINGS, validateRecord, validateTransaction, flattenV3, searchTerms, makeBootstrap`。SQLite和Web共用；不要导入浏览器/Node专用模块。具体函数参数由持久化worker及时发布，禁止双方各自猜测。

Web后端 `src/persistence/indexedDb.ts` 实现request与同等事务/迁移/索引；前端协调 `src/persistence/repository.ts` 使用桌面 `window.electronAPI.storeRequest`，否则IndexedDB。Repository提供订阅、异步刷新和与旧组件同名的await方法；getSnapshot只返回有界窗口。旧StorageService保留用于v3迁移/基线测试，不再作为生产资料源。

设置新增 `memoryModelEnabled:false`，独立控制记忆内容云端发送，旧modelEnabled不自动扩大授权；凭据接口完全保留。正式UI使用MemoryCenter替换旧MemoryTimeline。

## 集成责任

- 主进程数据库/共享纯逻辑由持久化worker负责。
- IndexedDB/Repository/MemoryCenter与记忆治理由记忆worker负责。
- 主App、旧生活组件的await适配、IPC接线、文件对话框、模型记忆接口由根代理负责。
- 伴侣worker只改新Companion组件/样式与纯状态函数，不改App/主进程。
