import React, { useEffect, useState } from 'react';
import { X, Download, Upload, KeyRound, RotateCcw, ArrowUpRight, Copy, Check } from 'lucide-react';
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
  initialTab?: SettingsTab;
  updateCheck?: { checking: boolean; result: UpdateCheckResult | null };
  onCheckForUpdates?(): void | Promise<void>;
  onOpenUpdateUrl?(url: string): Promise<boolean> | boolean | void;
  onOpenTrialInfo?(): void;
}

type SettingsTab = 'general' | 'ai' | 'updates' | 'backup';

export function SettingsModal({
  settings,
  isOpen,
  onClose,
  onSaveSettings,
  onDataImported,
  onConnectionChange,
  buildInfo,
  initialTab = 'general',
  updateCheck,
  onCheckForUpdates,
  onOpenUpdateUrl,
  onOpenTrialInfo,
}: Props) {
  const { lang, t } = useI18n();
  const initialLanguage: AppLanguage = settings.language || lang;
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [form, setForm] = useState<AppSettings>({ ...settings, language: initialLanguage });
  const [savedBaseline, setSavedBaseline] = useState<AppSettings>({ ...settings, language: initialLanguage });
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<ModelConnectionStatus | null>(null);
  const [feedback, setFeedback] = useState('');
  const [feedbackIsError, setFeedbackIsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importText, setImportText] = useState('');
  const [replaceAccepted, setReplaceAccepted] = useState(false);
  const [reminderCapability, setReminderCapability] = useState<{ background: boolean; notifications: string; exactAlarms: string; enabled: boolean } | null>(null);
  const [shaCopied, setShaCopied] = useState(false);
  const [pendingExit, setPendingExit] = useState<'close' | 'trialInfo' | null>(null);

  const isAndroid = typeof window !== 'undefined' && 'LoomaAndroid' in window;
  const hasNativeBridge = typeof window !== 'undefined' && Boolean(window.electronAPI);
  const isDesktop = hasNativeBridge && !isAndroid;

  const isDirty =
    form.personaName !== savedBaseline.personaName ||
    (isDesktop && Boolean(form.alwaysOnTop) !== Boolean(savedBaseline.alwaysOnTop)) ||
    (isDesktop && Boolean(form.contentProtection) !== Boolean(savedBaseline.contentProtection)) ||
    Boolean(form.remindersEnabled) !== Boolean(savedBaseline.remindersEnabled) ||
    (form.workSuggestionsEnabled ?? true) !== (savedBaseline.workSuggestionsEnabled ?? true) ||
    (hasNativeBridge && (
      form.apiBaseUrl !== savedBaseline.apiBaseUrl ||
      form.modelName !== savedBaseline.modelName ||
      Boolean(form.modelEnabled) !== Boolean(savedBaseline.modelEnabled) ||
      Boolean(form.memoryModelEnabled) !== Boolean(savedBaseline.memoryModelEnabled) ||
      key.length > 0
    ));

  useEffect(() => {
    if (!isOpen) return;
    const initial: AppSettings = { ...settings, language: settings.language || lang };
    setActiveTab(initialTab);
    setForm(initial);
    setSavedBaseline(initial);
    setKey('');
    setFeedback('');
    setFeedbackIsError(false);
    setImportText('');
    setReplaceAccepted(false);
    setReminderCapability(null);
    setShaCopied(false);
    setPendingExit(null);
    let active = true;
    const refreshCapability = () => {
      void TodoService.capabilities()
        .then(value => { if (active) setReminderCapability(value); })
        .catch(() => {
          if (active) {
            setFeedback(t('settings.capabilityReadError'));
            setFeedbackIsError(true);
          }
        });
    };
    refreshCapability();
    if (typeof window !== 'undefined') {
      window.addEventListener?.('looma:todo-capabilities', refreshCapability);
      window.electronAPI?.modelStatus()
        .then(s => {
          if (!active) return;
          setStatus(s);
          const patch = {
            apiBaseUrl: s.apiBaseUrl || initial.apiBaseUrl,
            modelName: s.modelName || initial.modelName,
            modelEnabled: s.enabled,
          };
          setForm(f => ({ ...f, ...patch }));
          setSavedBaseline(b => ({ ...b, ...patch }));
        })
        .catch(() => {
          if (active) {
            setFeedback(t('app.desktopModelUnavailable'));
            setFeedbackIsError(true);
          }
        });
    }
    return () => {
      active = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener?.('looma:todo-capabilities', refreshCapability);
      }
    };
  }, [isOpen]);

  function requestClose(action: 'close' | 'trialInfo' = 'close') {
    if (busy) return;
    if (isDirty) {
      setPendingExit(action);
      return;
    }
    setPendingExit(null);
    if (action === 'trialInfo') onOpenTrialInfo?.();
    else onClose();
  }

  function confirmDiscard() {
    const target = pendingExit;
    setPendingExit(null);
    if (target === 'trialInfo') onOpenTrialInfo?.();
    else onClose();
  }

  useEffect(() => {
    if (!isOpen || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (busy) return;
      if (pendingExit) {
        setPendingExit(null);
        return;
      }
      requestClose('close');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, isDirty, pendingExit, busy]);

  if (!isOpen) return null;

  const activeLang: AppLanguage = form.language || lang || 'zh-CN';

  function showStatus(message: string, isError = false) {
    setFeedback(message);
    setFeedbackIsError(isError);
  }

  function updateForm(updater: (prev: AppSettings) => AppSettings) {
    setPendingExit(null);
    setForm(updater);
  }

  async function switchLanguage(nextLang: AppLanguage) {
    if (activeLang === nextLang && savedBaseline.language === nextLang) return;
    setForm(f => ({ ...f, language: nextLang }));
    setLanguage(nextLang);
    try {
      const nextSaved: AppSettings = { ...savedBaseline, language: nextLang };
      await onSaveSettings(nextSaved);
      setSavedBaseline(nextSaved);
      showStatus(translate(nextLang, nextLang === 'en' ? 'app.languageSavedEn' : 'app.languageSavedZh'));
    } catch (error) {
      showStatus(`${error instanceof Error ? error.message : ''} ${translate(nextLang, 'app.languagePersistFailed')}`.trim(), true);
    }
  }

  async function save() {
    setBusy(true);
    setPendingExit(null);
    showStatus('');
    const nextLang: AppLanguage = form.language || 'zh-CN';
    try {
      if (window.electronAPI) {
        const s = await window.electronAPI.saveModelConnection({
          apiBaseUrl: form.apiBaseUrl,
          modelName: form.modelName,
          enabled: !!form.modelEnabled,
          ...(key ? { apiKey: key } : {}),
        });
        setStatus(s);
        setKey('');
        onConnectionChange?.(s);
      }
      const savedForm: AppSettings = { ...form, language: nextLang };
      await onSaveSettings(savedForm);
      setSavedBaseline(savedForm);
      setLanguage(nextLang);
      setReminderCapability(await TodoService.capabilities());
      if (isDesktop) {
        await window.electronAPI?.setAlwaysOnTop(form.alwaysOnTop);
        await window.electronAPI?.setContentProtection?.(!!form.contentProtection);
      }
      showStatus(translate(nextLang, 'settings.savedNotice'));
    } catch (error) {
      showStatus(`${error instanceof Error ? error.message : ''} ${t('settings.saveErrorSuffix')}`.trim(), true);
    } finally {
      setBusy(false);
    }
  }

  async function requestReminderPermissions() {
    try {
      setReminderCapability(await TodoService.requestPermissions());
      showStatus(t('settings.permissionsUpdated'));
    } catch {
      showStatus(t('settings.permissionsFailed'), true);
    }
  }

  async function backup() {
    try {
      if (window.electronAPI?.exportDataBackup) {
        const result = await window.electronAPI.exportDataBackup();
        if (result.canceled) return;
      } else {
        const payload = await Repository.exportAllData();
        const filename = `Looma-v5-${new Date().toISOString().slice(0, 10)}.json`;
        if (window.electronAPI?.saveBackupFile) {
          const result = await window.electronAPI.saveBackupFile(filename, payload);
          if (result?.canceled) return;
        } else {
          const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }
      showStatus(t('settings.backupGeneratedNotice'));
    } catch {
      showStatus(t('settings.backupFailedNotice'), true);
    }
  }

  async function importFile(file?: File) {
    if (!file) return;
    setImportText(await file.text());
    setReplaceAccepted(false);
    showStatus(t('settings.fileReadNotice'));
  }

  async function restore() {
    if (!replaceAccepted || busy) return;
    setBusy(true);
    setPendingExit(null);
    let acknowledged = false;
    const savedButUnread = t('settings.restoreSavedUnread');
    try {
      if (window.electronAPI?.importDataBackup) {
        const result = await window.electronAPI.importDataBackup();
        if (result.canceled) return;
        acknowledged = true;
        setReplaceAccepted(false);
        try { await Repository.reloadAfterRestore(); }
        catch { /* The native restore was acknowledged; a read failure cannot undo it. */ }
      } else {
        if (!importText) return;
        if (!await Repository.importAllData(importText)) {
          showStatus(t('settings.restoreValidationFailed'), true);
          return;
        }
        acknowledged = true;
        setImportText('');
        setReplaceAccepted(false);
        try {
          const restored = await Repository.getSettings();
          const nextRestored: AppSettings = {
            ...restored,
            ...(status ? { apiBaseUrl: status.apiBaseUrl || restored.apiBaseUrl, modelName: status.modelName || restored.modelName, modelEnabled: status.enabled } : {}),
          };
          setForm(nextRestored);
          setSavedBaseline(nextRestored);
        } catch { /* Continue informing the parent about the completed replacement. */ }
      }
      await onDataImported();
      showStatus(Repository.getRestoreWarning() || t('settings.restoreSuccessFallback'));
    } catch {
      showStatus(acknowledged ? Repository.getRestoreWarning() || savedButUnread : t('settings.restoreUncertain'), true);
    } finally {
      setBusy(false);
    }
  }

  async function openUpdateLink(url: string) {
    try {
      const opened = await onOpenUpdateUrl?.(url);
      if (opened === false) showStatus(t('settings.updateOpenUrlFailed'), true);
    } catch {
      showStatus(t('settings.updateOpenUrlFailed'), true);
    }
  }

  async function copySha256(sha: string) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(sha);
        setShaCopied(true);
        showStatus(t('settings.copiedShaNotice'));
        setTimeout(() => setShaCopied(false), 2000);
        return;
      }
    } catch { /* fallback below */ }
    showStatus(t('settings.copyShaFailedNotice'), true);
  }

  const updateResult = updateCheck?.result;
  const checkingUpdates = !!updateCheck?.checking;
  const panelStyle = (tab: SettingsTab) => (activeTab !== tab ? { display: 'none' } : undefined);

  return (
    <div className="modal-shade" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) requestClose('close'); }}>
      <section className="settings-sheet sheet-shell" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="sheet-header">
          <div>
            <span className="eyebrow">{t('settings.eyebrow')}</span>
            <h2 id="settings-title">{t('settings.title')}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={() => requestClose('close')} aria-label={t('settings.closeAria')}>
            <X size={20} />
          </button>
        </header>

        <nav className="settings-tabs" role="tablist" aria-label={t('settings.tabsAria')}>
          {([
            ['general', t('settings.tabGeneral')],
            ['ai', t('settings.tabAi')],
            ['updates', t('settings.tabUpdates')],
            ['backup', t('settings.tabBackup')],
          ] as const).map(([tabKey, label]) => (
            <button
              key={tabKey}
              type="button"
              role="tab"
              id={`settings-tab-${tabKey}`}
              aria-controls={`settings-panel-${tabKey}`}
              aria-selected={activeTab === tabKey}
              className={activeTab === tabKey ? 'active' : ''}
              onClick={() => setActiveTab(tabKey)}
            >
              <span>{label}</span>
              {tabKey === 'updates' && updateResult?.outcome === 'update-available' && (
                <span className="settings-tab-dot" aria-hidden="true" />
              )}
            </button>
          ))}
        </nav>

        <div className="sheet-body">
          <div
            role="tabpanel"
            id="settings-panel-general"
            aria-labelledby="settings-tab-general"
            hidden={activeTab !== 'general'}
            style={panelStyle('general')}
          >
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
              <label>
                {t('settings.personaNameLabel')}
                <input value={form.personaName} onChange={e => updateForm(f => ({ ...f, personaName: e.target.value }))} />
              </label>
              {isDesktop && (
                <>
                  <label className="check-label">
                    <input type="checkbox" checked={form.alwaysOnTop} onChange={e => updateForm(f => ({ ...f, alwaysOnTop: e.target.checked }))} />
                    {t('settings.alwaysOnTopLabel')}
                  </label>
                  <label className="check-label">
                    <input type="checkbox" checked={!!form.contentProtection} onChange={e => updateForm(f => ({ ...f, contentProtection: e.target.checked }))} />
                    {t('settings.contentProtectionLabel')}
                  </label>
                </>
              )}
            </section>

            <section className="settings-section">
              <h3>{t('settings.sectionRemindersTitle')}</h3>
              <label className="check-label">
                <input type="checkbox" checked={!!form.remindersEnabled} onChange={e => updateForm(f => ({ ...f, remindersEnabled: e.target.checked }))} />
                {t('settings.remindersEnabledLabel')}
              </label>
              <label className="check-label">
                <input type="checkbox" checked={form.workSuggestionsEnabled ?? true} onChange={e => updateForm(f => ({ ...f, workSuggestionsEnabled: e.target.checked }))} />
                <span>
                  {t('settings.workSuggestionsLabel')} <span className="tag">{t('settings.workScopeTag')}</span>
                </span>
              </label>
              <p className="settings-hint">{t('settings.timezoneNote')}</p>
              {reminderCapability ? (
                <div className="notice settings-capability-card">
                  <p className="small">
                    {!reminderCapability.background
                      ? t('settings.capabilityBrowser')
                      : isAndroid
                        ? t('settings.capabilityAndroid')
                        : t('settings.capabilityDesktop')}
                  </p>
                  <p className="small">
                    {t('settings.notifPrefix')}
                    {reminderCapability.notifications === 'granted'
                      ? t('settings.notifGranted')
                      : reminderCapability.notifications === 'unsupported'
                        ? t('settings.notifUnsupported')
                        : t('settings.notifDenied')}
                    {' · '}
                    {reminderCapability.enabled ? t('settings.schedulerEnabled') : t('settings.schedulerDisabled')}
                    {!['granted', 'not-required', 'unsupported'].includes(reminderCapability.exactAlarms) ? ` · ${t('settings.exactAlarmMissing')}` : ''}
                  </p>
                  {reminderCapability.notifications !== 'granted' && reminderCapability.notifications !== 'unsupported' && (
                    <button type="button" className="soft-btn" disabled={busy} onClick={requestReminderPermissions}>
                      {t('settings.requestNotifBtn')}
                    </button>
                  )}
                  {reminderCapability.background && !['granted', 'not-required', 'unsupported'].includes(reminderCapability.exactAlarms) && (
                    <button type="button" className="soft-btn" disabled={busy} onClick={requestReminderPermissions}>
                      {t('settings.requestExactAlarmBtn')}
                    </button>
                  )}
                </div>
              ) : (
                <p className="settings-hint">{t('settings.readingCapabilities')}</p>
              )}
            </section>
          </div>

          <div
            role="tabpanel"
            id="settings-panel-ai"
            aria-labelledby="settings-tab-ai"
            hidden={activeTab !== 'ai'}
            style={panelStyle('ai')}
          >
            <section className="settings-section">
              <div className="section-heading">
                <KeyRound size={16} />
                <h3>{t('settings.modelTitle')}</h3>
                <span className="tag">
                  {hasNativeBridge ? (status?.configured ? t('settings.tagConfigured') : t('settings.tagUnconfigured')) : t('settings.tagBrowserLocal')}
                </span>
              </div>
              {hasNativeBridge ? (
                <>
                  <p className="muted small">{t('settings.modelDesc')}</p>
                  {isAndroid && <p className="settings-hint">{t('settings.modelHardwareKeystoreNote')}</p>}
                  <div className="button-row">
                    <button type="button" className="soft-btn" onClick={() => updateForm(f => ({ ...f, apiBaseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-chat' }))}>
                      {t('settings.presetDeepSeek')}
                    </button>
                    <button type="button" className="soft-btn" onClick={() => updateForm(f => ({ ...f, apiBaseUrl: 'http://localhost:11434/v1', modelName: 'llama3.2' }))}>
                      {t('settings.presetOllama')}
                    </button>
                  </div>
                  <label>
                    {t('settings.apiBaseUrlLabel')}
                    <input value={form.apiBaseUrl} onChange={e => updateForm(f => ({ ...f, apiBaseUrl: e.target.value }))} placeholder={t('settings.apiBaseUrlPlaceholder')} />
                  </label>
                  <label>
                    {t('settings.modelNameLabel')}
                    <input value={form.modelName} onChange={e => updateForm(f => ({ ...f, modelName: e.target.value }))} />
                  </label>
                  <label>
                    {t('settings.apiKeyLabel')}
                    <input
                      type="password"
                      autoComplete="off"
                      value={key}
                      onChange={e => { setPendingExit(null); setKey(e.target.value); }}
                      placeholder={status?.configured ? t('settings.apiKeyPlaceholderConfigured') : t('settings.apiKeyPlaceholderUnconfigured')}
                    />
                  </label>
                  <label className="check-label">
                    <input type="checkbox" checked={!!form.modelEnabled} onChange={e => updateForm(f => ({ ...f, modelEnabled: e.target.checked }))} />
                    {t('settings.enableModelLabel')}
                  </label>
                  <label className="check-label">
                    <input type="checkbox" checked={!!form.memoryModelEnabled} onChange={e => updateForm(f => ({ ...f, memoryModelEnabled: e.target.checked }))} />
                    {t('settings.enableMemoryModelLabel')}
                  </label>
                  <p className="settings-hint">{t('settings.memoryModelDesc')}</p>
                  {status?.configured && !status.persistent && <p className="notice">{t('settings.sessionOnlyNotice')}</p>}
                  <button
                    type="button"
                    className="text-btn danger"
                    onClick={async () => {
                      try {
                        await window.electronAPI!.clearModelConnection();
                        const clean = clearLegacyCredential(localStorage);
                        const s = await window.electronAPI!.modelStatus();
                        setStatus(s);
                        onConnectionChange?.(s);
                        setKey('');
                        setForm(f => ({ ...f, modelEnabled: false }));
                        setSavedBaseline(b => ({ ...b, modelEnabled: false }));
                        showStatus(clean ? (isAndroid ? t('settings.clearModelAndroidSuccess') : t('settings.clearModelSuccess')) : t('settings.clearModelLegacyWarn'), !clean);
                      } catch {
                        showStatus(t('settings.clearModelFailed'), true);
                      }
                    }}
                  >
                    {isAndroid ? t('settings.clearModelAndroidBtn') : t('settings.clearModelBtn')}
                  </button>
                </>
              ) : (
                <p className="settings-hint">{t('settings.browserPreviewLocalHint')}</p>
              )}
            </section>
          </div>

          <div
            role="tabpanel"
            id="settings-panel-updates"
            aria-labelledby="settings-tab-updates"
            hidden={activeTab !== 'updates'}
            style={panelStyle('updates')}
          >
            {(buildInfo || onCheckForUpdates) && (
              <section className="settings-section">
                <div className="settings-update-head">
                  <h3>{t('settings.sectionUpdatesTitle')}</h3>
                  {onCheckForUpdates && (
                    <button type="button" className="soft-btn" disabled={busy || checkingUpdates} onClick={() => void onCheckForUpdates()}>
                      <RotateCcw size={14} />
                      {checkingUpdates ? t('settings.checkingUpdateBtn') : t('settings.checkUpdateBtn')}
                    </button>
                  )}
                </div>
                {buildInfo && (
                  <p className="settings-update-meta">
                    {t('settings.updateCurrentVersionPrefix')}
                    {buildInfo.productVersion}
                    {typeof buildInfo.androidVersionCode === 'number' && buildInfo.androidVersionCode > 0
                      ? `${t('settings.updateAndroidCodePrefix')}${buildInfo.androidVersionCode}`
                      : ''}
                  </p>
                )}
                <p className="settings-hint">{t('settings.updateManualDesc')}</p>
                {updateResult?.outcome === 'up-to-date' && (
                  <div className="settings-update-card">
                    <p className="settings-update-title">
                      {t('settings.updateUpToDate', { version: updateResult.latestVersion || buildInfo?.productVersion || updateResult.currentVersion })}
                    </p>
                  </div>
                )}
                {updateResult?.outcome === 'update-available' && (
                  <div className="settings-update-card settings-update-card--available">
                    <p className="settings-update-title">
                      {t('settings.updateAvailableTitle', { version: updateResult.latestVersion || '' })}
                      {typeof updateResult.latestVersionCode === 'number'
                        ? t('settings.updateLatestVersionCode', { code: updateResult.latestVersionCode })
                        : ''}
                    </p>
                    {updateResult.notesSummary && <p className="settings-update-notes">{updateResult.notesSummary}</p>}
                    {updateResult.expectedSha256 && (
                      <div className="button-row">
                        <p className="settings-update-sha">
                          {t('settings.updateShaPrefix')}
                          {updateResult.expectedSha256}
                        </p>
                        <button type="button" className="soft-btn" onClick={() => void copySha256(updateResult.expectedSha256!)}>
                          {shaCopied ? <Check size={14} /> : <Copy size={14} />}
                          {shaCopied ? t('settings.copiedShaBtn') : t('settings.copyShaBtn')}
                        </button>
                      </div>
                    )}
                    <p className="settings-update-warn">
                      {updateResult.platform === 'android' ? t('settings.updateAvailableAndroidHint') : t('settings.updateAvailableDesktopHint')}
                    </p>
                    <div className="button-row">
                      <button type="button" className="soft-btn" onClick={() => void backup()}>
                        <Download size={14} />
                        {t('settings.updateBackupFirstBtn')}
                      </button>
                      {updateResult.downloadUrl && (
                        <button type="button" className="primary-btn" onClick={() => void openUpdateLink(updateResult.downloadUrl!)}>
                          <ArrowUpRight size={14} />
                          {updateResult.assetName
                            ? t('settings.updateDownloadBtn', { asset: updateResult.assetName })
                            : t('settings.updateOpenReleasePageBtn')}
                        </button>
                      )}
                      {updateResult.assetName && updateResult.releaseUrl !== updateResult.downloadUrl && (
                        <button type="button" className="text-btn" onClick={() => void openUpdateLink(updateResult.releaseUrl)}>
                          {t('settings.updateOpenReleasePageBtn')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {updateResult?.outcome === 'no-release' && (
                  <div className="settings-update-card settings-update-card--muted">
                    <p className="settings-update-notes">{t('settings.updateNoReleaseNotice')}</p>
                    <div className="button-row">
                      <button type="button" className="soft-btn" onClick={() => void openUpdateLink(updateResult.releaseUrl)}>
                        <ArrowUpRight size={14} />
                        {t('settings.updateOpenReleasePageBtn')}
                      </button>
                    </div>
                  </div>
                )}
                {updateResult?.outcome === 'rate-limited' && (
                  <div className="settings-update-card settings-update-card--muted">
                    <p className="settings-update-notes">{t('settings.updateRateLimitedNotice')}</p>
                    <div className="button-row">
                      <button type="button" className="soft-btn" onClick={() => void openUpdateLink(updateResult.releaseUrl)}>
                        <ArrowUpRight size={14} />
                        {t('settings.updateOpenReleasePageBtn')}
                      </button>
                    </div>
                  </div>
                )}
                {updateResult?.outcome === 'error' && (
                  <div className="settings-update-card settings-update-card--muted">
                    <p className="settings-update-notes">
                      {t('settings.updateCheckFailedPrefix')}
                      {updateResult.errorMessage || t('common.unknown')}
                    </p>
                    <div className="button-row">
                      <button type="button" className="soft-btn" onClick={() => void openUpdateLink(updateResult.releaseUrl)}>
                        <ArrowUpRight size={14} />
                        {t('settings.updateOpenReleasePageBtn')}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
            {onOpenTrialInfo && (
              <section className="settings-section">
                <h3>{t('settings.openTrialInfoTitle')}</h3>
                <p className="settings-hint">{t('settings.openTrialInfoHint')}</p>
                <div className="button-row settings-backup-actions">
                  <button type="button" className="soft-btn" onClick={() => requestClose('trialInfo')}>
                    {t('settings.openTrialInfoBtn')}
                  </button>
                </div>
              </section>
            )}
          </div>

          <div
            role="tabpanel"
            id="settings-panel-backup"
            aria-labelledby="settings-tab-backup"
            hidden={activeTab !== 'backup'}
            style={panelStyle('backup')}
          >
            <section className="settings-section">
              <h3>{t('settings.sectionBackupTitle')}</h3>
              <p className="settings-hint">{t('settings.backupDesc1')}</p>
              <p className="settings-hint">{t('settings.backupDesc2')}</p>
              <div className="button-row settings-backup-actions">
                <button type="button" className="soft-btn" onClick={() => void backup()}>
                  <Download size={14} />
                  {t('settings.exportBackupBtn')}
                </button>
                {!window.electronAPI?.importDataBackup && (
                  <label className="soft-btn file-label">
                    <Upload size={14} />
                    {t('settings.selectBackupBtn')}
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={e => {
                        void importFile(e.target.files?.[0]).catch(() => showStatus(t('settings.fileReadFailed'), true));
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
              </div>
              {(importText || window.electronAPI?.importDataBackup) && (
                <div className="notice settings-restore-box">
                  <label className="check-label">
                    <input type="checkbox" checked={replaceAccepted} onChange={e => setReplaceAccepted(e.target.checked)} />
                    {t('settings.restoreAcceptLabel')}
                  </label>
                  <button type="button" className="soft-btn" disabled={!replaceAccepted || busy} onClick={() => void restore()}>
                    {t('settings.restoreBtn')}
                  </button>
                </div>
              )}
            </section>
          </div>
        </div>

        {pendingExit ? (
          <div className="settings-feedback--sticky is-error" role="alert">
            <div className="button-row">
              <span>{t('settings.unsavedChangesPrompt')}</span>
              <button type="button" className="soft-btn" onClick={() => setPendingExit(null)}>
                {t('settings.keepEditingBtn')}
              </button>
              <button type="button" className="text-btn danger" onClick={confirmDiscard}>
                {t('settings.discardAndCloseBtn')}
              </button>
            </div>
          </div>
        ) : (
          feedback && (
            <p className={`settings-feedback--sticky${feedbackIsError ? ' is-error' : ''}`} role={feedbackIsError ? 'alert' : 'status'}>
              {feedback}
            </p>
          )
        )}

        <footer className="sheet-footer">
          <button type="button" className="soft-btn" onClick={() => requestClose('close')}>
            {t('common.close')}
          </button>
          <button type="button" className="primary-btn" disabled={busy} onClick={save}>
            {busy ? t('settings.savingBtn') : t('settings.saveBtn')}
          </button>
        </footer>
      </section>
    </div>
  );
}
