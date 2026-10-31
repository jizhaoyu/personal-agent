export {};
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
      exportDataBackup?(): Promise<{canceled: boolean}>;
      importDataBackup?(): Promise<{canceled: boolean}>;
      modelStatus(): Promise<ModelConnectionStatus>;
      migrateLegacyConnection(config: {apiKey: string; apiBaseUrl: string; modelName: string}): Promise<{migrated: boolean}>;
      saveModelConnection(config: {apiKey?: string; apiBaseUrl: string; modelName: string; enabled: boolean}): Promise<ModelConnectionStatus>;
      clearModelConnection(): Promise<void>;
      proposeModel(input: {requestId: string; text: string; context: unknown; now: string}): Promise<{content: string}>;
      recallModel?(input: {requestId: string; query: string; space: 'life'|'work'; evidence: unknown[]}): Promise<{content: string}>;
      cancelModel(requestId: string): Promise<void>;
      notifyDue(input: {count: number}): Promise<{shown: boolean}>;
    };
  }
  interface ModelConnectionStatus { configured: boolean; persistent: boolean; enabled: boolean; apiBaseUrl: string; modelName: string }
}
