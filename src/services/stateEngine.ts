import {
  WorkspaceMode,
  StateMutationReceipt,
  ExpenseEntry,
  DealStage,
  CustomLivingCard,
} from '../types';
import { StorageService } from './storage';

export const StateEngine = {
  /**
   * 毫秒级无感意图嗅探器（Talk-to-Live-State 核心引擎）
   * 用户随口说一句话，自动解析并更新对应的活体状态卡，返回状态变更回执徽章
   */
  sniffAndMutate(text: string, currentMode: WorkspaceMode): StateMutationReceipt[] {
    const receipts: StateMutationReceipt[] = [];
    const clean = text.trim();
    if (!clean) return receipts;

    // 1. 嗅探「一句话新建自定义活体卡」
    const customMatch = clean.match(/(?:建一张|新建|创建|生成一张)\s*《?([^》”"\s]{2,14})》?\s*(?:卡|看板|面板)?/);
    if (customMatch && customMatch[1]) {
      const cardTitle = customMatch[1];
      const targetMatch = clean.match(/目标\s*(\d+)/);
      const targetVal = targetMatch ? parseInt(targetMatch[1], 10) : 100;
      const allCustom = StorageService.getCustomCards();
      const newCard: CustomLivingCard = {
        id: 'custom-' + Date.now(),
        mode: currentMode,
        title: cardTitle,
        icon: currentMode === 'work' ? '📊' : '🌟',
        metricLabel: '当前达成进度',
        metricValue: 10,
        metricTarget: targetVal,
        unit: clean.includes('小时') ? 'h' : clean.includes('万') ? '万' : '%',
        checklist: [
          { id: 'c-1', text: `启动「${cardTitle}」第一阶段里程碑`, done: true },
          { id: 'c-2', text: `推进「${cardTitle}」核心指标达标`, done: false },
        ],
      };
      allCustom.unshift(newCard);
      StorageService.saveCustomCards(allCustom);
      receipts.push({
        id: 'mut-' + Date.now() + '-custom',
        mode: currentMode,
        targetCardType: 'custom',
        targetCardTitle: cardTitle,
        summaryText: `✨ 已一句话生成专属活体卡：《${cardTitle}》`,
        deltaBadge: 'NEW CARD',
        timestamp: Date.now(),
      });
    }

    // 2. ToC【生活态】意图嗅探：随口记账与攒钱
    if (currentMode === 'life' || /(?:早饭|午饭|晚饭|喝了|买了个?|打车|花了|消费|存入小金库|攒了)/.test(clean)) {
      const wallet = StorageService.getWalletCard();

      // 2a. 攒钱/存入心愿金库
      const saveMatch = clean.match(/(?:存入|攒了|存进|小金库加)\s*(\d+(?:\.\d+)?)\s*(?:块|元)?/);
      if (saveMatch) {
        const amt = parseFloat(saveMatch[1]);
        wallet.wishSaved += amt;
        wallet.entries.unshift({
          id: 'exp-' + Date.now() + '-save',
          title: '心愿金库注入',
          amount: amt,
          type: 'saving',
          category: '金库✨',
          timestamp: Date.now(),
        });
        StorageService.saveWalletCard(wallet);
        receipts.push({
          id: 'mut-' + Date.now() + '-save',
          mode: 'life',
          targetCardType: 'wallet',
          targetCardTitle: '随口记账与小金库',
          summaryText: `💰 心愿小金库自动存入 ¥${amt.toFixed(0)}（已达成 ${Math.min(100, Math.round((wallet.wishSaved / wallet.wishTarget) * 100))}%）`,
          deltaBadge: `+¥${amt}`,
          timestamp: Date.now(),
        });
      }

      // 2b. 随口消费记账（支持一句话多笔：如“午饭吃了35，打车花了22”）
      const expRegex = /([^，。；！？\d]{1,10}?)\s*(?:花了|吃了|买了|付了|消费|喝了)?\s*(\d+(?:\.\d+)?)\s*(?:块钱|块|元)/g;
      let match: RegExpExecArray | null;
      while ((match = expRegex.exec(clean)) !== null) {
        const rawDesc = match[1].replace(/^(今天|刚刚|刚才|顺便|另外|还有|又)/, '').trim() || '日常消费';
        const amt = parseFloat(match[2]);
        if (rawDesc.includes('预算') || rawDesc.includes('万') || rawDesc.includes('存入') || rawDesc.includes('攒')) {
          continue;
        }
        let category: ExpenseEntry['category'] = '生活🏠';
        if (/饭|面|咖啡|拿铁|奶茶|吃|喝|餐|果|菜/.test(rawDesc)) category = '餐饮☕';
        else if (/车|地铁|公交|油|高铁|机票/.test(rawDesc)) category = '出行🚕';
        else if (/买|衣|鞋|包|淘宝|京东|超市/.test(rawDesc)) category = '购物🛍️';
        else if (/电影|游戏|玩|会员|票/.test(rawDesc)) category = '娱乐🎮';

        wallet.entries.unshift({
          id: 'exp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
          title: rawDesc,
          amount: amt,
          type: 'expense',
          category,
          timestamp: Date.now(),
        });
        StorageService.saveWalletCard(wallet);
        receipts.push({
          id: 'mut-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
          mode: 'life',
          targetCardType: 'wallet',
          targetCardTitle: '随口记账与小金库',
          summaryText: `💰 自动记账：[${category}] ${rawDesc} -¥${amt}`,
          deltaBadge: `-¥${amt}`,
          timestamp: Date.now(),
        });
      }

      // 2c. 身体状态栏（体重 / 喝水 / 精力熬夜 / 运动）
      const rpg = StorageService.getRpgStatusCard();
      let rpgChanged = false;

      const weightMatch = clean.match(/体重\s*(?:是|到了|降到|涨到)?\s*(\d{2,3}(?:\.\d+)?)\s*(?:kg|公斤|斤)?/i);
      if (weightMatch) {
        let w = parseFloat(weightMatch[1]);
        if (clean.includes('斤') && !clean.includes('公斤') && w > 80) w = +(w / 2).toFixed(1);
        rpg.weightKg = w;
        rpgChanged = true;
        receipts.push({
          id: 'mut-' + Date.now() + '-weight',
          mode: 'life',
          targetCardType: 'rpg_status',
          targetCardTitle: '三维人生状态栏',
          summaryText: `⚡ 体重曲线已自动刷新：${w} kg（距目标 ${(w - rpg.targetWeightKg).toFixed(1)} kg）`,
          deltaBadge: `${w}kg`,
          timestamp: Date.now(),
        });
      }

      if (/喝了?水|喝了?一杯|补水/.test(clean)) {
        rpg.waterCups = Math.min(8, rpg.waterCups + 1);
        rpg.energy = Math.min(100, rpg.energy + 4);
        rpgChanged = true;
        receipts.push({
          id: 'mut-' + Date.now() + '-water',
          mode: 'life',
          targetCardType: 'rpg_status',
          targetCardTitle: '三维人生状态栏',
          summaryText: `💧 饮水打卡 +1 杯（今日已达 ${rpg.waterCups}/8 杯），精力微升`,
          deltaBadge: `💧 ${rpg.waterCups}/8`,
          timestamp: Date.now(),
        });
      }

      if (/熬夜|失眠|好累|太累|头疼|没睡好|疲惫/.test(clean)) {
        rpg.energy = Math.max(15, rpg.energy - 18);
        rpg.moodBuff = '😴 睡眠透支 · 宜早点休息';
        rpgChanged = true;
        receipts.push({
          id: 'mut-' + Date.now() + '-tired',
          mode: 'life',
          targetCardType: 'rpg_status',
          targetCardTitle: '三维人生状态栏',
          summaryText: `🔋 感知到你处于疲惫状态，精力条已更新为 ${rpg.energy}%，挂起休息提醒 Buff`,
          deltaBadge: `🔋 -18%`,
          timestamp: Date.now(),
        });
      } else if (/跑步|健身|运动|睡了个好觉|满血复活/.test(clean)) {
        rpg.energy = Math.min(100, rpg.energy + 20);
        rpg.streakDays += 1;
        rpg.moodBuff = '🔥 多巴胺充沛 · 元气满格';
        rpgChanged = true;
        receipts.push({
          id: 'mut-' + Date.now() + '-sport',
          mode: 'life',
          targetCardType: 'rpg_status',
          targetCardTitle: '三维人生状态栏',
          summaryText: `🏃 运动/恢复打卡成功！连续打卡 ${rpg.streakDays} 天，精力恢复至 ${rpg.energy}%`,
          deltaBadge: `🔥 +20%`,
          timestamp: Date.now(),
        });
      }

      if (rpgChanged) {
        StorageService.saveRpgStatusCard(rpg);
      }

      // 2d. 人脉与亲友忌口/喜好嗅探
      const personMatch = clean.match(/(?:记一下[，,]?)?([^\s，。！？、“”]{2,5}?)(?:对([^，。！？]+?)过敏|不吃([^，。！？]+)|讨厌([^，。！？]+)|喜欢([^，。！？]+)|生日是([^，。！？]+))/);
      if (personMatch && !['我', '今天', '刚刚', '我们'].includes(personMatch[1])) {
        const pName = personMatch[1];
        const persons = StorageService.getPersonProfiles();
        let target = persons.find((p) => p.name.includes(pName) || pName.includes(p.name));
        if (!target) {
          target = {
            id: 'p-' + Date.now(),
            name: pName,
            relation: '重要人脉 / 亲友',
            taboos: [],
            preferences: [],
            updatedAt: Date.now(),
          };
          persons.unshift(target);
        }
        if (personMatch[2]) target.taboos.push(`${personMatch[2]}过敏`);
        if (personMatch[3]) target.taboos.push(`不吃${personMatch[3]}`);
        if (personMatch[4]) target.taboos.push(`忌讳${personMatch[4]}`);
        if (personMatch[5]) target.preferences.push(`喜欢${personMatch[5]}`);
        if (personMatch[6]) target.nextImportantDate = `生日 ${personMatch[6]}`;
        target.updatedAt = Date.now();
        StorageService.savePersonProfiles(persons);
        StorageService.addMemory(`${pName}档案更新：${clean}`, 'person', 'life');
        receipts.push({
          id: 'mut-' + Date.now() + '-person',
          mode: 'life',
          targetCardType: 'relationships',
          targetCardTitle: '人脉与亲友档案簿',
          summaryText: `❤️ 已自动归档至【${pName}】人脉名片，下次聚餐/送礼前自动提醒`,
          deltaBadge: `@${pName}`,
          timestamp: Date.now(),
        });
      }
    }

    // 3. ToB【搞钱态】意图嗅探：客户 CRM 商机建档与项目死线拆解
    if (currentMode === 'work' || /(?:总|经理|客户|甲方|预算|万|报价|合同|方案|死线|周[一二三四五六日]前)/.test(clean)) {
      const deals = StorageService.getCrmDeals();

      // 3a. 客户与预算/阶段嗅探
      const clientMatch = clean.match(/([A-Za-z0-9\u4e00-\u9fa5]{2,10}?(?:总|经理|总监|主理人|老板|科技|集团|工作室))/);
      const budgetMatch = clean.match(/(?:预算|金额|报价|加到|批了|定在|签了?)\s*(\d+(?:\.\d+)?)\s*(万|元|w|k)?/i);

      if (clientMatch || (currentMode === 'work' && budgetMatch)) {
        const rawClient = clientMatch
          ? clientMatch[1].replace(/^(刚见完|见了|跟|和|找|给|收到)/, '').trim()
          : deals[0]?.clientName || '新重点客户';

        let deal = deals.find((d) => d.clientName.includes(rawClient) || rawClient.includes(d.clientName.split('·')[0].trim()));

        let amount = deal?.budgetAmount || 100000;
        if (budgetMatch) {
          const num = parseFloat(budgetMatch[1]);
          const unit = (budgetMatch[2] || '').toLowerCase();
          if (unit === '万' || unit === 'w' || num < 500) amount = num * 10000;
          else if (unit === 'k') amount = num * 1000;
          else amount = num;
        }

        let stage: DealStage = deal?.stage || '需求确认';
        let winProb = deal?.winProbability || 50;
        if (/初步|刚认识|刚接触/.test(clean)) {
          stage = '初步接触';
          winProb = 30;
        } else if (/报价|发方案|给方案/.test(clean)) {
          stage = '方案报价';
          winProb = 65;
        } else if (/谈判|法务|比价|批到了|加到/.test(clean)) {
          stage = '商务谈判';
          winProb = 85;
        } else if (/签合同|成交|打款|赢单|搞定/.test(clean)) {
          stage = '赢单成交';
          winProb = 100;
        }

        const painMatch = clean.match(/(?:痛点是|需要|想做|关心|担心)([^，。；！？]+)/);
        const actionMatch = clean.match(/((?:下?周[一二三四五六日天]|明天|月底|\d+号)[^，。；！？]+)/);

        if (!deal) {
          deal = {
            id: 'deal-' + Date.now(),
            clientName: rawClient,
            budgetAmount: amount,
            stage,
            winProbability: winProb,
            painPoints: painMatch ? painMatch[1].trim() : clean.slice(0, 36),
            internalBottomLine: '系统自动建档 · 内部底线待补充（外发时自动脱敏）',
            nextAction: actionMatch ? actionMatch[1].trim() : '48小时内跟进发送方案确认单',
            updatedAt: Date.now(),
          };
          deals.unshift(deal);
        } else {
          deal.budgetAmount = amount;
          deal.stage = stage;
          deal.winProbability = winProb;
          if (painMatch) deal.painPoints = painMatch[1].trim();
          if (actionMatch) deal.nextAction = actionMatch[1].trim();
          deal.updatedAt = Date.now();
        }

        StorageService.saveCrmDeals(deals);
        StorageService.recordWorkIntensityBridge(6); // 单向同步工作强度至生活态精力条

        receipts.push({
          id: 'mut-' + Date.now() + '-crm',
          mode: 'work',
          targetCardType: 'crm',
          targetCardTitle: '零填表·客户商机 CRM',
          summaryText: `🤝 商机已自动建档/刷新：【${deal.clientName}】阶段→${deal.stage} | 预算 ¥${(deal.budgetAmount / 10000).toFixed(1)}万`,
          deltaBadge: `¥${(deal.budgetAmount / 10000).toFixed(1)}万 · ${deal.stage}`,
          timestamp: Date.now(),
        });
      }

      // 3b. 项目死线待办拆解
      const taskMatch = clean.match(/((?:本周[一二三四五六日天]|下周[一二三四五六日天]|周[一二三四五六日天]|明天|后天|月底|\d+号)前?)\s*(?:要|需要|必须|得)?\s*(?:完成|提交|交|发|搞定|上线)([^，。；！？]+)/);
      if (taskMatch) {
        const deadline = taskMatch[1].trim();
        const taskTitle = `交付/完成${taskMatch[2].trim()}`;
        const tasks = StorageService.getProjectTasks();
        tasks.unshift({
          id: 'task-' + Date.now(),
          title: taskTitle,
          assignee: '我',
          deadline,
          priority: 'high',
          done: false,
        });
        StorageService.saveProjectTasks(tasks);
        receipts.push({
          id: 'mut-' + Date.now() + '-task',
          mode: 'work',
          targetCardType: 'projects',
          targetCardTitle: '项目死线推进看板',
          summaryText: `🎯 自动拆解高优死线任务：[${deadline}] ${taskTitle}`,
          deltaBadge: `⏰ ${deadline}`,
          timestamp: Date.now(),
        });
      }
    }

    return receipts;
  },
};
