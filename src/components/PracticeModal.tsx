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
import { ClosureReceipt } from './ClosureReceipt';
import { ProposalReview } from './ProposalReview';
import './practice.css';

export interface PracticeModalProps {
  onClose(): void;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '演练操作没有完成，请保留当前内容后重试。';
}

export function PracticeModal({ onClose }: PracticeModalProps) {
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
      setError(errorText(cause));
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
      setError(errorText(cause));
    }
  }

  const followUps = practice.partition.followUps || [];
  const selectedProject = projectId ? practice.partition.engagements.find(project => project.id === projectId) : null;

  return <div className="practice-backdrop" role="presentation">
    <section className="practice-sheet" role="dialog" aria-modal="true" aria-labelledby="practice-title">
      <header className="practice-header">
        <div className="practice-title"><span className="practice-icon"><FlaskConical size={19}/></span><div><span className="eyebrow">独立演练</span><h2 id="practice-title">放心练习一次</h2></div></div>
        <button type="button" autoFocus className="practice-close" aria-label="关闭演练" onClick={onClose}><X size={20}/></button>
      </header>

      <p className="practice-boundary" role="note"><strong>演练资料，仅在当前窗口临时保留，关闭后丢弃。</strong><span>不会清空或改动真实工作区，也不会调用模型、通知或外发能力。</span></p>
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
        <button type="button" className="soft-btn practice-restart" onClick={restart}><RefreshCcw size={14}/>重新练习</button>
      </div>}

      {!projectId && !practice.closure && practice.draft.proposal && <ProposalReview
        proposal={practice.draft.proposal}
        engagements={practice.partition.engagements}
        onChange={editProposal}
        onConfirm={commit}
        onDiscard={() => revise(practice.draft.text)}
        onReparse={review}
      />}

      {!projectId && !practice.closure && !practice.draft.proposal && <section className="practice-capture" aria-label="演练输入">
        <div className="practice-step"><span>1</span><div><h3>先改一改这段示例沟通</h3><p>这是合成资料。你可以随意修改，看看 Looma 如何分开我方行动、等待客户和未定问题。</p></div></div>
        <label htmlFor="practice-source">演练沟通原文</label>
        <textarea id="practice-source" aria-label="演练沟通原文" rows={6} value={practice.draft.text} onChange={event => revise(event.target.value)}/>
        <div className="practice-capture-actions"><small>此时尚未产生任何真实项目记录。</small><button type="button" className="primary-btn" onClick={review}>整理并核对</button></div>
      </section>}
    </section>
  </div>;
}

function PracticeProject({ project, onBack }: { project?: Engagement | null; onBack(): void }) {
  return <section className="practice-project" aria-label="演练项目">
    <button type="button" className="text-btn" onClick={onBack}><ArrowLeft size={14}/>返回演练回执</button>
    <span className="eyebrow">演练项目 · 临时资料</span>
    {project ? <>
      <h3>{project.clientName} · {project.title}</h3>
      <dl><div><dt>当前进展</dt><dd>{project.stage}</dd></div><div><dt>参考预算</dt><dd>{project.budgetAmount === undefined ? '尚未确认' : `¥${project.budgetAmount.toLocaleString('zh-CN')} 元`}</dd></div><div><dt>下一步</dt><dd>{project.nextAction || '尚未安排'}</dd></div></dl>
    </> : <><h3>这项演练变更已撤销</h3><p>演练项目已经恢复到练习前的状态，原文仍可在回执中查看。</p></>}
  </section>;
}
