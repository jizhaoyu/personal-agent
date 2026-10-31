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
const phases: Record<TrialContext['phase'], string> = {
  idle: '接续首页', draft: '记录草稿', review: '核对内容', saving: '正在保存',
  uncertain: '核查保存结果', receipt: '查看收尾记录', memory: '记忆与档案',
};
const publicToken = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : '未知';
const dateText = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '未知';
const userText = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 2000) || '尚未填写' : '尚未填写';

/** Builds a visible, user-exported note. It never reads storage, business data, errors or the network. */
export function buildTrialReport(input: { buildInfo: TrialBuildInfo; context: TrialContext; details?: TrialFeedbackDetails }, at = Date.now()): string {
  const build = input.buildInfo || {} as TrialBuildInfo;
  const context = input.context || {} as TrialContext;
  const details = input.details || {};
  const mode = context.mode === 'work' ? '工作空间' : context.mode === 'life' ? '生活空间' : '未知';
  const phase = Object.prototype.hasOwnProperty.call(phases, context.phase) ? phases[context.phase] : '未知';
  const repeatability = details.repeatability === 'yes' ? '可以重复' : details.repeatability === 'no' ? '暂未重复出现' : '未确定';
  return [
    'Looma 试用问题记录',
    `记录时间（UTC）：${Number.isFinite(at) ? new Date(at).toISOString() : '未知'}`,
    `产品版本：${publicToken(build.productVersion, 40)}`,
    `构建编号：${publicToken(build.buildId, 100)}`,
    `构建时间（UTC）：${dateText(build.builtAt)}`,
    `使用渠道：${publicToken(build.channel, 60)}`,
    `所在空间：${mode}`,
    `所在步骤：${phase}`,
    `通用状态编号：${context.hasError === true ? 'UI_ERROR_PRESENT' : 'NONE'}`,
    '', '以下内容由使用者主动填写：',
    `预期发生什么：\n${userText(details.expected)}`,
    `实际发生什么：\n${userText(details.actual)}`,
    `是否可重复：${repeatability}`,
    '', '默认信息不含客户原文、内部备注、业务实体、凭据、接口地址、数据库或系统路径。',
    '请确认主动填写的描述也已脱敏；此记录不会自动发送，由你决定是否分享。',
  ].join('\n');
}
