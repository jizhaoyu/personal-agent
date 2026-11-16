import type { AgentModelInput } from '../desktop';

export interface LoomaAndroidNative {
  readClipboard(): string;
  setContentProtection(enabled: boolean): boolean;
  isContentProtected(): boolean;
  getModelStatus(): string;
  saveModelConnection(payloadJson: string): string;
  clearModelConnection(): string;
  proposeModel(payloadJson: string): string;
  captureAgentModel?(payloadJson: string): string;
  recallModel(payloadJson: string): string;
  notifyDue(count: number): boolean;
  todoRequest?(payloadJson: string): string;
  setSystemBarStyle?(isLightBackground: boolean): void;
  exportBackupDocument?(requestId: string, suggestedName: string, content: string): boolean;
  saveDocument?(requestId: string, suggestedName: string, mimeType: string, content: string, isBase64: boolean): boolean;
  shareImage?(base64Png: string, fileName: string, title: string): boolean;
  getAppVersionInfo?(): string;
  checkForUpdates?(requestId: string): boolean;
  openExternalUrl?(url: string): boolean;
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
  const todoFocusListeners = new Set<(focus: {space: 'life'|'work'; id: string}) => void>();
  const backupExports = new Map<string, { resolve: (res: { canceled: boolean }) => void; reject: (error: Error) => void }>();
  const updateChecks = new Map<string, { resolve: (res: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let backupSeq = 0;
  let updateSeq = 0;
  let pendingFocus: {space: 'life'|'work'; id: string} | undefined;

  const queueDocumentSave = (
    invoke: (requestId: string) => boolean,
    unavailableMessage = '无法调起系统文件保存器。',
  ): Promise<{ canceled: boolean }> => new Promise((resolve, reject) => {
    const requestId = `exp-${Date.now()}-${++backupSeq}`;
    backupExports.set(requestId, { resolve, reject });
    try {
      const started = invoke(requestId);
      if (!started) {
        backupExports.delete(requestId);
        reject(new Error(unavailableMessage));
      }
    } catch (error) {
      backupExports.delete(requestId);
      reject(error instanceof Error ? error : new Error('文件保存调起失败。'));
    }
  });

  return {
    todoRequest: async (command: any) => {
      if (!native.todoRequest) throw new Error('当前 Android 安装包尚不支持后台待办，请更新安装包。');
      return JSON.parse(native.todoRequest(JSON.stringify(command)) || '{"ok":false,"error":"待办响应为空"}');
    },
    onTodoFocus: (handler: (focus: {space: 'life'|'work'; id: string}) => void) => {
      todoFocusListeners.add(handler);
      if (pendingFocus) { const focus = pendingFocus; pendingFocus = undefined; queueMicrotask(() => { if (todoFocusListeners.has(handler)) handler(focus); else pendingFocus = focus; }); }
      return () => { todoFocusListeners.delete(handler); };
    },
    emitTodoFocus: (focus: {space: 'life'|'work'; id: string}) => {
      if (!focus || !['life','work'].includes(focus.space) || typeof focus.id !== 'string') return;
      if (!todoFocusListeners.size) { pendingFocus = focus; return; }
      for (const listener of todoFocusListeners) listener(focus);
    },
    minimizeWindow: async () => { native.minimizeApp(); },
    closeWindow: async () => { native.closeApp(); },
    setCompact: async (compact: boolean) => ({ compact: !!compact }),
    onBeforeClose: () => () => {},
    confirmClose: async () => ({ closed: true }),
    setAlwaysOnTop: async () => false,
    isAlwaysOnTop: async () => false,
    setContentProtection: async (value: boolean) => !!native.setContentProtection(!!value),
    isContentProtected: async () => !!native.isContentProtected(),
    setSystemBarStyle: async (isLightBackground: boolean) => {
      if (typeof native.setSystemBarStyle !== 'function') return false;
      native.setSystemBarStyle(!!isLightBackground);
      return true;
    },
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
    captureAgentModel: async (input: AgentModelInput): Promise<{content: string}> => {
      if (!native.captureAgentModel) throw new Error('当前 Android 安装包尚不支持随心记下增强，请更新安装包');
      const raw = JSON.parse(native.captureAgentModel(JSON.stringify(input)) || '{}');
      if (raw.error) throw new Error(raw.error);
      if (typeof raw.content !== 'string' || !raw.content.trim() || raw.content.length > 100000) throw new Error('模型返回格式无效');
      return {content: raw.content};
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
    ...(typeof native.exportBackupDocument === 'function' ? {
      saveBackupFile: (suggestedName: string, content: string): Promise<{ canceled: boolean }> =>
        queueDocumentSave(
          requestId => native.exportBackupDocument!(requestId, suggestedName, content),
          '无法调起系统备份文件保存器。',
        ),
    } : {}),
    ...(typeof native.saveDocument === 'function' ? {
      saveBinaryFile: (suggestedName: string, mimeType: string, dataOrBase64: string, isBase64 = true): Promise<{ canceled: boolean }> =>
        queueDocumentSave(
          requestId => native.saveDocument!(requestId, suggestedName, mimeType, dataOrBase64, isBase64 !== false),
        ),
      saveTextFile: (suggestedName: string, content: string): Promise<{ canceled: boolean }> => {
        const lower = (suggestedName || '').toLowerCase();
        const mimeType = lower.endsWith('.json') || lower.endsWith('.jsonl') ? 'application/json' : 'text/plain';
        return queueDocumentSave(
          requestId => native.saveDocument!(requestId, suggestedName, mimeType, content, false),
        );
      },
    } : {}),
    ...(typeof native.shareImage === 'function' ? {
      shareImage: async (base64Png: string, fileName: string, title?: string): Promise<{ shared: boolean }> => {
        try {
          return { shared: !!native.shareImage!(base64Png, fileName, title || '') };
        } catch {
          return { shared: false };
        }
      },
    } : {}),
    resolveBackupExport: (payload: { requestId?: string; ok?: boolean; canceled?: boolean; error?: string }) => {
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
      const entry = backupExports.get(requestId);
      if (!entry) return;
      backupExports.delete(requestId);
      if (payload?.canceled) {
        entry.resolve({ canceled: true });
      } else if (payload?.ok) {
        entry.resolve({ canceled: false });
      } else {
        entry.reject(new Error(payload?.error || '备份文件保存失败，请重试。'));
      }
    },
    ...(typeof native.getAppVersionInfo === 'function' ? {
      getAppVersionInfo: async () => {
        try {
          const parsed = JSON.parse(native.getAppVersionInfo!() || '{}');
          return {
            platform: 'android' as const,
            ...(typeof parsed.versionCode === 'number' ? { versionCode: parsed.versionCode } : {}),
            ...(typeof parsed.versionName === 'string' ? { versionName: parsed.versionName } : {}),
          };
        } catch {
          return { platform: 'android' as const };
        }
      },
    } : {}),
    ...(typeof native.checkForUpdates === 'function' ? {
      checkForUpdates: (): Promise<any> => new Promise((resolve, reject) => {
        const requestId = `upd-${Date.now()}-${++updateSeq}`;
        const timer = setTimeout(() => {
          updateChecks.delete(requestId);
          resolve({ status: 'error', message: '检查更新超时，请稍后重试' });
        }, 12000);
        updateChecks.set(requestId, { resolve, reject, timer });
        try {
          const started = native.checkForUpdates!(requestId);
          if (!started) {
            clearTimeout(timer);
            updateChecks.delete(requestId);
            reject(new Error('无法调起原生更新检查。'));
          }
        } catch (error) {
          clearTimeout(timer);
          updateChecks.delete(requestId);
          reject(error instanceof Error ? error : new Error('检查更新调起失败。'));
        }
      }),
    } : {}),
    resolveUpdateCheck: (payload: { requestId?: string; result?: any }) => {
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
      const entry = updateChecks.get(requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      updateChecks.delete(requestId);
      entry.resolve(payload?.result || { status: 'error', message: '检查更新返回空响应' });
    },
    ...(typeof native.openExternalUrl === 'function' ? {
      openExternalUrl: async (url: string) => ({ opened: !!native.openExternalUrl!(url), url }),
    } : {}),
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
  targetWindow.__loomaTodoFocus = (focus: {space: 'life'|'work'; id: string}) => adapter.emitTodoFocus(focus);
  targetWindow.__loomaOnBackupExportResult = (payload: { requestId?: string; ok?: boolean; canceled?: boolean; error?: string }) => adapter.resolveBackupExport(payload);
  targetWindow.__loomaOnUpdateCheckResult = (payload: { requestId?: string; result?: any }) => adapter.resolveUpdateCheck(payload);
  if (targetWindow.__loomaPendingTodoFocus) {
    const focus = targetWindow.__loomaPendingTodoFocus; delete targetWindow.__loomaPendingTodoFocus;
    adapter.emitTodoFocus(focus);
  }
  return true;
}
