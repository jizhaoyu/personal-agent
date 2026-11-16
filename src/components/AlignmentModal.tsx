import React, { useRef, useState } from 'react';
import { X, Copy, Download, ShieldCheck } from 'lucide-react';
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
  const preview = useRef<HTMLDivElement>(null);
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
        unselectedTaskCount: Math.max(0, tasks.filter(t => t.engagementId === engagement.id).length - selected.length),
        budgetWithheld: !includeBudget,
      };
  function selection(ids: string[], budget: boolean) {
    setSelected(ids); setIncludeBudget(budget); setReviewed(false);
    const fresh = createAlignmentDraft(engagement, tasks, ids, budget, lang);
    setDraft(d => ({ ...d, actions: fresh.actions, budgetAmount: fresh.budgetAmount }));
  }
  const formattedNotes = alignmentText(draft, lang);
  async function exportPng() {
    if (!reviewed || !preview.current) return;
    setBusy(true);
    try {
      const { default: html2canvas } = await import('html2canvas');
      const canvas = await html2canvas(preview.current, { scale: 2, backgroundColor: '#fffefa' });
      const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = `${t('alignment.downloadPrefix')}-${engagement.clientName.replace(/[\\/:*?"<>|]/g, '').slice(0, 30)}.png`; a.click(); onNotice(t('alignment.exportedNotice'));
    } catch { onNotice(t('alignment.exportFailedNotice')); }
    finally { setBusy(false); }
  }
  return <div className="modal-shade"><section className="alignment-sheet" role="dialog" aria-modal="true" aria-labelledby="alignment-title">
    <header className="sheet-header"><div><span className="eyebrow">{t('alignment.eyebrow')}</span><h2 id="alignment-title">{t('alignment.title')}</h2></div><button className="icon-btn" onClick={onClose} aria-label={t('alignment.closeAria')}><X size={20}/></button></header>
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
      {tasks.filter(t => t.engagementId === engagement.id).map(item => <label className="check-label" key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={e => selection(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id), includeBudget)}/>{item.title}</label>)}
      <div ref={preview} className="alignment-paper"><div className="paper-brand">LOOMA <span>{t('alignment.paperBrandSub')}</span></div><div className="paper-rule"/><pre>{formattedNotes}</pre><div className="paper-footer">{t('alignment.paperFooter')}</div></div>
      <label className="check-label review-accept"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)}/>{t('alignment.reviewedLabel')}</label>
      <textarea className="copy-fallback" aria-label={t('alignment.manualCopyAria')} readOnly value={formattedNotes} rows={3}/>
    </div>
    <footer className="sheet-footer"><button className="soft-btn" disabled={!reviewed} onClick={async () => { try { await navigator.clipboard.writeText(formattedNotes); onNotice(t('alignment.copiedNotice')); } catch { onNotice(t('alignment.copyFailedNotice')); } }}><Copy size={14}/>{t('alignment.copyBtn')}</button><button className="primary-btn" disabled={!reviewed || busy} onClick={exportPng}><Download size={14}/>{busy ? t('alignment.exportingPngBtn') : t('alignment.exportPngBtn')}</button></footer>
  </section></div>;
}
