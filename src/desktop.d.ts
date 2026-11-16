export interface AgentModelInput {
  requestId: string; text: string; space: 'life'|'work'; now: string;
  context: { todos: Array<{id: string; space: 'life'|'work'; title: string; status: string; revision: number; dueAt?: string; dueDate?: string; needsTime?: boolean}>;
    turns: Array<{role: 'user'|'assistant'; content: string}>; contextTaskId?: string };
}
declare global {
  interface Window {
    electronAPI?: {
      minimizeWindow(): Promise<void>;
      closeWindow(): Promise<void>;
      onBeforeClose?(handler: (requestId: string) => void | Promise<void>): () => void;
      confirmClose?(success: boolean, requestId: string): Promise<{closed: boolean}>;
      resizeWindow(size: {width: number; height: number}): Promise<void>;
      setAlwaysOnTop(value: boolean): Promise<boolean>;
      setCompact?(value: boolean): Promise<{compact: boolean}>;
      storeRequest?(command: any): Promise<any>;
      todoRequest?(command: any): Promise<any>;
      onTodoFocus?(handler: (focus: {space: 'life'|'work'; id: string}) => void): () => void;
      exportDataBackup?(): Promise<{canceled: boolean}>;
      importDataBackup?(): Promise<{canceled: boolean}>;
      saveBackupFile?(suggestedName: string, content: string): Promise<{canceled: boolean}>;
      saveBinaryFile?(suggestedName: string, mimeType: string, dataOrBase64: string, isBase64?: boolean): Promise<{canceled: boolean}>;
      saveTextFile?(suggestedName: string, content: string): Promise<{canceled: boolean}>;
      shareImage?(base64Png: string, fileName: string, title?: string): Promise<{shared: boolean}>;
      getAppVersionInfo?(): Promise<{platform: 'android'|'desktop'; versionCode?: number; versionName?: string}>;
      checkForUpdates?(): Promise<{status: 'ok'|'no-release'|'rate-limited'|'error'; httpStatus?: number; message?: string; release?: unknown}>;
      openExternalUrl?(url: string): Promise<{opened: boolean; url?: string}>;
      modelStatus(): Promise<ModelConnectionStatus>;
      migrateLegacyConnection(config: {apiKey: string; apiBaseUrl: string; modelName: string}): Promise<{migrated: boolean}>;
      saveModelConnection(config: {apiKey?: string; apiBaseUrl: string; modelName: string; enabled: boolean}): Promise<ModelConnectionStatus>;
      clearModelConnection(): Promise<void>;
      proposeModel(input: {requestId: string; text: string; context: unknown; now: string}): Promise<{content: string}>;
      captureAgentModel(input: AgentModelInput): Promise<{content: string}>;
      recallModel?(input: {requestId: string; query: string; space: 'life'|'work'; evidence: unknown[]}): Promise<{content: string}>;
      cancelModel(requestId: string): Promise<void>;
      notifyDue(input: {count: number}): Promise<{shown: boolean}>;
      onQuickCapture?(handler: (text: string) => void): () => void;
      readClipboard?(): Promise<string>;
      setContentProtection?(value: boolean): Promise<boolean>;
      isContentProtected?(): Promise<boolean>;
    };
  }
  interface ModelConnectionStatus { configured: boolean; persistent: boolean; enabled: boolean; apiBaseUrl: string; modelName: string }
}
