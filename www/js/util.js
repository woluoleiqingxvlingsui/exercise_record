/**
 * util.js —— 纯函数工具。刻意不碰 DOM、不碰存储，便于 `node --test` 直接跑。
 */

export function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 本地日期键 `YYYY-MM-DD`。
 *
 * 刻意不用 `toISOString()`：它按 UTC 截断，东八区凌晨 0–8 点会算成前一天。
 * 番茄钟项目在这里踩过坑（跨零点按本地零点拆分的教训），本模块统一走 Date 的本地取值。
 */
export function localDateKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `YYYY-MM-DD` -> `YYYY-MM` */
export function monthKeyOf(dateKey) {
  return String(dateKey).slice(0, 7);
}

/** `YYYY-MM` -> `YYYY-MM-01`（用于取该月第一天，做月中导航） */
export function firstDayOfMonth(monthKey) {
  return `${monthKey}-01`;
}

export function parseDateKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return { y, m, d };
}

/**
 * 按本地日历加减天数。
 * 锚定到当天 12:00 再运算，绕开夏令时切换与跨月边界带来的 ±1 小时误差。
 */
export function addDays(dateKey, n) {
  const { y, m, d } = parseDateKey(dateKey);
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  dt.setDate(dt.getDate() + n);
  return localDateKey(dt.getTime());
}

export function addMonths(monthKey, n) {
  const { y, m } = parseDateKey(`${monthKey}-01`);
  const dt = new Date(y, m - 1 + n, 1, 12, 0, 0, 0);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
}

/** 该月天数（本地） */
export function daysInMonth(monthKey) {
  const { y, m } = parseDateKey(`${monthKey}-01`);
  return new Date(y, m, 0).getDate();
}

/** 该月 1 号是周几（0=周日），用于日历网格留白 */
export function firstWeekdayOfMonth(monthKey) {
  const { y, m } = parseDateKey(`${monthKey}-01`);
  return new Date(y, m - 1, 1, 12, 0, 0, 0).getDay();
}

/** 短时钟：1:30 / 1:02:33（倒计时与计时器用） */
export function fmtClock(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

/** 人话时长：45 秒 / 1 分 30 秒 / 2 分钟（"原计划间歇"参考条用） */
export function fmtRest(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return sec === 0 ? `${m} 分钟` : `${m} 分 ${sec} 秒`;
}

/** 带符号差值：+30 秒 / -15 秒 / 持平 */
export function fmtDelta(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s === 0) return '持平';
  const sign = s > 0 ? '+' : '-';
  const abs = Math.abs(s);
  return abs < 60 ? `${sign}${abs} 秒` : `${sign}${fmtRest(abs * 1000)}`;
}

/** 长时长：2 小时 5 分 */
export function fmtLong(ms) {
  const totalMin = Math.round((ms || 0) / 60000);
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 深拷贝（计划快照要完全脱离原对象，避免后续改模板污染历史） */
export function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** 从任意输入里取第一个有效非负数字 */
export function firstNum(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return 0;
}

/* ==========================================================================
   周期（统计页按 周 / 月 / 年 看时长用）
   ========================================================================== */

/** 该日期所在周的**周一**（本地）。周一为一周之始。 */
export function startOfWeekKey(dateKey) {
  const { y, m, d } = parseDateKey(dateKey);
  const wd = new Date(y, m - 1, d, 12, 0, 0, 0).getDay(); // 0=周日
  const back = wd === 0 ? 6 : wd - 1;
  return addDays(dateKey, -back);
}

export const GRANULARITIES = ['week', 'month', 'year'];

/** 某个粒度下，锚点日期所属区间的首尾（都含） */
export function periodRange(gran, anchorKey) {
  if (gran === 'week') {
    const start = startOfWeekKey(anchorKey);
    return { start, end: addDays(start, 6) };
  }
  if (gran === 'month') {
    const mk = monthKeyOf(anchorKey);
    return { start: `${mk}-01`, end: `${mk}-${pad2(daysInMonth(mk))}` };
  }
  const y = String(anchorKey).slice(0, 4);
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

/** 前后翻一个周期，返回新的锚点日期 */
export function shiftPeriod(gran, anchorKey, delta) {
  if (gran === 'week') return addDays(anchorKey, delta * 7);
  if (gran === 'month') return `${addMonths(monthKeyOf(anchorKey), delta)}-01`;
  const y = Number(String(anchorKey).slice(0, 4)) + delta;
  return `${y}-01-01`;
}

/** 周期的可读标题 */
export function periodLabel(gran, anchorKey) {
  const { start, end } = periodRange(gran, anchorKey);
  if (gran === 'week') {
    const a = parseDateKey(start);
    const b = parseDateKey(end);
    return `${a.m} 月 ${a.d} 日 – ${b.m} 月 ${b.d} 日`;
  }
  if (gran === 'month') {
    const a = parseDateKey(start);
    return `${a.y} 年 ${a.m} 月`;
  }
  return `${String(anchorKey).slice(0, 4)} 年`;
}

/**
 * 周期内画柱状图用的桶：
 *   周 → 7 天（周一到周日）
 *   月 → 每一天
 *   年 → 12 个月（isMonth=true，聚合时按月份归并）
 */
export function periodBuckets(gran, anchorKey) {
  const { start } = periodRange(gran, anchorKey);
  if (gran === 'week') {
    return Array.from({ length: 7 }, (_, i) => ({
      key: addDays(start, i), label: '一二三四五六日'[i],
    }));
  }
  if (gran === 'month') {
    const mk = monthKeyOf(start);
    return Array.from({ length: daysInMonth(mk) }, (_, i) => ({
      key: `${mk}-${pad2(i + 1)}`, label: String(i + 1),
    }));
  }
  const y = String(anchorKey).slice(0, 4);
  return Array.from({ length: 12 }, (_, i) => ({
    key: `${y}-${pad2(i + 1)}`, label: String(i + 1), isMonth: true,
  }));
}

/**
 * 数字输入容错：空/非法 -> null；合法 -> number
 *
 * 刻意先 trim：Number(' ') 是 0（不是 NaN），不 trim 的话
 * 用户在输入框里只敲了一个空格，会被当成"填了 0"，
 * 于是该组被记成"做了 0 次"并判成偏离计划。
 */
export function toNumOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * HTML 转义。
 * 凡是拼进 innerHTML 的动态数据（计划名、备注、导入的备份内容）都必须过这一层，
 * 否则一个含引号或尖括号的名字就能把页面结构顶坏。
 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
