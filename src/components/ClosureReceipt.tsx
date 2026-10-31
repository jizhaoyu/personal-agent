import React from 'react';
import { Check, ArrowRight, FileText, RotateCcw, BookOpen } from 'lucide-react';
import type { ClosureRecord, Message, Engagement, ProjectTaskItem, FollowUpItem, CommittedChangeEvent } from '../types';
import { eventMutations } from '../../shared/persistence-core.mjs';

export interface ClosureReceiptProps {
  closure: ClosureRecord;
  source?: Message | null;
  event?: CommittedChangeEvent | null;
  engagements: Engagement[];
  tasks: ProjectTaskItem[];
  followUps: FollowUpItem[];
  onProject(id: string): void;
  onContinue(): void;
  onExport(engagement: Engagement): void;
  onUndo?(eventId: string): void;
  practice?: boolean;
}
const time = (value: string | number) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export function ClosureReceipt({ closure, source, event, engagements, tasks, followUps, onProject, onContinue, onExport, onUndo, practice = false }: ClosureReceiptProps) {
  const mutations = event ? eventMutations(event) : [];
  function historical<T extends { id: string }>(kind: string, ids: string[]): T[] {
    return ids.map(id => {
      const mutation = mutations.find(item => item.kind === kind && item.id === id);
      return mutation?.after as T | null | undefined;
    }).filter((row): row is T => !!row);
  }
  const projects = historical<Engagement>('engagement', closure.engagementIds);
  const actions = historical<ProjectTaskItem>('task', closure.taskIds);
  const related = historical<FollowUpItem>('followup', closure.followUpIds);
  const waiting = related.filter(item => item.kind === 'waiting');
  const questions = related.filter(item => item.kind === 'question');
  const firstProject = engagements.find(item => closure.engagementIds.includes(item.id));
  const reverted = !!closure.revertedAt || !!event?.revertedAt;
  return <section className={`closure-receipt${reverted ? ' closure-receipt--reverted' : ''}`} aria-label={practice ? '演练回执' : '本次沟通收尾记录'}>
    <div className="receipt-heading"><span className="receipt-check"><Check size={21}/></span><div><span className="eyebrow">{practice ? 'LOOMA · PRACTICE RECEIPT' : 'LOOMA · YOUR RECORD'}</span><h2>{practice ? reverted ? '这次演练记录已撤销' : '演练回执：这次沟通已核对。' : reverted ? '这次记录已撤销' : closure.originalOnly ? '原文已留在这里' : '这次沟通，已核对保存。'}</h2></div></div>
    <p className="receipt-boundary">{practice ? '演练资料，仅在当前窗口临时保留，关闭后丢弃。' : reverted ? '原文仍保留，项目与行动以当前资料为准。' : closure.originalOnly ? '仅保存原文，未更新项目或安排提醒。' : '这是你核对过的内部记录，不表示客户已经确认共识。'}<span>{time(closure.confirmedAt)} · 北京时间</span></p>
    {!closure.originalOnly && !event && <p className="notice" role="status">本次变更依据已删除或暂不可用。可查看当前项目；这张回执暂无法还原当时内容。</p>}
    {!closure.originalOnly && event && <div className="receipt-sections">
      <section aria-label="已核对内容"><h3>已核对内容 <span>{projects.length}</span></h3>{projects.length ? projects.map(project => {
        const change = mutations.find(item => item.kind === 'engagement' && item.id === project.id);
        const showBudget = !change || change.before?.budgetAmount !== change.after?.budgetAmount;
        return <article className="receipt-record" key={project.id}><strong>{project.clientName} · {project.title}</strong>{showBudget && <p>{project.budgetAmount === undefined ? '预算尚未确认' : `预算参考 ¥${project.budgetAmount.toLocaleString('zh-CN')} 元`}</p>}{change?.before?.stage !== project.stage && <p>当前进展：{project.stage}</p>}</article>;
      }) : <p className="muted small">本次没有更新项目字段。</p>}</section>
      <section aria-label="我方下一步"><h3>我方下一步 <span>{closure.taskIds.length}</span></h3>{actions.length ? actions.map(action => <article className="receipt-record" key={action.id}><strong>{action.title}</strong><p>{action.dueAt ? `${time(action.dueAt)}（我方提醒）` : '提醒时间尚未设置'}</p></article>) : <p className="muted small">本次没有新增我方行动。</p>}</section>
      <section aria-label="等待客户"><h3>等待客户 <span>{waiting.length}</span></h3>{waiting.length ? waiting.map(item => <article className="receipt-record" key={item.id}><strong>{item.title}</strong><p>{item.expectedDate ? `客户预计 ${item.expectedDate}（未约定具体时刻）` : item.expectedAt ? `客户预计 ${time(item.expectedAt)}` : '对方时间尚未确定'}</p><p>{item.reviewAt ? `我方回访：${time(item.reviewAt)}` : '未设置我方回访，不会自动催促'}</p></article>) : <p className="muted small">本次没有新增等待事项。</p>}</section>
      <section aria-label="仍待确认"><h3>仍待确认 <span>{questions.length}</span></h3>{questions.length ? questions.map(item => <article className="receipt-record" key={item.id}><strong>{item.title}</strong><p>尚未作为确定的预算、日期或承诺。</p></article>) : <p className="muted small">本次没有新增待确认问题。</p>}</section>
    </div>}
    {(waiting.length > 0 || questions.length > 0) && !reverted && <p className="receipt-open-note">这些等待和未定内容会留在项目里，下次可以接着核对。</p>}
    <p className="receipt-reminder-note">{practice ? '演练不会发送通知，也不会安排真实提醒。' : 'Looma 开启时（含胶囊）才会提醒，退出后不提醒；重新打开会汇总遗漏事项。'}</p>
    <div className="receipt-actions"><button className="soft-btn" disabled={!firstProject} onClick={() => firstProject && onProject(firstProject.id)}>查看项目 <ArrowRight size={14}/></button><button className="primary-btn" onClick={onContinue}>{practice ? '重新练习' : '继续记录'} <ArrowRight size={14}/></button><button className="text-btn" disabled={practice || !firstProject || reverted} onClick={() => !practice && firstProject && onExport(firstProject)}><FileText size={14}/>{practice ? '演练中不准备纪要' : '准备纪要'}</button></div>
    <details className="receipt-source"><summary><BookOpen size={14}/>查看本次来源与历史记录</summary>{source ? <p>{source.content}</p> : <p>来源原文已删除或暂不可用，独立确认的业务资料仍保留。</p>}<small>记录编号：{closure.id}</small>{onUndo && <button className="text-btn" disabled={reverted} onClick={() => onUndo(closure.eventId)}><RotateCcw size={13}/>撤销这次记录</button>}</details>
  </section>;
}
