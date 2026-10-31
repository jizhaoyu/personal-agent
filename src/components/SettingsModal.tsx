import React, { useEffect, useState } from 'react';
import { X, Download, Upload, KeyRound } from 'lucide-react';
import type { AppSettings } from '../types';
import { Repository } from '../persistence/repository';
import { clearLegacyCredential } from '../services/legacyConnection';

interface Props { settings: AppSettings; isOpen: boolean; onClose(): void; onSaveSettings(settings: AppSettings): Promise<void>; onDataImported(): void | Promise<void>; onConnectionChange?(status: ModelConnectionStatus): void }
export function SettingsModal({ settings, isOpen, onClose, onSaveSettings, onDataImported, onConnectionChange }: Props) {
  const [form, setForm] = useState(settings);
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<ModelConnectionStatus | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [importText, setImportText] = useState('');
  const [replaceAccepted, setReplaceAccepted] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    setForm(settings); setKey(''); setFeedback(''); setImportText(''); setReplaceAccepted(false);
    window.electronAPI?.modelStatus().then(s => { setStatus(s); setForm(f => ({ ...f, apiBaseUrl: s.apiBaseUrl || f.apiBaseUrl, modelName: s.modelName || f.modelName, modelEnabled: s.enabled })); }).catch(() => setFeedback('无法读取桌面模型配置，仍可使用本地记录。'));
  }, [isOpen]);
  if (!isOpen) return null;
  async function save() {
    setBusy(true); setFeedback('');
    try {
      if (window.electronAPI) {
        const s = await window.electronAPI.saveModelConnection({ apiBaseUrl: form.apiBaseUrl, modelName: form.modelName, enabled: !!form.modelEnabled, ...(key ? { apiKey: key } : {}) });
        setStatus(s); setKey(''); onConnectionChange?.(s);
      }
      await onSaveSettings(form);
      await window.electronAPI?.setAlwaysOnTop(form.alwaysOnTop);
      setFeedback('设置已保存。');
    } catch (error) { setFeedback(`${error instanceof Error ? error.message : '设置保存失败。'} 请重新打开设置核对，部分连接配置可能已保存。`); }
    finally { setBusy(false); }
  }
  async function backup() {
    try {
      if (window.electronAPI?.exportDataBackup) {
        const result = await window.electronAPI.exportDataBackup(); if (result.canceled) return;
      } else {
        const url = URL.createObjectURL(new Blob([await Repository.exportAllData()], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = `Looma-v5-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setFeedback('已生成两个空间的业务备份，不含模型凭据。');
    } catch { setFeedback('备份生成失败，请检查本地存储状态。'); }
  }
  async function importFile(file?: File) {
    if (!file) return;
    setImportText(await file.text()); setReplaceAccepted(false); setFeedback('文件已读取。导入会替换两个空间的数据，请先备份并确认。');
  }
  async function restore() {
    if (!replaceAccepted || busy) return;
    setBusy(true); let acknowledged = false;
    const savedButUnread = '业务资料已从备份恢复，视图暂未读取成功。请重新读取或重开应用，勿重复导入。';
    try {
      if (window.electronAPI?.importDataBackup) {
        const result = await window.electronAPI.importDataBackup(); if (result.canceled) return;
        acknowledged = true; setReplaceAccepted(false);
        try { await Repository.reloadAfterRestore(); }
        catch { /* The native restore was acknowledged; a read failure cannot undo it. */ }
      } else {
        if (!importText) return;
        if (!await Repository.importAllData(importText)) { setFeedback('文件校验或写入失败，当前业务数据未替换。'); return; }
        acknowledged = true; setImportText(''); setReplaceAccepted(false);
        try {
          const restored = await Repository.getSettings();
          setForm({ ...restored, ...(status ? { apiBaseUrl: status.apiBaseUrl || restored.apiBaseUrl, modelName: status.modelName || restored.modelName, modelEnabled: status.enabled } : {}) });
        } catch { /* Continue informing the parent about the completed replacement. */ }
      }
      await onDataImported();
      setFeedback(Repository.getRestoreWarning() || '业务数据已完整恢复，模型凭据保持独立。');
    } catch {
      setFeedback(acknowledged ? Repository.getRestoreWarning() || savedButUnread : '恢复结果暂时无法确认，请重新读取并核对当前资料，勿重复导入。');
    } finally { setBusy(false); }
  }
  return <div className="modal-shade" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="sheet-header"><div><span className="eyebrow">YOUR WORKSPACE</span><h2 id="settings-title">设置与数据</h2></div><button className="icon-btn" onClick={onClose} aria-label="关闭设置"><X size={20}/></button></header>
      <div className="sheet-body">
        <p className="muted small">无需配置模型即可开始记录、核对和接续工作。模型增强是可选项，基础流程在本机运行。</p>
        <details className="optional-model-settings" open={!!form.modelEnabled || !!form.memoryModelEnabled}><summary>可选：配置模型增强</summary>
        <div className="section-heading"><KeyRound size={16}/><h3>模型增强</h3><span className="tag">{window.electronAPI ? status?.configured ? '已配置' : '未配置' : '浏览器 · 本地模式'}</span></div>
        {window.electronAPI ? <>
          <p className="muted small">开启后，将当前输入和选中项目的必要字段发送到你配置的服务；不会附带其他项目、生活数据或内部备注。结果仍需你确认。</p>
          <div className="button-row"><button className="soft-btn" onClick={() => setForm(f => ({ ...f, apiBaseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-chat' }))}>DeepSeek 兼容接口</button><button className="soft-btn" onClick={() => setForm(f => ({ ...f, apiBaseUrl: 'http://localhost:11434/v1', modelName: 'llama3.2' }))}>本地 Ollama</button></div>
          <label>API Base URL<input value={form.apiBaseUrl} onChange={e => setForm(f => ({ ...f, apiBaseUrl: e.target.value }))} placeholder="https://…/v1"/></label>
          <label>模型名称<input value={form.modelName} onChange={e => setForm(f => ({ ...f, modelName: e.target.value }))}/></label>
          <label>API Key<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={status?.configured ? '已配置；留空保留，输入可替换' : 'Ollama 通常无需填写'}/></label>
          <label className="check-label"><input type="checkbox" checked={!!form.modelEnabled} onChange={e => setForm(f => ({ ...f, modelEnabled: e.target.checked }))}/>我了解发送范围，主动开启模型增强</label>
          <label className="check-label"><input type="checkbox" checked={!!form.memoryModelEnabled} onChange={e => setForm(f => ({ ...f, memoryModelEnabled: e.target.checked }))}/>另外允许发送当前空间检索到的回忆资料（默认关闭）</label>
          <p className="muted small">回忆增强仅在记忆中心主动点击时发送当前问题和已展示的相关证据，最多20项、8000字符；不会读取另一空间或内部项目备注。历史原文可能含你主动输入的私人信息，请先审阅。</p>
          {status?.configured && !status.persistent && <p className="notice">凭据仅在当前桌面会话有效，下次启动需要重新配置。</p>}
          <button className="text-btn danger" onClick={async () => { try { await window.electronAPI!.clearModelConnection(); const clean = clearLegacyCredential(localStorage); const s = await window.electronAPI!.modelStatus(); setStatus(s); onConnectionChange?.(s); setForm(f => ({ ...f, modelEnabled: false })); setFeedback(clean ? '桌面模型配置已清除。' : '桌面连接已清除，但旧版凭据字段未能清理，请检查本地存储权限。'); } catch { setFeedback('清除失败，请重试。'); } }}>清除桌面模型配置</button>
        </> : <p className="muted small">此浏览器预览支持本地解析、确认、修正、撤销和导出。连接自配模型请使用 Windows 桌面版。</p>}
        </details><hr/>
        <h3>使用偏好</h3>
        <label>伴侣名称<input value={form.personaName} onChange={e => setForm(f => ({ ...f, personaName: e.target.value }))}/></label>
        <label className="check-label"><input type="checkbox" checked={form.alwaysOnTop} onChange={e => setForm(f => ({ ...f, alwaysOnTop: e.target.checked }))}/>桌面窗口置顶</label>
        <label className="check-label"><input type="checkbox" checked={!!form.remindersEnabled} onChange={e => setForm(f => ({ ...f, remindersEnabled: e.target.checked }))}/>应用开启时发送到期通知（仅显示事项数量）</label>
        <p className="muted small">时区：Asia/Shanghai。退出后不提醒，重新打开时汇总到期事项。</p>
        <hr/><h3>本地业务备份</h3><p className="muted small">包含生活与工作资料、手记、自定义卡和变更历史，不含 API Key。业务数据采用本地逻辑分区，并非加密保险箱。</p>
        <p className="muted small">桌面使用SQLite逐条保存；原始档案保留到你主动删除。桌面备份为完整JSONL文件，浏览器为JSON，均不受旧版5MB限制。</p>
        <div className="button-row"><button className="soft-btn" onClick={() => void backup()}><Download size={14}/>导出备份</button>{!window.electronAPI?.importDataBackup && <label className="soft-btn file-label"><Upload size={14}/>选择备份<input type="file" accept=".json,application/json" onChange={e => { void importFile(e.target.files?.[0]).catch(() => setFeedback('文件读取失败。')); e.target.value = ''; }}/></label>}</div>
        {(importText || window.electronAPI?.importDataBackup) && <div className="notice"><label className="check-label"><input type="checkbox" checked={replaceAccepted} onChange={e => setReplaceAccepted(e.target.checked)}/>我已备份，确认替换两个空间的业务数据</label><button className="soft-btn" disabled={!replaceAccepted || busy} onClick={() => void restore()}>校验并恢复</button></div>}
        {feedback && <p className="notice" role="status">{feedback}</p>}
      </div><footer className="sheet-footer"><button className="soft-btn" onClick={onClose}>关闭</button><button className="primary-btn" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存设置'}</button></footer>
    </section>
  </div>;
}
