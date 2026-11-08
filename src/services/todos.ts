import type { TodoRecord, WorkspaceMode } from '../types';
import { isExplicitLifeTask, isUnboundLifeCancellation, routeLifeInput } from './lifeRouting';
import { Repository } from '../persistence/repository';
import { newId } from './storage';
import { resolveDeadline, shanghaiDateKey } from './dates';
import { createForegroundTodoScheduler } from './foregroundTodos';

type Analysis = { kind: 'none'|'create'|'suggest'|'complete'|'cancel'|'clarify'|'supply-time'; title?: string; dueAt?: string; dueDate?: string; needsTime?: boolean; todoId?: string; choices?: TodoRecord[]; choiceAction?: 'complete'|'cancel'|'time' };
type Port = (command: any) => Promise<any>;
const active = (t: TodoRecord) => t.status === 'pending' || t.status === 'suggested';
const numeral = (text: string) => {
  if (/^\d+$/.test(text)) return Number(text);
  const n = (s: string) => '零一二三四五六七八九'.indexOf(s.replace('两','二'));
  if (text.includes('十')) { const [a,b] = text.split('十'); return (a ? n(a) : 1)*10 + (b ? n(b) : 0); }
  return n(text);
};
function timeFields(raw: string, now: number): {dueAt?: string; dueDate?: string; needsTime?: boolean} {
  const text = raw.replace(/点一刻/g,'点15分').replace(/点三刻/g,'点45分')
    .replace(/(点)([零一二两三四五六七八九十]+)(分?)/g, (_s,p,n)=>`${p}${numeral(n)}分`)
    .replace(/([零一二两三四五六七八九十]+)\s*个?\s*半\s*小时(?:之)?后/g, (_s,n)=>`${numeral(n)*60+30}分钟后`)
    .replace(/半\s*个?\s*小时(?:之)?后/g,'30分钟后')
    .replace(/([零一二两三四五六七八九十]+)\s*个?(?=点|分|小时|分钟|天后)/g, (_s,n) => String(numeral(n)));
  const relative = text.match(/(\d+)\s*(分钟|小时)(?:之)?后/);
  if (relative) {
    const delta = +relative[1] * (relative[2] === '小时' ? 60 : 1);
    return delta > 0 && delta <= 525600 ? {dueAt: new Date(now+delta*60000).toISOString()} : {needsTime:true};
  }
  const clock = /\d{1,2}(?:[:：]\d{2}|点)/.test(text);
  const date = /今天|今日|今晚|明天|明早|明晚|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\d+[年月号]|\d{4}-\d{2}-\d{2}|\d+天后|月底|月初|月中/.test(text);
  if (!date) return {needsTime:true};
  const resolved = resolveDeadline(text, now).dueAt;
  if (!resolved) return {needsTime:true};
  const dueDate = shanghaiDateKey(Date.parse(resolved));
  if (!clock || Date.parse(resolved) <= now) return {dueDate:date ? dueDate : undefined, needsTime:true};
  return {dueAt:resolved};
}
const NO_TIME_QUALIFIER = /(?:(?:都|先|暂时|统统|全都)?(?:不设|不用设|不需要设|暂不设|别设|不要设)(?:置)?(?:时间|提醒|闹钟)|(?:都)?先记着|(?:先|暂时)?(?:不用|不要|别)(?:设)?(?:提醒|闹钟|时间)|(?:现在|今天|这会儿)?没空(?:弄|处理|做)?|(?:具体)?(?:几点|哪天|哪一天|时间|日期)(?:以后再说|再说|我还没想好|还没想好|还没定|没定|以后再定|待定))/;
export function taskTitle(text: string) {
  return text.replace(/^[，,\s]*(?:还有|另外|顺便|以及|并且|同时|然后再|然后|再(?!说|定|补|议|看))\s*/,'')
    .replace(/[，,；;\s]*(?:(?:都|先|暂时|统统|全都)?(?:不设|不用设|不需要设|暂不设|别设|不要设)(?:置)?(?:时间|提醒|闹钟)|(?:都)?先记着|(?:先|暂时)?(?:不用|不要|别)(?:设)?(?:提醒|闹钟|时间)|(?:现在|今天|这会儿)?没空(?:弄|处理|做)?|(?:具体)?(?:几点|哪天|哪一天|时间|日期)(?:以后再说|再说|我还没想好|还没想好|还没定|没定|以后再定|待定))[。！!\s]*/g,'')
    .replace(/(?:这两件事|两件事|二件事|这几件事|几件事|这件事)?(?:请|帮我|给我|先|都)?记(?:一下|下来|下|着|住|上|一笔)(?:两件事|二件事|几件事)?|找时间|回头|有空(?:再)?/g,'').replace(/^把/,'').replace(/交了/g,'交')
    .replace(/(?:\d+|[一二两三四五六七八九十]+)\s*个?\s*(?:半\s*)?(?:分钟|小时)(?:之)?后|半\s*个?\s*小时(?:之)?后/g,'')
    .replace(/\d{4}[年\-/]\d{1,2}[月\-/]\d{1,2}[日号]?|\d{1,2}月\d{1,2}[日号]?/g,'')
    .replace(/(?:下|本|这)?(?:周|星期|礼拜)[一二三四五六日天]|大后天|后天|明天|今天|今日|今晚|明早|明晚|\d+天后/g,'')
    .replace(/(?:上午|下午|晚上|傍晚|中午|早上|凌晨)?\s*(?:\d{1,2}|[一二两三四五六七八九十]+)(?:[:：]\d{2}|点(?:半|(?:\d{1,2}|[一二三四五六七八九十]+)分?)?)/g,'')
    .replace(/(?:请|帮我|给我|记得)?(?:提醒我|提醒一下|提醒|叫我一下|叫我一声|喊我一下|喊我一声|(?:添加|新增|记|加|留)(?:一个|一条|个|条)?(?:待办|任务)|设(?:置)?(?:一个|一条)?提醒)(?:一下|去|要)?/g,'')
    .replace(/^[我\s，,：:]+|[\s，,。！!]+$/g,'').replace(/^(?:可能|准备|计划|打算|要|得|会|去)/,'').trim().slice(0,500);
}
const significant = (s: string) => s.replace(/已经|已|完成|完毕|结束|取消|不用|提醒|待办|任务|那个|这个|我|把|的|了|发(?:送)?|交|去|做|好|付|缴纳|[\s\p{P}]/gu,'');
export const todoRescheduleVerb = /改到|改成|改为|挪到|移到|调到|推到|推迟到|提前到|延后到/;
export function analyzeTodoText(text: string, context: {now:number;space:WorkspaceMode;todos:TodoRecord[];contextTaskId?:string}): Analysis {
  const clean=text.trim(), todos=context.todos.filter(t=>t.space===context.space && active(t));
  if (!clean || /如果|假如|举例|例如|比如|以为|应该|好像|似乎|可能已经|是不是|是否|有没有|[“”「」"？?]|(?:吗|吧|么)[。！!\s]*$/.test(clean)) return {kind:'none'};
  if(context.space==='life'&&isUnboundLifeCancellation(clean))return {kind:'none'};
  // An instruction to move an existing item is not a new plan or reminder.
  if (todoRescheduleVerb.test(clean)
      && /(?:那(?:一)?(?:条|项|件|个)|这(?:一)?(?:条|项|件|个)|原(?:来|先)|提醒|待办|改到|挪到|推迟到|提前到)/.test(clean)) return {kind:'none'};
  const hasCapturePrefix = /(?:请|帮我|给我|先)?记(?:一下|下来|下|着|住|上|一笔)|(?:请|帮我|给我|先)?把.+?(?:先|都)?记(?:一下|下来|下|着|住|上|一笔)|(?:请|帮我|给我)?(?:记|加|新增|添加|留)(?:一条|一个|个)?(?:待办|任务)/.test(clean);
  const hasNoTimeQualifier = hasCapturePrefix && NO_TIME_QUALIFIER.test(clean) && !/不用给我|别给我|不要给我/.test(clean);
  const cancel = !/(?:别|不要|不用|不必|不能|先别|暂不).{0,6}(?:取消|撤|删|关)|不是.*取消|先缓|暂缓/.test(clean) && /取消|不用再提醒|不需要.*提醒/.test(clean) && !hasNoTimeQualifier;
  const isFactNote = /记(?:一)?个信息|随手记(?:一)?个信息|别动.*资料|先别整理|喜欢|讨厌|爱喝|爱吃|爱听|不吃|不喝|过敏|生日是|密码是|车位在/.test(clean);
  const captureVerb = /交|买|联系|发|办理|整理|提交|检查|对|校对|核对|复核|确认|汇总|打印|复印|预约|领取|跟进|催|问|拿|取|寄|修|改|写|做|准备|更新|盘点|清点|归档|备份|导出|上传|下载|同步|安排|沟通|对接|回访|开票|报销|预订|续费|盖章|审阅|审核|测试|部署|采购|补齐|补交|给.{1,10}发/;
  const capture = !isFactNote && hasCapturePrefix && (hasNoTimeQualifier || captureVerb.test(clean));
  const completed = !capture && !/(?:客户|同事|对方|别人|他们|她们|他|她)(?:说|已经|刚)|还没|没有|未完成|[没不未别].{0,8}(?:完成|做|交|发|付|办)|明天|后天|准备|计划|打算|将要|等.*完成/.test(clean) && /已经.*[了好]|已完成|完成了|做完了|搞定|办好了|交了|发了|付了/.test(clean);
  if (cancel || completed) {
    const key=significant(clean);
    let matches=key ? todos.filter(t=>{const title=significant(t.title);return title && (title.includes(key)||key.includes(title));}) : todos;
    if (!key && context.contextTaskId) matches=todos.filter(t=>t.id===context.contextTaskId);
    if(matches.length===1)return {kind:cancel?'cancel':'complete',todoId:matches[0].id};
    if(matches.length>1)return {kind:'clarify',choices:matches,choiceAction:cancel?'cancel':'complete'};
    return {kind:'none'};
  }
  if (!hasNoTimeQualifier && /不(?:用|要|需要).*提醒|别.*提醒|不要.*待办/.test(clean)) return {kind:'none'};
  const waiting=todos.filter(t=>t.needsTime);
  if (/^(?:今天|明天|后天|\d{4}-\d{2}-\d{2})?(?:上午|下午|晚上|中午|早上|凌晨)?\s*[\d一二两三四五六七八九十]+(?:[:：]\d{2}|点(?:半|\d+分?)?)[。！!\s]*$/.test(clean) && waiting.length) {
    if(waiting.length>1)return {kind:'clarify',choices:waiting,choiceAction:'time'};
    return {kind:'supply-time',todoId:waiting[0].id,...timeFields(/今天|明天|后天|\d{4}-/.test(clean)?clean:`${waiting[0].dueDate||''} ${clean}`,context.now)};
  }
  const explicit=capture||/提醒|(?:叫我|喊我)(?:一下|一声)|添加.*(?:待办|任务)|记.*待办/.test(clean)||context.space==='life'&&isExplicitLifeTask(clean);
  // Life ledger entries (expenses, income, savings, water, sleep, weight) and past-tense records are facts, not future todos.
  const isLifeRecord = !explicit && (
    /(?:挣了?|赚了?|花了?|付了?|买了?|存了?|攒了?|消费了?|支出了?|花费了?|用了?|刷了?|扣了?|收入了?|入账了?|开销了?|充值了?|结账了?)\s*[¥￥]?\s*\d+/.test(clean)
    || /(?:发工资|工资|外快|兼职|退税|退款|报销|红包|奖金|早饭|早餐|午饭|午餐|晚饭|晚餐|夜宵|宵夜|打车|咖啡|拿铁|美式|奶茶|果茶|水果|零食|买菜|超市|外卖|快递|话费|水费|电费|燃气|网费|房租|物业|电影|理发|买药)\s*[¥￥]?\s*\d+/.test(clean)
    || /(?:喝了?|炫了?|补)\s*(?:\d+|[一二两三四五六七八九十])?\s*(?:杯|瓶|毫升|ml)\s*水?/i.test(clean)
    || /(?:跑了?|慢跑了?|散步了?|走了?)\s*\d+(?:\.\d+)?\s*(?:公里|千米|km|步)/i.test(clean)
    || /睡了?\s*\d+(?:\.\d+)?\s*(?:个?小时|h)/i.test(clean)
    || /^\d+(?:\.\d+)?\s*(?:kg|公斤|千克|斤)$/i.test(clean)
    || /(?:不吃|喜欢|讨厌|爱喝|爱吃|在(?:家里|公司|办公室|抽屉|包里|门口)|密码是|车位在|生日是)/.test(clean)
  );
  if (context.space==='life'
    ? !explicit&&!routeLifeInput(clean).some(part=>part.route==='action')
    : isLifeRecord) return {kind:'none'};
  // Multi-fact client communications must keep the existing project review flow.
  if (!explicit && context.space === 'work' && /[，,。；;]/.test(clean) && /预算|项目|客户|需求|阶段/.test(clean)) return {kind:'none'};
  const plan=/明天|后天|大后天|今天|周[一二三四五六日天]|星期|礼拜|\d+点|[一二两三四五六七八九十]+点/.test(clean) && !/还没|没有|吗|？|\?|取消/.test(clean);
  if(!explicit&&!plan)return {kind:'none'};
  const title=taskTitle(clean); if(!title)return {kind:'none'};
  return {kind:explicit?'create':'suggest',title,...timeFields(clean,context.now)};
}

export function createTodoService(port: Port, options: {now?:()=>number;id?:()=>string;repository?:typeof Repository}={}) {
  const now=options.now||Date.now, id=options.id||(()=>newId('todo')), repo=options.repository;
  const listeners=new Set<()=>void>(); let queue:Promise<any>=Promise.resolve(), syncing:Promise<void>|undefined;
  const emit=()=>{for(const fn of listeners)try{fn();}catch{}};
  const request=async(c:any)=>{const r=await port(c);if(r?.ok===false)throw new Error(r.error||'待办操作失败');return r;};
  const writable=()=>{if(repo?.isRestoring?.())throw new Error('正在恢复资料，请恢复完成后重新核对待办。');};
  const epoch=()=>repo?.getReadIdentity?.().split(':')[0];
  const guard=(expected:string|undefined)=>{writable();if(expected!==epoch())throw new Error('资料已经恢复，请按当前待办重新操作。');};
  async function mirror(todo:TodoRecord) {
    if(!repo||!todo.sourceKind||!todo.sourceTaskId)return;
    const source:any=await repo.get('work',todo.sourceKind,todo.sourceTaskId);
    if(source){const result=await repo.setItemState(todo.sourceKind,source,todo.status==='completed');if(result.outcome!=='committed')throw new Error('待办已保存，原行动同步失败，请在项目中重试。');}
  }
  const service={
    subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
    refresh(){if(repo===Repository)resetForeground();emit();},
    async list(space:WorkspaceMode,includeInactive=false):Promise<TodoRecord[]>{const r=await request({op:'list',space});return r.todos.filter((t:TodoRecord)=>t.space===space&&(includeInactive||active(t)));},
    async create(input:Pick<TodoRecord,'space'|'title'> & Partial<TodoRecord>):Promise<TodoRecord>{
      writable();
      const todo={...input,id:input.id||id(),status:input.status||'suggested',createdAt:now(),updatedAt:now(),revision:1} as TodoRecord;
      const r=await request({op:'put',todo,expectedRevision:null});emit();return r.todo;
    },
    async update(todo:TodoRecord,patch:Partial<TodoRecord>):Promise<TodoRecord>{
      writable();
      const next={...todo,...patch,id:todo.id,space:todo.space,createdAt:todo.createdAt,updatedAt:now(),revision:todo.revision+1};
      // JSON transport must omit cleared optional values on every platform.
      const clean=JSON.parse(JSON.stringify(next));const r=await request({op:'put',todo:clean,expectedRevision:todo.revision});emit();return r.todo;
    },
    async complete(todo:TodoRecord){const expected=epoch();const next=await service.update(todo,{status:'completed',completedAt:now()});guard(expected);await mirror(next);return next;},
    cancel(todo:TodoRecord){return service.update(todo,{status:'cancelled'});},
    async snooze(todo:TodoRecord,minutes=15){const expected=epoch();await service.configure(true);guard(expected);return service.update(todo,{status:'pending',dueAt:new Date(now()+minutes*60000).toISOString(),needsTime:false,completedAt:undefined});},
    async approve(todo:TodoRecord,dueAt?:string){
      const expected=epoch();
      const due=dueAt||todo.dueAt;
      if(!due)return service.update(todo,{status:'pending',needsTime:true});
      if(!Number.isFinite(Date.parse(due))||Date.parse(due)<=now())throw new Error('请填写明确的未来日期和时间。');
      await service.configure(true);guard(expected);return service.update(todo,{status:'pending',dueAt:new Date(due).toISOString(),needsTime:false});
    },
    capabilities(){return request({op:'capabilities'});},
    requestPermissions(){return request({op:'requestPermissions'});},
    async configure(enabled:boolean){const expected=epoch();writable();await request({op:'configure',enabled});guard(expected);if(repo){const settings=await repo.getSettings();guard(expected);await repo.saveSettings({...settings,remindersEnabled:enabled});}emit();},
    handleText(text:string,space:WorkspaceMode,contextTaskId?:string):Promise<{handled:boolean;silent?:boolean;message?:string;created?:TodoRecord;needsTime?:TodoRecord;needsChoice?:TodoRecord[];choiceAction?:'complete'|'cancel'|'time'}>{
      const run=async()=>{
        const expected=epoch();writable();const todos=await service.list(space);guard(expected);const a=analyzeTodoText(text,{now:now(),space,todos,contextTaskId});
        if(a.kind==='none')return {handled:false};
        if(a.kind==='clarify')return {handled:true,needsChoice:a.choices,choiceAction:a.choiceAction,message:'有多条相近待办，请选择具体一条。'};
        if(a.kind==='complete'||a.kind==='cancel'){const todo=todos.find(t=>t.id===a.todoId)!;await service[a.kind](todo);return {handled:true,silent:true};}
        if(a.kind==='supply-time'){
          const todo=todos.find(t=>t.id===a.todoId)!;
          if(!a.dueAt)return {handled:true,needsTime:todo,message:'请补充明确的未来日期和时间。'};
          const created=await service.approve(todo,a.dueAt);return {handled:true,created};
        }
        const duplicate=todos.find(t=>t.title===a.title && t.sourceText===text && t.dueAt===a.dueAt);
        if(a.kind==='create'&&a.dueAt)await service.configure(true);
        guard(expected);
        if(duplicate)return {handled:true,created:duplicate,...(duplicate.needsTime?{needsTime:duplicate}:{})};
        const created=await service.create({space,title:a.title!,status:a.kind==='create'?'pending':'suggested',dueAt:a.dueAt,dueDate:a.dueDate,needsTime:a.needsTime,sourceText:text});
        return {handled:true,created,...(created.needsTime?{needsTime:created,message:'已记下，尚未安排准确提醒。时间可以以后再补。'}:{})};
      };
      const result=queue.then(run);queue=result.catch(()=>{});return result;
    },
    syncLegacy():Promise<void>{
      if(!repo||repo.isRestoring?.())return Promise.resolve();
      if(syncing)return syncing;
      syncing=(async()=>{
      const epoch=repo.getReadIdentity?.().split(':')[0];
      const current=()=>!repo.isRestoring?.()&&epoch===repo.getReadIdentity?.().split(':')[0];
      const existing=await service.list('work',true);
      if(!current())return;
      const seen=new Set<string>();
      for(const kind of ['task','followup'] as const){
        let cursor:string|undefined;
        do{
          const page=await repo.query<any>('work',kind,{limit:200,cursor});cursor=page.nextCursor||undefined;
          if(!current())return;
          for(const item of page.items){
            const dueAt=kind==='task'?item.dueAt:item.reviewAt, done=kind==='task'?item.done:item.status==='resolved';
            const todoId=`legacy-${kind}-${item.id}`, previous=existing.find(t=>t.id===todoId);
            seen.add(todoId);
            if(kind==='followup'&&!dueAt&&!previous)continue;
            const fingerprint=JSON.stringify([item.title,dueAt||'',done]);
            if(previous?.sourceFingerprint===fingerprint)continue;
            if(!current())return;
            const patch:Partial<TodoRecord>={title:item.title,dueAt,needsTime:!dueAt,sourceKind:kind,sourceTaskId:item.id,sourceFingerprint:fingerprint,sourceDone:done};
            if(done){patch.status='completed';patch.completedAt=now();}
            else if(!previous||previous.sourceDone===true){patch.status=dueAt?'pending':'suggested';patch.completedAt=undefined;}
            if(previous)await service.update(previous,patch);else await service.create({...patch,id:todoId,title:item.title,space:'work'});
          }
        }while(cursor);
      }
      for(const previous of existing)if(previous.sourceTaskId&&!seen.has(previous.id)&&active(previous)){if(!current())return;await service.update(previous,{status:'cancelled',sourceDone:true,sourceFingerprint:'source-deleted'});}
      })().finally(()=>{syncing=undefined;emit();});
      return syncing;
    },
  };return service;
}

let foreground:ReturnType<typeof createForegroundTodoScheduler>|undefined;
let foregroundTimer:ReturnType<typeof setInterval>|undefined;
const foregroundTick=()=>{void foreground?.tick().catch(()=>{});};
function resetForeground(){
  configureForeground(false);
  if(typeof window==='undefined'||window.electronAPI?.todoRequest||Repository.isRestoring())return;
  const epoch=Repository.getReadIdentity().split(':')[0];
  void Repository.getSettings().then(settings=>{if(!Repository.isRestoring()&&Repository.getReadIdentity().split(':')[0]===epoch)configureForeground(settings.remindersEnabled);}).catch(()=>{});
}
function configureForeground(enabled:boolean){
  if(typeof window==='undefined'||typeof document==='undefined')return;
  if(!enabled){foreground?.stop();foreground=undefined;clearInterval(foregroundTimer);foregroundTimer=undefined;return;}
  if(foreground)return;
  foreground=createForegroundTodoScheduler({
    list:async()=>{if(Repository.isRestoring())throw new Error('正在恢复资料');const r=await browserPort({op:'list'});if(Repository.isRestoring())throw new Error('正在恢复资料');return r.todos;},
    markDelivered:async todo=>{
      if(Repository.isRestoring())return;
      const epoch=Repository.getReadIdentity().split(':')[0];
      const before=await Repository.get<TodoRecord>(todo.space,'todo',todo.id);
      if(Repository.isRestoring()||epoch!==Repository.getReadIdentity().split(':')[0])return;
      if(!before||before.revision!==todo.revision||before.status!=='pending')return;
      const result=await Repository.transaction(todo.space,[{kind:'todo',id:todo.id,before,after:{...before,notifiedRevision:before.revision,lastNotifiedAt:Date.now()}}],{event:false});
      if(!result.ok)throw new Error('提醒状态暂未保存');
    },
    notify:(todo,shown,failed,clicked)=>{
      const time=new Date(todo.dueAt!).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
      if(typeof Notification!=='undefined'&&Notification.permission==='granted'){
        const notice=new Notification('Looma · 待办提醒',{body:`${time}\n${todo.title}`});
        notice.onshow=shown;notice.onerror=failed;notice.onclick=()=>clicked?.();return{close:()=>notice.close()};
      }
      // A visible page alert still works when browser/system notifications are unavailable.
      const notice=document.createElement('aside');notice.className='todo-foreground-notice';notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
      const label=document.createElement('span');label.textContent=`待办到期：${todo.title} · ${time}`;notice.append(label);
      const open=document.createElement('button');open.textContent='查看待办';open.onclick=()=>clicked?.();notice.append(open);
      const dismiss=document.createElement('button');dismiss.textContent='关闭提醒';dismiss.onclick=()=>notice.remove();notice.append(dismiss);
      document.body.append(notice);if(notice.isConnected)shown();else failed();return{close:()=>notice.remove()};
    },
    onFocus:focus=>window.dispatchEvent(new CustomEvent('looma:todo-focus',{detail:focus})),
  });
  foregroundTimer=setInterval(foregroundTick,15000);foregroundTick();
}
const browserPort:Port=async c=>{
  if(c.op==='list'){
    const todos:TodoRecord[]=[];for(const space of c.space?[c.space]:['life','work']){let cursor:string|undefined;do{const page=await Repository.query<TodoRecord>(space,'todo',{limit:200,cursor});todos.push(...page.items);cursor=page.nextCursor||undefined;}while(cursor);}return {ok:true,todos};
  }
  if(c.op==='put'){
    const before=await Repository.get<TodoRecord>(c.todo.space,'todo',c.todo.id);
    if((before?.revision??null)!==c.expectedRevision)return {ok:false,error:'待办版本冲突，请重新读取。'};
    const r=await Repository.transaction(c.todo.space,[{kind:'todo',id:c.todo.id,before:before||null,after:c.todo}],{event:false});foregroundTick();return {...r,todo:c.todo};
  }
  if(c.op==='configure'){configureForeground(c.enabled);return {ok:true};}
  if(c.op==='requestPermissions'&&typeof Notification!=='undefined')await Notification.requestPermission();
  const settings=await Repository.getSettings();
  return {ok:true,background:false,notifications:typeof Notification==='undefined'?'unsupported':Notification.permission==='default'?'unknown':Notification.permission,exactAlarms:'unsupported',enabled:settings.remindersEnabled};
};
export const TodoService=createTodoService(c=>typeof window!=='undefined'&&window.electronAPI?.todoRequest?window.electronAPI.todoRequest(c):browserPort(c),{repository:Repository});
let observedEpoch=Repository.getReadIdentity().split(':')[0];
Repository.subscribe(()=>{const epoch=Repository.getReadIdentity().split(':')[0];if(epoch!==observedEpoch){observedEpoch=epoch;TodoService.refresh();}});
