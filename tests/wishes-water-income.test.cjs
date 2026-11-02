const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadModule(relPath) {
  const fullPath = path.join(process.cwd(), relPath);
  const code = fs.readFileSync(fullPath, 'utf8');
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: fullPath,
  }).outputText;
  const module = { exports: {} };
  const customRequire = (dep) => {
    if (dep.endsWith('persistence-core.mjs')) {
      return require(path.join(process.cwd(), 'shared/persistence-core.mjs'));
    }
    if (dep.startsWith('./') || dep.startsWith('../')) {
      const target = path.resolve(path.dirname(fullPath), dep);
      const rel = path.relative(process.cwd(), target).replace(/\\/g, '/');
      if (fs.existsSync(target + '.ts')) return loadModule(rel + '.ts');
      if (fs.existsSync(target)) return require(target);
    }
    return require(dep);
  };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: customRequire,
    console,
    Date,
    Intl,
    crypto,
  }, { filename: fullPath });
  return module.exports;
}

const { StateEngine } = loadModule('src/services/stateEngine.ts');

function emptyLife() {
  return {
    revision: 1,
    messages: [],
    memories: [],
    persons: [],
    journals: [],
    customCards: [],
    events: [],
    processedProposalIds: [],
    wallet: {
      monthlyBudget: 3000,
      wishTitle: '日本樱花季旅行',
      wishTarget: 8000,
      wishSaved: 1200,
      entries: [],
      wishes: [
        { id: 'wish-1', title: '日本樱花季旅行', targetAmount: 8000, savedAmount: 1200, group: '旅行度假', isPrimary: true },
        { id: 'wish-2', title: '换一台4K高刷显示器', targetAmount: 3500, savedAmount: 500, group: '数码科技', isPrimary: false },
      ],
      activeWishId: 'wish-1',
    },
    rpg: { energy: 60, waterCups: 1, weightKg: 65, targetWeightKg: 60, moodBuff: '平静', streakDays: 1, dateKey: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/\//g, '-') },
  };
}

test('喝了3杯水：饮水记录增加且精力值相应增加，刷新状态Buff', () => {
  const life = emptyLife();
  const initialEnergy = life.rpg.energy;
  const initialWater = life.rpg.waterCups;

  StateEngine.mutateLifeDraft('喝了3杯水', life);

  assert.equal(life.rpg.waterCups, initialWater + 3, '饮水杯数必须增加3杯');
  assert.equal(life.rpg.energy, initialEnergy + 12, '精力值每杯增加4点，3杯增加12点');
  assert.match(life.rpg.moodBuff, /水分充足|充沛/);
});

test('随口说“挣了300块”：收入明细入账同时100%全额沉淀至当前主攻心愿', () => {
  const life = emptyLife();
  const initialSaved = life.wallet.wishSaved;
  const targetWish = life.wallet.wishes.find(w => w.id === life.wallet.activeWishId);
  const initialWishSaved = targetWish.savedAmount;

  StateEngine.mutateLifeDraft('今天兼职挣了300块', life);

  // 1. entries 增加 income
  const incomeEntry = life.wallet.entries.find(e => e.type === 'income');
  assert.ok(incomeEntry, '必须有收入流水记录');
  assert.equal(incomeEntry.amount, 300);

  // 2. wishSaved 增加 300
  assert.equal(life.wallet.wishSaved, initialSaved + 300, '心愿金库已攒金额必须同步增加300');

  // 3. 主攻心愿同步增加 300
  assert.equal(targetWish.savedAmount, initialWishSaved + 300, '当前主攻心愿已攒进度同步增加300');
});

test('切换主攻心愿后，存入与挣钱自动注入新主攻心愿', () => {
  const life = emptyLife();
  // 切换主攻心愿为 wish-2
  life.wallet.activeWishId = 'wish-2';
  const wish2 = life.wallet.wishes.find(w => w.id === 'wish-2');
  const initialWish2 = wish2.savedAmount;

  StateEngine.mutateLifeDraft('发工资赚了500', life);

  assert.equal(wish2.savedAmount, initialWish2 + 500, '新主攻心愿必须接收500元入账');
  assert.equal(life.wallet.wishTitle, '换一台4K高刷显示器');
});
