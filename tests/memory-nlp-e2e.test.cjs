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
const { retrieveRecallEvidence } = loadModule('src/persistence/memory.ts');

test('随口说生活态：自动沉淀亲友忌口、偏好与生日为高优记忆并去重', () => {
  const life = {
    revision: 1,
    wallet: { monthlyBudget: 5000, wishTitle: '心愿', wishTarget: 10000, wishSaved: 0, entries: [] },
    rpg: { energy: 70, waterCups: 0, weightKg: 60, targetWeightKg: 55, moodBuff: '平静', streakDays: 0 },
    persons: [],
    customCards: [],
    journals: [],
    memories: [],
    messages: [],
    events: [],
    processedProposalIds: [],
  };

  const text1 = '我妈不能吃香菜，老王对海鲜过敏，老婆生日5月20日';
  const receipts = StateEngine.mutateLifeDraft(text1, life);

  // 必须更新 persons
  assert.equal(life.persons.length, 3);
  // 必须自动沉淀为记忆
  assert.ok(life.memories.length >= 3);
  const momMem = life.memories.find(m => m.subject === '我妈');
  assert.ok(momMem, '缺少我妈的记忆');
  assert.match(momMem.fact, /香菜/);
  assert.equal(momMem.category, 'person');
  assert.equal(momMem.importance, 5);

  const wifeMem = life.memories.find(m => m.subject === '老婆');
  assert.ok(wifeMem, '缺少老婆的记忆');
  assert.match(wifeMem.fact, /5月20日/);

  // 重复输入相同语句，不应产生重复记忆
  const beforeCount = life.memories.length;
  StateEngine.mutateLifeDraft(text1, life);
  assert.equal(life.memories.length, beforeCount, '重复输入必须去重');
});

test('随口说生活态：自动提炼个人喜好禁忌、作息规律与生活事实', () => {
  const life = {
    revision: 1,
    wallet: { monthlyBudget: 5000, wishTitle: '心愿', wishTarget: 10000, wishSaved: 0, entries: [] },
    rpg: { energy: 70, waterCups: 0, weightKg: 60, targetWeightKg: 55, moodBuff: '平静', streakDays: 0 },
    persons: [],
    customCards: [],
    journals: [],
    memories: [],
    messages: [],
    events: [],
    processedProposalIds: [],
  };

  const text = '我喝咖啡只喝无糖拿铁，平时习惯晚上11点睡觉，记住家里的燃气卡放在门后第二个抽屉';
  StateEngine.mutateLifeDraft(text, life);

  const pref = life.memories.find(m => m.category === 'preference');
  assert.ok(pref, '缺少个人喜好偏好记忆');
  assert.match(pref.fact, /无糖拿铁/);

  const habit = life.memories.find(m => m.category === 'habit');
  assert.ok(habit, '缺少作息习惯记忆');
  assert.match(habit.fact, /11点/);

  const exp = life.memories.find(m => m.category === 'experience');
  assert.ok(exp, '缺少生活备忘事实记忆');
  assert.match(exp.fact, /燃气卡/);
});

test('随口说工作态：自动萃取商务底线、关键决策人和交付技术约束', () => {
  const work = {
    revision: 1,
    engagements: [],
    tasks: [],
    followUps: [],
    closures: [],
    events: [],
    messages: [],
    memories: [],
    journals: [],
    customCards: [],
    processedProposalIds: [],
  };

  const text = '赵总的智慧城市项目，预算¥80w，底线价格是70万必须分三期付款，李总是技术对接但决策人是王董事长，这次交付必须兼容信创国产环境';
  const proposal = StateEngine.propose(text, {
    mode: 'work',
    sourceMessageId: 'msg-work-1',
    partition: work,
    now: Date.now(),
  });

  const memOps = proposal.operations.filter(op => op.target === 'memory');
  assert.ok(memOps.length >= 3, `应该提取出至少3条工作记忆操作，实际: ${memOps.length}`);

  const businessMem = memOps.find(op => op.after.category === 'business');
  assert.ok(businessMem, '缺少商务底线记忆');
  assert.match(businessMem.after.fact, /底线价格|分三期/);

  const personMem = memOps.find(op => op.after.category === 'person');
  assert.ok(personMem, '缺少决策人记忆');
  assert.match(personMem.after.fact, /决策人|王董事长/);

  const techMem = memOps.find(op => op.after.category === 'experience');
  assert.ok(techMem, '缺少技术约束记忆');
  assert.match(techMem.after.fact, /信创国产环境/);
});

test('记忆检索与召回：单字搜索与复杂短语搜索百发百中', async () => {
  const facts = [
    { id: 'm1', mode: 'life', category: 'person', subject: '我妈', topic: '忌口', fact: '我妈不吃香菜，喜欢喝普洱茶', importance: 5, status: 'active', createdAt: 1 },
    { id: 'm2', mode: 'life', category: 'preference', subject: '我', topic: '喜好', fact: '我特别爱吃川菜麻婆豆腐', importance: 4, status: 'active', createdAt: 2 },
    { id: 'm3', mode: 'life', category: 'experience', subject: '宠物', topic: '健康', fact: '家里的小猫每年四月打疫苗', importance: 3, status: 'active', createdAt: 3 },
  ];

  const fakeRepo = {
    query: async (space, kind, options) => {
      if (kind !== 'memory') return { items: [], nextCursor: null };
      const q = (options.query || '').trim().toLowerCase();
      if (!q) return { items: facts, nextCursor: null };
      const matched = facts.filter(f => JSON.stringify(f).toLowerCase().includes(q));
      return { items: matched, nextCursor: null };
    },
  };

  // 1. 单字汉字搜索“猫”
  const catEvidence = await retrieveRecallEvidence(fakeRepo, '猫', 'life');
  assert.ok(catEvidence.items.length > 0, '单字“猫”应该检索出事实');
  assert.match(catEvidence.items[0].text, /小猫/);

  // 2. 单字汉字搜索“妈”
  const momEvidence = await retrieveRecallEvidence(fakeRepo, '妈', 'life');
  assert.ok(momEvidence.items.length > 0, '单字“妈”应该检索出事实');
  assert.match(momEvidence.items[0].text, /香菜/);

  // 3. 复合词语搜索“普洱茶”
  const teaEvidence = await retrieveRecallEvidence(fakeRepo, '普洱茶', 'life');
  assert.ok(teaEvidence.items.length > 0, '词语“普洱茶”应该检索出事实');
  assert.match(teaEvidence.items[0].text, /普洱茶/);
});
