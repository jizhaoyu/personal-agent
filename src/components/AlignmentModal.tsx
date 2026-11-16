import React, { useEffect, useRef, useState } from 'react';
import { X, Copy, Download, Share2, ShieldCheck } from 'lucide-react';
import type { Engagement, ProjectTaskItem } from '../types';
import { createAlignmentDraft, alignmentText, inspectAlignmentBoundary } from '../services/aiService';
import { formatBudgetAmount, useI18n } from '../i18n';

export function AlignmentModal({ engagement, tasks, onClose, onNotice }: { engagement: Engagement; tasks: ProjectTaskItem[]; onClose(): void; onNotice(message: string): void }) {
  const { lang, t } = useI18n();
  const [selected, setSelected] = useState<string[]>([]);
  const [includeBudget, setIncludeBudget] = useState(false);
  const [draft, setDraft] = useState(() => createAlignmentDraft(engagement, tasks, [], false, lang));
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showCopyFallback, setShowCopyFallback] = useState(false);
  const preview = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const copyFallbackRef = useRef<HTMLTextAreaElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    headingRef.current?.focus();
    if (typeof window === 'undefined') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const projectTasks = tasks.filter(item => item.engagementId === engagement.id);
  const pendingTasks = projectTasks.filter(item => !item.done);
  const completedTasks = projectTasks.filter(item => item.done);

  const boundary = typeof inspectAlignmentBoundary === 'function'
    ? inspectAlignmentBoundary(engagement, tasks, selected, includeBudget, lang)
    : {
        allowedFields: lang === 'en'
          ? [`Client & project (${engagement.clientName} · ${engagement.title})`, 'Shareable summary (edited & reviewed by sender)']
          : [`客户与项目名称（${engagement.clientName} · ${engagement.title}）`, '外发摘要（经发送者编辑审阅）'],
        withheldFields: lang === 'en'
          ? ['Internal notes (isolated by default)', 'Raw transcripts & Life space data (never shared)']
          : ['内部备注（默认隔离不外发）', '原始沟通全文与生活空间资料（零外发）'],
        internalNotesWithheld: Boolean((engagement.internalContext || '').trim()),
        internalNotesChars: (engagement.internalContext || '').trim().length,
        unselectedTaskCount: Math.max(0, projectTasks.length - selected.length),
        budgetWithheld: !includeBudget,
      };
  function selection(ids: string[], budget: boolean) {
    setSelected(ids); setIncludeBudget(budget); setReviewed(false);
    const fresh = createAlignmentDraft(engagement, tasks, ids, budget, lang);
    setDraft(d => ({ ...d, actions: fresh.actions, budgetAmount: fresh.budgetAmount }));
  }
  const formattedNotes = alignmentText(draft, lang);
  const safeClient = engagement.clientName.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 30) || t('cards.defaultClientLabel');
  const exportFileName = `${t('alignment.downloadPrefix')}-${safeClient}.png`;
  const hasShareImage = typeof window !== 'undefined' && typeof window.electronAPI?.shareImage === 'function';

  async function renderPngDataUrl(): Promise<string> {
    if (!preview.current) throw new Error('Preview unavailable');
    const { default: html2canvas } = await import('html2canvas');
    const canvas = await html2canvas(preview.current, { scale: 2, backgroundColor: '#fffefa' });
    return canvas.toDataURL('image/png');
  }

  async function copyNotes() {
    if (!reviewed) return;
    try {
      await navigator.clipboard.writeText(formattedNotes);
      onNotice(t('alignment.copiedNotice'));
    } catch {
      setShowCopyFallback(true);
      if (typeof document !== 'undefined') {
        setTimeout(() => {
          copyFallbackRef.current?.focus();
          copyFallbackRef.current?.select();
        }, 0);
      } else {
        copyFallbackRef.current?.focus();
        copyFallbackRef.current?.select();
      }
      onNotice(t('alignment.copyFailedNotice'));
    }
  }

  async function exportPng() {
    if (!reviewed || !preview.current || busy) return;
    setBusy(true);
    try {
      const dataUrl = await renderPngDataUrl();
      const saveBinary = typeof window !== 'undefined' ? window.electronAPI?.saveBinaryFile : undefined;
      if (saveBinary) {
        const result = await saveBinary(exportFileName, 'image/png', dataUrl, true);
        if (result?.canceled) return;
        onNotice(t('alignment.exportedNotice'));
        return;
      }
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = exportFileName;
      a.click();
      onNotice(t('alignment.exportedNotice'));
    } catch {
      onNotice(t('alignment.exportFailedNotice'));
    } finally {
      setBusy(false);
    }
  }

  async function sharePng() {
    if (!reviewed || !preview.current || busy || !hasShareImage) return;
    setBusy(true);
    try {
      const dataUrl = await renderPngDataUrl();
      const result = await window.electronAPI!.shareImage!(dataUrl, exportFileName, engagement.title || safeClient);
      if (result?.shared) {
        onNotice(t('alignment.sharedNotice'));
      } else {
        onNotice(t('alignment.shareCanceledNotice'));
      }
    } catch {
      onNotice(t('alignment.exportFailedNotice'));
    } finally {
      setBusy(false);
    }
  }

  function renderTaskCheckbox(item: ProjectTaskItem) {
    const checked = selected.includes(item.id);
    return (
      <label className="check-label" key={item.id}>
        <input
          type="checkbox"
          checked={checked}
          onChange={e => selection(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id), includeBudget)}
        />
        {item.title}
      </label>
    );
  }

  return <div className="modal-shade" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="alignment-sheet sheet-shell" role="dialog" aria-modal="true" aria-labelledby="alignment-title">
      <header className="sheet-header">
        <div>
          <span className="eyebrow">{t('alignment.eyebrow')}</span>
          <h2 id="alignment-title" tabIndex={-1} ref={headingRef}>{t('alignment.title')}</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('alignment.closeAria')}><X size={20}/></button>
      </header>
      <div className="sheet-body">
        <p className="muted small">{t('alignment.intro')}</p>
        <section className="boundary-proof-card" aria-label={t('alignment.boundaryAria')}>
          <div className="boundary-proof-header"><ShieldCheck size={15}/><strong>{t('alignment.boundaryTitle')}</strong></div>
          <div className="boundary-proof-columns">
            <div><span className="eyebrow">{t('alignment.allowedHeading')}</span><ul>{boundary.allowedFields.map((item, idx) => <li key={idx}>{item}</li>)}</ul></div>
            <div><span className="eyebrow">{t('alignment.withheldHeading')}</span><ul>{boundary.withheldFields.map((item, idx) => <li key={idx}>{item}</li>)}</ul></div>
          </div>
        </section>
        <label>{t('alignment.summaryLabel')}<textarea aria-label={t('alignment.summaryAria')} rows={3} value={draft.summary} onChange={e => { setDraft(d => ({ ...d, summary: e.target.value })); setReviewed(false); }}/></label>
        <label className="check-label"><input type="checkbox" checked={includeBudget} disabled={engagement.budgetAmount === undefined} onChange={e => selection(selected, e.target.checked)}/>{t('alignment.includeBudgetPrefix')}{engagement.budgetAmount !== undefined ? ` ${formatBudgetAmount(engagement.budgetAmount, lang)}` : t('alignment.budgetMissing')}</label>
        <h3>{t('alignment.selectActionsHeading')}</h3>
        {pendingTasks.map(renderTaskCheckbox)}
        {completedTasks.length > 0 && (
          <details>
            <summary>{t('alignment.showCompletedTasksSummary', { count: completedTasks.length })}</summary>
            {completedTasks.map(renderTaskCheckbox)}
          </details>
        )}
        <div ref={preview} className="alignment-paper"><div className="paper-brand">LOOMA <span>{t('alignment.paperBrandSub')}</span></div><div className="paper-rule"/><pre>{formattedNotes}</pre><div className="paper-footer">{t('alignment.paperFooter')}</div></div>
        <label className="check-label review-accept"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)}/>{t('alignment.reviewedLabel')}</label>
        <details open={showCopyFallback} onToggle={e => setShowCopyFallback((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>{t('alignment.manualCopySummary')}</summary>
          <textarea ref={copyFallbackRef} className="copy-fallback" aria-label={t('alignment.manualCopyAria')} readOnly value={formattedNotes} rows={3}/>
        </details>
      </div>
      <footer className="sheet-footer">
        <button type="button" className="soft-btn" disabled={!reviewed} onClick={() => void copyNotes()}><Copy size={14}/>{t('alignment.copyBtn')}</button>
        {hasShareImage && <button type="button" className="soft-btn" disabled={!reviewed || busy} onClick={() => void sharePng()}><Share2 size={14}/>{t('alignment.shareImageBtn')}</button>}
        <button type="button" className="primary-btn" disabled={!reviewed || busy} onClick={() => void exportPng()}><Download size={14}/>{busy ? t('alignment.exportingPngBtn') : t('alignment.exportPngBtn')}</button>
      </footer>
    </section>
  </div>;
}
