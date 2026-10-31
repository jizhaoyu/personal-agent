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
const DATE = '(?:\\d{4}[年\\-/]\\d{1,2}[月\\-/]\\d{1,2}[日号]?|\\d{1,2}月\\d{1,2}[日号]|下周[一二三四五六日天]|本周[一二三四五六日天]|这周[一二三四五六日天]|周[一二三四五六日天]|明天|后天|今天|月底|\\d{1,2}号)';
const CLOCK = '(?:\\s*(?:上午|下午|晚上)?\\s*\\d{1,2}(?:[:：]\\d{2}|点(?:\\d{1,2}分?)?))?';
const NEGATIVE = /还没|尚未|未能|没有|不是|并非|未进入|不曾|未成交|未签|没签|没成交|未打款/;
const HYPOTHETICAL = /如果|假如|假设|倘若|可能|或许|也许|预计|有望/;
const CLIENT = /(?:[\u4e00-\u9fa5A-Za-z0-9]{1,12}?(?:工作室|科技|公司|集团))?[\u4e00-\u9fa5A-Za-z0-9]{1,5}?(?:总监|经理|主理人|老板|总)|[\u4e00-\u9fa5A-Za-z0-9]{1,12}?(?:工作室|科技|公司|集团)/g;
const stripClientPrefix = (text: string) => text.replace(/^(?:(?:如果|假如|假设|今天|刚刚|另外|还有|新增客户|客户|新增|记一下|刚见完|刚见了|刚跟|刚和|刚才跟|拜访了|见了|跟|和|给|找|收到|把))+/, '').trim();

const UNCERTAIN = '还没确认|尚未确认|未确认|没有确认|待确认|未定|待定|暂定|先别定|还没拍板|尚未拍板|未拍板|可能|或许|也许|大概|左右';
function uncertaintyNear(text: string, subject: string): boolean {
  // Commas delimit independent facts: “还没成交，已确认预算” is not an uncertain budget.
  return text.split(/[，,；;。\n]/).some(clause =>
    new RegExp(`(?:${subject})[^，,；;。]{0,14}(?:${UNCERTAIN})|(?:${UNCERTAIN})[^，,；;。]{0,8}(?:${subject})`).test(clause));
}
export function budgetIsUncertain(text: string): boolean {
  return uncertaintyNear(text, '预算|金额|报价') || /(?:预算|金额|报价)\s*(?:约|大概)/.test(text);
}
export function dateIsUncertain(text: string): boolean {
  return uncertaintyNear(text, '时间|日期|时刻|期限|截止|交付时间') || /(?:暂定|可能|或许|也许)\s*(?:明天|后天|今天|下?周|本周|月底|\d{1,2}月|\d{4}年)/.test(text);
}

function findClients(text: string): { name: string; start: number }[] {
  return Array.from(text.matchAll(new RegExp(CLIENT.source, 'g'))).map(match => ({ name: stripClientPrefix(match[0]), start: match.index! }))
    .filter(item => item.name && !['预算', '总计', '总共', '合同', '总金额'].includes(item.name));
}
export const extractClientNames = (text: string): string[] => [...new Set(findClients(text).map(item => item.name))];
const RESPONSIBILITY_UNCERTAIN = /(?:负责人|责任人|谁来|谁负责|归属|由谁).{0,10}(?:未定|待定|没确定|没确认|不明确)|(?:未定|待定|没确定|没确认).{0,8}(?:负责人|责任人)/;
const ACTION = '完成|提交|交付|发送|补充|提供|回传|准备|确认|回复|跟进|联系|拜访|联调|补|给|发|交|签';
const HAS_CLOCK = /\d{1,2}(?:[:：]\d{2}|点(?:\d{1,2}分?)?)/;
function budget(text: string, warnings: string[]): number | undefined {
  if (budgetIsUncertain(text)) { warnings.push('预算金额尚未确认，未填写确定金额，请在预览中核对。'); return undefined; }
  const main = text.match(/(?:预算|金额|报价)\s*(?:从|是|为|在|约|大概|改为|调整为)?\s*(\d+(?:\.\d+)?)\s*(万|元|块|w|k)?/i);
  const corrections = Array.from(text.matchAll(/(?:改为|改到|调整为|调整到|变为|增加到|加到|降到|批到了|批到)\s*(\d+(?:\.\d+)?)\s*(万|元|块|w|k)?/gi));
  const match = corrections.at(-1) || main;
  if (!match) return undefined;
  if (!match[2]) { warnings.push('金额缺少单位，请补充元、万或 k 后重新整理，或在预览中手动核对。'); return undefined; }
  if (/约|大概|左右|区间|到\s*\d+\s*(?:万|元)/.test(text) && !corrections.length) warnings.push('原文金额含近似表达，请确认该预算后再保存。');
  const value = +match[1];
  const unit = match[2].toLowerCase();
  return value * (unit === '万' || unit === 'w' ? 10000 : unit === 'k' ? 1000 : 1);
}
function stageFrom(text: string, fallback: DealStage, warnings: string[]): DealStage {
  if (NEGATIVE.test(text) || HYPOTHETICAL.test(text)) {
    if (/成交|赢单|签|打款/.test(text)) warnings.push('检测到否定或假设表述，未推进成交阶段。');
    return fallback;
  }
  if (/阶段\s*(?:为|是|改为|进入)?\s*赢单成交|(?:已经|已|正式|确认|成功)\s*(?:完成)?\s*(?:成交|赢单|签约|打款|签合同)|成交了|合同签好了/.test(text)) return '赢单成交';
  if (/进入(?:了)?商务谈判|阶段\s*(?:为|是|改为)?\s*商务谈判|正在谈判/.test(text)) return '商务谈判';
  if (/阶段\s*(?:为|是|改为)?\s*方案报价|已经报价|已发方案|已发送报价/.test(text)) return '方案报价';
  if (/需求确认|已确认需求/.test(text)) return '需求确认';
  if (/初步接触|刚认识|刚接触/.test(text)) return '初步接触';
  return fallback;
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
        const contextMatch = segment.text.match(/(?:痛点是|诉求是|需求是|想做)([^，,；。]+)/);
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
          if (/(?:费用|预算|报价|金额|价格)/.test(clause) && /未定|待定|没(?:有)?(?:谈定|确定|确认)|尚未|待确认|不确定|先别定|还没拍板|未拍板/.test(clause)) addFollowUp('question', clause);
          if (/(?:预算|报价|金额|费用)\s*\d+(?:\.\d+)?\s*$/.test(clause)) addFollowUp('question', `确认${clause}的金额单位`);
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
    const customMatch = clean.match(/(?:建一张|新建|创建|生成一张)\s*《?([^》”"\s]{2,14}?)》?\s*(?:卡|看板|面板)/);
    if (customMatch) {
      const target = +(clean.match(/目标\s*(\d+)/)?.[1] || 100);
      if (target > 0) {
        const cards = life.customCards;
        cards.push({ id: newId('custom'), mode: 'life', title: customMatch[1], icon: '🌱', metricLabel: '进度', metricValue: 0,
          metricTarget: target, unit: '次', checklist: [] });
        receipt('custom', `已创建「${customMatch[1]}」生活卡`);
      }
    }
    const wallet = life.wallet;
    const save = clean.match(/(?:存入|攒了|存进|小金库加)\s*(\d+(?:\.\d+)?)\s*(?:块|元)?/);
    if (save) {
      const amount = +save[1]; wallet.wishSaved += amount;
      wallet.entries.push({ id: newId('expense'), title: '心愿金库存入', amount, type: 'saving', category: '金库✨', timestamp: Date.now() });
      receipt('wallet', `已记录心愿存入 ¥${amount}`);
    }
    for (const match of clean.matchAll(/([^，,。；！？\d]{1,10}?)\s*(?:花了|吃了|买了|付了|消费|喝了)?\s*(\d+(?:\.\d+)?)\s*(?:块钱|块|元)/g)) {
      const title = match[1].replace(/^(今天|刚刚|刚才|顺便|另外|还有|又)/, '').trim() || '日常消费';
      if (/预算|金额|报价|存入|攒|客户|王总|李总/.test(title)) continue;
      let category: ExpenseEntry['category'] = '生活🏠';
      if (/饭|面|咖啡|拿铁|奶茶|吃|喝|餐|果|菜/.test(title)) category = '餐饮☕';
      else if (/车|地铁|公交|油|高铁|机票/.test(title)) category = '出行🚕';
      else if (/衣|鞋|包|淘宝|京东|超市/.test(title)) category = '购物🛍️';
      else if (/电影|游戏|玩|会员|票/.test(title)) category = '娱乐🎮';
      wallet.entries.push({ id: newId('expense'), title, amount: +match[2], type: 'expense', category, timestamp: Date.now() });
      receipt('wallet', `已记录 ${title} ¥${match[2]}`);
    }
    const rpg = life.rpg;
    if (rpg.dateKey !== shanghaiDateKey()) { rpg.waterCups = 0; rpg.dateKey = shanghaiDateKey(); }
    const weight = clean.match(/体重\s*(?:是|到了|降到|涨到)?\s*(\d{2,3}(?:\.\d+)?)\s*(kg|公斤|斤)?/i);
    if (weight) { rpg.weightKg = +weight[1] / (weight[2] === '斤' ? 2 : 1); receipt('rpg_status', `用户自报体重 ${rpg.weightKg}kg`); }
    if (/喝了?水|喝了?一杯|补水/.test(clean)) { rpg.waterCups = Math.min(8, rpg.waterCups + 1); receipt('rpg_status', `今日饮水 ${rpg.waterCups}/8 杯`); }
    if (/熬夜|失眠|好累|太累|没睡好|疲惫/.test(clean)) { rpg.energy = Math.max(0, rpg.energy - 18); rpg.moodBuff = '用户自报疲惫'; receipt('rpg_status', '已记录自报状态：疲惫'); }
    if (/跑步|健身|运动|睡了个好觉|满血复活/.test(clean)) {
      const today = shanghaiDateKey();
      if (rpg.lastActivityDate !== today) {
        const yesterday = shanghaiDateKey(Date.now() - 86400000);
        rpg.streakDays = rpg.lastActivityDate === yesterday ? rpg.streakDays + 1 : 1;
        rpg.lastActivityDate = today; rpg.energy = Math.min(100, rpg.energy + 20);
      }
      rpg.moodBuff = '用户自报活动 / 恢复'; receipt('rpg_status', `今日活动已记录，连续 ${rpg.streakDays} 天`);
    }
    const personMatch = clean.match(/(?:记一下[，,]?)?([^\s，。！？、“”]{2,5}?)(?:对([^，。！？]+?)过敏|不吃([^，。！？]+)|讨厌([^，。！？]+)|喜欢([^，。！？]+)|生日是([^，。！？]+))/);
    if (personMatch && !['我', '今天', '刚刚', '我们'].includes(personMatch[1])) {
      const persons = life.persons;
      let person = persons.find(item => item.name === personMatch[1]);
      if (!person) { person = { id: newId('person'), name: personMatch[1], relation: '亲友', taboos: [], preferences: [], updatedAt: Date.now() }; persons.push(person); }
      if (personMatch[2]) person.taboos = [...new Set([...person.taboos, `${personMatch[2]}过敏`])];
      if (personMatch[3]) person.taboos = [...new Set([...person.taboos, `不吃${personMatch[3]}`])];
      if (personMatch[4]) person.taboos = [...new Set([...person.taboos, `讨厌${personMatch[4]}`])];
      if (personMatch[5]) person.preferences = [...new Set([...person.preferences, `喜欢${personMatch[5]}`])];
      if (personMatch[6]) person.nextImportantDate = personMatch[6];
      person.updatedAt = Date.now(); receipt('relationships', `已记录 ${person.name} 的亲友资料`);
    }
    return receipts;
  },
  /** Compatibility for v3 migration/tests; the production UI uses the async repository. */
  sniffAndMutate(text: string, mode: WorkspaceMode, sourceMessageId?: string): StateMutationReceipt[] {
    if (mode !== 'life') return [];
    return StorageService.updateLifeAtomically(life => StateEngine.mutateLifeDraft(text, life), sourceMessageId);
  },
};
