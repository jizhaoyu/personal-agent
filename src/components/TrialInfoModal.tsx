import React, { useEffect, useRef, useState } from 'react';
import { X, Copy, Download } from 'lucide-react';
import { buildTrialReport } from '../services/trialInfo';
import type { TrialBuildInfo, TrialContext, TrialFeedbackDetails } from '../services/trialInfo';
import { useI18n } from '../i18n';
import './trial-info.css';

export interface TrialInfoModalProps {
  isOpen: boolean;
  onClose(): void;
  context: TrialContext;
  buildInfo: TrialBuildInfo;
}

export function TrialInfoModal({ isOpen, onClose, context, buildInfo }: TrialInfoModalProps) {
  const { lang, t } = useI18n();
  const [details, setDetails] = useState<TrialFeedbackDetails>({ expected: '', actual: '', repeatability: 'unknown' });
  const [reviewed, setReviewed] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [openedAt, setOpenedAt] = useState(Date.now());
  const preview = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (isOpen) { setOpenedAt(Date.now()); setReviewed(false); setFeedback(''); } }, [isOpen]);
  useEffect(() => { setReviewed(false); }, [context.mode, context.phase, context.hasError, buildInfo.buildId]);
  if (!isOpen) return null;
  const report = buildTrialReport({ buildInfo, context, details }, openedAt, lang);
  function edit(patch: TrialFeedbackDetails) { setDetails(value => ({ ...value, ...patch })); setReviewed(false); setFeedback(''); }
  async function copy() {
    if (!reviewed) return;
    try { await navigator.clipboard.writeText(report); setFeedback(t('trial.copiedNotice')); }
    catch { preview.current?.focus(); preview.current?.select(); setFeedback(t('trial.copyFailedNotice')); }
  }
  function download() {
    if (!reviewed) return;
    const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `${t('trial.downloadPrefix')}-${new Date(openedAt).toISOString().slice(0, 10)}.txt`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFeedback(t('trial.downloadedNotice'));
  }
  return <div className="modal-shade"><section className="trial-info-sheet" role="dialog" aria-modal="true" aria-labelledby="trial-info-title">
    <header className="sheet-header"><div><span className="eyebrow">{t('trial.eyebrow')}</span><h2 id="trial-info-title">{t('trial.title')}</h2></div><button autoFocus className="icon-btn" aria-label={t('trial.closeAria')} onClick={onClose}><X size={20}/></button></header>
    <div className="sheet-body">
      <div className="trial-build-summary"><strong>{buildInfo.productVersion}</strong><span>{t('trial.buildPrefix')} {buildInfo.buildId}</span></div>
      <p className="muted small">{t('trial.intro')}</p>
      <p className="notice small">{t('trial.privacyNotice')}</p>
      <div className="trial-feedback-fields"><label>{t('trial.expectedLabel')}<textarea aria-label={t('trial.expectedAria')} rows={2} maxLength={2000} value={details.expected || ''} onChange={event => edit({ expected: event.target.value })} placeholder={t('trial.expectedPlaceholder')}/></label><label>{t('trial.actualLabel')}<textarea aria-label={t('trial.actualAria')} rows={3} maxLength={2000} value={details.actual || ''} onChange={event => edit({ actual: event.target.value })} placeholder={t('trial.actualPlaceholder')}/></label><label>{t('trial.repeatabilityLabel')}<select aria-label={t('trial.repeatabilityAria')} value={details.repeatability} onChange={event => edit({ repeatability: event.target.value as TrialFeedbackDetails['repeatability'] })}><option value="unknown">{t('trial.repeatUnknown')}</option><option value="yes">{t('trial.repeatYes')}</option><option value="no">{t('trial.repeatNo')}</option></select></label></div>
      <label className="trial-report-preview">{t('trial.previewLabel')}<textarea ref={preview} aria-label={t('trial.previewAria')} readOnly rows={13} value={report}/></label>
      <label className="check-label"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/>{t('trial.reviewedLabel')}</label>
      {feedback && <p className="notice" role="status">{feedback}</p>}
    </div>
    <footer className="sheet-footer"><button className="soft-btn" disabled={!reviewed} onClick={() => void copy()}><Copy size={14}/>{t('trial.copyBtn')}</button><button className="primary-btn" disabled={!reviewed} onClick={download}><Download size={14}/>{t('trial.downloadBtn')}</button></footer>
  </section></div>;
}
