import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, memoryBackend, initBrowserStore, QuotaError, EXPORT_FORMAT, SCHEMA_VERSION } from '../www/js/store.js';
import { seedPlans } from '../www/js/seed.js';
import { sessionFromPlan } from '../www/js/model.js';

function controlledBackend() {
  const backend = memoryBackend();
  const write = backend.setItem;
  let limit = Infinity;
  let fails = () => false;
  backend.setItem = (key, value) => {
    let size = 0;
    for (let i = 0; i < backend.length; i++) {
      const k = backend.key(i);
      if (k !== key) size += k.length + backend.getItem(k).length;
    }
    if (fails(key) || size + key.length + String(value).length > limit) {
      const error = new Error('Quota exceeded');
      error.name = 'QuotaExceededError';
      throw error;
    }
    write(key, value);
  };
  return { backend, setLimit: (n) => { limit = n; }, fail: (fn) => { fails = fn; } };
}
function payload(data) { return { format: EXPORT_FORMAT, version: SCHEMA_VERSION, data }; }
function record(id, dateKey, padding = 0) {
  return { id, dateKey, timeline: [], entries: [], adjustments: [], note: 'x'.repeat(padding) };
}

test('安全导入：写入新月份后失败会删除新增桶并恢复旧数据', () => {
  const c = controlledBackend();
  const s = createStore(c.backend);
  s.commitSession(record('old', '2026-03-01'));
  const before = s.exportAll().data;
  let failed = false;
  c.fail((key) => key === 'ex.schedule' && !failed && (failed = true));
  assert.throws(() => s.importAll(payload({ sessions: { '2026-04': [record('new', '2026-04-01')] } }), { mode: 'replace' }), QuotaError);
  assert.deepEqual(s.exportAll().data, before);
  assert.equal(c.backend.getItem('ex.sessions.2026-04'), null);
  assert.equal(c.backend.getItem('ex.import-undo'), null);
});

test('安全导入：总容量不足时原记录仍可读取和导出', () => {
  const c = controlledBackend();
  const s = createStore(c.backend);
  s.commitSession(record('old', '2026-03-01', 1000));
  const before = s.exportAll().data;
  c.setLimit(2200);
  assert.throws(() => s.importAll(payload({ sessions: { '2026-04': [record('new', '2026-04-01', 1500)] } }), { mode: 'replace' }), QuotaError);
  assert.deepEqual(s.exportAll().data, before);
  assert.equal(createStore(c.backend).getSession('old').id, 'old');
});

test('安全导入：恢复写入持续失败时保持只读旧视图，重启后恢复', () => {
  const c = controlledBackend();
  const s = createStore(c.backend);
  s.commitSession(record('old', '2026-03-01'));
  const before = s.exportAll().data;
  c.fail((key) => key === 'ex.schedule' || key === 'ex.sessions.2026-03');
  assert.throws(() => s.importAll(payload({ sessions: { '2026-04': [record('new', '2026-04-01')] } }), { mode: 'replace' }), QuotaError);
  assert.equal(s.getStorageStatus().writable, false);
  assert.deepEqual(s.exportAll().data, before);
  assert.throws(() => s.savePlan({ id: 'blocked' }), QuotaError);
  assert.ok(c.backend.getItem('ex.import-undo'));
  c.fail(() => false);
  const reopened = createStore(c.backend);
  assert.deepEqual(reopened.exportAll().data, before);
  assert.equal(reopened.getStorageStatus().writable, true);
  assert.equal(c.backend.getItem('ex.import-undo'), null);
});

test('安全导入：写入中断留下的日志会在下次启动恢复', () => {
  const b = memoryBackend();
  b.setItem('ex.import-undo', JSON.stringify([['ex.plans', '[{"id":"old"}]']]));
  b.setItem('ex.plans', '[{"id":"partial-new"}]');
  b.setItem('ex.sessions.2026-04', '[]');
  const s = createStore(b);
  assert.equal(s.getPlan('old').id, 'old');
  assert.equal(s.getPlan('partial-new'), null);
  assert.equal(b.getItem('ex.sessions.2026-04'), null);
});

test('损坏恢复日志会保留原存储并以只读警告启动', () => {
  for (const journal of ['{broken', '{}', '[["unrelated","value"]]']) {
    const backend = memoryBackend();
    backend.setItem('ex.import-undo', journal);
    backend.setItem('ex.plans', '[{"id":"readable","name":"可读计划"}]');
    const store = createStore(backend);
    assert.equal(store.getPlan('readable').name, '可读计划');
    assert.equal(store.getStorageStatus().writable, false);
    assert.match(store.getStorageStatus().warning, /可能不完整/);
    assert.throws(() => store.wipeAll(), QuotaError);
    assert.equal(backend.getItem('ex.import-undo'), journal);
    assert.equal(store.exportAll().data.plans[0].id, 'readable');
  }
});

test('存储满额启动仍显示现有数据，写入失败会通知界面', () => {
  const c = controlledBackend();
  c.backend.setItem('ex.plans', '[{"id":"existing","name":"原计划"}]');
  c.fail(() => true);
  const original = globalThis.window;
  globalThis.window = { localStorage: c.backend };
  try {
    const s = initBrowserStore();
    assert.equal(s.getPlan('existing').name, '原计划');
    const statuses = [];
    s.onStatus((value) => statuses.push(value));
    assert.throws(() => s.savePlan({ id: 'new' }), QuotaError);
    assert.equal(statuses.at(-1).mode, 'persistent');
    assert.match(statuses.at(-1).warning, /尚未保存/);
  } finally { if (original === undefined) delete globalThis.window; else globalThis.window = original; }
});

test('存储不可读时明确标记临时内存模式', () => {
  const original = globalThis.window;
  globalThis.window = { get localStorage() { throw new Error('Storage disabled'); } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const s = initBrowserStore();
    assert.equal(s.getStorageStatus().mode, 'memory');
    assert.match(s.getStorageStatus().warning, /关闭后会丢失/);
  } finally {
    console.warn = warn;
    if (original === undefined) delete globalThis.window; else globalThis.window = original;
  }
});

test('嵌套备份校验失败时不会写入计划、日程和进行中的训练', () => {
  const s = createStore(memoryBackend());
  s.savePlan({ id: 'old', name: '保留' });
  const before = s.exportAll().data;
  const invalid = [
    { plans: [{ id: 'bad', stages: {} }] },
    { plans: [{ id: 'bad', stages: [{ items: {} }] }] },
    { plans: [{ id: 'bad', stages: [{ items: [{ sets: { repeat: 1e9 } }] }] }] },
    { sessions: { '2026-02': [record('bad', '2026-02-30')] } },
    { schedule: { '2026-03-01': { planned: [null] } } },
    { ongoing: { id: 'bad', dateKey: '2026-03-01', timeline: {} } },
    JSON.parse('{"schedule":{"__proto__":{}}}'),
  ];
  for (const data of invalid) {
    assert.throws(() => s.importAll(payload(data), { mode: 'replace' }), /结构不正确/);
    assert.deepEqual(s.exportAll().data, before);
  }
});

test('示例计划与真实进行中训练的备份可往返恢复', () => {
  const s = createStore(memoryBackend());
  seedPlans().forEach((p) => s.savePlan(p));
  const live = sessionFromPlan(s.listPlans()[0]);
  live.playerState = { restEndTs: 0, restTotalMs: 0, confirmAt: 0, continuousStartedAt: 0, continuousStepId: '' };
  s.saveOngoing(live);
  const exported = s.exportAll();
  const next = createStore(memoryBackend());
  next.importAll(exported, { mode: 'replace' });
  assert.deepEqual(next.exportAll().data, exported.data);
});
