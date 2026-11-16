import React, { useState } from 'react';
import { ArrowLeft, FlaskConical, RefreshCcw, X } from 'lucide-react';
import type { Engagement, ProposedChangeSet } from '../types';
import {
  commitPractice,
  createPractice,
  editPracticeProposal,
  proposePractice,
  revisePractice,
  undoPractice,
  type PracticeState,
} from '../services/practice';
import { formatBudgetAmount, formatDealStage, useI18n } from '../i18n';
import { ClosureReceipt } from './ClosureReceipt';
import { ProposalReview } from './ProposalReview';
import './practice.css';

export interface PracticeModalProps {
  onClose(): void;
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return fallback;
}

export function PracticeModal({ onClose }: PracticeModalProps) {
  const { t } = useI18n();
  const [practice, setPractice] = useState<PracticeState>(() => createPractice());
  const [error, setError] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);

  function apply(action: (current: PracticeState) => PracticeState) {
    try {
      const next = action(practice);
      setPractice(next);
      setError('');
      return next;
    } catch (cause) {
      setError(errorText(cause, t('practice.errorFallback')));
      return null;
    }
  }

  function revise(text: string) {
    apply(current => revisePractice(current, text));
  }

  function review() {
    apply(current => proposePractice(current));
  }

  function editProposal(proposal: ProposedChangeSet) {
    apply(current => editPracticeProposal(current, proposal));
  }

  function commit() {
    apply(current => commitPractice(current));
  }

  function undo() {
    apply(current => undoPractice(current));
    setProjectId(null);
  }

  function restart() {
    try {
      setPractice(createPractice());
      setProjectId(null);
      setError('');
    } catch (cause) {
      setError(errorText(cause, t('practice.errorFallback')));
    }
  }

  const followUps = practice.partition.followUps || [];
  const selectedProject = projectId ? practice.partition.engagements.find(project => project.id === projectId) : null;

  return <div className="practice-backdrop" role="presentation">
    <section className="practice-sheet" role="dialog" aria-modal="true" aria-labelledby="practice-title">
      <header className="practice-header">
        <div className="practice-title"><span className="practice-icon"><FlaskConical size={19}/></span><div><span className="eyebrow">{t('practice.eyebrow')}</span><h2 id="practice-title">{t('practice.title')}</h2></div></div>
        <button type="button" autoFocus className="practice-close" aria-label={t('practice.closeAria')} onClick={onClose}><X size={20}/></button>
      </header>

      <p className="practice-boundary" role="note"><strong>{t('practice.boundaryStrong')}</strong><span>{t('practice.boundaryRest')}</span></p>
      {error && <p className="practice-error" role="alert">{error}</p>}

      {projectId && <PracticeProject project={selectedProject} onBack={() => setProjectId(null)}/>}

      {!projectId && practice.closure && <div className="practice-result">
        <ClosureReceipt
          closure={practice.closure}
          source={practice.source}
          event={practice.event}
          engagements={practice.partition.engagements}
          tasks={practice.partition.tasks}
          followUps={followUps}
          onProject={id => setProjectId(id)}
          onContinue={restart}
          onExport={() => {}}
          onUndo={undo}
          practice
        />
        <button type="button" className="soft-btn practice-restart" onClick={restart}><RefreshCcw size={14}/>{t('practice.restartBtn')}</button>
      </div>}

      {!projectId && !practice.closure && practice.draft.proposal && <ProposalReview
        proposal={practice.draft.proposal}
        engagements={practice.partition.engagements}
        onChange={editProposal}
        onConfirm={commit}
        onDiscard={() => revise(practice.draft.text)}
        onReparse={review}
      />}

      {!projectId && !practice.closure && !practice.draft.proposal && <section className="practice-capture" aria-label={t('practice.inputAria')}>
        <div className="practice-step"><span>1</span><div><h3>{t('practice.stepHeading')}</h3><p>{t('practice.stepDesc')}</p></div></div>
        <label htmlFor="practice-source">{t('practice.sourceLabel')}</label>
        <textarea id="practice-source" aria-label={t('practice.sourceLabel')} rows={6} value={practice.draft.text} onChange={event => revise(event.target.value)}/>
        <div className="practice-capture-actions"><small>{t('practice.noRealRecordsHint')}</small><button type="button" className="primary-btn" onClick={review}>{t('practice.organizeAndReviewBtn')}</button></div>
      </section>}
    </section>
  </div>;
}

function PracticeProject({ project, onBack }: { project?: Engagement | null; onBack(): void }) {
  const { lang, t } = useI18n();
  return <section className="practice-project" aria-label={t('practice.projectAria')}>
    <button type="button" className="text-btn" onClick={onBack}><ArrowLeft size={14}/>{t('practice.backToReceipt')}</button>
    <span className="eyebrow">{t('practice.projectEyebrow')}</span>
    {project ? <>
      <h3>{project.clientName} · {project.title}</h3>
      <dl><div><dt>{t('practice.stageLabel')}</dt><dd>{formatDealStage(project.stage, lang)}</dd></div><div><dt>{t('practice.budgetLabel')}</dt><dd>{project.budgetAmount === undefined ? t('proposal.valueUnconfirmed') : `${formatBudgetAmount(project.budgetAmount, lang)}${t('closure.budgetRefSuffix')}`}</dd></div><div><dt>{t('practice.nextActionLabel')}</dt><dd>{project.nextAction || t('practice.noNextAction')}</dd></div></dl>
    </> : <><h3>{t('practice.revertedTitle')}</h3><p>{t('practice.revertedDesc')}</p></>}
  </section>;
}
