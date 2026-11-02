export interface LoomaAndroidNative {
  readClipboard(): string;
  setContentProtection(enabled: boolean): boolean;
  isContentProtected(): boolean;
  getModelStatus(): string;
  saveModelConnection(payloadJson: string): string;
  clearModelConnection(): string;
  proposeModel(payloadJson: string): string;
  recallModel(payloadJson: string): string;
  notifyDue(count: number): boolean;
  minimizeApp(): void;
  closeApp(): void;
}

declare global {
  interface Window {
    LoomaAndroid?: LoomaAndroidNative;
  }
}

export function sanitizeAndroidClipboard(text: unknown): string {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 12000) return '';
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i.test(trimmed)) {
    return '[SECURITY INTERCEPT] 检测到包含私钥特征，底座已自动阻止载入待办，保护您的凭据安全。';
  }
  return trimmed;
}

export function createAndroidElectronAdapter(native: LoomaAndroidNative) {
  const quickCaptureListeners = new Set<(text: string) => void>();

  return {
    minimizeWindow: async () => { native.minimizeApp(); },
    closeWindow: async () => { native.closeApp(); },
    setCompact: async (compact: boolean) => ({ compact: !!compact }),
    onBeforeClose: () => () => {},
    confirmClose: async () => ({ closed: true }),
    setAlwaysOnTop: async () => false,
    isAlwaysOnTop: async () => false,
    setContentProtection: async (value: boolean) => !!native.setContentProtection(!!value),
    isContentProtected: async () => !!native.isContentProtected(),
    modelStatus: async (): Promise<ModelConnectionStatus> => {
      const raw = JSON.parse(native.getModelStatus() || '{}');
      return {
        configured: !!raw.configured,
        persistent: raw.persistent !== false,
        enabled: !!raw.enabled,
        apiBaseUrl: typeof raw.apiBaseUrl === 'string' ? raw.apiBaseUrl : 'https://api.deepseek.com/v1',
        modelName: typeof raw.modelName === 'string' ? raw.modelName : 'deepseek-chat',
      };
    },
    saveModelConnection: async (input: { apiBaseUrl: string; modelName: string; apiKey?: string; enabled: boolean }): Promise<ModelConnectionStatus> => {
      const raw = JSON.parse(native.saveModelConnection(JSON.stringify(input)) || '{}');
      if (raw.error) throw new Error(raw.error);
      return {
        configured: !!raw.configured,
        persistent: raw.persistent !== false,
        enabled: !!raw.enabled,
        apiBaseUrl: raw.apiBaseUrl || input.apiBaseUrl,
        modelName: raw.modelName || input.modelName,
      };
    },
    clearModelConnection: async () => {
      const raw = JSON.parse(native.clearModelConnection() || '{"cleared":true}');
      return { cleared: !!raw.cleared };
    },
    proposeModel: async (input: { requestId?: string; text: string; context: unknown; now: string }) => {
      const raw = JSON.parse(native.proposeModel(JSON.stringify(input)) || '{}');
      if (raw.error) throw new Error(raw.error);
      return { content: typeof raw.content === 'string' ? raw.content : '' };
    },
    recallModel: async (input: { requestId?: string; query: string; space: 'life' | 'work'; evidence: Array<{ id: string; kind: string; title: string; detail: string }> }) => {
      const raw = JSON.parse(native.recallModel(JSON.stringify(input)) || '{}');
      if (raw.error) throw new Error(raw.error);
      return { content: typeof raw.content === 'string' ? raw.content : '' };
    },
    cancelModel: async () => ({ canceled: true }),
    notifyDue: async (input: { count: number }) => ({
      shown: !!native.notifyDue(Math.max(0, Math.min(9999, Number(input?.count) || 0))),
    }),
    readClipboard: async () => sanitizeAndroidClipboard(native.readClipboard()),
    onQuickCapture: (handler: (text: string) => void) => {
      quickCaptureListeners.add(handler);
      return () => { quickCaptureListeners.delete(handler); };
    },
    emitQuickCapture: (rawText: string) => {
      const safe = sanitizeAndroidClipboard(rawText);
      if (!safe) return;
      for (const listener of quickCaptureListeners) {
        try { listener(safe); } catch { /* ignore listener errors */ }
      }
    },
  };
}

export function installAndroidBridge(targetWindow: any = typeof window !== 'undefined' ? window : undefined): boolean {
  if (!targetWindow || targetWindow.electronAPI || !targetWindow.LoomaAndroid) return false;
  const adapter = createAndroidElectronAdapter(targetWindow.LoomaAndroid);
  targetWindow.electronAPI = adapter;
  targetWindow.__loomaDispatchClipboard = (text: string) => adapter.emitQuickCapture(text);
  return true;
}
