import test from 'node:test';
import assert from 'node:assert/strict';
let migration: any = {};
try { migration = require('../src/services/legacyConnection'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
function store() {
  const values = new Map([['looma_settings', JSON.stringify({ apiKey: 'synthetic-old-key', personaName: '旧称呼' })], ['looma_app_v3', '{"schemaVersion":3}']]);
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
}
const fallback = { apiBaseUrl: 'https://api.example.com/v1', modelName: 'test' };
test('即使已有桌面连接，旧明文凭据仍进入安全迁移与清理', async () => {
  assert.equal(typeof migration.migrateLegacyCredential, 'function');
  const data = store(); let calls = 0;
  const result = await migration.migrateLegacyCredential({ migrateLegacyConnection: async () => { calls++; return { migrated: true }; } }, data, fallback);
  assert.equal(calls, 1); assert.equal(result, '');
  assert.equal(JSON.parse(data.getItem('looma_settings')!).apiKey, undefined);
  assert.equal(JSON.parse(data.getItem('looma_settings')!).personaName, '旧称呼');
});
test('安全迁移未完成绝不清理旧Key', async () => {
  assert.equal(typeof migration.migrateLegacyCredential, 'function');
  const data = store(); const before = data.getItem('looma_settings');
  const warning = await migration.migrateLegacyCredential({ migrateLegacyConnection: async () => ({ migrated: false }) }, data, fallback);
  assert.ok(warning); assert.equal(data.getItem('looma_settings'), before);
});
test('迁移成功后重写失败可移除已迁入v3的旧设置；清理失败下次继续', async () => {
  assert.equal(typeof migration.migrateLegacyCredential, 'function');
  const data = store(); const set = data.setItem; const remove = data.removeItem;
  data.setItem = () => { throw new Error('quota'); };
  data.removeItem = () => { throw new Error('denied'); };
  const api = { migrateLegacyConnection: async () => ({ migrated: true }) };
  assert.match(await migration.migrateLegacyCredential(api, data, fallback), /旧.*凭据/);
  data.removeItem = remove;
  assert.equal(await migration.migrateLegacyCredential(api, data, fallback), '');
  assert.equal(data.getItem('looma_settings'), null);
  data.setItem = set;
});
