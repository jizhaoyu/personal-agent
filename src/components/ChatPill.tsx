import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  RefreshCw,
  Zap,
  ArrowUpRight,
} from 'lucide-react';
import { Message, AppSettings, WorkspaceMode, StateMutationReceipt } from '../types';
import { Character } from './Companion';

interface ChatPillProps {
  messages: Message[];
  settings: AppSettings;
  mode: WorkspaceMode;
  isLoading: boolean;
  onSendMessage: (text: string, attachments?: string[]) => void;
  onInspectMutation: (mutation: StateMutationReceipt) => void;
  onOpenCards: () => void;
}

export const ChatPill: React.FC<ChatPillProps> = ({
  messages,
  settings,
  mode,
  isLoading,
  onSendMessage,
  onInspectMutation,
  onOpenCards,
}) => {
  const [inputText, setInputText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const isWork = mode === 'work';

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleSend = () => {
    if (!inputText.trim() || isLoading) return;
    onSendMessage(inputText.trim());
    setInputText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      className={`flex flex-col h-full min-h-[420px] md:h-[460px] backdrop-blur-md border rounded-2xl shadow-float overflow-hidden transition-all duration-300 ${
        isWork
          ? 'bg-[#0f172a]/95 border-slate-700 text-slate-100'
          : 'bg-[#fcfaf5]/95 border-[#e5dec9] text-[#23293a]'
      }`}
    >
      {/* 极简顶栏（小宠物伴侣置于顶栏左侧） */}
      <div
        className={`flex items-center justify-between px-3.5 py-2 border-b ${
          isWork ? 'bg-slate-900/90 border-slate-800' : 'bg-[#f9f6ed] border-[#ece6d5]'
        }`}
      >
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full overflow-hidden bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
            <div className="scale-65 -translate-y-0.5 pointer-events-none">
              <Character state={isLoading ? 'thinking' : 'idle'} />
            </div>
          </div>
          <div>
            <div className="text-xs font-bold leading-tight">
              {isWork ? '💼 Looma Pro' : `🌙 ${settings.personaName || 'Looma'}`}
            </div>
            <div className="text-[10px] text-emerald-600 font-medium leading-tight">
              {isLoading ? '正在记录…' : '随口说，我在听'}
            </div>
          </div>
        </div>

        <button
          onClick={onOpenCards}
          className={`text-[11px] flex items-center gap-1 px-2.5 py-1 rounded-lg cursor-pointer transition-colors ${
            isWork
              ? 'bg-blue-600/20 text-blue-300 hover:bg-blue-600/30'
              : 'bg-[#efeadd] text-[#8a5410] hover:bg-[#e2d8c3]'
          }`}
        >
          <Zap size={11} />
          <span>查看卡片</span>
        </button>
      </div>

      {/* 消息与状态变更流 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3.5 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center space-y-3">
            <div className="w-16 h-16 rounded-full bg-amber-50 border border-amber-200/60 flex items-center justify-center shadow-xs overflow-hidden">
              <div className="scale-80 pointer-events-none">
                <Character state={isLoading ? 'thinking' : 'idle'} />
              </div>
            </div>
            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-[#3d2b1f]">随口说，无需刻意排版</h4>
              <p className="text-xs text-[#7c6248] max-w-xs leading-relaxed">
                例如：“我今天攒了30块钱”、“喝了3杯水”、“今天花了25吃午饭”、“妈妈不吃香菜”…
              </p>
            </div>
          </div>
        )}
        {messages.map((msg) => {
          const isUser = msg.role === 'user';
          return (
            <div
              key={msg.id}
              className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-full`}
            >
              <div
                className={`px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed break-words max-w-[88%] ${
                  isUser
                    ? isWork
                      ? 'bg-blue-600 text-white rounded-tr-xs shadow-sm'
                      : 'bg-[#a8681a] text-white rounded-tr-xs shadow-sm'
                    : isWork
                    ? 'bg-slate-800/90 text-slate-100 border border-slate-700 rounded-tl-xs'
                    : 'bg-[#efeadd] text-[#23293a] border border-[#e2d8c3] rounded-tl-xs'
                }`}
              >
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {msg.attachments.map((att, idx) => (
                      <img
                        key={idx}
                        src={att}
                        alt="attachment"
                        className="rounded-lg max-h-36 w-auto object-cover"
                      />
                    ))}
                  </div>
                )}
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>

              {msg.mutations && msg.mutations.length > 0 && (
                <div className="mt-1.5 space-y-1 w-[88%]">
                  {msg.mutations.map((mut) => (
                    <button
                      key={mut.id}
                      onClick={() => onInspectMutation(mut)}
                      className={`w-full text-left px-2.5 py-1.5 rounded-xl border text-[11px] flex items-center justify-between gap-2 transition-all cursor-pointer shadow-xs ${
                        isWork
                          ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300 hover:bg-emerald-900/70'
                          : 'bg-amber-50 border-amber-300/80 text-[#8a5410] hover:bg-amber-100/80'
                      }`}
                    >
                      <span className="truncate font-medium">{mut.summaryText}</span>
                      <span className="shrink-0 flex items-center gap-0.5 font-mono font-bold text-[10px] px-1.5 py-0.5 rounded bg-black/10">
                        {mut.deltaBadge}
                        <ArrowUpRight size={11} />
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <span className="text-[10px] opacity-50 mt-1 px-1">
                {new Date(msg.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
          );
        })}

        {isLoading && (
          <div
            className={`flex items-center gap-2 text-xs px-3 py-2 rounded-2xl w-fit ${
              isWork ? 'bg-slate-800 text-blue-400' : 'bg-[#efeadd] text-[#8a5410]'
            }`}
          >
            <RefreshCw size={12} className="animate-spin" />
            <span>记录中…</span>
          </div>
        )}
      </div>

      {/* 输入框 */}
      <div
        className={`p-2.5 border-t flex items-end gap-2 ${
          isWork ? 'bg-slate-900 border-slate-800' : 'bg-[#f9f6ed] border-[#ece6d5]'
        }`}
      >
        <div
          className={`flex-1 rounded-xl border px-3 py-1.5 flex items-center transition-all ${
            isWork
              ? 'bg-slate-800 border-slate-700 focus-within:border-blue-500'
              : 'bg-white border-[#ded5be] focus-within:border-[#a8681a]'
          }`}
        >
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="随手记录…"
            rows={1}
            className={`w-full resize-none text-[12.5px] bg-transparent focus:outline-none max-h-20 leading-5 ${
              isWork
                ? 'text-slate-100 placeholder:text-slate-500'
                : 'text-[#23293a] placeholder:text-[#a49f91]'
            }`}
          />
        </div>

        <button
          onClick={handleSend}
          disabled={isLoading || !inputText.trim()}
          aria-label="发送文字记录"
          className={`p-2 rounded-xl text-white disabled:opacity-40 transition-colors shadow-xs cursor-pointer ${
            isWork ? 'bg-blue-600 hover:bg-blue-500' : 'bg-[#a8681a] hover:bg-[#8a5410]'
          }`}
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
};
