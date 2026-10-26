import React, { useRef, useState } from 'react';
import { BookOpen, Download, Sparkles, RefreshCw, Calendar, Heart, Share2 } from 'lucide-react';
import html2canvas from 'html2canvas';
import { JournalArtifact, Message, AppSettings } from '../types';
import { AiService } from '../services/aiService';
import { StorageService } from '../services/storage';

interface ArtifactJournalProps {
  journals: JournalArtifact[];
  messages: Message[];
  settings: AppSettings;
  onJournalsChange: (journals: JournalArtifact[]) => void;
}

export const ArtifactJournal: React.FC<ArtifactJournalProps> = ({
  journals,
  messages,
  settings,
  onJournalsChange,
}) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [selectedJournal, setSelectedJournal] = useState<JournalArtifact>(
    journals[0] || {
      id: 'default',
      date: new Date().toISOString().slice(0, 10),
      title: '生活闲笔',
      mood: '☕ 温暖惬意',
      userGoldenQuote: '今天在窗边看落日，感觉时间突然慢下来了。',
      aiReflection: '生活本就由这些细碎的闪光组成。很开心能在这个桌面上陪你度过又一个平静的傍晚。',
      stickers: ['🌅', '✨', '☕'],
      createdAt: Date.now(),
    }
  );

  // 一键生成今日新手帐
  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const newJournal = await AiService.generateDailyJournal(messages, settings);
      StorageService.addJournal(newJournal);
      const updated = StorageService.getJournals();
      onJournalsChange(updated);
      setSelectedJournal(newJournal);
    } catch (err) {
      console.error(err);
    } finally {
      setIsGenerating(false);
    }
  };

  // 导出为精美图片（可分享至社交平台）
  const handleExportImage = async () => {
    if (!cardRef.current) return;
    try {
      const canvas = await html2canvas(cardRef.current, {
        scale: 2,
        backgroundColor: '#f7f4ec',
        useCORS: true,
      });
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = `Ambi生活手帐-${selectedJournal.date}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error('导出图片失败:', err);
    }
  };

  return (
    <div className="flex flex-col h-[460px] bg-[#fcfaf5]/95 backdrop-blur-md border border-[#e5dec9] rounded-2xl shadow-float overflow-hidden">
      {/* 顶部操作条 */}
      <div className="px-4 py-2.5 border-b border-[#ece6d5] bg-[#f9f6ed] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen size={16} className="text-[#a8681a]" />
          <h3 className="text-sm font-semibold text-[#23293a]">双人生活手帐</h3>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg bg-[#efeadd] hover:bg-[#e2d8c3] text-[#8a5410] transition-colors disabled:opacity-50"
            title="提取近期对话自动生成今日手帐"
          >
            <RefreshCw size={12} className={isGenerating ? 'animate-spin' : ''} />
            <span>生成今日</span>
          </button>

          <button
            onClick={handleExportImage}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg bg-[#a8681a] hover:bg-[#8a5410] text-white transition-colors"
            title="保存为高清图片"
          >
            <Download size={12} />
            <span>存图</span>
          </button>
        </div>
      </div>

      {/* 手帐预览主体区（拍立得纸张手帐感） */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col items-center justify-center">
        <div
          ref={cardRef}
          className="w-full max-w-[320px] bg-[#fffefc] border-2 border-[#e6decd] rounded-xl p-5 shadow-sm text-[#23293a] space-y-4 relative"
        >
          {/* 胶带纸拟物装饰条 */}
          <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-20 h-4 bg-[#f3ecd9]/80 border-t border-b border-[#ded2b8] rotate-1" />

          {/* 日期与心情 */}
          <div className="flex items-center justify-between text-xs text-[#8a5410] pt-1">
            <span className="font-mono flex items-center gap-1">
              <Calendar size={12} />
              {selectedJournal.date}
            </span>
            <span className="px-2 py-0.5 rounded-full bg-[#f6f1e3] border border-[#e8dfcb]">
              {selectedJournal.mood}
            </span>
          </div>

          {/* 标题 */}
          <h4 className="text-base font-bold text-[#23293a] border-b border-[#ece6d5] pb-2 text-center">
            {selectedJournal.title}
          </h4>

          {/* 用户金句卡片 */}
          <div className="p-3 bg-[#fbf9f4] rounded-lg border-l-3 border-[#a8681a] text-xs leading-relaxed text-[#444a59] italic">
            “{selectedJournal.userGoldenQuote}”
          </div>

          {/* AI 伴侣手记 */}
          <div className="space-y-1 text-xs leading-relaxed text-[#4d5363] px-1">
            <p className="font-semibold text-[#8a5410] flex items-center gap-1 text-[11px]">
              <Sparkles size={11} /> {settings.personaName || 'Ambi'} 寄语：
            </p>
            <p>{selectedJournal.aiReflection}</p>
          </div>

          {/* 贴纸展示与页脚署名 */}
          <div className="pt-2 border-t border-[#ece6d5] flex items-center justify-between text-xs text-[#a49f91]">
            <div className="flex gap-1.5 text-base select-none">
              {selectedJournal.stickers.map((stk, i) => (
                <span key={i}>{stk}</span>
              ))}
            </div>
            <span className="text-[10px] font-mono">Ambi Companion #01</span>
          </div>
        </div>
      </div>

      {/* 历史手帐卡片选择栏 */}
      {journals.length > 1 && (
        <div className="px-3 py-2 bg-[#f9f6ed] border-t border-[#ece6d5] flex items-center gap-2 overflow-x-auto text-xs">
          <span className="text-[#a49f91] text-[10px] shrink-0">往期手帐：</span>
          {journals.map((j) => (
            <button
              key={j.id}
              onClick={() => setSelectedJournal(j)}
              className={`px-2 py-1 rounded-md text-[11px] whitespace-nowrap border transition-all ${
                selectedJournal.id === j.id
                  ? 'bg-[#a8681a] text-white border-[#a8681a]'
                  : 'bg-white text-[#6b7183] border-[#e2d8c3] hover:border-[#a8681a]'
              }`}
            >
              {j.date.slice(5)} {j.title.slice(0, 4)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
