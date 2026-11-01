#!/usr/bin/env node
/**
 * Looma Model Context Protocol (MCP) Server
 * 
 * 符合 MCP 2024-11-05 标准规范与 JSON-RPC 2.0 协议
 * 为外部大模型（Claude Desktop, Cursor, 本地智能体等）提供安全、可验证的私有数据底座接口。
 * 遵循《悬壶》架构设计：智能体只读授权数据，写入仅允许提交待人类确权的草稿提案。
 */

const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// 1. 运行时 ABI 自动适配探测
function ensureCompatibleRuntime() {
  if (process.env.ELECTRON_RUN_AS_NODE === '1') return true;
  try {
    require('better-sqlite3');
    return true;
  } catch (err) {
    if (err.code === 'ERR_DLOPEN_FAILED' || err.message.includes('NODE_MODULE_VERSION')) {
      const electronBin = resolveElectronPath();
      if (!electronBin || !fs.existsSync(electronBin)) {
        console.error('[Looma MCP] 错误: better-sqlite3 编译自 Electron，但未找到可用的 Electron 运行时:', electronBin);
        process.exit(1);
      }
      const child = spawn(electronBin, [__filename, ...process.argv.slice(2)], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['inherit', 'inherit', 'inherit']
      });
      child.on('exit', code => process.exit(code || 0));
      return false;
    }
    throw err;
  }
}

function resolveElectronPath() {
  try {
    const pkgElectron = require('electron');
    if (typeof pkgElectron === 'string' && fs.existsSync(pkgElectron)) return pkgElectron;
  } catch (e) {}

  const candidates = [
    path.join(__dirname, '../node_modules/electron/dist/electron.exe'),
    path.join(__dirname, '../output/trial/Looma-trial-20261101T092207Z-bd34bd969a-win32-x64/Looma.exe'),
    path.join(__dirname, '../../Looma.exe')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

if (!ensureCompatibleRuntime()) {
  return;
}

const { createPersistence } = require('./persistence.cjs');

// 2. 数据库路径解析
function resolveDatabasePath() {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf('--db-path');
  if (dbIndex !== -1 && args[dbIndex + 1]) {
    return path.resolve(args[dbIndex + 1]);
  }
  if (process.env.LOOMA_DB_PATH) {
    return path.resolve(process.env.LOOMA_DB_PATH);
  }
  const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(process.env.HOME || '', 'Library/Application Support') : path.join(process.env.HOME || '', '.config'));
  const prodDb = path.join(appData, 'Looma', 'looma.sqlite');
  if (fs.existsSync(prodDb)) return prodDb;

  const localDb = path.resolve(__dirname, '../looma.sqlite');
  if (fs.existsSync(localDb)) return localDb;

  return prodDb;
}

// 3. MCP 工具与资源元数据定义
const TOOLS_METADATA = [
  {
    name: 'looma_search_records',
    description: '全文搜索 Looma 私有数据底座（支持消息会话、客户项目、待办任务、跟进回访、记忆事实）。',
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', enum: ['work', 'life'], description: '空间，默认 work' },
        kind: { type: 'string', description: '类型：message, task, engagement, followup, memory' },
        query: { type: 'string', description: '搜索词（支持中文分词与模糊匹配）' },
        limit: { type: 'number', description: '结果上限，默认 20，最高 100' }
      },
      required: ['query']
    }
  },
  {
    name: 'looma_get_tasks',
    description: '获取当前业务待办任务列表，支持查看未完成事项或到期待办。',
    inputSchema: {
      type: 'object',
      properties: {
        dueOnly: { type: 'boolean', description: '是否仅筛选今天到期或已逾期的待办' },
        limit: { type: 'number', description: '返回上限，默认 50' }
      }
    }
  },
  {
    name: 'looma_get_engagements',
    description: '获取客户项目推进全景，包含推进阶段（初步接触/方案报价/商务谈判等）、预算金额、共识摘要与下一步行动。',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: '客户名称或项目名称列表' },
        limit: { type: 'number', description: '返回上限，默认 50' }
      }
    }
  },
  {
    name: 'looma_get_followups',
    description: '获取客户沟通后的等待跟进事项（waiting: 等待对方确认；question: 自设疑问待求证）。',
    inputSchema: {
      type: 'object',
      properties: {
        dueOnly: { type: 'boolean', description: '是否仅获取已到复核时间的事项' },
        limit: { type: 'number', description: '返回上限，默认 50' }
      }
    }
  },
  {
    name: 'looma_get_memories',
    description: '获取已沉淀并确权的用户事实记忆（包含习惯、偏好、经验、业务事实，自动过滤退役项）。',
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', enum: ['work', 'life'], description: '空间，默认 work' },
        category: { type: 'string', enum: ['preference', 'habit', 'experience', 'person', 'business'], description: '分类筛选' },
        limit: { type: 'number', description: '返回上限，默认 50' }
      }
    }
  },
  {
    name: 'looma_propose_action',
    description: '【悬壶可验证写入原则】智能体提交新待办/记忆建议。智能体严禁直接静默写库，此接口将提案安全写入待审草稿区，由人类在 Looma 界面审核确权。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceText: { type: 'string', description: '产生该建议的沟通原文或上下文' },
        proposedTask: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '待办标题' },
            assignee: { type: 'string', description: '负责人' },
            deadline: { type: 'string', description: '截止日期，如 2026-11-15' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            engagementId: { type: 'string', description: '关联项目 ID（可选）' }
          },
          required: ['title']
        },
        proposedMemory: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: ['preference', 'habit', 'experience', 'person', 'business'] },
            fact: { type: 'string', description: '事实陈述' },
            importance: { type: 'number', description: '重要程度 1-10' }
          },
          required: ['category', 'fact']
        }
      },
      required: ['sourceText']
    }
  },
  {
    name: 'looma_get_stats',
    description: '获取 Looma 空间统计指标（总记录数、待处理任务数、到期待办数、待跟进事项数、主库体积）。',
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', enum: ['work', 'life'], description: '空间，默认 work' }
      }
    }
  }
];

const RESOURCES_METADATA = [
  {
    uri: 'looma://work/overview',
    name: '工作看板总览',
    mimeType: 'application/json',
    description: '工作空间聚合状态，包含今日到期、逾期待办及等待跟进概览。'
  },
  {
    uri: 'looma://work/tasks/open',
    name: '未完成待办事项',
    mimeType: 'application/json',
    description: '当前所有的开放待办事项清单。'
  },
  {
    uri: 'looma://work/engagements',
    name: '客户合作推进表',
    mimeType: 'application/json',
    description: '全部在推进中的客户业务线与里程碑。'
  },
  {
    uri: 'looma://work/memories',
    name: '已确权长期记忆',
    mimeType: 'application/json',
    description: '已由用户审核入库的有效工作事实记忆。'
  }
];

// 4. MCP 服务端主体实现
class LoomaMCPServer {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.persistence = null;
  }

  async init() {
    this.persistence = await createPersistence({ filePath: this.dbPath });
    await this.persistence.request({ op: 'init' });
  }

  async handleToolCall(name, args = {}) {
    const space = args.space || 'work';
    switch (name) {
      case 'looma_search_records': {
        const kind = args.kind || 'message';
        const limit = Math.min(100, Math.max(1, args.limit || 20));
        const res = await this.persistence.request({
          op: 'list',
          space,
          kind,
          query: args.query,
          limit
        });
        if (!res || !res.items) return { error: res?.error || '搜索失败' };
        return { count: res.items.length, items: res.items };
      }

      case 'looma_get_tasks': {
        const limit = Math.min(100, Math.max(1, args.limit || 50));
        const res = await this.persistence.request({
          op: 'list',
          space: 'work',
          kind: 'task',
          dueOnly: Boolean(args.dueOnly),
          limit
        });
        if (!res || !res.items) return { error: res?.error || '获取待办失败' };
        const openTasks = res.items.filter(t => !t.done);
        return { totalFound: openTasks.length, tasks: openTasks };
      }

      case 'looma_get_engagements': {
        const limit = Math.min(100, Math.max(1, args.limit || 50));
        const command = { op: 'list', space: 'work', kind: 'engagement', limit };
        if (args.names && Array.isArray(args.names)) command.names = args.names;
        const res = await this.persistence.request(command);
        if (!res || !res.items) return { error: res?.error || '获取项目失败' };
        return { count: res.items.length, engagements: res.items };
      }

      case 'looma_get_followups': {
        const limit = Math.min(100, Math.max(1, args.limit || 50));
        const res = await this.persistence.request({
          op: 'list',
          space: 'work',
          kind: 'followup',
          dueOnly: Boolean(args.dueOnly),
          limit
        });
        if (!res || !res.items) return { error: res?.error || '获取跟进失败' };
        return { count: res.items.length, followups: res.items };
      }

      case 'looma_get_memories': {
        const limit = Math.min(100, Math.max(1, args.limit || 50));
        const res = await this.persistence.request({
          op: 'list',
          space,
          kind: 'memory',
          limit
        });
        if (!res || !res.items) return { error: res?.error || '获取记忆失败' };
        let items = res.items.filter(m => m.status === 'active');
        if (args.category) items = items.filter(m => m.category === args.category);
        return { count: items.length, memories: items };
      }

      case 'looma_propose_action': {
        const sessionId = `mcp-proposal-${Date.now()}`;
        const sourceMessageId = `msg-mcp-${Date.now()}`;
        const now = Date.now();
        const operations = [];

        if (args.proposedTask) {
          const taskId = `task-${Date.now()}`;
          operations.push({
            target: 'task',
            entityId: taskId,
            before: null,
            after: {
              id: taskId,
              title: args.proposedTask.title,
              assignee: args.proposedTask.assignee || '我',
              deadline: args.proposedTask.deadline || new Date().toISOString().slice(0, 10),
              priority: args.proposedTask.priority || 'medium',
              done: false,
              engagementId: args.proposedTask.engagementId || undefined,
              sourceDeadlineText: '由外部智能体分析建议'
            }
          });
        }

        if (args.proposedMemory) {
          const memoryId = `mem-${Date.now()}`;
          operations.push({
            target: 'memory',
            entityId: memoryId,
            before: null,
            after: {
              id: memoryId,
              mode: 'work',
              category: args.proposedMemory.category,
              fact: args.proposedMemory.fact,
              sourceMessageId,
              createdAt: now,
              importance: args.proposedMemory.importance || 5,
              status: 'active'
            }
          });
        }

        const draft = {
          id: 'active-work',
          sessionId,
          mode: 'work',
          text: args.sourceText,
          sourceVersion: 0,
          draftVersion: 1,
          sourceMessageId,
          status: 'review',
          updatedAt: now,
          proposal: {
            id: `prop-${sessionId}`,
            sourceMessageId,
            sourceText: args.sourceText,
            mode: 'work',
            baseRevision: 0,
            operations,
            warnings: ['该提案来自外部 MCP 智能体，需经由您当面点击核验以确权落地。'],
            createdAt: now
          }
        };

        const res = await this.persistence.request({
          op: 'saveDraft',
          space: 'work',
          draft
        });

        if (!res.ok) return { error: `保存提案草稿失败: ${res.error}` };
        return {
          status: 'PROPOSAL_STAGED_FOR_HUMAN_REVIEW',
          message: '智能体建议已成功保存至待审草稿区。人类用户将在 Looma 界面看到该提案卡片并执行最终确权。',
          sessionId,
          operationsCount: operations.length
        };
      }

      case 'looma_get_stats': {
        const stats = await this.persistence.request({ op: 'stats', space });
        return stats;
      }

      default:
        throw new Error(`未知工具: ${name}`);
    }
  }

  async handleResourceRead(uri) {
    switch (uri) {
      case 'looma://work/overview': {
        const home = await this.persistence.request({ op: 'workHome', space: 'work' });
        const stats = await this.persistence.request({ op: 'stats', space: 'work' });
        return JSON.stringify({ home, stats }, null, 2);
      }
      case 'looma://work/tasks/open': {
        const res = await this.persistence.request({ op: 'list', space: 'work', kind: 'task', limit: 100 });
        const open = (res.items || []).filter(t => !t.done);
        return JSON.stringify(open, null, 2);
      }
      case 'looma://work/engagements': {
        const res = await this.persistence.request({ op: 'list', space: 'work', kind: 'engagement', limit: 100 });
        return JSON.stringify(res.items || [], null, 2);
      }
      case 'looma://work/memories': {
        const res = await this.persistence.request({ op: 'list', space: 'work', kind: 'memory', limit: 100 });
        const active = (res.items || []).filter(m => m.status === 'active');
        return JSON.stringify(active, null, 2);
      }
      default:
        throw new Error(`未知资源 URI: ${uri}`);
    }
  }

  close() {
    if (this.persistence) {
      this.persistence.close();
      this.persistence = null;
    }
  }
}

// 5. JSON-RPC 消息分发调度器
async function runStdioServer() {
  const dbPath = resolveDatabasePath();
  const server = new LoomaMCPServer(dbPath);
  try {
    await server.init();
  } catch (err) {
    console.error(`[Looma MCP] 数据库初始化失败 (${dbPath}):`, err);
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const sendResponse = (id, result, error = null) => {
    const payload = { jsonrpc: '2.0', id };
    if (error) payload.error = error;
    else payload.result = result;
    process.stdout.write(JSON.stringify(payload) + '\n');
  };

  rl.on('line', async line => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch (e) {
      sendResponse(null, null, { code: -32700, message: 'Parse error' });
      return;
    }

    const { id, method, params } = request;

    try {
      switch (method) {
        case 'initialize': {
          sendResponse(id, {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
              resources: {}
            },
            serverInfo: {
              name: 'looma-mcp-server',
              version: '1.0.0',
              description: 'Looma (悬壶) 可验证隐私数据底座 MCP 服务器'
            }
          });
          break;
        }

        case 'notifications/initialized': {
          // 客户端就绪确认，无需回复
          break;
        }

        case 'ping': {
          sendResponse(id, {});
          break;
        }

        case 'tools/list': {
          sendResponse(id, { tools: TOOLS_METADATA });
          break;
        }

        case 'tools/call': {
          const { name, arguments: args } = params || {};
          const resultData = await server.handleToolCall(name, args || {});
          sendResponse(id, {
            content: [
              {
                type: 'text',
                text: JSON.stringify(resultData, null, 2)
              }
            ],
            isError: Boolean(resultData?.error)
          });
          break;
        }

        case 'resources/list': {
          sendResponse(id, { resources: RESOURCES_METADATA });
          break;
        }

        case 'resources/read': {
          const { uri } = params || {};
          const content = await server.handleResourceRead(uri);
          sendResponse(id, {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: content
              }
            ]
          });
          break;
        }

        default:
          if (id !== undefined && id !== null) {
            sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
          }
      }
    } catch (error) {
      if (id !== undefined && id !== null) {
        sendResponse(id, null, { code: -32603, message: error.message || 'Internal error' });
      }
    }
  });

  const cleanup = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

runStdioServer().catch(err => {
  console.error('[Looma MCP FATAL]', err);
  process.exit(1);
});
