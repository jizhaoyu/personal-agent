import React, { useEffect, useRef, useState } from 'react';
import { X, Copy, Download } from 'lucide-react';
import { buildTrialReport } from '../services/trialInfo';
import type { TrialBuildInfo, TrialContext, TrialFeedbackDetails } from '../services/trialInfo';
import './trial-info.css';

export interface TrialInfoModalProps {
  isOpen: boolean;
  onClose(): void;
  context: TrialContext;
  buildInfo: TrialBuildInfo;
}

export function TrialInfoModal({ isOpen, onClose, context, buildInfo }: TrialInfoModalProps) {
  const [details, setDetails] = useState<TrialFeedbackDetails>({ expected: '', actual: '', repeatability: 'unknown' });
  const [reviewed, setReviewed] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [openedAt, setOpenedAt] = useState(Date.now());
  const preview = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (isOpen) { setOpenedAt(Date.now()); setReviewed(false); setFeedback(''); } }, [isOpen]);
  useEffect(() => { setReviewed(false); }, [context.mode, context.phase, context.hasError, buildInfo.buildId]);
  if (!isOpen) return null;
  const report = buildTrialReport({ buildInfo, context, details }, openedAt);
  function edit(patch: TrialFeedbackDetails) { setDetails(value => ({ ...value, ...patch })); setReviewed(false); setFeedback(''); }
  async function copy() {
    if (!reviewed) return;
    try { await navigator.clipboard.writeText(report); setFeedback('问题记录已复制，请由你决定是否分享。'); }
    catch { preview.current?.focus(); preview.current?.select(); setFeedback('系统未允许复制，已选中预览文字，可以手动复制。'); }
  }
  function download() {
    if (!reviewed) return;
    const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `Looma-试用问题记录-${new Date(openedAt).toISOString().slice(0, 10)}.txt`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFeedback('问题记录已下载，由你审阅后自行分享。');
  }
  return <div className="modal-shade"><section className="trial-info-sheet" role="dialog" aria-modal="true" aria-labelledby="trial-info-title">
    <header className="sheet-header"><div><span className="eyebrow">LOOMA · 试用记录</span><h2 id="trial-info-title">版本与问题记录</h2></div><button autoFocus className="icon-btn" aria-label="关闭问题记录" onClick={onClose}><X size={20}/></button></header>
    <div className="sheet-body">
      <div className="trial-build-summary"><strong>{buildInfo.productVersion}</strong><span>构建 {buildInfo.buildId}</span></div>
      <p className="muted small">无需配置模型即可使用本地基础流程。这里用于记下试用中遇到的问题，不会自动发送或收集客户资料。</p>
      <p className="notice small">请描述操作步骤，不要填写客户姓名、聊天原文、内部备注、API Key 或接口地址。下面的预览就是即将复制或下载的完整内容。</p>
      <div className="trial-feedback-fields"><label>预期发生什么（可留空）<textarea aria-label="试用问题预期" rows={2} maxLength={2000} value={details.expected || ''} onChange={event => edit({ expected: event.target.value })} placeholder="例如：希望回到刚才未完成的整理。"/></label><label>实际发生什么（可留空）<textarea aria-label="试用问题实际" rows={3} maxLength={2000} value={details.actual || ''} onChange={event => edit({ actual: event.target.value })} placeholder="只描述界面和操作，不粘贴客户内容。"/></label><label>是否可以重复<select aria-label="试用问题是否可重复" value={details.repeatability} onChange={event => edit({ repeatability: event.target.value as TrialFeedbackDetails['repeatability'] })}><option value="unknown">还不确定</option><option value="yes">按相同步骤可以重复</option><option value="no">暂未重复出现</option></select></label></div>
      <label className="trial-report-preview">问题记录预览<textarea ref={preview} aria-label="试用问题记录预览" readOnly rows={13} value={report}/></label>
      <label className="check-label"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/>我已核对完整预览，主动填写的内容也已脱敏</label>
      {feedback && <p className="notice" role="status">{feedback}</p>}
    </div>
    <footer className="sheet-footer"><button className="soft-btn" disabled={!reviewed} onClick={() => void copy()}><Copy size={14}/>复制问题记录</button><button className="primary-btn" disabled={!reviewed} onClick={download}><Download size={14}/>下载文本</button></footer>
  </section></div>;
}
