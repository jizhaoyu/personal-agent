interface LegacyConnectionApi {
  migrateLegacyConnection(config: {apiKey: string; apiBaseUrl: string; modelName: string}): Promise<{migrated: boolean}>;
}
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// Called only after the public settings have been successfully migrated to v3.
export function clearLegacyCredential(store: Store): boolean {
  try {
    const raw = store.getItem('looma_settings');
    if (!raw) return true;
    const old = JSON.parse(raw);
    if (!old || typeof old !== 'object' || !Object.prototype.hasOwnProperty.call(old, 'apiKey')) return true;
    const { apiKey: _secret, ...publicOld } = old;
    try { store.setItem('looma_settings', JSON.stringify(publicOld)); }
    catch {
      if (!store.getItem('looma_app_v3')) return false;
      store.removeItem('looma_settings');
    }
    return true;
  } catch { return false; }
}

export async function migrateLegacyCredential(api: LegacyConnectionApi, store: Store, fallback: {apiBaseUrl: string; modelName: string}): Promise<string> {
  let old;
  try { const raw = store.getItem('looma_settings'); old = raw ? JSON.parse(raw) : null; }
  catch { return '旧配置暂时无法读取，原始配置已保留。'; }
  if (!old || typeof old.apiKey !== 'string' || !old.apiKey) return '';
  try {
    const result = await api.migrateLegacyConnection({ apiKey: old.apiKey, apiBaseUrl: typeof old.apiBaseUrl === 'string' ? old.apiBaseUrl : fallback.apiBaseUrl, modelName: typeof old.modelName === 'string' ? old.modelName : fallback.modelName });
    if (!result.migrated) return '旧模型凭据尚未完成安全迁移，旧配置仍保留；可继续使用本地流程。';
    return clearLegacyCredential(store) ? '' : '旧模型凭据已安全迁移，但旧明文字段暂未清理；下次启动会继续尝试。';
  } catch { return '旧模型凭据安全迁移未完成，旧配置已保留；下次启动会继续尝试。'; }
}
