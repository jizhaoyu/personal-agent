/** Date-only business deadlines use Asia/Shanghai and default to 09:00. */
export function shanghaiDateKey(value: number = Date.now()): string {
  return new Date(value + 8 * 3600000).toISOString().slice(0, 10);
}

function chineseNumeral(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = '零一二三四五六七八九';
  const d = (s: string) => digits.indexOf(s.replace('两', '二'));
  const clean = text.replace(/^零+(?=[一二两三四五六七八九])/, '');
  if (clean.includes('十')) {
    const [a, b] = clean.split('十');
    const tens = a ? d(a) : 1;
    const ones = b ? d(b) : 0;
    return tens >= 0 && ones >= 0 ? tens * 10 + ones : -1;
  }
  return d(clean);
}

function normalizeTimeText(raw: string): string {
  return raw
    .replace(/点[一1]刻/g, '点15分')
    .replace(/点[三3]刻/g, '点45分')
    .replace(/(点)([零一二两三四五六七八九十]+)(分?)/g, (m, p, n) => {
      const v = chineseNumeral(n);
      return v >= 0 && v <= 59 ? `${p}${v}分` : m;
    })
    .replace(/(上午|下午|晚上|傍晚|中午|早上|凌晨|今晚|明早|明晚)\s*([零一二两三四五六七八九十]+)点/g, (m, period, n) => {
      const v = chineseNumeral(n);
      return v >= 0 && v <= 99 ? `${period}${v}点` : m;
    })
    .replace(/(?<![有早晚快慢差好没多几\d])([零一二两三四五六七八九十]+)点(?!(?:儿|头|点|意见|建议|想法|问题|原因|理由|要求|说明|内容|注意|事项|都|也))/g, (m, n) => {
      const v = chineseNumeral(n);
      return v >= 0 && v <= 99 ? `${v}点` : m;
    })
    .replace(/([一二两三四五六七八九十]+)\s*(天(?:后|之后|内))/g, (m, n, tail) => {
      const v = chineseNumeral(n);
      return v >= 1 && v <= 31 ? `${v}${tail}` : m;
    });
}

export function resolveDeadline(text: string, now: number = Date.now()): { dueAt?: string; warning?: string } {
  const clean = normalizeTimeText(text.trim());
  const localNow = new Date(now + 8 * 3600000);
  let year = localNow.getUTCFullYear();
  let month = localNow.getUTCMonth();
  let day = localNow.getUTCDate();
  let found = false;
  let calendarDate = false;
  const explicit = clean.match(/(\d{4})[年\-/](\d{1,2})[月\-/](\d{1,2})[日号]?/);
  const daysLater = clean.match(/(\d{1,2})\s*天(?:后|之后|内)/);
  const explicitMonthEnd = clean.match(/(?:(\d{4})年)?(\d{1,2})月(?:月底|底)/);
  const relMonthDay = clean.match(/((?<![一记写留])下个?|[本这]个?)月(\d{1,2})[日号]?/);
  const weekday = clean.match(/((?<![一记写留])下个?|[本这]个?)?(周|星期|礼拜)([一二三四五六日天])/);
  if (explicit) {
    year = +explicit[1]; month = +explicit[2] - 1; day = +explicit[3]; found = true; calendarDate = true;
  } else if (daysLater) {
    day += +daysLater[1]; found = true;
  } else if (/大后天/.test(clean)) { day += 3; found = true; }
  else if (/后天/.test(clean)) { day += 2; found = true; }
  else if (/明天|明早|明晚/.test(clean)) { day += 1; found = true; }
  else if (/今天|今晚|今日/.test(clean)) { found = true; }
  else if (explicitMonthEnd) {
    if (explicitMonthEnd[1]) year = +explicitMonthEnd[1];
    month = +explicitMonthEnd[2] - 1;
    calendarDate = true;
    day = month >= 0 && month <= 11 ? new Date(Date.UTC(year, month + 1, 0)).getUTCDate() : 0;
    found = true;
  } else if (/(?<![一记写留])下(?:个)?月(?:月底|底)/.test(clean)) {
    month += 1; day = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); found = true;
  } else if (/(?:这|本)(?:个)?月(?:月底|底)/.test(clean)) {
    day = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); found = true;
  } else if (/(?<![一记写留])下(?:个)?月(?:月初|初)/.test(clean)) {
    month += 1; day = 1; found = true;
  } else if (/(?:这|本)(?:个)?月(?:月初|初)/.test(clean)) {
    day = 1; found = true;
  } else if (/(?<![一记写留])下(?:个)?月(?:月中|中)/.test(clean)) {
    month += 1; day = 15; found = true;
  } else if (/(?:这|本)(?:个)?月(?:月中|中)/.test(clean)) {
    day = 15; found = true;
  } else if (relMonthDay) {
    if (relMonthDay[1].startsWith('下')) {
      month += 1;
      if (month > 11) { year += Math.floor(month / 12); month %= 12; }
    }
    day = +relMonthDay[2]; found = true; calendarDate = true;
  } else if (weekday) {
    const target = '一二三四五六日'.indexOf(weekday[3] === '天' ? '日' : weekday[3]);
    const current = (localNow.getUTCDay() + 6) % 7;
    let delta = target - current;
    if (weekday[1]?.startsWith('下')) delta += 7;
    else if (!weekday[1] && delta < 0) delta += 7;
    day += delta; found = true;
  } else if (/月底/.test(clean)) {
    day = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); found = true;
  } else if (/月初/.test(clean)) {
    day = 1; found = true;
  } else if (/月中/.test(clean)) {
    day = 15; found = true;
  } else {
    const monthDay = clean.match(/(\d{1,2})月(\d{1,2})[日号]?/);
    if (monthDay) { month = +monthDay[1] - 1; day = +monthDay[2]; found = true; calendarDate = true; }
    else if (/\d{1,2}号/.test(clean)) return { warning: '日期缺少月份，请确认具体年月日。' };
  }
  if (!found) return { warning: '未识别明确日期，请保留原文并核对。' };
  let hour = 9;
  let minute = 0;
  const clock = clean.match(/(上午|下午|晚上|傍晚|中午|早上|凌晨|今晚|明早|明晚)?\s*(\d{1,2})(?:[:：](\d{2})|点(?:(半)|(\d{1,2})分?)?)/);
  if (clock) {
    hour = +clock[2];
    minute = clock[4] === '半' ? 30 : +(clock[3] || clock[5] || 0);
    const period = clock[1] || clean;
    if (/下午|晚上|傍晚|今晚|明晚/.test(period) && hour < 12) hour += 12;
    if (/上午|明早|早上|凌晨/.test(period) && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59 || (calendarDate && (month < 0 || month > 11 || day < 1 || day > new Date(Date.UTC(year, month + 1, 0)).getUTCDate()))) {
    return { warning: '日期或时刻无效，请核对。' };
  }
  const date = new Date(Date.UTC(year, month, day, hour - 8, minute));
  return { dueAt: date.toISOString() };
}
