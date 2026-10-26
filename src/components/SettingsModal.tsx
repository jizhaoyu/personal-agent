import React, { useState } from 'react';
import { X, Settings, Key, User, Shield, Download, Upload, Trash2, Check } from 'lucide-react';
import { AppSettings } from '../types';
import { StorageService } from '../services/storage';

interface SettingsModalProps {
  settings: AppSettings;
  isOpen: boolean;
  onClose: () => void;
  onSaveSettings: (settings: AppSettings) => void;
  onDataImported: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  isOpen,
  onClose,
  onSaveSettings,
  onDataImported,
}) => {
  const [formData, setFormData] = useState<AppSettings>(settings);
  const [copiedNotification, setCopiedNotification] = useState(false);

  if (!isOpen) return null;

  const handleSave = () => {
    StorageService.saveSettings(formData);
    onSaveSettings(formData);
    onClose();
  };

  // 快捷预设填充
  const applyPreset = (type: 'deepseek' | 'claude' | 'ollama') => {
    if (type === 'deepseek') {
      setFormData((prev) => ({
        ...prev,
        apiBaseUrl: 'https://api.deepseek.com/v1',
        modelName: 'deepseek-chat',
      }));
    } else if (type === 'claude') {
      setFormData((prev) => ({
        ...prev,
        apiBaseUrl: 'https://api.anthropic.com/v1',
        modelName: 'claude-3-5-sonnet-20241022',
      }));
    } else if (type === 'ollama') {
      setFormData((prev) => ({
        ...prev,
        apiBaseUrl: 'http://localhost:11434/v1',
        modelName: 'llama3.2',
        apiKey: 'ollama',
      }));
    }
  };

  // 导出全部主权数据
  const handleExport = () => {
    const jsonStr = StorageService.exportAllData();
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Ambi-Data-Backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };

  // 导入数据
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (StorageService.importAllData(content)) {
        onDataImported();
        alert('数据恢复成功！');
        onClose();
      } else {
        alert('数据解析失败，请检查文件格式。');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/30 backdrop-blur-xs">
      <div className="w-full max-w-[360px] bg-[#fdfbf7] border border-[#e2d8c3] rounded-2xl shadow-float flex flex-col max-h-[520px] overflow-hidden">
        {/* 顶部标题 */}
        <div className="px-4 py-3 border-b border-[#ece6d5] flex items-center justify-between bg-[#f9f6ed]">
          <div className="flex items-center gap-2">
            <Settings size={16} className="text-[#a8681a]" />
            <h3 className="text-sm font-semibold text-[#23293a]">系统设置与伴侣管理</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-[#a49f91] hover:text-[#23293a] rounded-lg transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {/* API 配置 */}
          <div className="space-y-2">
            <label className="font-semibold text-[#23293a] flex items-center gap-1.5">
              <Key size={13} className="text-[#a8681a]" />
              大模型连接配置
            </label>

            {/* 快速预设按钮 */}
            <div className="flex gap-1.5 pt-0.5">
              <button
                type="button"
                onClick={() => applyPreset('deepseek')}
                className="px-2 py-0.5 rounded bg-[#efeadd] hover:bg-[#e2d8c3] text-[#8a5410] text-[10px]"
              >
                DeepSeek (推荐)
              </button>
              <button
                type="button"
                onClick={() => applyPreset('ollama')}
                className="px-2 py-0.5 rounded bg-[#efeadd] hover:bg-[#e2d8c3] text-[#8a5410] text-[10px]"
              >
                本地 Ollama
              </button>
            </div>

            <div className="space-y-1.5 pt-1">
              <div>
                <span className="text-[10px] text-[#8a5410]">API Base URL</span>
                <input
                  type="text"
                  value={formData.apiBaseUrl}
                  onChange={(e) => setFormData({ ...formData, apiBaseUrl: e.target.value })}
                  placeholder="https://api.deepseek.com/v1"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#ded5be] bg-white focus:outline-none focus:border-[#a8681a]"
                />
              </div>

              <div>
                <span className="text-[10px] text-[#8a5410]">API Key（不填则开启离线模拟相伴）</span>
                <input
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                  placeholder="sk-..."
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#ded5be] bg-white focus:outline-none focus:border-[#a8681a]"
                />
              </div>

              <div>
                <span className="text-[10px] text-[#8a5410]">模型名称</span>
                <input
                  type="text"
                  value={formData.modelName}
                  onChange={(e) => setFormData({ ...formData, modelName: e.target.value })}
                  placeholder="deepseek-chat"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#ded5be] bg-white focus:outline-none focus:border-[#a8681a]"
                />
              </div>
            </div>
          </div>

          {/* 伴侣形象与性格 */}
          <div className="space-y-2 pt-2 border-t border-[#ece6d5]">
            <label className="font-semibold text-[#23293a] flex items-center gap-1.5">
              <User size={13} className="text-[#a8681a]" />
              伴侣形象与昵称
            </label>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <span className="text-[10px] text-[#8a5410]">头像表情</span>
                <input
                  type="text"
                  value={formData.personaAvatar}
                  onChange={(e) => setFormData({ ...formData, personaAvatar: e.target.value })}
                  placeholder="🐱"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#ded5be] bg-white text-center text-sm"
                />
              </div>
              <div className="col-span-2">
                <span className="text-[10px] text-[#8a5410]">伴侣昵称</span>
                <input
                  type="text"
                  value={formData.personaName}
                  onChange={(e) => setFormData({ ...formData, personaName: e.target.value })}
                  placeholder="Ambi"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#ded5be] bg-white"
                />
              </div>
            </div>
          </div>

          {/* 数据主权管理（源自 IO 哲学） */}
          <div className="space-y-2 pt-2 border-t border-[#ece6d5]">
            <label className="font-semibold text-[#23293a] flex items-center gap-1.5">
              <Shield size={13} className="text-[#a8681a]" />
              数据主权与备份 (Data Sovereignty)
            </label>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleExport}
                className="flex-1 py-1.5 px-2 rounded-lg bg-[#efeadd] hover:bg-[#e2d8c3] text-[#8a5410] flex items-center justify-center gap-1 text-[11px]"
              >
                <Download size={12} />
                <span>导出全量记忆</span>
              </button>

              <label className="flex-1 py-1.5 px-2 rounded-lg bg-[#efeadd] hover:bg-[#e2d8c3] text-[#8a5410] flex items-center justify-center gap-1 text-[11px] cursor-pointer">
                <Upload size={12} />
                <span>导入备份</span>
                <input type="file" accept=".json" onChange={handleImportFile} className="hidden" />
              </label>
            </div>
          </div>
        </div>

        {/* 底部保存按钮 */}
        <div className="px-4 py-2.5 bg-[#f9f6ed] border-t border-[#ece6d5] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-[#ded5be] text-[#6b7183] text-xs hover:bg-[#efeadd]"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 rounded-lg bg-[#a8681a] text-white text-xs hover:bg-[#8a5410] transition-colors"
          >
            保存并应用
          </button>
        </div>
      </div>
    </div>
  );
};
