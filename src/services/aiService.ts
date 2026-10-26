import {
  AppSettings,
  Message,
  MemoryItem,
  JournalArtifact,
  WorkspaceMode,
  StateMutationReceipt,
} from '../types';
import { StorageService } from './storage';
import { StateEngine } from './stateEngine';

export const AiService = {
  async sendMessage(
    messages: Message[],
    settings: AppSettings,
    memories: MemoryItem[],
    mode: WorkspaceMode = 'life'
  ): Promise<{ reply: string; mutations: StateMutationReceipt[] }> {
    const lastUserMsg = messages[messages.length - 1]?.content || '';

    // 1. 触发 Tier-0 毫秒级无感意图嗅探与活体状态更新
    const mutations = StateEngine.sniffAndMutate(lastUserMsg, mode);

    // 2. 如果未配置 API Key，启动双态高保真智能应答
    if (!settings.apiKey) {
      await new Promise((res) => setTimeout(res, 450));
      const reply = this.generateMockReply(messages, memories, mode, mutations);
      this.triggerMemoryRefinement(messages, mode);
      return { reply, mutations };
    }

    try {
      const modeRolePrompt =
        mode === 'work'
          ? `【当前空间：💼 搞钱态（商务防窥模式）】你现在的身份是用户的“首席商务幕僚 Looma Pro”。语气干练、专业、高执行力，绝不提及任何个人私密生活信息。`
          : `【当前空间：🌙 生活态（私人伴生模式）】你现在的身份是用户的“温暖生活搭子 ${settings.personaName}”。语气温柔、松弛、体贴。`;

      const mutationContext =
        mutations.length > 0
          ? `\n【系统后台已自动完成的活体状态卡更新（请在回复中自然告诉用户你已帮他更新好了，无需他手动填表）】：\n` +
            mutations.map((m) => `- ${m.summaryText}`).join('\n')
          : '';

      const memoryPrompt =
        memories.length > 0
          ? `\n【当前空间已记住的背景事实】：\n` +
            memories
              .slice(0, 8)
              .map((m, idx) => `${idx + 1}. ${m.fact}`)
              .join('\n')
          : '';

      const systemMessage = {
        role: 'system',
        content: `${settings.systemPrompt}\n${modeRolePrompt}${mutationContext}${memoryPrompt}\n当前时间：${new Date().toLocaleString()}`,
      };

      const apiMessages = [
        systemMessage,
        ...messages.slice(-10).map((m) => ({
          role: m.role,
          content: m.content,
        })),
      ];

      const endpoint = `${settings.apiBaseUrl.replace(/\/+$/, '')}/chat/completions`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.modelName || 'deepseek-chat',
          messages: apiMessages,
          temperature: 0.8,
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const reply =
        data.choices?.[0]?.message?.content ||
        this.generateMockReply(messages, memories, mode, mutations);

      this.triggerMemoryRefinement(messages, mode);
      return { reply, mutations };
    } catch (err) {
      console.warn('API 调用回退本地引擎:', err);
      const reply = this.generateMockReply(messages, memories, mode, mutations);
      return { reply, mutations };
    }
  },

  triggerMemoryRefinement(history: Message[], mode: WorkspaceMode) {
    const recentUserMsgs = history
      .filter((m) => m.role === 'user')
      .slice(-2)
      .map((m) => m.content)
      .join(' | ');

    const patterns =
      mode === 'work'
        ? [
            /(?:底线是|原则是|折扣最多|合同要求|客户偏好)([^，。！？\n]{3,25})/g,
            /(?:我们公司|主打产品|核心优势是)([^，。！？\n]{3,25})/g,
          ]
        : [
            /(?:我喜欢|我最喜欢|偏爱|我爱吃|我常喝)([^，。！？\n]{2,18})/g,
            /(?:我不喜欢|讨厌|受不了|过敏|不吃)([^，。！？\n]{2,18})/g,
            /(?:我的目标是|我最近在|我的生日是)([^，。！？\n]{2,20})/g,
          ];

    for (const pattern of patterns) {
      const match = pattern.exec(recentUserMsgs);
      if (match && match[0]) {
        const fact = match[0].trim();
        const existing = StorageService.getMemories(mode);
        if (!existing.some((m) => m.fact.includes(fact) || fact.includes(m.fact))) {
          StorageService.addMemory(fact, mode === 'work' ? 'business' : 'preference', mode);
          break;
        }
      }
    }
  },

  async generateDailyJournal(
    messages: Message[],
    settings: AppSettings,
    mode: WorkspaceMode = 'life'
  ): Promise<JournalArtifact> {
    const todayStr = new Date().toISOString().slice(0, 10);
    const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.content);
    const goldenQuote =
      userTexts.length > 0
        ? userTexts[userTexts.length - 1]
        : mode === 'work'
        ? '高效推进核心商机，保持专业节奏。'
        : '今天在屏幕前平静地度过了一段时光。';

    if (mode === 'work') {
      const deals = StorageService.getCrmDeals();
      const totalPipeline = deals.reduce((s, d) => s + d.budgetAmount, 0);
      return {
        id: 'journal-work-' + Date.now(),
        mode: 'work',
        date: todayStr,
        title: '今日商务推进战报',
        mood: '💼 高效笃定',
        userGoldenQuote: goldenQuote.slice(0, 65),
        aiReflection: `今日已零填表跟进 ${deals.length} 个重点商机，总商机池规模达 ¥${(totalPipeline / 10000).toFixed(1)} 万。所有关键节点均已锁定，明日继续稳步收网。`,
        stickers: ['💼', '📈', '🎯'],
        createdAt: Date.now(),
      };
    }

    const wallet = StorageService.getWalletCard();
    const rpg = StorageService.getRpgStatusCard();
    return {
      id: 'journal-life-' + Date.now(),
      mode: 'life',
      date: todayStr,
      title: `${new Date().getMonth() + 1}月的生活灵犀手记`,
      mood: rpg.moodBuff || '☕ 温暖惬意',
      userGoldenQuote: goldenQuote.slice(0, 65),
      aiReflection: `今天你的精力值保持在 ${rpg.energy}%，心愿金库已累计攒下 ¥${wallet.wishSaved}。不用刻意填表打卡，你认真生活的每一个瞬间，我都替你妥帖收好了。`,
      stickers: ['🌙', '✨', '☕'],
      createdAt: Date.now(),
    };
  },

  generateMockReply(
    messages: Message[],
    memories: MemoryItem[],
    mode: WorkspaceMode,
    mutations: StateMutationReceipt[]
  ): string {
    if (mutations.length > 0) {
      const summaryLines = mutations.map((m) => `• ${m.summaryText}`).join('\n');
      if (mode === 'work') {
        return `收到！已为您免填表自动同步至【搞钱态 · 活体工作台】：\n${summaryLines}\n\n您可以随时点击下方徽章查看看板，或一键导出脱敏后的《客户交付对齐单》发给对方确认。`;
      }
      return `好嘞，不用你动手填表，我已经悄悄帮你记进【活体状态卡】啦✨：\n${summaryLines}\n\n点一下气泡下面的发光徽章就能直接去看卡片细节哦～`;
    }

    const lastUserMsg = messages[messages.length - 1]?.content || '';
    if (mode === 'work') {
      return `明白。作为您的首席商务幕僚，我已记录该事项。您可以直接对我说“张总预算加到20万，周五前交方案”，我会自动为您更新 CRM 漏斗与死线看板。`;
    }

    if (lastUserMsg.includes('累') || lastUserMsg.includes('加班')) {
      return `摸摸头～工作再忙也别委屈自己，去倒杯温水歇五分钟吧！你的状态面板我都帮你看着呢。`;
    }

    return `我在听呢～不管是今天花了多少钱、喝了几杯水、体重多少，还是哪位朋友有什么忌口，你只管随口跟我念叨，剩下的建表归档全交给我！✨`;
  },
};
