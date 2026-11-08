const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const PLAYWRIGHT = 'D:/DevEnv/apps/Python/Python311/Lib/site-packages/playwright/driver/package';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inventory(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw Error(`Harness does not follow links: ${relative}`);
    return entry.isDirectory() ? inventory(root, relative) : [{ file: relative, sha256: hash(path.join(root, relative)) }];
  }).sort((a, b) => a.file.localeCompare(b.file));
}

/** This bootstrap exists only in the TEMP verification copy, never in the delivered package. */
function createBootstrap({ profile, backup }) {
  return `const e = require('electron');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
process.env.NODE_ENV = 'production';
process.argv = process.argv.filter(a => !['--remote-debugging-port','--remote-debugging-pipe','--inspect'].some(f => a.startsWith(f)));
e.app.setPath('userData', ${JSON.stringify(profile)});
const state = global.__loomaHarness = { handlers: new Map(), failures: [], notifications: [], osEvents: [], trays: [], dialogs: [] };
const originalHandle = e.ipcMain.handle.bind(e.ipcMain);
e.ipcMain.handle = (channel, handler) => {
  const wrapped = async (event, command) => {
    const failure = state.failures.findIndex(f => f.channel === channel && (!f.op || f.op === command?.op));
    if (failure >= 0) { state.failures.splice(failure, 1); throw Error('HARNESS_INJECTED_SAVE_FAILURE'); }
    return handler(event, command);
  };
  state.handlers.set(channel, wrapped); originalHandle(channel, wrapped);
};
class TestNotification extends EventEmitter {
  static isSupported() { return true; }
  constructor(options) { super(); this.options = options; this.closed = false; state.notifications.push(this); }
  show() { this.shown = true; setImmediate(() => { if (!this.closed) this.emit('show'); }); }
  close() { this.closed = true; this.emit('close'); }
}

const TestTray = new Proxy(e.Tray, { construct(Target, args) {
  const tray = new Target(...args), setMenu = tray.setContextMenu.bind(tray);
  tray.setContextMenu = menu => { tray.testMenu = menu; setMenu(menu); };
  state.trays.push(tray);return tray;
} });
const TestWindow = new Proxy(e.BrowserWindow, { construct(Target, [options]) {
  const window = new Target({...options, webPreferences: {...options.webPreferences, devTools: true}});
  window.setContentProtection = () => Target.prototype.setContentProtection.call(window, false);
  return window;
} });
e.dialog.showSaveDialog = async () => ({canceled: false, filePath: ${JSON.stringify(backup)}});
e.dialog.showOpenDialog = async () => ({canceled: false, filePaths: [${JSON.stringify(backup)}]});
e.dialog.showMessageBox = async (...args) => { state.dialogs.push(args[args.length - 1]); return {response: 0}; };
const originalLoad = Module._load;
const testElectron = {...e, Notification: TestNotification, Tray: TestTray, BrowserWindow: TestWindow, safeStorage: { isEncryptionAvailable: () => false }};
state.modelCalls=[];
const originalFetch=global.fetch;
global.fetch=async (url,options)=>{
  if(!String(url).endsWith('/chat/completions'))return originalFetch(url,options);
  const call={startedAt:Date.now()};state.modelCalls.push(call);
  try{const response=await originalFetch(url,options);call.status=response.status;return response;}
  catch(error){call.error=error.name;throw error;}finally{call.latencyMs=Date.now()-call.startedAt;}
};
Module._load = function(name, ...args) { return name === 'electron' ? testElectron : originalLoad.call(this, name, ...args); };
state.realNotification = () => {
  const note = new e.Notification({title:'Looma 合成提醒',body:'提醒时间到了 · 这是一条测试通知'});
  state.osNotification = note;
  for (const event of ['show','failed','click','close']) note.on(event, (...args) => state.osEvents.push({event,at:Date.now(),detail:args.map(String)}));
  note.show(); return {supported:e.Notification.isSupported()};
};
require('./electron/main.cjs');
`;
}

async function originalPackageSmoke(source, profile) {
  fs.mkdirSync(profile, {recursive:true});
  const env={...process.env,NODE_ENV:'production'};delete env.ELECTRON_RUN_AS_NODE;delete env.LOOMA_REAL_API_KEY;
  const child=spawn(path.join(source,'Looma.exe'),[`--user-data-dir=${profile}`],{cwd:source,env,windowsHide:true,stdio:'ignore'});
  let launchError;child.on('error',error=>{launchError=error;});
  try {
    const end=Date.now()+15000,database=path.join(profile,'looma.sqlite');
    while(Date.now()<end) {
      if(launchError)throw launchError;
      assert.equal(child.exitCode,null,'Original EXE exited during normal startup');
      if(fs.existsSync(database)&&fs.statSync(database).size>0) {
        assert.equal(fs.readFileSync(database).subarray(0,16).toString(),'SQLite format 3\0');
        await new Promise(resolve=>setTimeout(resolve,1000));assert.equal(child.exitCode,null);
        return {pid:child.pid,aliveAfterSQLiteCreation:true,database,debugFlags:false,productionEntrypointUnmodified:true,
          boundary:'Process + SQLite startup smoke only; UI interactions are verified separately in the instrumented byte-checked TEMP copy'};
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Original EXE did not create isolated SQLite within 15 seconds');
  } finally {
    // This PID belongs exclusively to the synthetic smoke process launched above.
    if(child.pid&&child.exitCode===null) {
      if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});
      else child.kill('SIGKILL');
      await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,2000))]);
    }
  }
}

async function verify() {
  const modelKey=process.env.LOOMA_REAL_API_KEY;
  const redact=value=>modelKey?String(value).split(modelKey).join('[redacted]'):String(value);
  const root = path.resolve(__dirname, '..');
  assert(process.env.LOOMA_EXE_DIR, 'Set LOOMA_EXE_DIR to the final portable directory containing Looma.exe and resources/app');
  const source = fs.realpathSync(process.env.LOOMA_EXE_DIR);
  assert(fs.existsSync(path.join(source, 'Looma.exe')), 'Looma.exe is missing');
  assert(fs.existsSync(path.join(source, 'resources/app/electron/main.cjs')), 'Packaged production main is missing');
  const output = path.join(root, 'output/playwright/personal-agent-exe');
  fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-exe-verification-'));
  const copied = path.join(temp, 'portable');
  const profile = path.join(temp, 'profile');
  fs.mkdirSync(profile, {recursive:true});
  const backup = path.join(temp, 'synthetic-backup.jsonl');
  const before = inventory(source);
  fs.cpSync(source, copied, { recursive: true });
  assert.deepEqual(inventory(copied), before, 'TEMP copy must exactly match the delivered package before harness injection');
  const appDirectory = path.join(copied, 'resources/app');
  const manifest = JSON.parse(fs.readFileSync(path.join(appDirectory, 'package.json'), 'utf8'));
  manifest.main = 'verification-bootstrap.cjs';
  fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(appDirectory, 'verification-bootstrap.cjs'), createBootstrap({ profile, backup }));
  const result = { startedAt: new Date().toISOString(), source, executableSha256: hash(path.join(source, 'Looma.exe')),
    profile, temporaryPortable: copied, harnessOnlyChanges: ['TEMP resources/app/package.json main', 'TEMP verification-bootstrap.cjs'],
    boundaries: ['Real final EXE/runtime and production renderer/main in a byte-verified TEMP copy', 'Harness strips debug flags, enables DevTools and screenshots only in TEMP bootstrap', 'IPC failure and native Notification boundaries are injected', modelKey?'Optional model stage uses real HTTP and a session-only key':'No real model request', 'Tray menu callback is invoked programmatically, not a manual OS tray click'],
    checks: [], rendererErrors: [], consoleErrors: [] };
  let app, page;
  const check = async (name, callback) => {
    const start = Date.now();
    try { const evidence = await callback(); result.checks.push({name,status:'passed',durationMs:Date.now()-start,...(evidence?{evidence}:{})}); console.log(`PASS ${name}`); }
    catch (error) {
      result.checks.push({name,status:'failed',error:redact(error.stack)});
      if(process.env.LOOMA_EXE_CONTINUE!=='1'||!page)throw error;
      console.error(`FAIL ${name}: ${redact(error.message)}`);
      await shot(`failure-${result.checks.length}`);
      await page.getByRole('button',{name:'工作态',exact:true}).waitFor();
    }
  };
  const wait = async callback => {
    const end = Date.now() + 12000; let last;
    while (Date.now() < end) { try { const value = await callback(); if (value) return value; } catch (error) { last=error; } await new Promise(resolve=>setTimeout(resolve,100)); }
    throw last || Error('Condition did not become true');
  };
  const ipc = (channel, command) => page.evaluate(({channel,command}) => {
    const api = window.electronAPI;
    if(channel==='todo:request')return api.todoRequest(command);
    if(channel==='store:request')return api.storeRequest(command);
    throw Error('Unsupported harness renderer IPC');
  }, {channel,command});
  const todos = async space => { const value=await ipc('todo:request',{op:'list',space}); assert.notEqual(value.ok,false,value.error); return value.todos; };
  const messages = async space => (await ipc('store:request',{op:'list',space,kind:'message',limit:200})).items;
  const switchMode = async space => { await page.getByRole('button',{name:space==='work'?'工作态':'生活态',exact:true}).click(); await page.locator(space==='work'?'textarea[aria-label="客户沟通记录"]':'textarea[placeholder="随手记录…"]').waitFor(); };
  const workInput = () => page.getByRole('textbox',{name:'客户沟通记录',exact:true});
  const lifeInput = () => page.getByPlaceholder('随手记录…');
  const shot = name => page.screenshot({path:path.join(output,`${name}.png`),fullPage:true});
  try {
    await check('original delivered EXE startup without debug flags or modified entrypoint',()=>originalPackageSmoke(source,path.join(temp,'original-smoke-profile')));
    const { _electron } = require(process.env.LOOMA_PLAYWRIGHT_PACKAGE || PLAYWRIGHT);
    const launchEnv={...process.env,NODE_ENV:'production'};delete launchEnv.ELECTRON_RUN_AS_NODE;delete launchEnv.LOOMA_REAL_API_KEY;
    app = await _electron.launch({executablePath:path.join(copied,'Looma.exe'),cwd:copied,timeout:30000,env:launchEnv});
    page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    page.on('pageerror',error=>result.rendererErrors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')result.consoleErrors.push(message.text());});
    await page.getByRole('button',{name:'工作态',exact:true}).waitFor();
    await check('final portable runtime, isolated SQLite and production file URL', async()=>{
      const info=await app.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,exe:app.getPath('exe'),profile:app.getPath('userData'),url:BrowserWindow.getAllWindows()[0].webContents.getURL()}));
      assert.equal(info.packaged,true);assert.equal(info.profile,profile);assert(info.url.startsWith('file:'));assert(info.url.includes('resources/app/dist/index.html')||info.url.includes('resources%2Fapp'));
      await wait(()=>fs.existsSync(path.join(profile,'looma.sqlite')));return info;
    });
    await switchMode('work');
    await check('work homepage directly exposes textarea without a project',async()=>{
      assert(await workInput().isVisible());const projects=await ipc('store:request',{op:'list',space:'work',kind:'engagement',limit:10});assert.equal(projects.items.length,0);await shot('01-work-home');
    });
    await check('work no-project original-only save',async()=>{
      const text='合成验证原文：今天的云很好看';await workInput().fill(text);await page.getByRole('button',{name:'只保存原文',exact:true}).click();
      await wait(async()=>(await messages('work')).some(row=>row.content===text));
      assert.equal((await todos('work')).length,0);
      const closures=await ipc('store:request',{op:'list',space:'work',kind:'closure',limit:10});assert(closures.items.some(row=>row.originalOnly));
      await page.getByRole('navigation',{name:'工作台导航'}).getByRole('button',{name:'待办',exact:true}).click();
      await wait(async()=>await workInput().inputValue()==='');
    });
    let workTodo;
    await check('work clear single task saves with no reminder time',async()=>{
      await workInput().fill('提醒我整理合成清单');await workInput().press('Enter');
      workTodo=await wait(async()=>(await todos('work')).find(row=>row.title.includes('整理合成清单')));
      assert.equal(workTodo.status,'pending');assert.equal(workTodo.dueAt,undefined);assert.equal(workTodo.needsTime,true);
      await page.locator(`[data-todo-id="${workTodo.id}"]`).scrollIntoViewIfNeeded();await shot('02-work-undated-task');return workTodo;
    });
    await check('completion is silent, removes active task and retains history',async()=>{
      const before=(await messages('work')).filter(row=>row.role==='assistant').length;
      await workInput().fill('整理合成清单完成了');await workInput().press('Enter');
      await wait(async()=>(await todos('work')).find(row=>row.id===workTodo.id)?.status==='completed');
      assert.equal((await messages('work')).filter(row=>row.role==='assistant').length,before);
      const history=page.locator('.todo-history');await history.locator(':scope > summary').click();await history.locator(`[data-todo-id="${workTodo.id}"]`).waitFor();
      assert.equal(await page.locator(`.todo-groups [data-todo-id="${workTodo.id}"]`).count(),0);await shot('03-work-completed-history');
    });
    await check('work IME Enter does not submit; Shift Enter adds a newline',async()=>{
      const text='合成输入法草稿';await workInput().fill(text);const before=(await messages('work')).length;
      await workInput().dispatchEvent('compositionstart',{data:'草稿'});await workInput().press('Enter');await workInput().dispatchEvent('compositionend',{data:'草稿'});
      assert((await workInput().inputValue()).includes(text));assert.equal((await messages('work')).length,before);
      await workInput().fill(text);await workInput().press('Shift+Enter');assert((await workInput().inputValue()).includes('\n'));
    });
    await check('work draft survives navigation and cross-space switching',async()=>{
      const text='合成跨页工作草稿';await workInput().fill(text);await page.getByRole('navigation',{name:'工作台导航'}).getByRole('button',{name:'项目',exact:true}).click();
      await page.getByRole('navigation',{name:'工作台导航'}).getByRole('button',{name:'待办',exact:true}).click();assert.equal(await workInput().inputValue(),text);
      await switchMode('life');await switchMode('work');assert.equal(await workInput().inputValue(),text);await workInput().fill('');
    });
    await switchMode('life');
    await check('life mode real renderer and IME Enter protection',async()=>{
      await shot('04-life-home');const text='合成生活输入法';await lifeInput().fill(text);const before=(await messages('life')).length;
      await lifeInput().dispatchEvent('compositionstart',{data:'法'});await lifeInput().press('Enter');await lifeInput().dispatchEvent('compositionend',{data:'法'});
      assert.equal((await lifeInput().inputValue()).trim(),text);assert.equal((await messages('life')).length,before);
    });
    await check('injected send failure preserves life input verbatim',async()=>{
      const text='提醒我买合成信封';await lifeInput().fill(text);
      await app.evaluate(()=>global.__loomaHarness.failures.push({channel:'store:request',op:'transaction'}));
      await page.getByRole('button',{name:'发送文字记录',exact:true}).click();
      await page.locator('[role="alert"]').first().waitFor();assert.equal(await lifeInput().inputValue(),text);
      assert.equal((await todos('life')).some(row=>row.title.includes('合成信封')),false);await shot('05-failure-keeps-original');
    });
    await check('life retry saves one undated task, draft survives cards and spaces',async()=>{
      await page.getByRole('button',{name:'发送文字记录',exact:true}).click();await wait(async()=>await lifeInput().inputValue()==='');
      const rows=(await todos('life')).filter(row=>row.title.includes('合成信封'));assert.equal(rows.length,1);assert.equal(rows[0].dueAt,undefined);
      const draft='合成生活跨页草稿';await lifeInput().fill(draft);await page.getByRole('navigation',{name:'生活导航'}).getByRole('button',{name:'生活卡片',exact:true}).click();
      await page.getByRole('navigation',{name:'生活导航'}).getByRole('button',{name:'随口说',exact:true}).click();assert.equal(await lifeInput().inputValue(),draft);
      await switchMode('work');await switchMode('life');assert.equal(await lifeInput().inputValue(),draft);await lifeInput().fill('');
    });
    await check('native scheduler delivery boundary, completion cancels notification',async()=>{
      const now=Date.now(),todo={id:'synthetic-due-boundary',space:'life',title:'合成边界提醒',status:'pending',createdAt:now,updatedAt:now,revision:1,dueAt:new Date(now-1000).toISOString(),needsTime:false};
      assert.equal((await ipc('todo:request',{op:'configure',enabled:true})).ok,true);
      assert.equal((await ipc('todo:request',{op:'put',todo,expectedRevision:null})).ok,true);
      const delivered=await wait(async()=>(await todos('life')).find(row=>row.id===todo.id)?.notifiedRevision===1);assert(delivered);
      const latest=(await todos('life')).find(row=>row.id===todo.id);const completed={...latest,status:'completed',completedAt:Date.now(),updatedAt:Date.now(),revision:2};
      assert.equal((await ipc('todo:request',{op:'put',todo:completed,expectedRevision:1})).ok,true);
      const notes=await app.evaluate(()=>global.__loomaHarness.notifications.map(note=>({options:note.options,shown:note.shown,closed:note.closed})));
      assert(notes.some(note=>note.options.title.includes('合成边界提醒')&&
        /^(提醒时间到了 · |这条待办还没完成 · 原定)/.test(note.options.body)&&note.shown&&note.closed));
      return {injectedNativeBoundary:true,notes};
    });
    await check('one real Windows Toast attempt with unmodified Electron Notification',async()=>{
      const supported=await app.evaluate(()=>global.__loomaHarness.realNotification());await page.waitForTimeout(3500);
      const events=await app.evaluate(()=>global.__loomaHarness.osEvents);return {...supported,events,osShowEventObserved:events.some(event=>event.event==='show'),manualVisibilityVerified:false};
    });
    await switchMode('work');
    await check('SQLite export contains todo rows and backup restore invalidates visible lists',async()=>{
      await page.getByRole('button',{name:'打开设置',exact:true}).click();await page.getByRole('button',{name:'导出备份',exact:true}).click();await wait(()=>fs.existsSync(backup));
      const archive=fs.readFileSync(backup,'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));assert(archive.some(row=>row.kind==='todo'||row.record?.kind==='todo'));
      await page.getByRole('button',{name:'关闭设置',exact:true}).click();
      await workInput().fill('提醒我整理恢复后应消失的合成条目');await workInput().press('Enter');
      const added=await wait(async()=>(await todos('work')).find(row=>row.title.includes('恢复后应消失')));await page.locator(`[data-todo-id="${added.id}"]`).waitFor();
      await page.getByRole('button',{name:'打开设置',exact:true}).click();await page.getByRole('checkbox',{name:'我已备份，确认替换两个空间的业务数据'}).check();
      await page.getByRole('button',{name:'校验并恢复',exact:true}).click();await wait(async()=>!(await todos('work')).some(row=>row.id===added.id));
      await page.getByRole('button',{name:'关闭设置',exact:true}).click();await wait(async()=>await page.locator(`[data-todo-id="${added.id}"]`).count()===0);
      assert((await todos('work')).some(row=>row.id===workTodo.id&&row.status==='completed'));await shot('06-after-restore');
      fs.copyFileSync(backup,path.join(output,'synthetic-backup.jsonl'));return {archiveLines:archive.length};
    });
    await check('close hides without quitting; programmatic tray reopen keeps SQLite consistent',async()=>{
      const before=await todos('work');await page.getByRole('button',{name:'退出应用',exact:true}).click();
      await wait(()=>app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];return !!window&&!window.isVisible()&&!window.isDestroyed();}));
      const trayResult=await app.evaluate(()=>{const tray=global.__loomaHarness.trays[0];const item=tray?.testMenu?.items.find(item=>item.label==='打开 Looma');if(!item)throw Error('Tray menu missing');item.click(item);return {method:'real Tray menu callback invoked by harness',trayDestroyed:tray.isDestroyed()};});
      await wait(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()));assert.deepEqual(await todos('work'),before);return trayResult;
    });
    if(modelKey)await check('real model through packaged work capture preserves separate undated actions',async()=>{
      await page.getByRole('button',{name:'打开设置',exact:true}).click();
      await page.getByText('可选：配置模型增强',{exact:true}).click();
      await page.getByLabel('API Base URL',{exact:true}).fill(process.env.LOOMA_REAL_API_BASE||'https://nb.deepsb.com/v1');
      await page.getByLabel('模型名称',{exact:true}).fill('gpt-6.1-sol');
      await page.getByLabel('API Key',{exact:true}).fill(modelKey);
      await page.getByLabel('我了解发送范围，主动开启模型增强').check();
      await page.getByRole('button',{name:'保存设置',exact:true}).click();
      await page.getByText('设置已保存。',{exact:true}).waitFor();
      await page.getByRole('button',{name:'关闭设置',exact:true}).click();
      const status=await page.evaluate(()=>window.electronAPI.modelStatus());
      assert(status.enabled&&status.configured&&!status.persistent);
      assert(!fs.existsSync(path.join(profile,'looma-model-connection.json')));
      await workInput().fill('帮我记一下预约牙医，打印材料，都不设时间');await workInput().press('Enter');
      await page.waitForFunction(()=>document.querySelector('textarea[aria-label="客户沟通记录"]')?.value==='',null,{timeout:65000});
      const created=(await todos('work')).filter(t=>/牙医|打印材料/.test(t.title));
      result.modelCalls=await app.evaluate(()=>global.__loomaHarness.modelCalls);
      assert(result.modelCalls.some(c=>c.status===200),'No successful live model HTTP request');
      assert.equal(created.length,2);assert(created.every(t=>t.status==='pending'&&!t.dueAt));
      return {modelName:status.modelName,calls:result.modelCalls,created:created.map(t=>t.title)};
    });
    assert.equal(result.rendererErrors.length,0,JSON.stringify(result.rendererErrors));
    result.status=result.checks.some(check=>check.status==='failed')?'failed':'passed';
    if(result.status==='failed')process.exitCode=1;
  } catch(error) {
    result.status='failed';result.error=redact(error.stack);
    if(page) { try { if(!modelKey)await shot('failure');result.lastVisibleText=redact(await page.locator('body').innerText()); } catch {} }
    process.exitCode=1;
  } finally {
    if(app) { try { await app.evaluate(({app})=>{global.__loomaHarness.osNotification?.close();app.exit(0);}); } catch {} try { await app.close(); } catch {} }
    assert.deepEqual(inventory(source),before,'Delivered original package was modified during verification');
    result.originalPackageUnchanged=true;result.finishedAt=new Date().toISOString();
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({status:result.status,checks:result.checks.map(({name,status})=>({name,status})),result:path.join(output,'result.json')},null,2));
    // All recursive cleanup stays inside this uniquely created TEMP directory.
    if(result.status==='passed'&&process.env.LOOMA_EXE_KEEP_TEMP!=='1')fs.rmSync(temp,{recursive:true,force:true});
  }
  return result;
}
if(require.main===module)verify().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={createBootstrap,inventory,verify,originalPackageSmoke};
