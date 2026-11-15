export type LifeRoute = 'fact'|'action'|'original';
export interface LifeFragment { text:string; start:number; end:number; route:LifeRoute }

const question=/[？?]|(?:吗|么|是不是|是否|能不能|有没有|不知道|不清楚|不确定|拿不准|待确认)/;
const uncertain=/如果|假如|假设|要是|举个例|举例|比如|只是例子|只是计划|差点|可能|也许|预计|听说|我猜|还没|尚未|(?:并?没|未)(?:挣|赚|花|买|付|交|存|攒|喝|跑|去|到|称|收|入账|做|发)|没有(?:挣|赚|花|买|付|交|存|攒|喝|跑|去|到|称|收|做|发)|(?:不是|并非).{0,12}(?:收入|支出|到账|发生|已完成)|别.{0,14}(?:记账|记到|记成|入账)|不(?:准备|打算)现在记账/;
const otherOwner=/(?<![请给帮带跟和同])(?<!(?:请|给|帮|带|跟|和|同)我)(?:别人|他人|我(?:妈|爸|姐|哥|弟|妹|朋友|同事|同学|老公|老婆|对象)|同事|同学|朋友|室友|邻居|亲戚|老板|领导|闺蜜|客户|他们|她们|对方)(?:的|刚|今天|昨天|最近|已经|也)?.{0,16}(?:挣|赚|花|存|攒|中了|收到了?|付了|买了)(?!.{0,12}(?:给我|还给我|AA|aa|我出了|我付了))/;
const definiteAction=/(?:提醒我|提醒一下|请提醒|(?:记|加|新增|添加|留)(?:一条|一个|个|两|二|2|三|几)?(?:件事|待办|任务)|(?:给我|帮我|请|先)记(?:一条|一下|下来|下|着|住|上|一笔|(?:两|二|2|三|几)(?:件事|个待办|条待办))).*\S/;
const cancelReminder=/^(?:(?:帮我|请)?取消.+?(?:提醒|待办)|(?:不用|不需要|别|不要)(?:再)?提醒(?:我)?(?!了[。！!\s]*$)[^，,。；;]{1,40}(?:了)?)[。！!\s]*$/;
const capturePreamble=/^(?:请|帮我|给我|先)?(?:记(?:一下|下来|下|着|住|上|一笔|(?:两|二|2|三|几)(?:件事|个待办|条待办))?|提醒(?:我|一下)|(?:记|加|添加|新增|留)(?:一条|一个|个|两|二|2|几)?(?:件事|待办|任务))[：:，,\s]*$/;
const timeFollowup=/^(?:不是(?:今天|明天|后天|(?:下|本|这)?(?:周|星期|礼拜)[一二三四五六日天])[，,]\s*是|(?:就|定在|定到|改到)?\s*(?:今天|今晚|明天|明早|明晚|后天|大后天|(?:下|本|这)?(?:周|星期|礼拜)[一二三四五六日天]|(?:这|本|下)个?月(?:底|初|中|\d{1,2}[日号])|\d{1,2}月底)(?:上午|中午|下午|晚上|傍晚|早上|凌晨)?[一二三四五六七八九十两\d]+(?:点|[:：]))/;
const bareClock=/^(?:(?:上午|中午|下午|晚上|傍晚|早上|凌晨)\s*)?(?:\d{1,2}|[一二两三四五六七八九十]+)(?:[:：]\d{2}|点(?:[一三13]刻|半|整|(?:零?[\d一二两三四五六七八九十]+)分?)?)(?:提醒(?:我)?|吧)?[。！!\s]*$/;
const mutation=/^(?:标题(?:改成|改为|换成)|取消(?:.+(?:提醒|待办)|\s*$)|(?:把|将).{0,24}(?:改到|挪到|改成|调到|推到|推迟到|提前到|延后到|撤掉|取消))|(?:那|这)(?:条|项|个|件).{0,18}(?:改到|改成|改为|推到|挪到|提前到|推迟到|撤掉|取消|划了|勾掉|标完成|标完|收了|关一下|关掉|已经处理好了)/;
const completion=/(?:电费|水费|燃气费|物业费|停车费|话费|网费|房租|学费|会员费|合同|报告|邮件|材料|待办|那条|那个).{0,16}(?:已完成|已经.*(?:交了|付了|发了|做完了|处理好了)|完成了|办好了|搞定了)|^完成了[。！!\s]*$/;
const verbCompletion=/^(?:刚才|刚刚)?(?:我)?(?:已经|已)(?:完成|做完|搞定|办好|办完)(?:了)?(?!\s*\d)\S(?:(?!(?:打卡|\d)).){1,29}[。！!\s]*$/;
const subjectCompletion=/^(?!.*(?:如果|假如|假设|要是|可能|也许|预计|听说|好像|似乎|应该|还没|尚未|未|不[太好够会要]|没有|别|同事|客户|对方|别人|他们|她们|他|她|工资|奖金|红包|外快|退款|报销|到账|入账|起床|睡着|吃饭|回家|出门|到家|打卡|\d+(?:\.\d+)?\s*(?:元|块|公里|km|米|ml|毫升|L|升|kg|斤|步|杯)))[^\d，,。；;！？!?\n]{1,24}(?:已经|已)(?:预约好|订好|洗好|签好|办好|办完|搞定|弄好|弄完|处理好|处理完|付清|缴清|结清|完成|做完)(?:了)?[。！!\s]*$/i;
const futureAction=/(?:明天|明早|明晚|后天|(?:[这本下]个?)?(?:周|星期|礼拜)[一二三四五六日天末]|(?:[这本下]个?)?(?:月底|月初|月中)|今晚|今天).{0,18}(?:去|要|得|准备|打算|计划|可能|想|把).{0,12}(?:买|交|发|办|拿|取|寄|约|去|整理|联系|检查|跑步|运动|骑车|游泳|看|修|做|换|洗|关|打|订|领|续|还|体检|复查|复诊|喂|接|送|陪|签)/;
const health=/(?:体重|称重|上称|\d\s*(?:kg|公斤|千克|斤)|熬夜|失眠|好累|太累|累死|没睡好|没睡醒|疲惫|好困|犯困|加班|内耗|心累|头疼|头痛|不舒服|生病|感冒|发烧|烦躁|焦虑|跑步|夜跑|晨跑|健身|举铁|撸铁|运动|锻炼|散步|走路|遛弯|骑行|骑车|游泳|打球|羽毛球|篮球|网球|乒乓球|踢球|瑜伽|普拉提|帕梅拉|跳绳|八段锦|爬山|徒步|冥想|早睡|早起|睡了|睡饱|睡足|精神不错|元气满满)/i;
const profile=/不吃|不喝|不能吃|不能喝|不碰|忌口|戒了?|有高血压|血压高|喜欢|讨厌|爱喝|爱吃|爱听|最爱|过敏|生日|只喝|习惯|放在|在(?:家里|公司|办公室|抽屉|包里|门口)|密码是|车位在/;
const finance=/(?:挣钱|挣了|赚了|花了?|付了?|实际支付|实付|买了|存了?|攒了?|消费|支出|花费|刷了|扣了|收入|入账|进账|充值|结账|到账|工资|外快|兼职|退税|退款|退回(?:来)?|退了|押金|定金|报销|红包|奖金|小金库|存入|存进|转给|转账|卖了|卖出|闲鱼|转转|二手|AA|出了|海底捞|火锅|聚餐|吃饭|超市|扫货|网购|早饭|早餐|午饭|午餐|晚饭|晚餐|夜宵|打车|地铁|公交|咖啡|奶茶|水果|买菜|外卖|快递|话费|电费|电影|理发|洗剪吹|剪发|买药|配钥匙|修车|修锁|修鞋|修电脑|洗车|洗鞋|干洗|洗衣|换锁|停车|充卡).{0,35}(?:\d(?!\d|\s*(?:点|号|月|年|日|分(?:钟)?(?!钱)))|[零一二三四五六七八九十百千万两]+[块元])|[¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:元|块钱?|大洋|rmb)(?![A-Za-z])/i;
const correctionTail=/^(?:(?:财务|平台|公司|商家|对方|我|银行)\s*)?(?:还没|尚未|没|没有|未|不一定|只是|不是|其实没|最后没|先不).{0,20}(?:到账|入账|打款|发了|发放|打给|收到|付|买|花|存|挣|收入|结算|发生)|^(?:还没|尚未|没|没有|未|不一定|只是|不是|其实没|最后没).{0,18}(?:喝|称|跑|做|开始)|^(?:啊|哦|额)?不对.*(?:没|不|别|算了)|^(?:啊|哦|额)?(?:最后|结果|后来|实际)(?:还是)?没|^(?:别|不用|不要)记(?:账|了|成|入账)|^(?:还是)?算了[。！!\s]*$/;
const qualifier=/^(?:几点|哪天|哪一天|时间|日期|具体几点|不用设|不设|都不设|暂时不设|先不设).{0,24}(?:再说|以后|没定|没想好|不定|再定|再决定|待定|未定|不确定|没确定|先不定|提醒|闹钟|时间|日期)|^(?:(?:都)?先记着|(?:都|先|暂时)?(?:不设|不用设)(?:时间|提醒|闹钟)|(?:现在|今天|这会儿)?没空(?:弄|处理|做)?)[。！!\s]*$/;
export const isUnboundLifeCancellation=(text:string)=>/^(?:(?:帮我|请|先|就|干脆)\s*)?(?:取消|撤掉|关掉|删掉)(?:这|那)?(?:一)?(?:个|条|项)?(?:提醒|待办)?(?:吧|了)?[。！!\s]*$/.test(text.trim());

export function classifyLifeFragment(text:string):LifeRoute {
  const value=text.trim();
  if(!value||question.test(value)||/[“”「」『』"]/.test(value))return 'original';
  if(isUnboundLifeCancellation(value))return 'original';
  if(timeFollowup.test(value)&&!/(?:花了|付了|已到账)/.test(value))return 'action';
  if(futureAction.test(value)&&!finance.test(value)&&!/了|做完|如果|假设|要是|不去|没去|只是在想/.test(value))return 'action';
  if(uncertain.test(value)||otherOwner.test(value)||/^(?:还没|没|没有|未|别|不要|先别|先缓|先放|不准备|不打算)/.test(value))return 'original';
  if(cancelReminder.test(value)&&!/^(?:先别|暂不|不是).{0,4}(?:取消|撤|删|关)|记账|入账/.test(value))return 'action';
  if(definiteAction.test(value)&&!/提醒时间到了|(?:不|别|无需)提醒|记账|记笔开销/.test(value)){
    if(!finance.test(value)||/提醒我|待办/.test(value))return 'action';
  }
  if(finance.test(value)||/^(?:(?:顺便|另外|还有|又|再)\s*)?(?:买|吃|喝|点|交|充|配|修|洗|剪).{1,15}\d+(?:\.\d+)?$/.test(value))return /明天|后天|将要|打算|准备|预计|预算|报价/.test(value)?'original':'fact';
  if(mutation.test(value)||completion.test(value)||((verbCompletion.test(value)||subjectCompletion.test(value))&&!health.test(value)&&!profile.test(value)))return 'action';
  if(/^(?:准备|打算|计划|想去|想要|要去|明天|后天).{0,25}(?:跑步|运动|游泳|骑车|健身|散步)/.test(value))return 'original';
  if(health.test(value)||profile.test(value)||/建.*(?:卡|看板)|打卡|\+\s*\d|完成了?\s*\d/.test(value))return 'fact';
  return 'original';
}

/** Return original slices; punctuation in a quote or a grouped amount is not a boundary. */
export function routeLifeInput(raw:string):LifeFragment[] {
  if(timeFollowup.test(raw.trim())&&classifyLifeFragment(raw)==='action'&&/^不是/.test(raw.trim()))
    return [{text:raw,start:0,end:raw.length,route:'action'}];
  const slices:{start:number;end:number}[]=[];
  const closing:Record<string,string>={'“':'”','「':'」','『':'』','"':'"'};
  let endQuote='', start=0;
  for(let i=0;i<raw.length;i++){
    const c=raw[i];
    if(endQuote){if(c===endQuote)endQuote='';continue;}
    if(closing[c]){endQuote=closing[c];continue;}
    if(!/[，,。；;！？!?\n]/.test(c))continue;
    if((c===','||c==='，')&&/\d/.test(raw[i-1]||'')&&/^\d{3}(?!\d)/.test(raw.slice(i+1)))continue;
    const end=/[？?]/.test(c)?i+1:i;
    if(raw.slice(start,end).trim())slices.push({start,end});
    start=i+1;
  }
  if(raw.slice(start).trim())slices.push({start,end:raw.length});
  const mergedSlices:{start:number;end:number}[]=[];
  for(let i=0;i<slices.length;i++){
    const cur=slices[i];
    const next=slices[i+1];
    const sep=next?raw.slice(cur.end,next.start):'';
    if(next&&!/[。；;！？!?\n]/.test(sep)&&capturePreamble.test(raw.slice(cur.start,cur.end).trim())){
      slices[i+1]={start:cur.start,end:next.end};
      continue;
    }
    mergedSlices.push(cur);
  }
  const result:LifeFragment[]=[];
  for(const slice of mergedSlices){
    const text=raw.slice(slice.start,slice.end);
    const previous=result.at(-1);
    const hardStop=previous&&/[。；;！？!?\n]/.test(raw.slice(previous.end,slice.start));
    if(previous?.route==='action'&&!hardStop&&/^(?:我)?(?:不记得|不知道|不确定|没说清楚)(?:是|要)?哪(?:一)?(?:条|项|个|件)/.test(text.trim())){
      previous.end=slice.end;previous.text=raw.slice(previous.start,previous.end);previous.route='original';continue;
    }
    if(previous?.route==='fact'&&!hardStop&&/^(?:钱)?(?:我)?(?:已经|已)?(?:已?收(?:到了?)?|已?到卡(?:上)?(?:了)?|已?到账(?:了)?)[。！!\s]*$/.test(text.trim())&&/卖了|卖出|闲鱼|转转|二手|出了|奖金|年终奖|退回|退了|押金|退款|报销/.test(previous.text)){
      previous.end=slice.end;previous.text=raw.slice(previous.start,previous.end);continue;
    }
    if(previous?.route==='fact'&&!hardStop&&/^(?:目标)\s*\d+/.test(text.trim())&&/(?:建|创建).*(?:卡|看板)/.test(previous.text)){
      previous.end=slice.end;previous.text=raw.slice(previous.start,previous.end);continue;
    }
    if(previous?.route==='fact'&&!hardStop&&/(?:开启|开始|启动|新建|创建|加一?个|建一?个|完成|连续|坚持).{0,10}天.{1,20}打卡/.test(previous.text)&&/^(?:每天|每日|每晚|最晚).{0,12}(?:\d{1,2}|[零一二两三四五六七八九十]+).{0,6}提醒(?:我|一下)?[。！!\s]*$/.test(text.trim())){
      previous.end=slice.end;previous.text=raw.slice(previous.start,previous.end);continue;
    }
    if(previous&&!hardStop&&(correctionTail.test(text.trim())&&previous.route==='fact'||(qualifier.test(text.trim())||bareClock.test(text.trim()))&&previous.route==='action')){
      previous.end=slice.end;previous.text=raw.slice(previous.start,previous.end);
      if(correctionTail.test(text.trim()))previous.route='original';
    }else{
      const route=classifyLifeFragment(text);
      const continuation=previous?.route==='action'&&!hardStop&&route==='original'
        && /^(?:(?:还有|另外|以及|顺便|同时|并且|然后再|然后|再(?!说|定|补))\s*)*(?:买|交|发|给|找|去|把|对|校对|核对|复核|确认|汇总|打印|复印|预约|联系|检查|整理|领取|拿|取|修|办理|归档|跟进|打|订|洗|换|续|还|寄|查|带|收|关|煮|充|泡|清|喂|接|送|陪|签)\S{1,30}$/.test(text.trim())
        && !uncertain.test(text)&&!question.test(text);
      result.push({...slice,text,route:continuation?'action':route});
    }
  }
  return result;
}

export const lifeActionText=(raw:string)=>routeLifeInput(raw).filter(x=>x.route==='action').map(x=>x.text.trim()).join('，');
export const isExplicitLifeTask=(text:string)=>definiteAction.test(text)&&classifyLifeFragment(text)==='action';
