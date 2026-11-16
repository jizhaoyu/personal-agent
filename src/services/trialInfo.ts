import type { AppLanguage } from '../types';

export interface TrialBuildInfo {
  productVersion: string;
  buildId: string;
  builtAt: string;
  channel: string;
}
export interface TrialContext {
  mode: 'work' | 'life';
  phase: 'idle' | 'draft' | 'review' | 'saving' | 'uncertain' | 'receipt' | 'memory';
  hasError: boolean;
}
export interface TrialFeedbackDetails {
  expected?: string;
  actual?: string;
  repeatability?: 'unknown' | 'yes' | 'no';
}
const phases: Record<TrialContext['phase'], Record<AppLanguage, string>> = {
  idle: { 'zh-CN': '接续首页', en: 'Home Continuation' },
  draft: { 'zh-CN': '记录草稿', en: 'Drafting' },
  review: { 'zh-CN': '核对内容', en: 'Reviewing Proposal' },
  saving: { 'zh-CN': '正在保存', en: 'Saving' },
  uncertain: { 'zh-CN': '核查保存结果', en: 'Verifying Save Result' },
  receipt: { 'zh-CN': '查看收尾记录', en: 'Closure Receipt' },
  memory: { 'zh-CN': '记忆与档案', en: 'Memory & Archive' },
};
const publicToken = (value: unknown, max: number, fallback: string) =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : fallback;
const dateText = (value: unknown, fallback: string) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback;
const userText = (value: unknown, fallback: string) =>
  typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 2000) || fallback
    : fallback;

/** Builds a visible, user-exported note. It never reads storage, business data, errors or the network. */
export function buildTrialReport(
  input: { buildInfo: TrialBuildInfo; context: TrialContext; details?: TrialFeedbackDetails },
  at = Date.now(),
  lang: AppLanguage = 'zh-CN',
): string {
  const build = input.buildInfo || {} as TrialBuildInfo;
  const context = input.context || {} as TrialContext;
  const details = input.details || {};
  const unknown = lang === 'en' ? 'Unknown' : '未知';
  const blank = lang === 'en' ? 'Not provided' : '尚未填写';
  const mode = context.mode === 'work'
    ? (lang === 'en' ? 'Work' : '工作空间')
    : context.mode === 'life'
      ? (lang === 'en' ? 'Life' : '生活空间')
      : unknown;
  const phase = Object.prototype.hasOwnProperty.call(phases, context.phase) ? phases[context.phase][lang] : unknown;
  const repeatability = details.repeatability === 'yes'
    ? (lang === 'en' ? 'Reproducible' : '可以重复')
    : details.repeatability === 'no'
      ? (lang === 'en' ? 'Not reproduced yet' : '暂未重复出现')
      : (lang === 'en' ? 'Uncertain' : '未确定');
  const recordedAt = Number.isFinite(at) ? new Date(at).toISOString() : unknown;
  if (lang === 'en') {
    return [
      'Looma Trial Issue Report',
      `Recorded At (UTC): ${recordedAt}`,
      `Product Version: ${publicToken(build.productVersion, 40, unknown)}`,
      `Build ID: ${publicToken(build.buildId, 100, unknown)}`,
      `Built At (UTC): ${dateText(build.builtAt, unknown)}`,
      `Channel: ${publicToken(build.channel, 60, unknown)}`,
      `Space: ${mode}`,
      `Step: ${phase}`,
      `General Status: ${context.hasError === true ? 'UI_ERROR_PRESENT' : 'NONE'}`,
      '', 'Entered by User:',
      `Expected Behavior:\n${userText(details.expected, blank)}`,
      `Actual Behavior:\n${userText(details.actual, blank)}`,
      `Reproducible: ${repeatability}`,
      '', 'Default metadata excludes client transcripts, internal notes, business records, credentials, API URLs, database files, and OS paths.',
      'Confirm any manually typed details are redacted before sharing; nothing is transmitted automatically.',
    ].join('\n');
  }
  return [
    'Looma 试用问题记录',
    `记录时间（UTC）：${recordedAt}`,
    `产品版本：${publicToken(build.productVersion, 40, unknown)}`,
    `构建编号：${publicToken(build.buildId, 100, unknown)}`,
    `构建时间（UTC）：${dateText(build.builtAt, unknown)}`,
    `使用渠道：${publicToken(build.channel, 60, unknown)}`,
    `所在空间：${mode}`,
    `所在步骤：${phase}`,
    `通用状态编号：${context.hasError === true ? 'UI_ERROR_PRESENT' : 'NONE'}`,
    '', '以下内容由使用者主动填写：',
    `预期发生什么：\n${userText(details.expected, blank)}`,
    `实际发生什么：\n${userText(details.actual, blank)}`,
    `是否可重复：${repeatability}`,
    '', '默认信息不含客户原文、内部备注、业务实体、凭据、接口地址、数据库或系统路径。',
    '请确认主动填写的描述也已脱敏；此记录不会自动发送，由你决定是否分享。',
  ].join('\n');
}
