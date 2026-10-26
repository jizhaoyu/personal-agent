import React, { useState } from 'react';
import { Brain, Trash2, Plus, Heart, Calendar, Sparkles, ShieldAlert, Briefcase, Users } from 'lucide-react';
import { MemoryItem, WorkspaceMode } from '../types';
import { StorageService } from '../services/storage';

interface MemoryTimelineProps {
  memories: MemoryItem[];
  mode: WorkspaceMode;
  onMemoriesChange: (memories: MemoryItem[]) => void;
}

export const MemoryTimeline: React.FC<MemoryTimelineProps> = ({
  memories,
  mode,
  onMemoriesChange,
}) => {
  const [newFact, setNewFact] = useState('');
  const [newCategory, setNewCategory] = useState<MemoryItem['category']>(
    mode === 'work' ? 'business' : 'preference'
  );

  const isWork = mode === 'work';

  const handleDelete = (id: string) => {
    StorageService.deleteMemory(id, mode);
    onMemoriesChange(StorageService.getMemories(mode));
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFact.trim()) return;
    StorageService.addMemory(newFact.trim(), newCategory, mode);
    setNewFact('');
    onMemoriesChange(StorageService.getMemories(mode));
  };

  const getCategoryMeta = (cat: MemoryItem['category']) => {
    switch (cat) {
      case 'preference':
        return {
          label: '长期偏好',
          icon: <Heart className="w-3 h-3" />,
          color: isWork
            ? 'bg-sky-900/50 text-sky-300 border-sky-700/60'
            : 'bg-rose-100 text-rose-700 border-rose-200',
        };
      case 'experience':
        return {
          label: '重要经历',
          icon: <Calendar className="w-3 h-3" />,
          color: isWork
            ? 'bg-indigo-900/50 text-indigo-300 border-indigo-700/60'
            : 'bg-amber-100 text-amber-700 border-amber-200',
        };
      case 'person':
        return {
          label: '人脉关系',
          icon: <Users className="w-3 h-3" />,
          color: isWork
            ? 'bg-purple-900/50 text-purple-300 border-purple-700/60'
            : 'bg-purple-100 text-purple-700 border-purple-200',
        };
      case 'business':
        return {
          label: '商业底线',
          icon: <Briefcase className="w-3 h-3" />,
          color: isWork
            ? 'bg-amber-900/50 text-amber-300 border-amber-700/60'
            : 'bg-blue-100 text-blue-700 border-blue-200',
        };
      case 'habit':
      default:
        return {
          label: '日常习惯',
          icon: <Sparkles className="w-3 h-3" />,
          color: isWork
            ? 'bg-emerald-900/50 text-emerald-300 border-emerald-700/60'
            : 'bg-emerald-100 text-emerald-700 border-emerald-200',
        };
    }
  };

  return (
    <div
      className={`flex flex-col h-[460px] rounded-2xl overflow-hidden border shadow-float transition-colors ${
        isWork
          ? 'bg-[#0f172a]/95 border-slate-700 text-slate-100'
          : 'bg-[#fcfaf5]/95 border-[#e5dec9] text-[#23293a]'
      }`}
    >
      {/* Header */}
      <div
        className={`px-4 py-3 border-b flex items-center justify-between ${
          isWork ? 'bg-slate-900/90 border-slate-800' : 'bg-[#f9f6ed] border-[#ece6d5]'
        }`}
      >
        <div className="flex items-center gap-2">
          <Brain className={`w-4 h-4 ${isWork ? 'text-blue-400' : 'text-[#8a5410]'}`} />
          <span className="font-bold text-xs">
            {isWork ? '💼 搞钱态 · 独立商业记忆保险箱' : '🌙 生活态 · 私密温情记忆胶囊'}
          </span>
        </div>
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
            isWork ? 'bg-slate-800 text-blue-300 border border-slate-700' : 'bg-[#efeadd] text-[#8a5410]'
          }`}
        >
          已沉淀 {memories.length} 条
        </span>
      </div>

      {/* Dual-Vault Isolation Banner */}
      <div
        className={`px-3.5 py-2 border-b flex items-start gap-2 text-[11px] leading-relaxed ${
          isWork
            ? 'bg-slate-950/60 border-slate-800 text-slate-400'
            : 'bg-amber-50/60 border-[#ece6d5] text-[#8a5410]'
        }`}
      >
        <ShieldAlert
          className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${isWork ? 'text-blue-400' : 'text-[#a8681a]'}`}
        />
        <span>
          {isWork
            ? '双生隔离保护生效中：当前处于【搞钱态】，此处商业记忆与您的私人生活情绪完全物理隔离，投屏防窥。'
            : '双生隔离保护生效中：当前处于【生活态】，所有记忆 100% 存储在您的本地设备，随时可一键彻底抹除。'}
        </span>
      </div>

      {/* Add Memory Form */}
      <form
        onSubmit={handleAdd}
        className={`p-2.5 border-b flex flex-col gap-2 ${
          isWork ? 'bg-slate-900/90 border-slate-800' : 'bg-[#f9f6ed] border-[#ece6d5]'
        }`}
      >
        <div className="flex gap-1.5">
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as MemoryItem['category'])}
            className={`text-xs rounded-lg px-2 py-1.5 border focus:outline-none ${
              isWork
                ? 'bg-slate-800 border-slate-700 text-slate-200'
                : 'bg-white border-[#ded5be] text-[#23293a]'
            }`}
          >
            <option value="preference">长期偏好</option>
            <option value="habit">日常习惯</option>
            <option value="person">人脉关系</option>
            <option value="business">商业底线</option>
            <option value="experience">重要经历</option>
          </select>
          <input
            type="text"
            value={newFact}
            onChange={(e) => setNewFact(e.target.value)}
            placeholder={
              isWork
                ? '手动写下一条需要幕僚牢记的商业规则...'
                : '手动写下一条希望伴侣记住的生活细节...'
            }
            className={`flex-1 text-xs rounded-lg px-2.5 py-1.5 border focus:outline-none ${
              isWork
                ? 'bg-slate-800 border-slate-700 text-slate-100 placeholder-slate-500'
                : 'bg-white border-[#ded5be] text-[#23293a] placeholder-[#a49f91]'
            }`}
          />
          <button
            type="submit"
            disabled={!newFact.trim()}
            className={`px-2.5 py-1.5 text-white rounded-lg text-xs font-medium disabled:opacity-40 flex items-center gap-1 cursor-pointer ${
              isWork ? 'bg-blue-600 hover:bg-blue-500' : 'bg-[#a8681a] hover:bg-[#8a5410]'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            添加
          </button>
        </div>
      </form>

      {/* Memory List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {memories.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6">
            <Brain
              className={`w-10 h-10 mb-2 ${isWork ? 'text-slate-700' : 'text-[#ded5be]'}`}
            />
            <p className={`text-xs font-medium ${isWork ? 'text-slate-400' : 'text-[#6b7183]'}`}>
              还没有记录下长期记忆哦
            </p>
            <p className={`text-[11px] mt-1 ${isWork ? 'text-slate-500' : 'text-[#a49f91]'}`}>
              在聊天中提及你的喜好或客户信息，Looma 会自动为你沉淀到这里
            </p>
          </div>
        ) : (
          memories.map((item) => {
            const meta = getCategoryMeta(item.category);
            return (
              <div
                key={item.id}
                className={`group p-3 rounded-xl border shadow-xs transition-all flex items-start justify-between gap-2 ${
                  isWork
                    ? 'bg-slate-800/80 border-slate-700/70 hover:border-blue-500/50'
                    : 'bg-white border-[#e5dec9] hover:border-[#a8681a]/50'
                }`}
              >
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${meta.color}`}
                    >
                      {meta.icon}
                      {meta.label}
                    </span>
                    <span className={`text-[10px] ${isWork ? 'text-slate-500' : 'text-[#a49f91]'}`}>
                      {new Date(item.createdAt).toLocaleDateString('zh-CN', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <p
                    className={`text-xs leading-relaxed pt-0.5 ${
                      isWork ? 'text-slate-200' : 'text-[#23293a]'
                    }`}
                  >
                    {item.fact}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(item.id)}
                  title="忘掉这件事"
                  className="opacity-60 group-hover:opacity-100 p-1.5 text-rose-400 hover:text-rose-600 hover:bg-rose-500/10 rounded-lg transition-all cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
