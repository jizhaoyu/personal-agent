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
  dateKey?: string;
  lastActivityDate?: string;
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
  engagementId?: string;
  dueAt?: string;
  sourceDeadlineText?: string;
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
  /** Only accepted during migration; never stored in the v3 application snapshot. */
  apiKey?: string;
  apiBaseUrl: string;
  modelName: string;
  personaName: string;
  personaAvatar: string;
  personaGreeting: string;
  systemPrompt: string;
  alwaysOnTop: boolean;
  modelEnabled?: boolean;
  remindersEnabled?: boolean;
  memoryModelEnabled?: boolean;
}

export type PublicAppSettings = Omit<AppSettings, 'apiKey'>;

export interface Engagement {
  id: string;
  clientName: string;
  title: string;
  budgetAmount?: number;
  stage: DealStage;
  internalContext: string;
  shareableSummary: string;
  nextAction: string;
  updatedAt: number;
}

export type WorkOperation =
  | { target: 'engagement'; entityId: string; before: Engagement | null; after: Engagement | null }
  | { target: 'task'; entityId: string; before: ProjectTaskItem | null; after: ProjectTaskItem | null }
  | { target: 'memory'; entityId: string; before: MemoryItem | null; after: MemoryItem | null }
  | { target: 'followup'; entityId: string; before: FollowUpItem | null; after: FollowUpItem | null };

export interface ProposedChangeSet {
  id: string;
  sourceMessageId: string;
  sourceText: string;
  mode: WorkspaceMode;
  baseRevision: number;
  operations: WorkOperation[];
  warnings: string[];
  createdAt: number;
  clarification?: { kind: 'project'; message: string };
}

export interface CommittedChangeEvent {
  id: string;
  proposalId: string;
  mode: WorkspaceMode;
  sourceMessageId: string;
  sourceText: string;
  operations: WorkOperation[];
  createdAt: number;
  revertedAt?: number;
}

export interface PartitionBase {
  revision: number;
  messages: Message[];
  memories: MemoryItem[];
  journals: JournalArtifact[];
  customCards: CustomLivingCard[];
  events: CommittedChangeEvent[];
  processedProposalIds: string[];
}

export interface WorkPartition extends PartitionBase {
  engagements: Engagement[];
  tasks: ProjectTaskItem[];
  followUps?: FollowUpItem[];
  closures?: ClosureRecord[];
}

export interface FollowUpItem {
  id: string;
  kind: 'waiting' | 'question';
  title: string;
  engagementId?: string;
  status: 'open' | 'resolved';
  sourceMessageId: string;
  createdAt: number;
  updatedAt: number;
  expectedDate?: string;
  expectedAt?: string;
  sourceDateText?: string;
  reviewAt?: string;
}
export interface ProposalConflict {
  id: string;
  target: WorkOperation['target'];
  entityId: string;
  field: string;
  original: unknown;
  current: unknown;
  proposed: unknown;
}
export interface CaptureDraft {
  id: 'active-work';
  sessionId: string;
  mode: 'work';
  text: string;
  selectedEngagementId?: string;
  newClientName?: string;
  newProjectTitle?: string;
  sourceVersion: number;
  draftVersion: number;
  sourceMessageId: string;
  proposal?: ProposedChangeSet;
  conflicts?: ProposalConflict[];
  status: 'editing' | 'review';
  updatedAt: number;
}
export interface ClosureRecord {
  id: string;
  mode: 'work';
  sourceMessageId: string;
  eventId: string;
  engagementIds: string[];
  taskIds: string[];
  followUpIds: string[];
  confirmedAt: number;
  revertedAt?: number;
  originalOnly?: boolean;
}
export interface WorkHome {
  draft: CaptureDraft | null;
  today: ProjectTaskItem[];
  overdue: ProjectTaskItem[];
  waiting: FollowUpItem[];
  questions: FollowUpItem[];
  recent: ClosureRecord[];
  counts: { today: number; overdue: number; waiting: number; questions: number };
}
export interface CaptureCommitResult {
  outcome: 'committed' | 'rejected' | 'unknown';
  closureId?: string;
  eventId?: string;
  error?: string;
  refreshWarning?: string;
}

export interface LifePartition extends PartitionBase {
  wallet: WalletCardState;
  rpg: RpgStatusCardState;
  persons: PersonProfile[];
}

export interface AppSnapshotV3 {
  schemaVersion: 3;
  snapshotRevision: number;
  activeMode: WorkspaceMode;
  settings: PublicAppSettings;
  partitions: { life: LifePartition; work: WorkPartition };
}

export interface MutationResult {
  ok: boolean;
  error?: string;
  receipts?: StateMutationReceipt[];
}

export interface AlignmentDraft {
  title: string;
  clientName: string;
  projectTitle: string;
  summary: string;
  actions: { title: string; dueAt?: string }[];
  budgetAmount?: number;
}
