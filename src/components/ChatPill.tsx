import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  RefreshCw,
  ShieldCheck,
  Zap,
  ArrowUpRight,
} from 'lucide-react';
import { Message, AppSettings, WorkspaceMode, StateMutationReceipt } from '../types';

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
      className={`flex flex-col h-[460px] backdrop-blur-md border rounded-2xl shadow-float overflow-hidden transition-all duration-300 ${
        isWork
          ? 'bg-[#0f172a]/95 border-slate-700 text-slate-100'
          : 'bg-[#fcfaf5]/95 border-[#e5dec9] text-[#23293a]'
      }`}
    >
      {/* 顶栏：当前本地逻辑分区 */}
      <div
        className={`flex items-center justify-between px-3.5 py-2.5 border-b ${
          isWork ? 'bg-slate-900/90 border-slate-800' : 'bg-[#f9f6ed] border-[#ece6d5]'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold">
            {isWork ? '💼 首席商务幕僚 · Looma Pro' : `🌙 ${settings.personaName || 'Looma'}`}
          </span>
          {isWork ? (
            <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              <ShieldCheck size={11} />
              <span>工作本地分区</span>
            </span>
          ) : (
            <span className="text-[10px] text-[#8a5410] bg-[#f2ecdc] px-2 py-0.5 rounded-full">
              生活本地分区
            </span>
          )}
        </div>

        <button
          onClick={onOpenCards}
          className={`text-[11px] flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer transition-colors ${
            isWork
              ? 'bg-blue-600/20 text-blue-300 hover:bg-blue-600/30'
              : 'bg-[#efeadd] text-[#8a5410] hover:bg-[#e2d8c3]'
          }`}
        >
          <Zap size={11} />
          <span>看活体卡</span>
        </button>
      </div>

      {/* 消息与活体变更徽章流 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3.5 space-y-3">
        {messages.length === 0 && (
          <p className="text-xs leading-relaxed text-[#6b7183] py-4">
            这里记录你主动输入的生活文字。可尝试记录账单、饮水和体重，请核对整理结果。
          </p>
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

              {/* ⚡ Talk-to-Live-State 状态自动更新微徽章 */}
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
            <span>正在整理文字记录...</span>
          </div>
        )}
      </div>

      {/* 底部：一秒体验魔法演示胶囊（随双态切换） */}
      <div
        className={`px-2.5 py-1.5 border-t flex items-center gap-1.5 overflow-x-auto text-[11px] no-drag ${
          isWork ? 'bg-slate-900/80 border-slate-800' : 'bg-[#f5f1e6] border-[#ece6d5]'
        }`}
      >
        {!isWork ? (
          <>
            <button
              onClick={() => setInputText('午饭吃了42元，顺便喝了一杯水，今天体重64.1kg')}
              className="whitespace-nowrap px-2.5 py-1 rounded-full bg-[#fcfaf5] border border-[#e2d8c3] text-[#8a5410] hover:border-[#a8681a] cursor-pointer"
            >
              ✨ 填入示例：记账与体重
            </button>
            <button
              onClick={() => setInputText('记一下，王叔对花生过敏，喜欢喝龙井茶')}
              className="whitespace-nowrap px-2.5 py-1 rounded-full bg-[#fcfaf5] border border-[#e2d8c3] text-[#6b7183] hover:text-[#8a5410] cursor-pointer"
            >
              ❤️ 填入示例：亲友忌口
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() =>
                setInputText(
                  '刚见完远景科技王总，预算26万，痛点是跨部门数据割裂，下周三前要完成定制方案汇报'
                )
              }
              className="whitespace-nowrap px-2.5 py-1 rounded-full bg-slate-800 border border-blue-500/40 text-blue-300 hover:bg-slate-700 cursor-pointer"
            >
              💼 填入客户跟进示例
            </button>
            <button
              onClick={() => setInputText('星辰科技李总把预算加到22万了，进入商务谈判阶段')}
              className="whitespace-nowrap px-2.5 py-1 rounded-full bg-slate-800 border border-slate-700 text-slate-300 hover:text-white cursor-pointer"
            >
              📈 填入预算变更示例
            </button>
          </>
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
            placeholder={
              isWork
                ? '输入客户跟进、预算变更或待办文字...'
                : '输入花销、体重、饮水或亲友备忘文字...'
            }
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
