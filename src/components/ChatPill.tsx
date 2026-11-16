import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  RefreshCw,
  Zap,
  ArrowUpRight,
  ListTodo,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import type { Message, AppSettings, WorkspaceMode, StateMutationReceipt, TodoRecord } from '../types';
import { useI18n, type I18nKey } from '../i18n';
import { Character } from './Companion';

interface ChatPillProps {
  messages: Message[];
  settings: AppSettings;
  mode: WorkspaceMode;
  isLoading: boolean;
  onSendMessage: (text: string, attachments?: string[]) => void | Promise<void>;
  draftText?: string;
  onDraftTextChange?: (text: string, expectedText?: string) => void;
  onInspectMutation: (mutation: StateMutationReceipt) => void;
  onOpenCards: () => void;
  pendingTodo?: TodoRecord | null;
  onApproveTodo?: (todo: TodoRecord) => Promise<void> | void;
  onDismissPendingTodo?: () => void;
  onOpenTodos?: () => void;
}

function parseLocalDateTimeMs(raw: string): number {
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || '0');
  const dt = new Date(year, month - 1, day, hour, minute, second);
  if (
    dt.getFullYear() !== year
    || dt.getMonth() !== month - 1
    || dt.getDate() !== day
    || dt.getHours() !== hour
    || dt.getMinutes() !== minute
  ) {
    return NaN;
  }
  return dt.getTime();
}

export const ChatPill: React.FC<ChatPillProps> = ({
  messages,
  settings,
  mode,
  isLoading,
  onSendMessage,
  draftText,
  onDraftTextChange,
  onInspectMutation,
  onOpenCards,
  pendingTodo,
  onApproveTodo,
  onDismissPendingTodo,
  onOpenTodos,
}) => {
  const { lang, t } = useI18n();
  const tr = (key: string, fallback: { zh: string; en: string }, params?: Record<string, string | number>): string => {
    const resolved = t(key as I18nKey, params);
    if (resolved !== key) return resolved;
    const tpl = lang === 'en' ? fallback.en : fallback.zh;
    if (!params) return tpl;
    return tpl.replace(/\{([A-Za-z0-9_]+)\}/g, (_, token) =>
      Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : `{${token}}`,
    );
  };

  const [localInput, setLocalInput] = useState('');
  const [todoConfirmed, setTodoConfirmed] = useState(false);
  const [todoFading, setTodoFading] = useState(false);
  const [todoBusy, setTodoBusy] = useState(false);
  const [quickDueAt, setQuickDueAt] = useState('');
  const [todoTimeError, setTodoTimeError] = useState('');

  const inputText = draftText ?? localInput;
  const latestInput = useRef(inputText);
  latestInput.current = inputText;
  const sending = useRef(false);
  const composing = useRef(false);
  const mountedRef = useRef(true);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTodoIdRef = useRef<string | undefined>(pendingTodo?.id);

  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState('');

  const setInputText = (value: string, expectedText?: string) => {
    latestInput.current = value;
    if (onDraftTextChange) onDraftTextChange(value, expectedText);
    else setLocalInput(value);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);
  const forceScrollBottomRef = useRef(false);
  const prevMsgCountRef = useRef(messages.length);
  const prevLoadingRef = useRef(isLoading);

  const isWork = mode === 'work';

  const clearTodoTimers = () => {
    if (fadeTimerRef.current !== null) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTodoTimers();
    };
  }, []);

  useEffect(() => {
    clearTodoTimers();
    activeTodoIdRef.current = pendingTodo?.id;
    setTodoConfirmed(false);
    setTodoFading(false);
    setTodoBusy(false);
    setQuickDueAt('');
    setTodoTimeError('');
    return clearTodoTimers;
  }, [pendingTodo?.id]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof el.style !== 'object') return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) {
      const nextHeight = Math.min(Math.max(el.scrollHeight, 24), 120);
      el.style.height = `${nextHeight}px`;
      el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden';
    }
  }, [inputText]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hasNewMessage = messages.length > prevMsgCountRef.current;
    const startedLoading = isLoading && !prevLoadingRef.current;
    prevMsgCountRef.current = messages.length;
    prevLoadingRef.current = isLoading;

    if (forceScrollBottomRef.current || ((hasNewMessage || startedLoading) && isNearBottomRef.current)) {
      forceScrollBottomRef.current = false;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleFeedScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };

  const handleConfirmTodo = async () => {
    if (!pendingTodo || todoBusy) return;
    const targetId = pendingTodo.id;
    let todoToApprove: TodoRecord = pendingTodo;

    if (pendingTodo.needsTime && quickDueAt.trim()) {
      const ms = parseLocalDateTimeMs(quickDueAt);
      if (!Number.isFinite(ms) || ms <= Date.now()) {
        setTodoTimeError(tr('lifeChat.todoTimePastError', {
          zh: '请选择未来的日期和时间',
          en: 'Pick a future date and time',
        }));
        return;
      }
      todoToApprove = {
        ...pendingTodo,
        dueAt: new Date(ms).toISOString(),
        needsTime: false,
      };
    }

    setTodoTimeError('');
    setTodoBusy(true);
    try {
      if (onApproveTodo) await onApproveTodo(todoToApprove);
      if (!mountedRef.current || activeTodoIdRef.current !== targetId) return;
      clearTodoTimers();
      setTodoConfirmed(true);
      fadeTimerRef.current = setTimeout(() => {
        if (mountedRef.current && activeTodoIdRef.current === targetId) {
          setTodoFading(true);
        }
      }, 400);
      dismissTimerRef.current = setTimeout(() => {
        if (mountedRef.current && activeTodoIdRef.current === targetId) {
          onDismissPendingTodo?.();
        }
      }, 1200);
    } catch {
      if (mountedRef.current && activeTodoIdRef.current === targetId) {
        setTodoBusy(false);
      }
    }
  };

  const handleDismissTodo = () => {
    const targetId = pendingTodo?.id;
    clearTodoTimers();
    setTodoFading(true);
    dismissTimerRef.current = setTimeout(() => {
      if (mountedRef.current && activeTodoIdRef.current === targetId) {
        onDismissPendingTodo?.();
      }
    }, 350);
  };

  const handleSend = async () => {
    if (!inputText.trim() || isLoading || sending.current || composing.current) return;
    const original = inputText;
    forceScrollBottomRef.current = true;
    sending.current = true;
    setSendPending(true);
    setSendError('');
    try {
      await onSendMessage(original.trim());
      if (latestInput.current === original) setInputText('', original);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error) || t('lifeChat.saveErrorFallback'));
    } finally {
      sending.current = false;
      setSendPending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (composing.current || e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229) return;
    if (pendingTodo && !todoConfirmed && !todoFading && e.key === 'Escape') {
      e.preventDefault();
      handleDismissTodo();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleExamplePick = (sample: string) => {
    setInputText(sample);
    textareaRef.current?.focus();
  };

  const examplePills = [
    tr('lifeChat.examplePillExpense', { zh: '今天花了35吃午饭', en: 'Spent 35 on lunch today' }),
    tr('lifeChat.examplePillSaving', { zh: '今天攒了200块', en: 'Saved 200 today' }),
    tr('lifeChat.examplePillTodo', { zh: '明天下午3点提醒我取快递', en: 'Remind me tomorrow at 3 PM to pick up package' }),
    tr('lifeChat.examplePillPerson', { zh: '妈妈不吃香菜', en: 'Mom dislikes cilantro' }),
  ];

  return (
    <div className="flex flex-col h-full min-h-[280px] md:h-[460px] bg-[var(--surface-card)] border border-[var(--line-hairline)] text-[var(--ink-primary)] rounded-2xl shadow-sm overflow-hidden transition-colors duration-200">
      {/* 极简顶栏（小宠物伴侣置于顶栏左侧） */}
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-[var(--line-hairline)] bg-[var(--surface-subtle)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-full overflow-hidden bg-[var(--accent-soft)] border border-[var(--accent-border)] flex items-center justify-center shrink-0">
            <div className="scale-65 -translate-y-0.5 pointer-events-none">
              <Character state={isLoading ? 'thinking' : 'idle'} />
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-xs font-bold leading-tight text-[var(--ink-primary)] truncate">
              {isWork
                ? tr('lifeChat.workModeTitle', { zh: '💼 Looma 工作助手', en: '💼 Looma Work' })
                : `🌙 ${settings.personaName || 'Looma'}`}
            </div>
            <div className="text-xs text-[var(--accent-primary)] font-medium leading-tight">
              {isLoading ? t('lifeChat.statusRecording') : t('lifeChat.statusListening')}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenCards}
          className="min-h-[var(--touch-target-min,34px)] text-xs font-medium flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--surface-card)] border border-[var(--line-hairline)] text-[var(--accent-primary)] hover:bg-[var(--surface-hover)] cursor-pointer transition-colors shrink-0"
        >
          <Zap size={12} />
          <span>{t('lifeChat.viewCards')}</span>
        </button>
      </div>

      {/* 消息与状态变更流 */}
      <div
        ref={scrollRef}
        onScroll={handleFeedScroll}
        className="flex-1 overflow-y-auto p-3.5 space-y-3"
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-6 px-3 text-center space-y-3">
            <div className="w-16 h-16 rounded-full bg-[var(--accent-soft)] border border-[var(--accent-border)] flex items-center justify-center overflow-hidden">
              <div className="scale-80 pointer-events-none">
                <Character state={isLoading ? 'thinking' : 'idle'} />
              </div>
            </div>
            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-[var(--ink-primary)]">{t('lifeChat.emptyTitle')}</h4>
              <p className="text-xs text-[var(--ink-muted)] max-w-xs leading-relaxed">
                {t('lifeChat.emptyExample')}
              </p>
            </div>
            <div
              className="flex flex-wrap items-center justify-center gap-1.5 pt-1 max-w-sm"
              aria-label={tr('lifeChat.examplesAria', { zh: '试试这样说', en: 'Try saying' })}
            >
              {examplePills.map((sample) => (
                <button
                  key={sample}
                  type="button"
                  onClick={() => handleExamplePick(sample)}
                  className="min-h-[var(--touch-target-min,34px)] px-3 py-1 rounded-full border border-[var(--accent-border)] bg-[var(--accent-soft)] text-xs font-medium text-[var(--accent-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
                >
                  {sample}
                </button>
              ))}
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
                    ? 'bg-[var(--accent-primary)] text-[#FFFCF6] rounded-tr-xs'
                    : 'bg-[var(--surface-subtle)] text-[var(--ink-primary)] border border-[var(--line-hairline)] rounded-tl-xs'
                }`}
              >
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {msg.attachments.map((att, idx) => (
                      <img
                        key={idx}
                        src={att}
                        alt={tr('lifeChat.attachmentLabel', { zh: '图片附件', en: 'Image attachment' })}
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
                      type="button"
                      key={mut.id}
                      onClick={() => onInspectMutation(mut)}
                      className="w-full text-left min-h-[var(--touch-target-min,34px)] px-2.5 py-1.5 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)] text-xs text-[var(--accent-primary)] hover:bg-[var(--surface-hover)] flex items-center justify-between gap-2 transition-colors cursor-pointer"
                    >
                      <span className="truncate font-medium">{mut.summaryText}</span>
                      <span className="shrink-0 flex items-center gap-0.5 font-mono font-bold text-xs px-1.5 py-0.5 rounded bg-[var(--surface-card)] border border-[var(--line-hairline)] tabular-nums">
                        {mut.deltaBadge}
                        <ArrowUpRight size={12} />
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <span className="text-xs text-[var(--ink-muted)] mt-1 px-1 tabular-nums">
                {new Date(msg.timestamp).toLocaleTimeString(lang === 'en' ? 'en-US' : undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
          );
        })}

        {isLoading && (
          <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-2xl w-fit bg-[var(--surface-subtle)] text-[var(--accent-primary)] border border-[var(--line-hairline)]">
            <RefreshCw size={12} className="animate-spin" />
            <span>{t('lifeChat.loadingBubble')}</span>
          </div>
        )}
      </div>

      {sendError && (
        <p
          className="px-3.5 py-1.5 text-xs text-[var(--danger-ink)] bg-[var(--danger-soft)] border-t border-[var(--danger-line)]"
          role="alert"
        >
          {sendError}
        </p>
      )}

      {/* 识别到待办动作时的胶囊浮窗 */}
      {pendingTodo && (
        <div
          className={`mx-3 mb-2 p-2.5 rounded-xl border border-[var(--accent-border)] bg-[var(--surface-card)] text-[var(--ink-primary)] shadow-sm transition-all duration-300 ease-out flex flex-col gap-2 ${
            todoFading ? 'opacity-0 -translate-y-2 pointer-events-none scale-95' : 'opacity-100 translate-y-0 scale-100'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-[var(--accent-soft)] text-[var(--accent-primary)]">
                {todoConfirmed ? <CheckCircle2 size={16} /> : <ListTodo size={15} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-bold text-[var(--accent-primary)]">{t('lifeChat.todoCapsuleTitle')}</span>
                  {pendingTodo.dueAt ? (
                    <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-primary)] tabular-nums">
                      {new Date(pendingTodo.dueAt).toLocaleTimeString(lang === 'en' ? 'en-US' : undefined, { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  ) : pendingTodo.dueDate ? (
                    <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-primary)] tabular-nums">
                      {pendingTodo.dueDate}
                    </span>
                  ) : (
                    <span className="text-xs text-[var(--ink-muted)]">{t('lifeChat.todoTimeTbd')}</span>
                  )}
                  {!todoConfirmed && (
                    <span className="hidden sm:inline-block text-xs font-mono text-[var(--ink-muted)] bg-[var(--surface-subtle)] px-1.5 py-0.5 rounded">
                      {tr('lifeChat.todoEscHint', { zh: 'Esc 忽略', en: 'Esc Dismiss' })}
                    </span>
                  )}
                </div>
                <p className="text-xs font-semibold truncate mt-0.5 text-[var(--ink-primary)]">{pendingTodo.title}</p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {todoConfirmed ? (
                <span className="text-xs font-semibold text-[var(--accent-primary)] px-2 py-1 flex items-center gap-1">
                  <CheckCircle2 size={13} /> {t('lifeChat.todoRecorded')}
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleConfirmTodo}
                    disabled={todoBusy}
                    className="min-h-[var(--touch-target-min,34px)] px-3 py-1 rounded-lg bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-[#FFFCF6] text-xs font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    <CheckCircle2 size={13} />
                    <span>{t('lifeChat.confirmBtn')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDismissTodo}
                    className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg text-xs text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] cursor-pointer transition-colors"
                  >
                    {t('lifeChat.dismissBtn')}
                  </button>
                </>
              )}
              {onOpenTodos && (
                <button
                  type="button"
                  onClick={onOpenTodos}
                  className="min-h-[var(--touch-target-min,34px)] text-xs font-medium text-[var(--accent-primary)] hover:underline px-1.5 cursor-pointer"
                  title={t('lifeChat.openTodosTitle')}
                >
                  {t('lifeChat.openTodosBtn')}
                </button>
              )}
            </div>
          </div>

          {pendingTodo.needsTime && !todoConfirmed && (
            <div className="flex flex-wrap items-center gap-2 pt-1.5 border-t border-[var(--line-hairline)]">
              <span className="inline-flex items-center gap-1 text-xs text-[var(--ink-muted)]">
                <Clock size={12} aria-hidden="true" />
                {tr('lifeChat.todoQuickTimeLabel', { zh: '可选补充时间：', en: 'Optional time:' })}
              </span>
              <input
                type="datetime-local"
                aria-label={tr('lifeChat.todoQuickTimeAria', { zh: '补充提醒时间', en: 'Reminder date and time' })}
                value={quickDueAt}
                onChange={(e) => {
                  setQuickDueAt(e.target.value);
                  if (todoTimeError) setTodoTimeError('');
                }}
                className="w-auto min-h-[var(--touch-target-min,34px)] rounded-lg border border-[var(--line-hairline)] bg-[var(--bg-paper)] px-2 py-1 text-xs text-[var(--ink-primary)] tabular-nums"
              />
              {todoTimeError && (
                <span className="text-xs text-[var(--danger-ink)]" role="alert">{todoTimeError}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 输入框 */}
      <div className="px-2.5 pt-2 pb-2.5 shrink-0 border-t border-[var(--line-hairline)] bg-[var(--surface-subtle)] flex flex-col gap-1">
        <div className="flex items-end gap-2">
          <div className="flex-1 rounded-xl border border-[var(--line-hairline)] bg-[var(--surface-card)] focus-within:border-[var(--accent-primary)] focus-within:ring-2 focus-within:ring-[var(--focus-ring)]/25 px-3 py-2 flex items-center transition-colors">
            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={(e) => {
                const target = e.currentTarget;
                const scroller = scrollRef.current;
                if (scroller && isNearBottomRef.current) {
                  if (typeof scroller.scrollTo === 'function') {
                    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
                  } else {
                    scroller.scrollTop = scroller.scrollHeight;
                  }
                }
                if (typeof requestAnimationFrame === 'function') {
                  requestAnimationFrame(() => target?.scrollIntoView?.({ block: 'nearest' }));
                }
              }}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; }}
              placeholder={t('lifeChat.inputPlaceholder')}
              aria-describedby="life-chat-kbd-hint"
              rows={1}
              style={{
                fontSize: 'var(--input-font-size, 13.5px)',
                border: 0,
                padding: 0,
                background: 'transparent',
                outline: 'none',
              }}
              className="w-full resize-none min-h-[24px] max-h-[120px] leading-6 bg-transparent text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] focus:outline-none"
            />
          </div>

          <button
            type="button"
            onClick={handleSend}
            disabled={isLoading || sendPending || !inputText.trim()}
            aria-label={t('lifeChat.sendAria')}
            className="min-h-[var(--touch-target-min,34px)] min-w-[var(--touch-target-min,34px)] p-2 rounded-xl bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-[#FFFCF6] disabled:opacity-40 transition-colors cursor-pointer flex items-center justify-center shrink-0"
          >
            <Send size={15} />
          </button>
        </div>
        <span id="life-chat-kbd-hint" className="hidden sm:block text-xs text-[var(--ink-muted)] px-1">
          {tr('lifeChat.keyboardHint', { zh: 'Enter 发送 · Shift+Enter 换行', en: 'Enter to send · Shift+Enter for newline' })}
        </span>
      </div>
    </div>
  );
};
