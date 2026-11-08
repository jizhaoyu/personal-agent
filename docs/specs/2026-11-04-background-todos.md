# 双态待办、后台提醒与静默完成

用户已确认：Windows托盘／Android系统后台提醒；明确提醒直接创建，普通计划先建议；到点一次、稍后15分钟；完成后保存历史、静默移出并取消提醒。不自动开启系统登录启动，不对强行停止、关机或权限不足承诺送达。

## 交互
- 两种空间都有常驻待办区，分今天、即将到期、已逾期、待确认建议；已完成默认折叠。
- 明确提醒直接保存；缺少日期或时刻时建立不调度的待确认项，补问缺参，不能沿用旧解析器的默认09:00。
- 普通明确计划只进入建议；假设／否定不进正式队列。完成、取消优先于创建识别。“没完成／准备完成／如果完成”不改状态。
- 唯一匹配或明确上下文才完成，歧义列出候选供选择。完成不弹确认／庆祝通知，仅错误需要说明。
- 保留原文；输入法组合状态的Enter不发送，异步存储失败不清空原文，生活未发送输入跨页保留。

## 记录与接口（实现合同）
新增通用记录kind `todo`，独立于旧工作task；工作task/followup通过确定性source链接投影，不重复创建。基础业务记录格式不改，旧备份继续支持；新备份含todo，旧应用可能不支持新记录。

`TodoRecord`字段：id、space(life/work)、title、status(suggested/pending/completed/cancelled)、createdAt、updatedAt、revision(从1开始)；可选dueAt(带时区ISO)、dueDate(YYYY-MM-DD)、needsTime、completedAt、notifiedRevision、lastNotifiedAt、sourceText、sourceKind(task/followup)、sourceTaskId、sourceFingerprint、sourceDone。

原生端口 `todoRequest(command)` 返回JSON可序列化对象：
- `list {space?}` -> `{ok:true,todos}`（含非活动状态，UI自行过滤分页）；
- `put {todo,expectedRevision:null|number}` -> `{ok:true,todo}`，新增null，更新CAS，revision须递增；失败`{ok:false,error}`；
- `replaceAll {todos}` 原子校验替换该端完整todo集合，用于恢复；
- `capabilities` / `requestPermissions` -> `{ok:true,background,notifications:granted|denied|unknown|unsupported,exactAlarms:granted|denied|not-required|unsupported,enabled}`；
- `configure {enabled}` 控制调度；默认关闭，用户明确建立提醒或点击开启后启用。关闭不删除待办。
- `onTodoFocus(handler)` 事件`{space,id}`：点击通知时恢复窗口／Activity并定位当前任务；不把任意URL作为路由。

Windows端口以已有persistence的todo记录为真相源（同SQLite文件，备份自然覆盖）。Android以原生SQLite todo库为真相源，WebView关闭后Receiver仍可读取；浏览器以现有IndexedDB todo记录保存，仅页面开启期间提醒且明确显示不支持后台。

核心TS服务`TodoService`提供 list/create/update/complete/cancel/snooze/approve/handleText/subscribe/capabilities/requestPermissions/configure/syncLegacy。导入旧工作行动按source链接幂等，已完成todo不因未变动的旧task反复重开；完成同时尽力同步旧工作状态，失败显示同步错误但不重开原生提醒。

## 调度可靠性
只调度pending且有dueAt的事项。完成／取消后先持久化，再取消定时器和已显示通知；回调在发送前重新核对状态与revision。发送标记notifiedRevision绑定revision，改期和稍后提醒会递增revision，同一版本只提醒一次。通知发送失败不虚假记录为已送达。

Windows主进程独立调度，窗口关闭前保留既有草稿保存协议，再隐藏至托盘；明确退出才停止。恢复、改期、完成和系统唤醒均重新核对。通知可点击打开指定待办，正文只含时间与事项，不自动拼接客户备注或金额。

Android使用AlarmManager、Receiver和持久化记录；处理通知权限、精确闹钟能力、重启和时间变更。完成／取消后即使旧PendingIntent触发也核对后放弃。拒绝权限时显示真实能力，不伪装已开启；不做常驻前台服务或远程推送服务器。

## 备份与范围
桌面todo进入现有records备份；Android导出合并原生todo，恢复需先完整验证，失败回滚两侧，恢复期间暂缓调度。不将模型凭据加入备份。完成历史和取消记录保留。

本轮仅修待办入口直接相关的输入法、发送失败和输入保留问题，不宣称其余已发现的财务／健康等问题已修复。交付前真实浏览器验证、原生SQLite测试、Android编译／签名；设备不可用时明确报告真机未执行。
