import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  localDateKey, monthKeyOf, addDays, addMonths, daysInMonth, firstWeekdayOfMonth,
  fmtClock, fmtRest, fmtDelta, fmtLong, firstNum, toNumOrNull, deepClone, clamp,
  startOfWeekKey, periodRange, periodBuckets, periodLabel, shiftPeriod,
} from '../www/js/util.js';

test('localDateKey 取本地日期，不用 toISOString（东八区凌晨会差一天）', () => {
  const d = new Date(2026, 0, 1, 0, 30, 0);
  assert.equal(localDateKey(d.getTime()), '2026-01-01');
  // 东半球（UTC 偏移为负）时，UTC 截断会退回前一天 —— 这正是要避免的 bug
  if (d.getTimezoneOffset() < 0) {
    assert.equal(d.toISOString().slice(0, 10), '2025-12-31');
  }
});

test('localDateKey 个位月日补零', () => {
  assert.equal(localDateKey(new Date(2026, 8, 5, 12).getTime()), '2026-09-05');
});

test('monthKeyOf 取月份键', () => {
  assert.equal(monthKeyOf('2026-09-05'), '2026-09');
});

test('addDays 跨月 / 跨年正确', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2026-06-15', 0), '2026-06-15');
});

test('addMonths 跨年正确', () => {
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-06', 7), '2027-01');
});

test('daysInMonth 闰年正确', () => {
  assert.equal(daysInMonth('2024-02'), 29);
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2026-01'), 31);
  assert.equal(daysInMonth('2026-04'), 30);
});

test('firstWeekdayOfMonth 与已知日期吻合（2000-01-01 是周六）', () => {
  assert.equal(firstWeekdayOfMonth('2000-01'), 6);
  assert.equal(firstWeekdayOfMonth('2026-01'), new Date(2026, 0, 1).getDay());
});

test('fmtClock 秒表格式', () => {
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(90000), '1:30');
  assert.equal(fmtClock(3723000), '1:02:03');
  assert.equal(fmtClock(-5), '0:00');
});

test('fmtRest 人话时长（原计划间歇参考条要用）', () => {
  assert.equal(fmtRest(45000), '45 秒');
  assert.equal(fmtRest(90000), '1 分 30 秒');
  assert.equal(fmtRest(120000), '2 分钟');
  assert.equal(fmtRest(0), '0 秒');
});

test('fmtDelta 显示与计划的差值', () => {
  assert.equal(fmtDelta(0), '持平');
  assert.equal(fmtDelta(30000), '+30 秒');
  assert.equal(fmtDelta(-15000), '-15 秒');
  assert.equal(fmtDelta(120000), '+2 分钟');
});

test('fmtLong', () => {
  assert.equal(fmtLong(45 * 60000), '45 分钟');
  assert.equal(fmtLong(125 * 60000), '2 小时 5 分');
  assert.equal(fmtLong(120 * 60000), '2 小时');
});

test('firstNum 取第一个有效非负数字', () => {
  assert.equal(firstNum(undefined, null, 5000, 9000), 5000);
  assert.equal(firstNum(undefined, null), 0);
  assert.equal(firstNum(-1, 20), 20);
  assert.equal(firstNum(0, 20), 0);
});

test('toNumOrNull 输入容错', () => {
  assert.equal(toNumOrNull(''), null);
  assert.equal(toNumOrNull(null), null);
  assert.equal(toNumOrNull('abc'), null);
  assert.equal(toNumOrNull('12.5'), 12.5);
  assert.equal(toNumOrNull(0), 0);
});

test('deepClone 与原对象完全脱钩', () => {
  const a = { x: { y: [1, 2, 3] } };
  const b = deepClone(a);
  b.x.y.push(4);
  assert.deepEqual(a.x.y, [1, 2, 3]);
});

test('clamp', () => {
  assert.equal(clamp(5, 1, 3), 3);
  assert.equal(clamp(0, 1, 3), 1);
  assert.equal(clamp(2, 1, 3), 2);
});

test('startOfWeekKey：周一为一周之始', () => {
  // 2000-01-01 是周六 → 那一周的周一是 1999-12-27
  assert.equal(startOfWeekKey('2000-01-01'), '1999-12-27');
  assert.equal(startOfWeekKey('1999-12-27'), '1999-12-27', '周一本身返回自己');
  assert.equal(startOfWeekKey('2000-01-02'), '1999-12-27', '周日归到本周（不是下周一）');
});

test('periodRange：三种粒度的区间', () => {
  assert.deepEqual(periodRange('week', '2000-01-01'), { start: '1999-12-27', end: '2000-01-02' });
  assert.deepEqual(periodRange('month', '2026-02-15'), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(periodRange('month', '2024-02-15'), { start: '2024-02-01', end: '2024-02-29' }, '闰年二月 29 天');
  assert.deepEqual(periodRange('year', '2026-06-01'), { start: '2026-01-01', end: '2026-12-31' });
});

test('periodBuckets：周=7 天、月=每一天、年=12 个月', () => {
  assert.equal(periodBuckets('week', '2000-01-01').length, 7);
  assert.equal(periodBuckets('week', '2000-01-01')[0].key, '1999-12-27');
  assert.equal(periodBuckets('month', '2026-02-15').length, 28);
  assert.equal(periodBuckets('month', '2024-02-15').length, 29);

  const y = periodBuckets('year', '2026-06-01');
  assert.equal(y.length, 12);
  assert.equal(y[0].isMonth, true, '年的桶是按月聚合的');
  assert.equal(y[0].key, '2026-01');
  assert.equal(y[11].key, '2026-12');
});

test('periodLabel：可读标题', () => {
  assert.equal(periodLabel('week', '2000-01-01'), '12 月 27 日 – 1 月 2 日');
  assert.equal(periodLabel('month', '2026-02-15'), '2026 年 2 月');
  assert.equal(periodLabel('year', '2026-06-01'), '2026 年');
});

test('shiftPeriod：前后翻一个周期', () => {
  assert.equal(shiftPeriod('week', '2000-01-01', -1), '1999-12-25');
  assert.equal(shiftPeriod('week', '2000-01-01', 1), '2000-01-08');
  assert.equal(shiftPeriod('month', '2026-01-15', -1), '2025-12-01');
  assert.equal(shiftPeriod('month', '2026-12-15', 1), '2027-01-01', '跨年');
  assert.equal(shiftPeriod('year', '2026-06-01', -1), '2025-01-01');
  assert.equal(shiftPeriod('year', '2026-06-01', 1), '2027-01-01');
});
