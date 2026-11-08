import type {
  WorkspaceMode, StateMutationReceipt, ProposedChangeSet, WorkPartition, LifePartition, WorkOperation,
  Engagement, ProjectTaskItem, DealStage, ExpenseEntry, FollowUpItem, ConditionIntent,
} from '../types';
import { StorageService, newId, validateProposal } from './storage';
import { resolveDeadline, shanghaiDateKey } from './dates';
import { routeLifeInput } from './lifeRouting';
import { evaluateFollowUpTransition, reviseConditionIntent, transitionConditionIntent } from './conditionIntents';
import { validateTransaction } from '../../shared/persistence-core.mjs';

interface ProposalContext {
  mode: WorkspaceMode;
  sourceMessageId: string;
  partition: WorkPartition | LifePartition;
  now?: number;
  selectedEngagementId?: string;
  newClientName?: string;
  newProjectTitle?: string;
}
const DATE = '(?:\\d{4}[年\\-/]\\d{1,2}[月\\-/]\\d{1,2}[日号]?|\\d{1,2}月\\d{1,2}[日号]?|(?:下周|本周|这周|周|下星期|本星期|这星期|星期|下礼拜|本礼拜|这礼拜|礼拜)[一二三四五六日天]|大后天|后天|明天|明早|明晚|今天|今晚|今日|下个?月底|月底|下个?月初|月初|月中|\\d{1,2}天(?:后|之后|内)|\\d{1,2}号)';
const CLOCK = '(?:\\s*(?:上午|下午|晚上)?\\s*\\d{1,2}(?:[:：]\\d{2}|点(?:半|\\d{1,2}分?)?))?';
const NEGATIVE = /还没|尚未|未能|没有|不是|并非|未进入|不曾|未成交|未签|没签|没成交|未打款/;
const HYPOTHETICAL = /如果|假如|假设|倘若|可能|或许|也许|预计|有望/;
const CLIENT = /(?:[\u4e00-\u9fa5A-Za-z0-9]{1,12}?(?:工作室|科技|公司|集团|中心|研究院|研究所|事务所|医院|学校|大学|学院|银行|设计院))?[\u4e00-\u9fa5A-Za-z0-9]{1,5}?(?:总监|经理|主理人|老板|主任|院长|行长|会长|厂长|店长|处长|局长|科长|书记|教授|博士|老师|律师|顾问|合伙人|师傅|女士|先生|总|工|姐|哥|叔|姨|董)|[\u4e00-\u9fa5A-Za-z0-9]{1,12}?(?:工作室|科技|公司|集团|中心|研究院|研究所|事务所|设计院)/g;
const stripClientPrefix = (text: string) => {
  let clean = text.replace(/^(?:(?:如果|假如|假设|今天|刚刚|刚才|另外|还有|新增客户|客户|新增|记一下|刚见完|刚见了|刚跟|刚和|刚才跟|拜访了|见了|跟|和|给|找|收到|把))+/, '').trim();
  if (!/(?:工作室|科技|公司|集团|中心|研究院|研究所|事务所|医院|学校|大学|学院|银行|设计院)/.test(clean)) {
    clean = clean.replace(/^.*?(?:发给|交给|补给|提供给|回传给|寄给|传给|送给|转给|报给|汇给|打给|留给|汇报给|转告|通知|联系|提醒|告诉|请示|询问|配合|协助|拜访|约见|见了|见一下|找一下|问一下|等|叫|让|请|给|向|找|跟|和|与|同|对|由|把|是|的|了|去|要|得|在|从|到)/, '').trim();
  }
  return clean;
};

const UNCERTAIN = '还没确认|尚未确认|未确认|没有确认|待确认|还没确定|尚未确定|未确定|没有确定|还没定|尚未定|未定|没定|待定|暂定|先别定|还没拍板|尚未拍板|未拍板|还没敲定|尚未敲定|可能|或许|也许|大概|左右';
function uncertaintyNear(text: string, subject: string): boolean {
  // Commas delimit independent facts: “还没成交，已确认预算” is not an uncertain budget.
  return text.split(/[，,；;。\n]/).some(clause =>
    new RegExp(`(?:${subject})[^，,；;。]{0,14}(?:${UNCERTAIN})|(?:${UNCERTAIN})[^，,；;。]{0,8}(?:${subject})`).test(clause));
}
export function budgetIsUncertain(text: string): boolean {
  return uncertaintyNear(text, '预算|金额|报价|合同额|总价|费用')
    || /(?:预算|金额|报价|合同额|总价)\s*(?:约|大概|不是|并非)/.test(text)
    || /(?:不是|并非)\s*[¥￥]?\s*(?:\d+(?:\.\d+)?|[一二两三四五六七八九十百千万]+)\s*(?:万元|万块|万|千元|千|块钱|块|元|w|k)?\s*(?:的)?(?:预算|金额|报价|合同额|总价)/i.test(text)
    || /不要当真|别当真|不作数|不算数/.test(text);
}
export function dateIsUncertain(text: string): boolean {
  return uncertaintyNear(text, '时间|日期|时刻|期限|截止|交付时间') || /(?:暂定|可能|或许|也许)\s*(?:明天|后天|大后天|今天|下?周|本周|下?星期|下?礼拜|月底|月初|\d{1,2}月|\d{4}年)/.test(text);
}

function findClients(text: string): { name: string; start: number }[] {
  return Array.from(text.matchAll(new RegExp(CLIENT.source, 'g'))).map(match => ({ name: stripClientPrefix(match[0]), start: match.index! }))
    .filter(item => item.name && !['预算', '总计', '总共', '合同', '总金额', '汇总'].includes(item.name));
}
export const extractClientNames = (text: string): string[] => [...new Set(findClients(text).map(item => item.name))];
const RESPONSIBILITY_UNCERTAIN = /(?:负责人|责任人|谁来|谁负责|归属|由谁).{0,10}(?:未定|待定|没确定|没确认|不明确)|(?:未定|待定|没确定|没确认).{0,8}(?:负责人|责任人)/;
const ACTION = '完成|提交|交付|发送|补充|提供|回传|准备|确认|回复|跟进|联系|拜访|联调|汇报|演示|对齐|评审|修改|调整|优化|上线|部署|测试|验收|沟通|约见|打款|付款|回款|转账|结款|开票|寄出|寄过来|发过来|盖章|走流程|过会|拍板|定下来|批下来|答复|通知|整理|输出|补齐|补交|补|给|发|交|签|出|改|做|写|催|约';
const HAS_CLOCK = /\d{1,2}(?:[:：]\d{2}|点(?:半|\d{1,2}分?)?)/;
const GENERIC_REF = /^(?:那条|这条|那个|这个|刚才那条|刚才那个|之前那条|之前那个|上面那条)?(?:跟进)?(?:行动|待办|事项|任务|安排|时间|期限|截止时间)?$/;

function normalizeItemCore(text: string): { core: string; object: string } {
  const clean = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s，,。；;！!？?：:“”"‘’'「」『』（）()【】\[\]《》<>·]/g, '')
    .replace(/^(?:我方|我们|咱们|我|乙方|客户|对方|甲方|他|她|他们|她们|说|表示|答应|承诺|反馈|把|将|去|先|再|要|需要|必须|得|负责|会|请|帮我|给我)+/, '')
    .replace(/^(?:给|向|找|跟|和)(?:客户|对方|甲方|我们|我方|咱们|我)/, '')
    .replace(/(?:给|发给|交给|补给|提供给|回传给)(?:客户|对方|甲方|我们|我方|咱们|我)$/, '')
    .replace(/(?:那件事|这件事|那条待办|这条待办|那条行动|这条行动|那条事项|这条事项|那条|这条|那个|这个|一下|的事|的事情|的时间|的期限|的截止时间|的安排)+$/, '');
  const core = clean
    .replace(/^(?:发送|发给|发出|发过去)/, '发')
    .replace(/^(?:补充|补齐|补交|补上|补给)/, '补')
    .replace(/^(?:提交|交付|交给|交上)/, '交')
    .replace(/^(?:提供给|提供)/, '提供')
    .replace(/^(?:修改|调整|优化|改动)/, '改');
  const object = core
    .replace(new RegExp(`^(?:${ACTION})`), '')
    .replace(/(?:发过来|发来|寄过来|传过来|回传|补齐|补交|整理好|整理|发过去|发出去了|发出|做好|做完|完成|搞定|处理好|收到了|收到|已收到|已补齐|已解决|了)+$/, '');
  return { core, object };
}

function itemMatchesTitle(existingTitle: string, candidateTitle: string): boolean {
  const a = normalizeItemCore(existingTitle);
  const b = normalizeItemCore(candidateTitle);
  if (!a.core || !b.core) return false;
  if (a.core === b.core) return true;
  if (a.core.length >= 2 && b.core.length >= 2 && (a.core.includes(b.core) || b.core.includes(a.core))) return true;
  if (a.object.length >= 2 && b.object.length >= 2) {
    if (a.object === b.object) return true;
    if (a.object.includes(b.object) || b.object.includes(a.object)) return true;
  }
  if (a.object.length >= 2 && (a.object === b.core || b.core.includes(a.object) || a.object.includes(b.core))) return true;
  return false;
}

function parseUnitMultiplier(unitRaw: string, hasPrefixSymbol: boolean): number | undefined {
  const unit = (unitRaw || '').toLowerCase();
  if (!unit && !hasPrefixSymbol) return undefined;
  if (unit.startsWith('万') || unit.startsWith('w')) return 10000;
  if (unit.startsWith('千') || unit.startsWith('k')) return 1000;
  if (unit === '百') return 100;
  return 1;
}

function parseChineseSection(s: string): number {
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let current = 0;
  for (const ch of s) {
    if (ch in digits) current = digits[ch];
    else if (ch in units) {
      total += (current || 1) * units[ch];
      current = 0;
    }
  }
  return total + current;
}

function parseAmountToken(numRaw: string, unitRaw: string, hasPrefixSymbol: boolean): number | undefined {
  if (/^\d+(?:\.\d+)?$/.test(numRaw)) {
    const multiplier = parseUnitMultiplier(unitRaw, hasPrefixSymbol);
    return multiplier === undefined ? undefined : +numRaw * multiplier;
  }
  // Colloquial shorthand like 三万五 (35000), 十二万五 (125000), 四千五 (4500)
  const wanShort = numRaw.match(/^([零一二两三四五六七八九十百千]+)万([一二两三四五六七八九])$/);
  if (wanShort) return parseChineseSection(wanShort[1]) * 10000 + parseChineseSection(wanShort[2]) * 1000;
  const qianShort = numRaw.match(/^([一二两三四五六七八九])千([一二两三四五六七八九])$/);
  if (qianShort) return parseChineseSection(qianShort[1]) * 1000 + parseChineseSection(qianShort[2]) * 100;
  if (numRaw.includes('万')) {
    const [high, low] = numRaw.split('万');
    return (high ? parseChineseSection(high) : 1) * 10000 + (low ? parseChineseSection(low) : 0);
  }
  if (/[千百]/.test(numRaw)) return parseChineseSection(numRaw);
  const multiplier = parseUnitMultiplier(unitRaw, hasPrefixSymbol);
  if (multiplier === undefined) return undefined;
  return parseChineseSection(numRaw) * multiplier;
}

const BUDGET_VERB = '从|是|为|在|约|大概|改为|改到|改成|调整为|调整到|调为|调到|确定为|确定是|确认为|确认是|敲定为|敲定是|敲定在|更新为|更新到|定在|定为|定死在|定死为|锁在|锁死在|压到|压在|砍到|砍成|降到|降为|提到|提至|涨到|加到|增加到|变为|变成|批到了|批到|批了|谈到|谈到了|谈成|谈定为|谈定在';
const AMOUNT_NUM = '(\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十百千万]+)';
const AMOUNT_UNIT = '(万元|万块|万|w元|w|千元|千块|千|k|块钱|块|元|rmb)?';

function budget(text: string, warnings: string[]): number | undefined {
  if (budgetIsUncertain(text)) { warnings.push('预算金额尚未确认，未填写确定金额，请在预览中核对。'); return undefined; }
  const main = text.match(new RegExp(`(?:预算|金额|报价|合同额|合同金额|总价)\\s*(?:${BUDGET_VERB})?\\s*([¥￥])?\\s*${AMOUNT_NUM}\\s*${AMOUNT_UNIT}`, 'i'));
  const corrections = Array.from(text.matchAll(new RegExp(`(?:${BUDGET_VERB})\\s*([¥￥])?\\s*${AMOUNT_NUM}\\s*${AMOUNT_UNIT}`, 'gi')))
    .filter(candidate => {
      // Scheduling changes must not override a budget; Chinese amounts may embed their unit.
      const hasCurrency = !!candidate[1] || !!candidate[3] || /[万千百]/.test(candidate[2]);
      const suffix = text.slice(candidate.index! + candidate[0].length);
      return hasCurrency && !/^\s*(?:点|号|日)/.test(suffix);
    });
  const match = corrections.at(-1) || main;
  if (!match) return undefined;
  const value = parseAmountToken(match[2], match[3] || '', !!match[1]);
  if (value === undefined) { warnings.push('金额缺少单位，请补充元、万或 k 后重新整理，或在预览中手动核对。'); return undefined; }
  if (/约|大概|左右|区间|到\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:万|元|k|w)/i.test(text) && !corrections.length) warnings.push('原文金额含近似表达，请确认该预算后再保存。');
  return value;
}

const STAGE_VERB = '(?:为|是|改为|改到|更新为|更新到|调整为|调整到|进入|推进到|推进为|切换到|切到|变成|变为|定为)';
function stageFrom(text: string, fallback: DealStage, warnings: string[]): DealStage {
  if (NEGATIVE.test(text) || HYPOTHETICAL.test(text)) {
    if (/成交|赢单|签|打款|回款/.test(text)) warnings.push('检测到否定或假设表述，未推进成交阶段。');
    return fallback;
  }
  if (new RegExp(`阶段\\s*${STAGE_VERB}?\\s*赢单成交|(?:已经|已|正式|确认|成功)\\s*(?:完成)?\\s*(?:成交|赢单|签约|打款|回款|签合同)|成交了|合同签好了|签了合同|已回款|已打款|尾款(?:已)?(?:到账|打过来了|结清)`).test(text)) return '赢单成交';
  if (new RegExp(`进入(?:了)?(?:商务谈判|砍价阶段)|阶段\\s*${STAGE_VERB}?\\s*商务谈判|正在谈判|在谈合同|谈合同|在聊商务|商务推进`).test(text)) return '商务谈判';
  if (new RegExp(`阶段\\s*${STAGE_VERB}?\\s*方案报价|已经报价|已报价|已发方案|已发送报价|发了报价|报价单(?:已经|已|刚)?发(?:过去|给客户)|方案(?:已经|已|刚)?发(?:过去|给客户)`).test(text)) return '方案报价';
  if (new RegExp(`阶段\\s*${STAGE_VERB}?\\s*需求确认|需求确认|已确认需求|需求对齐|确认了需求|需求(?:已经|已)?(?:聊清楚|对完了|对齐了)`).test(text)) return '需求确认';
  if (new RegExp(`阶段\\s*${STAGE_VERB}?\\s*初步接触|初步接触|刚认识|刚接触|初次沟通`).test(text)) return '初步接触';
  return fallback;
}

function classifyExpenseCategory(title: string): ExpenseEntry['category'] {
  if (/饭|面|粉|粥|饼|饺|包|咖啡|拿铁|美式|奶茶|果茶|茶|吃|喝|餐|早饭|早餐|午饭|午餐|晚饭|晚餐|夜宵|宵夜|下午茶|外卖|果|菜|肉|火锅|烧烤|烤肉|零食|甜品|蛋糕|面包|牛奶|水(?![杯费电])/.test(title)) return '餐饮☕';
  if (/车|打车|滴滴|地铁|公交|油|加油|停车|洗车|过路费|高铁|动车|火车|机票|飞机|打的|单车/.test(title)) return '出行🚕';
  if (/衣|裤|鞋|帽|包|表|水杯|杯|淘宝|京东|拼多多|超市|商场|日用|纸巾|洗发|护肤|面膜|化妆品|耳机|手机|电脑|键盘|鼠标|猫粮|狗粮|买/.test(title)) return '购物🛍️';
  if (/电影|游戏|玩|会员|票|演出|演唱会|KTV|桌游|密室|剧本杀|按摩|旅游|门票|麻将/.test(title)) return '娱乐🎮';
  return '生活🏠';
}

export const StateEngine = {
  /** Produces a reviewable batch. It never reads or writes browser storage. */
  propose(text: string, context: ProposalContext): ProposedChangeSet {
    const now = context.now ?? Date.now();
    const proposal: ProposedChangeSet = { id: `proposal-${context.sourceMessageId}`, sourceMessageId: context.sourceMessageId,
      sourceText: text, mode: context.mode, baseRevision: context.partition.revision, operations: [], warnings: [], createdAt: now };
    if (context.mode !== 'work') { proposal.warnings.push('请在工作空间整理客户项目；生活记录仅在生活空间处理。'); return proposal; }
    const original = context.partition as WorkPartition;
    const working = JSON.parse(JSON.stringify(original)) as WorkPartition;
    working.followUps ||= [];
    working.conditions ||= [];
    const explicitNewName = context.newClientName?.trim();
    const singleNamedClient = new Set(findClients(text).map(item => item.name)).size === 1;
    let boundProjectId: string | undefined;
    const addOperation = (operation: WorkOperation) => {
      const existing = proposal.operations.find(item => item.target === operation.target && item.entityId === operation.entityId);
      if (existing) existing.after = operation.after as any;
      else proposal.operations.push(operation);
      const list: any[] = operation.target === 'engagement' ? working.engagements : operation.target === 'task' ? working.tasks : operation.target === 'followup' ? working.followUps : operation.target === 'condition' ? working.conditions : working.memories;
      const index = list.findIndex(item => item.id === operation.entityId);
      if (index >= 0) list[index] = operation.after;
      else if (operation.after) list.push(operation.after);
    };
    if (/午饭|早饭|晚饭|体重|饮水|小金库|亲友|妈妈|老婆/.test(text)) proposal.warnings.push('疑似生活内容仍保留在当前输入中，未跨区记账；可编辑或删除原文后再保存。');
    for (const paragraph of text.split(/[；;\n。]/).filter(item => item.trim())) {
      const rawClients = findClients(paragraph);
      const clients = rawClients.filter((client, index) => index === 0 || client.name !== rawClients[index - 1].name);
      const segments = clients.length ? clients.map((client, index) => ({ name: client.name,
        text: paragraph.slice(index === 0 ? 0 : client.start, clients[index + 1]?.start ?? paragraph.length) })) : [{ name: '', text: paragraph }];
      for (const segment of segments) {
        if (/如果|假如|假设|倘若/.test(segment.text) || /(?:可能|或许|也许|预计|有望).{0,8}(?:成交|赢单|签约|打款)/.test(segment.text)) { proposal.warnings.push('假设内容未作为事实提取，请补充已确认的信息。'); continue; }
        const selected = working.engagements.find(item => item.id === context.selectedEngagementId);
        const candidates = segment.name ? working.engagements.filter(item => item.clientName === segment.name || item.clientName.includes(segment.name)) : [];
        const explicitTitle = segment.text.match(/(?:项目名称|项目名|项目叫|项目为)\s*(?:为|是|叫|[:：])?\s*[「《“]?([^，,；。》”」]{1,30})/)?.[1]?.trim();
        const allTitleMatches = working.engagements.filter(item => item.title && item.title.trim().length >= 2 && !/的合作项目$/.test(item.title.trim()) && segment.text.includes(item.title.trim()));
        const titleMatches = segment.name ? candidates.filter(item => item.title && item.title.trim().length >= 2 && segment.text.includes(item.title.trim())) : allTitleMatches;
        const ambiguousProjectRef = /具体哪个项目.*没说|没说.*哪个项目|不确定.*哪个项目|哪个项目还没定/.test(segment.text);
        let before: Engagement | null = null;
        if (ambiguousProjectRef) {
          proposal.warnings.push(`「${segment.name || '该客户'}」项目指向尚未明确，请先选择项目再整理。`);
          proposal.clarification = { kind: 'project', message: `这次沟通属于哪个项目？` }; continue;
        } else if (explicitTitle && candidates.some(item => item.title === explicitTitle)) before = candidates.find(item => item.title === explicitTitle)!;
        else if (titleMatches.length === 1) before = titleMatches[0];
        else if (boundProjectId && (!segment.name || segment.name === explicitNewName)) before = working.engagements.find(item => item.id === boundProjectId) || null;
        else if (selected && (!segment.name || selected.clientName.includes(segment.name))) before = selected;
        else if (candidates.length === 1 && !explicitTitle) before = candidates[0];
        else if (candidates.length > 1 && !explicitTitle) {
          proposal.warnings.push(`「${segment.name}」有多个合作项目，请先选择项目再整理。`);
          proposal.clarification = { kind: 'project', message: `「${segment.name}」有多个项目，这次沟通属于哪一个？` }; continue;
        }
        if (!segment.name && !before && NEGATIVE.test(segment.text) && /成交|赢单|签|打款/.test(segment.text)) {
          const inThisInput = proposal.operations.filter(op => op.target === 'engagement' && op.after);
          if (inThisInput.length === 1) before = working.engagements.find(e => e.id === inThisInput[0].entityId) || null;
        }
        if (!segment.name && !before && !explicitNewName) {
          proposal.warnings.push('未明确客户或项目，请补充姓名或先选择项目。');
          proposal.clarification = { kind: 'project', message: '这段沟通属于谁或哪个项目？也可以先只保存原文。' }; continue;
        }
        const clientName = before?.clientName || segment.name || explicitNewName!;
        const amount = budget(segment.text, proposal.warnings);
        let engagement: Engagement = before ? { ...before } : { id: newId('engagement'), clientName, title: context.newProjectTitle?.trim() || explicitTitle || `${clientName}的合作项目`,
          stage: '初步接触', internalContext: '', shareableSummary: '', nextAction: '', updatedAt: now };
        // A single explicit client owns later sentences in the same input; multiple names still require a project choice.
        if ((singleNamedClient && segment.name) || (!before && explicitNewName && clientName === explicitNewName) || before) boundProjectId = engagement.id;
        if (explicitTitle) engagement.title = explicitTitle;
        if (amount !== undefined) engagement.budgetAmount = amount;
        engagement.stage = stageFrom(segment.text, engagement.stage, proposal.warnings);
        const contextMatch = segment.text.match(/(?:痛点是|诉求是|需求是|想做|需要做|目标是)([^，,；。]+)/);
        if (contextMatch) engagement.internalContext = contextMatch[1].trim();
        const openTasks = () => working.tasks.filter(item => item.engagementId === engagement.id && !item.done);
        const openFollowUps = (kind?: FollowUpItem['kind']) =>
          (working.followUps || []).filter(item => item.engagementId === engagement.id && item.status === 'open' && (!kind || item.kind === kind));
        const addFollowUp = (kind: FollowUpItem['kind'], title: string, dateText?: string) => {
          const existingMatch = kind === 'waiting' ? openFollowUps('waiting').filter(item => itemMatchesTitle(item.title, title)) : [];
          if (existingMatch.length === 1) {
            const target = existingMatch[0];
            const orig = (original.followUps || []).find(item => item.id === target.id) ?? null;
            const updated: FollowUpItem = { ...target, status: 'open', updatedAt: now };
            if (dateText) {
              updated.sourceDateText = dateText;
              const resolved = dateIsUncertain(segment.text) ? { warning: '日期或时间尚未确认，请在核对时补充。', dueAt: undefined } : resolveDeadline(dateText, now);
              if (resolved.warning) proposal.warnings.push(resolved.warning);
              delete updated.expectedAt;
              delete updated.expectedDate;
              if (resolved.dueAt) {
                if (HAS_CLOCK.test(dateText)) updated.expectedAt = resolved.dueAt;
                else updated.expectedDate = shanghaiDateKey(Date.parse(resolved.dueAt));
              }
            }
            addOperation({ target: 'followup', entityId: target.id, before: orig, after: updated });
            return;
          }
          if (proposal.operations.some(item => item.target === 'followup' && item.after?.engagementId === engagement.id && item.after.kind === kind && item.after.title === title)) return;
          const id = newId('followup');
          const followup: FollowUpItem = { id, kind, title, engagementId: engagement.id, status: 'open', sourceMessageId: context.sourceMessageId, createdAt: now, updatedAt: now };
          if (dateText) {
            followup.sourceDateText = dateText;
            const resolved = dateIsUncertain(segment.text) ? { warning: '日期或时间尚未确认，请在核对时补充。', dueAt: undefined } : resolveDeadline(dateText, now);
            if (resolved.warning) proposal.warnings.push(resolved.warning);
            if (resolved.dueAt) {
              if (HAS_CLOCK.test(dateText)) followup.expectedAt = resolved.dueAt;
              else followup.expectedDate = shanghaiDateKey(Date.parse(resolved.dueAt));
            }
          }
          addOperation({ target: 'followup', entityId: id, before: null, after: followup });
        };
        const upsertTask = (title: string, dateText?: string, existingTarget?: ProjectTaskItem) => {
          const matched = existingTarget ? [existingTarget] : openTasks().filter(item => itemMatchesTitle(item.title, title));
          if (matched.length === 1) {
            const target = matched[0];
            const orig = original.tasks.find(item => item.id === target.id) ?? null;
            const updated: ProjectTaskItem = { ...target };
            if (dateText !== undefined) {
              const resolved = dateIsUncertain(segment.text) ? { warning: '日期或时间尚未确认，行动保留但未设置提醒时间。', dueAt: undefined } : resolveDeadline(dateText, now);
              if (resolved.warning) proposal.warnings.push(resolved.warning);
              updated.deadline = dateText;
              updated.sourceDeadlineText = dateText;
              if (resolved.dueAt) updated.dueAt = resolved.dueAt;
              else delete updated.dueAt;
              engagement.nextAction = `${dateText} ${target.title}`;
              if (resolved.warning) addFollowUp('question', `确认${target.title}的时间`);
            }
            addOperation({ target: 'task', entityId: target.id, before: orig, after: updated });
            return;
          }
          if (dateText !== undefined) {
            const resolved = dateIsUncertain(segment.text) ? { warning: '日期或时间尚未确认，行动保留但未设置提醒时间。', dueAt: undefined } : resolveDeadline(dateText, now);
            if (resolved.warning) proposal.warnings.push(resolved.warning);
            const task: ProjectTaskItem = { id: newId('task'), title, assignee: '我', deadline: dateText, sourceDeadlineText: dateText,
              priority: 'medium', done: false, engagementId: engagement.id, ...(resolved.dueAt ? { dueAt: resolved.dueAt } : {}) };
            engagement.nextAction = `${dateText} ${title}`;
            addOperation({ target: 'task', entityId: task.id, before: null, after: task });
            if (resolved.warning) addFollowUp('question', `确认${title}的时间`);
          } else {
            const id = newId('task');
            addOperation({ target: 'task', entityId: id, before: null, after: { id, title, assignee: '我', deadline: '', priority: 'medium', done: false, engagementId: engagement.id } });
          }
        };
        const rawClauses = segment.text.split(/[，,]/).map(item => item.trim()).filter(Boolean);
        const clauses: string[] = [];
        for (let ci = 0; ci < rawClauses.length; ci++) {
          const cur = rawClauses[ci];
          const nxt = rawClauses[ci + 1];
          if (
            nxt &&
            (/^(?:(?:我方|我们|咱们|我|乙方)?(?:这边)?\s*)?(?:.*条件(?:改成|改到|改为|调整为|换成)\s*)?(?:等|待|等到|收到|拿到|确认好).+(?:后|之后|以后)$/.test(cur) ||
              (/^(?:(?:我方|我们|咱们|我|乙方)?(?:这边)?\s*)?(?:等|待|等到|收到|拿到).+/.test(cur) &&
                /^(?:(?:我方|我们|咱们|我|乙方)(?:这边)?\s*)?(?:再|就|才|开始|继续)/.test(nxt)) ||
              (/^(?:不用等|不必等|别等).+/.test(cur) && /^(?:取消|不用|算了|停止|暂停)/.test(nxt)))
          ) {
            clauses.push(`${cur}，${nxt}`);
            ci++;
          } else {
            clauses.push(cur);
          }
        }
        const activeConditions = () =>
          (working.conditions || []).filter(item => item.engagementId === engagement.id && !['completed', 'cancelled'].includes(item.status));
        const extractWaitingTitleFromCondition = (condText: string): string | null => {
          const cleaned = stripContextPrefix(condText)
            .replace(/^(?:客户|对方|甲方|他|她|他们|她们|那边|那头|这边)+/, '')
            .replace(/(?:了|之后|以后|后)+$/, '')
            .trim();
          if (/时机成熟|看情况|有空|内部讨论差不多|后续有机会|差不多|再看|待定|未定/.test(cleaned)) return null;
          const baMatch = cleaned.match(/^把(.+?)(发过来|发来|发|补齐|补交|补充|提供|给到|寄过来|传过来|回传|发给我们|交给我们|给我们|确认好|确认|签好|盖章)$/);
          if (baMatch) {
            const obj = baMatch[1].trim();
            const verb = baMatch[2];
            if (/^发/.test(verb) || verb === '给到' || verb === '给我们') return `发${obj}`;
            if (/^补/.test(verb)) return `补${obj}`;
            return `${verb}${obj}`;
          }
          const recvMatch = cleaned.match(/^(?:收到|拿到|等来|收齐)(.+)$/);
          if (recvMatch && recvMatch[1].trim().length >= 2) return `发${recvMatch[1].trim()}`;
          const postRecvMatch = cleaned.match(/^(.+?)(?:收到|收齐|发过来|发来|补齐|补交|到位|批下来|确认好|确认)$/);
          if (postRecvMatch && postRecvMatch[1].trim().length >= 2) {
            const obj = postRecvMatch[1].replace(/^(?:把|将)/, '').trim();
            return `提供${obj}`;
          }
          if (new RegExp(`^(?:${ACTION}).{2,}`).test(cleaned)) return cleaned;
          return null;
        };
        const bindOrStageFollowUp = (condText: string): FollowUpItem | undefined => {
          const matches = openFollowUps('waiting').filter(w => itemMatchesTitle(w.title, condText));
          if (matches.length === 1) return matches[0];
          if (matches.length > 1) return undefined;
          const waitingTitle = extractWaitingTitleFromCondition(condText);
          if (!waitingTitle) return undefined;
          addFollowUp('waiting', waitingTitle);
          const afterAdd = openFollowUps('waiting').filter(w => itemMatchesTitle(w.title, waitingTitle) || itemMatchesTitle(w.title, condText));
          return afterAdd.length === 1 ? afterAdd[0] : undefined;
        };
        const escapedClient = clientName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const stripContextPrefix = (raw: string) => {
          let out = raw.trim();
          if (clientName) out = out.replace(new RegExp(`^(?:跟|和|找|给)?${escapedClient}(?:的|那边|那头|这边|这头)?`), '').trim();
          if (engagement.title) {
            const escapedTitle = engagement.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            out = out.replace(new RegExp(`^(?:${escapedTitle})(?:项目)?(?:的|这块|那块|这边|那边)?`), '').trim();
          }
          return out.replace(/^(?:项目|这次|刚才|之前|目前|现在)(?:的|里|上)?/, '').trim();
        };
        let postponedWaiting = false;
        let pendingSubjectFromNegatedClause = '';
        for (const [clauseIndex, clause] of clauses.entries()) {
          // M2: ConditionIntent lifecycle (pause / resume / cancel / confirm ready)
          if (/(?:不用等|不必等|别等).*(?:取消|不用了|算了)|取消.*(?:条件|跟进)|(?:条件|跟进).*(?:取消|作废|不用了)/.test(clause)) {
            const subj = stripContextPrefix(clause)
              .replace(/(?:不用等|不必等|别等|了|取消|作废|不用|算了|那个|这个|那条|这条|条件|跟进|[，,])/g, ' ')
              .trim();
            const candidates = activeConditions();
            const matched = subj
              ? candidates.filter(c => itemMatchesTitle(c.actionTitle, subj) || itemMatchesTitle(c.conditionText, subj))
              : candidates.length === 1 ? candidates : [];
            const target = matched.length === 1 ? matched[0] : candidates.length === 1 ? candidates[0] : undefined;
            if (target) {
              const orig = (original.conditions || []).find(c => c.id === target.id) ?? null;
              addOperation({ target: 'condition', entityId: target.id, before: orig, after: transitionConditionIntent(target, 'cancel', now) });
              continue;
            }
          }
          if (/(?:先)?暂停.*(?:条件|跟进)|(?:条件|跟进).*(?:先)?暂停/.test(clause)) {
            const subj = stripContextPrefix(clause).replace(/(?:先|暂停|那个|这个|那条|这条|条件|跟进|的)/g, '').trim();
            const candidates = activeConditions();
            const matched = subj ? candidates.filter(c => itemMatchesTitle(c.actionTitle, subj) || itemMatchesTitle(c.conditionText, subj)) : candidates;
            const target = matched.length === 1 ? matched[0] : candidates.length === 1 ? candidates[0] : undefined;
            if (target) {
              const orig = (original.conditions || []).find(c => c.id === target.id) ?? null;
              addOperation({ target: 'condition', entityId: target.id, before: orig, after: transitionConditionIntent(target, 'pause', now) });
              continue;
            }
          }
          if (/(?:恢复|继续观察|重新开启).*(?:条件|跟进)|(?:条件|跟进).*(?:恢复|继续观察|重新开启)/.test(clause)) {
            const subj = stripContextPrefix(clause).replace(/(?:恢复|继续观察|重新开启|那个|这个|那条|这条|条件|跟进|的)/g, '').trim();
            const candidates = activeConditions().filter(c => c.status === 'paused' || c.status === 'draft');
            const matched = subj ? candidates.filter(c => itemMatchesTitle(c.actionTitle, subj) || itemMatchesTitle(c.conditionText, subj)) : candidates;
            const target = matched.length === 1 ? matched[0] : candidates.length === 1 ? candidates[0] : undefined;
            if (target) {
              const orig = (original.conditions || []).find(c => c.id === target.id) ?? null;
              addOperation({ target: 'condition', entityId: target.id, before: orig, after: transitionConditionIntent(target, 'activate_watching', now) });
              continue;
            }
          }
          if (/确认.*条件(?:已经|已)?满足|条件(?:已经|已)?满足/.test(clause)) {
            const subj = stripContextPrefix(clause).replace(/(?:确认|条件|已经|已|满足|了|可以|开始|推进|那个|这个|的|[，,])/g, '').trim();
            const candidates = activeConditions().filter(c => c.status === 'watching' || c.status === 'draft');
            const matched = subj ? candidates.filter(c => itemMatchesTitle(c.actionTitle, subj) || itemMatchesTitle(c.conditionText, subj)) : candidates;
            const target = matched.length === 1 ? matched[0] : candidates.length === 1 ? candidates[0] : undefined;
            if (target) {
              const orig = (original.conditions || []).find(c => c.id === target.id) ?? null;
              addOperation({ target: 'condition', entityId: target.id, before: orig, after: transitionConditionIntent(target, 'confirm_ready', now, `event-${proposal.id}`) });
              continue;
            }
          }
          // M2: Action-first condition edit: e.g. "整理第二版报价的条件改成等确认函收到"
          const actionFirstCondEdit = clause.match(/^(.+?)(?:那个|这个|的)?条件(?:改成|改到|改为|调整为|换成)\s*(?:等|待|等到)?(.+?)(?:后|之后|以后)?$/);
          if (actionFirstCondEdit && !/，/.test(actionFirstCondEdit[2])) {
            const rawAct = stripContextPrefix(actionFirstCondEdit[1]).trim();
            const rawCond = actionFirstCondEdit[2].trim();
            const candidates = activeConditions();
            const matched = rawAct ? candidates.filter(c => itemMatchesTitle(c.actionTitle, rawAct)) : candidates;
            const target = matched.length === 1 ? matched[0] : candidates.length === 1 ? candidates[0] : undefined;
            if (target && rawCond) {
              const bound = bindOrStageFollowUp(rawCond);
              const orig = (original.conditions || []).find(c => c.id === target.id) ?? null;
              const updated = reviseConditionIntent(target, {
                conditionText: rawCond,
                conditionKind: bound ? 'followup_resolved' : 'manual_confirm',
                followUpId: bound?.id || '',
                status: bound ? 'watching' : 'draft',
                sourceMessageId: context.sourceMessageId,
              }, now);
              addOperation({ target: 'condition', entityId: target.id, before: orig, after: updated });
              continue;
            }
          }
          // M2: Conditional follow-up creation or edit: e.g. "等陈总把首页素材发过来后，再整理第二版报价"
          const condClauseMatch = clause.match(
            /^(?:(?:我方|我们|咱们|我|乙方)?(?:这边)?\s*)?(?:(?:把|将)?(.*?)(?:那个|这个|的)?条件(?:改成|改到|改为|调整为|换成)\s*)?(等|待|等到|收到|拿到|确认好)(.+?)(?:(?:后|之后|以后)\s*[，,]?\s*(?:(?:我方|我们|咱们|我|乙方)(?:这边)?\s*)?(?:再|就|才|开始|继续|去)?|\s*[，,]\s*(?:(?:我方|我们|咱们|我|乙方)(?:这边)?\s*)?(?:再|就|才))(.+)$/,
          );
          if (condClauseMatch) {
            const editTargetHint = condClauseMatch[1]?.trim() || '';
            const prefixWord = condClauseMatch[2];
            const condBody = condClauseMatch[3].trim();
            const condText = /^(?:收到|拿到|确认好)$/.test(prefixWord) ? `${prefixWord}${condBody}` : condBody;
            const actionTitle = condClauseMatch[4]
              .replace(/^(?:我方|我们|咱们|我|乙方|这边|那边|再|就|才|开始|继续|去|先)+/, '')
              .replace(/(?:吧|了|呢)+$/, '')
              .trim();
            if (condText && actionTitle) {
              const bound = bindOrStageFollowUp(condText);
              const candidates = activeConditions();
              const existingMatch = candidates.filter(
                c => itemMatchesTitle(c.actionTitle, actionTitle) || (editTargetHint && itemMatchesTitle(c.actionTitle, editTargetHint)),
              );
              const target = existingMatch.length === 1 ? existingMatch[0] : (condClauseMatch[0].includes('条件改') && candidates.length === 1 ? candidates[0] : undefined);
              if (target) {
                const orig = (original.conditions || []).find(c => c.id === target.id) ?? null;
                const updated = reviseConditionIntent(target, {
                  conditionText: condText,
                  actionTitle,
                  conditionKind: bound ? 'followup_resolved' : 'manual_confirm',
                  followUpId: bound?.id || '',
                  status: bound ? 'watching' : 'draft',
                  sourceMessageId: context.sourceMessageId,
                }, now);
                addOperation({ target: 'condition', entityId: target.id, before: orig, after: updated });
              } else {
                const id = newId('condition');
                const cond: ConditionIntent = {
                  id,
                  space: 'work',
                  engagementId: engagement.id,
                  ...(bound ? { followUpId: bound.id } : {}),
                  conditionKind: bound ? 'followup_resolved' : 'manual_confirm',
                  conditionText: condText,
                  actionTitle,
                  sourceMessageId: context.sourceMessageId,
                  status: bound ? 'watching' : 'draft',
                  revision: 1,
                  createdAt: now,
                  updatedAt: now,
                };
                if (!bound) {
                  proposal.warnings.push('条件尚未绑定具体等待事项，已先存为条件草稿；可在核对时绑定等待项或改由人工确认。');
                }
                addOperation({ target: 'condition', entityId: id, before: null, after: cond });
              }
              continue;
            }
          }
          if (/(?:先)?(?:不用|不要|别|先别|暂缓)催/.test(clause)) {
            const subj = stripContextPrefix(clause).replace(/(?:先)?(?:不用|不要|别|先别|暂缓)催(?:了|他|她|客户|对方)?/g, '').trim();
            const waitingMatches = subj && !GENERIC_REF.test(subj) ? openFollowUps('waiting').filter(w => itemMatchesTitle(w.title, subj)) : openFollowUps('waiting');
            if (waitingMatches.length === 1) {
              const target = waitingMatches[0];
              const orig = (original.followUps || []).find(f => f.id === target.id) ?? null;
              const vagueMatch = segment.text.match(/下周|下星期|下礼拜|下个?月|过几天|晚点|稍后|改天/);
              const updated: FollowUpItem = { ...target, sourceDateText: vagueMatch ? vagueMatch[0] : '待定', updatedAt: now };
              delete updated.expectedDate;
              delete updated.expectedAt;
              addOperation({ target: 'followup', entityId: target.id, before: orig, after: updated });
              postponedWaiting = true;
            } else if (waitingMatches.length > 1) {
              proposal.warnings.push('该项目有多条等待客户事项，请明确要修改哪一条。');
              proposal.clarification = { kind: 'project', message: '该项目有多条等待客户事项，请说明要修改具体哪一条。' };
            }
            continue;
          }
          if (/^(?:不用|不要|别|先别|无需|不必)/.test(clause)) continue;
          if (/^(?:我这边|我们这边|我方|我们|咱们|我)?(?:先)?\s*(?:先等|等着|等待|等他|等她|等对方|等客户|先不动|按兵不动|记一笔等着|等消息)/.test(clause)) continue;
          if (/^不是/.test(clause) && new RegExp(DATE).test(clause) && !/(?:改成|改到|改为|推迟到|延后到|提前到)/.test(clause)) {
            pendingSubjectFromNegatedClause = stripContextPrefix(clause.replace(new RegExp(`不是\\s*${DATE}${CLOCK}前?`), '')).trim();
            continue;
          }
          const own = /^(?:我方|我们|我|乙方)/.test(clause);
          const customer = /^(?:客户|对方|甲方|他|她|他们|她们)/.test(clause) || ((clauseIndex > 0 || /(?:^|[，,])我(?:方|们)?/.test(paragraph)) && clause.startsWith(clientName)) ||
            new RegExp(`^${escapedClient}(?:刚才|刚刚|刚|微信上?|电话里?|口头|那头|那边|这边|那儿|这儿){0,2}(?:说|表示|答应|承诺|反馈|讲|提到|负责|会|将|需要|要|那边|这边|那头)`).test(clause) ||
            /(?:发给|交给|补给|提供给|回传给|寄给)(?:我们|我方|我)(?:$|[^A-Za-z0-9\u4e00-\u9fa5])/.test(clause);
          if (!NEGATIVE.test(clause) && !HYPOTHETICAL.test(clause) && !/[?？]|(?:吗|么)$/.test(clause) && !new RegExp(DATE).test(clause)) {
            if (/(?:已经|已|刚).*(?:收到|收齐|发过来|发来|传过来|寄过来|补齐|补交|给到|提供|解决|确认清楚)|(?:已收到|已经收到|收到了|已收齐|发过来了|已经发过来|已补齐|已经补齐|已解决|已经解决)$/.test(clause)) {
              const subj = stripContextPrefix(clause).replace(/(?:客户|对方|甲方|他|她|他们|她们|已经|已|刚|把|将|都|全部|收到|收齐|发过来|发来|传过来|寄过来|补齐|补交|给到|提供|解决|确认清楚|了)+/g, '').trim();
              const followUpMatches = subj && !GENERIC_REF.test(subj) ? openFollowUps().filter(f => itemMatchesTitle(f.title, subj)) : openFollowUps('waiting').length === 1 ? openFollowUps('waiting') : [];
              if (followUpMatches.length === 1) {
                const target = followUpMatches[0];
                const orig = (original.followUps || []).find(f => f.id === target.id) ?? null;
                const resolvedFollowUp: FollowUpItem = { ...target, status: 'resolved', updatedAt: now };
                addOperation({ target: 'followup', entityId: target.id, before: orig, after: resolvedFollowUp });
                for (const condOp of evaluateFollowUpTransition(working.conditions || [], orig || target, resolvedFollowUp, now, `event-${proposal.id}`)) {
                  if (condOp.target !== 'condition') continue;
                  const origCond = (original.conditions || []).find(c => c.id === condOp.entityId) ?? null;
                  addOperation({ target: 'condition', entityId: condOp.entityId, before: origCond, after: condOp.after });
                }
                continue;
              }
            }
            if (!customer && /(?:已经|已|刚).*(?:完成|做完|发过去|发出去了|发给客户|提交了|交了|搞定|处理好)|(?:做完|发过去|发出去了|完成了|搞定了|处理好了)$/.test(clause)) {
              const subj = stripContextPrefix(clause).replace(/(?:我方|我们|我|已经|已|刚|把|将|都|全部|完成|做完|发过去|发出去了|发给客户|提交|交|搞定|处理好|了)+/g, '').trim();
              const taskMatches = subj && !GENERIC_REF.test(subj) ? openTasks().filter(t => itemMatchesTitle(t.title, subj)) : [];
              if (taskMatches.length === 1) {
                const target = taskMatches[0];
                const orig = original.tasks.find(t => t.id === target.id) ?? null;
                addOperation({ target: 'task', entityId: target.id, before: orig, after: { ...target, done: true } });
                continue;
              }
            }
          }
          const reschedule = !/(?:预算|金额|报价|合同额|合同金额|总价|阶段)/.test(clause)
            ? clause.match(new RegExp(`^(.*?)\\s*(?:改成|改到|改为|推迟到|延后到|顺延到|提前到|挪到|调到|调整到|调整为)\\s*(${DATE}${CLOCK})前?(?:\\s*((?:${ACTION})[^，,；。]*))?$`))
            : null;
          if (reschedule) {
            const datePart = reschedule[2].trim();
            const rawSubj = stripContextPrefix(reschedule[1] || pendingSubjectFromNegatedClause || '')
              .replace(new RegExp(`^不是\\s*${DATE}${CLOCK}前?\\s*`), '')
              .replace(/^(?:我方|我们|咱们|我|乙方|客户|对方|甲方|他|她|他们|她们|说|表示|答应|把|将)+/, '')
              .trim();
            const tailAction = reschedule[3]?.trim() || '';
            const candidateSubj = [rawSubj, tailAction].filter(Boolean).join('');
            pendingSubjectFromNegatedClause = '';
            if (!candidateSubj || GENERIC_REF.test(candidateSubj)) {
              const pool = customer ? openFollowUps('waiting') : openTasks();
              if (pool.length === 1) {
                if (customer) addFollowUp('waiting', pool[0].title, datePart);
                else upsertTask(pool[0].title, datePart, pool[0] as ProjectTaskItem);
              } else if (pool.length > 1) {
                proposal.warnings.push('该项目有多条进行中的事项，请明确要修改哪一条。');
                proposal.clarification = { kind: 'project', message: '该项目有多条进行中的事项，请说明要修改具体哪一条。' };
              }
              continue;
            }
            const taskMatches = !customer ? openTasks().filter(t => itemMatchesTitle(t.title, candidateSubj)) : [];
            const waitMatches = openFollowUps('waiting').filter(w => itemMatchesTitle(w.title, candidateSubj));
            if (taskMatches.length === 1) { upsertTask(taskMatches[0].title, datePart, taskMatches[0]); continue; }
            if (waitMatches.length === 1) { addFollowUp('waiting', waitMatches[0].title, datePart); continue; }
            if (taskMatches.length > 1 || waitMatches.length > 1) {
              proposal.warnings.push('该项目有多条相近事项，请明确要修改哪一条。');
              proposal.clarification = { kind: 'project', message: '该项目有多条相近事项，请说明要修改具体哪一条。' };
              continue;
            }
            if (customer) addFollowUp('waiting', candidateSubj, datePart);
            else upsertTask(candidateSubj, datePart);
            continue;
          }
          const unclearOwner = RESPONSIBILITY_UNCERTAIN.test(segment.text) && !own && !customer;
          const taskPattern = new RegExp(`(${DATE}${CLOCK})前?\\s*(?:要|需要|必须|得|先|会|将|再)?\\s*(?:(${ACTION})([^，,；。]+)|(把[^，,；。]*?(?:${ACTION})[^，,；。]*))`, 'g');
          for (const match of clause.matchAll(taskPattern)) {
            const title = (match[4] || `${match[2]}${match[3]}`).trim();
            if (unclearOwner) { addFollowUp('question', `确认由谁${title}`); continue; }
            if (customer) { addFollowUp('waiting', title, match[1]); continue; }
            upsertTask(title, match[1]);
          }
          if ((customer || own) && !new RegExp(DATE).test(clause) && !/(?:预算|金额|报价|合同额|合同金额|总价|阶段)/.test(clause)) {
            const clauseWithoutProject = engagement.title ? clause.replace(engagement.title, '') : clause;
            const action = clauseWithoutProject.match(new RegExp(`(?:负责|会|将|需要|要)?\\s*(?:(${ACTION})([^，,；。]+)|(把[^，,；。]*?(?:${ACTION})[^，,；。]*))`));
            if (action && !/未定|没确定|没确认|不确定|不提供|不会/.test(clause)) {
              const title = (action[3] || `${action[1]}${action[2]}`).trim();
              if (postponedWaiting && customer && normalizeItemCore(title).object.length < 2) continue;
              if (customer) addFollowUp('waiting', title);
              else upsertTask(title);
            }
          }
          if (
            /(?:费用|预算|报价|金额|价格|尾款|合同额|运费|税点|税率|几个点|发票|专票|普票|周期|工期|交付|方案|接口|标准|条款|质保|账期|预付款|首付款|定金|违约金|售后)/.test(clause) &&
            /未定|待定|(?:还)?没(?:有)?(?:定|谈定|确定|确认|拍板|敲定|说清|明确|聊透|谈拢|谈妥|聊妥|说定|定下来|对齐|商量好)|尚未(?:定|谈定|确定|确认|拍板|敲定|说清|明确)|待确认|不确定|先别定|未拍板|含不含|包不包|算不算|是否包含|是否含|谁承担|怎么算/.test(clause) &&
            !/不是.*(?:预算|报价|金额)|不要当真|别当真/.test(clause)
          ) {
            addFollowUp('question', clause);
          }
          if (/(?:预算|报价|金额|费用|合同额)\s*\d+(?:\.\d+)?\s*$/.test(clause)) addFollowUp('question', `确认${clause}的金额单位`);

          // 关键商务事实与决策约束沉淀为长期工作事实
          if (/(?:底线|底价|最低价|成本线|付款方式|付款流程|结款|专票|增值税|分期|预付款|质保金|押金)/.test(clause) && !new RegExp(DATE).test(clause)) {
            const memId = newId('memory');
            addOperation({
              target: 'memory',
              entityId: memId,
              before: null,
              after: {
                id: memId,
                mode: 'work',
                category: 'business',
                fact: clause.trim(),
                subject: engagement.clientName || '客户商务事实',
                topic: '商务底线与付款规则',
                importance: 5,
                status: 'active',
                pinned: true,
                createdAt: now,
                sourceIds: [context.sourceMessageId],
              } as any,
            });
          } else if (/(?:决策人|拍板人|负责人是|老板是|董事长|总经理|主管|偏好微信|开会不接|不要打电话|沟通偏好)/.test(clause)) {
            const memId = newId('memory');
            addOperation({
              target: 'memory',
              entityId: memId,
              before: null,
              after: {
                id: memId,
                mode: 'work',
                category: 'person',
                fact: clause.trim(),
                subject: engagement.clientName || '关键人脉背景',
                topic: '决策链与沟通习惯',
                importance: 5,
                status: 'active',
                pinned: false,
                createdAt: now,
                sourceIds: [context.sourceMessageId],
              } as any,
            });
          } else if (/(?:必须兼容|不能动|严禁修改|技术约束|信创|私有化部署|老系统架构)/.test(clause)) {
            const memId = newId('memory');
            addOperation({
              target: 'memory',
              entityId: memId,
              before: null,
              after: {
                id: memId,
                mode: 'work',
                category: 'experience',
                fact: clause.trim(),
                subject: engagement.title || engagement.clientName || '交付约束',
                topic: '技术与交付约束',
                importance: 4,
                status: 'active',
                pinned: false,
                createdAt: now,
                sourceIds: [context.sourceMessageId],
              } as any,
            });
          }
        }
        engagement.updatedAt = now;
        if (!before || JSON.stringify({ ...before, updatedAt: now }) !== JSON.stringify(engagement)) {
          addOperation({ target: 'engagement', entityId: engagement.id, before: original.engagements.find(item => item.id === engagement.id) || null, after: engagement });
        }
      }
    }
    proposal.operations.sort((a, b) => (a.target === 'engagement' ? 0 : 1) - (b.target === 'engagement' ? 0 : 1));
    proposal.warnings = [...new Set(proposal.warnings)];
    if (!proposal.operations.length && !proposal.warnings.length) proposal.warnings.push('没有提取到明确变更，原文已保留供核对。');
    return proposal;
  },
  validate(proposal: ProposedChangeSet, partition: WorkPartition | LifePartition): string[] {
    if (!proposal.operations.some(operation => operation.target === 'followup' || operation.target === 'condition')) return validateProposal(proposal, partition);
    if (proposal.mode !== 'work' || !Array.isArray(proposal.warnings) || proposal.warnings.some(item => typeof item !== 'string') || !Number.isFinite(proposal.createdAt)) return ['变更格式或所属空间无效。'];
    const work = partition as WorkPartition;
    return validateTransaction({ op: 'transaction', space: 'work', id: proposal.id, sourceMessageId: proposal.sourceMessageId, sourceText: proposal.sourceText,
      baseRevision: proposal.baseRevision, mutations: proposal.operations.map(operation => ({ kind: operation.target, id: operation.entityId, before: operation.before, after: operation.after })) },
      partition.revision, (kind: string, id: string) => (kind === 'engagement' ? work.engagements : kind === 'task' ? work.tasks : kind === 'followup' ? work.followUps || [] : kind === 'condition' ? work.conditions || [] : work.memories).find(item => item.id === id) || null);
  },

  /** Mutates only the caller's detached draft. The repository commits it atomically. */
  mutateLifeDraft(text: string, life: LifePartition): StateMutationReceipt[] {
    const facts=routeLifeInput(text).filter(part=>part.route==='fact').map(part=>part.text.trim()
      .replace(/\d{1,3}(?:[,，]\d{3})+(?:\.\d+)?/g,amount=>amount.replace(/[,，]/g,''))
      .replace(/(\d+)块([0-9])(?:毛)?$/,'$1.$2元'));
    if (!facts.length) return [];
    const receipts: StateMutationReceipt[] = [];
    const receipt = (targetCardType: StateMutationReceipt['targetCardType'], summaryText: string) => receipts.push({
      id: newId('receipt'), mode: 'life', targetCardType, targetCardTitle: '生活记录', summaryText, deltaBadge: '已记录', timestamp: Date.now(),
    });
    const clean = facts.join('，');

    // 1. 自定义卡片新建与打卡推进（支持带或不带《》书名号）
    const customMatch = clean.match(/(?:建一?张|建一?个|新建|创建|生成一?张|加一?个)\s*《?([^》”"\s，,。；]{1,14}?)》?\s*(?:卡|看板|面板|打卡)/);
    if (customMatch) {
      const target = +(clean.match(/目标\s*(\d+)/)?.[1] || 100);
      if (target > 0) {
        const cards = life.customCards;
        cards.push({ id: newId('custom'), mode: 'life', title: customMatch[1], icon: '🌱', metricLabel: '进度', metricValue: 0,
          metricTarget: target, unit: '次', checklist: [] });
        receipt('custom', `已创建「${customMatch[1]}」生活卡`);
      }
    } else if (life.customCards?.length) {
      for (const card of life.customCards) {
        if (!card.title) continue;
        const escaped = card.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const progMatch = clean.match(new RegExp(`(?:打卡|完成(?:了)?|推进)?\\s*${escaped}\\s*(?:打卡|\\+\\s*(\\d+)|完成了?\\s*(\\d+))`));
        if (progMatch) {
          const delta = +(progMatch[1] || progMatch[2] || 1);
          card.metricValue = Math.min(card.metricTarget || 100, (card.metricValue || 0) + delta);
          receipt('custom', `已更新「${card.title}」进度 +${delta}`);
        }
      }
    }

    const wallet = life.wallet;

    // 确保多心愿结构与主攻目标就绪
    if (!wallet.wishes || !wallet.wishes.length) {
      wallet.wishes = [{
        id: 'default-wish',
        title: wallet.wishTitle || '心愿小金库',
        targetAmount: wallet.wishTarget || 10000,
        savedAmount: wallet.wishSaved || 0,
        group: '品质生活',
        isPrimary: true,
        createdAt: Date.now(),
      }];
    }
    if (!wallet.activeWishId) {
      wallet.activeWishId = wallet.wishes.find(w => w.isPrimary)?.id || wallet.wishes[0]?.id || 'default-wish';
    }

    const syncWishProgress = (addAmount: number) => {
      wallet.wishSaved += addAmount;
      const targetWish = wallet.wishes?.find(w => w.id === wallet.activeWishId) || wallet.wishes?.[0];
      if (targetWish) {
        targetWish.savedAmount += addAmount;
        wallet.wishTitle = targetWish.title;
        wallet.wishTarget = targetWish.targetAmount;
      }
      return targetWish;
    };

    // 2. 心愿金库存入 / 攒钱（无需强制写“元/块”，支持 万/w/k）
    const bookedClauses = new Set<string>();
    for (const clause of facts) {
    const save = clause.match(/(?:存入(?:小金库)?|存了?|攒了?|存进|小金库\s*(?:加|存|\+|入了?)?)\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元)?/i);
    if (save) {
      const unit = (save[2] || '').toLowerCase();
      const mult = unit === '万' || unit === 'w' ? 10000 : unit === '千' || unit === 'k' ? 1000 : 1;
      const amount = +save[1] * mult;
      const primaryWish = syncWishProgress(amount);
      wallet.entries.push({ id: newId('expense'), title: '心愿金库存入', amount, type: 'saving', category: '金库✨', timestamp: Date.now() });
      bookedClauses.add(clause);
      receipt('wallet', `已记录心愿存入 ¥${amount}（${primaryWish ? primaryWish.title : '心愿金库'}）`);
      continue;
    }

    // 3. 收入记录（发工资 / 兼职 / 报销 / 红包 / 入账 / 挣了 / 赚了，无需强制写“元/块”）
    const received=clause.match(/^(.*?(?:还给我|发了(?:年终奖|奖金)|卖了|卖出))\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(?:块钱|块|元)(.*)$/);
    if(received&&(/还给我/.test(received[1])||/(?:钱已收|到卡上了|已到账|收款了)/.test(received[3]))){
      const amount=+received[2],title=received[1];
      if(amount>0&&Number.isFinite(amount)){
        wallet.entries.push({id:newId('expense'),title,amount,type:'income',category:'金库✨',timestamp:Date.now()});
        bookedClauses.add(clause);
        syncWishProgress(amount);
        receipt('wallet',`已记录收入 ${title} ¥${amount}，已存入心愿金库`);
      }
      continue;
    }
    const incomeMatch = clause.match(/(?:(发工资|工资|兼职|报销|红包|奖金|年终奖|退款|退税|外快|副业|利息)\s*(?:发了|到了|到账了?|收到|入账|进账|赚了?|挣了?)?|(?:收到了?|到账了?|入账|进账|赚了?|挣了?|收入)\s*([^\d，,。；！？\s]{0,8}?))\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元)?/i);
    if (incomeMatch) {
      if(incomeMatch[1]&&!/发工资|发了|到了|到账|收到|入账|进账|赚|挣/.test(clause))continue;
      const title = (incomeMatch[1] || incomeMatch[2] || '日常收入').trim() || '日常收入';
      const unit = (incomeMatch[4] || '').toLowerCase();
      const mult = unit === '万' || unit === 'w' ? 10000 : unit === '千' || unit === 'k' ? 1000 : 1;
      const amount = +incomeMatch[3] * mult;
      wallet.entries.push({ id: newId('expense'), title, amount, type: 'income', category: '金库✨', timestamp: Date.now() });
      bookedClauses.add(clause);
      const primaryWish = syncWishProgress(amount);
      receipt('wallet', `已记录收入 ${title} ¥${amount}，已存入心愿金库（${primaryWish ? primaryWish.title : '心愿金库'}）`);
      continue;
    }

    // 4. 消费记账（支持无单位如“今天花了30”、“买水杯60”、“花了30买水杯”、“早饭15”、“打车28”等全部日常口语）
      // 跳过已作为心愿存入、收入、自定义卡目标、体重、饮水、睡眠或商务预算的子句
      if (/(?:存入|存了?|攒了?|存进|小金库|发工资|工资|报销|收到红包|入账|进账|赚了?|挣了?|收入|目标\s*\d+|体重|称重|上称|预算|报价|王总|李总)/.test(clause)) continue;
      if(/红包|奖金|年终奖|退款|退税|利息|还给我|卖了|卖出|到账|转账/.test(clause)&&!/实付|花了|扣了|刷了/.test(clause))continue;
      if (/^\d+(?:\.\d+)?\s*(?:kg|公斤|千克|斤)$/i.test(clause)) continue;
      if (/(?:喝了?|炫了?|补)\s*(?:\d+|[一二两三四五六七八九十])?\s*(?:杯|瓶|毫升|ml)\s*水?/i.test(clause)) continue;
      if (/睡了?\s*\d+(?:\.\d+)?\s*(?:个?小时|h)/i.test(clause)) continue;

      let title = '';
      let amountNum = NaN;
      let unitRaw = '';

      // 句式 A: [前缀/时间/项目] + (花了/付了/消费/支出/花费/用了/刷了/扣了) + [金额] + [单位]? + [去买/吃/喝/项目]?
      // 例: "今天花了30", "花了30买水杯", "午饭花了35", "付了28打车"
      const verbFirst = clause.match(/^(.*?)\s*(?:实付了?|花了?|付了?|消费了?|支出了?|花费了?|用了?|刷了?|扣了?)\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元|米|大洋|rmb)?\s*(.*)$/i);
      if (verbFirst) {
        const prefix = verbFirst[1].replace(/^(?:今天|刚刚|刚才|昨晚|昨天|前天|早上|上午|中午|下午|晚上|夜里|顺便|另外|还有|又|我|去|在)+/, '').trim();
        const suffix = verbFirst[4].replace(/^(?:去|给|在)+/, '').trim();
        title = suffix || prefix || '日常开销';
        amountNum = +verbFirst[2];
        unitRaw = verbFirst[3] || '';
      }

      // 句式 B: (买了/吃了/喝了/点了/交了/充了/打车/早饭/午饭/晚饭/咖啡/奶茶...) + [项目] + [金额] + [单位]?（无需写“花了”和“元/块”）
      // 例: "买水杯60", "买了水杯 60", "早饭15", "打车28", "咖啡18", "充话费100"
      if (Number.isNaN(amountNum)) {
        const actionOrScene = clause.match(/^(?:今天|刚刚|刚才|昨晚|昨天|早上|上午|中午|下午|晚上|下班|顺便|另外|还有|又|我|去)*\s*((?:买了?|吃了?|喝了?|点了?|交了?|充了?|刷了?|打车|滴滴|坐车|地铁|公交|加油|停车|洗车|早饭|早餐|午饭|午餐|晚饭|晚餐|夜宵|宵夜|下午茶|咖啡|拿铁|美式|奶茶|果茶|水果|零食|买菜|超市|外卖|快递|话费|水费|电费|燃气|网费|房租|物业|电影|理发|挂号|买药|淘宝|京东|拼多多)[^\d，,。；！？]{0,12}?)\s*(?:一共|总共|共|是)?\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元|米|大洋|rmb)?$/i);
        if (actionOrScene) {
          title = actionOrScene[1].replace(/^(?:了|个|杯|碗|份|顿|次)+/, '').trim();
          amountNum = +actionOrScene[2];
          unitRaw = actionOrScene[3] || '';
        }
      }

      // 句式 C: 任意项目名称 + 金额 + 明确货币符号或单位 (例: "水杯 60元", "耳机¥299", "猫粮180块")
      if (Number.isNaN(amountNum)) {
        const explicitUnit = clause.match(/^([^，,。；！？\d]{1,12}?)\s*(?:([¥￥])\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元|米|大洋|rmb))$/i);
        if (explicitUnit) {
          title = explicitUnit[1].replace(/^(?:今天|刚刚|刚才|顺便|另外|还有|又|我)+/, '').trim() || '日常开销';
          amountNum = +(explicitUnit[3] || explicitUnit[4]);
          unitRaw = explicitUnit[5] || '';
        }
      }

      if (!Number.isNaN(amountNum) && amountNum > 0) {
        const cleanTitle = title.replace(/^(?:今天|刚刚|刚才|顺便|另外|还有|又)+/, '').trim() || '日常开销';
        if (/预算|金额|报价|存入|攒|客户|王总|李总/.test(cleanTitle)) continue;
        const unit = unitRaw.toLowerCase();
        const mult = unit === '万' || unit === 'w' ? 10000 : unit === '千' || unit === 'k' ? 1000 : 1;
        const finalAmount = +(amountNum * mult).toFixed(2);
        const category = classifyExpenseCategory(cleanTitle);
        wallet.entries.push({ id: newId('expense'), title: cleanTitle, amount: finalAmount, type: 'expense', category, timestamp: Date.now() });
        bookedClauses.add(clause);
        receipt('wallet', `已记录 ${cleanTitle} ¥${finalAmount}`);
      }
    }

    // 5. 体重、疲劳与运动恢复。饮水字段仅保留旧数据兼容。
    const rpg = life.rpg;

    // 体重：支持 "体重65"、"体重130斤"、"体重130"(>=95自动按斤折算)、"今天65kg"、"128斤"
    const weightExplicit = clean.match(/(?:体重|称重|上称|重了?|瘦到|涨到|降到)\s*(?:是|为|到了?)?\s*(\d{2,3}(?:\.\d+)?)\s*(kg|公斤|千克|斤)?/i);
    const weightUnitOnly = !weightExplicit ? clean.match(/(?:^|[，,。；\s]|今天|现在|目前|早上|晚上)(\d{2,3}(?:\.\d+)?)\s*(kg|公斤|千克|斤)/i) : null;
    const weightMatch = weightExplicit || weightUnitOnly;
    if (weightMatch) {
      const rawVal = +weightMatch[1];
      const unit = (weightMatch[2] || '').toLowerCase();
      if (rawVal >= 30 && rawVal <= 350) {
        const isJin = unit === '斤' || (!unit && rawVal >= 95);
        rpg.weightKg = +(rawVal / (isJin ? 2 : 1)).toFixed(1);
        receipt('rpg_status', `用户自报体重 ${rpg.weightKg}kg`);
      }
    }

    // 疲惫与精力下降
    if (/熬夜|失眠|好累|太累|累死|累趴|没睡好|没睡醒|疲惫|困死|好困|犯困|加班|内耗|心累|头疼|头痛|不舒服|生病|感冒|发烧|烦躁|焦虑/.test(clean)) {
      rpg.energy = Math.max(0, rpg.energy - 18);
      rpg.moodBuff = '用户自报疲惫';
      receipt('rpg_status', '已记录自报状态：疲惫');
    }

    // 运动与睡眠恢复
    if (/跑步|夜跑|晨跑|健身|举铁|撸铁|运动|锻炼|散步|走路|遛弯|骑行|骑车|游泳|打球|羽毛球|篮球|网球|乒乓球|踢球|瑜伽|普拉提|帕梅拉|跳绳|八段锦|爬山|徒步|冥想|早睡|早起|睡了个?好觉|睡饱|睡足|睡了\s*(?:[789]|10|[七八九十])\s*个?小时|满血复活|精神不错|元气满满/.test(clean)) {
      const today = shanghaiDateKey();
      if (rpg.lastActivityDate !== today) {
        const yesterday = shanghaiDateKey(Date.now() - 86400000);
        rpg.streakDays = rpg.lastActivityDate === yesterday ? rpg.streakDays + 1 : 1;
        rpg.lastActivityDate = today;
        rpg.energy = Math.min(100, rpg.energy + 20);
      }
      rpg.moodBuff = '用户自报活动 / 恢复';
      receipt('rpg_status', `今日活动已记录，连续 ${rpg.streakDays} 天`);
    }

    // 6. 亲友档案与个人深度记忆精准提取
    life.memories ||= [];
    const newMemories: any[] = [];
    const pushLifeMem = (subject: string, topic: string, fact: string, category: 'preference' | 'habit' | 'person' | 'experience' | 'business', importance = 4) => {
      const cleanFact = fact.trim();
      if (!cleanFact || cleanFact.length < 2) return;
      if (/^已记录|^今日饮水|^自报体重/.test(cleanFact)) return;
      const norm = (s: string) => s.replace(/[\s，,。；;！？!、]/g, '').toLowerCase();
      const existing = life.memories.find(m => m.subject === subject && m.topic === topic);
      if (existing) {
        if (norm(existing.fact) !== norm(cleanFact)) {
          existing.fact = cleanFact;
          existing.validFrom = Date.now();
          const badge = cleanFact.startsWith(`【${subject}】`)
            ? `🧠 记忆已收录：${cleanFact}`
            : `🧠 记忆已收录：【${subject}】${cleanFact}`;
          receipt('relationships' as any, badge);
        }
      } else if (!newMemories.some(m => norm(m.fact) === norm(cleanFact))) {
        const mem = {
          id: newId('memory'),
          mode: 'life',
          category,
          fact: cleanFact,
          subject,
          topic,
          importance,
          status: 'active',
          pinned: importance >= 5,
          createdAt: Date.now(),
          sourceIds: [],
        };
        newMemories.push(mem);
        life.memories.push(mem as any);
        const summaryBadge = cleanFact.startsWith(`【${subject}】`)
          ? `🧠 记忆已收录：${cleanFact}`
          : `🧠 记忆已收录：【${subject}】${cleanFact}`;
        receipt('relationships' as any, summaryBadge);
      }
    };

    const KIN_TITLES = ['妈妈', '老妈', '母亲', '妈', '爸爸', '老爸', '父亲', '爸', '老婆', '媳妇', '爱人', '妻子', '太太', '老公', '丈夫', '先生', '对象', '女朋友', '女友', '男友', '男朋友', '儿子', '女儿', '闺女', '孩子', '宝宝', '爷爷', '奶奶', '姥姥', '姥爷', '外公', '外婆', '公公', '婆婆', '岳父', '岳母', '丈母娘', '哥哥', '姐姐', '弟弟', '妹妹', '嫂子', '姐夫', '妹夫', '叔叔', '阿姨', '舅舅', '姑姑', '表哥', '表姐', '表弟', '表妹', '堂哥', '堂姐', '堂弟', '堂妹', '闺蜜', '室友', '发小', '同学', '同事', '朋友'];
    const KIN_REGEX = new RegExp('^(?:我|我的|咱|咱们)?(' + KIN_TITLES.join('|') + ')');
    const normalizeKin = (raw: string) => {
      if (/^(?:我|我的|咱|咱们)?(?:老妈|妈|母亲)$/.test(raw)) return raw.startsWith('我') && raw.length === 2 ? '妈' : '妈妈';
      if (/^(?:我|我的|咱|咱们)?(?:老爸|爸|父亲)$/.test(raw)) return raw.startsWith('我') && raw.length === 2 ? '爸' : '爸爸';
      return raw.replace(/^(?:我|我的|咱|咱们)/, '');
    };
    const SELF_PREFIX = /^(?:而且|而|但|但是|另外|还有|然后|至于)?\s*(我自己|我本人|我们|我)(?![妈爸老媳丈公婆哥姐弟妹叔姨舅姑闺室发同朋儿女丈孩宝外爷奶])/;
    const NON_PERSON_BLACKLIST = new Set(['今天', '明天', '后天', '昨天', '前天', '刚才', '刚刚', '现在', '我们', '你们', '他们', '大家', '有人', '自己', '本人', '家里', '公司', '工作', '预算', '平时', '经常', '总是', '有时', '一直', '顺便', '另外', '还有', '如果', '并且', '然后', '但是', '至于', '而我', '但我']);

    const updatePersonInfo = (name: string, restInfo: string) => {
      let person = life.persons.find(item => item.name === name || item.name === `我${name}` || item.name.replace(/^我/, '') === name);
      if (!person) {
        person = { id: newId('person'), name, relation: '亲友', taboos: [], preferences: [], updatedAt: Date.now() };
        life.persons.push(person);
      }
      let updated = false;

      const allergyMatch = restInfo.match(/^(?:对\s*([^，,。！？]+?)\s*过敏|([^，,。！？]{1,8}?)\s*过敏)/);
      if (allergyMatch) {
        const val = (allergyMatch[1] || allergyMatch[2]).trim() + '过敏';
        if (!person.taboos.includes(val)) { person.taboos.push(val); updated = true; }
      }
      const notEatMatch = restInfo.match(/^(?:不吃|不能吃|忌口|不喝|不能喝|不碰|戒了?)\s*([^，,。！？]+)/);
      if (notEatMatch) {
        const val = '不吃' + notEatMatch[1].trim();
        if (!person.taboos.includes(val)) { person.taboos.push(val); updated = true; }
      }
      const hateMatch = restInfo.match(/^(?:讨厌|最烦|最怕)\s*([^，,。！？]+)/);
      if (hateMatch) {
        const val = '讨厌' + hateMatch[1].trim();
        if (!person.taboos.includes(val)) { person.taboos.push(val); updated = true; }
      }

      const likeMatch = restInfo.match(/^(?:喜欢|爱吃|爱喝|最爱|偏好|偏爱|爱)\s*([^，,。！？]+)/);
      if (likeMatch) {
        const val = '喜欢' + likeMatch[1].trim();
        if (!person.preferences.includes(val)) { person.preferences.push(val); updated = true; }
      }
      const wantMatch = restInfo.match(/^(?:想要|想买)\s*([^，,。！？]+)/);
      if (wantMatch) {
        const val = '想要' + wantMatch[1].trim();
        if (!person.preferences.includes(val)) { person.preferences.push(val); updated = true; }
      }

      const dateMatch = restInfo.match(/^(?:生日|纪念日)\s*(?:是|在)?\s*([^，,。！？]+)/);
      if (dateMatch) {
        person.nextImportantDate = dateMatch[1].trim();
        updated = true;
      }

      if (updated) {
        person.updatedAt = Date.now();
        touchedPersons.add(person.name);
      }
    };

    const touchedPersons = new Set<string>();

    for (const rawCl of facts) {
      if (bookedClauses.has(rawCl)) continue;
      if (/(?:预算|项目|张总|李总|王总|陈姐|合同额|报价|工作|存入|攒了|花了|买了|打车|发工资)/.test(rawCl)) continue;
      let cl = rawCl.replace(/^(?:记一下|记住|备忘|提醒我(?:记住)?|顺便说一下|还有|另外|而且|而|但|但是|然后|至于|其实|平时|今天|昨天|刚才|顺便)[，,：:\s]*/, '').trim();
      if (!cl) continue;

      // 1. 已知亲友称谓
      const kinMatch = cl.match(KIN_REGEX);
      if (kinMatch) {
        const personName = normalizeKin(kinMatch[0]);
        let rest = cl.slice(kinMatch[0].length).trim();
        rest = rest.replace(/^(?:还|也|又|其实|平时|经常|特别|很|十分|最|比较|超级|极其|一直|就|都)+/, '').trim();
        updatePersonInfo(personName, rest);
        continue;
      }

      // 2. 专属排他习惯与偏好（如“我喝咖啡只喝无糖拿铁”或“喝咖啡只喝无糖拿铁”）
      const scopedMatch = cl.match(/(?:(?:我|平时|自己)\s*)?([^\s，,。；！？]+?)\s*(?:只喝|只要|只吃|只用|只选|只买|不吃|不喝|不放|不要|偏好|最爱)\s*([^\s，,。；！？]+)/);
      if (scopedMatch) {
        const fullPref = cl.replace(/^(?:记一下|记住|还有|另外|顺便)[，,：:\s]*/, '').trim();
        if (fullPref.length >= 3 && !/^\d+$/.test(fullPref)) {
          pushLifeMem('我', '个人喜好与偏好', `我${fullPref.replace(/^我/, '')}`, 'preference', 4);
          continue;
        }
      }

      // 3. 主语为【我】（通用偏好、禁忌）
      const selfMatch = cl.match(SELF_PREFIX);
      if (selfMatch) {
        let restSelf = cl.slice(selfMatch[0].length).trim();
        restSelf = restSelf.replace(/^(?:还|也|又|其实|平时|经常|特别|很|十分|最|比较|超级|极其|一直|就|都)+/, '').trim();
        
        const prefMatch = restSelf.match(/^(?:特别?|极其|最|一直|比较)?\s*(喜欢|爱吃|爱喝|最爱|偏爱|偏好|想要|讨厌|最烦|最怕|不吃|不能吃|不喝|不能喝|只吃|只喝|只选|只买|只用|只看|不要|不碰|忌口|对.+?过敏|从不(?:吃|喝|碰)?)\s*(.+)/);
        if (prefMatch) {
          const verb = prefMatch[1];
          const content = prefMatch[2].replace(/[，,。！？\s]+$/, '').trim();
          if (content && content.length >= 2 && !/^\d+$/.test(content)) {
            const isTaboo = /讨厌|最烦|最怕|不吃|不能吃|不喝|不能喝|不要|不碰|忌口|过敏|从不/.test(verb);
            pushLifeMem('我', isTaboo ? '生活禁忌与不适' : '个人偏好与心愿', `我${verb}${content}`, 'preference', 4);
            continue;
          }
        }

        if (restSelf.length >= 3) {
          pushLifeMem('我', '个人喜好与偏好', `我${restSelf}`, 'preference', 4);
          continue;
        }
      }

      // 4. 作息生活规律（习惯）
      const habitMatch = rawCl.match(/(?:(?:我|平时|自己)\s*)?(?:习惯(?:于)?|每天|经常|通常|总是|每(?:周|天|月))\s*(.+)/);
      if (habitMatch) {
        const habitContent = habitMatch[1].replace(/[，,。！？\s]+$/, '').trim();
        if (habitContent && habitContent.length >= 3) {
          pushLifeMem('我', '作息与生活规律', `平时习惯${habitContent}`, 'habit', 4);
          continue;
        }
      }

      // 5. 自定义亲友姓名（如老王芒果过敏，排除以“我”开头和黑名单）
      const nameMatch = cl.match(/^([^我\s，,。！？\d]{2,4}?)\s*(?:还|也|又|其实|平时|经常|特别|很|十分|最|比较|超级|极其|一直|就|都)?\s*(?:对.+?过敏|[^，,。！？\s]{1,8}?过敏|不吃|不能吃|忌口|不喝|不能喝|不碰|戒了?|讨厌|最烦|最怕|喜欢|爱吃|爱喝|最爱|偏好|偏爱|想要|想买|生日|纪念日)/);
      if (nameMatch && !NON_PERSON_BLACKLIST.has(nameMatch[1])) {
        const personName = nameMatch[1];
        let restName = cl.slice(nameMatch[1].length).trim();
        restName = restName.replace(/^(?:还|也|又|其实|平时|经常|特别|很|十分|最|比较|超级|极其|一直|就|都)+/, '').trim();
        updatePersonInfo(personName, restName);
        continue;
      }

      // 6. 泛生活经验与备忘事实
      const factMatch = rawCl.match(/(?:记一下|记住|备忘|提醒我记住|千万别忘|家里|合同|密码|卡放在|地址是|停在)\s*[:：]?\s*(.+)/);
      if (factMatch) {
        const factContent = factMatch[1].replace(/[，,。！？\s]+$/, '').trim();
        if (factContent && factContent.length >= 3) {
          pushLifeMem('生活备忘', '重要生活事实', factContent, 'experience', 4);
        }
      }
    }

    // 亲友档案记忆同步与回执
    for (const name of touchedPersons) {
      receipt('relationships', `已记录 ${name} 的亲友资料`);
      const p = life.persons.find(item => item.name === name);
      if (p) {
        const subject = ['妈', '爸'].includes(p.name) ? `我${p.name}` : p.name;
        if (p.taboos?.length) {
          pushLifeMem(subject, '忌口与过敏', `【${subject}】忌口与雷区：${p.taboos.join('、')}`, 'person', 5);
        }
        if (p.preferences?.length) {
          pushLifeMem(subject, '喜好与偏好', `【${subject}】喜好与心愿：${p.preferences.join('、')}`, 'person', 4);
        }
        if (p.nextImportantDate) {
          pushLifeMem(subject, '重要日期', `【${subject}】重要日期或生日：${p.nextImportantDate}`, 'person', 5);
        }
      }
    }
    return receipts;
  },
  /** Compatibility for v3 migration/tests; the production UI uses the async repository. */
  sniffAndMutate(text: string, mode: WorkspaceMode, sourceMessageId?: string): StateMutationReceipt[] {
    if (mode !== 'life') return [];
    return StorageService.updateLifeAtomically(life => StateEngine.mutateLifeDraft(text, life), sourceMessageId);
  },
};
