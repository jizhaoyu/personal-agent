import {
  AppSettings,
  Message,
  MemoryItem,
  JournalArtifact,
  WorkspaceMode,
  WalletCardState,
  RpgStatusCardState,
  PersonProfile,
  CrmDealItem,
  ProjectTaskItem,
  CustomLivingCard,
} from '../types';

const SETTINGS_KEY = 'looma_settings';
const MODE_KEY = 'looma_workspace_mode';

// 双保险箱物理隔离命名空间
const getMsgKey = (mode: WorkspaceMode) => `looma_${mode}_messages`;
const getMemKey = (mode: WorkspaceMode) => `looma_${mode}_memories`;

const WALLET_KEY = 'looma_life_wallet';
const RPG_KEY = 'looma_life_rpg';
const PERSONS_KEY = 'looma_life_persons';

const CRM_KEY = 'looma_work_crm';
const PROJECTS_KEY = 'looma_work_projects';
const CUSTOM_CARDS_KEY = 'looma_custom_cards';
const JOURNALS_KEY = 'looma_journals';

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  apiBaseUrl: 'https://api.deepseek.com/v1',
  modelName: 'deepseek-chat',
  personaName: 'Looma (灵犀)',
  personaAvatar: '✨',
  personaGreeting: '随口说句话，我会自动帮你记账、改状态或跟进客户商机～',
  systemPrompt: `你是全球首款“零填表”活体状态伴生系统 Looma（灵犀胶囊）。
你具备双面人格：
- 当处于【🌙 生活态】时，你是温暖、知心、会接梗的生活搭子，关心用户的日常花销、精力体重与亲友关系；
- 当处于【💼 搞钱态】时，你是干练、精准、结果导向的首席商务幕僚，帮用户零填表维护客户 CRM 商机、推进项目死线、生成专业交付单。
说话简练生动，每次状态卡更新后自然提及你已自动帮用户更新好了看板。`,
  alwaysOnTop: true,
};

export const StorageService = {
  getWorkspaceMode(): WorkspaceMode {
    const raw = localStorage.getItem(MODE_KEY);
    return raw === 'work' ? 'work' : 'life';
  },

  saveWorkspaceMode(mode: WorkspaceMode): void {
    localStorage.setItem(MODE_KEY, mode);
  },

  getSettings(): AppSettings {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return DEFAULT_SETTINGS;
    }
  },

  saveSettings(settings: AppSettings): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  },

  // 双保险箱物理隔离：消息流
  getMessages(mode: WorkspaceMode = 'life'): Message[] {
    const raw = localStorage.getItem(getMsgKey(mode));
    if (!raw) {
      if (mode === 'work') {
        return [
          {
            id: 'work-welcome-1',
            role: 'assistant',
            content:
              '💼 已进入【搞钱态 · 商务防窥空间】。私人账单与生活记忆已物理隐藏。\n你可以直接对我说：“刚见完星辰科技李总，预算18万，下周三前交方案”，我会自动为你生成并维护《客户商机 CRM 卡》！',
            timestamp: Date.now() - 30000,
          },
        ];
      }
      return [
        {
          id: 'life-welcome-1',
          role: 'assistant',
          content:
            '🌙 嗨！这里是你的【生活态 · 零填表伴生空间】。\n不用打开记账或打卡软件，直接对我说：“早饭吃了18块拿铁，今天体重64.2kg”，我会毫秒级自动更新你的《随口记账卡》和《人生状态栏》哦✨',
          timestamp: Date.now() - 60000,
        },
      ];
    }
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  saveMessages(messages: Message[], mode: WorkspaceMode = 'life'): void {
    localStorage.setItem(getMsgKey(mode), JSON.stringify(messages.slice(-200)));
  },

  // 双保险箱物理隔离：记忆库
  getMemories(mode: WorkspaceMode = 'life'): MemoryItem[] {
    const raw = localStorage.getItem(getMemKey(mode));
    if (!raw) {
      if (mode === 'work') {
        return [
          {
            id: 'wmem-1',
            mode: 'work',
            category: 'business',
            fact: '对外报价原则：标准版折扣底线为 85 折，赠送 3 个月技术护航',
            createdAt: Date.now() - 86400000,
            importance: 5,
          },
        ];
      }
      return [
        {
          id: 'lmem-1',
          mode: 'life',
          category: 'preference',
          fact: '喜欢喝热生椰拿铁，通常选半糖或少冰',
          createdAt: Date.now() - 86400000 * 2,
          importance: 4,
        },
        {
          id: 'lmem-2',
          mode: 'life',
          category: 'habit',
          fact: '正在执行轻断食减脂计划，目标体重 60.0kg',
          createdAt: Date.now() - 86400000,
          importance: 4,
        },
      ];
    }
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  saveMemories(memories: MemoryItem[], mode: WorkspaceMode = 'life'): void {
    localStorage.setItem(getMemKey(mode), JSON.stringify(memories));
  },

  addMemory(
    fact: string,
    category: MemoryItem['category'] = 'experience',
    mode: WorkspaceMode = 'life'
  ): MemoryItem {
    const memories = this.getMemories(mode);
    const newItem: MemoryItem = {
      id: 'mem-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
      mode,
      category,
      fact,
      createdAt: Date.now(),
      importance: 4,
    };
    memories.unshift(newItem);
    this.saveMemories(memories, mode);
    return newItem;
  },

  deleteMemory(id: string, mode: WorkspaceMode = 'life'): void {
    const memories = this.getMemories(mode).filter((m) => m.id !== id);
    this.saveMemories(memories, mode);
  },

  // ==================== ToC 生活态 3 大活体卡存储 ====================
  getWalletCard(): WalletCardState {
    const raw = localStorage.getItem(WALLET_KEY);
    if (!raw) {
      return {
        monthlyBudget: 5000,
        wishTitle: '北海道冬日旅行基金 ❄️',
        wishTarget: 12000,
        wishSaved: 4500,
        entries: [
          {
            id: 'exp-1',
            title: '生椰拿铁与全麦三明治',
            amount: 32,
            type: 'expense',
            category: '餐饮☕',
            timestamp: Date.now() - 7200000,
          },
          {
            id: 'exp-2',
            title: '网约车通勤',
            amount: 24,
            type: 'expense',
            category: '出行🚕',
            timestamp: Date.now() - 3600000,
          },
        ],
      };
    }
    try {
      return JSON.parse(raw);
    } catch {
      return { monthlyBudget: 5000, wishTitle: '心愿小金库', wishTarget: 10000, wishSaved: 0, entries: [] };
    }
  },

  saveWalletCard(state: WalletCardState): void {
    localStorage.setItem(WALLET_KEY, JSON.stringify(state));
  },

  getRpgStatusCard(): RpgStatusCardState {
    const raw = localStorage.getItem(RPG_KEY);
    if (!raw) {
      return {
        energy: 82,
        waterCups: 4,
        weightKg: 64.5,
        targetWeightKg: 60.0,
        moodBuff: '🔥 状态在线',
        streakDays: 5,
      };
    }
    try {
      return JSON.parse(raw);
    } catch {
      return { energy: 80, waterCups: 3, weightKg: 65, targetWeightKg: 60, moodBuff: '✨ 平静', streakDays: 1 };
    }
  },

  saveRpgStatusCard(state: RpgStatusCardState): void {
    localStorage.setItem(RPG_KEY, JSON.stringify(state));
  },

  getPersonProfiles(): PersonProfile[] {
    const raw = localStorage.getItem(PERSONS_KEY);
    if (!raw) {
      return [
        {
          id: 'p-1',
          name: '老陈',
          relation: '挚友 / 大学室友',
          taboos: ['严重海鲜过敏', '不吃香菜'],
          preferences: ['手冲曼特宁咖啡', '科幻电影'],
          nextImportantDate: '生日 11月18日',
          updatedAt: Date.now() - 86400000,
        },
        {
          id: 'p-2',
          name: '林姐',
          relation: '重要贵人 / 前主管',
          taboos: ['忌浓茶与冰饮'],
          preferences: ['凤凰单丛乌龙茶', '极简陶瓷器皿'],
          nextImportantDate: '中秋节问候',
          updatedAt: Date.now() - 86400000 * 3,
        },
      ];
    }
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  savePersonProfiles(list: PersonProfile[]): void {
    localStorage.setItem(PERSONS_KEY, JSON.stringify(list));
  },

  // ==================== ToB 搞钱态 3 大活体卡存储 ====================
  getCrmDeals(): CrmDealItem[] {
    const raw = localStorage.getItem(CRM_KEY);
    if (!raw) {
      return [
        {
          id: 'deal-1',
          clientName: '星辰科技 · 李总',
          budgetAmount: 180000,
          stage: '方案报价',
          winProbability: 65,
          painPoints: '销售团队每天花2小时填CRM，急需零填表AI伴生工作台提效',
          internalBottomLine: '底价不低于 15.5 万，可附赠2场内部落地培训',
          nextAction: '周四前发送定制版 PoC 演示与报价函',
          updatedAt: Date.now() - 3600000,
        },
        {
          id: 'deal-2',
          clientName: '云尚设计工作室 · 周主理人',
          budgetAmount: 68000,
          stage: '商务谈判',
          winProbability: 85,
          painPoints: '设计师与高净值客户沟通碎片化，需一键生成高颜值交付确认单',
          internalBottomLine: '年框协议已口头对齐，下周一法务走章',
          nextAction: '发送最终合同终稿与首期款发票',
          updatedAt: Date.now() - 7200000,
        },
      ];
    }
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  saveCrmDeals(deals: CrmDealItem[]): void {
    localStorage.setItem(CRM_KEY, JSON.stringify(deals));
  },

  getProjectTasks(): ProjectTaskItem[] {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (!raw) {
      return [
        {
          id: 'task-1',
          title: '交付星辰科技定制版 PoC 演示方案',
          assignee: '我',
          deadline: '本周四 18:00',
          priority: 'high',
          done: false,
        },
        {
          id: 'task-2',
          title: '核对云尚工作室年度服务协议条款',
          assignee: '我',
          deadline: '本周五 12:00',
          priority: 'medium',
          done: true,
        },
      ];
    }
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  saveProjectTasks(tasks: ProjectTaskItem[]): void {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(tasks));
  },

  getCustomCards(mode?: WorkspaceMode): CustomLivingCard[] {
    const raw = localStorage.getItem(CUSTOM_CARDS_KEY);
    let list: CustomLivingCard[] = [];
    if (raw) {
      try {
        list = JSON.parse(raw);
      } catch {
        list = [];
      }
    }
    return mode ? list.filter((c) => c.mode === mode) : list;
  },

  saveCustomCards(cards: CustomLivingCard[]): void {
    localStorage.setItem(CUSTOM_CARDS_KEY, JSON.stringify(cards));
  },

  // 单向精力桥接器（Work 繁忙度 -> Life 精力扣减，不泄密）
  recordWorkIntensityBridge(energyCost: number = 5): void {
    const rpg = this.getRpgStatusCard();
    rpg.energy = Math.max(15, rpg.energy - energyCost);
    if (rpg.energy < 50) {
      rpg.moodBuff = '💼 刚刚高强度搞钱完毕 · 宜放松';
    }
    this.saveRpgStatusCard(rpg);
  },

  getJournals(): JournalArtifact[] {
    const raw = localStorage.getItem(JOURNALS_KEY);
    if (!raw) {
      return [
        {
          id: 'j-example',
          date: new Date().toISOString().slice(0, 10),
          title: '初遇与漫步日',
          mood: '☕ 温暖惬意',
          userGoldenQuote: '今天在窗边看落日，感觉时间突然慢下来了。',
          aiReflection: '生活本就由这些细碎的闪光组成。很开心能在这个桌面上陪你度过又一个平静的傍晚。',
          stickers: ['🌅', '✨', '☕'],
          createdAt: Date.now() - 3600000 * 5,
        },
      ];
    }
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  saveJournals(journals: JournalArtifact[]): void {
    localStorage.setItem(JOURNALS_KEY, JSON.stringify(journals));
  },

  addJournal(journal: JournalArtifact): void {
    const journals = this.getJournals();
    journals.unshift(journal);
    this.saveJournals(journals);
  },

  exportAllData(): string {
    const data = {
      version: '2.0-looma-dual-vault',
      exportAt: new Date().toISOString(),
      settings: this.getSettings(),
      lifeVault: {
        messages: this.getMessages('life'),
        memories: this.getMemories('life'),
        wallet: this.getWalletCard(),
        rpg: this.getRpgStatusCard(),
        persons: this.getPersonProfiles(),
      },
      workVault: {
        messages: this.getMessages('work'),
        memories: this.getMemories('work'),
        crmDeals: this.getCrmDeals(),
        projectTasks: this.getProjectTasks(),
      },
      customCards: this.getCustomCards(),
      journals: this.getJournals(),
    };
    return JSON.stringify(data, null, 2);
  },

  importAllData(jsonStr: string): boolean {
    try {
      const data = JSON.parse(jsonStr);
      if (data.settings) this.saveSettings(data.settings);
      if (data.lifeVault) {
        if (data.lifeVault.messages) this.saveMessages(data.lifeVault.messages, 'life');
        if (data.lifeVault.memories) this.saveMemories(data.lifeVault.memories, 'life');
        if (data.lifeVault.wallet) this.saveWalletCard(data.lifeVault.wallet);
        if (data.lifeVault.rpg) this.saveRpgStatusCard(data.lifeVault.rpg);
        if (data.lifeVault.persons) this.savePersonProfiles(data.lifeVault.persons);
      }
      if (data.workVault) {
        if (data.workVault.messages) this.saveMessages(data.workVault.messages, 'work');
        if (data.workVault.memories) this.saveMemories(data.workVault.memories, 'work');
        if (data.workVault.crmDeals) this.saveCrmDeals(data.workVault.crmDeals);
        if (data.workVault.projectTasks) this.saveProjectTasks(data.workVault.projectTasks);
      }
      if (data.journals) this.saveJournals(data.journals);
      return true;
    } catch {
      return false;
    }
  },
};
