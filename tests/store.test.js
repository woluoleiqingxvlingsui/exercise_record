import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStore, memoryBackend, QuotaError, DEFAULT_SETTINGS, SCHEMA_VERSION, EXPORT_FORMAT,
  BUILTIN_CATEGORIES,
} from '../www/js/store.js';

function freshStore() {
  return createStore(memoryBackend());
}

function sampleSession(id, dateKey, extra = {}) {
  return {
    id, dateKey, planId: 'p1', planName: '引体日',
    startedAt: 0, endedAt: 0, status: 'done', cursor: 0,
    timeline: [], entries: [], adjustments: [], feedback: null, ...extra,
  };
}

test('计划 CRUD', () => {
  const s = freshStore();
  assert.deepEqual(s.listPlans(), []);

  const saved = s.savePlan({ name: '引体日', category: 'strength', stages: [] });
  assert.ok(saved.id, '没给 id 时自动生成');
  assert.equal(s.listPlans().length, 1);
  assert.equal(s.getPlan(saved.id).name, '引体日');

  s.savePlan({ id: saved.id, name: '引体日 v2', category: 'strength', stages: [] });
  assert.equal(s.listPlans().length, 1, '同 id 是更新不是新增');
  assert.equal(s.getPlan(saved.id).name, '引体日 v2');

  s.deletePlan(saved.id);
  assert.equal(s.listPlans().length, 0);
  assert.equal(s.getPlan(saved.id), null);
});

test('训练类别：记住 / 列出 / 删除', () => {
  const s = freshStore();
  assert.deepEqual(s.listCategories(), BUILTIN_CATEGORIES, '新库默认有内置的两个类别');

  s.rememberCategory(' 腿 ');
  assert.ok(s.listCategories().includes('腿'), '新填的类别没被记住');
  // 展示顺序：内置的两个在前，用户自己填的按"最近用过"排在后面
  assert.equal(s.listCategories().slice(0, BUILTIN_CATEGORIES.length).join(), BUILTIN_CATEGORIES.join());
  assert.equal(s.listCategories()[BUILTIN_CATEGORIES.length], '腿');
  assert.equal(s.listCategories().length, BUILTIN_CATEGORIES.length + 1);
  assert.ok(!s.listCategories().includes(' 腿 '), '应去掉首尾空格');

  s.rememberCategory('腿');
  assert.equal(s.listCategories().filter((c) => c === '腿').length, 1, '同名不该重复');

  // 用户自己填的类别可以删
  s.forgetCategory('腿');
  assert.ok(!s.listCategories().includes('腿'));

  // 内置的也能删，且删完不会自己冒回来（这正是 hiddenCategories 的作用）
  s.forgetCategory('有氧');
  assert.ok(!s.listCategories().includes('有氧'));
  assert.equal(s.listCategories().length, BUILTIN_CATEGORIES.length - 1);

  // 删过之后重新填同名，等于"复活"，也不该重复出现
  s.rememberCategory('有氧');
  assert.equal(s.listCategories().filter((c) => c === '有氧').length, 1);

  // 老数据里存英文旧值时归一去重
  const s2 = freshStore();
  s2.rememberCategory('cardio');
  assert.equal(s2.listCategories().filter((c) => c === 'cardio').length, 1);
});

test('训练类别：删除只动可选项，不动已有计划', () => {
  const s = freshStore();
  s.savePlan({ id: 'p1', name: '腿部日', category: '腿', stages: [] });
  s.rememberCategory('腿');
  s.forgetCategory('腿');
  assert.equal(s.getPlan('p1').category, '腿', '计划本身不受影响');
  assert.ok(!s.listCategories().includes('腿'));
});

test('会话按月分桶存放', () => {
  const s = freshStore();
  s.commitSession(sampleSession('a', '2026-03-05'));
  s.commitSession(sampleSession('b', '2026-03-28'));
  s.commitSession(sampleSession('c', '2026-04-02'));

  assert.deepEqual(s.listMonths(), ['2026-03', '2026-04']);
  assert.equal(s.sessionsInMonth('2026-03').length, 2);
  assert.equal(s.sessionsInMonth('2026-04').length, 1);
  assert.equal(s.allSessions().length, 3);
  assert.equal(s.getSession('c').dateKey, '2026-04-02');
  assert.equal(s.getSession('nope'), null);
  assert.ok(s.getMeta().months.includes('2026-04'));
});

test('同 id 会话再次落库是覆盖而非重复', () => {
  const s = freshStore();
  s.commitSession(sampleSession('a', '2026-03-05', { status: 'ongoing' }));
  s.commitSession(sampleSession('a', '2026-03-05', { status: 'done' }));
  assert.equal(s.sessionsInMonth('2026-03').length, 1);
  assert.equal(s.getSession('a').status, 'done');
});

test('删除会话', () => {
  const s = freshStore();
  s.commitSession(sampleSession('a', '2026-03-05'));
  assert.equal(s.deleteSession('a'), true);
  assert.equal(s.deleteSession('a'), false);
  assert.equal(s.sessionsInMonth('2026-03').length, 0);
});

test('进行中的训练单独存 ongoing，练完落桶并清空', () => {
  const s = freshStore();
  assert.equal(s.getOngoing(), null);

  const live = sampleSession('live', '2026-03-05', { status: 'ongoing', cursor: 3 });
  s.saveOngoing(live);
  assert.equal(s.getOngoing().cursor, 3);
  assert.equal(s.allSessions().length, 0, 'ongoing 不该混进正式记录');

  s.finishSession({ ...live, status: 'done', cursor: 10 });
  assert.equal(s.getOngoing(), null, '练完要清掉 ongoing');
  assert.equal(s.allSessions().length, 1);
  assert.equal(s.getSession('live').cursor, 10);
});

test('设置读写带默认值', () => {
  const s = freshStore();
  assert.deepEqual(s.getSettings(), DEFAULT_SETTINGS);
  const next = s.saveSettings({ confirmTimeoutMs: 15000 });
  assert.equal(next.confirmTimeoutMs, 15000);
  assert.equal(next.defaultRestMs, DEFAULT_SETTINGS.defaultRestMs, '未指定的项保留默认');
  assert.equal(s.getSettings().confirmTimeoutMs, 15000);
});

test('★ 导出 → 导入新库 → 再导出，内容完全一致（往返不丢数据）', () => {
  const a = freshStore();
  a.savePlan({ id: 'p1', name: '引体日', category: 'strength', stages: [{ id: 's1', kind: 'main', items: [] }] });
  a.savePlan({ id: 'p2', name: '有氧跑', category: 'cardio', stages: [] });
  a.commitSession(sampleSession('s1', '2026-03-05', { entries: [{ reps: 8 }] }));
  a.commitSession(sampleSession('s2', '2026-04-11'));
  a.saveSchedule({
    '2026-03-05': { dateKey: '2026-03-05', planned: [], sessions: ['s1'], status: 'done', note: '状态不错' },
  });
  a.saveSettings({ confirmTimeoutMs: 15000 });

  const dump = a.exportAll();
  assert.equal(dump.format, EXPORT_FORMAT);
  assert.equal(dump.version, SCHEMA_VERSION);

  const b = freshStore();
  b.importAll(dump, { mode: 'replace' });
  const dump2 = b.exportAll();

  assert.deepEqual(dump2.data, dump.data);
  assert.equal(b.getSession('s2').dateKey, '2026-04-11');
  assert.equal(b.getSchedule()['2026-03-05'].note, '状态不错');
});

test('导入 merge 模式按 id 去重，不冲掉已有记录', () => {
  const a = freshStore();
  a.savePlan({ id: 'p1', name: '引体日', category: 'strength', stages: [] });
  a.commitSession(sampleSession('s1', '2026-03-05'));
  const dump = a.exportAll();

  const b = freshStore();
  b.commitSession(sampleSession('s1', '2026-03-05', { status: 'ongoing' }));
  b.savePlan({ id: 'p1', name: '我本地的引体日', category: 'strength', stages: [] });

  const summary = b.importAll(dump, { mode: 'merge' });
  assert.equal(b.listPlans().length, 1);
  assert.equal(b.getPlan('p1').name, '我本地的引体日', '已存在的计划不被覆盖');
  assert.equal(b.sessionsInMonth('2026-03').length, 1, '同 id 会话不重复');
  assert.equal(b.getSession('s1').status, 'ongoing', '已存在的会话不被覆盖');
  assert.equal(summary.sessions, 0);

  // overwrite 时才覆盖
  b.importAll(dump, { mode: 'merge', overwrite: true });
  assert.equal(b.getPlan('p1').name, '引体日');
  assert.equal(b.getSession('s1').status, 'done');
});

test('导入 merge 能把备份里的新内容补进来', () => {
  const a = freshStore();
  a.commitSession(sampleSession('s1', '2026-03-05'));
  a.commitSession(sampleSession('s2', '2026-03-06'));
  const dump = a.exportAll();

  const b = freshStore();
  b.commitSession(sampleSession('s1', '2026-03-05'));
  const summary = b.importAll(dump);
  assert.equal(b.sessionsInMonth('2026-03').length, 2);
  assert.equal(summary.sessions, 1, '只新增了 s2');
});

test('拒绝非本 App 的备份与过高版本', () => {
  const s = freshStore();
  assert.throws(() => s.importAll({ format: 'other', version: 1 }), /不是本 App 导出的备份/);
  assert.throws(() => s.importAll(null), /不是本 App 导出的备份/);
  assert.throws(
    () => s.importAll({ format: EXPORT_FORMAT, version: SCHEMA_VERSION + 1, data: {} }),
    /更新的版本/);
});

test('wipeAll 清空后是新库', () => {
  const s = freshStore();
  s.savePlan({ id: 'p1', name: 'x', category: 'strength', stages: [] });
  s.commitSession(sampleSession('s1', '2026-03-05'));
  s.saveSettings({ confirmTimeoutMs: 5000 });
  s.saveOngoing(sampleSession('live', '2026-03-05'));

  s.wipeAll();
  assert.deepEqual(s.listPlans(), []);
  assert.deepEqual(s.listMonths(), []);
  assert.equal(s.getOngoing(), null);
  assert.deepEqual(s.getSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(s.allSessions(), []);
});

test('写入失败抛 QuotaError（绝不静默丢数据）', () => {
  const backend = memoryBackend();
  backend.setItem = () => {
    const e = new Error('QuotaExceededError');
    e.name = 'QuotaExceededError';
    throw e;
  };
  const s = createStore(backend);
  assert.throws(() => s.savePlan({ id: 'p1', name: 'x', category: 'strength', stages: [] }), (err) => {
    assert.ok(err instanceof QuotaError);
    assert.match(err.message, /导出备份/);
    return true;
  });
});

test('损坏的 JSON 不炸，退化为默认值', () => {
  const backend = memoryBackend();
  backend.setItem('ex.plans', '{ 这不是合法 JSON');
  backend.setItem('ex.settings', 'garbage');
  const s = createStore(backend);
  assert.deepEqual(s.listPlans(), []);
  assert.deepEqual(s.getSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(s.getSchedule(), {});
});

test('usage 统计用量', () => {
  const s = freshStore();
  s.savePlan({ id: 'p1', name: '引体日', category: 'strength', stages: [] });
  s.commitSession(sampleSession('s1', '2026-03-05'));
  const u = s.usage();
  assert.equal(u.plans, 1);
  assert.equal(u.sessions, 1);
  assert.ok(u.bytes > 0);
});
