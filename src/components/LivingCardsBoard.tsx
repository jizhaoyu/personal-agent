import React, { useState, useRef } from 'react';
import {
  Wallet,
  Users,
  Briefcase,
  Target,
  FileCheck,
  Plus,
  CheckCircle2,
  Circle,
  Download,
  ShieldCheck,
  Sparkles,
  Trash2,
  ArrowRight,
  Lock,
  Pencil,
  Star,
} from 'lucide-react';
import {
  WorkspaceMode,
  WalletCardState,
  WishItem,
  PersonProfile,
  CrmDealItem,
  ProjectTaskItem,
  CustomLivingCard,
  DealStage,
} from '../types';
import { StorageService } from '../services/storage';
import { Repository } from '../persistence/repository';
import { formatBudgetAmount, formatDealStage, formatExpenseCategory, useI18n } from '../i18n';

interface LivingCardsBoardProps {
  mode: WorkspaceMode;
  highlightedCard?: string | null;
  onCompanionToast: (msg: string) => void;
}

const STAGES: DealStage[] = ['初步接触', '需求确认', '方案报价', '商务谈判', '赢单成交'];

const monthFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
});
const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });

export function normalizeWallet(w: WalletCardState): WalletCardState {
  const wishes: WishItem[] = (w.wishes && w.wishes.length > 0) ? w.wishes : [
    {
      id: 'wish-default',
      title: w.wishTitle || '我的心愿',
      targetAmount: w.wishTarget || 10000,
      savedAmount: w.wishSaved || 0,
      group: '品质生活',
      isPrimary: true,
      createdAt: Date.now(),
    }
  ];
  const activeWishId = w.activeWishId || wishes.find(item => item.isPrimary)?.id || wishes[0].id;
  const activeWish = wishes.find(item => item.id === activeWishId) || wishes[0];
  return {
    ...w,
    wishTitle: activeWish.title,
    wishTarget: activeWish.targetAmount,
    wishes,
    activeWishId,
  };
}

export function monthlyExpenseTotal(entries: WalletCardState['entries'], now = Date.now()): number {
  const month = monthFormatter.format(now);
  return entries.filter(entry => entry.type === 'expense' && Number.isFinite(entry.timestamp) &&
    monthFormatter.format(entry.timestamp) === month).reduce((sum, entry) => sum + entry.amount, 0);
}

export function boundedProgress(value: number, target: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(target) || target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(value / target * 100)));
}

export const LivingCardsBoard: React.FC<LivingCardsBoardProps> = ({
  mode,
  highlightedCard,
  onCompanionToast,
}) => {
  const { lang, t } = useI18n();
  const cachedPartition = Repository.getCurrent().partitions[mode];
  const cachedLife = mode === 'life' ? Repository.getCurrent().partitions.life : null;
  // Only the current space is read. The repository cache contains a bounded, already migrated window.
  const [wallet, setWallet] = useState<WalletCardState>(() => normalizeWallet(cachedLife?.wallet || { monthlyBudget: 5000, wishTitle: '我的心愿', wishTarget: 10000, wishSaved: 0, entries: [] }));
  const [persons, setPersons] = useState<PersonProfile[]>(() => cachedLife?.persons || []);

  // ToB 状态
  const [deals, setDeals] = useState<CrmDealItem[]>(() => mode === 'work' ? StorageService.getCrmDeals() : []);
  const [tasks, setTasks] = useState<ProjectTaskItem[]>(() => mode === 'work' ? StorageService.getProjectTasks() : []);
  const [selectedDealForPoster, setSelectedDealForPoster] = useState<CrmDealItem | null>(null);

  // 自定义卡（极简每日打卡卡归属独立「打卡」面板展示）
  const [customCards, setCustomCards] = useState<CustomLivingCard[]>(() =>
    cachedPartition.customCards.filter(c => c.cardKind !== 'checkin')
  );
  const [activeSubTab, setActiveSubTab] = useState<string>(
    mode === 'work' ? 'crm' : 'wallet'
  );

  const posterRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const activeModeRef = useRef(mode);
  const savingRef = useRef(false);
  activeModeRef.current = mode;

  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  React.useEffect(() => {
    const syncCurrentSpace = () => {
      if (!mountedRef.current || activeModeRef.current !== mode) return;
      const partition = Repository.getCurrent().partitions[mode];
      setCustomCards(partition.customCards.filter(c => c.cardKind !== 'checkin'));
      if (mode === 'life') {
        const life = Repository.getCurrent().partitions.life;
        setWallet(normalizeWallet(life.wallet));
        setPersons(life.persons);
      }
    };
    syncCurrentSpace();
    if (highlightedCard) {
      setActiveSubTab(highlightedCard);
    } else {
      setActiveSubTab(mode === 'work' ? 'crm' : 'wallet');
    }
    return Repository.subscribe(syncCurrentSpace);
  }, [mode, highlightedCard]);

  const persistUpdate = async (save: () => void | Promise<void>, update: () => void, success: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    const sourceMode = mode;
    try {
      await save();
      if (!mountedRef.current || activeModeRef.current !== sourceMode) return;
      update();
      onCompanionToast(success);
    } catch {
      if (mountedRef.current && activeModeRef.current === sourceMode) {
        onCompanionToast(t('cards.saveFailedToast'));
      }
    } finally {
      savingRef.current = false;
    }
  };

  const handleQuickSaveWish = () => {
    const next: WalletCardState = {
      ...wallet,
      wishSaved: wallet.wishSaved + 200,
      entries: [
        {
          id: 'exp-' + Date.now(),
          title: t('cards.quickSaveEntryTitle'),
          amount: 200,
          type: 'saving',
          category: '金库✨',
          timestamp: Date.now(),
        },
        ...wallet.entries,
      ],
    };
    return persistUpdate(() => Repository.saveWalletCard(next), () => setWallet(next),
      t('cards.quickSaveToast', { saved: next.wishSaved }));
  };

  // ==================== ToB 双向交互动作（手动嘴知） ====================
  const handleAdvanceDealStage = (dealId: string) => {
    const nextDeals = deals.map((d) => {
      if (d.id !== dealId) return d;
      const idx = STAGES.indexOf(d.stage);
      const nextStage = STAGES[Math.min(STAGES.length - 1, idx + 1)];
      const probs = [30, 50, 65, 85, 100];
      return {
        ...d,
        stage: nextStage,
        winProbability: probs[Math.min(STAGES.length - 1, idx + 1)],
        updatedAt: Date.now(),
      };
    });
    const updated = nextDeals.find((d) => d.id === dealId);
    if (updated) {
      persistUpdate(() => StorageService.saveCrmDeals(nextDeals), () => setDeals(nextDeals),
        t('cards.advanceDealToast', { client: updated.clientName, stage: formatDealStage(updated.stage, lang) }));
    }
  };

  const handleToggleTask = (taskId: string) => {
    const nextTasks = tasks.map((t) => (t.id === taskId ? { ...t, done: !t.done } : t));
    const target = nextTasks.find((t) => t.id === taskId);
    persistUpdate(() => StorageService.saveProjectTasks(nextTasks), () => setTasks(nextTasks),
      t('cards.toggleTaskToast', { title: target?.title || t('cards.defaultTaskTitle') }));
  };

  const handleExportClientPoster = async () => {
    if (!posterRef.current) return;
    try {
      const { default: html2canvas } = await import('html2canvas');
      const canvas = await html2canvas(posterRef.current, {
        scale: 2,
        backgroundColor: '#0f172a',
        useCORS: true,
      });
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = t('cards.posterDownloadName', { client: selectedDealForPoster?.clientName || t('cards.defaultClientLabel') });
      a.click();
      onCompanionToast(t('cards.posterExportedToast'));
    } catch {
      onCompanionToast(t('cards.posterExportErrorToast'));
    }
  };

  // The cache is a bounded page, so this is an explicitly partial budget reference.
  const totalSpent = monthlyExpenseTotal(wallet.entries);
  const budgetUsedPct = boundedProgress(totalSpent, wallet.monthlyBudget);
  const wishPct = boundedProgress(wallet.wishSaved, wallet.wishTarget);

  const isWork = mode === 'work';

  return (
    <div
      className={`flex flex-col h-full min-h-[420px] md:h-[460px] rounded-2xl shadow-float overflow-hidden border transition-all duration-300 ${
        isWork
          ? 'bg-[#0f172a]/95 text-slate-100 border-slate-700'
          : 'bg-[#fcfaf5]/95 text-[#23293a] border-[#e5dec9]'
      }`}
    >
      {/* 顶部子导航栏 */}
      <div
        className={`px-3 py-2 border-b flex items-center justify-between gap-1 overflow-x-auto no-drag ${
          isWork ? 'bg-slate-900/90 border-slate-800' : 'bg-[#f9f6ed] border-[#ece6d5]'
        }`}
      >
        {!isWork ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveSubTab('wallet')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                activeSubTab === 'wallet'
                  ? 'bg-[#a8681a] text-white shadow-xs'
                  : 'text-[#6b7183] hover:bg-[#efeadd]'
              }`}
            >
              <Wallet size={13} />
              <span>{t('cards.tabWallet')}</span>
            </button>
            <button
              onClick={() => setActiveSubTab('relationships')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                activeSubTab === 'relationships'
                  ? 'bg-[#a8681a] text-white shadow-xs'
                  : 'text-[#6b7183] hover:bg-[#efeadd]'
              }`}
            >
              <Users size={13} />
              <span>{t('cards.tabRelationships')}</span>
            </button>
            {customCards.length > 0 && (
              <button
                onClick={() => setActiveSubTab('custom')}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                  activeSubTab === 'custom'
                    ? 'bg-[#a8681a] text-white shadow-xs'
                    : 'text-[#6b7183] hover:bg-[#efeadd]'
                }`}
              >
                <Sparkles size={13} />
                <span>{t('cards.tabCustom', { count: customCards.length })}</span>
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveSubTab('crm')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                activeSubTab === 'crm'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              <Briefcase size={13} />
              <span>{t('cards.tabCrm', { count: deals.length })}</span>
            </button>
            <button
              onClick={() => setActiveSubTab('projects')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                activeSubTab === 'projects'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              <Target size={13} />
              <span>{t('cards.tabProjects')}</span>
            </button>
            <button
              onClick={() => {
                if (!selectedDealForPoster && deals[0]) setSelectedDealForPoster(deals[0]);
                setActiveSubTab('poster');
              }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                activeSubTab === 'poster'
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              <FileCheck size={13} />
              <span>{t('cards.tabPoster')}</span>
            </button>
          </div>
        )}
      </div>

      {/* 主体内容区 */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
        {/* ==================== ToC 1: 随口记账与心愿小金库 ==================== */}
        {!isWork && activeSubTab === 'wallet' && (
          <div className="space-y-3">
            {/* 月度预算血条 */}
            <div className="p-3 rounded-xl bg-white border border-[#e6decd] shadow-xs space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[#23293a]">{t('cards.monthlyBudgetHeading')}</span>
                <span className="font-mono text-[#a8681a] font-bold">
                  {t('cards.monthlyBudgetSummary', { spent: totalSpent.toFixed(0), budget: wallet.monthlyBudget })}
                </span>
              </div>
              <div className="w-full h-2.5 bg-[#efeadd] rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#a8681a] to-amber-500 transition-all duration-500"
                  style={{ width: `${budgetUsedPct}%` }}
                />
              </div>
            </div>

            {/* 心愿攒钱罐 */}
            <div className="p-3 rounded-xl bg-gradient-to-r from-[#fbf7ec] to-[#f4ecda] border border-[#e2d6bc] flex items-center justify-between">
              <div className="space-y-1 flex-1 pr-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[#8a5410]">{wallet.wishTitle}</span>
                  <span className="font-mono text-[11px] text-[#8a5410]">{wishPct}%</span>
                </div>
                <div className="w-full h-2 bg-white/80 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-600 transition-all duration-500"
                    style={{ width: `${wishPct}%` }}
                  />
                </div>
                <span className="text-[10px] text-[#6b7183] block">
                  {t('cards.wishSavedSummary', { saved: wallet.wishSaved, target: wallet.wishTarget })}
                </span>
              </div>
              <button
                onClick={handleQuickSaveWish}
                className="px-2.5 py-1.5 rounded-lg bg-[#a8681a] hover:bg-[#8a5410] text-white text-xs font-medium shrink-0 cursor-pointer shadow-xs"
              >
                {t('cards.quickSaveBtn')}
              </button>
            </div>

            {/* 近期流水 */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-[#6b7183] px-1">{t('cards.recentEntriesTitle')}</span>
              {wallet.entries.slice(0, 6).map((item) => (
                <div
                  key={item.id}
                  className="px-3 py-2 rounded-xl bg-white/90 border border-[#ece6d5] flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-[#f5f1e6] text-[10px] text-[#8a5410]">
                      {formatExpenseCategory(item.category, lang)}
                    </span>
                    <span className="font-medium text-[#23293a]">{item.title}</span>
                  </div>
                  <span
                    className={`font-mono font-semibold ${
                      (item.type === 'saving' || item.type === 'income') ? 'text-emerald-600' : 'text-[#23293a]'
                    }`}
                  >
                    {(item.type === 'saving' || item.type === 'income') ? `+¥${item.amount}` : `-¥${item.amount}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}


        {/* ==================== ToC 3: 人脉与亲友档案簿 ==================== */}
        {!isWork && activeSubTab === 'relationships' && (
          <div className="space-y-2.5">
            {persons.map((p) => (
              <div
                key={p.id}
                className="p-3 rounded-xl bg-white border border-[#e6decd] space-y-2 shadow-xs"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-[#23293a]">{p.name}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#efeadd] text-[#8a5410]">
                      {p.relation}
                    </span>
                  </div>
                  {p.nextImportantDate && (
                    <span className="text-[10px] font-mono text-rose-600 bg-rose-50 px-2 py-0.5 rounded">
                      📅 {p.nextImportantDate}
                    </span>
                  )}
                </div>

                {p.taboos.length > 0 && (
                  <div className="flex flex-wrap gap-1 items-center text-[11px]">
                    <span className="text-rose-600 font-semibold">{t('cards.taboosLabel')}</span>
                    {p.taboos.map((taboo, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">
                        {taboo}
                      </span>
                    ))}
                  </div>
                )}

                {p.preferences.length > 0 && (
                  <div className="flex flex-wrap gap-1 items-center text-[11px]">
                    <span className="text-emerald-700 font-semibold">{t('cards.preferencesLabel')}</span>
                    {p.preferences.map((pref, i) => (
                      <span
                        key={i}
                        className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200"
                      >
                        {pref}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ==================== ToB 1: 零填表客户商机 CRM 卡 ==================== */}
        {isWork && activeSubTab === 'crm' && (
          <div className="space-y-3">
            {/* 商机总盘摘要 */}
            <div className="p-3 rounded-xl bg-slate-800/90 border border-slate-700 flex items-center justify-between">
              <div>
                <span className="text-[10px] text-slate-400 block">{t('cards.crmTotalLabel')}</span>
                <span className="text-lg font-mono font-bold text-emerald-400">
                  {t('cards.crmTotalValue', {
                    wan: (deals.reduce((s, d) => s + d.budgetAmount, 0) / 10000).toFixed(1),
                    formatted: formatBudgetAmount(deals.reduce((s, d) => s + d.budgetAmount, 0), lang),
                  })}
                </span>
              </div>
              <div className="text-right">
                <span className="text-[10px] text-slate-400 block">{t('cards.crmSubtitle')}</span>
                <span className="text-xs text-blue-400 font-medium">{t('cards.crmClientCount', { count: deals.length })}</span>
              </div>
            </div>

            {/* 客户商机卡片流 */}
            {deals.map((deal) => (
              <div
                key={deal.id}
                className="p-3.5 rounded-xl bg-slate-800/60 border border-slate-700/80 space-y-2.5 hover:border-blue-500/60 transition-all"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-bold text-white">{deal.clientName}</h4>
                    <span className="text-[11px] font-mono text-emerald-400 font-semibold">
                      {t('cards.crmDealBudget', {
                        wan: (deal.budgetAmount / 10000).toFixed(1),
                        formatted: formatBudgetAmount(deal.budgetAmount, lang),
                        prob: deal.winProbability,
                      })}
                    </span>
                  </div>
                  <button
                    onClick={() => handleAdvanceDealStage(deal.id)}
                    className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                    title={t('cards.crmAdvanceTitle')}
                  >
                    <span>{formatDealStage(deal.stage, lang)}</span>
                    <ArrowRight size={11} />
                  </button>
                </div>

                {/* 5阶段漏斗进度条 */}
                <div className="grid grid-cols-5 gap-1 pt-0.5">
                  {STAGES.map((st, idx) => {
                    const currentIdx = STAGES.indexOf(deal.stage);
                    const active = idx <= currentIdx;
                    return (
                      <div key={st} className="space-y-1 text-center">
                        <div
                          className={`h-1.5 rounded-full ${
                            active ? 'bg-blue-500' : 'bg-slate-700'
                          }`}
                        />
                        <span
                          className={`text-[9px] block ${
                            idx === currentIdx ? 'text-blue-400 font-bold' : 'text-slate-500'
                          }`}
                        >
                          {formatDealStage(st, lang)}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="text-xs space-y-1 bg-slate-900/70 p-2.5 rounded-lg border border-slate-800">
                  <p className="text-slate-300">
                    <span className="text-blue-400 font-medium">{t('cards.crmPainPoints')}</span>
                    {deal.painPoints}
                  </p>
                  <p className="text-amber-300/90 flex items-center gap-1">
                    <Lock size={11} className="shrink-0" />
                    <span className="font-medium">{t('cards.crmInternalBottomLine')}</span>
                    {deal.internalBottomLine}
                  </p>
                  <p className="text-emerald-400">
                    <span className="font-medium">{t('cards.crmNextAction')}</span>
                    {deal.nextAction}
                  </p>
                </div>

                <div className="flex justify-end">
                  <button
                    onClick={() => {
                      setSelectedDealForPoster(deal);
                      setActiveSubTab('poster');
                    }}
                    className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 cursor-pointer"
                  >
                    <FileCheck size={12} />
                    <span>{t('cards.crmViewPosterBtn')}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ==================== ToB 2: 项目死线推进看板 ==================== */}
        {isWork && activeSubTab === 'projects' && (
          <div className="space-y-2.5">
            {tasks.map((task) => (
              <div
                key={task.id}
                onClick={() => handleToggleTask(task.id)}
                className={`p-3 rounded-xl border flex items-center justify-between gap-2 cursor-pointer transition-all ${
                  task.done
                    ? 'bg-slate-900/40 border-slate-800 text-slate-500 line-through'
                    : 'bg-slate-800/80 border-slate-700 text-slate-100 hover:border-blue-500/50'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {task.done ? (
                    <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
                  ) : (
                    <Circle size={16} className="text-blue-400 shrink-0" />
                  )}
                  <div>
                    <p className="text-xs font-medium">{task.title}</p>
                    <span className="text-[10px] text-amber-400 font-mono">{t('cards.deadlinePrefix')}{task.deadline}</span>
                  </div>
                </div>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                    task.priority === 'high'
                      ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                      : 'bg-blue-500/20 text-blue-300'
                  }`}
                >
                  {task.priority === 'high' ? t('cards.priorityHigh') : t('cards.priorityNormal')}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ==================== ToB 3: 一键外发·客户交付对齐回执单 ==================== */}
        {isWork && activeSubTab === 'poster' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <select
                value={selectedDealForPoster?.id || deals[0]?.id}
                onChange={(e) => {
                  const found = deals.find((d) => d.id === e.target.value);
                  if (found) setSelectedDealForPoster(found);
                }}
                className="bg-slate-800 border border-slate-700 text-xs text-white rounded-lg px-2.5 py-1.5"
              >
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {t('cards.posterClientOption', { client: d.clientName })}
                  </option>
                ))}
              </select>

              <button
                onClick={handleExportClientPoster}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1.5 cursor-pointer shadow-sm"
              >
                <Download size={13} />
                <span>{t('cards.posterExportBtn')}</span>
              </button>
            </div>

            {/* 旧版内部纪要预览；正式工作态由 WorkBench 提供审核外发流程 */}
            {(() => {
              const target = selectedDealForPoster || deals[0];
              if (!target) return null;
              return (
                <div
                  ref={posterRef}
                  className="p-5 rounded-xl bg-gradient-to-br from-[#0f172a] via-[#1e293b] to-[#0f172a] border-2 border-amber-500/40 text-slate-100 space-y-4 shadow-lg"
                >
                  <div className="flex items-center justify-between border-b border-slate-700 pb-3">
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-widest text-amber-400 block">
                        {t('cards.posterDraftEyebrow')}
                      </span>
                      <h3 className="text-base font-bold text-white mt-0.5">
                        {t('cards.posterMemoHeading', { client: target.clientName })}
                      </h3>
                    </div>
                    <ShieldCheck size={22} className="text-amber-400" />
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 text-xs">
                    <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-700/80">
                      <span className="text-[10px] text-slate-400 block">{t('cards.posterStageLabel')}</span>
                      <span className="font-bold text-emerald-400">{formatDealStage(target.stage, lang)}</span>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-700/80">
                      <span className="text-[10px] text-slate-400 block">{t('cards.posterBudgetLabel')}</span>
                      <span className="font-mono font-bold text-amber-300">
                        {t('cards.posterBudgetValue', {
                          wan: (target.budgetAmount / 10000).toFixed(1),
                          formatted: formatBudgetAmount(target.budgetAmount, lang),
                        })}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="p-3 rounded-lg bg-slate-900/60 border-l-3 border-blue-500">
                      <span className="text-[10px] text-blue-400 font-semibold block mb-1">
                        {t('cards.posterSection1Title')}
                      </span>
                      <p className="text-slate-200 leading-relaxed">{target.painPoints}</p>
                    </div>

                    <div className="p-3 rounded-lg bg-slate-900/60 border-l-3 border-emerald-500">
                      <span className="text-[10px] text-emerald-400 font-semibold block mb-1">
                        {t('cards.posterSection2Title')}
                      </span>
                      <p className="text-slate-200 leading-relaxed">{target.nextAction}</p>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-[10px] text-slate-400">
                    <span>{t('cards.posterFooterNote')}</span>
                    <span className="font-mono text-amber-400/80">Generated by Looma OS</span>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* ==================== 自定义活体卡 ==================== */}
        {activeSubTab === 'custom' && (
          <div className="space-y-3">
            {customCards.map((c) => {
              const pct = boundedProgress(c.metricValue, c.metricTarget);
              return (
                <div
                  key={c.id}
                  className={`p-3.5 rounded-xl border space-y-2.5 ${
                    isWork ? 'bg-slate-800 border-slate-700' : 'bg-white border-[#e6decd]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold">
                      {c.icon} {c.title}
                    </span>
                    <span className="text-xs font-mono font-bold text-[#a8681a]">
                      {c.metricValue} / {c.metricTarget} {c.unit} ({pct}%)
                    </span>
                  </div>
                  <div className="w-full h-2 bg-black/10 rounded-full overflow-hidden">
                    <div className="h-full bg-[#a8681a]" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="flex justify-end">
                    <button
                      onClick={() => {
                        const updated = { ...c, metricValue: Math.min(c.metricTarget, c.metricValue + 10) };
                        return persistUpdate(() => Repository.upsert(mode, 'custom', [updated], true),
                          () => setCustomCards(previous => previous.map(item => item.id === c.id ? updated : item)), t('cards.customUpdatedToast', { title: c.title }));
                      }}
                      className="px-2.5 py-1 rounded bg-[#a8681a] text-white text-xs cursor-pointer"
                    >
                      {t('cards.customAdvanceBtn')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
