import React, { useState, useEffect } from 'react';
import { FloatingDock, MainTabType } from './components/FloatingDock';
import { ChatPill } from './components/ChatPill';
import { LivingCardsBoard } from './components/LivingCardsBoard';
import { ArtifactJournal } from './components/ArtifactJournal';
import { ArtifactGomoku } from './components/ArtifactGomoku';
import { MemoryTimeline } from './components/MemoryTimeline';
import { SettingsModal } from './components/SettingsModal';
import { StorageService } from './services/storage';
import { AiService } from './services/aiService';
import {
  Message,
  AppSettings,
  MemoryItem,
  JournalArtifact,
  StateMutationReceipt,
  WorkspaceMode,
} from './types';

export const App: React.FC = () => {
  const [mode, setMode] = useState<WorkspaceMode>(() => StorageService.getWorkspaceMode());
  const [settings, setSettings] = useState<AppSettings>(() => StorageService.getSettings());
  const [messages, setMessages] = useState<Message[]>(() =>
    StorageService.getMessages(StorageService.getWorkspaceMode())
  );
  const [memories, setMemories] = useState<MemoryItem[]>(() =>
    StorageService.getMemories(StorageService.getWorkspaceMode())
  );
  const [journals, setJournals] = useState<JournalArtifact[]>(() => StorageService.getJournals());

  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<MainTabType>('chat');
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [highlightedCard, setHighlightedCard] = useState<string | null>(null);
  const [companionToast, setCompanionToast] = useState<string | null>(null);

  useEffect(() => {
    StorageService.saveSettings(settings);
  }, [settings]);

  const showToast = (msg: string) => {
    setCompanionToast(msg);
    setTimeout(() => {
      setCompanionToast((prev) => (prev === msg ? null : prev));
    }, 3800);
  };

  const handleToggleMode = () => {
    const nextMode: WorkspaceMode = mode === 'life' ? 'work' : 'life';
    StorageService.saveWorkspaceMode(nextMode);
    setMode(nextMode);
    setMessages(StorageService.getMessages(nextMode));
    setMemories(StorageService.getMemories(nextMode));

    if (nextMode === 'work') {
      if (activeTab === 'gomoku') setActiveTab('chat');
      showToast('💼 已切换至【搞钱态】：独立商业记忆库与 3B 客户/死线看板已挂载');
    } else {
      const rpg = StorageService.getRpgStatusCard();
      if (rpg.energy < 60) {
        showToast('🌙 欢迎回到【生活态】！检测到你今天高强度搞钱完毕，今晚好好放松一下吧 ☕');
      } else {
        showToast('🌙 已切换至【生活态】：私人温情记忆库与 3C 生活手账已挂载');
      }
    }
  };

  const handleSendMessage = async (text: string, attachments?: string[]) => {
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    };

    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    StorageService.saveMessages(newHistory, mode);
    setIsLoading(true);

    try {
      const { reply, mutations } = await AiService.sendMessage(
        newHistory,
        settings,
        memories,
        mode
      );

      const assistantMsg: Message = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: reply,
        timestamp: Date.now(),
        mutations: mutations.length > 0 ? mutations : undefined,
      };

      const updatedMessages = [...newHistory, assistantMsg];
      setMessages(updatedMessages);
      StorageService.saveMessages(updatedMessages, mode);
      setMemories(StorageService.getMemories(mode));

      if (mutations.length > 0) {
        showToast(`⚡ 零填表引擎已自动更新 ${mutations.length} 项活体卡片数据`);
      }
    } catch {
      const fallbackMsg: Message = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: '哎呀，信号稍微打了个盹，不过我一直都在听你说呢 🐾',
        timestamp: Date.now(),
      };
      const updated = [...newHistory, fallbackMsg];
      setMessages(updated);
      StorageService.saveMessages(updated, mode);
    } finally {
      setIsLoading(false);
    }
  };

  const handleInspectMutation = (mutation: StateMutationReceipt) => {
    setActiveTab('cards');
    setHighlightedCard(mutation.targetCardType);
    setTimeout(() => {
      setHighlightedCard(null);
    }, 2600);
  };

  const handleDataImported = () => {
    const currentMode = StorageService.getWorkspaceMode();
    setMode(currentMode);
    setSettings(StorageService.getSettings());
    setMessages(StorageService.getMessages(currentMode));
    setMemories(StorageService.getMemories(currentMode));
    setJournals(StorageService.getJournals());
    showToast('✨ 全量双保险箱记忆与活体卡片数据已恢复');
  };

  const isWork = mode === 'work';

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-end p-4 select-none relative overflow-hidden">
      {/* Ambient Toast Bubble */}
      {companionToast && (
        <div
          className={`fixed top-4 z-50 max-w-sm px-4 py-2.5 rounded-2xl shadow-lg border text-xs font-medium animate-bounce ${
            isWork
              ? 'bg-slate-900/95 text-blue-300 border-blue-500/40'
              : 'bg-[#8a5410]/95 text-amber-50 border-amber-400/40'
          }`}
        >
          {companionToast}
        </div>
      )}

      {/* Main Expanded Panel */}
      {isExpanded && (
        <div className="w-full max-w-[400px] mb-3 transition-all duration-300 ease-out">
          {activeTab === 'chat' && (
            <ChatPill
              messages={messages}
              settings={settings}
              mode={mode}
              isLoading={isLoading}
              onSendMessage={handleSendMessage}
              onInspectMutation={handleInspectMutation}
              onOpenCards={() => setActiveTab('cards')}
            />
          )}

          {activeTab === 'cards' && (
            <LivingCardsBoard
              mode={mode}
              highlightedCard={highlightedCard}
              onCompanionToast={showToast}
            />
          )}

          {activeTab === 'journal' && (
            <ArtifactJournal
              journals={journals}
              messages={messages}
              settings={settings}
              onJournalsChange={(updated) => setJournals(updated)}
            />
          )}

          {activeTab === 'gomoku' && <ArtifactGomoku settings={settings} />}

          {activeTab === 'memory' && (
            <MemoryTimeline
              memories={memories}
              mode={mode}
              onMemoriesChange={(updated) => setMemories(updated)}
            />
          )}
        </div>
      )}

      {/* Bottom Floating Dock */}
      <FloatingDock
        settings={settings}
        mode={mode}
        isExpanded={isExpanded}
        activeTab={activeTab}
        onToggleExpand={() => setIsExpanded(!isExpanded)}
        onToggleMode={handleToggleMode}
        onSelectTab={(tab) => {
          setActiveTab(tab);
          setIsExpanded(true);
        }}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        settings={settings}
        onClose={() => setIsSettingsOpen(false)}
        onSaveSettings={(newSettings) => setSettings(newSettings)}
        onDataImported={handleDataImported}
      />
    </div>
  );
};

export default App;
