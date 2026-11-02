/** Date-only business deadlines use Asia/Shanghai and default to 09:00. */
export function shanghaiDateKey(value: number = Date.now()): string {
  return new Date(value + 8 * 3600000).toISOString().slice(0, 10);
}

export function resolveDeadline(text: string, now: number = Date.now()): { dueAt?: string; warning?: string } {
  const clean = text.trim();
  const localNow = new Date(now + 8 * 3600000);
  let year = localNow.getUTCFullYear();
  let month = localNow.getUTCMonth();
  let day = localNow.getUTCDate();
  let found = false;
  let calendarDate = false;
  const explicit = clean.match(/(\d{4})[年\-/](\d{1,2})[月\-/](\d{1,2})[日号]?/);
  const daysLater = clean.match(/(\d{1,2})\s*天(?:后|之后|内)/);
  if (explicit) {
    year = +explicit[1]; month = +explicit[2] - 1; day = +explicit[3]; found = true; calendarDate = true;
  } else if (daysLater) {
    day += +daysLater[1]; found = true;
  } else if (/大后天/.test(clean)) { day += 3; found = true; }
  else if (/后天/.test(clean)) { day += 2; found = true; }
  else if (/明天|明早|明晚/.test(clean)) { day += 1; found = true; }
  else if (/今天|今晚|今日/.test(clean)) { found = true; }
  else if (/下个?月底/.test(clean)) { month += 1; day = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); found = true; }
  else if (/月底/.test(clean)) { day = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); found = true; }
  else if (/下个?月初/.test(clean)) { month += 1; day = 1; found = true; }
  else if (/月初/.test(clean)) { day = 1; found = true; }
  else if (/月中/.test(clean)) { day = 15; found = true; }
  else {
    const weekday = clean.match(/(下周|本周|这周|周|下星期|本星期|这星期|星期|下礼拜|本礼拜|这礼拜|礼拜)([一二三四五六日天])/);
    if (weekday) {
      const target = '一二三四五六日'.indexOf(weekday[2] === '天' ? '日' : weekday[2]);
      const current = (localNow.getUTCDay() + 6) % 7;
      let delta = target - current;
      if (weekday[1].startsWith('下')) delta += 7;
      else if (['周', '星期', '礼拜'].includes(weekday[1]) && delta < 0) delta += 7;
      day += delta; found = true;
    } else {
      const monthDay = clean.match(/(\d{1,2})月(\d{1,2})[日号]?/);
      if (monthDay) { month = +monthDay[1] - 1; day = +monthDay[2]; found = true; calendarDate = true; }
      else if (/\d{1,2}号/.test(clean)) return { warning: '日期缺少月份，请确认具体年月日。' };
    }
  }
  if (!found) return { warning: '未识别明确日期，请保留原文并核对。' };
  let hour = 9;
  let minute = 0;
  const clock = clean.match(/(\d{1,2})(?:[:：](\d{2})|点(?:(半)|(\d{1,2})分?)?)/);
  if (clock) {
    hour = +clock[1];
    minute = clock[3] === '半' ? 30 : +(clock[2] || clock[4] || 0);
    if (/下午|晚上|今晚|明晚/.test(clean) && hour < 12) hour += 12;
    if (/上午|明早/.test(clean) && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59 || (calendarDate && (month < 0 || month > 11 || day < 1 || day > new Date(Date.UTC(year, month + 1, 0)).getUTCDate()))) {
    return { warning: '日期或时刻无效，请核对。' };
  }
  const date = new Date(Date.UTC(year, month, day, hour - 8, minute));
  return { dueAt: date.toISOString() };
}
