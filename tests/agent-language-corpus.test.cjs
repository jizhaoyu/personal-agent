const {test}=require('node:test');const assert=require('node:assert/strict');const {singles,sessions}=require('./agent-language-corpus.cjs');
test('oral evaluation corpus has 200 unique single inputs and 40 independent multi-turn sessions',()=>{
 assert.equal(singles.length,200);assert.equal(new Set(singles.map(x=>x.text)).size,200);assert.equal(sessions.length,40);
 for(const sample of singles){assert.ok(sample.expected);assert.ok(sample.seed.every(t=>t.space===sample.space));}
 for(const session of sessions){assert.ok(session.turns.length>=3);assert.ok(session.expected.records);}
});
