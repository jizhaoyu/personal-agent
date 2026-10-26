import React from 'react';
import {
  MessageSquare,
  Layers,
  Brain,
  BookOpen,
  Grid3X3,
  Settings,
  Move,
  Moon,
  Briefcase,
} from 'lucide-react';
import { AppSettings, WorkspaceMode } from '../types';

export type MainTabType = 'chat' | 'cards' | 'journal' | 'gomoku' | 'memory';

interface FloatingDockProps {
  settings: AppSettings;
  mode: WorkspaceMode;
  isExpanded: boolean;
  activeTab: MainTabType;
  onToggleExpand: () => void;
  onToggleMode: () => void;
  onSelectTab: (tab: MainTabType) => void;
  onOpenSettings: () => void;
}

export const FloatingDock: React.FC<FloatingDockProps> = ({
  settings,
  mode,
  isExpanded,
  activeTab,
  onToggleExpand,
  onToggleMode,
  onSelectTab,
  onOpenSettings,
}) => {
  const isWork = mode === 'work';

  return (
    <div
      className={`flex items-center gap-1.5 p-1.5 rounded-full backdrop-blur-md border shadow-pill drag-region transition-all duration-300 ${
        isWork
          ? 'bg-[#0f172a]/95 border-slate-700 text-slate-100'
          : 'bg-[#fdfbf7]/95 border-[#e5dec9] text-[#23293a]'
      }`}
    >
      {/* 伴侣头像与展开切换 */}
      <button
        onClick={onToggleExpand}
        className={`no-drag flex items-center gap-1.5 px-2.5 py-1.5 rounded-full transition-all cursor-pointer group ${
          isWork
            ? 'bg-slate-800 hover:bg-slate-700 text-blue-400'
            : 'bg-[#efeadd] hover:bg-[#e7dfcb] text-[#8a5410]'
        }`}
        title="点击展开/收起灵犀胶囊"
      >
        <span className="text-base select-none group-hover:scale-110 transition-transform">
          {isWork ? '💼' : settings.personaAvatar || '✨'}
        </span>
        <span className="text-xs font-bold">
          {isWork ? 'Looma Pro' : settings.personaName?.split(' ')[0] || 'Looma'}
        </span>
        <span
          className={`w-2 h-2 rounded-full animate-pulse ${
            isWork ? 'bg-blue-400' : 'bg-emerald-500'
          }`}
        />
      </button>

      {/* 日夜双态（ToC 生活态 / ToB 搞钱态）一键切换开关 */}
      <button
        onClick={onToggleMode}
        className={`no-drag flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all cursor-pointer ${
          isWork
            ? 'bg-blue-600/20 border-blue-500/40 text-blue-300 hover:bg-blue-600/30'
            : 'bg-amber-500/15 border-amber-600/30 text-[#8a5410] hover:bg-amber-500/25'
        }`}
        title="点击切换【🌙 生活态 (ToC)】与【💼 搞钱态 (ToB 防窥)】"
      >
        {isWork ? <Briefcase size={12} /> : <Moon size={12} />}
        <span>{isWork ? '搞钱态' : '生活态'}</span>
      </button>

      {/* 导航页签 */}
      {isExpanded && (
        <div className="flex items-center gap-0.5 no-drag px-0.5">
          <button
            onClick={() => onSelectTab('chat')}
            className={`p-1.5 rounded-full transition-colors cursor-pointer ${
              activeTab === 'chat'
                ? isWork
                  ? 'bg-blue-600 text-white'
                  : 'bg-[#a8681a] text-white'
                : isWork
                ? 'text-slate-400 hover:bg-slate-800'
                : 'text-[#6b7183] hover:bg-[#efeadd]'
            }`}
            title="随口说 / 零填表对话"
          >
            <MessageSquare size={14} />
          </button>

          <button
            onClick={() => onSelectTab('cards')}
            className={`p-1.5 rounded-full transition-colors cursor-pointer ${
              activeTab === 'cards'
                ? isWork
                  ? 'bg-blue-600 text-white'
                  : 'bg-[#a8681a] text-white'
                : isWork
                ? 'text-slate-400 hover:bg-slate-800'
                : 'text-[#6b7183] hover:bg-[#efeadd]'
            }`}
            title={isWork ? '商务活体看板 (CRM/死线/对齐单)' : '生活活体状态卡 (记账/状态栏/人脉)'}
          >
            <Layers size={14} />
          </button>

          <button
            onClick={() => onSelectTab('journal')}
            className={`p-1.5 rounded-full transition-colors cursor-pointer ${
              activeTab === 'journal'
                ? isWork
                  ? 'bg-blue-600 text-white'
                  : 'bg-[#a8681a] text-white'
                : isWork
                ? 'text-slate-400 hover:bg-slate-800'
                : 'text-[#6b7183] hover:bg-[#efeadd]'
            }`}
            title={isWork ? '今日商务推进战报' : '今日双人生活手帐'}
          >
            <BookOpen size={14} />
          </button>

          {!isWork && (
            <button
              onClick={() => onSelectTab('gomoku')}
              className={`p-1.5 rounded-full transition-colors cursor-pointer ${
                activeTab === 'gomoku'
                  ? 'bg-[#a8681a] text-white'
                  : 'text-[#6b7183] hover:bg-[#efeadd]'
              }`}
              title="摸鱼五子棋"
            >
              <Grid3X3 size={14} />
            </button>
          )}

          <button
            onClick={() => onSelectTab('memory')}
            className={`p-1.5 rounded-full transition-colors cursor-pointer ${
              activeTab === 'memory'
                ? isWork
                  ? 'bg-blue-600 text-white'
                  : 'bg-[#a8681a] text-white'
                : isWork
                ? 'text-slate-400 hover:bg-slate-800'
                : 'text-[#6b7183] hover:bg-[#efeadd]'
            }`}
            title="双保险箱隔离记忆库"
          >
            <Brain size={14} />
          </button>

          <button
            onClick={onOpenSettings}
            className={`p-1.5 rounded-full transition-colors cursor-pointer ${
              isWork
                ? 'text-slate-400 hover:bg-slate-800'
                : 'text-[#6b7183] hover:bg-[#efeadd]'
            }`}
            title="设置与主权备份"
          >
            <Settings size={14} />
          </button>
        </div>
      )}

      <div className="px-1 drag-region cursor-move opacity-50 hover:opacity-100" title="按住拖拽窗口">
        <Move size={12} />
      </div>
    </div>
  );
};
