export type WorkspaceMode = 'life' | 'work';

export interface StateMutationReceipt {
  id: string;
  mode: WorkspaceMode;
  targetCardType: 'wallet' | 'rpg_status' | 'relationships' | 'crm' | 'projects' | 'custom';
  targetCardTitle: string;
  summaryText: string;
  deltaBadge: string;
  timestamp: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  attachments?: string[];
  mutations?: StateMutationReceipt[];
  artifactRef?: {
    type: 'journal' | 'gomoku' | 'note';
    dataId: string;
  };
}

export interface MemoryItem {
  id: string;
  mode?: WorkspaceMode;
  category: 'preference' | 'habit' | 'experience' | 'person' | 'business';
  fact: string;
  sourceMessageId?: string;
  createdAt: number;
  importance: number;
}

export interface JournalArtifact {
  id: string;
  mode?: WorkspaceMode;
  date: string;
  title: string;
  mood: string;
  userGoldenQuote: string;
  aiReflection: string;
  photoUrl?: string;
  stickers: string[];
  createdAt: number;
}

// ==================== ToC 生活态 3 大王牌活体卡 ====================
export interface ExpenseEntry {
  id: string;
  title: string;
  amount: number;
  type: 'expense' | 'income' | 'saving';
  category: '餐饮☕' | '购物🛍️' | '出行🚕' | '娱乐🎮' | '生活🏠' | '金库✨';
  timestamp: number;
}

export interface WalletCardState {
  monthlyBudget: number;
  wishTitle: string;
  wishTarget: number;
  wishSaved: number;
  entries: ExpenseEntry[];
}

export interface RpgStatusCardState {
  energy: number;
  waterCups: number;
  weightKg: number;
  targetWeightKg: number;
  moodBuff: string;
  streakDays: number;
}

export interface PersonProfile {
  id: string;
  name: string;
  relation: string;
  taboos: string[];
  preferences: string[];
  nextImportantDate?: string;
  updatedAt: number;
}

// ==================== ToB 搞钱态 3 大王牌活体卡 ====================
export type DealStage = '初步接触' | '需求确认' | '方案报价' | '商务谈判' | '赢单成交';

export interface CrmDealItem {
  id: string;
  clientName: string;
  budgetAmount: number;
  stage: DealStage;
  winProbability: number;
  painPoints: string;
  internalBottomLine: string; // 内部底线（外发回执时自动脱敏隐藏）
  nextAction: string;
  updatedAt: number;
}

export interface ProjectTaskItem {
  id: string;
  title: string;
  assignee: string;
  deadline: string;
  priority: 'high' | 'medium' | 'low';
  done: boolean;
}

export interface CustomLivingCard {
  id: string;
  mode: WorkspaceMode;
  title: string;
  icon: string;
  metricLabel: string;
  metricValue: number;
  metricTarget: number;
  unit: string;
  checklist: { id: string; text: string; done: boolean }[];
}

export type GomokuPiece = 'black' | 'white' | null;

export interface GomokuState {
  board: GomokuPiece[][];
  currentTurn: 'black' | 'white';
  winner: 'black' | 'white' | 'draw' | null;
  history: [number, number][];
}

export interface AppSettings {
  apiKey: string;
  apiBaseUrl: string;
  modelName: string;
  personaName: string;
  personaAvatar: string;
  personaGreeting: string;
  systemPrompt: string;
  alwaysOnTop: boolean;
}
