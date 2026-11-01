const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');

const electronBin = require('electron');
const serverPath = path.join(__dirname, '../electron/mcp-server.cjs');

async function testMCPServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-mcp-test-'));
  const testDb = path.join(tmpDir, 'test.sqlite');

  console.log('[MCP TEST] 启动 MCP Server 测试，临时数据库:', testDb);

  const child = spawn(electronBin, [serverPath, '--db-path', testDb], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'inherit']
  });

  let messageId = 1;
  const pendingRequests = new Map();

  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 保留未完整的尾部
    for (const line of lines) {
      if (!line.trim()) continue;
      const res = JSON.parse(line);
      if (res.id !== undefined && pendingRequests.has(res.id)) {
        const { resolve, reject } = pendingRequests.get(res.id);
        pendingRequests.delete(res.id);
        if (res.error) reject(new Error(res.error.message || JSON.stringify(res.error)));
        else resolve(res.result);
      }
    }
  });

  function sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = messageId++;
      pendingRequests.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  try {
    // 1. 测试 initialize
    console.log('[MCP TEST] 1. 测试 initialize...');
    const initRes = await sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'test-runner', version: '1.0' }
    });
    assert.strictEqual(initRes.serverInfo.name, 'looma-mcp-server');
    assert.strictEqual(initRes.protocolVersion, '2024-11-05');
    console.log('✓ initialize 成功:', initRes.serverInfo.name, initRes.serverInfo.version);

    // 2. 测试 tools/list
    console.log('[MCP TEST] 2. 测试 tools/list...');
    const toolsRes = await sendRequest('tools/list');
    assert.strictEqual(toolsRes.tools.length, 7);
    const toolNames = toolsRes.tools.map(t => t.name);
    assert(toolNames.includes('looma_search_records'));
    assert(toolNames.includes('looma_get_tasks'));
    assert(toolNames.includes('looma_get_engagements'));
    assert(toolNames.includes('looma_get_followups'));
    assert(toolNames.includes('looma_get_memories'));
    assert(toolNames.includes('looma_propose_action'));
    assert(toolNames.includes('looma_get_stats'));
    console.log('✓ tools/list 成功，注册了 7 个业务工具:', toolNames.join(', '));

    // 3. 测试 tools/call looma_get_stats
    console.log('[MCP TEST] 3. 测试 tools/call looma_get_stats...');
    const statsRes = await sendRequest('tools/call', {
      name: 'looma_get_stats',
      arguments: { space: 'work' }
    });
    assert(!statsRes.isError);
    const stats = JSON.parse(statsRes.content[0].text);
    assert.strictEqual(stats.space, 'work');
    console.log('✓ looma_get_stats 成功，初始总记录数:', stats.total);

    // 4. 测试 tools/call looma_propose_action (悬壶可验证原则写入提案)
    console.log('[MCP TEST] 4. 测试 tools/call looma_propose_action...');
    const proposeRes = await sendRequest('tools/call', {
      name: 'looma_propose_action',
      arguments: {
        sourceText: '张总希望在下周五前拿到私有化部署架构方案',
        proposedTask: {
          title: '编制张总客户私有化部署架构设计方案',
          priority: 'high',
          deadline: '2026-11-06'
        },
        proposedMemory: {
          category: 'business',
          fact: '张总团队对私有化部署和数据物理隔离有强合规诉求',
          importance: 8
        }
      }
    });
    assert(!proposeRes.isError);
    const proposal = JSON.parse(proposeRes.content[0].text);
    assert.strictEqual(proposal.status, 'PROPOSAL_STAGED_FOR_HUMAN_REVIEW');
    assert.strictEqual(proposal.operationsCount, 2);
    console.log('✓ looma_propose_action 成功，草稿已暂存待人类确认:', proposal.status);

    // 5. 测试 resources/list 和 resources/read
    console.log('[MCP TEST] 5. 测试 resources/list & resources/read...');
    const resList = await sendRequest('resources/list');
    assert.strictEqual(resList.resources.length, 4);
    const readRes = await sendRequest('resources/read', { uri: 'looma://work/overview' });
    assert(readRes.contents && readRes.contents[0].text);
    const overview = JSON.parse(readRes.contents[0].text);
    assert(overview.home);
    console.log('✓ resources/read 成功，获取工作看板概览');

    console.log('\n[MCP TEST] 全部 MCP 测试用例 100% 通过！');

  } finally {
    child.kill();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch(e) {}
  }
}

testMCPServer().catch(err => {
  console.error('[MCP TEST FAILED]', err);
  process.exit(1);
});
