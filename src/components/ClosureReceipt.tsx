import React from 'react';
import { Check, ArrowRight, FileText, RotateCcw, BookOpen } from 'lucide-react';
import type { ClosureRecord, Message, Engagement, ProjectTaskItem, FollowUpItem, ConditionIntent, CommittedChangeEvent } from '../types';
import { eventMutations } from '../../shared/persistence-core.mjs';
import { formatBudgetAmount, formatDealStage, formatShanghaiTime, useI18n } from '../i18n';

export interface ClosureReceiptProps {
  closure: ClosureRecord;
  source?: Message | null;
  event?: CommittedChangeEvent | null;
  engagements: Engagement[];
  tasks: ProjectTaskItem[];
  followUps: FollowUpItem[];
  conditions?: ConditionIntent[];
  onProject(id: string): void;
  onContinue(): void;
  onExport(engagement: Engagement): void;
  onUndo?(eventId: string): void;
  practice?: boolean;
}

export function ClosureReceipt({ closure, source, event, engagements, tasks, followUps, onProject, onContinue, onExport, onUndo, practice = false }: ClosureReceiptProps) {
  const { lang, t } = useI18n();
  const time = (value: string | number) => formatShanghaiTime(value, lang);
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
  const conditionItems = historical<ConditionIntent>('condition', closure.conditionIds || []);
  const waiting = related.filter(item => item.kind === 'waiting');
  const questions = related.filter(item => item.kind === 'question');
  const firstProject = engagements.find(item => closure.engagementIds.includes(item.id));
  const reverted = !!closure.revertedAt || !!event?.revertedAt;
  const conditionLabel = (status: ConditionIntent['status']) => status === 'ready'
    ? t('work.condReady')
    : status === 'watching'
      ? t('work.condWatching')
      : status === 'draft'
        ? t('work.condDraft')
        : status === 'paused'
          ? t('work.condPaused')
          : status === 'cancelled'
            ? t('work.condCancelled')
            : t('work.condCompleted');
  return <section className={`closure-receipt${reverted ? ' closure-receipt--reverted' : ''}`} aria-label={practice ? t('closure.ariaPractice') : t('closure.ariaRecord')}>
    <div className="receipt-heading"><span className="receipt-check"><Check size={21}/></span><div><span className="eyebrow">{practice ? t('closure.eyebrowPractice') : t('closure.eyebrowRecord')}</span><h2>{practice ? reverted ? t('closure.headingPracticeReverted') : t('closure.headingPracticeDone') : reverted ? t('closure.headingRecordReverted') : closure.originalOnly ? t('closure.headingRecordOriginal') : t('closure.headingRecordDone')}</h2></div></div>
    <p className="receipt-boundary">{practice ? t('closure.boundaryPractice') : reverted ? t('closure.boundaryReverted') : closure.originalOnly ? t('closure.boundaryOriginal') : t('closure.boundaryDone')}<span>{time(closure.confirmedAt)}{t('closure.beijingTimeSuffix')}</span></p>
    {!closure.originalOnly && !event && <p className="notice" role="status">{t('closure.eventMissingNotice')}</p>}
    {!closure.originalOnly && event && <div className="receipt-sections">
      <section aria-label={t('closure.secReviewed')}><h3>{t('closure.secReviewed')} <span>{projects.length}</span></h3>{projects.length ? projects.map(project => {
        const change = mutations.find(item => item.kind === 'engagement' && item.id === project.id);
        const showBudget = !change || change.before?.budgetAmount !== change.after?.budgetAmount;
        return <article className="receipt-record" key={project.id}><strong>{project.clientName} · {project.title}</strong>{showBudget && <p>{project.budgetAmount === undefined ? t('closure.budgetUnconfirmed') : `${t('closure.budgetRefPrefix')}${formatBudgetAmount(project.budgetAmount, lang)}${t('closure.budgetRefSuffix')}`}</p>}{change?.before?.stage !== project.stage && <p>{t('closure.stagePrefix')}{formatDealStage(project.stage, lang)}</p>}</article>;
      }) : <p className="muted small">{t('closure.noProjectFieldChanges')}</p>}</section>
      <section aria-label={t('closure.secSelf')}><h3>{t('closure.secSelf')} <span>{closure.taskIds.length}</span></h3>{actions.length ? actions.map(action => <article className="receipt-record" key={action.id}><strong>{action.title}</strong><p>{action.dueAt ? `${time(action.dueAt)}${t('closure.ourReminderSuffix')}` : t('closure.reminderUnset')}</p></article>) : <p className="muted small">{t('closure.noNewActions')}</p>}</section>
      <section aria-label={t('closure.secWaiting')}><h3>{t('closure.secWaiting')} <span>{waiting.length}</span></h3>{waiting.length ? waiting.map(item => <article className="receipt-record" key={item.id}><strong>{item.title}</strong><p>{item.expectedDate ? `${t('closure.expectedPrefix')}${item.expectedDate}${t('closure.expectedNoTimeSuffix')}` : item.expectedAt ? `${t('closure.expectedPrefix')}${time(item.expectedAt)}` : t('closure.clientTimeTbd')}</p><p>{item.reviewAt ? `${t('closure.ourReviewPrefix')}${time(item.reviewAt)}` : t('closure.noReviewScheduled')}</p></article>) : <p className="muted small">{t('closure.noNewWaiting')}</p>}</section>
      <section aria-label={t('closure.secQuestions')}><h3>{t('closure.secQuestions')} <span>{questions.length}</span></h3>{questions.length ? questions.map(item => <article className="receipt-record" key={item.id}><strong>{item.title}</strong><p>{t('closure.questionNote')}</p></article>) : <p className="muted small">{t('closure.noNewQuestions')}</p>}</section>
      {conditionItems.length > 0 && <section aria-label={t('closure.secConditions')}><h3>{t('closure.secConditions')} <span>{conditionItems.length}</span></h3>{conditionItems.map(item => <article className="receipt-record" key={item.id}><strong>{t('work.condTitlePrefix')}{item.conditionText}</strong><p>{t('closure.condThenPrefix')}{item.actionTitle}（{conditionLabel(item.status)} · v{item.revision}）</p></article>)}</section>}
    </div>}
    {(waiting.length > 0 || questions.length > 0) && !reverted && <p className="receipt-open-note">{t('closure.openItemsNote')}</p>}
    <p className="receipt-reminder-note">{practice ? t('closure.reminderPracticeNote') : t('closure.reminderDesktopNote')}</p>
    <div className="receipt-actions"><button className="soft-btn" disabled={!firstProject} onClick={() => firstProject && onProject(firstProject.id)}>{t('closure.viewProjectBtn')}<ArrowRight size={14}/></button><button className="primary-btn" onClick={onContinue}>{practice ? t('closure.practiceAgainBtn') : t('closure.continueRecordBtn')} <ArrowRight size={14}/></button><button className="text-btn" disabled={practice || !firstProject || reverted} onClick={() => !practice && firstProject && onExport(firstProject)}><FileText size={14}/>{practice ? t('closure.prepareNotesPractice') : t('closure.prepareNotesBtn')}</button></div>
    <details className="receipt-source"><summary><BookOpen size={14}/>{t('closure.sourceDetailsSummary')}</summary>{source ? <p>{source.content}</p> : <p>{t('closure.sourceDeletedNote')}</p>}<small>{t('closure.recordIdPrefix')}{closure.id}</small>{onUndo && <button className="text-btn" disabled={reverted} onClick={() => onUndo(closure.eventId)}><RotateCcw size={13}/>{t('closure.undoRecordBtn')}</button>}</details>
  </section>;
}
