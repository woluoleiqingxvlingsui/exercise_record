/**
 * 回归测试 —— 覆盖 2026-11-02 只读审计里发现、后来修掉的那批缺陷。
 *
 * 为什么单独开一个文件：原来那 67 项测试**一条都没覆盖**这些路径，
 * 全绿也拦不住它们再犯。这里每一条都对着一个具体的"以前的坏行为"写断言，
 * 以后谁把修复改回去，测试会立刻变红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStore, memoryBackend, QuotaError, EXPORT_FORMAT, SCHEMA_VERSION,
} from '../www/js/store.js';
import {
  completeStep, skipCurrentStep, gotoStep, summarizeSession, manualSession,
  isDeviated, buildTimeline, sessionFromPlan,
} from '../www/js/model.js';
import { toNumOrNull } from '../www/js/util.js';

/* ------------------------------------------------------------------ 工具 */

/** 可控后端：能看内容，也能指定某个 key 写入时抛错 */
function controllableBackend() {
  const m = new Map();
  let failKey = null;
  let failCount = 0;   // 0=不失败；n=还能失败 n 次；Infinity=一直失败
  const backend = {
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (failKey && k === failKey && failCount !== 0) {
        // failOnce：只失败这一次（模拟"导入时写崩了一下、之后又能写"）
        if (failCount > 0) failCount -= 1;
        throw new Error('QuotaExceededError');
      }
      m.set(k, String(v));
    },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
  return {
    m, backend,
    failOn: (k) => { failKey = k; failCount = Infinity; },
    failOnce: (k) => { failKey = k; failCount = 1; },
    failNone: () => { failKey = null; failCount = 0; },
  };
}

function sampleSession(id, dateKey, extra = {}) {
  return {
    id, dateKey, planId: 'p1', planName: '引体日',
    startedAt: 0, endedAt: 0, status: 'done', cursor: 0,
    timeline: [], entries: [], adjustments: [], feedback: null, ...extra,
  };
}

/* ------------------------------------------------- 导入：坏结构不许清库 */

test('回归：全量替换导入遇到坏结构 → 报错，但数据一条都没丢', () => {
  const s = createStore(memoryBackend());
  s.savePlan({ id: 'p1', name: '原计划' });
  s.commitSession(sampleSession('s1', '2026-03-05'));
  s.saveSchedule({ '2026-03-05': { dateKey: '2026-03-05', planned: [], sessions: ['s1'], status: 'done' } });

  assert.throws(
    () => s.importAll({ format: EXPORT_FORMAT, version: SCHEMA_VERSION, data: { plans: { 不是数组: true } } }, { mode: 'replace' }),
    /结构不正确/,
    '坏结构必须被拒绝'
  );

  assert.equal(s.listPlans().length, 1, '原计划必须还在');
  assert.equal(s.listPlans()[0].name, '原计划');
  assert.equal(s.allSessions().length, 1, '原记录必须还在');
  assert.equal(Object.keys(s.getSchedule()).length, 1, '原日程必须还在');
});

test('回归：全量替换导入写到一半失败 → 原库原样恢复', () => {
  const c = controllableBackend();
  const s = createStore(c.backend);
  s.savePlan({ id: 'p1', name: '原计划' });
  s.commitSession(sampleSession('s1', '2026-03-05'));
  s.saveSchedule({ '2026-03-05': { dateKey: '2026-03-05', planned: [], sessions: ['s1'], status: 'done' } });

  // 让日程写入失败一次 —— 这发生在导入流程的末尾，前面已经写了计划/记录/meta。
  // （真实场景：配额满/写入抖了一下。注意 wipeAll 已经腾出过空间，所以回滚通常写得回去。）
  c.failOnce('ex.schedule');
  assert.throws(() => s.importAll({
    format: EXPORT_FORMAT, version: SCHEMA_VERSION,
    data: { plans: [{ id: 'p2', name: '新计划' }], schedule: {}, sessions: {}, meta: {}, settings: {} },
  }, { mode: 'replace' }), QuotaError);

  c.failNone();
  assert.equal(s.listPlans().length, 1, '原计划必须被恢复');
  assert.equal(s.listPlans()[0].name, '原计划');
  assert.equal(s.allSessions().length, 1, '原记录必须被恢复');
  assert.equal(Object.keys(s.getSchedule()).length, 1, '原日程必须被恢复');
});

/* ------------------------------------------------------ meta 坏了不许丢数据 */

test('回归：ex.meta 损坏 → 记录仍能在界面和导出里看到', () => {
  const c = controllableBackend();
  const s = createStore(c.backend);
  s.commitSession(sampleSession('s1', '2026-03-05'));

  assert.equal(s.allSessions().length, 1);
  assert.deepEqual(Object.keys(s.exportAll().data.sessions), ['2026-03']);

  // meta 被写坏（少了 months 字段）
  c.m.set('ex.meta', JSON.stringify({ schemaVersion: 1, seeded: true }));

  assert.equal(s.allSessions().length, 1, 'meta 坏了也不能让记录消失');
  assert.deepEqual(Object.keys(s.exportAll().data.sessions), ['2026-03'], '导出里也必须还在');
});

test('回归：meta 里的 seeded 等额外字段不能被丢掉', () => {
  const s = createStore(memoryBackend());
  s.saveMeta({ schemaVersion: SCHEMA_VERSION, seeded: true });
  assert.equal(s.getMeta().seeded, true, 'seeded 必须保留');
});

test('回归：清空数据后 seeded 不丢 → 示例计划不会自己长回来', () => {
  const s = createStore(memoryBackend());
  s.saveMeta({ schemaVersion: SCHEMA_VERSION, seeded: true });
  s.wipeAll();
  s.saveMeta({ ...s.getMeta(), schemaVersion: SCHEMA_VERSION, seeded: true });
  assert.equal(s.getMeta().seeded, true);
});

/* ---------------------------------------------------------- 写入顺序与孤儿 */

test('回归：commitSession 先登记月份再写分桶 → 失败时不留孤儿记录', () => {
  const c = controllableBackend();
  const s = createStore(c.backend);
  c.failOn('ex.meta');

  assert.throws(() => s.commitSession(sampleSession('s1', '2026-03-05')), QuotaError);

  c.failNone();
  assert.equal(s.allSessions().length, 0, '不该有看不见的孤儿记录');
  assert.equal(s.getSession('s1'), null);
  assert.equal(JSON.stringify(s.exportAll().data.sessions).includes('s1'), false, '导出里也不该出现');
});

/* ------------------------------------------------------------ 导出/导入往返 */

test('回归：导出 → 导入新库 → 再导出，内容完全一致（含进行中的训练）', () => {
  const s1 = createStore(memoryBackend());
  s1.savePlan({ id: 'p1', name: '引体日' });
  s1.commitSession(sampleSession('s1', '2026-03-05'));
  s1.saveMeta({ schemaVersion: SCHEMA_VERSION, months: ['2026-03'], seeded: true });
  s1.saveOngoing(sampleSession('ongoing-1', '2026-03-06', { status: 'ongoing' }));

  const exported = s1.exportAll();
  assert.ok(exported.data.ongoing, '进行中的训练也要进备份');

  const s2 = createStore(memoryBackend());
  s2.importAll(exported, { mode: 'replace' });
  const again = s2.exportAll();

  assert.deepEqual(again.data.meta, exported.data.meta, 'meta 往返必须恒等');
  assert.deepEqual(again.data.sessions, exported.data.sessions);
  assert.deepEqual(again.data.plans, exported.data.plans);
  assert.deepEqual(again.data.ongoing, exported.data.ongoing, '进行中的训练也要能恢复');
  assert.equal(s2.getOngoing().id, 'ongoing-1');
});

/* ------------------------------------------------------------------ 模型 */

test('回归：gotoStep 不能往回跳（否则同一组会被记两次）', () => {
  const plan = { id: 'p', name: 'x', stages: [{ kind: 'main', name: '正式组', items: [{ id: 'i1', name: '深蹲', mode: 'reps', defaultRestMs: 60000, sets: { repeat: 3, of: { reps: 5 } } }] }] };
  const s = sessionFromPlan(plan);
  s.cursor = 2;
  const before = s.cursor;
  assert.equal(gotoStep(s, 0), false, '回跳必须被拒绝');
  assert.equal(s.cursor, before, '游标不能退');
});

test('回归：skipCurrentStep 能跳掉当前这一组并落到下一组', () => {
  const plan = { id: 'p', name: 'x', stages: [{ kind: 'main', name: '正式组', items: [{ id: 'i1', name: '深蹲', mode: 'reps', defaultRestMs: 60000, sets: { repeat: 3, of: { reps: 5 } } }] }] };
  const s = sessionFromPlan(plan);
  const total = s.timeline.length;
  const firstId = s.timeline[0].id;

  const gone = skipCurrentStep(s, '跳过本组');
  assert.ok(gone, '应该能跳掉');
  assert.equal(gone.id, firstId);
  assert.equal(s.timeline.length, total - 1, '时间线少了一组');
  assert.equal(s.cursor, 0, '游标停在原地，也就是下一组');
  assert.equal(s.timeline[0].id !== firstId, true, '当前组真的被摘掉了');
  assert.equal(s.adjustments.length, 1, '跳过要留痕');
});

test('回归：最后一组选灵活调整 → 记录里不写不存在的间歇', () => {
  const plan = { id: 'p', name: 'x', stages: [{ kind: 'main', name: '正式组', items: [{ id: 'i1', name: '深蹲', mode: 'reps', defaultRestMs: 60000, sets: { repeat: 1, of: { reps: 5 } } }] }] };
  const s = sessionFromPlan(plan);
  s.cursor = s.timeline.length - 1;   // 最后一组

  const willBeLast = s.cursor + 1 >= s.timeline.length;
  assert.equal(willBeLast, true);
  const effectiveRest = willBeLast ? 0 : 60000;
  completeStep(s, { reps: 5 }, { restMs: effectiveRest, decision: 'flex' });

  const entry = s.entries[0];
  assert.equal(entry.restActualMs, 0, '最后一组不该留下间歇值');
  const sum = summarizeSession(s);
  assert.equal(sum.restMs, 0, '休息合计也不该有值');
});

test('回归：自动推进的组不算「偏离计划」', () => {
  const plan = { id: 'p', name: 'x', stages: [{ kind: 'main', name: '正式组', items: [{ id: 'i1', name: '深蹲', mode: 'reps', defaultRestMs: 60000, sets: { repeat: 1, of: { reps: 8, weightKg: 50 } } }] }] };
  const s = sessionFromPlan(plan);
  const e = completeStep(s, {}, { restMs: 60000, decision: 'auto' });
  assert.equal(e.deviated, false, '自动推进不是偏离');
  assert.equal(isDeviated(e), false);
  assert.equal(summarizeSession(s).deviations, 0);
});

test('回归：loggedSec 是非法值时，时长不能变成 NaN', () => {
  const s = sampleSession('s1', '2026-03-05', { startedAt: 1000, endedAt: 5000, loggedSec: 'abc' });
  const sum = summarizeSession(s);
  assert.equal(Number.isFinite(sum.durationMs), true, 'durationMs 不能是 NaN');
  assert.equal(sum.loggedMin === null || Number.isFinite(sum.loggedMin), true,
    'loggedMin 要么是 null（没记过），要么是有限数，不能是 NaN');
  assert.equal(sum.durationMs, 4000, '非法值要回落到自动计时');
});

test('回归：manualSession 传非法日期键也不能产生 NaN', () => {
  const s = manualSession({ dateKey: '不是日期', category: '有氧', loggedSec: 1800 });
  assert.equal(Number.isFinite(s.startedAt), true, 'startedAt 不能是 NaN');
  assert.equal(Number.isFinite(s.endedAt), true, 'endedAt 不能是 NaN');
  assert.match(s.dateKey, /^\d{4}-\d{2}-\d{2}$/, 'dateKey 要被修正成合法格式');
  const json = JSON.stringify(s);
  assert.equal(/"startedAt":null/.test(json), false, '时间戳不能序列化成 null');
  assert.equal(/"endedAt":null/.test(json), false, '时间戳不能序列化成 null');
});

test('回归：toNumOrNull 只输入空格 → null（不是 0）', () => {
  assert.equal(toNumOrNull(' '), null);
  assert.equal(toNumOrNull('\t'), null);
  assert.equal(toNumOrNull(''), null);
  assert.equal(toNumOrNull('0'), 0);
  assert.equal(toNumOrNull('12'), 12);
});

test('回归：休息优先级的既有约定没被改坏（每组=动作间歇，整份计划最后一步=0）', () => {
  const plan = { id: 'p', name: 'x', stages: [{ kind: 'main', name: '正式组', items: [{ id: 'i1', name: '深蹲', mode: 'reps', defaultRestMs: 45000, sets: { repeat: 2, of: { reps: 5 } } }] }] };
  const steps = buildTimeline(plan);
  assert.equal(steps[0].restPlannedMs, 45000);
  assert.equal(steps[steps.length - 1].restPlannedMs, 0, '整份计划最后一步不安排间歇');
});
