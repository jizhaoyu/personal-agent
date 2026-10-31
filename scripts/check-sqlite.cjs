const { spawnSync } = require('node:child_process');
if (!process.versions.electron) {
  const result = spawnSync(require('electron'), [__filename], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} else {
  const assert = require('node:assert/strict');
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT); CREATE VIRTUAL TABLE words USING fts5(text);');
  db.transaction(() => db.prepare('INSERT INTO probe(value) VALUES (?)').run('compatibility'))();
  db.prepare('INSERT INTO words(text) VALUES (?)').run('咖啡 白茶');
  assert.equal(db.prepare('SELECT count(*) n FROM probe').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM words WHERE words MATCH ?').get('咖啡').n, 1);
  console.log(JSON.stringify({ node: process.versions.node, electron: process.versions.electron, abi: process.versions.modules, sqlite: db.prepare('SELECT sqlite_version() v').get().v, transaction: true, fts: true }));
  db.close();
}
