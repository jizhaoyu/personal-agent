import React, { useState, useRef } from 'react';
import {
  Wallet,
  Users,
  Sparkles,
  Trash2,
  Pencil,
  Plus,
  Check,
  X,
  Calendar,
} from 'lucide-react';
import type {
  WorkspaceMode,
  WalletCardState,
  WishItem,
  PersonProfile,
  CustomLivingCard,
  ExpenseEntry,
} from '../types';
import { Repository } from '../persistence/repository';
import {
  formatBudgetAmount,
  formatExpenseCategory,
  getLanguage,
  translate,
  useI18n,
  type I18nKey,
} from '../i18n';

interface LivingCardsBoardProps {
  mode: WorkspaceMode;
  highlightedCard?: string | null;
  onCompanionToast: (msg: string) => void;
}

const EXPENSE_CATEGORIES: ExpenseEntry['category'][] = [
  '餐饮☕',
  '购物🛍️',
  '出行🚕',
  '娱乐🎮',
  '生活🏠',
  '金库✨',
];

const monthFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
});

export function normalizeWallet(
  w: WalletCardState,
  defaults?: { title?: string; group?: string },
): WalletCardState {
  const lang = getLanguage();
  const defaultTitle = defaults?.title ?? translate(lang, 'cards.defaultWishTitle');
  const translatedGroup = translate(lang, 'cards.defaultWishGroup' as I18nKey);
  const defaultGroup = defaults?.group ?? (
    translatedGroup !== 'cards.defaultWishGroup'
      ? translatedGroup
      : (lang === 'en' ? 'Lifestyle' : '品质生活')
  );
  const wishes: WishItem[] = (w.wishes && w.wishes.length > 0)
    ? w.wishes.map(item => ({ ...item }))
    : [
        {
          id: 'wish-default',
          title: w.wishTitle || defaultTitle,
          targetAmount: w.wishTarget || 10000,
          savedAmount: w.wishSaved || 0,
          group: defaultGroup,
          isPrimary: true,
          createdAt: Date.now(),
        },
      ];
  const activeWishId = w.activeWishId && wishes.some(item => item.id === w.activeWishId)
    ? w.activeWishId
    : wishes.find(item => item.isPrimary)?.id || wishes[0].id;
  const activeWish = wishes.find(item => item.id === activeWishId) || wishes[0];
  return {
    ...w,
    wishTitle: activeWish.title,
    wishTarget: activeWish.targetAmount,
    wishSaved: Number.isFinite(activeWish.savedAmount) ? activeWish.savedAmount : (w.wishSaved || 0),
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

function splitTagList(raw: string): string[] {
  return [...new Set(raw.split(/[,，、;；]+/).map(s => s.trim()).filter(Boolean))];
}

function makeLocalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export const LivingCardsBoard: React.FC<LivingCardsBoardProps> = ({
  mode,
  highlightedCard,
  onCompanionToast,
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

  const isLife = mode === 'life';
  const cachedLife = isLife ? Repository.getCurrent().partitions.life : null;
  // Only the current space is read. The repository cache contains a bounded, already migrated window.
  const [wallet, setWallet] = useState<WalletCardState>(() =>
    normalizeWallet(cachedLife?.wallet || {
      monthlyBudget: 5000,
      wishTitle: translate(getLanguage(), 'cards.defaultWishTitle'),
      wishTarget: 10000,
      wishSaved: 0,
      entries: [],
    }),
  );
  const [persons, setPersons] = useState<PersonProfile[]>(() => cachedLife?.persons || []);
  const [customCards, setCustomCards] = useState<CustomLivingCard[]>(() =>
    cachedLife ? cachedLife.customCards.filter(c => c.cardKind !== 'checkin') : [],
  );
  const [activeSubTab, setActiveSubTab] = useState<string>(() =>
    highlightedCard && ['wallet', 'relationships', 'custom'].includes(highlightedCard) ? highlightedCard : 'wallet',
  );

  // Wallet inline editing & entry composer state
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInput, setBudgetInput] = useState('');
  const [editingWish, setEditingWish] = useState(false);
  const [wishTitleInput, setWishTitleInput] = useState('');
  const [wishTargetInput, setWishTargetInput] = useState('');
  const [addingWish, setAddingWish] = useState(false);
  const [newWishTitle, setNewWishTitle] = useState('');
  const [newWishTarget, setNewWishTarget] = useState('');
  const [customSaveInput, setCustomSaveInput] = useState('');
  const [addingEntry, setAddingEntry] = useState(false);
  const [entryTitle, setEntryTitle] = useState('');
  const [entryAmount, setEntryAmount] = useState('');
  const [entryType, setEntryType] = useState<ExpenseEntry['type']>('expense');
  const [entryCategory, setEntryCategory] = useState<ExpenseEntry['category']>('餐饮☕');
  const [showAllEntries, setShowAllEntries] = useState(false);
  const [confirmDeleteEntryId, setConfirmDeleteEntryId] = useState<string | null>(null);
  const [walletError, setWalletError] = useState('');

  // Relationships inline composer / editor state
  const [addingPerson, setAddingPerson] = useState(false);
  const [editingPersonId, setEditingPersonId] = useState<string | null>(null);
  const [personName, setPersonName] = useState('');
  const [personRelation, setPersonRelation] = useState('');
  const [personTaboos, setPersonTaboos] = useState('');
  const [personPrefs, setPersonPrefs] = useState('');
  const [personDate, setPersonDate] = useState('');
  const [confirmDeletePersonId, setConfirmDeletePersonId] = useState<string | null>(null);
  const [personError, setPersonError] = useState('');

  // Custom cards increment step / direct edit state
  const [customStepInputs, setCustomStepInputs] = useState<Record<string, string>>({});
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);
  const [editingCustomValue, setEditingCustomValue] = useState('');

  const mountedRef = useRef(true);
  const activeModeRef = useRef(mode);
  const savingRef = useRef(false);
  activeModeRef.current = mode;

  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  React.useEffect(() => {
    if (!isLife) return;
    const syncCurrentSpace = () => {
      if (!mountedRef.current || activeModeRef.current !== 'life') return;
      const life = Repository.getCurrent().partitions.life;
      setCustomCards(life.customCards.filter(c => c.cardKind !== 'checkin'));
      setWallet(normalizeWallet(life.wallet));
      setPersons(life.persons);
    };
    syncCurrentSpace();
    if (highlightedCard && ['wallet', 'relationships', 'custom'].includes(highlightedCard)) {
      setActiveSubTab(highlightedCard);
    } else {
      setActiveSubTab('wallet');
    }
    return Repository.subscribe(syncCurrentSpace);
  }, [isLife, highlightedCard]);

  if (!isLife) {
    return (
      <div className="p-4 rounded-2xl border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-muted)]">
        {tr('cards.lifeOnlyNotice', { zh: '生活卡片仅在生活空间使用。', en: 'Life Cards are available in Life space.' })}
      </div>
    );
  }

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

  const applyDepositToWallet = (amount: number, entryTitleText: string): WalletCardState => {
    const base = normalizeWallet(wallet);
    const wishes = (base.wishes || []).map(item =>
      item.id === base.activeWishId
        ? { ...item, savedAmount: Math.max(0, (item.savedAmount || 0) + amount) }
        : item,
    );
    const activeWish = wishes.find(item => item.id === base.activeWishId) || wishes[0];
    const nextEntry: ExpenseEntry = {
      id: makeLocalId('exp'),
      title: entryTitleText,
      amount,
      type: 'saving',
      category: '金库✨',
      timestamp: Date.now(),
    };
    return normalizeWallet({
      ...base,
      wishSaved: activeWish ? activeWish.savedAmount : base.wishSaved + amount,
      wishes,
      entries: [nextEntry, ...base.entries],
    });
  };

  const handleQuickSaveWish = () => {
    const next = applyDepositToWallet(200, t('cards.quickSaveEntryTitle'));
    return persistUpdate(
      () => Repository.saveWalletCard(next),
      () => setWallet(next),
      tr('cards.quickSaveToastFormatted', {
        zh: '已记录心愿储蓄 {delta}，当前累计 {saved}。',
        en: 'Saved {delta} to wish jar; total {saved}.',
      }, {
        delta: formatBudgetAmount(200, lang),
        saved: formatBudgetAmount(next.wishSaved, lang),
      }),
    );
  };

  const handleCustomDeposit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(customSaveInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      setWalletError(tr('cards.errPositiveAmount', { zh: '请输入大于 0 的金额。', en: 'Enter an amount greater than 0.' }));
      return;
    }
    setWalletError('');
    const rounded = +amount.toFixed(2);
    const next = applyDepositToWallet(rounded, t('cards.quickSaveEntryTitle'));
    return persistUpdate(
      () => Repository.saveWalletCard(next),
      () => {
        setWallet(next);
        setCustomSaveInput('');
      },
      tr('cards.depositToast', {
        zh: '已存入 {amount}，当前累计 {saved}。',
        en: 'Deposited {amount}; total saved {saved}.',
      }, {
        amount: formatBudgetAmount(rounded, lang),
        saved: formatBudgetAmount(next.wishSaved, lang),
      }),
    );
  };

  const handleSaveBudget = (e: React.FormEvent) => {
    e.preventDefault();
    const val = Number(budgetInput);
    if (!Number.isFinite(val) || val < 0) {
      setWalletError(tr('cards.errBudgetNonNeg', { zh: '月度预算不能为负数。', en: 'Monthly budget cannot be negative.' }));
      return;
    }
    setWalletError('');
    const next = normalizeWallet({ ...wallet, monthlyBudget: +val.toFixed(2) });
    return persistUpdate(
      () => Repository.saveWalletCard(next),
      () => {
        setWallet(next);
        setEditingBudget(false);
      },
      tr('cards.budgetUpdatedToast', {
        zh: '已更新月度预算为 {budget}。',
        en: 'Updated monthly budget to {budget}.',
      }, { budget: formatBudgetAmount(next.monthlyBudget, lang) }),
    );
  };

  const handleSaveActiveWish = (e: React.FormEvent) => {
    e.preventDefault();
    const title = wishTitleInput.trim();
    const target = Number(wishTargetInput);
    if (!title) {
      setWalletError(tr('cards.errWishTitleRequired', { zh: '请填写心愿名称。', en: 'Enter a wish title.' }));
      return;
    }
    if (!Number.isFinite(target) || target <= 0) {
      setWalletError(tr('cards.errWishTargetPositive', { zh: '目标金额需大于 0。', en: 'Target amount must be greater than 0.' }));
      return;
    }
    setWalletError('');
    const base = normalizeWallet(wallet);
    const roundedTarget = +target.toFixed(2);
    const wishes = (base.wishes || []).map(item =>
      item.id === base.activeWishId ? { ...item, title, targetAmount: roundedTarget } : item,
    );
    const next = normalizeWallet({
      ...base,
      wishTitle: title,
      wishTarget: roundedTarget,
      wishes,
    });
    return persistUpdate(
      () => Repository.saveWalletCard(next),
      () => {
        setWallet(next);
        setEditingWish(false);
      },
      tr('cards.wishUpdatedToast', { zh: '已更新心愿「{title}」。', en: 'Updated wish "{title}".' }, { title }),
    );
  };

  const handleAddWish = (e: React.FormEvent) => {
    e.preventDefault();
    const title = newWishTitle.trim();
    const target = Number(newWishTarget);
    if (!title) {
      setWalletError(tr('cards.errWishTitleRequired', { zh: '请填写心愿名称。', en: 'Enter a wish title.' }));
      return;
    }
    if (!Number.isFinite(target) || target <= 0) {
      setWalletError(tr('cards.errWishTargetPositive', { zh: '目标金额需大于 0。', en: 'Target amount must be greater than 0.' }));
      return;
    }
    setWalletError('');
    const base = normalizeWallet(wallet);
    const defaultGroupResolved = translate(lang, 'cards.defaultWishGroup' as I18nKey);
    const created: WishItem = {
      id: makeLocalId('wish'),
      title,
      targetAmount: +target.toFixed(2),
      savedAmount: 0,
      group: defaultGroupResolved !== 'cards.defaultWishGroup'
        ? defaultGroupResolved
        : (lang === 'en' ? 'Lifestyle' : '品质生活'),
      isPrimary: true,
      createdAt: Date.now(),
    };
    const wishes: WishItem[] = (base.wishes || []).map(item => ({ ...item, isPrimary: false }));
    wishes.push(created);
    const next = normalizeWallet({
      ...base,
      activeWishId: created.id,
      wishTitle: created.title,
      wishTarget: created.targetAmount,
      wishSaved: 0,
      wishes,
    });
    return persistUpdate(
      () => Repository.saveWalletCard(next),
      () => {
        setWallet(next);
        setAddingWish(false);
        setNewWishTitle('');
        setNewWishTarget('');
      },
      tr('cards.wishAddedToast', { zh: '已新增并切换至「{title}」。', en: 'Added and switched to "{title}".' }, { title }),
    );
  };

  const handleSwitchWish = (wishId: string) => {
    if (wishId === wallet.activeWishId) return;
    const base = normalizeWallet(wallet);
    const target = (base.wishes || []).find(w => w.id === wishId);
    if (!target) return;
    const wishes = (base.wishes || []).map(w => ({ ...w, isPrimary: w.id === wishId }));
    const next = normalizeWallet({
      ...base,
      activeWishId: wishId,
      wishTitle: target.title,
      wishTarget: target.targetAmount,
      wishSaved: target.savedAmount,
      wishes,
    });
    return persistUpdate(
      () => Repository.saveWalletCard(next),
      () => {
        setWallet(next);
        setEditingWish(false);
      },
      tr('cards.wishSwitchedToast', { zh: '已切换当前心愿为「{title}」。', en: 'Switched active wish to "{title}".' }, { title: target.title }),
    );
  };

  const handleAddEntry = (e: React.FormEvent) => {
    e.preventDefault();
    const title = entryTitle.trim();
    const amount = Number(entryAmount);
    if (!title) {
      setWalletError(tr('cards.errEntryTitleRequired', { zh: '请填写账单名称。', en: 'Enter a description.' }));
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setWalletError(tr('cards.errPositiveAmount', { zh: '请输入大于 0 的金额。', en: 'Enter an amount greater than 0.' }));
      return;
    }
    setWalletError('');
    const rounded = +amount.toFixed(2);
    const base = normalizeWallet(wallet);
    const created: ExpenseEntry = {
      id: makeLocalId('exp'),
      title,
      amount: rounded,
      type: entryType,
      category: entryType === 'expense' ? entryCategory : '金库✨',
      timestamp: Date.now(),
    };
    const delta = entryType === 'saving' || entryType === 'income' ? rounded : 0;
    const wishes = (base.wishes || []).map(item =>
      delta > 0 && item.id === base.activeWishId
        ? { ...item, savedAmount: Math.max(0, (item.savedAmount || 0) + delta) }
        : item,
    );
    const activeWish = wishes.find(item => item.id === base.activeWishId) || wishes[0];
    const next = normalizeWallet({
      ...base,
      wishSaved: delta > 0 ? (activeWish ? activeWish.savedAmount : base.wishSaved + delta) : base.wishSaved,
      wishes,
      entries: [created, ...base.entries],
    });
    return persistUpdate(
      () => Repository.saveWalletCard(next),
      () => {
        setWallet(next);
        setAddingEntry(false);
        setEntryTitle('');
        setEntryAmount('');
      },
      tr('cards.entryAddedToast', {
        zh: '已记录「{title}」{amount}。',
        en: 'Recorded "{title}" ({amount}).',
      }, { title, amount: formatBudgetAmount(rounded, lang) }),
    );
  };

  const handleDeleteEntry = (entry: ExpenseEntry) => {
    setConfirmDeleteEntryId(null);
    return persistUpdate(
      async () => {
        if (typeof Repository.transaction === 'function') {
          const before = typeof Repository.get === 'function'
            ? await Repository.get<ExpenseEntry>('life', 'expense', entry.id)
            : entry;
          if (before) {
            const res = await Repository.transaction(
              'life',
              [{ kind: 'expense', id: entry.id, before, after: null }],
              { event: true, sourceText: '删除生活账单记录' },
            );
            if (!res.ok) throw new Error(res.error);
          }
        }
      },
      () => {
        setWallet(prev => normalizeWallet({
          ...prev,
          entries: prev.entries.filter(item => item.id !== entry.id),
        }));
      },
      tr('cards.entryDeletedToast', { zh: '已删除账单「{title}」。', en: 'Deleted entry "{title}".' }, { title: entry.title }),
    );
  };

  const resetPersonForm = () => {
    setAddingPerson(false);
    setEditingPersonId(null);
    setPersonName('');
    setPersonRelation('');
    setPersonTaboos('');
    setPersonPrefs('');
    setPersonDate('');
    setPersonError('');
  };

  const openPersonEdit = (p: PersonProfile) => {
    setAddingPerson(false);
    setEditingPersonId(p.id);
    setPersonName(p.name);
    setPersonRelation(p.relation);
    setPersonTaboos(p.taboos.join('、'));
    setPersonPrefs(p.preferences.join('、'));
    setPersonDate(p.nextImportantDate || '');
    setConfirmDeletePersonId(null);
    setPersonError('');
  };

  const handleSavePerson = (e: React.FormEvent) => {
    e.preventDefault();
    const name = personName.trim();
    if (!name) {
      setPersonError(tr('cards.errPersonNameRequired', { zh: '请填写姓名或称呼。', en: 'Enter a name.' }));
      return;
    }
    setPersonError('');
    const relation = personRelation.trim() || tr('cards.defaultRelation', { zh: '亲友', en: 'Contact' });
    const taboos = splitTagList(personTaboos);
    const preferences = splitTagList(personPrefs);
    const cleanDate = personDate.trim();
    const record: PersonProfile = {
      id: editingPersonId || makeLocalId('person'),
      name,
      relation,
      taboos,
      preferences,
      ...(cleanDate ? { nextImportantDate: cleanDate } : {}),
      updatedAt: Date.now(),
    };
    const isEdit = Boolean(editingPersonId);
    return persistUpdate(
      () => Repository.upsert('life', 'person', [record], true),
      () => {
        setPersons(prev => {
          if (isEdit) return prev.map(item => item.id === record.id ? record : item);
          return [record, ...prev];
        });
        resetPersonForm();
      },
      isEdit
        ? tr('cards.personUpdatedToast', { zh: '已更新「{name}」档案。', en: 'Updated profile for "{name}".' }, { name })
        : tr('cards.personAddedToast', { zh: '已添加「{name}」档案。', en: 'Added profile for "{name}".' }, { name }),
    );
  };

  const handleDeletePerson = (person: PersonProfile) => {
    setConfirmDeletePersonId(null);
    return persistUpdate(
      async () => {
        if (typeof Repository.transaction === 'function') {
          const before = typeof Repository.get === 'function'
            ? await Repository.get<PersonProfile>('life', 'person', person.id)
            : person;
          if (before) {
            const res = await Repository.transaction(
              'life',
              [{ kind: 'person', id: person.id, before, after: null }],
              { event: true, sourceText: '删除亲友档案' },
            );
            if (!res.ok) throw new Error(res.error);
          }
        }
      },
      () => {
        setPersons(prev => prev.filter(item => item.id !== person.id));
        if (editingPersonId === person.id) resetPersonForm();
      },
      tr('cards.personDeletedToast', { zh: '已删除「{name}」档案。', en: 'Deleted profile for "{name}".' }, { name: person.name }),
    );
  };

  const getCustomStep = (cardId: string): number => {
    const raw = customStepInputs[cardId];
    if (raw === undefined || raw.trim() === '') return 10;
    const parsed = Math.round(Number(raw));
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 10;
  };

  const handleAdvanceCustomCard = (card: CustomLivingCard, delta: number) => {
    const step = Number.isFinite(delta) && delta >= 1 ? Math.round(delta) : 10;
    const updated: CustomLivingCard = {
      ...card,
      metricValue: Math.min(card.metricTarget, card.metricValue + step),
    };
    return persistUpdate(
      () => Repository.upsert(mode, 'custom', [updated], true),
      () => setCustomCards(previous => previous.map(item => item.id === card.id ? updated : item)),
      t('cards.customUpdatedToast', { title: card.title }),
    );
  };

  const handleSetCustomCardValue = (card: CustomLivingCard, rawValue: string) => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const nextValue = Math.min(card.metricTarget, Math.max(0, Math.round(parsed)));
    const updated: CustomLivingCard = { ...card, metricValue: nextValue };
    return persistUpdate(
      () => Repository.upsert(mode, 'custom', [updated], true),
      () => {
        setCustomCards(previous => previous.map(item => item.id === card.id ? updated : item));
        setEditingCustomId(null);
      },
      t('cards.customUpdatedToast', { title: card.title }),
    );
  };

  // The cache is a bounded page, so this is an explicitly partial budget reference.
  const totalSpent = monthlyExpenseTotal(wallet.entries);
  const budgetUsedPct = boundedProgress(totalSpent, wallet.monthlyBudget);
  const wishPct = boundedProgress(wallet.wishSaved, wallet.wishTarget);
  const wishes = wallet.wishes || [];
  const visibleEntries = showAllEntries ? wallet.entries : wallet.entries.slice(0, 6);

  const renderDeleteConfirm = (prompt: string, onConfirm: () => void, onCancel: () => void) => (
    <div className="flex items-center justify-between gap-2 pt-2 border-t border-[var(--line-hairline)]">
      <span className="text-xs text-[var(--danger-ink)]">{prompt}</span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onConfirm}
          className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg bg-[var(--danger-ink)] text-[#FFFCF6] text-xs font-semibold cursor-pointer"
        >
          {t('common.confirm')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg text-xs text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] cursor-pointer"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full min-h-[420px] md:h-[460px] rounded-2xl shadow-sm overflow-hidden border border-[var(--line-hairline)] bg-[var(--surface-card)] text-[var(--ink-primary)] transition-colors duration-200">
      {/* 顶部子导航栏 */}
      <div className="px-3 py-2 border-b border-[var(--line-hairline)] bg-[var(--surface-subtle)] flex items-center justify-between gap-1 overflow-x-auto no-drag shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setActiveSubTab('wallet')}
            className={`min-h-[var(--touch-target-min,34px)] flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
              activeSubTab === 'wallet'
                ? 'bg-[var(--accent-primary)] text-[#FFFCF6]'
                : 'text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]'
            }`}
          >
            <Wallet size={13} />
            <span>{t('cards.tabWallet')}</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveSubTab('relationships')}
            className={`min-h-[var(--touch-target-min,34px)] flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
              activeSubTab === 'relationships'
                ? 'bg-[var(--accent-primary)] text-[#FFFCF6]'
                : 'text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]'
            }`}
          >
            <Users size={13} />
            <span>{t('cards.tabRelationships')}</span>
          </button>
          {customCards.length > 0 && (
            <button
              type="button"
              onClick={() => setActiveSubTab('custom')}
              className={`min-h-[var(--touch-target-min,34px)] flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                activeSubTab === 'custom'
                  ? 'bg-[var(--accent-primary)] text-[#FFFCF6]'
                  : 'text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]'
              }`}
            >
              <Sparkles size={13} />
              <span>{t('cards.tabCustom', { count: customCards.length })}</span>
            </button>
          )}
        </div>
      </div>

      {/* 主体内容区 */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
        {/* ==================== 1: 随口记账与心愿小金库 ==================== */}
        {activeSubTab === 'wallet' && (
          <div className="space-y-3">
            {walletError && (
              <div
                className="px-3 py-2 rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] text-xs text-[var(--danger-ink)] flex items-center justify-between gap-2"
                role="alert"
              >
                <span>{walletError}</span>
                <button
                  type="button"
                  onClick={() => setWalletError('')}
                  className="text-xs font-semibold underline cursor-pointer shrink-0"
                >
                  {t('common.collapse')}
                </button>
              </div>
            )}

            {/* 月度预算 */}
            <div className="p-3 rounded-xl bg-[var(--bg-paper)] border border-[var(--line-hairline)] space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-[var(--ink-primary)]">{t('cards.monthlyBudgetHeading')}</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[var(--accent-primary)] font-bold tabular-nums">
                    {tr('cards.budgetSummaryFormatted', {
                      zh: '已支出 {spent} / 预算 {budget}',
                      en: 'Spent {spent} / Budget {budget}',
                    }, {
                      spent: formatBudgetAmount(Math.round(totalSpent), lang),
                      budget: formatBudgetAmount(wallet.monthlyBudget, lang),
                    })}
                  </span>
                  <button
                    type="button"
                    aria-label={tr('cards.editBudgetAria', { zh: '编辑月度预算', en: 'Edit monthly budget' })}
                    onClick={() => {
                      setEditingBudget(!editingBudget);
                      setBudgetInput(String(wallet.monthlyBudget));
                      setWalletError('');
                    }}
                    className="min-h-[var(--touch-target-min,34px)] min-w-[var(--touch-target-min,34px)] p-1.5 rounded-lg text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)] flex items-center justify-center cursor-pointer"
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="w-full h-2.5 bg-[var(--surface-subtle)] border border-[var(--line-hairline)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--accent-primary)] transition-all duration-500"
                  style={{ width: `${budgetUsedPct}%` }}
                />
              </div>

              <p className="text-xs text-[var(--ink-muted)] tabular-nums">
                {tr('cards.recentWindowHint', {
                  zh: '按最近 {count} 条已加载流水统计',
                  en: 'Based on the latest {count} loaded entries',
                }, { count: wallet.entries.length })}
              </p>

              {editingBudget && (
                <form onSubmit={handleSaveBudget} className="flex flex-wrap items-center gap-2 pt-1.5 border-t border-[var(--line-hairline)]">
                  <input
                    type="number"
                    min={0}
                    step="any"
                    aria-label={tr('cards.budgetInputAria', { zh: '月度预算金额', en: 'Monthly budget amount' })}
                    value={budgetInput}
                    onChange={e => setBudgetInput(e.target.value)}
                    style={{ width: '120px' }}
                    className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)] tabular-nums"
                  />
                  <button
                    type="submit"
                    className="min-h-[var(--touch-target-min,34px)] px-3 py-1 rounded-lg bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-[#FFFCF6] text-xs font-semibold cursor-pointer"
                  >
                    {t('common.save')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingBudget(false)}
                    className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg text-xs text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    {t('common.cancel')}
                  </button>
                </form>
              )}
            </div>

            {/* 心愿攒钱罐 */}
            <div className="p-3 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent-border)] space-y-2.5">
              {wishes.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {wishes.map(w => (
                    <button
                      type="button"
                      key={w.id}
                      onClick={() => handleSwitchWish(w.id)}
                      className={`min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer transition-colors ${
                        w.id === wallet.activeWishId
                          ? 'bg-[var(--accent-primary)] text-[#FFFCF6] border-[var(--accent-primary)]'
                          : 'bg-[var(--surface-card)] text-[var(--ink-primary)] border-[var(--line-hairline)] hover:bg-[var(--surface-hover)]'
                      }`}
                    >
                      {w.title}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <div className="space-y-1 flex-1 min-w-0 pr-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-[var(--ink-primary)] truncate">{wallet.wishTitle}</span>
                    <span className="font-mono text-xs font-semibold text-[var(--accent-primary)] tabular-nums shrink-0">{wishPct}%</span>
                  </div>
                  <div className="w-full h-2 bg-[var(--surface-card)] border border-[var(--line-hairline)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#2B6B43] transition-all duration-500"
                      style={{ width: `${wishPct}%` }}
                    />
                  </div>
                  <span className="text-xs text-[var(--ink-muted)] block tabular-nums">
                    {tr('cards.wishSavedFormatted', {
                      zh: '已攒 {saved} / 目标 {target}',
                      en: 'Saved {saved} / Target {target}',
                    }, {
                      saved: formatBudgetAmount(wallet.wishSaved, lang),
                      target: formatBudgetAmount(wallet.wishTarget, lang),
                    })}
                  </span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={handleQuickSaveWish}
                    className="min-h-[var(--touch-target-min,34px)] px-3 py-1.5 rounded-lg bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-[#FFFCF6] text-xs font-semibold cursor-pointer"
                  >
                    {t('cards.quickSaveBtn')}
                  </button>
                  <button
                    type="button"
                    aria-label={tr('cards.editWishAria', { zh: '编辑当前心愿', en: 'Edit active wish' })}
                    onClick={() => {
                      setEditingWish(!editingWish);
                      setAddingWish(false);
                      setWishTitleInput(wallet.wishTitle);
                      setWishTargetInput(String(wallet.wishTarget));
                      setWalletError('');
                    }}
                    className="min-h-[var(--touch-target-min,34px)] min-w-[var(--touch-target-min,34px)] p-1.5 rounded-lg bg-[var(--surface-card)] border border-[var(--line-hairline)] text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)] flex items-center justify-center cursor-pointer"
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                </div>
              </div>

              {/* 自定义存入金额与新增心愿触发 */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-[var(--accent-border)]">
                <form onSubmit={handleCustomDeposit} className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0.01}
                    step="any"
                    aria-label={tr('cards.customDepositAria', { zh: '自定义存入金额', en: 'Custom deposit amount' })}
                    placeholder={tr('cards.customDepositPlaceholder', { zh: '自定义金额', en: 'Amount' })}
                    value={customSaveInput}
                    onChange={e => setCustomSaveInput(e.target.value)}
                    style={{ width: '110px' }}
                    className="min-h-[var(--touch-target-min,34px)] px-2 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)] tabular-nums"
                  />
                  <button
                    type="submit"
                    className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg bg-[var(--surface-card)] border border-[var(--line-hairline)] text-xs font-medium text-[var(--accent-primary)] hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    {tr('cards.depositBtn', { zh: '+ 存入', en: '+ Deposit' })}
                  </button>
                </form>

                <button
                  type="button"
                  onClick={() => {
                    setAddingWish(!addingWish);
                    setEditingWish(false);
                    setWalletError('');
                  }}
                  className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--accent-primary)] hover:bg-[var(--surface-hover)] cursor-pointer flex items-center gap-1"
                >
                  <Plus size={12} aria-hidden="true" />
                  <span>{tr('cards.newWishBtn', { zh: '新心愿', en: 'New Wish' })}</span>
                </button>
              </div>

              {editingWish && (
                <form onSubmit={handleSaveActiveWish} className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--accent-border)]">
                  <input
                    type="text"
                    maxLength={40}
                    aria-label={tr('cards.wishTitleInputAria', { zh: '心愿名称', en: 'Wish title' })}
                    placeholder={tr('cards.wishTitlePlaceholder', { zh: '心愿名称', en: 'Wish title' })}
                    value={wishTitleInput}
                    onChange={e => setWishTitleInput(e.target.value)}
                    className="flex-1 min-w-[120px] min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)]"
                  />
                  <input
                    type="number"
                    min={1}
                    step="any"
                    aria-label={tr('cards.wishTargetInputAria', { zh: '心愿目标金额', en: 'Wish target amount' })}
                    placeholder={tr('cards.wishTargetPlaceholder', { zh: '目标金额', en: 'Target' })}
                    value={wishTargetInput}
                    onChange={e => setWishTargetInput(e.target.value)}
                    style={{ width: '110px' }}
                    className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)] tabular-nums"
                  />
                  <button
                    type="submit"
                    className="min-h-[var(--touch-target-min,34px)] px-3 py-1 rounded-lg bg-[var(--accent-primary)] text-[#FFFCF6] text-xs font-semibold cursor-pointer"
                  >
                    {t('common.save')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingWish(false)}
                    className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg text-xs text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    {t('common.cancel')}
                  </button>
                </form>
              )}

              {addingWish && (
                <form onSubmit={handleAddWish} className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--accent-border)]">
                  <input
                    type="text"
                    maxLength={40}
                    aria-label={tr('cards.newWishTitleAria', { zh: '新心愿名称', en: 'New wish title' })}
                    placeholder={tr('cards.newWishTitlePlaceholder', { zh: '想攒什么？（如：旅行基金）', en: 'Wish name (e.g. Trip fund)' })}
                    value={newWishTitle}
                    onChange={e => setNewWishTitle(e.target.value)}
                    className="flex-1 min-w-[130px] min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)]"
                  />
                  <input
                    type="number"
                    min={1}
                    step="any"
                    aria-label={tr('cards.newWishTargetAria', { zh: '新心愿目标金额', en: 'New wish target amount' })}
                    placeholder={tr('cards.wishTargetPlaceholder', { zh: '目标金额', en: 'Target' })}
                    value={newWishTarget}
                    onChange={e => setNewWishTarget(e.target.value)}
                    style={{ width: '110px' }}
                    className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)] tabular-nums"
                  />
                  <button
                    type="submit"
                    className="min-h-[var(--touch-target-min,34px)] px-3 py-1 rounded-lg bg-[var(--accent-primary)] text-[#FFFCF6] text-xs font-semibold cursor-pointer"
                  >
                    {tr('cards.createWishBtn', { zh: '创建并切换', en: 'Create & Switch' })}
                  </button>
                </form>
              )}
            </div>

            {/* 近期流水与手动记一笔 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-xs font-semibold text-[var(--ink-muted)]">{t('cards.recentEntriesTitle')}</span>
                <button
                  type="button"
                  onClick={() => {
                    setAddingEntry(!addingEntry);
                    setWalletError('');
                  }}
                  className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--bg-paper)] text-xs font-medium text-[var(--accent-primary)] hover:bg-[var(--surface-hover)] cursor-pointer flex items-center gap-1"
                >
                  <Plus size={12} aria-hidden="true" />
                  <span>{tr('cards.addEntryToggleBtn', { zh: '记一笔', en: 'Add Entry' })}</span>
                </button>
              </div>

              {addingEntry && (
                <form onSubmit={handleAddEntry} className="p-3 rounded-xl bg-[var(--bg-paper)] border border-[var(--line-hairline)] space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      type="text"
                      maxLength={40}
                      aria-label={tr('cards.entryTitleAria', { zh: '账单名称', en: 'Entry title' })}
                      placeholder={tr('cards.entryTitlePlaceholder', { zh: '例如：午饭 / 咖啡 / 工资', en: 'e.g. Lunch / Coffee / Salary' })}
                      value={entryTitle}
                      onChange={e => setEntryTitle(e.target.value)}
                      className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)]"
                    />
                    <input
                      type="number"
                      min={0.01}
                      step="any"
                      aria-label={tr('cards.entryAmountAria', { zh: '账单金额', en: 'Entry amount' })}
                      placeholder={tr('cards.entryAmountPlaceholder', { zh: '金额', en: 'Amount' })}
                      value={entryAmount}
                      onChange={e => setEntryAmount(e.target.value)}
                      className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)] tabular-nums"
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label={tr('cards.entryTypeAria', { zh: '账单类型', en: 'Entry type' })}
                        value={entryType}
                        onChange={e => setEntryType(e.target.value as ExpenseEntry['type'])}
                        style={{ width: 'auto' }}
                        className="min-h-[var(--touch-target-min,34px)] px-2 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)]"
                      >
                        <option value="expense">{tr('cards.entryTypeExpense', { zh: '支出', en: 'Expense' })}</option>
                        <option value="saving">{tr('cards.entryTypeSaving', { zh: '储蓄', en: 'Saving' })}</option>
                        <option value="income">{tr('cards.entryTypeIncome', { zh: '收入', en: 'Income' })}</option>
                      </select>
                      {entryType === 'expense' && (
                        <select
                          aria-label={tr('cards.entryCategoryAria', { zh: '账单分类', en: 'Category' })}
                          value={entryCategory}
                          onChange={e => setEntryCategory(e.target.value as ExpenseEntry['category'])}
                          style={{ width: 'auto' }}
                          className="min-h-[var(--touch-target-min,34px)] px-2 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)]"
                        >
                          {EXPENSE_CATEGORIES.map(cat => (
                            <option key={cat} value={cat}>{formatExpenseCategory(cat, lang)}</option>
                          ))}
                        </select>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="submit"
                        className="min-h-[var(--touch-target-min,34px)] px-3 py-1 rounded-lg bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-[#FFFCF6] text-xs font-semibold cursor-pointer"
                      >
                        {t('common.save')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddingEntry(false)}
                        className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg text-xs text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] cursor-pointer"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                </form>
              )}

              {wallet.entries.length === 0 ? (
                <div className="p-4 rounded-xl border border-dashed border-[var(--line-hairline)] bg-[var(--bg-paper)] text-center space-y-2">
                  <p className="text-xs font-semibold text-[var(--ink-primary)]">
                    {tr('cards.emptyEntriesTitle', { zh: '还没有生活账单记录', en: 'No ledger entries yet' })}
                  </p>
                  <p className="text-xs text-[var(--ink-muted)] leading-relaxed">
                    {tr('cards.emptyEntriesHint', {
                      zh: '在「随口说」里说“今天花了35吃午饭”，或点上方「记一笔」手动添加。',
                      en: 'Mention spending/savings in Quick Note, or click "Add Entry" above.',
                    })}
                  </p>
                </div>
              ) : (
                <>
                  {visibleEntries.map((item) => {
                    const isPositive = item.type === 'saving' || item.type === 'income';
                    const isConfirming = confirmDeleteEntryId === item.id;
                    return (
                      <div
                        key={item.id}
                        className="px-3 py-2 rounded-xl bg-[var(--bg-paper)] border border-[var(--line-hairline)] space-y-1.5 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="px-2 py-0.5 rounded bg-[var(--surface-subtle)] border border-[var(--line-hairline)] text-xs text-[var(--accent-primary)] shrink-0">
                              {formatExpenseCategory(item.category, lang)}
                            </span>
                            <span className="font-medium text-[var(--ink-primary)] truncate">{item.title}</span>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span
                              className={`font-mono font-semibold tabular-nums ${
                                isPositive ? 'text-[#215936]' : 'text-[var(--ink-primary)]'
                              }`}
                            >
                              {isPositive ? `+${formatBudgetAmount(item.amount, lang)}` : `-${formatBudgetAmount(item.amount, lang)}`}
                            </span>
                            <button
                              type="button"
                              aria-label={tr('cards.deleteEntryAria', { zh: '删除记录 {title}', en: 'Delete entry {title}' }, { title: item.title })}
                              onClick={() => setConfirmDeleteEntryId(isConfirming ? null : item.id)}
                              className="min-h-[var(--touch-target-min,34px)] min-w-[var(--touch-target-min,34px)] p-1.5 rounded-lg text-[var(--ink-muted)] hover:text-[var(--danger-ink)] hover:bg-[var(--danger-soft)] flex items-center justify-center cursor-pointer"
                            >
                              <Trash2 size={13} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                        {isConfirming && renderDeleteConfirm(
                          tr('cards.confirmDeleteEntryPrompt', { zh: '确认删除这条流水？', en: 'Delete this entry?' }),
                          () => handleDeleteEntry(item),
                          () => setConfirmDeleteEntryId(null),
                        )}
                      </div>
                    );
                  })}
                  {wallet.entries.length > 6 && (
                    <button
                      type="button"
                      onClick={() => setShowAllEntries(!showAllEntries)}
                      className="w-full min-h-[var(--touch-target-min,34px)] py-1.5 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs font-medium text-[var(--accent-primary)] hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      {showAllEntries
                        ? tr('cards.collapseEntriesBtn', { zh: '收起部分流水', en: 'Show fewer' })
                        : tr('cards.showAllEntriesBtn', {
                            zh: '查看全部 ({count})',
                            en: 'View all ({count})',
                          }, { count: wallet.entries.length })}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* ==================== 2: 人脉与亲友档案簿 ==================== */}
        {activeSubTab === 'relationships' && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[var(--ink-muted)]">
                {tr('cards.personsCountLabel', { zh: '亲友档案 ({count})', en: 'Contacts ({count})' }, { count: persons.length })}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (addingPerson) {
                    resetPersonForm();
                  } else {
                    resetPersonForm();
                    setAddingPerson(true);
                  }
                }}
                className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--bg-paper)] text-xs font-medium text-[var(--accent-primary)] hover:bg-[var(--surface-hover)] cursor-pointer flex items-center gap-1"
              >
                <Plus size={12} aria-hidden="true" />
                <span>{tr('cards.addPersonBtn', { zh: '添加亲友', en: 'Add Contact' })}</span>
              </button>
            </div>

            {personError && (
              <p className="px-3 py-2 rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] text-xs text-[var(--danger-ink)]" role="alert">
                {personError}
              </p>
            )}

            {(addingPerson || editingPersonId) && (
              <form onSubmit={handleSavePerson} className="p-3 rounded-xl bg-[var(--bg-paper)] border border-[var(--line-hairline)] space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="text"
                    maxLength={40}
                    aria-label={tr('cards.personNameAria', { zh: '亲友姓名或称呼', en: 'Contact name' })}
                    placeholder={tr('cards.personNamePlaceholder', { zh: '姓名 / 称呼（如：妈妈）', en: 'Name (e.g. Mom)' })}
                    value={personName}
                    onChange={e => setPersonName(e.target.value)}
                    className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)]"
                  />
                  <input
                    type="text"
                    maxLength={24}
                    aria-label={tr('cards.personRelationAria', { zh: '关系标签', en: 'Relation' })}
                    placeholder={tr('cards.personRelationPlaceholder', { zh: '关系（如：家人 / 朋友）', en: 'Relation (e.g. Family)' })}
                    value={personRelation}
                    onChange={e => setPersonRelation(e.target.value)}
                    className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)]"
                  />
                </div>
                <input
                  type="text"
                  aria-label={tr('cards.personTaboosAria', { zh: '忌口或雷区', en: 'Avoid / taboos' })}
                  placeholder={tr('cards.personTaboosPlaceholder', { zh: '忌口 / 雷区（顿号或逗号分隔）', en: 'Avoid / taboos (comma-separated)' })}
                  value={personTaboos}
                  onChange={e => setPersonTaboos(e.target.value)}
                  className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)]"
                />
                <input
                  type="text"
                  aria-label={tr('cards.personPrefsAria', { zh: '喜好或心愿', en: 'Likes / preferences' })}
                  placeholder={tr('cards.personPrefsPlaceholder', { zh: '喜好 / 心愿（顿号或逗号分隔）', en: 'Likes / gifts (comma-separated)' })}
                  value={personPrefs}
                  onChange={e => setPersonPrefs(e.target.value)}
                  className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)]"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <input
                    type="text"
                    maxLength={40}
                    aria-label={tr('cards.personDateAria', { zh: '重要日期或生日', en: 'Birthday or key date' })}
                    placeholder={tr('cards.personDatePlaceholder', { zh: '重要日期（如：6月12日 生日）', en: 'Key date (e.g. Jun 12 Birthday)' })}
                    value={personDate}
                    onChange={e => setPersonDate(e.target.value)}
                    className="flex-1 min-w-[140px] min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)]"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      type="submit"
                      className="min-h-[var(--touch-target-min,34px)] px-3 py-1 rounded-lg bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-[#FFFCF6] text-xs font-semibold cursor-pointer"
                    >
                      {t('common.save')}
                    </button>
                    <button
                      type="button"
                      onClick={resetPersonForm}
                      className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg text-xs text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              </form>
            )}

            {persons.length === 0 ? (
              <div className="p-4 rounded-xl border border-dashed border-[var(--line-hairline)] bg-[var(--bg-paper)] text-center space-y-2">
                <p className="text-xs font-semibold text-[var(--ink-primary)]">
                  {tr('cards.emptyPersonsTitle', { zh: '还没有记录亲友档案', en: 'No contact notes yet' })}
                </p>
                <p className="text-xs text-[var(--ink-muted)] leading-relaxed">
                  {tr('cards.emptyPersonsHint', {
                    zh: '在「随口说」里说“妈妈不吃香菜，喜欢白茶”，或点击右上角「添加亲友」。',
                    en: 'Mention preferences in Quick Note (e.g. "Mom dislikes cilantro"), or click "Add Contact".',
                  })}
                </p>
              </div>
            ) : (
              persons.map((p) => {
                const isConfirming = confirmDeletePersonId === p.id;
                return (
                  <div
                    key={p.id}
                    className="p-3 rounded-xl bg-[var(--bg-paper)] border border-[var(--line-hairline)] space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <span className="text-sm font-bold text-[var(--ink-primary)]">{p.name}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--surface-subtle)] border border-[var(--line-hairline)] text-[var(--accent-primary)]">
                          {p.relation}
                        </span>
                        {p.nextImportantDate && (
                          <span className="inline-flex items-center gap-1 text-xs font-mono text-[var(--danger-ink)] bg-[var(--danger-soft)] border border-[var(--danger-line)] px-2 py-0.5 rounded tabular-nums">
                            <Calendar size={12} aria-hidden="true" />
                            <span>{p.nextImportantDate}</span>
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          aria-label={tr('cards.editPersonAria', { zh: '编辑 {name}', en: 'Edit {name}' }, { name: p.name })}
                          onClick={() => openPersonEdit(p)}
                          className="min-h-[var(--touch-target-min,34px)] min-w-[var(--touch-target-min,34px)] p-1.5 rounded-lg text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)] flex items-center justify-center cursor-pointer"
                        >
                          <Pencil size={13} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={tr('cards.deletePersonAria', { zh: '删除 {name}', en: 'Delete {name}' }, { name: p.name })}
                          onClick={() => setConfirmDeletePersonId(isConfirming ? null : p.id)}
                          className="min-h-[var(--touch-target-min,34px)] min-w-[var(--touch-target-min,34px)] p-1.5 rounded-lg text-[var(--ink-muted)] hover:text-[var(--danger-ink)] hover:bg-[var(--danger-soft)] flex items-center justify-center cursor-pointer"
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    {p.taboos.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 items-center text-xs">
                        <span className="text-[var(--danger-ink)] font-semibold">{t('cards.taboosLabel')}</span>
                        {p.taboos.map((taboo, i) => (
                          <span key={i} className="px-2 py-0.5 rounded bg-[var(--danger-soft)] text-[var(--danger-ink)] border border-[var(--danger-line)]">
                            {taboo}
                          </span>
                        ))}
                      </div>
                    )}

                    {p.preferences.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 items-center text-xs">
                        <span className="text-[#215936] font-semibold">{t('cards.preferencesLabel')}</span>
                        {p.preferences.map((pref, i) => (
                          <span
                            key={i}
                            className="px-2 py-0.5 rounded bg-[#EDF5EE] text-[#215936] border border-[#B7D3BF]"
                          >
                            {pref}
                          </span>
                        ))}
                      </div>
                    )}

                    {isConfirming && renderDeleteConfirm(
                      tr('cards.confirmDeletePersonPrompt', { zh: '确认删除「{name}」档案？', en: 'Delete "{name}"?' }, { name: p.name }),
                      () => handleDeletePerson(p),
                      () => setConfirmDeletePersonId(null),
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ==================== 3: 自定义活体卡 ==================== */}
        {activeSubTab === 'custom' && (
          <div className="space-y-3">
            {customCards.map((c) => {
              const pct = boundedProgress(c.metricValue, c.metricTarget);
              const stepText = customStepInputs[c.id] ?? '10';
              const stepValue = getCustomStep(c.id);
              const isEditingVal = editingCustomId === c.id;
              return (
                <div
                  key={c.id}
                  className="p-3.5 rounded-xl border border-[var(--line-hairline)] bg-[var(--bg-paper)] space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-bold text-[var(--ink-primary)]">
                      {c.icon} {c.title}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-mono font-bold text-[var(--accent-primary)] tabular-nums">
                        {c.metricValue} / {c.metricTarget} {c.unit} ({pct}%)
                      </span>
                      <button
                        type="button"
                        aria-label={tr('cards.editCustomValueAria', { zh: '直接设置 {title} 数值', en: 'Set value for {title}' }, { title: c.title })}
                        onClick={() => {
                          if (isEditingVal) {
                            setEditingCustomId(null);
                          } else {
                            setEditingCustomId(c.id);
                            setEditingCustomValue(String(c.metricValue));
                          }
                        }}
                        className="min-h-[var(--touch-target-min,34px)] min-w-[var(--touch-target-min,34px)] p-1.5 rounded-lg text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)] flex items-center justify-center cursor-pointer"
                      >
                        <Pencil size={13} aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  <div className="w-full h-2 bg-[var(--surface-subtle)] border border-[var(--line-hairline)] rounded-full overflow-hidden">
                    <div className="h-full bg-[var(--accent-primary)] transition-all duration-300" style={{ width: `${pct}%` }} />
                  </div>

                  {isEditingVal && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <input
                        type="number"
                        min={0}
                        max={c.metricTarget}
                        aria-label={tr('cards.customDirectInputAria', { zh: '当前进度值', en: 'Current progress value' })}
                        value={editingCustomValue}
                        onChange={e => setEditingCustomValue(e.target.value)}
                        style={{ width: '110px' }}
                        className="min-h-[var(--touch-target-min,34px)] px-2 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-[var(--ink-primary)] tabular-nums"
                      />
                      <button
                        type="button"
                        onClick={() => handleSetCustomCardValue(c, editingCustomValue)}
                        className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg bg-[var(--accent-primary)] text-[#FFFCF6] text-xs font-semibold cursor-pointer inline-flex items-center gap-1"
                      >
                        <Check size={12} aria-hidden="true" />
                        <span>{t('common.save')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingCustomId(null)}
                        className="min-h-[var(--touch-target-min,34px)] px-2 py-1 rounded-lg text-xs text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] cursor-pointer inline-flex items-center gap-1"
                      >
                        <X size={12} aria-hidden="true" />
                        <span>{t('common.cancel')}</span>
                      </button>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <div className="flex items-center gap-1.5">
                      {[1, 5, 10].map((quickStep) => (
                        <button
                          type="button"
                          key={quickStep}
                          onClick={() => handleAdvanceCustomCard(c, quickStep)}
                          className="min-h-[var(--touch-target-min,34px)] px-2.5 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs font-medium text-[var(--ink-primary)] hover:bg-[var(--surface-hover)] cursor-pointer tabular-nums"
                        >
                          +{quickStep}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={1}
                        aria-label={tr('cards.customStepAria', { zh: '自定义步长', en: 'Custom step' })}
                        value={stepText}
                        onChange={(e) => setCustomStepInputs(prev => ({ ...prev, [c.id]: e.target.value }))}
                        onBlur={() => {
                          const normalized = getCustomStep(c.id);
                          setCustomStepInputs(prev => ({ ...prev, [c.id]: String(normalized) }));
                        }}
                        style={{ width: '72px' }}
                        className="min-h-[var(--touch-target-min,34px)] px-2 py-1 rounded-lg border border-[var(--line-hairline)] bg-[var(--surface-card)] text-xs text-center text-[var(--ink-primary)] tabular-nums"
                      />
                      <button
                        type="button"
                        onClick={() => handleAdvanceCustomCard(c, stepValue)}
                        className="min-h-[var(--touch-target-min,34px)] px-3 py-1 rounded-lg bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-[#FFFCF6] text-xs font-semibold cursor-pointer"
                      >
                        {t('cards.customAdvanceBtn')}
                      </button>
                    </div>
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
