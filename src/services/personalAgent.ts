import type { TodoRecord, WorkspaceMode } from '../types';
import { analyzeTodoText, taskTitle, todoRescheduleVerb, type createTodoService } from './todos';
import { resolveDeadline, shanghaiDateKey } from './dates';
import { routeLifeInput } from './lifeRouting';

export interface AgentItem { kind:'task'|'note'|'waiting'|'question'; title:string; intent:'explicit'|'suggested'; sourceQuote:string; dueAt?:string; dueDate?:string }
export interface AgentChange { todoId:string; expectedRevision:number; action:'complete'|'cancel'|'reschedule'|'rename'; sourceQuote:string; title?:string; dueAt?:string }
export interface AgentPlan { version:1; items:AgentItem[]; changes:AgentChange[]; reply?:string; requiresBusinessReview?:boolean }
export interface AgentTurn { role:string; content:string; space?:WorkspaceMode }
export interface AgentModelInput { requestId:string; text:string; space:WorkspaceMode; now:string; context:{todos:TodoRecord[];turns:{role:'user'|'assistant';content:string}[];contextTaskId?:string} }
export interface AgentCaptureInput { text:string;space:WorkspaceMode;sourceId:string;turns?:AgentTurn[];contextTaskId?:string;useModel?:boolean;expectedIdentity?:string }
export interface AgentCaptureResult {handled:boolean;created:TodoRecord[];changed:TodoRecord[];message?:string;silent?:boolean;needsChoice?:TodoRecord[];choiceAction?:'complete'|'cancel'|'time';needsReview?:boolean;modelUsed:boolean;warning?:string}
type Todos=Pick<ReturnType<typeof createTodoService>,'list'|'create'|'update'|'complete'|'cancel'|'handleText'|'configure'>;
type PlanContext={text:string;space:WorkspaceMode;todos:TodoRecord[];now:number};
const active=(t:TodoRecord)=>t.status==='pending'||t.status==='suggested';
const targetKey=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu,'');
function mentionsTarget(text:string,title:string) {
  const key=targetKey(title);
  const subject=key.replace(/^(?:交|缴|付)(?=.{2,}$)/,'').replace(/^找(?:行政|前台)(?=.{2,}$)/,'');
  if(subject.length>=2&&text.includes(subject))return true;
  const scoped=key.match(/^([a-z0-9]+店)盘点$/);
  if(scoped)return text.includes(scoped[1])&&/盘点|清点/.test(text);
  const delivery=key.match(/^(送.{2,8})去(.{2,8})$/);
  return !!delivery&&text.includes(delivery[1])&&text.includes(delivery[2]);
}
function hasUniqueTargetEvidence(text:string,todos:TodoRecord[],space:WorkspaceMode,id:string) {
  const utterance=targetKey(text);
  const matches=todos.filter(t=>t.space===space&&active(t)&&mentionsTarget(utterance,t.title));
  return matches.length===1&&matches[0].id===id;
}
const unsafeCompletion=(text:string)=>/不|没|未|别|如果|假如|以为|应该|好像|似乎|可能|是不是|是否|有没有|[?？]|(?:吗|么)[。！!\s]*$|[“”「」"]/.test(text);
function originalOnly(text:string){
  const uncertain=/以为|结果没|实际还没|举例|比如|例如|假如|如果|是不是|是否|有没有|[?？]|[“”「」"]|(?:吗|么)[。！!\s]*$/.test(text)
    || /还没|尚未|没有/.test(text)&&/别(?:当|算|标|关)|不要(?:当|算|标|关)/.test(text);
  const explicit=/(?:提醒我|提醒一下|请提醒|记住|记一下|记下|记着|添加.*(?:任务|待办)|新增.*(?:任务|待办)|(?:我|帮我|请)(?:计划|打算|准备))/.test(text)&&!/不要.*提醒|不用.*提醒|别.*提醒/.test(text);
  return uncertain&&!explicit;
}
function explicitLocalChange(context:PlanContext):AgentChange|undefined {
  const {text,todos,space,now}=context;
  // A named action category can still select one target after a multi-item turn.
  if(/^交费那(?:个|项|条)已经处理好了[。！!\s]*$/.test(text)){
    const fees=todos.filter(t=>active(t)&&t.space===space&&/^(?:交|缴纳|缴|付)(?:.{0,15}费(?:用)?|房租|租金)$/.test(targetKey(t.title)));
    if(fees.length===1)return {todoId:fees[0].id,expectedRevision:fees[0].revision,sourceQuote:text,action:'complete'};
    return;
  }
  const targets=todos.filter(t=>active(t)&&t.space===space&&mentionsTarget(targetKey(text),t.title));
  if(targets.length!==1||/[？?「」“”"]|如果|假如|举例|比如|原话|可能|好像|是不是|是否|先等等/.test(text))return;
  const target=targets[0];
  const candidate={todoId:target.id,expectedRevision:target.revision,sourceQuote:text};
  // A clock-only change must preserve the date and use the existing reminder to disambiguate the old clock.
  const shift=text.match(/把([一二三四五六七八九十\d]+点(?:半|[一二三四五六七八九十\d]+分?)?)响改成([一二三四五六七八九十\d]+点(?:半|[一二三四五六七八九十\d]+分?)?)[。！!\s]*$/);
  if(shift&&target.dueAt&&/那(?:条|项|个)/.test(text)&&!/改天|明天|后天|周[一二三四五六日天]|不改时间|不要改|别改/.test(text)){
    const original=Date.parse(target.dueAt);
    if(!Number.isFinite(original))return;
    const local=new Date(original+8*3600000);
    const day=local.toISOString().slice(0,10);
    const half=local.getUTCHours()>=12?'下午':'上午';
    const parseClock=(clock:string)=>analyzeTodoText(`提醒我核对时间${day}${half}${clock}`,{now:original-86400000,space,todos:[]}).dueAt;
    if(Date.parse(parseClock(shift[1])||'')!==original)return;
    const dueAt=parseClock(shift[2]);
    if(dueAt&&Date.parse(dueAt)>now)return {...candidate,action:'reschedule',dueAt};
    return;
  }
  const clauses=text.split(/[，,；;。\n]+/).map(s=>s.trim()).filter(Boolean);
  const directive=clauses.at(-1)||'';
  if(!unsafeCompletion(text)&&!/(?:他们|对方|同事|客户|别人|他|她)(?:说|已|刚|做|发|交|弄|把|那份|的)|快(?:要)?(?:完|好)|就差/.test(text)
      && /(?:已经|刚|总算).{0,12}(?:做完|跑完|清点完|发出去了|盖了|拿回来了)|(?:做|跑|清点)完了/.test(text)
      && /(?:那(?:条|项|件)|这(?:条|项|件)).{0,7}(?:划了|关一下|收了|勾掉|标完成|标完)/.test(directive))return {...candidate,action:'complete'};
  if(!/先缓|暂缓|先放|保持|留着|不是让|不是说|(?:别|不要|不用|不必|不能).{0,4}(?:撤|关掉|取消|删掉)/.test(text)
      && clauses.some(s=>/不.{1,12}了|不要了/.test(s))
      && clauses.some(s=>/(?:提醒|待办).{0,8}(?:撤|关掉|取消)|(?:那条|这条).{0,14}不要了/.test(s)
        && (mentionsTarget(targetKey(s),target.title)||/^(送.{2,8})去/.test(target.title)&&s.includes(target.title.split('去')[0]))))
    return {...candidate,action:'cancel'};
}
const followupRename=/^标题(?:改成|改为|换成)([^。！？!?，,；;\n]{1,100})[。！!\s]*$/;
const followupCorrection=/^不是((?:今天|明天|后天|(?:下|本|这)?周[一二三四五六日天]))[，,]\s*是(.+?)[。！!\s]*$/;
const followupTime=/^(?:就|定在|定到|改到)?\s*((?:今天|今晚|明天|明早|明晚|后天|大后天|(?:下|本|这)?(?:周|星期|礼拜)[一二三四五六日天])(?:上午|中午|下午|晚上|傍晚|早上)?[一二三四五六七八九十两\d]+(?:点(?:半|[一二三四五六七八九十两\d]+分?)?|[:：]\d{2}))(?:吧)?[。！!\s]*$/;
function contextualChange(text:string,todo:TodoRecord,now:number):AgentChange|undefined {
  const rename=text.match(followupRename);
  const base={todoId:todo.id,expectedRevision:todo.revision,sourceQuote:text};
  if(rename){
    const title=rename[1].trim();
    return title?{...base,action:'rename',title}:undefined;
  }
  const correction=text.match(followupCorrection);
  const clock=(correction?.[2]||text).match(followupTime)?.[1];
  if(!clock)return;
  if(correction){
    const old=resolveDeadline(correction[1],now).dueAt;
    if(!old||!todo.dueAt||shanghaiDateKey(Date.parse(old))!==shanghaiDateKey(Date.parse(todo.dueAt)))return;
  }else if(!todo.needsTime||todo.dueAt)return;
  const dueAt=analyzeTodoText(`提醒我核对时间${clock}`,{now,space:todo.space,todos:[]}).dueAt;
  if(dueAt)return {...base,action:'reschedule',dueAt};
}
// Extract the old title before looking up the target: the new title and the
// new time are not evidence of which existing task should be changed.
function namedWorkChange({text,todos,space,now}:PlanContext):{change?:AgentChange}|undefined {
  if(space!=='work')return;
  const command=text.trim().replace(/[。！!]+$/,'').trimEnd();
  const rename=command.match(/^(?:把)?(.+?)(?:那(?:一)?条(?:待办)?(?:的)?|(?:的)?)标题(?:改成|改为|换成)(.+)$/)
    ?? command.match(/^(?:把)?(.+?)那(?:一)?条(?:待办)?改名(?:成|为|叫)(.+)$/);
  const move=command.match(/^(?:把)?(.+?)(?:那(?:一)?条)?(?:的)?提醒(?:时间)?(?:改到|挪到|推迟到|提前到|调到)(.+?)(?:提醒)?$/);
  const cancel=command.match(/^(?:(?:别|不要|不用|先别|暂时)?(?:帮我|请)?)?(?:取消(?:掉)?(.+?)的提醒|把(.+?)(?:那(?:一)?条)?的?提醒(?:取消(?:掉)?|撤掉|删掉|关掉)|(.+?)不用(?:再)?提醒(?:我)?了)$/);
  const complete=command.match(/^(?:把)?(.+?)(?:那(?:一)?条)?(?:已经)?(?:完成了|做完了|搞定了|弄完了|处理好了|办好了|标(?:为|成)?完成|勾掉)$/);
  const subject=(rename?.[1]??move?.[1]??cancel?.[1]??cancel?.[2]??cancel?.[3]??complete?.[1])?.trim();
  if(!subject)return;
  if(/[，,；;。\n？?「」“”"]|如果|假如|要是|举例|比如|原话|可能|好像/.test(command)||
     /^(?:别|不要|不用|先别|暂时)/.test(command)||
     /^(?:(?:客户|同事|对方|别人|他们|她们|他|她)(?:说|已经|刚)|(?:别|不要|不用|暂时))/.test(subject)||
     /(?:还没|没|未|不|别|等到|快要)$/.test(subject))return {};
  const key=(title:string)=>title.trim().normalize('NFKC').toLowerCase();
  const targets=todos.filter(t=>t.space===space&&active(t)&&key(t.title)===key(subject));
  if(targets.length!==1)return {};
  const target=targets[0];
  const base={todoId:target.id,expectedRevision:target.revision,sourceQuote:text};
  if(rename){
    const title=rename[2].trim();
    return title&&title.length<=100&&!/顺便|然后再|并且|另外/.test(title)?{change:{...base,action:'rename',title}}:{};
  }
  if(move){
    const clock=move[2].trim().match(followupTime)?.[1];
    const dueAt=clock&&analyzeTodoText(`提醒我核对时间${clock}`,{now,space,todos:[]}).dueAt;
    return dueAt?{change:{...base,action:'reschedule',dueAt}}:{};
  }
  return {change:{...base,action:cancel?'cancel':'complete'}};
}
const qualifierClause=/^(?:(?:都|先|暂时|统统|全都)?(?:不设|不用设|不需要设|暂不设|别设|不要设)(?:置)?(?:时间|提醒|闹钟)|(?:都)?先记着|(?:先|暂时)?(?:不用|不要|别)(?:设)?(?:提醒|闹钟|时间)|(?:现在|今天|这会儿)?没空(?:弄|处理|做)?|(?:具体)?(?:几点|哪天|哪一天|时间|日期).*(?:再说|没定|没想好|再定|待定)|(?:请|帮我|先|给我)?记(?:一下|下来|下|着|住|上|一笔)(?:两件事|二件事|几件事)?)[。！!：:\s]*$/;
const clausesOf=(text:string)=>text.split(/[，,；;\n。]|然后|还要|以及|顺便|和|再(?!说|定|补|议|看)/).map(s=>s.trim()).filter(Boolean);
const captureClauses=(text:string)=>clausesOf(text).filter(s=>!/如果|假如|不对|不用|不必|不要|别|不是|(?:家里|手头|店里)还有|算了|实际|已经|已发|发了|交了|累|不想|开心|烦/.test(s)
  && !qualifierClause.test(s) && taskTitle(s)!=='');
const actionStartVerb=/^(?:交|买|联系|发|办理|整理|提交|检查|对|校对|核对|复核|确认|汇总|打印|复印|预约|领取|跟进|催|问|拿|取|寄|修|改|写|做|准备|更新|盘点|清点|归档|备份|导出|上传|下载|同步|安排|沟通|对接|回访|开票|报销|预订|续费|盖章|审阅|审核|测试|部署|采购|补齐|补交|给.{1,10}发)/;
function localMultiTasks(text:string,space:WorkspaceMode,nowMs:number,initial:TodoRecord[]):{title:string;dueAt?:string;dueDate?:string}[]|undefined {
  const clean=text.trim();
  const hasCaptureStart=/^(?:请|帮我|给我|先)?记(?:一下|下来|下|着|住|上|一笔|(?:两|二|2|几)(?:件事|个待办|条待办))|^(?:请|帮我|给我|先)?把.+?(?:这两件事|两件事|二件事|这几件事|几件事)?(?:先|都)?记(?:一下|下来|下|着|住|上|一笔)|^(?:请|帮我|给我)?(?:添加|新增|记|加)(?:两|二|2|几)(?:个|条)?(?:待办|任务)/.test(clean);
  const hasReminderStart=/^(?:请|帮我|给我|记得)?(?:提醒我|提醒一下|请提醒)/.test(clean);
  if(!hasCaptureStart&&!hasReminderStart)return;
  const body=clean
    .replace(/^(?:请|帮我|给我|先)?(?:记(?:一下|下来|下|着|住|上|一笔)?|添加|新增)(?:两|二|2|几)(?:件事|个待办|条待办|个任务|条任务)[：:，,\s]*/,'')
    .replace(/^(?:请|帮我|给我|先)?把(.+?)(?:这两件事|两件事|二件事|这几件事|几件事|这件事)?(?:先|都)?记(?:一下|下来|下|着|住|上|一笔)/,'$1');
  const rawSplit=body.split(/[，,；;\n。]|然后|还要|以及|顺便|再(?!说|定|补|议|看)/).map(s=>s.trim()).filter(s=>s&&!qualifierClause.test(s));
  const raw=rawSplit.flatMap(clause=>{
    const stripped=clause.replace(/^(?:请|帮我|给我|先)?记(?:一下|下来|下|着|住|上|一笔)\s*/,'').trim();
    const parts=stripped.split(/(?:和|、)/).map(s=>s.trim()).filter(Boolean);
    return parts.length===2&&parts.every(p=>actionStartVerb.test(p))?parts:[clause];
  });
  const cancelled:string[]=[];
  const kept:string[]=[];
  for(const clause of raw){
    const cancelMatch=clause.match(/^(?:哦|啊|对了)?(.{1,12}?)(?:(?:家里|手头|店里)还有|(?:不用|不要|别)(?:记|买|交|发|办|弄)了)[。！!\s]*$/);
    if(cancelMatch){
      const key=cancelMatch[1].replace(/^(?:哦|啊|对了|那个|这个)+/,'').trim();
      if(key)cancelled.push(key);
      continue;
    }
    kept.push(clause);
  }
  const items=kept.filter(c=>!cancelled.some(k=>k&&c.includes(k)));
  if(!items.length||(items.length===1&&!cancelled.length))return;
  if(items.some(c=>/如果|假如|不对|不用|不必|不要|别|不是|算了|实际|已经|已发|发了|交了|累|不想|开心|烦/.test(c)))return;
  if(!hasCaptureStart&&items.slice(1).some(c=>!/^(?:还有|另外|顺便|以及|并且|同时|再|请|帮我|给我|记得|提醒|记(?:一下|下来|下|着|住|上|一笔))/.test(c)))return;
  const forceNoTime=/(?:都|先|暂时|统统|全都)?(?:不设|不用设|不需要设|暂不设|别设|不要设)(?:置)?(?:时间|提醒|闹钟)|(?:都)?先记着|(?:先|暂时)?(?:不用|不要|别)(?:设)?(?:提醒|闹钟|时间)/.test(clean);
  const parsedItems:{title:string;dueAt?:string;dueDate?:string}[]=[];
  for(const item of items){
    const stripped=item.replace(/^(?:还有|另外|顺便|以及|并且|同时|然后再|然后|再)\s*/,'').trim();
    const probe=/^(?:请|帮我|给我|先|记得)?(?:提醒|记(?:一下|下来|下|着|住|上|一笔)|(?:添加|新增|记|加).*(?:待办|任务))/.test(stripped)?stripped:`帮我记一下${stripped}`;
    const parsed=analyzeTodoText(probe,{now:nowMs,space,todos:initial});
    if(parsed.kind!=='create'||!parsed.title)return;
    parsedItems.push({title:parsed.title,dueAt:forceNoTime?undefined:parsed.dueAt,dueDate:forceNoTime?undefined:parsed.dueDate});
  }
  return parsedItems.length?parsedItems:undefined;
}
function isBusinessAction(quote:string){
  if(/提醒|记(?:一下|下|着|住)|添加.*(?:待办|任务)/.test(quote))return true;
  if(/(?:客户|陈总|老板|他|她).*(?:说|确认|承诺|会|将|已经)/.test(quote))return false;
  return /买|发(?:送|给|合同|邮件|报价)|交(?:费|电费|水费|材料|合同)|提交|办理|整理|联系|检查|打电话|预约|打印|复印|领取|核对|跟进|催|问/.test(quote);
}
function keys(value:any,allowed:string[]) { if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('模型候选包含无效字段'); }
function bounded(value:unknown,max:number):asserts value is string {if(typeof value!=='string'||!value.trim()||value.length>max)throw Error('模型候选文字无效');}
function validateTime(item:{dueAt?:string;dueDate?:string;sourceQuote:string},context:PlanContext,rescheduling=false) {
  if(item.dueAt===undefined&&item.dueDate===undefined)return;
  // The synthetic reminder only parses the requested new time, not the move command or old time.
  const verb=rescheduling?todoRescheduleVerb.exec(item.sourceQuote):null;
  const timeQuote=verb?item.sourceQuote.slice(verb.index+verb[0].length):item.sourceQuote;
  const evidence=analyzeTodoText(`提醒我核对时间${timeQuote.replace(/吧[。！!\s]*$/,'')}`,{...context,todos:[]});
  if(item.dueAt!==undefined){
    if(typeof item.dueAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(item.dueAt)||!Number.isFinite(Date.parse(item.dueAt))||Date.parse(item.dueAt)<=context.now||!evidence.dueAt||Date.parse(evidence.dueAt)!==Date.parse(item.dueAt))throw Error('提醒时间缺少可验证原文依据');
  }
  if(item.dueDate!==undefined && (typeof item.dueDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)||item.dueDate!==evidence.dueDate))throw Error('日期缺少可验证原文依据');
}
/** Treat a model plan as untrusted data; validate the entire plan before any write. */
export function parseAgentPlan(raw:string,context:PlanContext):AgentPlan {
  if(typeof raw!=='string'||raw.length>40000)throw Error('模型结果格式无效');
  const p=JSON.parse(raw);keys(p,['version','items','changes','reply','requiresBusinessReview']);
  if(p.version!==1||!Array.isArray(p.items)||p.items.length>20||!Array.isArray(p.changes)||p.changes.length>20)throw Error('模型计划版本或数量无效');
  if(p.reply!==undefined)bounded(p.reply,2000);
  if(p.requiresBusinessReview!==undefined&&typeof p.requiresBusinessReview!=='boolean')throw Error('核对标记无效');
  const quote=(x:any)=>{bounded(x.sourceQuote,10000);if(!context.text.includes(x.sourceQuote))throw Error('来源不在本轮原文中');};
  for(const item of p.items){
    keys(item,['kind','title','intent','sourceQuote','dueAt','dueDate']);bounded(item.title,500);quote(item);
    if(!['task','note','waiting','question'].includes(item.kind)||!['explicit','suggested'].includes(item.intent))throw Error('事项类型无效');
    validateTime(item,context);
  }
  const ids=new Set<string>();
  for(const change of p.changes){
    keys(change,['todoId','expectedRevision','action','sourceQuote','title','dueAt']);quote(change);bounded(change.todoId,200);
    const target=context.todos.find(t=>t.id===change.todoId&&t.space===context.space);
    if(!target||!active(target)||!Number.isInteger(change.expectedRevision)||target.revision!==change.expectedRevision||ids.has(change.todoId))throw Error('目标不存在或版本已变化');
    ids.add(change.todoId);
    if(!['complete','cancel','reschedule','rename'].includes(change.action))throw Error('变更动作无效');
    if(change.action==='complete'&&(unsafeCompletion(context.text)||!/交了|付了|发了|做完|完成|搞定|办好|好了|已处理|已发|付清/.test(change.sourceQuote)))throw Error('未确认的完成意图');
    if(change.action==='cancel'&&(!/取消|不用|不需要|不做了/.test(change.sourceQuote)||/不是不做|先放|暂时|这周/.test(context.text)))throw Error('未确认的取消意图');
    if(change.action==='rename'){bounded(change.title,500);if(!change.sourceQuote.includes(change.title))throw Error('新标题缺少原文依据');}
    else if(change.title!==undefined)throw Error('动作不允许标题字段');
    if(change.action==='reschedule'){if(!change.dueAt)throw Error('改期缺少准确时间');validateTime(change,context,true);}
    else if(change.dueAt!==undefined)throw Error('动作不允许时间字段');
  }
  return p;
}

export function createPersonalAgent(options:{todos:Todos;repository?:{getReadIdentity?:()=>string;isRestoring?:()=>boolean};model?:(input:AgentModelInput)=>Promise<{content:string}>;now?:()=>number;readIdentity?:()=>string}) {
  const {todos}=options,now=options.now||Date.now;
  const identity=()=>options.readIdentity?.()??options.repository?.getReadIdentity?.().split(':')[0]??'';
  const completed=new Map<string,AgentCaptureResult>();
  let previousTarget:{identity:string;space:WorkspaceMode;id:string;revision:number}|undefined;
  const frozenPlans=new Map<string,{text:string;raw:string}>();let queue:Promise<unknown>=Promise.resolve();
  function assertCurrent(expected:string){if(options.repository?.isRestoring?.()||identity()!==expected)throw Error('资料已变化，原文已保留，请按当前事项重新核对。');}
  async function capture(input:AgentCaptureInput):Promise<AgentCaptureResult>{
    const businessRisk=input.space==='work'&&/预算|承诺|成交|签约|阶段|需求确认|进入(?:了)?(?:商务谈判|砍价)|正在谈判|在谈合同|在聊商务|(?:报价单|方案)(?:已经|已|刚)?发(?:过去|给客户)|已报价|已发方案|需求(?:已经|已)?(?:聊清楚|对完了|对齐了)|已回款|已打款|尾款(?:已)?(?:到账|打过来了|结清)|(?:\d+|[一二两三四五六七八九十百千万]+)(?:万|元)|[一二两三四五六七八九十]+万[一二两三四五六七八九]|(?:说|答应|表示|承诺|反馈).*(?:会把|将会|将把|给.*项目|把.*确认函|把.*合同|把.*附件|补齐|提供|发给|回传|给答复|给回复|给反馈|给我们|给咱们|打预付款|打款|付款)|(?:客户|对方|甲方|他|她|他们).*(?:补齐|补充|补交|提供|回传|发过来|发给我们|给我们|给答复|给反馈)|(?:等|待|等到|收到).*(?:后|之后|以后)|条件(?:改成|改到|改为|调整为|换成|先暂停|暂停|取消|恢复|继续观察|已满足|已经满足)|不用等.*取消|先不用催|不用催|(?:咱们|我们|我这边|我先)(?:先不动|按兵不动|先等|等着|记一笔等着)|(?:报价|费用|运费|税点|税率|几个点|发票|专票|普票|条款|周期|工期|标准|方案|接口|归属|责任人|账期|尾款|预付款).*(?:含不含|包不包|算不算|还没定|没定|未定|待定|没确定|没确认|尚未确认|待确认|还没敲定|还没聊透|没聊透|还没谈拢|没谈拢|还没谈妥|没谈妥|还没说定|没说定|还没定下来|没定下来)/.test(input.text);
    const result:AgentCaptureResult={handled:false,created:[],changed:[],modelUsed:false,needsReview:businessRisk};
    const expected=input.expectedIdentity??identity(),key=`${expected}:${input.space}:${input.sourceId}`;
    const cached=completed.get(key);if(cached)return {...cached,created:[...cached.created],changed:[]};
    const focus=previousTarget;previousTarget=undefined;
    const remember=()=>{
      completed.set(key,result);
      const writes=[...result.created,...result.changed];
      if(!result.warning&&!result.needsChoice&&writes.length===1&&active(writes[0]))
        previousTarget={identity:expected,space:input.space,id:writes[0].id,revision:writes[0].revision};
      return result;
    };
    try{
      bounded(input.sourceId,170);bounded(input.text,20000);assertCurrent(expected);
      // Interpret uncertainty over the whole original, never a model-selected positive fragment.
      if(originalOnly(input.text)){result.handled=true;result.message='原文已保存。';return remember();}
      const initial=await todos.list(input.space,true);assertCurrent(expected);
      const text=input.text.trim();
      const followup=followupRename.test(text)||followupCorrection.test(text)||followupTime.test(text);
      const focused=focus?.identity===expected&&focus.space===input.space
        ? initial.find(t=>t.id===focus.id&&t.revision===focus.revision&&t.space===input.space&&active(t)) : undefined;
      const localContext={text:input.text,todos:initial,space:input.space,now:now()};
      const contextual=followup&&focused?contextualChange(text,focused,now()):undefined;
      // Do not reinterpret an unresolved referential instruction as a new todo.
      if(followup&&(!contextual||businessRisk)){
        result.handled=true;result.warning='未确认上一条待办或新时间，原文已保留。';return remember();
      }
      const named=!businessRisk?namedWorkChange(localContext):undefined;
      if(named&&!named.change){
        result.handled=true;result.warning='未能唯一确认待办或新时间，原文已保留。';return remember();
      }
      const direct=contextual??named?.change??explicitLocalChange(localContext);
      if(direct&&!businessRisk){
        const verified=(records:TodoRecord[])=>{
          if(contextual)return records.some(t=>t.id===focused!.id&&t.revision===focused!.revision&&t.space===input.space&&active(t));
          const currentContext={...localContext,todos:records,now:now()};
          const change=named?namedWorkChange(currentContext)?.change:explicitLocalChange(currentContext);
          return change?.todoId===direct.todoId&&change.action===direct.action&&change.dueAt===direct.dueAt;
        };
        const current=await todos.list(input.space,true);assertCurrent(expected);
        const target=current.find(t=>t.id===direct.todoId&&t.revision===direct.expectedRevision&&t.space===input.space&&active(t));
        if(!target||!verified(current))throw Error('待办目标或版本已变化');
        let changed:TodoRecord;
        if(direct.action==='complete')changed=await todos.complete(target);
        else if(direct.action==='cancel')changed=await todos.cancel(target);
        else if(direct.action==='rename')changed=await todos.update(target,{title:direct.title});
        else {
          await todos.configure(true);assertCurrent(expected);
          const latest=await todos.list(input.space,true);assertCurrent(expected);
          if(!latest.some(t=>t.id===target.id&&t.revision===target.revision&&active(t))||!verified(latest))throw Error('待办目标或版本已变化');
          changed=await todos.update(target,{dueAt:direct.dueAt,dueDate:shanghaiDateKey(Date.parse(direct.dueAt!)),needsTime:false,
            sourceText:`${target.sourceText||''}\n原事项：${target.title} · ${target.dueAt}\n变更原文：${input.text}`});
        }
        result.changed.push(changed);result.handled=true;result.silent=direct.action==='complete';return remember();
      }
      const prefix=`agent-${input.sourceId}-`;
      const contextTaskId=focused?.id;
      const routes=input.space==='life'?routeLifeInput(text):[];
      if (routes.some(part=>part.route==='fact')&&!routes.some(part=>part.route==='action')) {
        return result;
      }
      const analysis=analyzeTodoText(input.text,{now:now(),space:input.space,todos:initial,contextTaskId});
      const rawClauses=clausesOf(input.text);
      const actionClauses=captureClauses(input.text);
      const complex=rawClauses.length>1||/[，,；;\n。].*\S|预算|承诺|刚才|那个|这个|之前|不是|实际|不对|改成|改到/.test(input.text)||businessRisk;
      const boundedCreate=!businessRisk&&analysis.kind==='create'&&actionClauses.length===1
        &&rawClauses.filter(s=>!qualifierClause.test(s)&&taskTitle(s)!=='').length===1
        &&(input.space!=='life'||(routes.length===1&&routes[0].route==='action'));
      const fast=(!complex||boundedCreate)&&analysis.kind!=='none';
      // The existing local interpreter remains the deterministic fallback for simple commands only.
      const local=async()=>{
        assertCurrent(expected);
        if(analysis.kind==='create'||analysis.kind==='suggest'){
          const existing=initial.find(t=>t.id===`${prefix}0`);
          if(existing){result.handled=true;result.created.push(existing);return;}
          if(analysis.kind==='create'&&analysis.dueAt){await todos.configure(true);assertCurrent(expected);}
          const created=await todos.create({id:`${prefix}0`,space:input.space,title:analysis.title!,status:analysis.kind==='create'?'pending':'suggested',dueAt:analysis.dueAt,dueDate:analysis.dueDate,needsTime:!analysis.dueAt,sourceText:input.text});
          result.created.push(created);result.handled=true;
          if(!created.dueAt)result.message='已记下，时间可以以后再补。';
        }else{
          const r=await todos.handleText(input.text,input.space,contextTaskId);Object.assign(result,{handled:r.handled,silent:r.silent,message:r.message,needsChoice:r.needsChoice,choiceAction:r.choiceAction});
          if(r.created)result.created.push(r.created);
          const after=await todos.list(input.space,true);result.changed=after.filter(t=>initial.some(old=>old.id===t.id&&old.revision!==t.revision));
        }
      };
      if(fast){await local();return remember();}
      if(!options.model||input.useModel===false){
        if(!complex){await local();return remember();}
        if(businessRisk){
          const explicitReminders=input.text.split(/[，,；;\n。]/).map(s=>s.trim().replace(/^(?:另外|还有|顺便|同时|并且|以及|然后)\s*/,'')).filter(s=>/(?:请|帮我|给我|记得)?(?:提醒我|提醒一下|请提醒)/.test(s)&&!/不(?:用|要|需要).*提醒|别.*提醒/.test(s));
          for(const [i,clause] of explicitReminders.entries()){
            assertCurrent(expected);
            const parsed=analyzeTodoText(clause,{now:now(),space:input.space,todos:initial});
            if(parsed.kind!=='create'||!parsed.title)continue;
            const existing=initial.find(t=>t.id===`${prefix}${i}`);
            if(existing){result.created.push(existing);continue;}
            if(parsed.dueAt){await todos.configure(true);assertCurrent(expected);}
            const created=await todos.create({id:`${prefix}${i}`,space:input.space,title:parsed.title,status:'pending',dueAt:parsed.dueAt,dueDate:parsed.dueDate,needsTime:!parsed.dueAt,sourceText:input.text});
            result.created.push(created);
          }
          if(result.created.length){result.handled=true;result.message='已记下，原文已保存。';}
          return remember();
        }
        const multi=localMultiTasks(input.text,input.space,now(),initial);
        if(multi){
          for(const [i,item] of multi.entries()){
            assertCurrent(expected);
            const existing=initial.find(t=>t.id===`${prefix}${i}`);
            if(existing){result.created.push(existing);continue;}
            if(item.dueAt){await todos.configure(true);assertCurrent(expected);}
            const created=await todos.create({id:`${prefix}${i}`,space:input.space,title:item.title,status:'pending',dueAt:item.dueAt,dueDate:item.dueDate,needsTime:!item.dueAt,sourceText:input.text});
            result.created.push(created);
          }
          result.handled=true;
          result.message=result.created.some(t=>!t.dueAt)?'已记下，时间可以以后再补。':'已记下，原文已保存。';
          return remember();
        }
        result.warning='原文已保留，复杂内容稍后整理。';return result;
      }
      result.modelUsed=true;
      let p:AgentPlan;
      let raw:string;
      let missingCoverage=false;
      try{
        const contextTodos=initial.filter(t=>t.space===input.space).slice(0,80);
        const turns=(input.turns||[]).filter(t=>(!t.space||t.space===input.space)&&(t.role==='user'||t.role==='assistant')).slice(-6).map(t=>({role:t.role as 'user'|'assistant',content:t.content}));
        const frozen=frozenPlans.get(key);
        result.modelUsed=!frozen;
        if(frozen&&frozen.text!==input.text)throw Error('同一来源原文已变化');
        raw=frozen?.raw??(await options.model({requestId:input.sourceId,text:input.text,space:input.space,now:new Date(now()).toISOString(),context:{todos:contextTodos,turns,contextTaskId}})).content;
        assertCurrent(expected);
        const latest=await todos.list(input.space,true);assertCurrent(expected);
        // Validate against both the offered snapshot and the actual current state.
        p=parseAgentPlan(raw,{text:input.text,space:input.space,todos:contextTodos,now:now()});
        parseAgentPlan(raw,{text:input.text,space:input.space,todos:latest,now:now()});
        if(p.changes.length===1&&!hasUniqueTargetEvidence(input.text,latest,input.space,p.changes[0].todoId))
          throw Error('原文未指向唯一待办');
        const actionClauses=captureClauses(input.text);
        const quotes=[...p.items,...p.changes].map(x=>x.sourceQuote);
        missingCoverage=actionClauses.length>1&&actionClauses.some(clause=>!quotes.some(q=>q.includes(clause)||clause.includes(q)));
        // A partial write must resume the exact validated ordering, not ask a model to reinvent IDs.
        if(!missingCoverage)frozenPlans.set(key,{text:input.text,raw});
      }catch(error){
        assertCurrent(expected);
        if(!complex)await local();
        result.warning='原文已保留，自动整理暂未完成。';return result;
      }
      result.needsReview=businessRisk||!!p.requiresBusinessReview;
      if(p.changes.length>1){
        result.handled=true;
        const action=p.changes[0].action;
        if(!p.changes.every(c=>c.action===action)||(action!=='complete'&&action!=='cancel')){result.warning='原文已保留，不同类型的变更需要分别核对，本次未执行。';return result;}
        result.needsChoice=initial.filter(t=>p.changes.some(c=>c.todoId===t.id));result.choiceAction=action;
        result.message='请先选择具体一条事项。';return remember();
      }
      const statusFor=(item:AgentItem)=>item.intent==='explicit'&&!(/明天|后天|今天|周[一二三四五六日天]|打算|准备|计划|可能/.test(item.sourceQuote)&&!/提醒|记(?:一下|下|着|住)|待办|任务/.test(input.text))?'pending':'suggested';
      for(const existing of initial.filter(t=>t.id.startsWith(prefix))){
        const i=Number(existing.id.slice(prefix.length)),item=p.items[i];
        if(!item||item.kind!=='task'||existing.title!==item.title||existing.sourceText!==input.text||existing.dueAt!==item.dueAt||existing.dueDate!==item.dueDate)throw Error('已保存事项与本次候选不一致');
      }
      for(const [i,item] of p.items.entries()){
        if(item.kind!=='task')continue;
        if(businessRisk&&!isBusinessAction(item.sourceQuote))continue;
        assertCurrent(expected);
        const existing=initial.find(t=>t.id===`${prefix}${i}`);if(existing){result.created.push(existing);continue;}
        const status=statusFor(item);
        if(status==='pending'&&item.dueAt){await todos.configure(true);assertCurrent(expected);}
        const created=await todos.create({id:`${prefix}${i}`,space:input.space,title:item.title,status,dueAt:item.dueAt,dueDate:item.dueDate,needsTime:!item.dueAt,sourceText:input.text});result.created.push(created);
      }
      for(const change of p.changes){
        assertCurrent(expected);const current=await todos.list(input.space,true);assertCurrent(expected);
        if(!hasUniqueTargetEvidence(input.text,current,input.space,change.todoId))throw Error('待办目标已不明确');
        const target=current.find(t=>t.id===change.todoId&&t.space===input.space&&t.revision===change.expectedRevision&&active(t));if(!target)throw Error('事项版本已变化');
        let changed:TodoRecord;
        if(change.action==='complete')changed=await todos.complete(target);
        else if(change.action==='cancel')changed=await todos.cancel(target);
        else{
          const history=`${target.sourceText||''}\n原事项：${target.title}${target.dueAt?` · ${target.dueAt}`:''}\n变更原文：${input.text}`;
          if(change.action==='reschedule'){await todos.configure(true);assertCurrent(expected);}
          changed=await todos.update(target,change.action==='rename'?{title:change.title,sourceText:history}:{dueAt:change.dueAt,needsTime:false,sourceText:history});
        }
        result.changed.push(changed);
      }
      result.handled=!!(p.items.length||p.changes.length||p.reply||p.requiresBusinessReview);
      result.silent=p.changes.length===1&&p.changes[0].action==='complete'&&!p.items.length;
      if(!result.silent)result.message=result.created.length?'已记下，原文已保存。':result.needsReview?'原文已保存，重要业务信息仍需核对。':'原文已保存。';
      if(missingCoverage){result.warning='原文已保留，部分行动尚未整理完整，可稍后继续整理。';return result;}
      return remember();
    }catch(error){result.handled=true;result.warning=result.created.length||result.changed.length?'原文及部分事项已保存，其余整理未完成，无需重复输入。':'原文已保留，本次整理未执行。';return result;}
  }
  return {
    capture(input:AgentCaptureInput){const run=queue.then(()=>capture(input));queue=run.catch(()=>{});return run;},
    clearFocus(space:WorkspaceMode){if(previousTarget?.space===space)previousTarget=undefined;},
  };
}
