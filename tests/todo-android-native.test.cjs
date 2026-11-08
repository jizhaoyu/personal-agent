const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const adjacentRoot = path.resolve(__dirname, '..');
const root = fs.existsSync(path.join(adjacentRoot, 'android/app/src/main')) ? adjacentRoot : process.cwd();
const javaRoot = path.join(root, 'android/app/src/main/java/com/looma/agent');
const read = (name) => fs.readFileSync(path.join(javaRoot, name), 'utf8');

test('Android todo rules execute real JVM CAS, zoned dates, stale-alarm and one-shot guards', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-todo-rules-'));
  try {
    const harness = path.join(temp, 'TodoRulesHarness.java');
    fs.writeFileSync(harness, `
      import com.looma.agent.TodoRules;
      import java.util.HashMap;
      import java.util.Map;
      public class TodoRulesHarness {
        static void check(boolean value) { if (!value) throw new AssertionError(); }
        static void reject(Runnable action) { try { action.run(); } catch (IllegalArgumentException expected) { return; } throw new AssertionError("accepted invalid input"); }
        public static void main(String[] args) {
          Map<String,Object> record = new HashMap<>();
          record.put("id", "same-id"); record.put("space", "life"); record.put("title", "开会");
          record.put("status", "pending"); record.put("revision", 1); record.put("createdAt", 100L); record.put("updatedAt", 100L);
          TodoRules.validateRecord(record);
          record.put("unknownField", "no"); reject(() -> TodoRules.validateRecord(record)); record.remove("unknownField");
          record.put("revision", 1.5); reject(() -> TodoRules.validateRecord(record)); record.put("revision", 1);
          record.put("revision", "1"); reject(() -> TodoRules.validateRecord(record)); record.put("revision", 1);
          record.put("needsTime", "false"); reject(() -> TodoRules.validateRecord(record)); record.remove("needsTime");
          record.put("sourceKind", "note"); reject(() -> TodoRules.validateRecord(record)); record.remove("sourceKind");
          record.put("space", "other"); reject(() -> TodoRules.validateRecord(record)); record.put("space", "life");
          record.put("notifiedRevision", 2); reject(() -> TodoRules.validateRecord(record)); record.remove("notifiedRevision");
          record.put("title", " "); reject(() -> TodoRules.validateRecord(record)); record.put("title", "开会");
          record.put("completedAt", null); reject(() -> TodoRules.validateRecord(record)); record.remove("completedAt");
          record.put("createdAt", -1.5); record.put("updatedAt", 1.25); TodoRules.validateRecord(record);
          record.put("lastNotifiedAt", Double.POSITIVE_INFINITY); reject(() -> TodoRules.validateRecord(record)); record.remove("lastNotifiedAt");
          record.put("title", "x".repeat(501)); reject(() -> TodoRules.validateRecord(record)); record.put("title", "开会");
          record.put("id", "x".repeat(201)); reject(() -> TodoRules.validateRecord(record)); record.put("id", "same-id");
          record.put("sourceText", "x".repeat(12001)); reject(() -> TodoRules.validateRecord(record)); record.remove("sourceText");
          record.put("sourceTaskId", ""); reject(() -> TodoRules.validateRecord(record)); record.remove("sourceTaskId");
          record.put("sourceTaskId", "x".repeat(201)); reject(() -> TodoRules.validateRecord(record)); record.remove("sourceTaskId");
          record.put("sourceFingerprint", "x".repeat(2001)); reject(() -> TodoRules.validateRecord(record)); record.remove("sourceFingerprint");
          check(TodoRules.parseDueAt("2026-11-04T16:30+23:00") == 1793727000000L);
          check(TodoRules.parseDueAt("2026-11-04T16:30:00.123456789123+08:00") == 1793781000123L);
          check(TodoRules.notificationBody("2026-11-05T07:00:00Z", TodoRules.parseDueAt("2026-11-05T07:00:20Z")).equals("提醒时间到了 · 今天 15:00"));
          check(TodoRules.notificationBody("2026-11-05T15:30:00Z", TodoRules.parseDueAt("2026-11-05T16:30:00Z")).equals("这条待办还没完成 · 原定昨天 23:30"));
          check(TodoRules.notificationBody("2026-11-05T15:00:00+08:00", TodoRules.parseDueAt("2027-01-01T01:00:00Z")).equals("这条待办还没完成 · 原定2026年11月5日 15:00"));
          TodoRules.checkRevision(null, null, 1);
          TodoRules.checkRevision(2L, 2L, 3);
          reject(() -> TodoRules.checkRevision(null, 2L, 3));
          reject(() -> TodoRules.checkRevision(2L, 1L, 3));
          reject(() -> TodoRules.checkRevision(2L, 2L, 2));
          reject(() -> TodoRules.checkRevision(null, null, 2));
          check(TodoRules.parseDueAt("2026-11-04T16:30:00+08:00") == 1793781000000L);
          reject(() -> TodoRules.parseDueAt("2026-11-04T16:30:00"));
          reject(() -> TodoRules.parseDueAt("2026-02-30T16:30:00+08:00"));
          TodoRules.checkDueDate("2028-02-29");
          reject(() -> TodoRules.checkDueDate("2026-02-29"));
          check(TodoRules.shouldNotify("pending", 3, 0, 3, 100, 101));
          check(!TodoRules.shouldNotify("completed", 3, 0, 3, 100, 101));
          check(!TodoRules.shouldNotify("cancelled", 3, 0, 3, 100, 101));
          check(!TodoRules.shouldNotify("suggested", 3, 0, 3, 100, 101));
          check(!TodoRules.shouldNotify("pending", 3, 3, 3, 100, 101));
          check(!TodoRules.shouldNotify("pending", 3, 0, 2, 100, 101));
          check(!TodoRules.shouldNotify("pending", 3, 0, 3, 200, 101));
          check(TodoRules.shouldNotify("pending", 3, 0, 3, 0, 101));
          System.out.println("TODO_RULES_JVM_OK");
        }
      }
    `);
    execFileSync('javac', ['--release', '11', '-encoding', 'UTF-8', '-d', temp, path.join(javaRoot, 'TodoRules.java'), harness], { stdio: 'pipe' });
    assert.match(execFileSync('java', ['-cp', temp, 'TodoRulesHarness'], { encoding: 'utf8' }), /TODO_RULES_JVM_OK/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Android port persists with SQLite transactions and exposes the shared command contract', () => {
  const store = read('TodoStore.java');
  assert.match(store, /extends SQLiteOpenHelper/);
  assert.match(store, /beginTransaction\(/);
  assert.match(store, /setTransactionSuccessful\(/);
  assert.match(store, /expectedRevision/);
  assert.match(store, /TodoRules\.checkRevision/);
  assert.match(store, /validateTodo/);
  assert.match(read('LoomaBridge.java'), /@JavascriptInterface\s+public String todoRequest\(String commandJson\)/);
  const scheduler = read('TodoScheduler.java');
  for (const op of ['list', 'put', 'replaceAll', 'configure', 'capabilities', 'requestPermissions']) {
    assert.ok(scheduler.includes('"' + op + '"'), op);
  }
  assert.match(scheduler, /optString\("op"/);
});

test('Android receiver and lifecycle restore background alarms without granting fake permission', () => {
  const scheduler = read('TodoScheduler.java');
  assert.match(scheduler, /canScheduleExactAlarms\(/);
  assert.match(scheduler, /areNotificationsEnabled\(/);
  assert.match(scheduler, /POST_NOTIFICATIONS/);
  assert.match(scheduler, /setExactAndAllowWhileIdle\(/);
  assert.match(scheduler, /setAndAllowWhileIdle\(/);
  assert.match(scheduler, /TodoRules\.shouldNotify/);
  assert.match(scheduler, /synchronized \(TodoStore\.LOCK\)/);
  assert.match(scheduler, /manager\.notify\(/);
  assert.match(scheduler, /\.setContentText\(TodoRules\.notificationBody\(todo\.getString\("dueAt"\), now\)\)/);
  assert.match(scheduler, /cancelNotification/);
  const manifest = fs.readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  for (const feature of ['SCHEDULE_EXACT_ALARM', 'RECEIVE_BOOT_COMPLETED', '.TodoReceiver', 'BOOT_COMPLETED', 'TIME_SET', 'TIMEZONE_CHANGED', 'MY_PACKAGE_REPLACED']) assert.ok(manifest.includes(feature), feature);
  const activity = read('MainActivity.java');
  assert.match(activity, /onRequestPermissionsResult/);
  assert.match(activity, /onNewIntent/);
  assert.match(activity, /__loomaTodoFocus/);
  assert.match(activity, /onPageFinished/);
});

test('Android resources, all native classes and receiver compile into a real SDK34/min26 DEX', (t) => {
  const sdk = process.env.ANDROID_HOME || 'D:/DevEnv/apps/android-sdk';
  const platform = path.join(sdk, 'platforms/android-34/android.jar');
  const candidates = ['android-14', '34.0.0', '35.0.0'].map(version => path.join(sdk, 'build-tools', version));
  const build = candidates.find(dir => fs.existsSync(path.join(dir, 'aapt2.exe')) && fs.existsSync(path.join(dir, 'dexdump.exe')));
  if (!fs.existsSync(platform) || !build) return t.skip('Android SDK34/build-tools unavailable; JVM rule tests still run');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-todo-dex-'));
  const main = path.join(root, 'android/app/src/main');
  try {
    const gen = path.join(temp, 'gen');
    const classes = path.join(temp, 'classes');
    fs.mkdirSync(gen); fs.mkdirSync(classes);
    execFileSync(path.join(build, 'aapt2.exe'), ['compile', '--dir', path.join(main, 'res'), '-o', path.join(temp, 'res.zip')], { stdio: 'pipe' });
    execFileSync(path.join(build, 'aapt2.exe'), ['link', '-I', platform, '--manifest', path.join(main, 'AndroidManifest.xml'), '--java', gen, '-o', path.join(temp, 'base.apk'), path.join(temp, 'res.zip')], { stdio: 'pipe' });
    const sources = fs.readdirSync(javaRoot).filter(name => name.endsWith('.java')).map(name => path.join(javaRoot, name));
    sources.push(path.join(gen, 'com/looma/agent/R.java'));
    execFileSync('javac', ['--release', '11', '-encoding', 'UTF-8', '-cp', platform, '-d', classes, ...sources], { stdio: 'pipe' });
    const classRoot = path.join(classes, 'com/looma/agent');
    const classFiles = fs.readdirSync(classRoot).filter(name => name.endsWith('.class')).map(name => path.join(classRoot, name));
    execFileSync('cmd.exe', ['/c', path.join(build, 'd8.bat'), '--release', '--min-api', '26', '--lib', platform, '--output', temp, ...classFiles], { stdio: 'pipe' });
    const dex = execFileSync(path.join(build, 'dexdump.exe'), ['-f', path.join(temp, 'classes.dex')], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    for (const name of ['TodoStore', 'TodoRules', 'TodoScheduler', 'TodoReceiver']) assert.ok(dex.includes("'Lcom/looma/agent/" + name + ";'"), name + ' absent in DEX');
    assert.match(dex, /'todoRequest'/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
