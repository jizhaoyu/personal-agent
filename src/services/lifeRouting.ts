export type LifeRoute = 'fact'|'action'|'original';
export interface LifeFragment { text:string; start:number; end:number; route:LifeRoute }

const question=/[？?]|(?:吗|么|是不是|是否|能不能|有没有|不知道|不清楚|不确定|拿不准|待确认)/;
const uncertain=/如果|假如|假设|要是|举个例|举例|比如|只是例子|只是计划|差点|可能|也许|预计|听说|我猜|还没|尚未|(?:并?没|未)(?:挣|赚|花|买|付|交|存|攒|喝|跑|去|到|称|收|入账|做|发)|没有(?:挣|赚|花|买|付|交|存|攒|喝|跑|去|到|称|收|做|发)|(?:不是|并非).{0,12}(?:收入|支出|到账|发生|已完成)|别.{0,14}(?:记账|记到|记成|入账)|不(?:准备|打算)现在记账/;
const otherOwner=/(?:别人|他人|我(?:妈|爸|姐|哥|弟|妹|朋友|同事)|同事|室友|他们|她们|对方)(?:的)?(?:刚|今天|昨天|已经|也)?(?:挣|赚|花|存|攒|中了|收到了?|付了|买了)/;
const definiteAction=/(?:提醒我|提醒一下|请提醒|(?:记|加|新增|添加|留)(?:一条|一个|个)?待办|(?:给我|帮我|请|先)记(?:一条|一下|下|着|住)).*\S/;
const timeFollowup=/^(?:不是(?:今天|明天|后天|(?:下|本|这)?周[一二三四五六日天])[，,]\s*是|(?:就|定在|定到|改到)?\s*(?:今天|今晚|明天|明早|明晚|后天|(?:下|本|这)?周[一二三四五六日天])(?:上午|中午|下午|晚上|早上)?[一二三四五六七八九十两\d]+(?:点|[:：]))/;
const mutation=/^(?:标题(?:改成|改为|换成)|取消(?:.+(?:提醒|待办)|\s*$)|(?:把|将).{0,24}(?:改到|挪到|改成|调到|推到|撤掉|取消))|(?:那|这)(?:条|项|个|件).{0,18}(?:改到|改成|推到|挪到|提前到|推迟到|撤掉|取消|划了|勾掉|标完成|标完|收了|关一下|关掉|已经处理好了)/;
const completion=/(?:电费|水费|燃气费|物业费|停车费|话费|网费|房租|学费|会员费|合同|报告|邮件|材料|待办|那条|那个).{0,16}(?:已完成|已经.*(?:交了|付了|发了|做完了|处理好了)|完成了|办好了|搞定了)|^完成了[。！!\s]*$/;
const futureAction=/(?:明天|明早|明晚|后天|周[一二三四五六日天末]|今晚|今天).{0,18}(?:去|要|得|准备|打算|计划|可能|想|把).{0,12}(?:买|交|发|办|拿|取|寄|约|去|整理|联系|检查|跑步|运动|骑车|游泳|看|修|做|换|洗|关)/;
const health=/(?:体重|称重|上称|\d\s*(?:kg|公斤|千克|斤)|熬夜|失眠|好累|太累|累死|没睡好|没睡醒|疲惫|好困|犯困|加班|内耗|心累|头疼|头痛|不舒服|生病|感冒|发烧|烦躁|焦虑|跑步|夜跑|晨跑|健身|举铁|撸铁|运动|锻炼|散步|走路|遛弯|骑行|骑车|游泳|打球|羽毛球|篮球|网球|乒乓球|踢球|瑜伽|普拉提|帕梅拉|跳绳|八段锦|爬山|徒步|冥想|早睡|早起|睡了|睡饱|睡足|精神不错|元气满满)/i;
const profile=/不吃|不喝|不能吃|喜欢|讨厌|爱喝|爱吃|爱听|最爱|过敏|生日|只喝|习惯|放在|在(?:家里|公司|办公室|抽屉|包里|门口)|密码是|车位在/;
const finance=/(?:挣钱|挣了|赚了|花了?|付了?|实际支付|实付|买了|存了?|攒了?|消费|支出|花费|刷了|扣了|收入|入账|进账|充值|结账|到账|工资|外快|兼职|退税|退款|报销|红包|奖金|小金库|存入|存进|转给|转账|早饭|早餐|午饭|午餐|晚饭|晚餐|夜宵|打车|地铁|公交|咖啡|奶茶|水果|买菜|外卖|快递|话费|电费|电影|理发|买药).{0,35}(?:\d|[零一二三四五六七八九十百千万两]+[块元])|[¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:元|块钱?|rmb)(?![A-Za-z])/i;
const correctionTail=/^(?:(?:财务|平台|公司|商家|对方|我|银行)\s*)?(?:还没|尚未|没|没有|未|不一定|只是|不是|其实没|最后没|先不).{0,20}(?:到账|入账|打款|发了|发放|打给|收到|付|买|花|存|挣|收入|结算|发生)|^(?:还没|尚未|没|没有|未|不一定|只是|不是|其实没|最后没).{0,18}(?:喝|称|跑|做|开始)/;
const qualifier=/^(?:几点|哪天|哪一天|时间|日期|具体几点|不用设|不设|都不设|暂时不设|先不设).{0,24}(?:再说|以后|没定|没想好|不定|提醒|闹钟|时间|日期)|^(?:(?:都)?先记着|(?:都|先|暂时)?(?:不设|不用设)(?:时间|提醒|闹钟)|(?:现在|今天|这会儿)?没空(?:弄|处理|做)?)[。！!\s]*$/;
export const isUnboundLifeCancellation=(text:string)=>/^(?:(?:帮我|请|先|就|干脆)\s*)?(?:取消|撤掉|关掉|删掉)(?:这|那)?(?:一)?(?:个|条|项)?(?:提醒|待办)?(?:吧|了)?[。！!\s]*$/.test(text.trim());

export function classifyLifeFragment(text:string):LifeRoute {
  const value=text.trim();
  if(!value||question.test(value)||/[“”「」『』"]/.test(value))return 'original';
  if(isUnboundLifeCancellation(value))return 'original';
  if(timeFollowup.test(value)&&!/(?:花了|付了|已到账)/.test(value))return 'action';
  if(futureAction.test(value)&&!finance.test(value)&&!/了|做完|如果|假设|要是|不去|没去|只是在想/.test(value))return 'action';
  if(uncertain.test(value)||otherOwner.test(value)||/^(?:还没|没|没有|未|别|不要|先别|先缓|先放|不准备|不打算)/.test(value))return 'original';
  if(definiteAction.test(value)&&!/提醒时间到了|(?:不|别|无需)提醒|记账|记笔开销/.test(value)){
    if(!finance.test(value)||/提醒我|待办/.test(value))return 'action';
  }
  if(finance.test(value)||/^(?:买|吃|喝|点|交|充).{1,15}\d+(?:\.\d+)?$/.test(value))return /明天|后天|将要|打算|准备|预计|预算|报价/.test(value)?'original':'fact';
  if(mutation.test(value)||completion.test(value))return 'action';
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
  const result:LifeFragment[]=[];
  for(const slice of slices){
    const text=raw.slice(slice.start,slice.end);
    const previous=result.at(-1);
    const hardStop=previous&&/[。；;！？!?\n]/.test(raw.slice(previous.end,slice.start));
    if(previous?.route==='action'&&!hardStop&&/^(?:我)?(?:不记得|不知道|不确定|没说清楚)(?:是|要)?哪(?:一)?(?:条|项|个|件)/.test(text.trim())){
      previous.end=slice.end;previous.text=raw.slice(previous.start,previous.end);previous.route='original';continue;
    }
    if(previous?.route==='fact'&&!hardStop&&/^(?:钱)?(?:我)?(?:已经)?(?:已收|收到了|到卡上了|到账了|已经到账)[。！!\s]*$/.test(text.trim())&&/卖了|卖出|奖金|年终奖/.test(previous.text)){
      previous.end=slice.end;previous.text=raw.slice(previous.start,previous.end);continue;
    }
    if(previous?.route==='fact'&&!hardStop&&/^(?:目标)\s*\d+/.test(text.trim())&&/(?:建|创建).*(?:卡|看板)/.test(previous.text)){
      previous.end=slice.end;previous.text=raw.slice(previous.start,previous.end);continue;
    }
    if(previous&&!hardStop&&(correctionTail.test(text.trim())&&previous.route==='fact'||qualifier.test(text.trim())&&previous.route==='action')){
      previous.end=slice.end;previous.text=raw.slice(previous.start,previous.end);
      if(correctionTail.test(text.trim()))previous.route='original';
    }else{
      const route=classifyLifeFragment(text);
      const continuation=previous?.route==='action'&&!hardStop&&route==='original'
        && /^(?:还有|另外|以及|顺便|同时|并且|再(?!说|定|补))?(?:买|交|发|给|找|去|把|对|校对|核对|复核|确认|汇总|打印|复印|预约|联系|检查|整理|领取|拿|取|修|办理|归档|跟进)\S{1,30}$/.test(text.trim())
        && !uncertain.test(text)&&!question.test(text);
      result.push({...slice,text,route:continuation?'action':route});
    }
  }
  return result;
}

export const lifeActionText=(raw:string)=>routeLifeInput(raw).filter(x=>x.route==='action').map(x=>x.text.trim()).join('，');
export const isExplicitLifeTask=(text:string)=>definiteAction.test(text)&&classifyLifeFragment(text)==='action';
