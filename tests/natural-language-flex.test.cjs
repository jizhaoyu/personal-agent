const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadModule(relPath) {
  const compiledPath = path.join(__dirname, '..', relPath.replace(/\.ts$/, '.js'));
  if (fs.existsSync(compiledPath)) {
    return require(compiledPath);
  }
  const ts = require('typescript');
  const fullPath = path.join(process.cwd(), relPath);
  const source = fs.readFileSync(fullPath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const customRequire = (id) => {
    if (id.startsWith('./') || id.startsWith('../')) {
      const target = path.resolve(path.dirname(fullPath), id);
      const rel = path.relative(process.cwd(), target);
      if (fs.existsSync(target + '.ts')) return loadModule(rel + '.ts');
      if (fs.existsSync(target)) return require(target);
    }
    return require(id);
  };
  const fn = new Function('exports', 'require', 'module', output);
  fn(mod.exports, customRequire, mod);
  return mod.exports;
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
    processedProposalIds: [],
    wallet: { monthlyBudget: 3000, wishTitle: '旅行', wishTarget: 5000, wishSaved: 0, entries: [] },
    rpg: { energy: 70, waterCups: 0, weightKg: 0, targetWeightKg: 60, moodBuff: '平静', streakDays: 0 },
  };
}

test('life parser records expenses without requiring 元/块 and supports diverse word orders', () => {
  const cases = [
    ['今天花了30', '日常开销', 30, '生活🏠'],
    ['花了30买水杯', '买水杯', 30, '购物🛍️'],
    ['买水杯60', '买水杯', 60, '购物🛍️'],
    ['早饭15', '早饭', 15, '餐饮☕'],
    ['打车28.5', '打车', 28.5, '出行🚕'],
    ['喝奶茶18', '喝奶茶', 18, '餐饮☕'],
    ['充话费100', '充话费', 100, '生活🏠'],
    ['付了45看电影', '看电影', 45, '娱乐🎮'],
    ['耳机 ¥299', '耳机', 299, '购物🛍️'],
  ];

  for (const [input, expectedTitle, expectedAmount, expectedCategory] of cases) {
    const life = emptyLife();
    const receipts = StateEngine.mutateLifeDraft(input, life);
    assert.equal(life.wallet.entries.length, 1, `未能识别消费: ${input}`);
    assert.equal(life.wallet.entries[0].title, expectedTitle, `标题不匹配: ${input}`);
    assert.equal(life.wallet.entries[0].amount, expectedAmount, `金额不匹配: ${input}`);
    assert.equal(life.wallet.entries[0].category, expectedCategory, `分类不匹配: ${input}`);
    assert.ok(receipts.some(r => r.targetCardType === 'wallet'));
  }
});

test('life parser supports unitless savings, income, weight, multi-cup water and multi-person colloquial kinship', () => {
  const life = emptyLife();

  // 1. 无单位攒钱与收入
  StateEngine.mutateLifeDraft('存了500，发工资8000', life);
  assert.equal(life.wallet.wishSaved, 500);
  assert.ok(life.wallet.entries.some(e => e.type === 'saving' && e.amount === 500));
  assert.ok(life.wallet.entries.some(e => e.type === 'income' && e.amount === 8000));

  // 2. 无单位体重（>=95 自动识别为斤并折算为 kg）与无“体重”前缀
  StateEngine.mutateLifeDraft('体重130', life);
  assert.equal(life.rpg.weightKg, 65);
  StateEngine.mutateLifeDraft('今天63.5kg', life);
  assert.equal(life.rpg.weightKg, 63.5);

  // 3. 多杯饮水与毫升折算
  StateEngine.mutateLifeDraft('喝了两杯水', life);
  assert.equal(life.rpg.waterCups, 2);
  StateEngine.mutateLifeDraft('喝了500ml水', life);
  assert.equal(life.rpg.waterCups, 4);

  // 4. 口语化单字亲属与单句多亲友提取
  StateEngine.mutateLifeDraft('我妈不能吃香菜，老王芒果过敏，老婆生日5月20日', life);
  assert.equal(life.persons.length, 3);
  assert.ok(life.persons.find(p => p.name === '妈')?.taboos.includes('不吃香菜'));
  assert.ok(life.persons.find(p => p.name === '老王')?.taboos.includes('芒果过敏'));
  assert.equal(life.persons.find(p => p.name === '老婆')?.nextImportantDate, '5月20日');
});

test('work parser supports prefix currency symbols, extended titles, half-hour clocks and relative day offsets', () => {
  const now = Date.parse('2026-10-26T04:00:00Z');
  const emptyWork = {
    revision: 0, engagements: [], tasks: [], followUps: [],
    events: [], messages: [], memories: [], journals: [], customCards: [], processedProposalIds: [],
  };

  const proposal = StateEngine.propose('陈姐合同额¥15w，我下星期三下午3点半汇报方案，客户3天后补充资料', {
    mode: 'work',
    sourceMessageId: 'flex-work-1',
    partition: emptyWork,
    now,
  });

  const eng = proposal.operations.find(op => op.target === 'engagement')?.after;
  assert.equal(eng?.clientName, '陈姐');
  assert.equal(eng?.budgetAmount, 150000);

  const task = proposal.operations.find(op => op.target === 'task')?.after;
  assert.equal(task?.title, '汇报方案');
  assert.equal(task?.dueAt, '2026-11-04T07:30:00.000Z'); // 15:30 Asia/Shanghai = 07:30 UTC

  const waiting = proposal.operations.find(op => op.target === 'followup' && op.after?.kind === 'waiting')?.after;
  assert.equal(waiting?.title, '补充资料');
  assert.equal(waiting?.expectedDate, '2026-10-29');
});
