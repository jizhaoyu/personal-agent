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
  vm.runInNewContext(compiled, { module, exports: module.exports, require: customRequire, console, Date, Intl, crypto }, { filename: fullPath });
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
    wallet: { monthlyBudget: 5000, wishTitle: '心愿', wishTarget: 10000, wishSaved: 0, entries: [], wishes: [] },
    rpg: { energy: 80, waterCups: 0, weightKg: 0, targetWeightKg: 0, moodBuff: '未记录', streakDays: 0 },
  };
}

test('多亲友与“我”复合长句：准确分离亲友与个人，杜绝“而我”成亲友、杜绝别人的喜好塞给“我”', () => {
  const life = emptyLife();
  const receipts = StateEngine.mutateLifeDraft('我妈妈喜欢吃湘菜，我爸爸喜欢吃牛肉饭，而我喜欢吃方便面', life);

  // 1. 亲友档案必须只有妈妈和爸爸，绝对不能出现“而我”
  assert.equal(life.persons.length, 2, '亲友档案必须恰好只有2人');
  const mom = life.persons.find(p => p.name === '妈妈');
  const dad = life.persons.find(p => p.name === '爸爸');
  assert.ok(mom, '必须有名为妈妈的亲友');
  assert.ok(dad, '必须有名为爸爸的亲友');
  assert.ok(!life.persons.some(p => p.name.includes('我')), '亲友姓名绝对不能包含“我”或“而我”');

  assert.ok(mom.preferences.some(p => p.includes('湘菜')));
  assert.ok(dad.preferences.some(p => p.includes('牛肉饭')));

  // 2. 记忆归属精确分流
  const myMems = life.memories.filter(m => m.subject === '我');
  assert.equal(myMems.length, 1, '针对【我】的记忆必须恰好只有1条方便面');
  assert.match(myMems[0].fact, /方便面/);
  assert.ok(!myMems.some(m => m.fact.includes('湘菜')), '妈妈的湘菜绝不能记到【我】名下');
  assert.ok(!myMems.some(m => m.fact.includes('牛肉饭')), '爸爸的牛肉饭绝不能记到【我】名下');

  // 3. 记忆文案杜绝嵌套【妈妈】【妈妈】
  const momMem = life.memories.find(m => m.subject === '妈妈');
  assert.ok(momMem);
  assert.ok(!momMem.fact.includes('【妈妈】【妈妈】'), '绝对不能出现【妈妈】【妈妈】重复嵌套');
});

test('“爸爸还喜欢吃鸡肉”：副词“还”准确剥离，合并更新原有亲友，绝不产生“爸爸还”假亲友', () => {
  const life = emptyLife();
  // 先有初始记录
  StateEngine.mutateLifeDraft('我爸爸喜欢吃牛肉饭', life);
  assert.equal(life.persons.length, 1);
  assert.equal(life.persons[0].name, '爸爸');

  // 增量跟进记录
  const receipts = StateEngine.mutateLifeDraft('爸爸还喜欢吃鸡肉', life);

  // 亲友不增加，仍为爸爸一人
  assert.equal(life.persons.length, 1);
  assert.equal(life.persons[0].name, '爸爸');
  assert.ok(life.persons[0].preferences.some(p => p.includes('牛肉饭')));
  assert.ok(life.persons[0].preferences.some(p => p.includes('鸡肉')));

  // 记忆不增加错误项
  assert.ok(!life.memories.some(m => m.subject === '我' && m.fact.includes('鸡肉')), '爸爸的鸡肉绝不能变成【我】的喜好');
  const dadMem = life.memories.find(m => m.subject === '爸爸');
  assert.ok(dadMem);
  assert.match(dadMem.fact, /鸡肉/);
  assert.ok(!dadMem.fact.includes('【爸爸还】'), '事实绝对不能出现【爸爸还】');
});

test('各种转折与连词前缀（而我/但我/另外我/然后我）均精准识别为用户本人', () => {
  const variations = [
    '而我喜欢吃水饺',
    '但我平时习惯早起',
    '另外我最爱喝无糖拿铁',
    '至于我自己不吃香菜',
  ];

  for (const sentence of variations) {
    const life = emptyLife();
    StateEngine.mutateLifeDraft(sentence, life);
    assert.equal(life.persons.length, 0, `句子 “${sentence}” 绝不能创建亲友`);
    assert.ok(life.memories.some(m => m.subject === '我'), `句子 “${sentence}” 必须收录在【我】的名下`);
  }
});
