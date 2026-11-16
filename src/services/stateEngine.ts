import type {
  WorkspaceMode, StateMutationReceipt, ProposedChangeSet, WorkPartition, LifePartition, WorkOperation,
  Engagement, ProjectTaskItem, DealStage, ExpenseEntry, FollowUpItem, ConditionIntent,
} from '../types';
import { StorageService, newId, validateProposal } from './storage';
import { resolveDeadline, shanghaiDateKey } from './dates';
import { routeLifeInput } from './lifeRouting';
import { tryApplySpokenCheckin } from './checkins';
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
const DATE = '(?:\\d{4}[年\\-/]\\d{1,2}[月\\-/]\\d{1,2}[日号]?|\\d{1,2}月\\d{1,2}[日号]?|(?:下周|本周|这周|周|下星期|本星期|这星期|星期|下礼拜|本礼拜|这礼拜|礼拜)[一二三四五六日天]|大后天|后天|明天|明早|明晚|今天|今晚|今日|(?:下|这|本)个?月底|月底|(?:下|这|本)个?月初|月初|月中|\\d{1,2}天(?:后|之后|内)|\\d{1,2}号)';
const CLOCK = '(?:\\s*(?:早上|上午|中午|下午|傍晚|晚上|凌晨)?\\s*(?:\\d{1,2}(?:[:：]\\d{2}|点(?:半|一刻|三刻|\\d{1,2}分?)?)|[一二两三四五六七八九十]{1,3}点(?:半|一刻|三刻)?))?';
const NEGATIVE = /还没|尚未|未能|没有|不是|并非|未进入|不曾|未成交|未签|没签|没成交|未打款/;
const HYPOTHETICAL = /如果|假如|假设|倘若|可能|或许|也许|预计|有望/;
const STRONG_HYPOTHETICAL = /如果|假如|假设|倘若/;
const WON_BLOCKER = /还没|尚未|未能|没有|不是|并非|没成交|未成交|未签|没签|未打款|可能|或许|也许|有望|预计|打算|计划|准备|下周|明天|后天/;
const CLIENT = /(?:[\u4e00-\u9fa5A-Za-z0-9]{1,12}?(?:工作室|科技|公司|集团|中心|研究院|研究所|事务所|医院|学校|大学|学院|银行|设计院)(?:[\u4e00-\u9fa5]{0,5}?|[A-Za-z][A-Za-z0-9._-]{0,15})?|(?:[\u4e00-\u9fa5]{1,5}?|[A-Za-z][A-Za-z0-9._-]{0,15}))(?:总监|经理|主理人|老板|主任|院长|行长|会长|厂长|店长|处长|局长|科长|书记|教授|博士|老师|律师|顾问|合伙人|师傅|女士|先生|总|工|姐|哥|叔|姨|董)|[\u4e00-\u9fa5A-Za-z0-9]{1,12}?(?:工作室|科技|公司|集团|中心|研究院|研究所|事务所|设计院)/g;
const EXPLICIT_PREFIXED_CLIENT_RE = /(?:新?客户)\s*([\u4e00-\u9fa5]{2,3})(?=[的，,。；;\s]|那边|这边|那头|这头|预算|报价|合同|项目|需求|说|表示|答应|确认|反馈|下周|明天|后天|今天)/g;
const ENGLISH_CLIENT_STOPWORDS = new Set([
  'UI', 'UX', 'API', 'SDK', 'PDF', 'PPT', 'DOC', 'DOCX', 'XLS', 'XLSX', 'APP', 'CRM', 'ERP', 'OA',
  'SAAS', 'PAAS', 'IAAS', 'RMB', 'USD', 'EUR', 'AI', 'IT', 'HR', 'QA', 'PM', 'RD', 'OP', 'OK',
  'VIP', 'SVIP', 'CEO', 'CTO', 'CFO', 'COO', 'VP', 'GM', 'BD', 'PR', 'SEO', 'SEM', 'H5', 'PC',
  'IOS', 'APK', 'EXE', 'SQL', 'HTTP', 'HTTPS', 'JSON', 'HTML', 'CSS', 'JS', 'TS', 'KTV', 'WIFI',
  'B2B', 'B2C', 'O2O', 'MVP', 'KPI', 'OKR', 'ROI', 'SLA', 'NDA', 'PO', 'RFQ', 'SOW', 'FAQ', 'TODO',
]);
const NON_CHINESE_CLIENT_NOUN_RE = /^(?:这边|那边|那头|这头|自己|本人|公司|单位|团队|领导|老板|经理|总监|专员|代表|姓名|名称|资料|材料|信息|需求|诉求|痛点|预算|报价|合同|订单|项目|款项|尾款|定金|预付款|问题|反馈|确认|表示|答应|承诺|说明|提到|今天|明天|后天|昨天|前天|本周|下周|这周|上周|本月|下月|月底|月初|上午|下午|晚上|早上|刚刚|刚才|已经|还没|没有|目前|现在|能否|是否|可以|如果|应该|大概|可能)/;
const stripClientPrefix = (text: string) => {
  let clean = text.replace(/^(?:(?:如果|假如|假设|今天|昨天|前天|明天|后天|刚刚|刚才|另外|还有|新增客户|客户|新增|记一下|刚见完|刚见了|刚跟|刚和|刚才跟|拜访了|见了|那单|这单|那笔|这笔|项目|合同|订单|跟|和|给|找|收到|把))+/, '').trim();
  if (!/(?:工作室|科技|公司|集团|中心|研究院|研究所|事务所|医院|学校|大学|学院|银行|设计院)/.test(clean)) {
    clean = clean.replace(/^.*?(?:发给|交给|补给|提供给|回传给|寄给|传给|送给|转给|报给|汇给|打给|留给|汇报给|转告|通知|联系|提醒|告诉|请示|询问|配合|协助|拜访|约见|见了|见一下|找一下|问一下|等|叫|让|请|给|向|找|跟|和|与|同|对|由|把|是|的|了|去|要|得|在|从|到|说|看|按|算)/, '').trim();
  }
  return clean;
};

export function normalizeGroupedNumbers(text: string): string {
  return text.replace(/\d{1,3}(?:[,，]\d{3})+(?:\.\d+)?/g, amount => amount.replace(/[,，]/g, ''));
}

function normalizeLifeClause(text: string): string {
  return normalizeGroupedNumbers(text.trim()).replace(/(\d+)块([0-9])(?:毛)?$/, '$1.$2元');
}

const UNCERTAIN = '还没确认|尚未确认|未确认|没有确认|待确认|还没确定|尚未确定|未确定|没有确定|还没定|尚未定|未定|没定|待定|暂定|先别定|还没拍板|尚未拍板|未拍板|还没敲定|尚未敲定|可能|或许|也许|大概|左右';
function uncertaintyNear(text: string, subject: string, extraUncertain = ''): boolean {
  // Commas delimit independent facts: “还没成交，已确认预算” is not an uncertain budget.
  const uncertainExpr = extraUncertain ? `${UNCERTAIN}|${extraUncertain}` : UNCERTAIN;
  return normalizeGroupedNumbers(text).split(/[，,；;。\n]/).some(clause =>
    new RegExp(`(?:${subject})[^，,；;。]{0,14}(?:${uncertainExpr})|(?:${uncertainExpr})[^，,；;。]{0,8}(?:${subject})`).test(clause));
}
export function budgetIsUncertain(text: string): boolean {
  const norm = normalizeGroupedNumbers(text);
  return uncertaintyNear(norm, '预算|金额|报价|合同额|总价|费用|单位', '还没说明白|没说明白|说不清|没说清|没说清楚|没写清')
    || /(?:预算|金额|报价|合同额|总价)\s*(?:约|大概|不是|并非)/.test(norm)
    || /(?:不是|并非)\s*[¥￥]?\s*(?:\d+(?:\.\d+)?|[一二两三四五六七八九十百千万]+)\s*(?:万元|万块|万|千元|千|块钱|块|元|w|k)?\s*(?:的)?(?:预算|金额|报价|合同额|总价)/i.test(norm)
    || /(?:万|千|百|块|元|[wk])\s*还是\s*(?:万|千|百|块|元|[wk])|(?:还没|没有|未|没)(?:说明白|说清|说清楚|讲清|讲明白|明确|写清).{0,10}(?:万|千|百|块|元|单位|金额)|(?:单位|金额单位).{0,8}(?:未定|待定|不明|不清|没说|没写|不确定)/i.test(norm)
    || /不要当真|别当真|不作数|不算数/.test(norm);
}
export function dateIsUncertain(text: string): boolean {
  return uncertaintyNear(
    text,
    '时间|日期|时刻|期限|截止|交付时间|具体几点|几点|哪天|哪一天|什么时候|何时',
    '再定|再说|以后再说|以后再定|没想好|还没想好|没定好|还没说|没说定|未说明|不定',
  ) || /(?:暂定|可能|或许|也许)\s*(?:明天|后天|大后天|今天|下?周|本周|下?星期|下?礼拜|月底|月初|\d{1,2}月|\d{4}年)/.test(text);
}

const BARE_BUDGET_QUALIFIER_RE = /^(?:但是|不过|只是|目前|现在|暂时|先)?(?:(?:这个|这笔|该|上述)?(?:预算|金额|报价|价格|总价|合同额|费用|单位|数(?:字|额)?)\s*(?:还)?(?:没|未|待|暂|不)|(?:我们|我方|客户|对方|双方)?\s*(?:目前|现在|暂时|先)?(?:还没|尚未|未|没有)(?:定|确定|确认|拍板|敲定|说清|说明白|讲清)|(?:具体)?单位(?:还)?(?:没|未|不清|没说)|(?:这个数|这数|这笔钱)?(?:先)?(?:不要当真|别当真|不作数|不算数)|(?:还)?(?:没|未)说明白|(?:是)?(?:万|千|百|块|元|[wk])\s*还是\s*(?:万|千|百|块|元|[wk]))/i;
const BARE_DATE_QUALIFIER_RE = /^(?:但是|不过|只是|目前|现在|暂时|先)?(?:(?:(?:具体|准确)?(?:时间|日期|时刻|期限|截止时间|交付时间|具体几点|几点|哪天|哪一天|什么时候|何时)|(?:这事|这个|那个)?(?:时间|日期))(?:还)?(?:没|未|待|暂|再|不|可能)|(?:再定|再说|以后再定|以后再说|没定|待定|暂定|还没定|还没确定|还没想好|不确定|可能调整|不一定)$)/;

function isClauseDateUncertain(clauses: string[], index: number): boolean {
  const clause = clauses[index] || '';
  if (dateIsUncertain(clause)) return true;
  const next = (clauses[index + 1] || '').trim();
  return Boolean(next && BARE_DATE_QUALIFIER_RE.test(next) && dateIsUncertain(next));
}

function splitActiveClauses(text: string): { activeClauses: string[]; hasStrongHypothetical: boolean; hasAnyHypothetical: boolean } {
  const rawClauses = normalizeGroupedNumbers(text).split(/[，,；;。\n]/).map(s => s.trim()).filter(Boolean);
  const activeClauses: string[] = [];
  let hasStrongHypothetical = false;
  let hasAnyHypothetical = false;
  let conditionalConsequent = false;
  for (const clause of rawClauses) {
    if (STRONG_HYPOTHETICAL.test(clause)) {
      hasStrongHypothetical = true;
      hasAnyHypothetical = true;
      conditionalConsequent = true;
      continue;
    }
    if (conditionalConsequent && /^(?:就|那就|那么|便|则|我也|我就|客户就|对方就|我再|再)/.test(clause)) {
      hasStrongHypothetical = true;
      hasAnyHypothetical = true;
      conditionalConsequent = false;
      continue;
    }
    conditionalConsequent = false;
    if (HYPOTHETICAL.test(clause)) hasAnyHypothetical = true;
    activeClauses.push(clause);
  }
  return { activeClauses, hasStrongHypothetical, hasAnyHypothetical };
}

export function hasNonHypotheticalContent(text: string): boolean {
  const { activeClauses } = splitActiveClauses(text);
  return activeClauses.some(c => !/(?:可能会|或许会|也许会|有望)/.test(c));
}

export function hasHypotheticalFraming(text: string): boolean {
  return STRONG_HYPOTHETICAL.test(text) || /(?:可能|或许|也许|预计|有望)/.test(text);
}

export function hasWonStageBlocker(text: string): boolean {
  return WON_BLOCKER.test(text) || STRONG_HYPOTHETICAL.test(text);
}

const WON_CLAUSE_RE = /阶段\s*(?:为|是|改为|改到|更新为|更新到|调整为|调整到|进入|推进到|推进为|切换到|切到|变成|变为|定为)?\s*赢单成交|(?:已经|已|正式|确认|成功)\s*(?:完成)?\s*(?:成交|赢单|签约|打款|回款|签合同)|成交了|合同(?:已经|已)?签好了|签了合同|已回款|已打款|尾款(?:已经|已)?(?:收到|收到了|到账|打过来了|结清)/;

export function hasConfirmedWonClause(text: string): boolean {
  const { activeClauses } = splitActiveClauses(text);
  return activeClauses.some(clause =>
    !NEGATIVE.test(clause)
    && !HYPOTHETICAL.test(clause)
    && !/不要当真|别当真|不作数|不算数|不确定|未定|待定|谈不上|算不上|说不上/.test(clause)
    && (!(/(?:明天|后天|下周|下个月|本周|下礼拜|计划|打算|准备|争取|预计|有望)/.test(clause)) || /(?:已经|已|正式|签好了|签了合同|到账|收到)/.test(clause))
    && WON_CLAUSE_RE.test(clause),
  );
}

export function hasExplicitBudgetUnit(text: string): boolean {
  const norm = normalizeGroupedNumbers(text);
  return /(?:\d+(?:\.\d+)?|[一二三四五六七八九十百千万两零]+)\s*(?:万元?|万块|w元?|千元?|千块|k|百元?|块钱?|元|rmb)|[¥￥]\s*\d+/i.test(norm)
    || /\d+(?:\.\d+)?(?:万|千)(?:\d|[一二两三四五六七八九])/.test(norm)
    || /[一二两三四五六七八九十百千万]+(?:万|千)[一二两三四五六七八九]/.test(norm);
}

export function isScopedBudgetUncertain(text: string, candidateAmount?: number): boolean {
  const { activeClauses } = splitActiveClauses(text);
  let sawUncertain = false;
  let sawConfirmed = false;
  for (let i = 0; i < activeClauses.length; i++) {
    const clause = activeClauses[i];
    const nextClause = activeClauses[i + 1] || '';
    const nextBare = Boolean(nextClause && BARE_BUDGET_QUALIFIER_RE.test(nextClause) && budgetIsUncertain(nextClause));
    const hasBudgetMention = /(?:预算|金额|报价|合同额|合同金额|合同总价|总金额|总预算|总价|总额|总计)|[¥￥]|\d+(?:\.\d+)?\s*(?:万|千|块|元|[wk])/i.test(clause);
    if (!hasBudgetMention) continue;
    if (budgetIsUncertain(clause) || HYPOTHETICAL.test(clause) || nextBare) {
      sawUncertain = true;
      continue;
    }
    const localWarnings: string[] = [];
    const parsed = extractClauseBudget(clause, localWarnings);
    if (parsed !== undefined && (candidateAmount === undefined || parsed === candidateAmount)) {
      sawConfirmed = true;
    }
  }
  return sawUncertain && !sawConfirmed;
}

export function isItemDateUncertain(text: string, title?: string, dateExpr?: string): boolean {
  const { activeClauses } = splitActiveClauses(text);
  if (!activeClauses.length) return dateIsUncertain(text);
  const matchingIndexes: number[] = [];
  for (let i = 0; i < activeClauses.length; i++) {
    const clause = activeClauses[i];
    const hitsDateExpr = Boolean(dateExpr && clause.includes(dateExpr));
    const hitsTitle = Boolean(title && itemMatchesTitle(clause, title));
    if (hitsDateExpr || hitsTitle) matchingIndexes.push(i);
  }
  if (matchingIndexes.length > 0) {
    return matchingIndexes.some(idx => isClauseDateUncertain(activeClauses, idx));
  }
  const dateClauses = activeClauses
    .map((c, idx) => ({ c, idx }))
    .filter(({ c }) => new RegExp(DATE).test(c) || dateIsUncertain(c));
  if (!dateClauses.length) return dateIsUncertain(text);
  return dateClauses.every(({ idx }) => isClauseDateUncertain(activeClauses, idx));
}

const NON_CLIENT_PREFIX_RE = /^(?:那单|这单|那笔|这笔|那条|这条|那个|这个|那块|这块|那边|这边|那头|这头|哪单|哪个|哪位|每单|某单|项目|合同|订单|报价|预算|金额|价格|费用|尾款|预付款|首付款|定金|押金|税点|发票|总价|总额|总计|总共|总预算|总金额|汇总|合计|大概|大约|目前|现在|当前|原本|原来|本来|其实|实际|最终|最后|全部|整体|一共|共计|已经|还没|尚未|暂定|预计|可能|或许|也许|如果|假如|假设|今天|明天|后天|昨天|前天|本周|下周|这周|上周|本月|下月|月底|月初|上午|下午|晚上|早上|刚刚|刚才|一期|二期|三期|甲方|乙方|客户|对方|我们|我方|他们|她们)(?:总|工|姐|哥|叔|姨|董)$/;
const FAKE_GONG_RE = /(?:人|美|施|加|返|完|开|停|俊|竣|代|员|包|用|招|出|收|赶|抢|手|做|精|细|木|电|焊|钳|泥|瓦|杂|小|大|零|短|长|临|义|特|重|化|军|矿|窝|误|罢|复)工$/;
function findClients(text: string): { name: string; start: number }[] {
  const results: { name: string; start: number }[] = [];
  const seen = new Set<string>();
  const push = (name: string, start: number) => {
    const key = `${start}:${name}`;
    if (!seen.has(key)) { seen.add(key); results.push({ name, start }); }
  };
  for (const match of text.matchAll(new RegExp(CLIENT.source, 'g'))) {
    const raw = match[0];
    const name = stripClientPrefix(raw);
    if (!name || name.length < 2) continue;
    if (['预算', '总计', '总共', '合同', '总金额', '汇总', '总价', '总额', '总预算', '总费用'].includes(name)) continue;
    if (NON_CLIENT_PREFIX_RE.test(name)) continue;
    const after = text.slice(match.index! + raw.length);
    if (raw.endsWith('总')) {
      if (/^(?:价|额|共|计|金额|费用|包|承)/.test(after)) continue;
      if (/^(?:预算|报价|合同额|造价|成本|花费|结|算|体|之|是|得|归|账|款)/.test(after)) {
        const beforeTitle = name.slice(0, -1);
        if (/^[这那该此本其每某全共约超破近满达占算按是有的了为说看]$/.test(beforeTitle)) continue;
        if (beforeTitle.length >= 2 && !/^(?:老|小|大|阿)/.test(beforeTitle) && !/(?:工作室|科技|公司|集团|中心|研究院|研究所|事务所|医院|学校|大学|学院|银行|设计院)$/.test(beforeTitle)) {
          if (/^(?:预算|报价|合同额|造价|成本|花费)/.test(after) && /(?:说|看|有|是|的|了|为|把|将|给|按|算|定|做|这|那|该|此|本|全|整|合|共|总)/.test(beforeTitle)) continue;
        }
      }
    }
    if (raw.endsWith('工')) {
      if (FAKE_GONG_RE.test(name)) continue;
      if (!/^[\u4e00-\u9fa5]工$/.test(name) && /^(?:期|作|单|程|资|时|费|具|位|艺|序|厂|地|会|业|种|钱|价|款|方|队|量)/.test(after)) continue;
    }
    push(name, match.index!);
  }
  for (const match of text.matchAll(new RegExp(EXPLICIT_PREFIXED_CLIENT_RE.source, 'g'))) {
    const candidate = match[1];
    if (!candidate || NON_CHINESE_CLIENT_NOUN_RE.test(candidate) || /(?:总|工|姐|哥|叔|姨|董|生|士|师|理|监)$/.test(candidate)) continue;
    if (/^[说要会能想把给发补打签来去的和跟与]/.test(candidate)) continue;
    if (!results.some(r => r.name === candidate || r.name.includes(candidate))) {
      push(candidate, match.index!);
    }
  }
  const enPrefixRe = /(?:新?客户|拜访了?|约见了?|见了|联系|对接|跟|和|找|给)\s*([A-Z][A-Za-z0-9.-]{1,20}(?:\s+[A-Z][A-Za-z0-9.-]{1,15})?)/g;
  const enSuffixRe = /(?:^|[，,；;。\s])([A-Z][A-Za-z0-9.-]{1,20}(?:\s+[A-Z][A-Za-z0-9.-]{1,15})?)\s*(?:那边|这边|那头|的(?:项目|官网|小程序|系统|预算|报价|合同|需求|方案)|(?:项目|预算|报价|合同额|总价|需求|方案)|(?:刚才|刚刚|刚)?(?:说|表示|答应|确认|反馈|下周|明天|后天))/g;
  for (const re of [enPrefixRe, enSuffixRe]) {
    for (const match of text.matchAll(re)) {
      const cand = match[1].trim();
      if (!cand || cand.length < 2 || ENGLISH_CLIENT_STOPWORDS.has(cand.toUpperCase())) continue;
      if (results.some(r => r.name === cand || r.name.startsWith(cand))) continue;
      push(cand, match.index! + match[0].indexOf(cand));
    }
  }
  results.sort((a, b) => a.start - b.start);
  return results;
}
export const extractClientNames = (text: string): string[] => [...new Set(findClients(text).map(item => item.name))];
const RESPONSIBILITY_UNCERTAIN = /(?:负责人|责任人|谁来|谁负责|归属|由谁).{0,10}(?:未定|待定|没确定|没确认|不明确)|(?:未定|待定|没确定|没确认).{0,8}(?:负责人|责任人)/;
const BARE_RESP_UNCERTAIN = /^(?:具体)?(?:负责人|责任人|由谁来?负责|谁来负责|归属)(?:这边|那边)?(?:还)?(?:没定|没确定|没确认|未定|待定|不明确)$/;
const ACTION = '完成|提交|交付|发送|补充|提供|回传|准备|确认|回复|跟进|联系|拜访|联调|汇报|演示|对齐|评审|修改|调整|优化|上线|部署|测试|验收|沟通|约见|对接|协调|梳理|核对|核实|汇总|落实|拟定|起草|打款|付款|回款|转账|结款|开票|寄出|寄过来|发过来|盖章|走流程|过会|拍板|定下来|批下来|答复|通知|整理|输出|补齐|补交|回电话|回电|打电话|来电|补|给|发|交|签|出|改|做|写|催|约';
export const HAS_CLOCK = /\d{1,2}(?:[:：]\d{2}|点(?:半|一刻|三刻|\d{1,2}分?)?)|[一二两三四五六七八九十]{1,3}点(?:半|一刻|三刻)?/;
export function hasClockExpression(value: string): boolean { return HAS_CLOCK.test(value); }
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
  if (!/[\d零一二两三四五六七八九十]/.test(numRaw)) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(numRaw)) {
    const multiplier = parseUnitMultiplier(unitRaw, hasPrefixSymbol);
    return multiplier === undefined ? undefined : +numRaw * multiplier;
  }
  // Mixed digital + Chinese shorthand like 8万5 / 8万五 (85000), 8万5千 (85000), 1万2 (12000), 4千5 (4500)
  const digitalWan = numRaw.match(/^(\d+(?:\.\d+)?)万(.+)?$/);
  if (digitalWan) {
    const highVal = +digitalWan[1] * 10000;
    const tail = digitalWan[2] || '';
    if (!tail) return highVal;
    if (/^\d$/.test(tail)) return highVal + +tail * 1000;
    if (/^[一二两三四五六七八九]$/.test(tail)) return highVal + parseChineseSection(tail) * 1000;
    const tailUnit = tail.match(/^(\d+|[一二两三四五六七八九])(千|百)$/);
    if (tailUnit) {
      const n = /^\d+$/.test(tailUnit[1]) ? +tailUnit[1] : parseChineseSection(tailUnit[1]);
      return highVal + n * (tailUnit[2] === '千' ? 1000 : 100);
    }
    if (/^\d+$/.test(tail)) return highVal + +tail;
    return highVal + parseChineseSection(tail);
  }
  const digitalQian = numRaw.match(/^(\d+(?:\.\d+)?)千(.+)?$/);
  if (digitalQian) {
    const highVal = +digitalQian[1] * 1000;
    const tail = digitalQian[2] || '';
    if (!tail) return highVal;
    if (/^\d$/.test(tail)) return highVal + +tail * 100;
    if (/^[一二两三四五六七八九]$/.test(tail)) return highVal + parseChineseSection(tail) * 100;
    if (/^\d+$/.test(tail)) return highVal + +tail;
    return highVal + parseChineseSection(tail);
  }
  // Colloquial shorthand like 三万五 (35000), 十二万五 (125000), 四千五 (4500)
  const wanShort = numRaw.match(/^([零一二两三四五六七八九十百千]+)万([一二两三四五六七八九])$/);
  if (wanShort) return parseChineseSection(wanShort[1]) * 10000 + parseChineseSection(wanShort[2]) * 1000;
  const qianShort = numRaw.match(/^([一二两三四五六七八九])千([一二两三四五六七八九])$/);
  if (qianShort) return parseChineseSection(qianShort[1]) * 1000 + parseChineseSection(qianShort[2]) * 100;
  if (numRaw.includes('万')) {
    const [high, low] = numRaw.split('万');
    if (!high) return undefined;
    return parseChineseSection(high) * 10000 + (low ? parseChineseSection(low) : 0);
  }
  if (/[千百]/.test(numRaw)) return parseChineseSection(numRaw);
  const multiplier = parseUnitMultiplier(unitRaw, hasPrefixSymbol);
  if (multiplier === undefined) return undefined;
  return parseChineseSection(numRaw) * multiplier;
}

const BUDGET_VERB = '从|是|为|在|约|大概|改为|改到|改成|调整为|调整到|调为|调到|确定为|确定是|确认为|确认是|敲定为|敲定是|敲定在|更新为|更新到|定在|定为|定死在|定死为|锁在|锁死在|压到|压在|砍到|砍成|降到|降为|提到|提至|涨到|加到|增加到|变为|变成|批到了|批到|批了|谈到|谈到了|谈成|谈定为|谈定在';
const AMOUNT_TAIL_GUARD = '(?!\\s*(?:号|日|天|月|年|周|点|个|期|次|份|人))';
const AMOUNT_NUM = `(\\d+(?:\\.\\d+)?(?:万(?:(?:\\d{1,4}(?:千|百)?|[一二两三四五六七八九](?:千|百)?)${AMOUNT_TAIL_GUARD})?|千(?:(?:\\d{1,3}|[一二两三四五六七八九])${AMOUNT_TAIL_GUARD})?)?|[零一二两三四五六七八九十百千万]+)`;
const AMOUNT_UNIT = '(万元|万块|万|w元|w|千元|千块|千|k|块钱|块|元|rmb)?';

function extractClauseBudget(clause: string, warnings: string[]): number | undefined {
  const main = clause.match(new RegExp(`(?:预算|金额|报价|合同额|合同金额|合同总价|总金额|总预算|总价|总额|总计)\\s*(?:${BUDGET_VERB})?\\s*([¥￥])?\\s*${AMOUNT_NUM}\\s*${AMOUNT_UNIT}`, 'i'));
  const corrections = Array.from(clause.matchAll(new RegExp(`(?:${BUDGET_VERB})\\s*([¥￥])?\\s*${AMOUNT_NUM}\\s*${AMOUNT_UNIT}`, 'gi')))
    .filter(candidate => {
      // Scheduling changes and unit-comparison/negation clauses must not override a budget.
      if (!/[\d零一二两三四五六七八九十]/.test(candidate[2])) return false;
      if (/还是|不确定|没说明白|没说清|不是|并非/.test(clause)) return false;
      const hasCurrency = !!candidate[1] || !!candidate[3] || /[万千百]/.test(candidate[2]);
      const suffix = clause.slice(candidate.index! + candidate[0].length);
      return hasCurrency && !/^\s*(?:点|号|日)/.test(suffix);
    });
  const match = corrections.at(-1) || main;
  if (!match) return undefined;
  const value = parseAmountToken(match[2], match[3] || '', !!match[1]);
  if (value === undefined) return undefined;
  if (/约|大概|左右|区间|到\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:万|元|k|w)/i.test(clause) && !corrections.length) warnings.push('原文金额含近似表达，请确认该预算后再保存。');
  return value;
}

function budget(text: string, warnings: string[]): number | undefined {
  const { activeClauses } = splitActiveClauses(text);
  let confirmed: number | undefined;
  let sawUncertainBudget = false;
  let sawMissingUnit = false;
  for (let i = 0; i < activeClauses.length; i++) {
    const clause = activeClauses[i];
    const nextClause = activeClauses[i + 1] || '';
    const nextIsBareQualifier = Boolean(nextClause && BARE_BUDGET_QUALIFIER_RE.test(nextClause) && budgetIsUncertain(nextClause));
    const hasBudgetMention = /(?:预算|金额|报价|合同额|合同金额|合同总价|总金额|总预算|总价|总额|总计)|[¥￥]|\d+(?:\.\d+)?\s*(?:万|千|块|元|[wk])/i.test(clause);
    if (budgetIsUncertain(clause) || HYPOTHETICAL.test(clause) || nextIsBareQualifier) {
      if (hasBudgetMention) sawUncertainBudget = true;
      continue;
    }
    const localWarnings: string[] = [];
    const extracted = extractClauseBudget(clause, localWarnings);
    if (extracted !== undefined) {
      confirmed = extracted;
      warnings.push(...localWarnings);
    } else if (new RegExp(`(?:预算|金额|报价|合同额|合同金额|合同总价|总金额|总预算|总价|总额|总计)\\s*(?:${BUDGET_VERB})?\\s*${AMOUNT_NUM}\\s*$`, 'i').test(clause)) {
      sawMissingUnit = true;
    }
  }
  if (confirmed === undefined) {
    if (sawUncertainBudget) warnings.push('预算金额尚未确认，未填写确定金额，请在预览中核对。');
    else if (sawMissingUnit) warnings.push('金额缺少单位，请补充元、万或 k 后重新整理，或在预览中手动核对。');
  } else if (sawUncertainBudget && activeClauses.some(c => /(?:预算|报价|合同额|总价).*(?:可能|大概|待定|未定|还没)/.test(c))) {
    warnings.push('部分附加预算表达尚未确认，已仅保留明确预算，请在预览中核对。');
  }
  return confirmed;
}

const STAGE_VERB = '(?:为|是|改为|改到|更新为|更新到|调整为|调整到|进入|推进到|推进为|切换到|切到|变成|变为|定为)';
function stageFrom(text: string, fallback: DealStage, warnings: string[]): DealStage {
  const { activeClauses, hasAnyHypothetical } = splitActiveClauses(text);
  const eligible = activeClauses.filter(clause =>
    !NEGATIVE.test(clause)
    && !HYPOTHETICAL.test(clause)
    && !/不要当真|别当真|不作数|不算数|不确定|未定|待定|谈不上|算不上|说不上/.test(clause),
  );
  const hasStageClause = (re: RegExp) => eligible.some(clause => re.test(clause));
  const wonMatched = eligible.some(clause =>
    (!(/(?:明天|后天|下周|下个月|本周|下礼拜|计划|打算|准备|争取|预计|有望)/.test(clause)) || /(?:已经|已|正式|签好了|签了合同|到账|收到)/.test(clause))
    && new RegExp(`阶段\\s*${STAGE_VERB}?\\s*赢单成交|(?:已经|已|正式|确认|成功)\\s*(?:完成)?\\s*(?:成交|赢单|签约|打款|回款|签合同)|成交了|合同(?:已经|已)?签好了|签了合同|已回款|已打款|尾款(?:已经|已)?(?:收到|收到了|到账|打过来了|结清)`).test(clause),
  );
  let nextStage: DealStage = fallback;
  if (wonMatched) nextStage = '赢单成交';
  else if (hasStageClause(new RegExp(`进入(?:了)?(?:商务谈判|砍价阶段)|阶段\\s*${STAGE_VERB}?\\s*商务谈判|正在谈判|在谈合同|谈合同|在聊商务|商务推进`))) nextStage = '商务谈判';
  else if (hasStageClause(new RegExp(`(?:进入(?:了)?|到了?|在)?(?:方案报价阶段)|阶段\\s*${STAGE_VERB}?\\s*方案报价|已经报价|已报价|(?:已经|已|刚)发送?(?:了|出|过去)?(?:方案|报价(?:单|表)?)|发了(?:方案|报价(?:单)?)|(?:方案|报价(?:单)?)(?:已经|已|刚)发(?:过去|给客户|出|了)?|(?:方案|报价(?:单)?)(?:已经|已|刚)?报(?:过去|给客户|了)`))) nextStage = '方案报价';
  else if (hasStageClause(new RegExp(`(?:进入(?:了)?|到了?|在)?(?:需求确认阶段)|阶段\\s*${STAGE_VERB}?\\s*需求确认|需求确认|已确认需求|需求对齐|确认了需求|需求(?:已经|已|刚)?(?:聊清楚|聊透|沟通清楚|对完了|对齐了|明确了|确认了)`))) nextStage = '需求确认';
  else if (hasStageClause(new RegExp(`阶段\\s*${STAGE_VERB}?\\s*初步接触|初步接触|刚认识|刚接触|初次沟通`))) nextStage = '初步接触';

  const blockedWonInAnyClause = !wonMatched && /成交|赢单|签|打款|回款/.test(text) && (hasAnyHypothetical || NEGATIVE.test(text));
  if (blockedWonInAnyClause) warnings.push('检测到否定或假设表述，未推进成交阶段。');
  return nextStage;
}

function classifyExpenseCategory(title: string): ExpenseEntry['category'] {
  if (/饭|面|粉|粥|饼|饺|包|咖啡|拿铁|美式|奶茶|果茶|茶|吃|喝|餐|早饭|早餐|午饭|午餐|晚饭|晚餐|夜宵|宵夜|下午茶|外卖|果|菜|肉|火锅|烧烤|烤肉|海底捞|串串|麻辣烫|自助|日料|西餐|快餐|小吃|蛋挞|饼干|冷饮|冰淇淋|零食|甜品|蛋糕|面包|牛奶|水(?![杯费电])/.test(title)) return '餐饮☕';
  if (/车|打车|滴滴|地铁|公交|油|加油|停车|洗车|过路费|高铁|动车|火车|机票|飞机|打的|单车/.test(title)) return '出行🚕';
  if (/衣|裤|鞋|帽|包|表|水杯|杯|淘宝|京东|拼多多|超市|商场|扫货|网购|海淘|下单|百货|家具|家电|数码|书|买书|日用|纸巾|洗发|护肤|面膜|化妆品|耳机|手机|电脑|键盘|鼠标|猫粮|狗粮|买/.test(title)) return '购物🛍️';
  if (/电影|游戏|玩|会员|票|演出|演唱会|KTV|桌游|密室|剧本杀|按摩|旅游|门票|麻将/.test(title)) return '娱乐🎮';
  return '生活🏠';
}

const INLINE_PROJECT_STOPWORDS = /^(?:那单|这单|那笔|这笔|那个|这个|那块|这块|项目|单|单子|合作项目|目前|现在|当前|刚才|刚刚|之前|上次|本次|这次|今天|明天|昨天|下周|本周|这周|具体|相关|确认|表示|答应|告诉|沟通|联系|负责|谁来|已发|已经|刚发|发了|方案|报价)/;
function inferInlineProjectTitle(text: string, clientName: string): string | undefined {
  if (!clientName) return undefined;
  const escaped = clientName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp(`${escaped}(?:的|那边(?:的)?|这边(?:的)?|那头(?:的)?)?\\s*([^，,；;。\\s]{2,14}?)\\s*(?:项目|单子?|的)?\\s*(?:预算|报价|金额|合同额|合同金额|总价)(?!单|表|阶段|方案)`));
  if (!m) return undefined;
  const cand = m[1].replace(/^(?:想做|要做|需要做|关于|做|的|一个|个)+/, '').trim();
  if (!cand || cand.length < 2 || cand.length > 14) return undefined;
  if (INLINE_PROJECT_STOPWORDS.test(cand)) return undefined;
  if (/^(?:是|为|在|有|没|不|要|会|将|能|把|给|向|找|跟|和|说|问|发|改|谈|定|看|算|已|正在|准备|进入|开始)/.test(cand)) return undefined;
  if (/(?:还没|尚未|未能|没有|不是|已经|确认|不确定|未定|待定|报价|预算|金额|总价|时间|日期|几点|几号|刚才|刚刚|刚|微信|电话|口头|说|表示|反馈|答应|承诺|聊)/.test(cand)) return undefined;
  if (new RegExp(DATE).test(cand)) return undefined;
  return cand;
}

function hasNonWorkLifeContent(text: string): boolean {
  if (/体重|饮水|小金库|亲友|妈妈|老婆/.test(text)) return true;
  if (!/午饭|早饭|晚饭/.test(text)) return false;
  const hasHospitalityCue = /(?:请|陪|跟|和|与|同|约|招待|宴请).{0,10}(?:客户|对方|甲方|[\u4e00-\u9fa5]{1,3}(?:总|经理|总监|老板|主任|老师|工|姐|哥|董)|[A-Z][A-Za-z0-9]+)/.test(text);
  const hasPersonalSpendCue = /(?:花了|实付|消费|AA|报销|外卖|自己吃)/.test(text);
  return !(hasHospitalityCue && !hasPersonalSpendCue);
}

function appendDistinctInternalContext(existing: string, incoming: string): string {
  const cleanNote = incoming.trim();
  if (!cleanNote) return existing;
  const current = existing.trim();
  if (!current) return cleanNote;
  const normalizeNote = (s: string) => s.replace(/[\s，,。；;：:]/g, '').toLowerCase();
  const targetNorm = normalizeNote(cleanNote);
  if (!targetNorm) return existing;
  const parts = current.split(/[\n；;]+/).map(p => p.trim()).filter(Boolean);
  if (parts.some(p => normalizeNote(p) === targetNorm || normalizeNote(p).includes(targetNorm))) return existing;
  return `${current}\n${cleanNote}`;
}

function mergeConditionClauses(text: string): string[] {
  const rawClauses = normalizeGroupedNumbers(text).split(/[，,]/).map(item => item.trim()).filter(Boolean);
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
  return clauses;
}

function findKnownClientsInParagraph(paragraph: string, engagements: Engagement[]): { name: string; start: number }[] {
  const knownNames = [...new Set(engagements.map(e => e.clientName.trim()).filter(name => name.length >= 2))]
    .sort((a, b) => b.length - a.length);
  const found: { name: string; start: number }[] = [];
  for (const name of knownNames) {
    const idx = paragraph.indexOf(name);
    if (idx < 0) continue;
    if (/^[A-Za-z0-9._-]+$/.test(name)) {
      const prev = idx > 0 ? paragraph[idx - 1] : '';
      const next = paragraph[idx + name.length] || '';
      if (/[A-Za-z0-9]/.test(prev) || /[A-Za-z0-9]/.test(next)) continue;
    }
    found.push({ name, start: idx });
  }
  return found.sort((a, b) => a.start - b.start);
}

export interface AmbiguousTargetItemCandidate {
  target: 'task' | 'followup';
  id: string;
  title: string;
  engagementId?: string;
  kind?: FollowUpItem['kind'];
  dueAt?: string;
  expectedDate?: string;
  expectedAt?: string;
}

export interface ItemClarificationResult {
  kind: 'item';
  message: string;
  engagementId?: string;
  action: 'postpone_waiting' | 'reschedule';
  targetDateText?: string;
  candidates: AmbiguousTargetItemCandidate[];
}

export function findAmbiguousTargetItems(
  text: string,
  partition: WorkPartition,
  engagementId?: string,
): ItemClarificationResult | null {
  const engagements = partition.engagements || [];
  const tasks = partition.tasks || [];
  const followUps = partition.followUps || [];
  for (const rawParagraph of text.split(/[；;\n。]/).filter(item => item.trim())) {
    const paragraph = normalizeGroupedNumbers(rawParagraph);
    const detected = findClients(paragraph);
    const rawClients = detected.length ? detected : findKnownClientsInParagraph(paragraph, engagements);
    const clients = rawClients.filter((client, index) => index === 0 || client.name !== rawClients[index - 1].name);
    const segments = clients.length ? clients.map((client, index) => ({
      name: client.name,
      text: paragraph.slice(index === 0 ? 0 : client.start, clients[index + 1]?.start ?? paragraph.length),
    })) : [{ name: '', text: paragraph }];
    for (const segment of segments) {
      const selected = engagements.find(item => item.id === engagementId);
      const candidates = segment.name ? engagements.filter(item => item.clientName === segment.name || item.clientName.includes(segment.name)) : [];
      const explicitTitle = segment.text.match(/(?:项目名称|项目名|项目叫|项目为)\s*(?:为|是|叫|[:：])?\s*[「《“]?([^，,；。》”」]{1,30})/)?.[1]?.trim();
      const allTitleMatches = engagements.filter(item => item.title && item.title.trim().length >= 2 && !/的合作项目$/.test(item.title.trim()) && segment.text.includes(item.title.trim()));
      const titleMatches = segment.name ? candidates.filter(item => item.title && item.title.trim().length >= 2 && segment.text.includes(item.title.trim())) : allTitleMatches;
      let targetEng: Engagement | null = null;
      if (explicitTitle && candidates.some(item => item.title === explicitTitle)) targetEng = candidates.find(item => item.title === explicitTitle)!;
      else if (titleMatches.length === 1) targetEng = titleMatches[0];
      else if (selected && (!segment.name || selected.clientName.includes(segment.name))) targetEng = selected;
      else if (candidates.length === 1 && !explicitTitle) targetEng = candidates[0];
      if (!targetEng) continue;

      const clientName = targetEng.clientName;
      const escapedClient = clientName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripPrefix = (raw: string) => {
        let out = raw.trim();
        if (clientName) out = out.replace(new RegExp(`^(?:跟|和|找|给)?${escapedClient}(?:的|那边|那头|这边|这头)?`), '').trim();
        if (targetEng!.title) {
          const escapedTitle = targetEng!.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          out = out.replace(new RegExp(`^(?:${escapedTitle})(?:项目)?(?:的|这块|那块|这边|那边)?`), '').trim();
        }
        return out.replace(/^(?:项目|这次|刚才|之前|目前|现在)(?:的|里|上)?/, '').trim();
      };
      const openTasks = tasks.filter(item => item.engagementId === targetEng!.id && !item.done);
      const openWaitings = followUps.filter(item => item.engagementId === targetEng!.id && item.status === 'open' && item.kind === 'waiting');
      const clauses = mergeConditionClauses(segment.text);
      let pendingNegSubj = '';
      let condConseq = false;
      for (const [clauseIndex, clause] of clauses.entries()) {
        if (STRONG_HYPOTHETICAL.test(clause)) { condConseq = true; continue; }
        if (condConseq && /^(?:就|那就|那么|便|则|我也|我就|客户就|对方就|我再|再)/.test(clause)) { condConseq = false; continue; }
        condConseq = false;
        if (/(?:先)?(?:不用|不要|别|先别|暂缓)催/.test(clause)) {
          const subj = stripPrefix(clause).replace(/(?:先)?(?:不用|不要|别|先别|暂缓)催(?:了|他|她|客户|对方)?/g, '').trim();
          const waitingMatches = subj && !GENERIC_REF.test(subj) ? openWaitings.filter(w => itemMatchesTitle(w.title, subj)) : openWaitings;
          if (waitingMatches.length > 1) {
            return {
              kind: 'item',
              action: 'postpone_waiting',
              engagementId: targetEng.id,
              message: '该项目有多条等待客户事项，请说明要修改具体哪一条。',
              candidates: waitingMatches.map(w => ({ target: 'followup', id: w.id, title: w.title, engagementId: w.engagementId, kind: w.kind, expectedDate: w.expectedDate, expectedAt: w.expectedAt })),
            };
          }
          continue;
        }
        if (/^不是/.test(clause) && new RegExp(DATE).test(clause) && !/(?:改成|改到|改为|推迟到|延后到|提前到)/.test(clause)) {
          pendingNegSubj = stripPrefix(clause.replace(new RegExp(`不是\\s*${DATE}${CLOCK}前?`), '')).trim();
          continue;
        }
        const own = /^(?:我方|我们|咱们|我|乙方)/.test(clause) ||
          /(?:^|[，,；;\s\d点号日天周礼拜期一二三四五六日早上下午晚前])我(?:方|们)?(?:过去|过来|去|来(?![电])|亲自|直接|把|要|需要|得|会|将|先|发|交|写|出|做|改|整|补|对|跟|联|汇|演)/.test(clause);
        const customer = !own && (
          /^(?:客户|对方|甲方|他|她|他们|她们)/.test(clause) ||
          ((clauseIndex > 0 || /(?:^|[，,])我(?:方|们)?/.test(paragraph)) && clause.startsWith(clientName)) ||
          new RegExp(`^${escapedClient}(?:刚才|刚刚|刚|微信上?|电话里?|口头|那头|那边|这边|那儿|这儿){0,2}(?:说|表示|答应|承诺|反馈|讲|提到|负责|会|将|需要|要)`).test(clause)
        );
        const reschedule = !/(?:预算|金额|报价|合同额|合同金额|总价|阶段)/.test(clause)
          ? clause.match(new RegExp(`^(.*?)\\s*(?:改成|改到|改为|推迟到|延后到|顺延到|提前到|挪到|调到|调整到|调整为)\\s*(${DATE}${CLOCK})前?(?:\\s*((?:${ACTION})[^，,；。]*))?$`))
          : null;
        if (reschedule) {
          const datePart = reschedule[2].trim();
          const rawSubj = stripPrefix(reschedule[1] || pendingNegSubj || '')
            .replace(new RegExp(`^不是\\s*${DATE}${CLOCK}前?\\s*`), '')
            .replace(/^(?:我方|我们|咱们|我|乙方|客户|对方|甲方|他|她|他们|她们|说|表示|答应|把|将)+/, '')
            .trim();
          const tailAction = reschedule[3]?.trim() || '';
          const candidateSubj = [rawSubj, tailAction].filter(Boolean).join('');
          pendingNegSubj = '';
          if (!candidateSubj || GENERIC_REF.test(candidateSubj)) {
            const pool = customer ? openWaitings : openTasks;
            if (pool.length > 1) {
              return {
                kind: 'item',
                action: 'reschedule',
                engagementId: targetEng.id,
                targetDateText: datePart,
                message: '该项目有多条进行中的事项，请说明要修改具体哪一条。',
                candidates: pool.map(item => 'done' in item
                  ? { target: 'task' as const, id: item.id, title: item.title, engagementId: item.engagementId, dueAt: item.dueAt }
                  : { target: 'followup' as const, id: item.id, title: item.title, engagementId: item.engagementId, kind: item.kind, expectedDate: item.expectedDate, expectedAt: item.expectedAt }),
              };
            }
            continue;
          }
          const taskMatches = !customer ? openTasks.filter(t => itemMatchesTitle(t.title, candidateSubj)) : [];
          const waitMatches = openWaitings.filter(w => itemMatchesTitle(w.title, candidateSubj));
          if (taskMatches.length > 1 || waitMatches.length > 1) {
            const combined: AmbiguousTargetItemCandidate[] = [
              ...taskMatches.map(t => ({ target: 'task' as const, id: t.id, title: t.title, engagementId: t.engagementId, dueAt: t.dueAt })),
              ...waitMatches.map(w => ({ target: 'followup' as const, id: w.id, title: w.title, engagementId: w.engagementId, kind: w.kind, expectedDate: w.expectedDate, expectedAt: w.expectedAt })),
            ];
            return {
              kind: 'item',
              action: 'reschedule',
              engagementId: targetEng.id,
              targetDateText: datePart,
              message: '该项目有多条相近事项，请说明要修改具体哪一条。',
              candidates: combined,
            };
          }
        }
      }
    }
  }
  return null;
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
    const normalizedInput = normalizeGroupedNumbers(text);
    const explicitNewName = context.newClientName?.trim();
    const initialClients = findClients(normalizedInput);
    const singleNamedClient = new Set(initialClients.map(item => item.name)).size === 1;
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
    if (hasNonWorkLifeContent(text)) proposal.warnings.push('疑似生活内容仍保留在当前输入中，未跨区记账；可编辑或删除原文后再保存。');
    for (const paragraph of normalizedInput.split(/[；;\n。]/).filter(item => item.trim())) {
      const detectedClients = findClients(paragraph);
      const rawClients = detectedClients.length ? detectedClients : findKnownClientsInParagraph(paragraph, working.engagements);
      const clients = rawClients.filter((client, index) => index === 0 || client.name !== rawClients[index - 1].name);
      const segments = clients.length ? clients.map((client, index) => ({ name: client.name,
        text: paragraph.slice(index === 0 ? 0 : client.start, clients[index + 1]?.start ?? paragraph.length) })) : [{ name: '', text: paragraph }];
      for (const segment of segments) {
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
        const { activeClauses: segmentNonHypClauses, hasStrongHypothetical: segHasStrongHyp } = splitActiveClauses(segment.text);
        if (segHasStrongHyp) proposal.warnings.push('假设内容未作为事实提取，请补充已确认的信息。');
        if (!segmentNonHypClauses.length) {
          if (/(?:可能|或许|也许|预计|有望).{0,8}(?:成交|赢单|签约|打款)/.test(segment.text)) {
            proposal.warnings.push('假设内容未作为事实提取，请补充已确认的信息。');
          }
          continue;
        }
        if (!segment.name && !before && !explicitNewName) {
          proposal.warnings.push('未明确客户或项目，请补充姓名或先选择项目。');
          proposal.clarification = { kind: 'project', message: '这段沟通属于谁或哪个项目？也可以先只保存原文。' }; continue;
        }
        const clientName = before?.clientName || segment.name || explicitNewName!;
        const amount = budget(segment.text, proposal.warnings);
        let engagement: Engagement = before ? { ...before } : { id: newId('engagement'), clientName, title: context.newProjectTitle?.trim() || explicitTitle || inferInlineProjectTitle(segment.text, clientName) || `${clientName}的合作项目`,
          stage: '初步接触', internalContext: '', shareableSummary: '', nextAction: '', updatedAt: now };
        // A single explicit client owns later sentences in the same input; multiple names still require a project choice.
        if ((singleNamedClient && segment.name) || (!before && explicitNewName && clientName === explicitNewName) || before) boundProjectId = engagement.id;
        if (explicitTitle) engagement.title = explicitTitle;
        if (amount !== undefined) engagement.budgetAmount = amount;
        engagement.stage = stageFrom(segment.text, engagement.stage, proposal.warnings);
        for (const ctxClause of segmentNonHypClauses) {
          for (const ctxMatch of ctxClause.matchAll(/(?:痛点是|诉求是|需求是|想做|需要做|目标是)([^，,；。]+)/g)) {
            engagement.internalContext = appendDistinctInternalContext(engagement.internalContext, ctxMatch[1]);
          }
        }
        const openTasks = () => working.tasks.filter(item => item.engagementId === engagement.id && !item.done);
        const openFollowUps = (kind?: FollowUpItem['kind']) =>
          (working.followUps || []).filter(item => item.engagementId === engagement.id && item.status === 'open' && (!kind || item.kind === kind));
        const addFollowUp = (kind: FollowUpItem['kind'], title: string, dateText?: string, dateUncertain?: boolean) => {
          const existingMatch = kind === 'waiting' ? openFollowUps('waiting').filter(item => itemMatchesTitle(item.title, title)) : [];
          if (existingMatch.length === 1) {
            const target = existingMatch[0];
            const orig = (original.followUps || []).find(item => item.id === target.id) ?? null;
            const updated: FollowUpItem = { ...target, status: 'open', updatedAt: now };
            if (dateText) {
              updated.sourceDateText = dateText;
              const resolved = dateUncertain ? { warning: '日期或时间尚未确认，请在核对时补充。', dueAt: undefined } : resolveDeadline(dateText, now);
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
            const resolved = dateUncertain ? { warning: '日期或时间尚未确认，请在核对时补充。', dueAt: undefined } : resolveDeadline(dateText, now);
            if (resolved.warning) proposal.warnings.push(resolved.warning);
            if (resolved.dueAt) {
              if (HAS_CLOCK.test(dateText)) followup.expectedAt = resolved.dueAt;
              else followup.expectedDate = shanghaiDateKey(Date.parse(resolved.dueAt));
            }
          }
          addOperation({ target: 'followup', entityId: id, before: null, after: followup });
        };
        const upsertTask = (title: string, dateText?: string, existingTarget?: ProjectTaskItem, dateUncertain?: boolean) => {
          const matched = existingTarget ? [existingTarget] : openTasks().filter(item => itemMatchesTitle(item.title, title));
          if (matched.length === 1) {
            const target = matched[0];
            const orig = original.tasks.find(item => item.id === target.id) ?? null;
            const updated: ProjectTaskItem = { ...target };
            if (dateText !== undefined) {
              const resolved = dateUncertain ? { warning: '日期或时间尚未确认，行动保留但未设置提醒时间。', dueAt: undefined } : resolveDeadline(dateText, now);
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
            const resolved = dateUncertain ? { warning: '日期或时间尚未确认，行动保留但未设置提醒时间。', dueAt: undefined } : resolveDeadline(dateText, now);
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
        const clauses = mergeConditionClauses(segment.text);
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
        let conditionalConsequentPending = false;
        let hasNonHypotheticalClause = false;
        const hasBareRespUncertain = clauses.some(c => BARE_RESP_UNCERTAIN.test(stripContextPrefix(c)));
        for (const [clauseIndex, clause] of clauses.entries()) {
          if (STRONG_HYPOTHETICAL.test(clause)) {
            conditionalConsequentPending = true;
            continue;
          }
          if (conditionalConsequentPending && /^(?:就|那就|那么|便|则|我也|我就|客户就|对方就|我再|再)/.test(clause)) {
            conditionalConsequentPending = false;
            continue;
          }
          conditionalConsequentPending = false;
          if (/(?:可能|或许|也许|预计|有望).{0,8}(?:成交|赢单|签约|打款)/.test(clause) && !extractClauseBudget(clause, [])) {
            continue;
          }
          hasNonHypotheticalClause = true;
          const clauseDateUncertain = isClauseDateUncertain(clauses, clauseIndex);
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
              const vagueRe = /下周|下星期|下礼拜|下个?月|过几天|晚点|稍后|改天/;
              const vagueMatch = clause.match(vagueRe) || (clauses[clauseIndex + 1] || '').match(vagueRe);
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
          const own = /^(?:我方|我们|咱们|我|乙方)/.test(clause) ||
            /(?:^|[，,；;\s\d点号日天周礼拜期一二三四五六日早上下午晚前])我(?:方|们)?(?:过去|过来|去|来(?![电])|亲自|直接|把|要|需要|得|会|将|先|发|交|写|出|做|改|整|补|对|跟|联|汇|演)/.test(clause);
          const customer = !own && (
            /^(?:客户|对方|甲方|他|她|他们|她们)/.test(clause) ||
            ((clauseIndex > 0 || /(?:^|[，,])我(?:方|们)?/.test(paragraph)) && clause.startsWith(clientName)) ||
            new RegExp(`^${escapedClient}(?:刚才|刚刚|刚|微信上?|电话里?|口头|那头|那边|这边|那儿|这儿){0,2}(?:说|表示|答应|承诺|反馈|讲|提到|负责|会|将|需要|要)`).test(clause) ||
            new RegExp(`^${escapedClient}(?:刚才|刚刚|刚|微信上?|电话里?)?(?:确认|同意|说明)(?:会|将|要|自己|他|她|对方|他们|[^，,；。]{0,8}(?:给我们|给我方|给我|发过来|发来|寄过来|传过来|回传|打过来|打款|付款|回款))`).test(clause) ||
            /(?:发过来|发来|寄过来|传过来|回传)/.test(clause) ||
            /(?:发给|交给|补给|提供给|回传给|寄给|回复给?|答复给?|通知给?)(?:我们|我方|咱们|我)(?:$|[^A-Za-z0-9\u4e00-\u9fa5])/.test(clause) ||
            /(?:给|向)(?:我们|我方|咱们|我)(?:回电话|回电|打电话|发|交|补|寄|传|提供|回复|答复)/.test(clause)
          );
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
                if (customer) addFollowUp('waiting', pool[0].title, datePart, clauseDateUncertain);
                else upsertTask(pool[0].title, datePart, pool[0] as ProjectTaskItem, clauseDateUncertain);
              } else if (pool.length > 1) {
                proposal.warnings.push('该项目有多条进行中的事项，请明确要修改哪一条。');
                proposal.clarification = { kind: 'project', message: '该项目有多条进行中的事项，请说明要修改具体哪一条。' };
              }
              continue;
            }
            const taskMatches = !customer ? openTasks().filter(t => itemMatchesTitle(t.title, candidateSubj)) : [];
            const waitMatches = openFollowUps('waiting').filter(w => itemMatchesTitle(w.title, candidateSubj));
            if (taskMatches.length === 1) { upsertTask(taskMatches[0].title, datePart, taskMatches[0], clauseDateUncertain); continue; }
            if (waitMatches.length === 1) { addFollowUp('waiting', waitMatches[0].title, datePart, clauseDateUncertain); continue; }
            if (taskMatches.length > 1 || waitMatches.length > 1) {
              proposal.warnings.push('该项目有多条相近事项，请明确要修改哪一条。');
              proposal.clarification = { kind: 'project', message: '该项目有多条相近事项，请说明要修改具体哪一条。' };
              continue;
            }
            if (customer) addFollowUp('waiting', candidateSubj, datePart, clauseDateUncertain);
            else upsertTask(candidateSubj, datePart, undefined, clauseDateUncertain);
            continue;
          }
          const unclearOwner = !own && !customer && (RESPONSIBILITY_UNCERTAIN.test(clause) || hasBareRespUncertain);
          const taskPattern = new RegExp(`(${DATE}${CLOCK})前?\\s*(?:(?:我方|我们|咱们|我|乙方|客户|对方|甲方|他|她|他们|她们)(?:这边|那边)?)?\\s*(?:要|需要|必须|得|先|会|将|再|顺便|抽空|亲自|直接)?\\s*(?:过去|过来|去|来(?![电]))?\\s*(?:((?:到?现场|上门|当面|线下)?(?:${ACTION})([^，,；。]*))|(把[^，,；。]*?(?:${ACTION})[^，,；。]*))`, 'g');
          for (const match of clause.matchAll(taskPattern)) {
            const title = (match[4] || match[2]).trim();
            if (title.length < 2) continue;
            if (unclearOwner) { addFollowUp('question', `确认由谁${title}`); continue; }
            if (customer) { addFollowUp('waiting', title, match[1], clauseDateUncertain); continue; }
            upsertTask(title, match[1], undefined, clauseDateUncertain);
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
          if (RESPONSIBILITY_UNCERTAIN.test(clause)) {
            const stripped = stripContextPrefix(clause);
            if (!BARE_RESP_UNCERTAIN.test(stripped) || !clauses.some(c => new RegExp(DATE).test(c))) {
              addFollowUp('question', stripped || clause);
            }
          }
          if (
            /(?:费用|预算|报价|金额|价格|尾款|合同额|运费|税点|税率|几个点|发票|专票|普票|周期|工期|交付|方案|接口|标准|条款|质保|账期|预付款|首付款|定金|违约金|售后)/.test(clause) &&
            /未定|待定|(?:还)?没(?:有)?(?:定|谈定|确定|确认|拍板|敲定|说清|明确|聊透|谈拢|谈妥|聊妥|说定|定下来|对齐|商量好)|尚未(?:定|谈定|确定|确认|拍板|敲定|说清|明确)|待确认|不确定|先别定|未拍板|含不含|包不包|算不算|是否包含|是否含|谁承担|怎么算/.test(clause) &&
            !/不是.*(?:预算|报价|金额)|不要当真|别当真/.test(clause)
          ) {
            addFollowUp('question', clause);
          }
          const bareAmountQ = clause.match(/^.*?(?:预算|报价|金额|费用|合同额)\s*\d+(?:\.\d+)?/);
          if (bareAmountQ && (/^\s*$/.test(clause.slice(bareAmountQ[0].length)) || /(?:是)?(?:万|千|块|元)还是(?:万|千|块|元)|还没说明白|没说明白|说不清|没说清/.test(clause))) {
            addFollowUp('question', `确认${bareAmountQ[0].trim()}的金额单位`);
          }

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
        if (hasNonHypotheticalClause) {
          engagement.updatedAt = now;
          if (!before || JSON.stringify({ ...before, updatedAt: now }) !== JSON.stringify(engagement)) {
            addOperation({ target: 'engagement', entityId: engagement.id, before: original.engagements.find(item => item.id === engagement.id) || null, after: engagement });
          }
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
    const facts = routeLifeInput(text).filter(part => part.route === 'fact').map(part => normalizeLifeClause(part.text));
    if (!facts.length) return [];
    const receipts: StateMutationReceipt[] = [];
    const receipt = (targetCardType: StateMutationReceipt['targetCardType'], summaryText: string) => receipts.push({
      id: newId('receipt'), mode: 'life', targetCardType, targetCardTitle: '生活记录', summaryText, deltaBadge: '已记录', timestamp: Date.now(),
    });
    const clean = facts.join('，');

    const bookedClauses = new Set<string>();

    // 0. 极简多天习惯打卡识别（不干扰旧版《...》卡 + 目标N 的统计型自定义卡片）
    const checkinResult = tryApplySpokenCheckin(clean, life.customCards);
    if (checkinResult.handled) {
      if ((checkinResult.kind === 'created' || checkinResult.kind === 'checked') && checkinResult.card) {
        receipt('custom', checkinResult.message || `已记录「${checkinResult.card.title}」打卡`);
      }
      for (const f of facts) {
        if (/打卡/.test(f)) bookedClauses.add(f);
      }
    } else {
      // 1. 自定义卡片新建与打卡推进（支持带或不带《》书名号）
      const customMatch = clean.match(/(?:建一?张|建一?个|新建|创建|生成一?张|加一?个)\s*(?:《([^》]{1,20})》|「([^」]{1,20})」|“([^”]{1,20})”|"([^"]{1,20})"|([^\s，,。；《》「」“”"]{1,16}?)(?:的)?\s*(?:卡|看板|面板|打卡))/);
      const customTitle = customMatch ? (customMatch[1] || customMatch[2] || customMatch[3] || customMatch[4] || customMatch[5] || '').trim() : '';
      if (customTitle) {
        const target = +(clean.match(/目标\s*(\d+)/)?.[1] || 100);
        if (target > 0) {
          const cards = life.customCards;
          cards.push({ id: newId('custom'), mode: 'life', title: customTitle, icon: '🌱', metricLabel: '进度', metricValue: 0,
            metricTarget: target, unit: '次', checklist: [] });
          receipt('custom', `已创建「${customTitle}」生活卡`);
          for (const f of facts) {
            if (/(?:建一?张|建一?个|新建|创建|生成一?张|加一?个|目标\s*\d+)/.test(f)) bookedClauses.add(f);
          }
        }
      } else if (life.customCards?.length) {
        for (const card of life.customCards) {
          if (!card.title || card.cardKind === 'checkin') continue;
          const escaped = card.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const progMatch = clean.match(new RegExp(`(?:打卡|完成(?:了)?|推进)?\\s*《?${escaped}》?\\s*(?:[+＋]\\s*(\\d+)|(?:打卡)?\\s*完成了?\\s*(\\d+)|打卡)`));
          if (progMatch) {
            const delta = +(progMatch[1] || progMatch[2] || 1);
            card.metricValue = Math.min(card.metricTarget || 100, (card.metricValue || 0) + delta);
            receipt('custom', `已更新「${card.title}」进度 +${delta}`);
            for (const f of facts) {
              if (f.includes(card.title)) bookedClauses.add(f);
            }
          }
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

    // 撤回/反悔句与第三方消费过滤防御
    const rawSegs = text.split(/[，,；;。\n！？!?]+/).map(normalizeLifeClause).filter(Boolean);
    const RETRACT_STOP_RE = /(?:啊?不对|搞错了|说错了|算错了|记错了|别记账|不要记账|不用记账|别入账|不要入账|不用入账|别记了|不要记了|不用记了|不记账|最后没(?:存|买|花|付|转|交|收|到)|其实没(?:存|买|花|付|转|交|收|到)|最终没(?:存|买|花|付|转|交|收|到)|根本没(?:存|买|花|付|转|交|收|到)|没存成功|没买成|作废|撤回)/;
    const PENDING_INCOMING_RE = /^(?:还)?(?:没|未|没有)(?:到账|收|收到|退|打过来|打给我|转过来|发过来)$|^(?:退款|报销|补贴|工资|奖金|红包)?(?:还)?(?:没|未|没有)(?:到账|打给我|打过来)$/;
    const INCOMING_LIKE_RE = /(?:退款|退税|退回|报销|补贴|工资|奖金|年终奖|红包|入账|进账|到账|还给我|转给我|卖了|卖出)/;
    const retractedIdx = new Set<number>();
    for (let i = 0; i < rawSegs.length; i++) {
      const seg = rawSegs[i];
      if (RETRACT_STOP_RE.test(seg)) {
        retractedIdx.add(i);
        if (i > 0) retractedIdx.add(i - 1);
        if (/(?:别记账|不要记账|不用记账|别入账|不记账|啊?不对)/.test(seg) && !/不过.*(?:确实|实际|实付)/.test(seg)) {
          for (let k = i - 1; k >= 0; k--) {
            if (/^(?:不过|但是|其实)/.test(rawSegs[k]) && !RETRACT_STOP_RE.test(rawSegs[k])) break;
            retractedIdx.add(k);
          }
        }
      } else if (PENDING_INCOMING_RE.test(seg) && i > 0 && INCOMING_LIKE_RE.test(rawSegs[i - 1])) {
        retractedIdx.add(i);
        retractedIdx.add(i - 1);
      }
    }
    const retractedTexts = Array.from(retractedIdx).map(idx => rawSegs[idx]);
    const isRetractedFinance = (clause: string) => RETRACT_STOP_RE.test(clause) || retractedTexts.some(r => r && (clause === r || (r.length >= 4 && clause.includes(r))));

    const OTHER_SUBJECT_FINANCE_RE = /^(?:(?:我|我的|咱|咱们)?(?:同事|朋友|邻居|室友|同学|老板|领导|亲戚|闺蜜|客户|表哥|表姐|表弟|表妹|堂哥|堂姐|堂弟|堂妹|老王|老张|老李|老刘|老陈|他|她|他们|她们|人家|别人|其他人)|(?:(?:我|表|堂|大|小|二)?[\u4e00-\u9fa5]{0,2}(?:姐|哥|叔|姨))|(?:[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜](?:总|工)(?![资作程厂具费共计算是价额]))|(?:[\u4e00-\u9fa5]总(?![共计算是价额]))|(?:(?:老|小)[\u4e00-\u9fa5]工(?![资作程厂])))/;
    const isThirdPartyFinanceClause = (clause: string): boolean => {
      const trimmed = clause.replace(/^(?:今天|刚刚|刚才|昨晚|昨天|前天|顺便|听说|还有|另外)[，,：\s]*/, '').trim();
      if (/^(?:请|给|帮|替|带|陪|跟|和|与|向(?![导])|找|同(?!(?:事|学|伴|行)))/.test(trimmed) || /^为(?:了)?(?:朋友|同事|同学|家人|大家|别人|客户|领导|老板)/.test(trimmed)) return false;
      if (/(?:我(?:出了|付了|花了|买了|垫了|交了|充了|转了|给了|AA了?|自己)|还给我|转给我|发给我|退给我|打给我|给我钱)/.test(trimmed)) return false;
      if (/^(?:老板|领导|公司|单位|财务|HR)/.test(trimmed) && /(?:发了?(?:工资|年终奖|奖金|绩效|提成|津贴|补贴|红包|过节费))/.test(trimmed)) return false;
      if (OTHER_SUBJECT_FINANCE_RE.test(trimmed)) return true;
      if (/(?:^|[^\u4e00-\u9fa5])(?:同事|朋友|邻居|室友|同学|老板|领导|亲戚|闺蜜|客户)(?:自己|那边)?(?:买|花|付|用|消费|赚|挣|发了|中了|收到|花了)/.test(trimmed)) return true;
      return false;
    };

    const LIFE_CHINESE_NUM = '[一二两三四五六七八九十百千万零]+';
    const LIFE_CURR_UNIT = '万元|万块|万|w元|w|千元|千块|千|k|块钱|块|元|米|大洋|rmb';
    const parseLifeAmount = (numRaw: string, unitRaw = ''): number => {
      if (!numRaw) return NaN;
      if (/^\d+(?:\.\d+)?$/.test(numRaw)) {
        const u = unitRaw.toLowerCase();
        const mult = u.startsWith('万') || u.startsWith('w') ? 10000 : u.startsWith('千') || u.startsWith('k') ? 1000 : 1;
        return +numRaw * mult;
      }
      if (!unitRaw && !/[千百万]/.test(numRaw)) return NaN;
      const val = parseAmountToken(numRaw, unitRaw || '元', false);
      return val ?? NaN;
    };

    // 2. 心愿金库存入 / 攒钱（无需强制写“元/块”，支持 万/w/k 及撤回/第三方防御）
    for (let clauseIdx = 0; clauseIdx < facts.length; clauseIdx++) {
      const clause = facts[clauseIdx];
      const nextClause = facts[clauseIdx + 1] || '';
      if (bookedClauses.has(clause)) continue;
      if (isRetractedFinance(clause) || isThirdPartyFinanceClause(clause)) continue;

      const save = clause.match(/(?:存入(?:小金库)?|存了?|攒了?|存进|小金库\s*(?:加|存|\+|入了?)?)\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元)?/i);
      if (save && !/没存|不存/.test(clause)) {
        const amount = parseLifeAmount(save[1], save[2] || '');
        if (!Number.isNaN(amount) && amount > 0) {
          const primaryWish = syncWishProgress(amount);
          wallet.entries.push({ id: newId('expense'), title: '心愿金库存入', amount, type: 'saving', category: '金库✨', timestamp: Date.now() });
          bookedClauses.add(clause);
          receipt('wallet', `已记录心愿存入 ¥${amount}（${primaryWish ? primaryWish.title : '心愿金库'}）`);
        }
        continue;
      }

      // 3. 收入记录（发工资 / 兼职 / 报销 / 红包 / 卖闲置 / 退押金 / 入账 / 挣了 / 赚了）
      if (/(?:亏了?|亏损|浮亏|缩水|跌了|赔了|被骗|罚款)/.test(clause) && !/(?:赔偿|理赔|赔付)/.test(clause)) continue;
      if (!/损失/.test(clause)) {
        const received = clause.match(/^(.*?(?:还给我|发了(?:年终奖|奖金)|卖了|卖出|出掉了?|转手了?|退回来?了?|退还了?|退了|(?:闲鱼|转转|二手)[^，,。]{0,4}出了?|出了?))\s*(?:个|了个|了|一把|台|套)?\s*([^¥￥\d，,。；！？]*?)\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元|米|大洋)?(.*)$/i);
        if (received) {
          const arrContext = `${received[5]} ${nextClause}`;
          const hasArrivalWord = /(?:钱已收|已收|到卡上?了?|钱已到卡|已到卡|已到账|到账了?|收款了|转过来了)/.test(arrContext);
          const blockedPending = /(?:还没|未|没有)(?:到账|收|打|退)/.test(arrContext);
          const isIncomingClause = hasArrivalWord || /(?:还给我|发了(?:年终奖|奖金)|卖了|卖出|退回|退还|闲鱼|转转|二手|转手|出掉)/.test(clause);
          if (isIncomingClause) {
            if (/还给我/.test(received[1]) || (hasArrivalWord && !blockedPending)) {
              const amount = parseLifeAmount(received[3], received[4] || '');
              const cleanItem = (received[2] || '').trim();
              const title = `${received[1].replace(/(?:了|来)$/, '')}${cleanItem}`.trim() || '日常收入';
              if (amount > 0 && Number.isFinite(amount)) {
                wallet.entries.push({ id: newId('expense'), title, amount, type: 'income', category: '金库✨', timestamp: Date.now() });
                bookedClauses.add(clause);
                if (/^(?:钱已收|已收|钱已到卡|已到卡|到卡上?了?|已到账|收款了)$/.test(nextClause)) bookedClauses.add(nextClause);
                syncWishProgress(amount);
                receipt('wallet', `已记录收入 ${title} ¥${amount}，已存入心愿金库`);
              }
            }
            continue;
          }
        }
        const grabIncomeMatch = clause.match(/(?:抢到|抢了|领到|抽到|中了|拿了|拿到)\s*(?:一?个|一?笔|了)?\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元)?(?:的)?\s*(大红包|红包|压岁钱|奖金|年终奖|补贴|津贴|返现|外快)/i);
        if (grabIncomeMatch && !/(?:发|包|给|送).*红包/.test(clause)) {
          const amount = parseLifeAmount(grabIncomeMatch[1], grabIncomeMatch[2] || '');
          const title = grabIncomeMatch[3].trim() || '红包';
          if (amount > 0 && Number.isFinite(amount)) {
            wallet.entries.push({ id: newId('expense'), title, amount, type: 'income', category: '金库✨', timestamp: Date.now() });
            bookedClauses.add(clause);
            const primaryWish = syncWishProgress(amount);
            receipt('wallet', `已记录收入 ${title} ¥${amount}，已存入心愿金库（${primaryWish ? primaryWish.title : '心愿金库'}）`);
          }
          continue;
        }
        const incomeMatch = clause.match(/(?:(发工资|工资|兼职|报销|红包|奖金|年终奖|退款|退税|外快|副业|利息)\s*(?:发了|到了|到账了?|收到|入账|进账|赚了?|挣了?)?|(?:收到了?|到账了?|入账|进账|赚了?|挣了?|收入)\s*([^\d，,。；！？\s]{0,8}?))\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(万|w|千|k|块钱|块|元)?/i);
        if (incomeMatch) {
          if (incomeMatch[1] && !/发工资|发了|到了|到账|收到|入账|进账|赚|挣/.test(clause)) continue;
          const title = (incomeMatch[1] || incomeMatch[2] || '日常收入').trim() || '日常收入';
          const amount = parseLifeAmount(incomeMatch[3], incomeMatch[4] || '');
          if (amount > 0 && Number.isFinite(amount)) {
            wallet.entries.push({ id: newId('expense'), title, amount, type: 'income', category: '金库✨', timestamp: Date.now() });
            bookedClauses.add(clause);
            const primaryWish = syncWishProgress(amount);
            receipt('wallet', `已记录收入 ${title} ¥${amount}，已存入心愿金库（${primaryWish ? primaryWish.title : '心愿金库'}）`);
          }
          continue;
        }
      }

      // 4. 消费记账（支持全部日常口语、AA分摊、品牌/地点修饰与中文数字）
      // 跳过已作为心愿存入、收入、自定义卡目标、体重、饮水、睡眠或商务预算的子句
      const hasWorkClientSubject = extractClientNames(clause).length > 0 && !/^(?:今天|刚刚|刚才|昨晚|昨天|早上|中午|下午|晚上|顺便|另外)?\s*(?:请|给|帮|替|带|陪)/.test(clause);
      if (/(?:存入|存了?|攒了?|存进|小金库|发工资|工资|报销|收到红包|入账|进账|赚了?|挣了?|收入|目标\s*\d+|体重|称重|上称|预算|报价|合同额)/.test(clause) || hasWorkClientSubject) continue;
      if (/(?:红包|奖金|年终奖|退款|退税|退回|押金|利息|还给我|卖了|卖出|闲鱼|转转|二手|到账|转账|钱已收|钱已到卡)/.test(clause) && !/实付|花了|扣了|刷了|交了押金/.test(clause)) continue;
      if (/^\d+(?:\.\d+)?\s*(?:kg|公斤|千克|斤)$/i.test(clause)) continue;
      if (/(?:喝了?|炫了?|补)\s*(?:\d+|[一二两三四五六七八九十])?\s*(?:杯|瓶|毫升|ml)\s*水?/i.test(clause)) continue;
      if (/睡了?\s*\d+(?:\.\d+)?\s*(?:个?小时|h)/i.test(clause)) continue;

      let title = '';
      let finalAmount = NaN;

      // 句式 A: [前缀/时间/项目] + (实付/花了/付了/出了/用了/刷了/扣了/...) + [金额] + [单位]? + [项目]?
      const verbFirst = clause.match(new RegExp(`^(.*?)\\s*(?:实付了?|花了?|付了?|消费了?|支出了?|花费了?|用了?|刷了?|扣了?|出了?|垫了?|AA了?)\\s*[¥￥]?\\s*(\\d+(?:\\.\\d+)?|${LIFE_CHINESE_NUM})\\s*(${LIFE_CURR_UNIT})?\\s*(.*)$`, 'i'));
      if (verbFirst) {
        const prefix = verbFirst[1].replace(/^(?:今天|刚刚|刚才|昨晚|昨天|前天|早上|上午|中午|下午|晚上|夜里|顺便|另外|还有|又|我|去|在)+/, '').replace(/我$/, '').trim();
        const suffixRaw = verbFirst[4].trim();
        const unitRaw = verbFirst[3] || '';
        const isDuration = !unitRaw && /^(?:个?(?:小时|钟头)|天|分钟|秒|周|个月|年|次|遍|顿|杯|瓶|碗|件|本|张|台|套|双|条|只|斤|公斤|公里|步|圈|页|道|题|集|章)/.test(suffixRaw);
        if (!isDuration) {
          const parsed = parseLifeAmount(verbFirst[2], unitRaw);
          if (!Number.isNaN(parsed) && parsed > 0) {
            const suffix = suffixRaw.replace(/^(?:去|给|在)+/, '').trim();
            title = suffix || prefix || '日常开销';
            finalAmount = parsed;
          }
        }
      }

      // 句式 A2: 买了/点了/充了/交了 + [明确货币符号或单位金额] + [项目]
      if (Number.isNaN(finalAmount)) {
        const buyFirst = clause.match(new RegExp(`^(.*?)\\s*(?:买了|点了|充了|交了)\\s*(?:([¥￥])\\s*(\\d+(?:\\.\\d+)?)|(\\d+(?:\\.\\d+)?|${LIFE_CHINESE_NUM})\\s*(${LIFE_CURR_UNIT}))\\s*(.*)$`, 'i'));
        if (buyFirst) {
          const parsed = parseLifeAmount(buyFirst[3] || buyFirst[4], buyFirst[5] || '元');
          if (!Number.isNaN(parsed) && parsed > 0) {
            const prefix = buyFirst[1].replace(/^(?:今天|刚刚|刚才|昨晚|昨天|前天|顺便|另外|还有|又|我|去|在)+/, '').trim();
            const suffix = (buyFirst[6] || '').replace(/^(?:的)+/, '').trim();
            title = suffix || prefix || '日常开销';
            finalAmount = parsed;
          }
        }
      }

      // 句式 B: [可选地点/品牌前缀] + (买了/吃了/喝了/理发/配钥匙/超市/奶茶/蛋挞...) + [项目] + [金额] + [单位]?
      if (Number.isNaN(finalAmount)) {
        const SCENE_KW = '买了?|吃了?|喝了?|点了?|交了?|充了?|刷了?|打车|滴滴|坐车|地铁|公交|加油|停车费?|洗车|过路费|充电|跑腿|早饭|早餐|午饭|午餐|晚饭|晚餐|夜宵|宵夜|下午茶|咖啡|拿铁|美式|奶茶|果茶|水果|零食|蛋挞|甜品|点心|面包|蛋糕|买菜|生鲜|超市|扫货|百货|日用品|外卖|快递|话费|水费|电费|燃气|网费|房租|物业|电影|理发|洗剪吹|剪发|洗发|配钥匙|开锁|修锁|修车|修鞋|贴膜|干洗|洗衣|打印|复印|挂号|买药|淘宝|京东|拼多多|海底捞|火锅|烧烤|串串';
        const actionOrScene = clause.match(new RegExp(`^(?:今天|刚刚|刚才|昨晚|昨天|早上|上午|中午|下午|晚上|下班|顺便|另外|还有|又|我|去)*\\s*((?:[\\u4e00-\\u9fa5A-Za-z]{1,8}?(?=${SCENE_KW}))?(?:${SCENE_KW})[^\\d，,。；！？]{0,12}?)\\s*(?:一共|总共|共|是)?\\s*[¥￥]?\\s*(?<![A-Za-z0-9\\-－_])(\\d+(?:\\.\\d+)?)\\s*(${LIFE_CURR_UNIT})?(?!(?:号|日|点|分|秒|岁|周|年|月|天|小时|个|杯|ml|kg|斤|%|折|℃|度|楼|单元|室))`, 'i'));
        if (actionOrScene && actionOrScene[0].length === clause.length) {
          const parsed = parseLifeAmount(actionOrScene[2], actionOrScene[3] || '');
          if (!Number.isNaN(parsed) && parsed > 0) {
            title = actionOrScene[1].replace(/^(?:了|个|杯|碗|份|顿|次)+/, '').trim();
            finalAmount = parsed;
          }
        }
      }

      // 句式 C: 任意项目名称 + 金额 + 明确货币符号或单位 (例: "水杯 60元", "耳机¥299", "猫粮180块")
      if (Number.isNaN(finalAmount)) {
        const explicitUnit = clause.match(new RegExp(`^([^，,。；！？\\d]{1,14}?)\\s*(?:([¥￥])\\s*(\\d+(?:\\.\\d+)?)|(?<![A-Za-z0-9\\-－_])(\\d+(?:\\.\\d+)?|${LIFE_CHINESE_NUM})\\s*(${LIFE_CURR_UNIT}))$`, 'i'));
        if (explicitUnit) {
          const candTitle = explicitUnit[1].replace(/^(?:今天|刚刚|刚才|顺便|另外|还有|又|我)+/, '').trim() || '日常开销';
          const unitStr = explicitUnit[5] || '元';
          if (!(unitStr === '米' && /跑|走|游|骑|跳|距|离|长|宽|高|深|海拔/.test(candTitle))) {
            const parsed = parseLifeAmount(explicitUnit[3] || explicitUnit[4], unitStr);
            if (!Number.isNaN(parsed) && parsed > 0) {
              title = candTitle;
              finalAmount = parsed;
            }
          }
        }
      }

      if (!Number.isNaN(finalAmount) && finalAmount > 0) {
        const cleanTitle = title.replace(/^(?:今天|刚刚|刚才|顺便|另外|还有|又)+/, '').trim() || '日常开销';
        if (/预算|金额|报价|合同额|存入|攒|客户/.test(cleanTitle) || (extractClientNames(cleanTitle).length > 0 && !/^(?:请|给|帮|替|带|陪)/.test(cleanTitle))) continue;
        const roundedAmount = +finalAmount.toFixed(2);
        const category = classifyExpenseCategory(cleanTitle);
        wallet.entries.push({ id: newId('expense'), title: cleanTitle, amount: roundedAmount, type: 'expense', category, timestamp: Date.now() });
        bookedClauses.add(clause);
        receipt('wallet', `已记录 ${cleanTitle} ¥${roundedAmount}`);
      }
    }

    // 5. 体重、疲劳与运动恢复。饮水字段仅保留旧数据兼容。
    const rpg = life.rpg;
    const unbookedClean = facts.filter(f => !bookedClauses.has(f)).join('，');

    // 体重：支持 "体重65"、"体重130斤"、"体重130"(>=95自动按斤折算)、"今天65kg"、"128斤"
    const weightExplicit = unbookedClean.match(/(?:体重|称重|上称|重了?|瘦到|涨到|降到)\s*(?:是|为|到了?)?\s*(\d{2,3}(?:\.\d+)?)\s*(kg|公斤|千克|斤)?/i);
    const weightUnitOnly = !weightExplicit ? unbookedClean.match(/(?:^|[，,。；\s]|今天|现在|目前|早上|晚上)(\d{2,3}(?:\.\d+)?)\s*(kg|公斤|千克|斤)/i) : null;
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
    if (/熬夜|失眠|好累|太累|累死|累趴|没睡好|没睡醒|疲惫|困死|好困|犯困|加班|内耗|心累|头疼|头痛|不舒服|生病|感冒|发烧|烦躁|焦虑/.test(unbookedClean)) {
      rpg.energy = Math.max(0, rpg.energy - 18);
      rpg.moodBuff = '用户自报疲惫';
      receipt('rpg_status', '已记录自报状态：疲惫');
    }

    // 运动与睡眠恢复
    if (/跑步|夜跑|晨跑|健身|举铁|撸铁|运动|锻炼|散步|走路|遛弯|骑行|骑车|游泳|打球|羽毛球|篮球|网球|乒乓球|踢球|瑜伽|普拉提|帕梅拉|跳绳|八段锦|爬山|徒步|冥想|早睡|早起|睡了个?好觉|睡饱|睡足|睡了\s*(?:[789]|10|[七八九十])\s*个?小时|满血复活|精神不错|元气满满/.test(unbookedClean)) {
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

    const KIN_TITLES = ['妈妈', '老妈', '母亲', '妈', '爸爸', '老爸', '父亲', '爸', '老婆', '媳妇', '爱人', '妻子', '太太', '老公', '丈夫', '先生', '对象', '女朋友', '女友', '男友', '男朋友', '儿子', '女儿', '闺女', '孩子', '宝宝', '爷爷', '奶奶', '姥姥', '姥爷', '外公', '外婆', '公公', '婆婆', '岳父', '岳母', '丈母娘', '哥哥', '姐姐', '弟弟', '妹妹', '哥', '姐', '弟', '妹', '嫂子', '姐夫', '妹夫', '叔叔', '阿姨', '舅舅', '姑姑', '姑妈', '姨妈', '舅妈', '伯父', '伯母', '大伯', '大妈', '大爷', '表哥', '表姐', '表弟', '表妹', '堂哥', '堂姐', '堂弟', '堂妹', '闺蜜', '室友', '发小', '同学', '同事', '朋友'];
    const KIN_REGEX = new RegExp('^(?:我|我的|咱|咱们)?(' + KIN_TITLES.join('|') + ')');
    const normalizeKin = (raw: string) => {
      if (/^(?:我|我的|咱|咱们)?(?:老妈|妈|母亲)$/.test(raw)) return raw.startsWith('我') && raw.length === 2 ? '妈' : '妈妈';
      if (/^(?:我|我的|咱|咱们)?(?:老爸|爸|父亲)$/.test(raw)) return raw.startsWith('我') && raw.length === 2 ? '爸' : '爸爸';
      return raw.replace(/^(?:我|我的|咱|咱们)/, '');
    };
    const SELF_PREFIX = /^(?:而且|而|但|但是|另外|还有|然后|至于)?\s*(我自己|我本人|我们|我)(?![妈爸老媳丈公婆哥姐弟妹叔姨舅姑闺室发同朋儿女丈孩宝外爷奶大的爱父父母家妻夫对象邻])/;
    const NON_PERSON_BLACKLIST = new Set(['今天', '明天', '后天', '昨天', '前天', '刚才', '刚刚', '现在', '我们', '你们', '他们', '大家', '有人', '自己', '本人', '家里', '公司', '工作', '预算', '平时', '经常', '总是', '有时', '一直', '顺便', '另外', '还有', '如果', '并且', '然后', '但是', '至于', '而我', '但我']);
    const PERSON_CONT_PREFIX = /^(?:还|也|又|而且|并且|同时|加上|尤其|特别|很|非常|最|不|没|讨厌|(?<!不)喜欢|爱吃|爱喝|最爱|偏|对.+?(?:过敏|忌口)|忌口|戒|血压|血糖|血脂|肠胃|脾胃|皮肤|生日|纪念日)/;

    const touchedPersons = new Set<string>();
    const updatePersonInfo = (name: string, restInfo: string) => {
      let person = life.persons.find(item => item.name === name || item.name === `我${name}` || item.name.replace(/^我/, '') === name);
      if (!person) {
        person = { id: newId('person'), name, relation: '亲友', taboos: [], preferences: [], updatedAt: Date.now() };
        life.persons.push(person);
      }
      let updated = false;

      const subParts = restInfo.split(/[，,。；！？]+/).map(s => s.trim()).filter(Boolean);
      for (const part of subParts.length ? subParts : [restInfo]) {
        const cleanPart = part.replace(/^(?:还|也|又|其实|平时|经常|特别|很|十分|最|比较|超级|极其|一直|就|都)+/, '').trim();
        const allergyMatch = cleanPart.match(/(?:对\s*([^\s，,。！？]+?)\s*过敏|^(?:[^\s，,。！？]{0,6}(?:高|不好|敏感))?\s*([^\s，,。！？对]{1,8}?)\s*过敏)/);
        if (allergyMatch) {
          const val = (allergyMatch[1] || allergyMatch[2]).trim() + '过敏';
          if (val.length >= 3 && !person.taboos.includes(val)) { person.taboos.push(val); updated = true; }
        }
        const notEatMatch = cleanPart.match(/(?:(?:不吃|不能吃|不爱吃|忌口|不喝|不能喝|不爱喝|不碰|戒了?)\s*([^，,。！？]+)|对\s*([^，,。！？]+?)\s*忌口)/);
        if (notEatMatch) {
          const val = '不吃' + (notEatMatch[1] || notEatMatch[2]).trim();
          if (!person.taboos.includes(val)) { person.taboos.push(val); updated = true; }
        }
        const hateMatch = cleanPart.match(/(?:讨厌|最烦|最怕|不喜欢)\s*([^，,。！？]+)/);
        if (hateMatch) {
          const val = '讨厌' + hateMatch[1].trim();
          if (!person.taboos.includes(val)) { person.taboos.push(val); updated = true; }
        }

        const likeMatch = cleanPart.match(/(?:(?<![不讨厌])(?:喜欢|最爱|偏好|偏爱)|爱吃|爱喝)\s*([^，,。！？]+)/);
        if (likeMatch) {
          const val = '喜欢' + likeMatch[1].trim();
          if (!person.preferences.includes(val)) { person.preferences.push(val); updated = true; }
        }
        const wantMatch = cleanPart.match(/(?:想要|想买)\s*([^，,。！？]+)/);
        if (wantMatch) {
          const val = '想要' + wantMatch[1].trim();
          if (!person.preferences.includes(val)) { person.preferences.push(val); updated = true; }
        }

        const dateMatch = cleanPart.match(/(?:生日|纪念日)\s*(?:是|在)?\s*([^，,。！？]+)/);
        if (dateMatch) {
          person.nextImportantDate = dateMatch[1].trim();
          updated = true;
        }
      }

      if (updated) {
        person.updatedAt = Date.now();
        touchedPersons.add(person.name);
      }
    };

    let lastPersonName: string | null = null;
    for (const rawCl of facts) {
      if (bookedClauses.has(rawCl)) continue;
      if (/(?:预算|项目|合同额|报价|工作|存入|攒了|花了|买了|打车|发工资)/.test(rawCl)
        || /(?:总监|经理|老板|主理人|院长|行长|厂长|处长|局长|科长|书记|律师|顾问|合伙人|董|(?<![我表堂大二小])[\u4e00-\u9fa5]总)/.test(rawCl)) continue;
      let cl = rawCl.replace(/^(?:记一下|记住|备忘|提醒我(?:记住)?|顺便说一下|还有|另外|而且|而|但|但是|然后|至于|其实|平时|今天|昨天|刚才|顺便)[，,：:\s]*/, '').trim();
      if (!cl) continue;

      // 0. 主语显式为【我】时重置亲友上下文（防止“而我喜欢吃...”错挂到上一位亲友）
      const explicitSelf = !KIN_REGEX.test(cl) ? cl.match(SELF_PREFIX) : null;
      if (explicitSelf) {
        lastPersonName = null;
        let restSelf = cl.slice(explicitSelf[0].length).trim();
        restSelf = restSelf.replace(/^(?:还|也|又|其实|平时|经常|特别|很|十分|最|比较|超级|极其|一直|就|都)+/, '').trim();

        const scopedSelf = cl.match(/(?:(?:我|平时|自己)\s*)?([^\s，,。；！？]+?)\s*(?:只喝|只要|只吃|只用|只选|只买|不吃|不喝|不放|不要|偏好|最爱)\s*([^\s，,。；！？]+)/);
        const prefMatch = restSelf.match(/^(?:特别?|极其|最|一直|比较)?\s*(喜欢|爱吃|爱喝|最爱|偏爱|偏好|想要|讨厌|最烦|最怕|不喜欢|不吃|不能吃|不喝|不能喝|只吃|只喝|只选|只买|只用|只看|不要|不碰|忌口|对.+?过敏|从不(?:吃|喝|碰)?)\s*(.+)/);
        if (prefMatch && !(scopedSelf && /只喝|只要|只吃|只用|只选|只买/.test(cl) && !/^(?:只喝|只吃|只选|只买|只用)/.test(restSelf))) {
          const verb = prefMatch[1];
          const content = prefMatch[2].replace(/[，,。！？\s]+$/, '').trim();
          if (content && content.length >= 2 && !/^\d+$/.test(content)) {
            const isTaboo = /讨厌|最烦|最怕|不喜欢|不吃|不能吃|不喝|不能喝|不要|不碰|忌口|过敏|从不/.test(verb);
            pushLifeMem('我', isTaboo ? '生活禁忌与不适' : '个人偏好与心愿', `我${verb}${content}`, 'preference', 4);
            continue;
          }
        }
        if (scopedSelf) {
          const fullPref = cl.replace(/^(?:记一下|记住|还有|另外|顺便)[，,：:\s]*/, '').trim();
          if (fullPref.length >= 3 && !/^\d+$/.test(fullPref)) {
            pushLifeMem('我', '个人喜好与偏好', `我${fullPref.replace(/^我/, '')}`, 'preference', 4);
            continue;
          }
        }
        if (restSelf.length >= 3) {
          pushLifeMem('我', '个人喜好与偏好', `我${restSelf}`, 'preference', 4);
          continue;
        }
      }

      // 1. 已知亲友称谓
      const kinMatch = cl.match(KIN_REGEX);
      if (kinMatch) {
        const personName = normalizeKin(kinMatch[0]);
        lastPersonName = personName;
        let rest = cl.slice(kinMatch[0].length).trim();
        rest = rest.replace(/^(?:还|也|又|其实|平时|经常|特别|很|十分|最|比较|超级|极其|一直|就|都)+/, '').trim();
        updatePersonInfo(personName, rest);
        continue;
      }

      // 2. 同句续接上一位亲友的后续分句（如“我妈对青霉素过敏，平时也不吃香菜” / “老爸血压高不碰咸菜，爱喝铁观音” / “小林芒果过敏，生日是6月12号”）
      if (lastPersonName && PERSON_CONT_PREFIX.test(cl)) {
        const restCont = cl.replace(/^(?:还|也|又|其实|平时|经常|特别|很|十分|最|比较|超级|极其|一直|就|都)+/, '').trim();
        updatePersonInfo(lastPersonName, restCont);
        continue;
      }

      // 3. 自定义亲友姓名（如老王芒果过敏、小林芒果过敏、张阿姨忌口牛羊肉，排除以“我”开头和黑名单）
      const nameMatch = cl.match(/^([^我\s，,。！？\d]{2,4}?)\s*(?:还|也|又|其实|平时|经常|特别|很|十分|最|比较|超级|极其|一直|就|都)?\s*(?:对.+?过敏|[^，,。！？\s]{1,8}?过敏|不吃|不能吃|忌口|不喝|不能喝|不碰|戒了?|讨厌|最烦|最怕|不喜欢|喜欢|爱吃|爱喝|最爱|偏好|偏爱|想要|想买|生日|纪念日)/);
      if (nameMatch && !NON_PERSON_BLACKLIST.has(nameMatch[1]) && !/(?:过敏|忌口|不吃|不喝|喜欢|讨厌|血压|健康|身体|肠胃|皮肤|生活|日常|习惯|工作)/.test(nameMatch[1])) {
        const personName = nameMatch[1];
        lastPersonName = personName;
        let restName = cl.slice(nameMatch[1].length).trim();
        restName = restName.replace(/^(?:还|也|又|其实|平时|经常|特别|很|十分|最|比较|超级|极其|一直|就|都)+/, '').trim();
        updatePersonInfo(personName, restName);
        continue;
      }

      // 4. 专属排他习惯与偏好（无明确主语，如“喝咖啡只喝无糖拿铁”）
      const scopedMatch = cl.match(/(?:(?:我|平时|自己)\s*)?([^\s，,。；！？]{2,8}?)\s*(?:只喝|只要|只吃|只用|只选|只买|不吃|不喝|不放|不要|偏好|最爱)\s*([^\s，,。；！？]+)/);
      if (scopedMatch && !/^[也还又都就才]/.test(scopedMatch[1])) {
        const fullPref = cl.replace(/^(?:记一下|记住|还有|另外|顺便)[，,：:\s]*/, '').trim();
        if (fullPref.length >= 3 && !/^\d+$/.test(fullPref)) {
          lastPersonName = null;
          pushLifeMem('我', '个人喜好与偏好', `我${fullPref.replace(/^我/, '')}`, 'preference', 4);
          continue;
        }
      }

      // 5. 作息生活规律（习惯）
      const habitMatch = rawCl.match(/(?:(?:我|平时|自己)\s*)?(?:习惯(?:于)?|每天|经常|通常|总是|每(?:周|天|月))\s*(.+)/);
      if (habitMatch) {
        const habitContent = habitMatch[1].replace(/[，,。！？\s]+$/, '').trim();
        if (habitContent && habitContent.length >= 3) {
          pushLifeMem('我', '作息与生活规律', `平时习惯${habitContent}`, 'habit', 4);
          continue;
        }
      }

      // 6. 泛生活经验与备忘事实（车位/位置/门禁密码/家居存放分开 topic 避免互相覆盖）
      const memoPrefixMatch = rawCl.match(/(?:记一下|记住|备忘|提醒我记住|千万别忘)\s*[:：]?\s*(.+)/);
      const locationOrFactMatch = !memoPrefixMatch && /(?:家里|合同|密码|卡放在|放在|地址是|停在|车位|停车位|门禁|WiFi|wifi|钥匙|快递柜|门牌)/.test(rawCl)
        ? [rawCl, rawCl.replace(/^(?:家里)\s*[:：]?\s*/, '')]
        : null;
      const factMatch = memoPrefixMatch || locationOrFactMatch;
      if (factMatch) {
        const factContent = factMatch[1].replace(/[，,。！？\s]+$/, '').trim();
        if (factContent && factContent.length >= 3) {
          const factTopic = /(?:车位|停在|地库|停车)/.test(factContent)
            ? '车位与出行位置'
            : /(?:密码|门禁|wifi|WiFi)/.test(factContent)
              ? '账号密码与门禁'
              : '重要生活事实';
          pushLifeMem('生活备忘', factTopic, factContent, 'experience', 4);
        }
      }
    }

    // 亲友档案记忆同步与回执
    for (const name of touchedPersons) {
      receipt('relationships', `已记录 ${name} 的亲友资料`);
      const p = life.persons.find(item => item.name === name);
      if (p) {
        const subject = ['妈', '爸', '姐', '哥', '弟', '妹'].includes(p.name) ? `我${p.name}` : p.name;
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
