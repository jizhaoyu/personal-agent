const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const result = spawnSync(require('electron'), ['--test', ...['persistence.test.cjs', 'persistence-v5.test.cjs', 'project-continuation-native.test.cjs', 'todo-desktop.test.cjs'].map(file => path.join(root, 'tests', file))], {
  cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LOOMA_NATIVE_TEST: '1', LOOMA_SOURCE_ROOT: root },
});
process.exitCode = result.status ?? 1;
