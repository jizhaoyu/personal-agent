import React, { useEffect, useState } from 'react';
import { X, Download, Upload, KeyRound, RotateCcw, ArrowUpRight } from 'lucide-react';
import type { AppLanguage, AppSettings } from '../types';
import type { UpdateCheckResult } from '../services/appUpdate';
import { Repository } from '../persistence/repository';
import { clearLegacyCredential } from '../services/legacyConnection';
import { TodoService } from '../services/todos';
import { setLanguage, translate, useI18n } from '../i18n';

interface Props {
  settings: AppSettings;
  isOpen: boolean;
  onClose(): void;
  onSaveSettings(settings: AppSettings): Promise<void>;
  onDataImported(): void | Promise<void>;
  onConnectionChange?(status: ModelConnectionStatus): void;
  buildInfo?: { productVersion: string; buildId: string; builtAt: string; channel: string; androidVersionCode?: number };
  updateCheck?: { checking: boolean; result: UpdateCheckResult | null };
  onCheckForUpdates?(): void | Promise<void>;
  onOpenUpdateUrl?(url: string): Promise<boolean> | boolean | void;
}
export function SettingsModal({ settings, isOpen, onClose, onSaveSettings, onDataImported, onConnectionChange, buildInfo, updateCheck, onCheckForUpdates, onOpenUpdateUrl }: Props) {
  const { lang, t } = useI18n();
  const [form, setForm] = useState<AppSettings>({ ...settings, language: settings.language || lang });
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<ModelConnectionStatus | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [importText, setImportText] = useState('');
  const [replaceAccepted, setReplaceAccepted] = useState(false);
  const [reminderCapability, setReminderCapability] = useState<{ background: boolean; notifications: string; exactAlarms: string; enabled: boolean } | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    setForm({ ...settings, language: settings.language || lang }); setKey(''); setFeedback(''); setImportText(''); setReplaceAccepted(false);
    setReminderCapability(null);
    let active = true;
    const refreshCapability = () => { void TodoService.capabilities().then(value => { if (active) setReminderCapability(value); }).catch(() => { if (active) setFeedback(t('settings.capabilityReadError')); }); };
    refreshCapability();
    window.addEventListener?.('looma:todo-capabilities', refreshCapability);
    window.electronAPI?.modelStatus().then(s => { setStatus(s); setForm(f => ({ ...f, apiBaseUrl: s.apiBaseUrl || f.apiBaseUrl, modelName: s.modelName || f.modelName, modelEnabled: s.enabled })); }).catch(() => setFeedback(t('app.desktopModelUnavailable')));
    return () => { active = false; window.removeEventListener?.('looma:todo-capabilities', refreshCapability); };
  }, [isOpen]);
  if (!isOpen) return null;
  const activeLang: AppLanguage = form.language || lang || 'zh-CN';
  async function switchLanguage(nextLang: AppLanguage) {
    if (activeLang === nextLang && settings.language === nextLang) return;
    const nextForm: AppSettings = { ...form, language: nextLang };
    setForm(nextForm);
    setLanguage(nextLang);
    try {
      await onSaveSettings(nextForm);
      setFeedback(translate(nextLang, nextLang === 'en' ? 'app.languageSavedEn' : 'app.languageSavedZh'));
    } catch (error) {
      setFeedback(`${error instanceof Error ? error.message : ''} ${translate(nextLang, 'app.languagePersistFailed')}`.trim());
    }
  }
  async function save() {
    setBusy(true); setFeedback('');
    const nextLang: AppLanguage = form.language || 'zh-CN';
    try {
      if (window.electronAPI) {
        const s = await window.electronAPI.saveModelConnection({ apiBaseUrl: form.apiBaseUrl, modelName: form.modelName, enabled: !!form.modelEnabled, ...(key ? { apiKey: key } : {}) });
        setStatus(s); setKey(''); onConnectionChange?.(s);
      }
      await onSaveSettings({ ...form, language: nextLang });
      setLanguage(nextLang);
      setReminderCapability(await TodoService.capabilities());
      await window.electronAPI?.setAlwaysOnTop(form.alwaysOnTop);
      if (window.electronAPI && !('LoomaAndroid' in window)) {
        await window.electronAPI.setContentProtection?.(!!form.contentProtection);
      }
      setFeedback(translate(nextLang, 'settings.savedNotice'));
    } catch (error) { setFeedback(`${error instanceof Error ? error.message : ''} ${t('settings.saveErrorSuffix')}`.trim()); }
    finally { setBusy(false); }
  }
  async function requestReminderPermissions() {
    try { setReminderCapability(await TodoService.requestPermissions()); setFeedback(t('settings.permissionsUpdated')); }
    catch { setFeedback(t('settings.permissionsFailed')); }
  }
  async function backup() {
    try {
      if (window.electronAPI?.exportDataBackup) {
        const result = await window.electronAPI.exportDataBackup(); if (result.canceled) return;
      } else {
        const payload = await Repository.exportAllData();
        const filename = `Looma-v5-${new Date().toISOString().slice(0, 10)}.json`;
        if (window.electronAPI?.saveBackupFile) {
          const result = await window.electronAPI.saveBackupFile(filename, payload);
          if (result?.canceled) return;
        } else {
          const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
          const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }
      setFeedback(t('settings.backupGeneratedNotice'));
    } catch { setFeedback(t('settings.backupFailedNotice')); }
  }
  async function importFile(file?: File) {
    if (!file) return;
    setImportText(await file.text()); setReplaceAccepted(false); setFeedback(t('settings.fileReadNotice'));
  }
  async function restore() {
    if (!replaceAccepted || busy) return;
    setBusy(true); let acknowledged = false;
    const savedButUnread = t('settings.restoreSavedUnread');
    try {
      if (window.electronAPI?.importDataBackup) {
        const result = await window.electronAPI.importDataBackup(); if (result.canceled) return;
        acknowledged = true; setReplaceAccepted(false);
        try { await Repository.reloadAfterRestore(); }
        catch { /* The native restore was acknowledged; a read failure cannot undo it. */ }
      } else {
        if (!importText) return;
        if (!await Repository.importAllData(importText)) { setFeedback(t('settings.restoreValidationFailed')); return; }
        acknowledged = true; setImportText(''); setReplaceAccepted(false);
        try {
          const restored = await Repository.getSettings();
          setForm({ ...restored, ...(status ? { apiBaseUrl: status.apiBaseUrl || restored.apiBaseUrl, modelName: status.modelName || restored.modelName, modelEnabled: status.enabled } : {}) });
        } catch { /* Continue informing the parent about the completed replacement. */ }
      }
      await onDataImported();
      setFeedback(Repository.getRestoreWarning() || t('settings.restoreSuccessFallback'));
    } catch {
      setFeedback(acknowledged ? Repository.getRestoreWarning() || savedButUnread : t('settings.restoreUncertain'));
    } finally { setBusy(false); }
  }
  async function openUpdateLink(url: string) {
    try {
      const opened = await onOpenUpdateUrl?.(url);
      if (opened === false) setFeedback(t('settings.updateOpenUrlFailed'));
    } catch {
      setFeedback(t('settings.updateOpenUrlFailed'));
    }
  }
  const updateResult = updateCheck?.result;
  const checkingUpdates = !!updateCheck?.checking;
  return <div className="modal-shade" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="sheet-header"><div><span className="eyebrow">{t('settings.eyebrow')}</span><h2 id="settings-title">{t('settings.title')}</h2></div><button className="icon-btn" onClick={onClose} aria-label={t('settings.closeAria')}><X size={20}/></button></header>
      <div className="sheet-body">
        <p className="muted small settings-intro">{t('settings.intro')}</p>
        <section className="settings-section">
          <h3>{t('settings.sectionAppearanceTitle')}</h3>
          <div className="settings-field">
            <span className="settings-field-label">{t('settings.languageLabel')}</span>
            <div className="settings-segmented" role="radiogroup" aria-label={t('settings.languageLabel')}>
              <button
                type="button"
                role="radio"
                aria-checked={activeLang === 'zh-CN'}
                className={activeLang === 'zh-CN' ? 'active' : ''}
                disabled={busy}
                onClick={() => void switchLanguage('zh-CN')}
              >
                {t('settings.languageZh')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={activeLang === 'en'}
                className={activeLang === 'en' ? 'active' : ''}
                disabled={busy}
                onClick={() => void switchLanguage('en')}
              >
                {t('settings.languageEn')}
              </button>
            </div>
            <p className="settings-hint">{t('settings.languageSwitchHint')}</p>
          </div>
          <label>{t('settings.personaNameLabel')}<input value={form.personaName} onChange={e => setForm(f => ({ ...f, personaName: e.target.value }))}/></label>
          <label className="check-label"><input type="checkbox" checked={form.alwaysOnTop} onChange={e => setForm(f => ({ ...f, alwaysOnTop: e.target.checked }))}/>{t('settings.alwaysOnTopLabel')}</label>
          {window.electronAPI && !('LoomaAndroid' in window) && (
            <label className="check-label"><input type="checkbox" checked={!!form.contentProtection} onChange={e => setForm(f => ({ ...f, contentProtection: e.target.checked }))}/>{t('settings.contentProtectionLabel')}</label>
          )}
        </section>
        <section className="settings-section">
          <h3>{t('settings.sectionRemindersTitle')}</h3>
          <label className="check-label"><input type="checkbox" checked={!!form.remindersEnabled} onChange={e => setForm(f => ({ ...f, remindersEnabled: e.target.checked }))}/>{t('settings.remindersEnabledLabel')}</label>
          <label className="check-label"><input type="checkbox" checked={form.workSuggestionsEnabled ?? true} onChange={e => setForm(f => ({ ...f, workSuggestionsEnabled: e.target.checked }))}/>{t('settings.workSuggestionsLabel')}</label>
          <p className="settings-hint">{t('settings.timezoneNote')}</p>
          {reminderCapability ? <div className="notice settings-capability-card"><p className="small">{reminderCapability.background ? t('settings.capabilityDesktop') : t('settings.capabilityBrowser')}</p><p className="small">{t('settings.notifPrefix')}{reminderCapability.notifications === 'granted' ? t('settings.notifGranted') : reminderCapability.notifications === 'unsupported' ? t('settings.notifUnsupported') : t('settings.notifDenied')} · {reminderCapability.enabled ? t('settings.schedulerEnabled') : t('settings.schedulerDisabled')}{!['granted', 'not-required', 'unsupported'].includes(reminderCapability.exactAlarms) ? ` · ${t('settings.exactAlarmMissing')}` : ''}</p>{reminderCapability.notifications !== 'granted' && reminderCapability.notifications !== 'unsupported' && <button className="soft-btn" disabled={busy} onClick={requestReminderPermissions}>{t('settings.requestNotifBtn')}</button>}{reminderCapability.background && !['granted', 'not-required', 'unsupported'].includes(reminderCapability.exactAlarms) && <button className="soft-btn" disabled={busy} onClick={requestReminderPermissions}>{t('settings.requestExactAlarmBtn')}</button>}</div> : <p className="settings-hint">{t('settings.readingCapabilities')}</p>}
        </section>
        <section className="settings-section">
          <details className="optional-model-settings" open={!!form.modelEnabled || !!form.memoryModelEnabled}><summary>{t('settings.optionalModelSummary')}</summary>
          <div className="section-heading"><KeyRound size={16}/><h3>{t('settings.modelTitle')}</h3><span className="tag">{window.electronAPI ? status?.configured ? t('settings.tagConfigured') : t('settings.tagUnconfigured') : t('settings.tagBrowserLocal')}</span></div>
          {window.electronAPI ? <>
            <p className="muted small">{t('settings.modelDesc')}</p>
            <div className="button-row"><button className="soft-btn" onClick={() => setForm(f => ({ ...f, apiBaseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-chat' }))}>{t('settings.presetDeepSeek')}</button><button className="soft-btn" onClick={() => setForm(f => ({ ...f, apiBaseUrl: 'http://localhost:11434/v1', modelName: 'llama3.2' }))}>{t('settings.presetOllama')}</button></div>
            <label>{t('settings.apiBaseUrlLabel')}<input value={form.apiBaseUrl} onChange={e => setForm(f => ({ ...f, apiBaseUrl: e.target.value }))} placeholder={t('settings.apiBaseUrlPlaceholder')}/></label>
            <label>{t('settings.modelNameLabel')}<input value={form.modelName} onChange={e => setForm(f => ({ ...f, modelName: e.target.value }))}/></label>
            <label>{t('settings.apiKeyLabel')}<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={status?.configured ? t('settings.apiKeyPlaceholderConfigured') : t('settings.apiKeyPlaceholderUnconfigured')}/></label>
            <label className="check-label"><input type="checkbox" checked={!!form.modelEnabled} onChange={e => setForm(f => ({ ...f, modelEnabled: e.target.checked }))}/>{t('settings.enableModelLabel')}</label>
            <label className="check-label"><input type="checkbox" checked={!!form.memoryModelEnabled} onChange={e => setForm(f => ({ ...f, memoryModelEnabled: e.target.checked }))}/>{t('settings.enableMemoryModelLabel')}</label>
            <p className="settings-hint">{t('settings.memoryModelDesc')}</p>
            {status?.configured && !status.persistent && <p className="notice">{t('settings.sessionOnlyNotice')}</p>}
            <button className="text-btn danger" onClick={async () => { try { await window.electronAPI!.clearModelConnection(); const clean = clearLegacyCredential(localStorage); const s = await window.electronAPI!.modelStatus(); setStatus(s); onConnectionChange?.(s); setForm(f => ({ ...f, modelEnabled: false })); setFeedback(clean ? t('settings.clearModelSuccess') : t('settings.clearModelLegacyWarn')); } catch { setFeedback(t('settings.clearModelFailed')); } }}>{t('settings.clearModelBtn')}</button>
          </> : <p className="settings-hint">{t('settings.browserPreviewNotice')}</p>}
          </details>
        </section>
        {(buildInfo || onCheckForUpdates) && <section className="settings-section">
          <div className="settings-update-head">
            <h3>{t('settings.sectionUpdatesTitle')}</h3>
            {onCheckForUpdates && <button type="button" className="soft-btn" disabled={busy || checkingUpdates} onClick={() => void onCheckForUpdates()}><RotateCcw size={14}/>{checkingUpdates ? t('settings.checkingUpdateBtn') : t('settings.checkUpdateBtn')}</button>}
          </div>
          {buildInfo && <p className="settings-update-meta">{t('settings.updateCurrentVersionPrefix')}{buildInfo.productVersion}{typeof buildInfo.androidVersionCode === 'number' && buildInfo.androidVersionCode > 0 ? `${t('settings.updateAndroidCodePrefix')}${buildInfo.androidVersionCode}` : ''}</p>}
          <p className="settings-hint">{t('settings.updateManualDesc')}</p>
          {updateResult?.outcome === 'up-to-date' && <div className="settings-update-card"><p className="settings-update-title">{t('settings.updateUpToDate', { version: updateResult.latestVersion || buildInfo?.productVersion || updateResult.currentVersion })}</p></div>}
          {updateResult?.outcome === 'update-available' && <div className="settings-update-card settings-update-card--available">
            <p className="settings-update-title">{t('settings.updateAvailableTitle', { version: updateResult.latestVersion || '' })}{typeof updateResult.latestVersionCode === 'number' ? ` (versionCode ${updateResult.latestVersionCode})` : ''}</p>
            {updateResult.notesSummary && <p className="settings-update-notes">{updateResult.notesSummary}</p>}
            {updateResult.expectedSha256 && <p className="settings-update-sha">{t('settings.updateShaPrefix')}{updateResult.expectedSha256}</p>}
            <p className="settings-update-warn">{updateResult.platform === 'android' ? t('settings.updateAvailableAndroidHint') : t('settings.updateAvailableDesktopHint')}</p>
            <div className="button-row">
              <button type="button" className="soft-btn" onClick={() => void backup()}><Download size={14}/>{t('settings.updateBackupFirstBtn')}</button>
              {updateResult.downloadUrl && <button type="button" className="primary-btn" onClick={() => void openUpdateLink(updateResult.downloadUrl!)}><ArrowUpRight size={14}/>{updateResult.assetName ? t('settings.updateDownloadBtn', { asset: updateResult.assetName }) : t('settings.updateOpenReleasePageBtn')}</button>}
              {updateResult.assetName && updateResult.releaseUrl !== updateResult.downloadUrl && <button type="button" className="text-btn" onClick={() => void openUpdateLink(updateResult.releaseUrl)}>{t('settings.updateOpenReleasePageBtn')}</button>}
            </div>
          </div>}
          {updateResult?.outcome === 'no-release' && <div className="settings-update-card settings-update-card--muted"><p className="settings-update-notes">{t('settings.updateNoReleaseNotice')}</p><div className="button-row"><button type="button" className="soft-btn" onClick={() => void openUpdateLink(updateResult.releaseUrl)}><ArrowUpRight size={14}/>{t('settings.updateOpenReleasePageBtn')}</button></div></div>}
          {updateResult?.outcome === 'rate-limited' && <div className="settings-update-card settings-update-card--muted"><p className="settings-update-notes">{t('settings.updateRateLimitedNotice')}</p><div className="button-row"><button type="button" className="soft-btn" onClick={() => void openUpdateLink(updateResult.releaseUrl)}><ArrowUpRight size={14}/>{t('settings.updateOpenReleasePageBtn')}</button></div></div>}
          {updateResult?.outcome === 'error' && <div className="settings-update-card settings-update-card--muted"><p className="settings-update-notes">{t('settings.updateCheckFailedPrefix')}{updateResult.errorMessage || t('common.unknown')}</p><div className="button-row"><button type="button" className="soft-btn" onClick={() => void openUpdateLink(updateResult.releaseUrl)}><ArrowUpRight size={14}/>{t('settings.updateOpenReleasePageBtn')}</button></div></div>}
        </section>}
        <section className="settings-section">
          <h3>{t('settings.sectionBackupTitle')}</h3>
          <p className="settings-hint">{t('settings.backupDesc1')}</p>
          <p className="settings-hint">{t('settings.backupDesc2')}</p>
          <div className="button-row settings-backup-actions"><button className="soft-btn" onClick={() => void backup()}><Download size={14}/>{t('settings.exportBackupBtn')}</button>{!window.electronAPI?.importDataBackup && <label className="soft-btn file-label"><Upload size={14}/>{t('settings.selectBackupBtn')}<input type="file" accept=".json,application/json" onChange={e => { void importFile(e.target.files?.[0]).catch(() => setFeedback(t('settings.fileReadFailed'))); e.target.value = ''; }}/></label>}</div>
          {(importText || window.electronAPI?.importDataBackup) && <div className="notice settings-restore-box"><label className="check-label"><input type="checkbox" checked={replaceAccepted} onChange={e => setReplaceAccepted(e.target.checked)}/>{t('settings.restoreAcceptLabel')}</label><button className="soft-btn" disabled={!replaceAccepted || busy} onClick={() => void restore()}>{t('settings.restoreBtn')}</button></div>}
        </section>
        {feedback && <p className="notice settings-feedback" role="status">{feedback}</p>}
      </div><footer className="sheet-footer"><button className="soft-btn" onClick={onClose}>{t('common.close')}</button><button className="primary-btn" disabled={busy} onClick={save}>{busy ? t('settings.savingBtn') : t('settings.saveBtn')}</button></footer>
    </section>
  </div>;
}
