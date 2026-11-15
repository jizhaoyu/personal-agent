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
const { validateTransaction } = require('../shared/persistence-core.mjs');

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

test('life ledger records only affirmed events, each in one category', () => {
  const cases = [
    ['奖金到账500元', [['income',500]]],
    ['报销64元，财务还没打给我', []],
    ['假如地铁花了17元就贵了', []],
    ['我姐赚了280块，不是我的收入', []],
    ['没花45块', []],
    ['退款39元，还没到账，不过午饭确实花了26元', [['expense',26]]],
    ['工资到账8,500元', [['income',8500]]],
    ['早饭18元，地铁也花了18元', [['expense',18],['expense',18]]],
    ['我今天实付了26元买书，平台补贴还没到账', [['expense',26]]],
    ['收到红包20元，晚饭花了18元', [['expense',18],['income',20]]],
    ['我的退税到账62.5元', [['income',62.5]]],
    ['发了年终奖800元，已经到卡上了', [['income',800]]],
    ['二手书卖了42元，钱已收', [['income',42]]],
    ['同事买新手机花了5999', []],
    ['同学买了双鞋699', []],
    ['炒股亏了500块', []],
    ['转转出了个旧键盘260，钱已收', [['income',260]]],
    ['闲鱼卖了个旧相机950，钱已收', [['income',950]]],
    ['过年抢到个88.8元大红包', [['income',88.8]]],
    ['房租押金退回来了2000，钱已到卡', [['income',2000]]],
    ['押金退回2000，钱已到卡', [['income',2000]]],
    ['昨晚海底捞AA我出了168.5', [['expense',168.5]]],
    ['楼下理发洗剪吹58', [['expense',58]]],
    ['超市扫货420大洋', [['expense',420]]],
    ['茶颜悦色奶茶18，顺便买蛋挞12', [['expense',18],['expense',12]]],
    ['刚才花了九十九块买书', [['expense',99]]],
    ['楼下配钥匙15，顺便买了瓶水3', [['expense',15],['expense',3]]],
  ];
  for(const [text,wanted] of cases){
    const life=emptyLife();
    StateEngine.mutateLifeDraft(text,life);
    assert.deepEqual(Array.from(life.wallet.entries,e=>[e.type,e.amount]).sort(),wanted.sort(),text);
  }
});

test('water reports leave legacy status untouched and independent expenses still commit',()=>{
  const life=emptyLife();
  life.rpg.waterCups=2;
  const prior=structuredClone(life);
  for(const input of ['喝水3杯','喝了500ml水','补水一杯','我没喝两杯水，只是倒了两杯']){
    assert.deepEqual(StateEngine.mutateLifeDraft(input,life),[]);
    assert.deepEqual(life,prior);
  }
  const receipts=StateEngine.mutateLifeDraft('喝了两杯水，午饭花了28元',life);
  assert.deepEqual(life.rpg,prior.rpg);
  assert.equal(life.wallet.entries[0].amount,28);
  assert.ok(receipts.every(r=>r.targetCardType==='wallet'));
});

test('a preference update and an expense form one schema-valid transaction',()=>{
  const life=emptyLife();
  StateEngine.mutateLifeDraft('我喝咖啡只喝无糖拿铁',life);
  const before=structuredClone(life.memories[0]);
  StateEngine.mutateLifeDraft('我喝咖啡只喝美式，午饭花了26元',life);
  const after=life.memories.find(m=>m.id===before.id);
  assert.match(after.fact,/美式/);
  assert.equal(after.createdAt,before.createdAt);
  const expense=life.wallet.entries.at(-1);
  assert.equal(expense.amount,26);
  const mutations=[
    {kind:'memory',id:before.id,before,after},
    {kind:'expense',id:expense.id,before:null,after:expense},
  ];
  assert.deepEqual(validateTransaction({op:'transaction',space:'life',id:'mixed-life',mutations},1,
    (kind,id)=>kind==='memory'&&id===before.id?before:null),[]);
});

test('a booked refund does not overwrite a previously saved preference',()=>{
  const life=emptyLife();
  StateEngine.mutateLifeDraft('我喝咖啡只喝无糖拿铁',life);
  const saved=structuredClone(life.memories);
  StateEngine.mutateLifeDraft('我的退税到账62.5元',life);
  assert.deepEqual(life.memories,saved);
  assert.deepEqual(life.wallet.entries.map(e=>[e.type,e.amount]),[['income',62.5]]);
});

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

test('life parser supports unitless savings, income, weight and multi-person colloquial kinship', () => {
  const life = emptyLife();

  // 1. 无单位攒钱与收入（收入同步注入心愿小金库）
  StateEngine.mutateLifeDraft('存了500，发工资8000', life);
  assert.equal(life.wallet.wishSaved, 8500);
  assert.ok(life.wallet.entries.some(e => e.type === 'saving' && e.amount === 500));
  assert.ok(life.wallet.entries.some(e => e.type === 'income' && e.amount === 8000));

  // 2. 无单位体重（>=95 自动识别为斤并折算为 kg）与无“体重”前缀
  StateEngine.mutateLifeDraft('体重130', life);
  assert.equal(life.rpg.weightKg, 65);
  StateEngine.mutateLifeDraft('今天63.5kg', life);
  assert.equal(life.rpg.weightKg, 63.5);

  // 3. 口语化单字亲属与单句多亲友提取
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

test('life parser handles retractions, persons with health/dates, parking facts, and quoted custom cards', () => {
  // 1. MIX-05 retraction defense
  const retracted = emptyLife();
  const retractReceipts = StateEngine.mutateLifeDraft('存了200块，啊不对最后没存，别记账', retracted);
  assert.equal(retracted.wallet.entries.length, 0);
  assert.equal(retracted.wallet.wishSaved, 0);
  assert.equal(retractReceipts.length, 0);

  // 2. AA / scene / Chinese numeral categories
  const expChecks = [
    ['昨晚海底捞AA我出了168.5', '餐饮☕', 168.5],
    ['楼下理发洗剪吹58', '生活🏠', 58],
    ['超市扫货420大洋', '购物🛍️', 420],
    ['刚才花了九十九块买书', '购物🛍️', 99],
  ];
  for (const [input, cat, amt] of expChecks) {
    const life = emptyLife();
    StateEngine.mutateLifeDraft(input, life);
    assert.equal(life.wallet.entries.length, 1, input);
    assert.equal(life.wallet.entries[0].category, cat, input);
    assert.equal(life.wallet.entries[0].amount, amt, input);
  }

  // 3. Multi-clause kinship taboos/preferences, allergy+birthday, and non-overwriting facts
  const lifeMem = emptyLife();
  StateEngine.mutateLifeDraft('我妈对青霉素过敏，平时也不吃香菜', lifeMem);
  assert.deepEqual(lifeMem.persons.find(p => p.name === '妈')?.taboos, ['青霉素过敏', '不吃香菜']);
  assert.equal(lifeMem.memories.some(m => m.subject === '我'), false);

  StateEngine.mutateLifeDraft('老爸血压高不碰咸菜，爱喝铁观音', lifeMem);
  assert.ok(lifeMem.persons.find(p => p.name === '爸爸')?.taboos.includes('不吃咸菜'));
  assert.ok(lifeMem.persons.find(p => p.name === '爸爸')?.preferences.includes('喜欢铁观音'));

  const dadEat = emptyLife();
  StateEngine.mutateLifeDraft('老爸血压高不吃咸菜，爱喝铁观音', dadEat);
  assert.ok(dadEat.persons.find(p => p.name === '爸爸')?.taboos.includes('不吃咸菜'));
  assert.ok(dadEat.persons.find(p => p.name === '爸爸')?.preferences.includes('喜欢铁观音'));

  StateEngine.mutateLifeDraft('我姐对海鲜过敏，平时也不吃辣', lifeMem);
  assert.deepEqual(lifeMem.persons.find(p => p.name === '姐')?.taboos, ['海鲜过敏', '不吃辣']);

  StateEngine.mutateLifeDraft('小林芒果过敏，生日是6月12号', lifeMem);
  const lin = lifeMem.persons.find(p => p.name === '小林');
  assert.ok(lin?.taboos.includes('芒果过敏'));
  assert.equal(lin?.nextImportantDate, '6月12号');

  StateEngine.mutateLifeDraft('张阿姨忌口牛羊肉', lifeMem);
  assert.ok(lifeMem.persons.find(p => p.name === '张阿姨')?.taboos.includes('不吃牛羊肉'));

  StateEngine.mutateLifeDraft('记住家里燃气卡放在玄关第二个抽屉', lifeMem);
  StateEngine.mutateLifeDraft('小区地库车位在B2-108', lifeMem);
  assert.ok(lifeMem.memories.some(m => m.fact.includes('燃气卡放在玄关第二个抽屉')));
  assert.ok(lifeMem.memories.some(m => m.fact.includes('小区地库车位在B2-108')));

  // 4. Quoted custom card creation and incremental check-in
  const cardsLife = emptyLife();
  StateEngine.mutateLifeDraft('新建《英语单词打卡》卡，目标30', cardsLife);
  assert.equal(cardsLife.customCards.length, 1);
  assert.equal(cardsLife.customCards[0].title, '英语单词打卡');
  assert.equal(cardsLife.customCards[0].metricTarget, 30);
  assert.equal(cardsLife.customCards[0].metricValue, 0);

  StateEngine.mutateLifeDraft('英语单词打卡 +5', cardsLife);
  assert.equal(cardsLife.customCards[0].metricValue, 5);
});
