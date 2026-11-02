import type {
  WorkspaceMode, StateMutationReceipt, ProposedChangeSet, WorkPartition, LifePartition, WorkOperation,
  Engagement, ProjectTaskItem, DealStage, ExpenseEntry, FollowUpItem,
} from '../types';
import { StorageService, newId, validateProposal } from './storage';
import { resolveDeadline, shanghaiDateKey } from './dates';
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
const CLIENT = /(?:[\u4e00-\u9fa5A-Za-z0-9]{1,12}?(?:工作室|科技|公司|集团|中心|研究院|研究所|事务所|医院|学校|大学|学院|银行|设计院))?[\u4e00-\u9fa5A-Za-z0-9]{1,5}?(?:总监|经理|主理人|老板|主任|院长|行长|会长|厂长|店长|处长|局长|科长|书记|教授|博士|老师|律师|顾问|合伙人|总|工|姐|哥|叔|姨|董)|[\u4e00-\u9fa5A-Za-z0-9]{1,12}?(?:工作室|科技|公司|集团|中心|研究院|研究所|事务所|设计院)/g;
const stripClientPrefix = (text: string) => text.replace(/^(?:(?:如果|假如|假设|今天|刚刚|另外|还有|新增客户|客户|新增|记一下|刚见完|刚见了|刚跟|刚和|刚才跟|拜访了|见了|跟|和|给|找|收到|把))+/, '').trim();

const UNCERTAIN = '还没确认|尚未确认|未确认|没有确认|待确认|未定|待定|暂定|先别定|还没拍板|尚未拍板|未拍板|可能|或许|也许|大概|左右';
function uncertaintyNear(text: string, subject: string): boolean {
  // Commas delimit independent facts: “还没成交，已确认预算” is not an uncertain budget.
  return text.split(/[，,；;。\n]/).some(clause =>
    new RegExp(`(?:${subject})[^，,；;。]{0,14}(?:${UNCERTAIN})|(?:${UNCERTAIN})[^，,；;。]{0,8}(?:${subject})`).test(clause));
}
export function budgetIsUncertain(text: string): boolean {
  return uncertaintyNear(text, '预算|金额|报价|合同额|总价|费用') || /(?:预算|金额|报价|合同额|总价)\s*(?:约|大概)/.test(text);
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
const ACTION = '完成|提交|交付|发送|补充|提供|回传|准备|确认|回复|跟进|联系|拜访|联调|汇报|演示|对齐|评审|修改|调整|优化|上线|部署|测试|验收|沟通|约见|打款|付款|开票|寄出|整理|输出|补|给|发|交|签|出|改|做|写|催|约';
const HAS_CLOCK = /\d{1,2}(?:[:：]\d{2}|点(?:半|\d{1,2}分?)?)/;

function parseUnitMultiplier(unitRaw: string, hasPrefixSymbol: boolean): number | undefined {
  const unit = (unitRaw || '').toLowerCase();
  if (!unit && !hasPrefixSymbol) return undefined;
  if (unit.startsWith('万') || unit.startsWith('w')) return 10000;
  if (unit.startsWith('千') || unit.startsWith('k')) return 1000;
  if (unit === '百') return 100;
  return 1;
}

function budget(text: string, warnings: string[]): number | undefined {
  if (budgetIsUncertain(text)) { warnings.push('预算金额尚未确认，未填写确定金额，请在预览中核对。'); return undefined; }
  const main = text.match(/(?:预算|金额|报价|合同额|合同金额|总价)\s*(?:从|是|为|在|约|大概|改为|调整为|定在|定为)?\s*([¥￥])?\s*(\d+(?:\.\d+)?)\s*(万元|万块|万|w元|w|千元|千块|千|k|块钱|块|元|rmb)?/i);
  const corrections = Array.from(text.matchAll(/(?:改为|改到|调整为|调整到|变为|增加到|加到|降到|批到了|批到|定在|定为|谈到)\s*([¥￥])?\s*(\d+(?:\.\d+)?)\s*(万元|万块|万|w元|w|千元|千块|千|k|块钱|块|元|rmb)?/gi));
  const match = corrections.at(-1) || main;
  if (!match) return undefined;
  const multiplier = parseUnitMultiplier(match[3] || '', !!match[1]);
  if (multiplier === undefined) { warnings.push('金额缺少单位，请补充元、万或 k 后重新整理，或在预览中手动核对。'); return undefined; }
  if (/约|大概|左右|区间|到\s*\d+\s*(?:万|元|k|w)/i.test(text) && !corrections.length) warnings.push('原文金额含近似表达，请确认该预算后再保存。');
  return +match[2] * multiplier;
}

function stageFrom(text: string, fallback: DealStage, warnings: string[]): DealStage {
  if (NEGATIVE.test(text) || HYPOTHETICAL.test(text)) {
    if (/成交|赢单|签|打款|回款/.test(text)) warnings.push('检测到否定或假设表述，未推进成交阶段。');
    return fallback;
  }
  if (/阶段\s*(?:为|是|改为|进入)?\s*赢单成交|(?:已经|已|正式|确认|成功)\s*(?:完成)?\s*(?:成交|赢单|签约|打款|回款|签合同)|成交了|合同签好了|已回款|已打款/.test(text)) return '赢单成交';
  if (/进入(?:了)?商务谈判|阶段\s*(?:为|是|改为)?\s*商务谈判|正在谈判|谈合同|商务推进/.test(text)) return '商务谈判';
  if (/阶段\s*(?:为|是|改为)?\s*方案报价|已经报价|已报价|已发方案|已发送报价|发了报价/.test(text)) return '方案报价';
  if (/需求确认|已确认需求|需求对齐|确认了需求/.test(text)) return '需求确认';
  if (/初步接触|刚认识|刚接触|初次沟通/.test(text)) return '初步接触';
  return fallback;
}

function classifyExpenseCategory(title: string): ExpenseEntry['category'] {
  if (/饭|面|粉|粥|饼|饺|包|咖啡|拿铁|美式|奶茶|果茶|茶|吃|喝|餐|早饭|早餐|午饭|午餐|晚饭|晚餐|夜宵|宵夜|下午茶|外卖|果|菜|肉|火锅|烧烤|烤肉|零食|甜品|蛋糕|面包|牛奶|水(?![杯费电])/.test(title)) return '餐饮☕';
  if (/车|打车|滴滴|地铁|公交|油|加油|停车|洗车|过路费|高铁|动车|火车|机票|飞机|打的|单车/.test(title)) return '出行🚕';
  if (/衣|裤|鞋|帽|包|表|水杯|杯|淘宝|京东|拼多多|超市|商场|日用|纸巾|洗发|护肤|面膜|化妆品|耳机|手机|电脑|键盘|鼠标|猫粮|狗粮|买/.test(title)) return '购物🛍️';
  if (/电影|游戏|玩|会员|票|演出|演唱会|KTV|桌游|密室|剧本杀|按摩|旅游|门票|麻将/.test(title)) return '娱乐🎮';
  return '生活🏠';
}

function parseChineseCount(raw?: string): number {
  if (!raw) return 1;
  if (/^\d+$/.test(raw)) return Math.max(1, +raw);
  const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return map[raw] || 1;
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
    const explicitNewName = context.newClientName?.trim();
    const singleNamedClient = new Set(findClients(text).map(item => item.name)).size === 1;
    let boundProjectId: string | undefined;
    const addOperation = (operation: WorkOperation) => {
      const existing = proposal.operations.find(item => item.target === operation.target && item.entityId === operation.entityId);
      if (existing) existing.after = operation.after as any;
      else proposal.operations.push(operation);
      const list: any[] = operation.target === 'engagement' ? working.engagements : operation.target === 'task' ? working.tasks : operation.target === 'followup' ? working.followUps : working.memories;
      const index = list.findIndex(item => item.id === operation.entityId);
      if (index >= 0) list[index] = operation.after;
      else if (operation.after) list.push(operation.after);
    };
    if (/午饭|早饭|晚饭|体重|饮水|小金库|亲友|妈妈|老婆/.test(text)) proposal.warnings.push('疑似生活内容仍保留在当前输入中，未跨区记账；可编辑或删除原文后再保存。');
    for (const paragraph of text.split(/[；;\n。]/).filter(item => item.trim())) {
      const clients = findClients(paragraph);
      const segments = clients.length ? clients.map((client, index) => ({ name: client.name,
        text: paragraph.slice(index === 0 ? 0 : client.start, clients[index + 1]?.start ?? paragraph.length) })) : [{ name: '', text: paragraph }];
      for (const segment of segments) {
        if (/如果|假如|假设|倘若/.test(segment.text) || /(?:可能|或许|也许|预计|有望).{0,8}(?:成交|赢单|签约|打款)/.test(segment.text)) { proposal.warnings.push('假设内容未作为事实提取，请补充已确认的信息。'); continue; }
        const selected = working.engagements.find(item => item.id === context.selectedEngagementId);
        const candidates = segment.name ? working.engagements.filter(item => item.clientName === segment.name || item.clientName.includes(segment.name)) : [];
        const explicitTitle = segment.text.match(/(?:项目名称|项目名|项目叫|项目为)\s*(?:为|是|叫|[:：])?\s*[「《“]?([^，,；。》”」]{1,30})/)?.[1]?.trim();
        let before: Engagement | null = null;
        if (boundProjectId && (!segment.name || segment.name === explicitNewName)) before = working.engagements.find(item => item.id === boundProjectId) || null;
        else if (selected && (!segment.name || selected.clientName.includes(segment.name))) before = selected;
        else if (explicitTitle && candidates.some(item => item.title === explicitTitle)) before = candidates.find(item => item.title === explicitTitle)!;
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
        if ((singleNamedClient && segment.name) || (!before && explicitNewName && clientName === explicitNewName)) boundProjectId = engagement.id;
        if (explicitTitle) engagement.title = explicitTitle;
        if (amount !== undefined) engagement.budgetAmount = amount;
        engagement.stage = stageFrom(segment.text, engagement.stage, proposal.warnings);
        const contextMatch = segment.text.match(/(?:痛点是|诉求是|需求是|想做|需要做|目标是)([^，,；。]+)/);
        if (contextMatch) engagement.internalContext = contextMatch[1].trim();
        const addFollowUp = (kind: FollowUpItem['kind'], title: string, dateText?: string) => {
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
        const clauses = segment.text.split(/[，,]/).map(item => item.trim()).filter(Boolean);
        for (const [clauseIndex, clause] of clauses.entries()) {
          const own = /^(?:我方|我们|我|乙方)/.test(clause);
          const customer = /^(?:客户|对方|甲方|他|她|他们|她们)/.test(clause) || ((clauseIndex > 0 || /(?:^|[，,])我(?:方|们)?/.test(paragraph)) && clause.startsWith(clientName)) ||
            new RegExp(`^${clientName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:负责|会|将|需要|要)`).test(clause);
          const unclearOwner = RESPONSIBILITY_UNCERTAIN.test(segment.text) && !own && !customer;
          const taskPattern = new RegExp(`(${DATE}${CLOCK})前?\\s*(?:要|需要|必须|得|先)?\\s*(${ACTION})([^，,；。]+)`, 'g');
          for (const match of clause.matchAll(taskPattern)) {
            const title = `${match[2]}${match[3]}`.trim();
            if (unclearOwner) { addFollowUp('question', `确认由谁${title}`); continue; }
            if (customer) { addFollowUp('waiting', title, match[1]); continue; }
            const resolved = dateIsUncertain(segment.text) ? { warning: '日期或时间尚未确认，行动保留但未设置提醒时间。', dueAt: undefined } : resolveDeadline(match[1], now);
            if (resolved.warning) proposal.warnings.push(resolved.warning);
            const task: ProjectTaskItem = { id: newId('task'), title, assignee: '我', deadline: match[1], sourceDeadlineText: match[1],
              priority: 'medium', done: false, engagementId: engagement.id, ...(resolved.dueAt ? { dueAt: resolved.dueAt } : {}) };
            engagement.nextAction = `${match[1]} ${title}`;
            addOperation({ target: 'task', entityId: task.id, before: null, after: task });
            if (resolved.warning) addFollowUp('question', `确认${title}的时间`);
          }
          if ((customer || own) && !new RegExp(DATE).test(clause)) {
            const action = clause.match(new RegExp(`(?:负责|会|将|需要|要)?\\s*(${ACTION})([^，,；。]+)`));
            if (action && !/未定|没确定|没确认|不确定|不提供|不会/.test(clause)) {
              const title = `${action[1]}${action[2]}`.trim();
              if (customer) addFollowUp('waiting', title);
              else { const id = newId('task'); addOperation({ target: 'task', entityId: id, before: null, after: { id, title, assignee: '我', deadline: '', priority: 'medium', done: false, engagementId: engagement.id } }); }
            }
          }
          if (/(?:费用|预算|报价|金额|价格|尾款|合同额)/.test(clause) && /未定|待定|没(?:有)?(?:谈定|确定|确认)|尚未|待确认|不确定|先别定|还没拍板|未拍板/.test(clause)) addFollowUp('question', clause);
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
    if (!proposal.operations.some(operation => operation.target === 'followup')) return validateProposal(proposal, partition);
    if (proposal.mode !== 'work' || !Array.isArray(proposal.warnings) || proposal.warnings.some(item => typeof item !== 'string') || !Number.isFinite(proposal.createdAt)) return ['变更格式或所属空间无效。'];
    const work = partition as WorkPartition;
    return validateTransaction({ op: 'transaction', space: 'work', id: proposal.id, sourceMessageId: proposal.sourceMessageId, sourceText: proposal.sourceText,
      baseRevision: proposal.baseRevision, mutations: proposal.operations.map(operation => ({ kind: operation.target, id: operation.entityId, before: operation.before, after: operation.after })) },
      partition.revision, (kind: string, id: string) => (kind === 'engagement' ? work.engagements : kind === 'task' ? work.tasks : kind === 'followup' ? work.followUps || [] : work.memories).find(item => item.id === id) || null);
  },

  /** Mutates only the caller's detached draft. The repository commits it atomically. */
  mutateLifeDraft(text: string, life: LifePartition): StateMutationReceipt[] {
    if (!text.trim()) return [];
    const receipts: StateMutationReceipt[] = [];
    const receipt = (targetCardType: StateMutationReceipt['targetCardType'], summaryText: string) => receipts.push({
      id: newId('receipt'), mode: 'life', targetCardType, targetCardTitle: '生活记录', summaryText, deltaBadge: '已记录', timestamp: Date.now(),
    });
    const clean = text.trim();

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
    const save = clean.match(/(?:存入|存了?|攒了?|存进|小金库\s*(?:加|存|\+|入了?)?)\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元)?/i);
    if (save) {
      const unit = (save[2] || '').toLowerCase();
      const mult = unit === '万' || unit === 'w' ? 10000 : unit === '千' || unit === 'k' ? 1000 : 1;
      const amount = +save[1] * mult;
      const primaryWish = syncWishProgress(amount);
      wallet.entries.push({ id: newId('expense'), title: '心愿金库存入', amount, type: 'saving', category: '金库✨', timestamp: Date.now() });
      receipt('wallet', `已记录心愿存入 ¥${amount}（${primaryWish ? primaryWish.title : '心愿金库'}）`);
    }

    // 3. 收入记录（发工资 / 兼职 / 报销 / 红包 / 入账 / 挣了 / 赚了，无需强制写“元/块”）
    const incomeMatch = clean.match(/(?:(发工资|工资|兼职|报销|红包|奖金|退款|退税|外快|副业)\s*(?:发了|到了|到账|收到|入账|进账|赚了?|挣了?|有|是)?|(?:收到|入账|进账|赚了?|挣了?|收入)\s*([^\d，,。；！？\s]{0,8}?))\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元)?/i);
    if (incomeMatch) {
      const title = (incomeMatch[1] || incomeMatch[2] || '日常收入').trim() || '日常收入';
      const unit = (incomeMatch[4] || '').toLowerCase();
      const mult = unit === '万' || unit === 'w' ? 10000 : unit === '千' || unit === 'k' ? 1000 : 1;
      const amount = +incomeMatch[3] * mult;
      wallet.entries.push({ id: newId('expense'), title, amount, type: 'income', category: '金库✨', timestamp: Date.now() });
      const primaryWish = syncWishProgress(amount);
      receipt('wallet', `已记录收入 ${title} ¥${amount}，已存入心愿金库（${primaryWish ? primaryWish.title : '心愿金库'}）`);
    }

    // 4. 消费记账（支持无单位如“今天花了30”、“买水杯60”、“花了30买水杯”、“早饭15”、“打车28”等全部日常口语）
    const clauses = clean.split(/[，,。；;！？!\n]+/).map(s => s.trim()).filter(Boolean);
    for (const clause of clauses) {
      // 跳过已作为心愿存入、收入、自定义卡目标、体重、饮水、睡眠或商务预算的子句
      if (/(?:存入|存了?|攒了?|存进|小金库|发工资|工资|报销|收到红包|入账|进账|赚了?|挣了?|收入|目标\s*\d+|体重|称重|上称|预算|报价|王总|李总)/.test(clause)) continue;
      if (/^\d+(?:\.\d+)?\s*(?:kg|公斤|千克|斤)$/i.test(clause)) continue;
      if (/(?:喝了?|炫了?|补)\s*(?:\d+|[一二两三四五六七八九十])?\s*(?:杯|瓶|毫升|ml)\s*水?/i.test(clause)) continue;
      if (/睡了?\s*\d+(?:\.\d+)?\s*(?:个?小时|h)/i.test(clause)) continue;

      let title = '';
      let amountNum = NaN;
      let unitRaw = '';

      // 句式 A: [前缀/时间/项目] + (花了/付了/消费/支出/花费/用了/刷了/扣了) + [金额] + [单位]? + [去买/吃/喝/项目]?
      // 例: "今天花了30", "花了30买水杯", "午饭花了35", "付了28打车"
      const verbFirst = clause.match(/^(.*?)\s*(?:花了?|付了?|消费了?|支出了?|花费了?|用了?|刷了?|扣了?)\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元|米|大洋|rmb)?\s*(.*)$/i);
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
        const actionOrScene = clause.match(/^(?:今天|刚刚|刚才|昨晚|昨天|早上|上午|中午|下午|晚上|顺便|另外|还有|又|我|去)*\s*((?:买了?|吃了?|喝了?|点了?|交了?|充了?|刷了?|打车|滴滴|坐车|地铁|公交|加油|停车|洗车|早饭|早餐|午饭|午餐|晚饭|晚餐|夜宵|宵夜|下午茶|咖啡|拿铁|美式|奶茶|果茶|水果|零食|买菜|超市|外卖|快递|话费|水费|电费|燃气|网费|房租|物业|电影|理发|挂号|买药|淘宝|京东|拼多多)[^\d，,。；！？]{0,12}?)\s*(?:一共|总共|共|是)?\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元|米|大洋|rmb)?$/i);
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
        receipt('wallet', `已记录 ${cleanTitle} ¥${finalAmount}`);
      }
    }

    // 5. 身体状态栏：体重、饮水、疲劳与运动恢复
    const rpg = life.rpg;
    if (rpg.dateKey !== shanghaiDateKey()) { rpg.waterCups = 0; rpg.dateKey = shanghaiDateKey(); }

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

    // 饮水：支持 "喝水"、"喝了2杯水"、"喝了两杯水"、"喝水3杯"、"喝了500ml水"、"补水"
    const waterMatch = clean.match(/(?:喝了?|炫了?|干了?|来)\s*(?:(\d+|[一二两三四五六七八])\s*(?:杯|瓶)|(\d{3,4})\s*(?:ml|毫升))?\s*(?:温开水|矿泉水|白开水|柠檬水|水)|(?:喝水|饮水|补水)\s*(?:(\d+|[一二两三四五六七八])\s*(?:杯|瓶))?/i);
    if (waterMatch) {
      let cups = 1;
      if (waterMatch[1] || waterMatch[3]) cups = parseChineseCount(waterMatch[1] || waterMatch[3]);
      else if (waterMatch[2]) cups = Math.max(1, Math.round(+waterMatch[2] / 250));
      rpg.waterCups = Math.min(8, rpg.waterCups + cups);
      const energyGain = cups * 4;
      rpg.energy = Math.min(100, rpg.energy + energyGain);
      rpg.moodBuff = '补充水分，状态充沛';
      receipt('rpg_status', `今日饮水 ${rpg.waterCups}/8 杯，精力 +${energyGain}`);
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
          (existing as any).updatedAt = Date.now();
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

    for (const rawCl of clauses) {
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
