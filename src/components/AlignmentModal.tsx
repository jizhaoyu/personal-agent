import React, { useRef, useState } from 'react';
import { X, Copy, Download, ShieldCheck } from 'lucide-react';
import type { Engagement, ProjectTaskItem } from '../types';
import { createAlignmentDraft, alignmentText, inspectAlignmentBoundary } from '../services/aiService';

export function AlignmentModal({ engagement, tasks, onClose, onNotice }: { engagement: Engagement; tasks: ProjectTaskItem[]; onClose(): void; onNotice(message: string): void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [includeBudget, setIncludeBudget] = useState(false);
  const [draft, setDraft] = useState(() => createAlignmentDraft(engagement, tasks, []));
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const preview = useRef<HTMLDivElement>(null);
  const boundary = typeof inspectAlignmentBoundary === 'function'
    ? inspectAlignmentBoundary(engagement, tasks, selected, includeBudget)
    : {
        allowedFields: [`客户与项目名称（${engagement.clientName} · ${engagement.title}）`, '外发摘要（经发送者编辑审阅）'],
        withheldFields: ['内部备注（默认隔离不外发）', '原始沟通全文与生活空间资料（零外发）'],
        internalNotesWithheld: Boolean((engagement.internalContext || '').trim()),
        internalNotesChars: (engagement.internalContext || '').trim().length,
        unselectedTaskCount: Math.max(0, tasks.filter(t => t.engagementId === engagement.id).length - selected.length),
        budgetWithheld: !includeBudget,
      };
  function selection(ids: string[], budget: boolean) {
    setSelected(ids); setIncludeBudget(budget); setReviewed(false);
    const fresh = createAlignmentDraft(engagement, tasks, ids, budget);
    setDraft(d => ({ ...d, actions: fresh.actions, budgetAmount: fresh.budgetAmount }));
  }
  async function exportPng() {
    if (!reviewed || !preview.current) return;
    setBusy(true);
    try {
      const { default: html2canvas } = await import('html2canvas');
      const canvas = await html2canvas(preview.current, { scale: 2, backgroundColor: '#fffefa' });
      const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = `Looma-待确认纪要-${engagement.clientName.replace(/[\\/:*?"<>|]/g, '').slice(0, 30)}.png`; a.click(); onNotice('已导出纪要草稿，请由你审阅后自行发送。');
    } catch { onNotice('图片导出失败，可先复制纪要文本。'); }
    finally { setBusy(false); }
  }
  return <div className="modal-shade"><section className="alignment-sheet" role="dialog" aria-modal="true" aria-labelledby="alignment-title">
    <header className="sheet-header"><div><span className="eyebrow">REVIEW BEFORE SHARING</span><h2 id="alignment-title">准备沟通纪要</h2></div><button className="icon-btn" onClick={onClose} aria-label="关闭纪要"><X size={20}/></button></header>
    <div className="sheet-body">
      <p className="muted small">只包含此项目的外发字段。内部备注与聊天原文不会自动进入纪要；不代表对方已确认。</p>
      <section className="boundary-proof-card" aria-label="数据控制与外发边界核验">
        <div className="boundary-proof-header"><ShieldCheck size={15}/><strong>数据控制与外发边界核验</strong></div>
        <div className="boundary-proof-columns">
          <div><span className="eyebrow">允许进入纪要</span><ul>{boundary.allowedFields.map((item, idx) => <li key={idx}>{item}</li>)}</ul></div>
          <div><span className="eyebrow">已自动拦截隔离</span><ul>{boundary.withheldFields.map((item, idx) => <li key={idx}>{item}</li>)}</ul></div>
        </div>
      </section>
      <label>外发摘要<textarea aria-label="纪要外发摘要" rows={3} value={draft.summary} onChange={e => { setDraft(d => ({ ...d, summary: e.target.value })); setReviewed(false); }}/></label>
      <label className="check-label"><input type="checkbox" checked={includeBudget} disabled={engagement.budgetAmount === undefined} onChange={e => selection(selected, e.target.checked)}/>包含预算参考{engagement.budgetAmount !== undefined ? ` ¥${engagement.budgetAmount.toLocaleString('zh-CN')}` : '（尚未记录）'}</label>
      <h3>选择待核对行动</h3>
      {tasks.filter(t => t.engagementId === engagement.id).map(t => <label className="check-label" key={t.id}><input type="checkbox" checked={selected.includes(t.id)} onChange={e => selection(e.target.checked ? [...selected, t.id] : selected.filter(id => id !== t.id), includeBudget)}/>{t.title}</label>)}
      <div ref={preview} className="alignment-paper"><div className="paper-brand">LOOMA <span>COMMUNICATION NOTES</span></div><div className="paper-rule"/><pre>{alignmentText(draft)}</pre><div className="paper-footer">DRAFT · 待对方确认</div></div>
      <label className="check-label review-accept"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)}/>我已核对预览内容，确认可以对外分享</label>
      <textarea className="copy-fallback" aria-label="可手动复制的纪要全文" readOnly value={alignmentText(draft)} rows={3}/>
    </div>
    <footer className="sheet-footer"><button className="soft-btn" disabled={!reviewed} onClick={async () => { try { await navigator.clipboard.writeText(alignmentText(draft)); onNotice('纪要文本已复制。'); } catch { onNotice('系统未允许复制，请从纪要全文框手动选择复制。'); } }}><Copy size={14}/>复制文本</button><button className="primary-btn" disabled={!reviewed || busy} onClick={exportPng}><Download size={14}/>{busy ? '生成中…' : '导出 PNG'}</button></footer>
  </section></div>;
}
