import type { AppLanguage, ArtifactDraft, ArtifactType, ConditionIntent } from '../types';

const STAGE_EN: Record<string, string> = {
  '初步接触': 'Initial Contact',
  '需求确认': 'Scope & Discovery',
  '方案报价': 'Proposal & Quote',
  '商务谈判': 'Negotiation',
  '赢单成交': 'Closed Won',
};

const CONDITION_STATUS_LABELS: Record<ConditionIntent['status'], Record<AppLanguage, string>> = {
  draft: { 'zh-CN': '草稿（待明确条件）', en: 'Draft (trigger pending)' },
  watching: { 'zh-CN': '观察中', en: 'Watching' },
  ready: { 'zh-CN': '已就绪（可推进）', en: 'Ready to advance' },
  paused: { 'zh-CN': '已暂停', en: 'Paused' },
  completed: { 'zh-CN': '已完成', en: 'Completed' },
  cancelled: { 'zh-CN': '已取消', en: 'Cancelled' },
};

const CONDITION_KIND_LABELS: Record<ConditionIntent['conditionKind'], Record<AppLanguage, string>> = {
  followup_resolved: { 'zh-CN': '等待客户事项收到后就绪', en: 'Ready once client dependency resolves' },
  manual_confirm: { 'zh-CN': '由我人工确认满足', en: 'Manually confirmed by me' },
};

const ARTIFACT_TYPE_I18N: Record<ArtifactType, Record<AppLanguage, string>> = {
  proposal_brief: { 'zh-CN': '方案简报', en: 'Proposal Brief' },
  material_checklist: { 'zh-CN': '材料清单', en: 'Materials Checklist' },
  meeting_brief: { 'zh-CN': '沟通纪要', en: 'Meeting Brief' },
};

const ARTIFACT_STATUS_I18N: Record<ArtifactDraft['status'], Record<AppLanguage, string>> = {
  draft: { 'zh-CN': '草稿', en: 'Draft' },
  needs_review: { 'zh-CN': '需核对', en: 'Needs Review' },
  ready: { 'zh-CN': '已可查看', en: 'Ready' },
};

const EXPENSE_CATEGORY_EN: Record<string, string> = {
  '餐饮☕': 'Food & Drinks ☕',
  '购物🛍️': 'Shopping 🛍️',
  '出行🚕': 'Transport 🚕',
  '娱乐🎮': 'Leisure 🎮',
  '生活🏠': 'Home & Living 🏠',
  '金库✨': 'Wish Vault ✨',
};

export function formatExpenseCategory(category: string, lang: AppLanguage = 'zh-CN'): string {
  if (lang === 'en') return EXPENSE_CATEGORY_EN[category] || category;
  return category;
}

export function formatDealStage(stage: string, lang: AppLanguage = 'zh-CN'): string {
  if (lang === 'en') return STAGE_EN[stage] || stage;
  return stage;
}

export function formatConditionStatus(status: ConditionIntent['status'] | string, lang: AppLanguage = 'zh-CN'): string {
  const row = CONDITION_STATUS_LABELS[status as ConditionIntent['status']];
  return row ? row[lang] : String(status);
}

export function formatConditionKind(kind: ConditionIntent['conditionKind'] | string, lang: AppLanguage = 'zh-CN'): string {
  const row = CONDITION_KIND_LABELS[kind as ConditionIntent['conditionKind']];
  return row ? row[lang] : String(kind);
}

export function formatArtifactType(type: ArtifactType, lang: AppLanguage = 'zh-CN'): string {
  return ARTIFACT_TYPE_I18N[type]?.[lang] || type;
}

export function formatArtifactStatus(status: ArtifactDraft['status'], lang: AppLanguage = 'zh-CN'): string {
  return ARTIFACT_STATUS_I18N[status]?.[lang] || status;
}

export function formatNumber(amount: number, lang: AppLanguage = 'zh-CN'): string {
  return amount.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN');
}

export function formatBudgetAmount(amount: number, lang: AppLanguage = 'zh-CN'): string {
  return lang === 'en' ? `CNY ${formatNumber(amount, 'en')}` : `¥${amount}`;
}

export function formatShanghaiTime(value: string | number, lang: AppLanguage = 'zh-CN'): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
