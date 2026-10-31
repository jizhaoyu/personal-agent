import React, { useState, useRef } from 'react';
import {
  Wallet,
  Zap,
  Users,
  Briefcase,
  Target,
  FileCheck,
  Droplets,
  Plus,
  CheckCircle2,
  Circle,
  Download,
  ShieldCheck,
  Sparkles,
  Trash2,
  ArrowRight,
  Lock,
} from 'lucide-react';
import {
  WorkspaceMode,
  WalletCardState,
  RpgStatusCardState,
  PersonProfile,
  CrmDealItem,
  ProjectTaskItem,
  CustomLivingCard,
  DealStage,
} from '../types';
import { StorageService } from '../services/storage';
import { Repository } from '../persistence/repository';

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

function statusForToday(value: RpgStatusCardState): RpgStatusCardState {
  const today = dayFormatter.format(Date.now());
  return { ...value, waterCups: value.dateKey === today ? value.waterCups : 0, dateKey: today };
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
  const cachedPartition = Repository.getCurrent().partitions[mode];
  const cachedLife = mode === 'life' ? Repository.getCurrent().partitions.life : null;
  // Only the current space is read. The repository cache contains a bounded, already migrated window.
  const [wallet, setWallet] = useState<WalletCardState>(() => cachedLife?.wallet || { monthlyBudget: 0, wishTitle: '我的心愿', wishTarget: 0, wishSaved: 0, entries: [] });
  const [rpg, setRpg] = useState<RpgStatusCardState>(() => cachedLife ? statusForToday(cachedLife.rpg) : { energy: 0, waterCups: 0, weightKg: 0, targetWeightKg: 0, moodBuff: '未记录', streakDays: 0 });
  const [persons, setPersons] = useState<PersonProfile[]>(() => cachedLife?.persons || []);

  // ToB 状态
  const [deals, setDeals] = useState<CrmDealItem[]>(() => mode === 'work' ? StorageService.getCrmDeals() : []);
  const [tasks, setTasks] = useState<ProjectTaskItem[]>(() => mode === 'work' ? StorageService.getProjectTasks() : []);
  const [selectedDealForPoster, setSelectedDealForPoster] = useState<CrmDealItem | null>(null);

  // 自定义卡
  const [customCards, setCustomCards] = useState<CustomLivingCard[]>(() =>
    cachedPartition.customCards
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
      setCustomCards(partition.customCards);
      if (mode === 'life') {
        const life = Repository.getCurrent().partitions.life;
        setWallet(life.wallet);
        setRpg(statusForToday(life.rpg));
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
        onCompanionToast('保存失败，界面保留原记录。请检查本地存储空间后重试。');
      }
    } finally {
      savingRef.current = false;
    }
  };

  // ==================== ToC 双向交互动作（手动嘴知） ====================
  const handleAddWater = () => {
    const today = statusForToday(rpg);
    const next = {
      ...today,
      waterCups: Math.min(8, today.waterCups + 1),
      energy: Math.min(100, rpg.energy + 3),
    };
    return persistUpdate(() => Repository.saveRpgStatusCard(next), () => setRpg(next),
      `💧 已记录今日第 ${next.waterCups} 杯水。精力分值仅供个人记录参考。`);
  };

  const handleQuickRest = () => {
    const next = {
      ...statusForToday(rpg),
      energy: Math.min(100, rpg.energy + 15),
      moodBuff: '✨ 小憩回血 · 神清气爽',
    };
    return persistUpdate(() => Repository.saveRpgStatusCard(next), () => setRpg(next),
      '⚡ 休息记录已保存。精力分值是个人状态记录，不代表生理测量。');
  };

  const handleQuickSaveWish = () => {
    const next: WalletCardState = {
      ...wallet,
      wishSaved: wallet.wishSaved + 200,
      entries: [
        {
          id: 'exp-' + Date.now(),
          title: '随手攒入心愿金库',
          amount: 200,
          type: 'saving',
          category: '金库✨',
          timestamp: Date.now(),
        },
        ...wallet.entries,
      ],
    };
    return persistUpdate(() => Repository.saveWalletCard(next), () => setWallet(next),
      `💰 已记录心愿储蓄 ¥200，当前累计 ¥${next.wishSaved}。`);
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
        `💼 【${updated.clientName}】已更新为「${updated.stage}」。`);
    }
  };

  const handleToggleTask = (taskId: string) => {
    const nextTasks = tasks.map((t) => (t.id === taskId ? { ...t, done: !t.done } : t));
    const target = nextTasks.find((t) => t.id === taskId);
    persistUpdate(() => StorageService.saveProjectTasks(nextTasks), () => setTasks(nextTasks),
      `🎯 已更新「${target?.title || '事项'}」的完成状态。`);
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
      a.download = `Looma待确认纪要草稿-${selectedDealForPoster?.clientName || '客户'}.png`;
      a.click();
      onCompanionToast('📤 已导出待确认纪要草稿，请核对全部文字后再自行发送。');
    } catch {
      onCompanionToast('图片导出失败，请重试。');
    }
  };

  // The cache is a bounded page, so this is an explicitly partial budget reference.
  const totalSpent = monthlyExpenseTotal(wallet.entries);
  const budgetUsedPct = boundedProgress(totalSpent, wallet.monthlyBudget);
  const wishPct = boundedProgress(wallet.wishSaved, wallet.wishTarget);

  const isWork = mode === 'work';

  return (
    <div
      className={`flex flex-col h-[460px] rounded-2xl shadow-float overflow-hidden border transition-all duration-300 ${
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
              <span>随口记账</span>
            </button>
            <button
              onClick={() => setActiveSubTab('rpg_status')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                activeSubTab === 'rpg_status'
                  ? 'bg-[#a8681a] text-white shadow-xs'
                  : 'text-[#6b7183] hover:bg-[#efeadd]'
              }`}
            >
              <Zap size={13} />
              <span>人生状态栏</span>
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
              <span>人脉档案</span>
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
                <span>自定义({customCards.length})</span>
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
              <span>商机CRM({deals.length})</span>
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
              <span>死线看板</span>
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
              <span>外发对齐单</span>
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
                <span className="font-semibold text-[#23293a]">💰 近期账单预算参考</span>
                <span className="font-mono text-[#a8681a] font-bold">
                  已加载本月支出 ¥{totalSpent.toFixed(0)} / 预算 ¥{wallet.monthlyBudget}
                </span>
              </div>
              <div className="w-full h-2.5 bg-[#efeadd] rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#a8681a] to-amber-500 transition-all duration-500"
                  style={{ width: `${budgetUsedPct}%` }}
                />
              </div>
              <p className="text-[11px] text-[#6b7183]">
                仅汇总已加载的近期账单，本月完整支出可能更高。文字示例：“午饭花了35元”。
              </p>
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
                  已攒 ¥{wallet.wishSaved} / 目标 ¥{wallet.wishTarget}
                </span>
              </div>
              <button
                onClick={handleQuickSaveWish}
                className="px-2.5 py-1.5 rounded-lg bg-[#a8681a] hover:bg-[#8a5410] text-white text-xs font-medium shrink-0 cursor-pointer shadow-xs"
              >
                +攒 ¥200
              </button>
            </div>

            {/* 近期流水 */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-[#6b7183] px-1">近期生活账单</span>
              {wallet.entries.slice(0, 6).map((item) => (
                <div
                  key={item.id}
                  className="px-3 py-2 rounded-xl bg-white/90 border border-[#ece6d5] flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-[#f5f1e6] text-[10px] text-[#8a5410]">
                      {item.category}
                    </span>
                    <span className="font-medium text-[#23293a]">{item.title}</span>
                  </div>
                  <span
                    className={`font-mono font-semibold ${
                      item.type === 'saving' ? 'text-emerald-600' : 'text-[#23293a]'
                    }`}
                  >
                    {item.type === 'saving' ? `+¥${item.amount}` : `-¥${item.amount}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ==================== ToC 2: 三维人生 RPG 状态栏 ==================== */}
        {!isWork && activeSubTab === 'rpg_status' && (
          <div className="space-y-3">
            <div className="p-3.5 rounded-xl bg-white border border-[#e6decd] space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#23293a]">⚡ 个人状态与精力面板</span>
                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-[#8a5410] text-[11px] font-medium">
                  {rpg.moodBuff}
                </span>
              </div>

              {/* 精力条 */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-[#6b7183]">🔋 自报精力参考值 (HP)</span>
                  <span className="font-mono font-bold text-emerald-700">{rpg.energy} / 100</span>
                </div>
                <div className="w-full h-2.5 bg-[#efeadd] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-500"
                    style={{ width: `${rpg.energy}%` }}
                  />
                </div>
              </div>

              {/* 饮水 8 格 */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-[#6b7183]">💧 今日饮水记录</span>
                  <span className="font-mono text-sky-700 font-semibold">{rpg.waterCups} / 8 杯</span>
                </div>
                <div className="grid grid-cols-8 gap-1.5">
                  {Array.from({ length: 8 }).map((_, idx) => (
                    <button
                      key={idx}
                      onClick={handleAddWater}
                      className={`h-7 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
                        idx < rpg.waterCups
                          ? 'bg-sky-500 text-white shadow-xs'
                          : 'bg-[#f4f0e6] text-[#a49f91] hover:bg-sky-100'
                      }`}
                    >
                      <Droplets size={13} />
                    </button>
                  ))}
                </div>
              </div>

              {/* 体重与打卡天数 */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="p-2.5 rounded-lg bg-[#f9f6ed] border border-[#ece6d5]">
                  <span className="text-[10px] text-[#6b7183] block">⚖️ 自报体重{rpg.targetWeightKg > 0 ? `（目标 ${rpg.targetWeightKg}kg）` : ''}</span>
                  <span className="text-base font-mono font-bold text-[#23293a]">{rpg.weightKg > 0 ? `${rpg.weightKg} kg` : '尚未记录'}</span>
                </div>
                <div className="p-2.5 rounded-lg bg-[#f9f6ed] border border-[#ece6d5]">
                  <span className="text-[10px] text-[#6b7183] block">🔥 连续自律打卡</span>
                  <span className="text-base font-mono font-bold text-[#a8681a]">{rpg.streakDays} 天</span>
                </div>
              </div>

              {/* 双向绑定快捷按钮 */}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleAddWater}
                  className="flex-1 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium cursor-pointer"
                >
                  💧 喝一杯水
                </button>
                <button
                  onClick={handleQuickRest}
                  className="flex-1 py-1.5 rounded-lg bg-[#a8681a] hover:bg-[#8a5410] text-white text-xs font-medium cursor-pointer"
                >
                  🛌 记录休息
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ==================== ToC 3: 人脉与亲友档案簿 ==================== */}
        {!isWork && activeSubTab === 'relationships' && (
          <div className="space-y-2.5">
            <div className="px-3 py-2 rounded-xl bg-[#f5f1e6] text-[11px] text-[#8a5410]">
              💡 可输入：“记一下王叔对海鲜过敏，喜欢喝普洱”。请在这里查看并核对亲友备忘。
            </div>
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
                    <span className="text-rose-600 font-semibold">⚠️ 忌口/雷区：</span>
                    {p.taboos.map((t, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">
                        {t}
                      </span>
                    ))}
                  </div>
                )}

                {p.preferences.length > 0 && (
                  <div className="flex flex-wrap gap-1 items-center text-[11px]">
                    <span className="text-emerald-700 font-semibold">🎁 喜好/心愿：</span>
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
                <span className="text-[10px] text-slate-400 block">活跃跟进商机池总额</span>
                <span className="text-lg font-mono font-bold text-emerald-400">
                  ¥{(deals.reduce((s, d) => s + d.budgetAmount, 0) / 10000).toFixed(1)} 万
                </span>
              </div>
              <div className="text-right">
                <span className="text-[10px] text-slate-400 block">零填表语音/文字建档</span>
                <span className="text-xs text-blue-400 font-medium">已跟进 {deals.length} 家核心客户</span>
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
                      预算规模：¥{(deal.budgetAmount / 10000).toFixed(1)}万 · 赢率 {deal.winProbability}%
                    </span>
                  </div>
                  <button
                    onClick={() => handleAdvanceDealStage(deal.id)}
                    className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                    title="点击推进到下一商机阶段"
                  >
                    <span>{deal.stage}</span>
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
                          {st}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="text-xs space-y-1 bg-slate-900/70 p-2.5 rounded-lg border border-slate-800">
                  <p className="text-slate-300">
                    <span className="text-blue-400 font-medium">🎯 客户痛点：</span>
                    {deal.painPoints}
                  </p>
                  <p className="text-amber-300/90 flex items-center gap-1">
                    <Lock size={11} className="shrink-0" />
                    <span className="font-medium">内部备注（仅内部查看）：</span>
                    {deal.internalBottomLine}
                  </p>
                  <p className="text-emerald-400">
                    <span className="font-medium">⏰ 下一步行动：</span>
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
                    <span>查看待确认纪要草稿 →</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ==================== ToB 2: 项目死线推进看板 ==================== */}
        {isWork && activeSubTab === 'projects' && (
          <div className="space-y-2.5">
            <div className="p-2.5 rounded-xl bg-slate-800/80 border border-slate-700 text-[11px] text-slate-300">
              💡 输入待办文字后，请在工作台预览并确认事项与日期。
            </div>
            {tasks.map((t) => (
              <div
                key={t.id}
                onClick={() => handleToggleTask(t.id)}
                className={`p-3 rounded-xl border flex items-center justify-between gap-2 cursor-pointer transition-all ${
                  t.done
                    ? 'bg-slate-900/40 border-slate-800 text-slate-500 line-through'
                    : 'bg-slate-800/80 border-slate-700 text-slate-100 hover:border-blue-500/50'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {t.done ? (
                    <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
                  ) : (
                    <Circle size={16} className="text-blue-400 shrink-0" />
                  )}
                  <div>
                    <p className="text-xs font-medium">{t.title}</p>
                    <span className="text-[10px] text-amber-400 font-mono">⏰ 截止：{t.deadline}</span>
                  </div>
                </div>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                    t.priority === 'high'
                      ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                      : 'bg-blue-500/20 text-blue-300'
                  }`}
                >
                  {t.priority === 'high' ? '高优死线' : '推进中'}
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
                    客户：{d.clientName}
                  </option>
                ))}
              </select>

              <button
                onClick={handleExportClientPoster}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1.5 cursor-pointer shadow-sm"
              >
                <Download size={13} />
                <span>导出待确认草稿</span>
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
                        DRAFT · 沟通纪要草稿／待对方确认
                      </span>
                      <h3 className="text-base font-bold text-white mt-0.5">
                        {target.clientName} · 合作推进备忘录
                      </h3>
                    </div>
                    <ShieldCheck size={22} className="text-amber-400" />
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 text-xs">
                    <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-700/80">
                      <span className="text-[10px] text-slate-400 block">当前合作阶段</span>
                      <span className="font-bold text-emerald-400">{target.stage}</span>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-700/80">
                      <span className="text-[10px] text-slate-400 block">规划预算规模</span>
                      <span className="font-mono font-bold text-amber-300">
                        ¥{(target.budgetAmount / 10000).toFixed(1)} 万元
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="p-3 rounded-lg bg-slate-900/60 border-l-3 border-blue-500">
                      <span className="text-[10px] text-blue-400 font-semibold block mb-1">
                        一、 待核对的业务诉求
                      </span>
                      <p className="text-slate-200 leading-relaxed">{target.painPoints}</p>
                    </div>

                    <div className="p-3 rounded-lg bg-slate-900/60 border-l-3 border-emerald-500">
                      <span className="text-[10px] text-emerald-400 font-semibold block mb-1">
                        二、 待确认的后续行动与排期
                      </span>
                      <p className="text-slate-200 leading-relaxed">{target.nextAction}</p>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-[10px] text-slate-400">
                    <span>草稿仅供核对，发送前请审阅所有内容。</span>
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
                          () => setCustomCards(previous => previous.map(item => item.id === c.id ? updated : item)), `🌟 已更新「${c.title}」进度。`);
                      }}
                      className="px-2.5 py-1 rounded bg-[#a8681a] text-white text-xs cursor-pointer"
                    >
                      +推进进度
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
