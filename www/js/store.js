/**
 * store.js —— 本地持久化。
 *
 * 设计要点：
 *  1. **分桶存储**：会话按 `ex.sessions.YYYY-MM` 分月存，避免单个大 key 每次写入都全量序列化。
 *  2. **进行中的训练单独存 `ex.ongoing`**：训练期间每次状态变化只写这一条（很小），
 *     练完才落进当月桶。既保证杀进程可恢复，又不会每次改一组都重写整月数据。
 *  3. **后端可注入**：浏览器传 localStorage，测试传 memoryBackend，
 *     所以本模块没有任何 DOM 依赖，`node --test` 可直接跑。
 *  4. **配额保护**：写失败抛 QuotaError，由界面提示导出备份，绝不静默丢数据。
 */

import { monthKeyOf, uid } from './util.js';

export const SCHEMA_VERSION = 1;
export const EXPORT_FORMAT = 'exercise-record';

const JOURNAL_KEY = 'ex.import-undo';

const K = {
  meta: 'ex.meta',
  plans: 'ex.plans',
  schedule: 'ex.schedule',
  settings: 'ex.settings',
  ongoing: 'ex.ongoing',
  sessionPrefix: 'ex.sessions.',
};

/** 本地存储写不进去（通常是配额满）——必须让用户知道，不能装作写成功了 */
export class QuotaError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'QuotaError';
    this.cause = cause;
  }
}

/** 内存后端：给测试用，也在浏览器无 localStorage 时兜底（数据不持久，但功能不炸） */
export function memoryBackend() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

/**
 * 类别是**用户自由输入**的文本，不限死"力量/有氧"两类：
 * 用户填过的记在 settings.knownCategories 里，下次直接点选复用。
 * 内置的两个只是"开箱即用"的起步项，可以被用户删掉 —— 所以删掉的要记下来
 * （hiddenCategories），否则内置项删完又会自己冒回来。
 */
export const BUILTIN_CATEGORIES = ['力量', '有氧'];

export const DEFAULT_SETTINGS = {
  /** 询问「按计划推进 / 灵活调整」的自动兜底毫秒数；0 = 关闭 */
  confirmTimeoutMs: 20000,
  /** 新建动作时的默认组间歇 */
  defaultRestMs: 90000,
  /** 休息结束是否震动（实际震动由原生服务负责，这里仅供界面提示） */
  vibrateOnRestEnd: true,
  /** 用户自己输入过的训练类别，供下次直接点选复用（最新在前，最多留 30 个） */
  knownCategories: [],
  /** 被用户删掉的类别（含内置的两个），避免删除后又自动补回来 */
  hiddenCategories: [],
  /** 保留给未来的深色模式等 */
  schemaVersion: SCHEMA_VERSION,
};

export function createStore(backend, options = {}) {
  const listeners = new Set();
  let status = { mode: options.mode || 'persistent', writable: true, warning: options.warning || '' };
  let recovery = null;
  const publish = (patch) => {
    status = { ...status, ...patch };
    listeners.forEach((fn) => { try { fn({ ...status }); } catch (_) { /* UI observer */ } });
  };
  const getStorageStatus = () => ({ ...status });
  const onStatus = (fn) => {
    listeners.add(fn);
    fn(getStorageStatus());
    return () => listeners.delete(fn);
  };
  const dataKey = (key) => Object.values(K).includes(key) || key.startsWith(K.sessionPrefix);
  const rawKeys = () => {
    const keys = new Set([K.meta, K.plans, K.schedule, K.settings, K.ongoing]);
    if (typeof backend.key === 'function') {
      for (let i = 0; i < backend.length; i += 1) {
        const key = backend.key(i);
        if (key && dataKey(key)) keys.add(key);
      }
    }
    // Also support injected backends without key enumeration.
    try {
      const meta = JSON.parse(backend.getItem(K.meta) || 'null');
      if (Array.isArray(meta?.months)) meta.months.forEach((m) => keys.add(K.sessionPrefix + m));
    } catch (_) { /* Enumerated buckets remain recoverable even with damaged meta. */ }
    return [...keys];
  };
  const recover = () => {
    try {
      // Free imported data before restoring; the undo log stays durable until all writes succeed.
      rawKeys().forEach((key) => backend.removeItem(key));
      recovery.forEach(([key, value]) => backend.setItem(key, value));
      backend.removeItem(JOURNAL_KEY);
      recovery = null;
    } catch (_) {
      publish({ writable: false, warning: '导入恢复尚未完成，当前只读显示原数据；请先导出备份，再释放空间并重启。' });
    }
  };
  const savedUndo = backend.getItem(JOURNAL_KEY);
  if (savedUndo != null) {
    let journal;
    try { journal = JSON.parse(savedUndo); } catch (_) { /* Preserve damaged recovery data. */ }
    if (!Array.isArray(journal) || !journal.every((pair) => Array.isArray(pair) && pair.length === 2
      && typeof pair[0] === 'string' && dataKey(pair[0]) && typeof pair[1] === 'string')) {
      publish({ writable: false, warning: '本地导入恢复日志损坏，已停止写入；当前数据可能不完整，请保留原存储并导出可读数据，再使用完整备份恢复。' });
    } else {
      recovery = journal;
      recover();
    }
  }
  const visibleKeys = () => recovery ? recovery.map(([key]) => key) : rawKeys();
  const readRaw = (key) => recovery
    ? (recovery.find(([k]) => k === key)?.[1] ?? null) : backend.getItem(key);
  const assertWritable = () => {
    if (!status.writable) throw new QuotaError(status.warning);
  };
  const readJson = (key, fallback) => {
    try {
      const raw = readRaw(key);
      if (raw == null || raw === '') return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  };

  const writeJson = (key, value) => {
    assertWritable();
    try {
      backend.setItem(key, JSON.stringify(value));
    } catch (e) {
      publish({ warning: '本地存储写入失败，本次改动尚未保存；请尽快导出备份并释放空间。' });
      throw new QuotaError(status.warning, e);
    }
  };

  const remove = (key) => {
    assertWritable();
    try { backend.removeItem(key); } catch (e) {
      publish({ warning: '本地存储删除失败，数据尚未清除，请备份后重试。' });
      throw new QuotaError(status.warning, e);
    }
  };

  /* ---------------------------------------------------------------- meta */

  /**
   * 读 meta。
   *
   * 刻意**原样保留**除 months 以外的字段（比如 seeded）：
   * 以前这里只认 { schemaVersion, months }，别的字段一律丢掉，
   * 结果「清空数据」把 seeded 冲掉后，下次启动示例计划会自己长回来。
   *
   * months 缺失时补空数组，但不因此把整个存储作废。
   */
  function getMeta() {
    const m = readJson(K.meta, null);
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      return { ...m, months: Array.isArray(m.months) ? m.months.slice() : [] };
    }
    return { schemaVersion: SCHEMA_VERSION, months: [] };
  }

  function saveMeta(meta) {
    writeJson(K.meta, meta);
    return meta;
  }

  /**
   * 已知月份 = meta 里登记的 ∪ 存储里真实存在的分桶 key。
   *
   * 以前只看 meta.months：meta 一旦损坏或丢失（写坏、被清掉、跨版本改名），
   * **所有训练记录就从界面和导出里一起消失**，而分桶数据其实还好好地躺在盘上。
   * 扫一遍真实 key 就不会因为索引丢了而看不到数据。
   */
  function listMonths() {
    const months = new Set(getMeta().months);
    visibleKeys().forEach((key) => {
      if (key.startsWith(K.sessionPrefix)) months.add(key.slice(K.sessionPrefix.length));
    });
    return Array.from(months).sort();
  }

  function ensureMonth(month) {
    const meta = getMeta();
    if (!meta.months.includes(month)) {
      meta.months.push(month);
      meta.months.sort();
      saveMeta(meta);
    }
    return month;
  }

  /* ------------------------------------------------------------ settings */

  function getSettings() {
    return { ...DEFAULT_SETTINGS, ...readJson(K.settings, {}) };
  }

  function saveSettings(patch) {
    const next = { ...getSettings(), ...patch };
    writeJson(K.settings, next);
    return next;
  }

  /* ------------------------------------------------------------- 训练类别 */

  const catList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

  /** 可复用的类别：内置两个 + 用户填过的，去掉已删除的 */
  function listCategories() {
    const s = getSettings();
    const hidden = new Set(catList(s.hiddenCategories));
    const all = BUILTIN_CATEGORIES.concat(catList(s.knownCategories));
    return Array.from(new Set(all)).filter((c) => !hidden.has(c));
  }

  /** 记住用户填过的类别，最新的排最前，最多留 30 个；同名等于"复活" */
  function rememberCategory(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) return listCategories();
    const s = getSettings();
    const next = [n, ...catList(s.knownCategories).filter((c) => c !== n)].slice(0, 30);
    saveSettings({
      knownCategories: next,
      hiddenCategories: catList(s.hiddenCategories).filter((c) => c !== n),
    });
    return listCategories();
  }

  /** 删掉一个类别条目。只动"可选项"，已经用它建好的计划不受影响。 */
  function forgetCategory(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) return listCategories();
    const s = getSettings();
    saveSettings({
      knownCategories: catList(s.knownCategories).filter((c) => c !== n),
      hiddenCategories: Array.from(new Set(catList(s.hiddenCategories).concat(n))),
    });
    return listCategories();
  }

  /* --------------------------------------------------------------- plans */

  function listPlans() {
    const list = readJson(K.plans, []);
    return Array.isArray(list) ? list : [];
  }

  function getPlan(id) {
    return listPlans().find((p) => p.id === id) || null;
  }

  function savePlan(plan) {
    const list = listPlans();
    const idx = list.findIndex((p) => p.id === plan.id);
    const next = { ...plan };
    if (!next.id) next.id = uid('plan');
    if (idx >= 0) list[idx] = next; else list.push(next);
    writeJson(K.plans, list);
    return next;
  }

  function deletePlan(id) {
    writeJson(K.plans, listPlans().filter((p) => p.id !== id));
  }

  /* ------------------------------------------------------------ schedule */

  function getSchedule() {
    const s = readJson(K.schedule, {});
    return s && typeof s === 'object' ? s : {};
  }

  function saveSchedule(schedule) {
    writeJson(K.schedule, schedule);
    return schedule;
  }

  /* ------------------------------------------------------------ sessions */

  function sessionsInMonth(month) {
    const list = readJson(K.sessionPrefix + month, []);
    return Array.isArray(list) ? list : [];
  }

  function allSessions() {
    const out = [];
    listMonths().forEach((m) => { out.push(...sessionsInMonth(m)); });
    return out;
  }

  function getSession(id) {
    for (const m of listMonths()) {
      const found = sessionsInMonth(m).find((s) => s.id === id);
      if (found) return found;
    }
    return null;
  }

  /** 落库一条会话（训练结束时调用，或日后编辑已完成的记录） */
  function commitSession(session) {
    const month = monthKeyOf(session.dateKey);
    // 先把月份登记进 meta，再写分桶。
    // 顺序反过来的话：分桶写成功、meta 写失败（配额满），
    // 这条记录就成了"孤儿"—— allSessions / getSession / exportAll 全都看不到它，
    // 数据在盘上却等于没了。先登记则失败时什么都没写，错误是诚实的。
    ensureMonth(month);
    const list = sessionsInMonth(month);
    const idx = list.findIndex((s) => s.id === session.id);
    if (idx >= 0) list[idx] = session; else list.push(session);
    writeJson(K.sessionPrefix + month, list);
    return session;
  }

  function deleteSession(id) {
    for (const m of listMonths()) {
      const list = sessionsInMonth(m);
      const next = list.filter((s) => s.id !== id);
      if (next.length !== list.length) {
        writeJson(K.sessionPrefix + m, next);
        return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------- 进行中的训练 */

  function getOngoing() {
    const s = readJson(K.ongoing, null);
    return s && typeof s === 'object' && s.id ? s : null;
  }

  /** 训练期间每次变化都写这里——单条对象，代价小，杀进程也能恢复 */
  function saveOngoing(session) {
    writeJson(K.ongoing, session);
    return session;
  }

  function clearOngoing() {
    remove(K.ongoing);
  }

  /** 结束训练：落进当月桶 + 清掉 ongoing（两步都要成功语义，先写桶再清） */
  function finishSession(session) {
    commitSession(session);
    clearOngoing();
    return session;
  }

  /* ------------------------------------------------------- 导出 / 导入 */

  function exportAll() {
    const sessions = {};
    listMonths().forEach((m) => { sessions[m] = sessionsInMonth(m); });
    return {
      format: EXPORT_FORMAT,
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      data: {
        plans: listPlans(),
        schedule: getSchedule(),
        settings: getSettings(),
        sessions,
        meta: getMeta(),
        // 进行中的训练也要进备份：它在 ex.ongoing 里，
        // 不导的话「导出了再恢复」会把练到一半的组弄丢。
        ongoing: getOngoing(),
      },
    };
  }

  /** localStorage has no multi-key transaction: reserve a durable undo log BEFORE touching data.
   * If rollback itself fails, all reads use the old log and writes are blocked until restart recovery.
   * Requires space for old + new + undo at peak; insufficient space rejects without deleting old data.
   * This protects a single writer; concurrent tabs/imports are not a supported transaction boundary.
   */
  function replaceAll(data, opts) {
    assertWritable();
    const stagingBackend = memoryBackend();
    const staging = createStore(stagingBackend);
    const summary = staging.importAll({ format: EXPORT_FORMAT, version: SCHEMA_VERSION, data }, { ...opts, mode: 'merge' });
    const previous = rawKeys().map((key) => [key, backend.getItem(key)]).filter(([, value]) => value != null);
    writeJson(JOURNAL_KEY, previous);
    recovery = previous;
    try {
      const nextKeys = [];
      for (let i = 0; i < stagingBackend.length; i += 1) nextKeys.push(stagingBackend.key(i));
      // Write even empty values, so write failures are observable instead of silently skipping keys.
      nextKeys.forEach((key) => backend.setItem(key, stagingBackend.getItem(key)));
      rawKeys().filter((key) => !nextKeys.includes(key)).forEach((key) => backend.removeItem(key));
      backend.removeItem(JOURNAL_KEY); // Commit point: all new data is durable before discarding undo.
      recovery = null;
      publish({ writable: true, warning: options.warning || '' });
      return { ...summary, mode: 'replace' };
    } catch (e) {
      recover();
      if (!recovery) publish({ warning: '导入未完成，原数据已恢复。请导出备份并释放空间后重试。' });
      throw new QuotaError(status.warning, e);
    }
  }

  /**
   * 备份结构自检。
   *
   * 必须在**清空之前**跑：以前「全量替换」是先 wipeAll() 再解析 data，
   * 备份结构不对时抛错倒是抛了，但库已经空了 —— 用户看到一句"导入失败"，
   * 数据却真的没了。
   */
  function validatePayload(data) {
    const problems = [];
    const fail = (path) => { if (problems.length < 20) problems.push(`${path} 无效`); };
    const object = (v, path) => {
      const ok = v !== null && typeof v === 'object' && !Array.isArray(v);
      if (!ok) fail(path);
      return ok;
    };
    const array = (v, path, check) => {
      if (!Array.isArray(v)) { fail(path); return; }
      v.forEach((x, i) => check(x, `${path}[${i}]`));
    };
    const text = (v, path) => { if (typeof v !== 'string') fail(path); };
    const id = (v, path) => { if (typeof v !== 'string' || !v.trim()) fail(path); };
    const number = (v, path) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(path); };
    const integer = (v, path) => { number(v, path); if (!Number.isSafeInteger(v)) fail(path); };
    const optional = (v, fields, check, path) => fields.forEach((key) => {
      if (v[key] != null) check(v[key], `${path}.${key}`);
    });
    const strings = (v, path) => array(v, path, text);
    const monthOK = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
    const dateOK = (v) => {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
      const d = new Date(`${v}T12:00:00Z`);
      return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
    };
    const date = (v, path) => { if (!dateOK(v)) fail(path); };
    const spec = (v, path) => {
      if (!object(v, path)) return;
      optional(v, ['reps', 'weightKg', 'durationS', 'distanceKm', 'paceSPerKm'], number, path);
      optional(v, ['note'], text, path);
    };
    const plan = (v, path, requireId = false) => {
      if (!object(v, path)) return;
      if (requireId) id(v.id, `${path}.id`);
      optional(v, ['id', 'name', 'category', 'note'], text, path);
      if (v.tags != null) strings(v.tags, `${path}.tags`);
      if (v.stages != null) array(v.stages, `${path}.stages`, (stage, sp) => {
        if (!object(stage, sp)) return;
        optional(stage, ['id', 'kind', 'name'], text, sp);
        if (stage.items != null) array(stage.items, `${sp}.items`, (item, ip) => {
          if (!object(item, ip)) return;
          optional(item, ['id', 'name'], text, ip);
          if (item.mode != null && !['reps', 'duration', 'distance'].includes(item.mode)) fail(`${ip}.mode`);
          optional(item, ['defaultRestMs'], number, ip);
          if (item.sets != null) {
            if (Array.isArray(item.sets)) array(item.sets, `${ip}.sets`, spec);
            else if (object(item.sets, `${ip}.sets`)) {
              if (item.sets.repeat != null) {
                integer(item.sets.repeat, `${ip}.sets.repeat`);
                if (item.sets.repeat < 1 || item.sets.repeat > 10000) fail(`${ip}.sets.repeat`);
              }
              if (item.sets.of != null) spec(item.sets.of, `${ip}.sets.of`);
            }
          }
        });
      });
    };
    const session = (v, path, month = null, ongoing = false) => {
      if (!object(v, path)) return;
      id(v.id, `${path}.id`);
      date(v.dateKey, `${path}.dateKey`);
      if (month && monthKeyOf(v.dateKey) !== month) fail(`${path}.dateKey 与分桶不一致`);
      optional(v, ['planId', 'planName', 'status', 'source', 'uiPhase'], text, path);
      optional(v, ['startedAt', 'endedAt', 'loggedSec'], number, path);
      if (v.planSnapshot != null) plan(v.planSnapshot, `${path}.planSnapshot`);
      if (ongoing && (!Array.isArray(v.timeline) || !Array.isArray(v.entries)
        || !Array.isArray(v.adjustments) || (v.timeline.length > 0 && !v.planSnapshot))) {
        fail(`${path} 缺少恢复训练所需字段`);
      }
      if (v.cursor != null) {
        integer(v.cursor, `${path}.cursor`);
        if (Array.isArray(v.timeline) && v.cursor > v.timeline.length) fail(`${path}.cursor`);
      }
      if (v.timeline != null) array(v.timeline, `${path}.timeline`, (step, tp) => {
        if (!object(step, tp)) return;
        id(step.id, `${tp}.id`);
        optional(step, ['itemId', 'itemName', 'stageName', 'stageKind'], text, tp);
        optional(step, ['stageIndex', 'itemIndex', 'setIndex', 'setTotal'], integer, tp);
        optional(step, ['restPlannedMs', 'restOverrideMs'], number, tp);
        if (step.continuous != null && typeof step.continuous !== 'boolean') fail(`${tp}.continuous`);
        if (step.mode != null && !['reps', 'duration', 'distance'].includes(step.mode)) fail(`${tp}.mode`);
        if (step.spec != null) spec(step.spec, `${tp}.spec`);
      });
      if (v.entries != null) array(v.entries, `${path}.entries`, (entry, ep) => {
        if (!object(entry, ep)) return;
        optional(entry, ['itemName', 'stepId', 'stageKind', 'decision'], text, ep);
        optional(entry, ['restActualMs', 'restPlannedMs', 'completedAt'], number, ep);
        optional(entry, ['setIndex', 'setTotal'], integer, ep);
        if (entry.actual != null) spec(entry.actual, `${ep}.actual`);
        if (entry.planned != null) spec(entry.planned, `${ep}.planned`);
      });
      if (v.adjustments != null) array(v.adjustments, `${path}.adjustments`, (a, ap) => {
        if (!object(a, ap)) return;
        optional(a, ['scope', 'field', 'reason', 'itemId', 'stepId'], text, ap);
        optional(a, ['at'], number, ap);
        ['from', 'to'].forEach((key) => {
          if (a[key] != null && !['string', 'number'].includes(typeof a[key])) fail(`${ap}.${key}`);
        });
      });
      if (v.playerState != null && object(v.playerState, `${path}.playerState`)) {
        optional(v.playerState, ['restEndTs', 'restTotalMs', 'confirmAt', 'continuousStartedAt'], number, `${path}.playerState`);
        optional(v.playerState, ['continuousStepId'], text, `${path}.playerState`);
      }
      if (v.feedback != null && object(v.feedback, `${path}.feedback`)) {
        const fb = v.feedback;
        optional(fb, ['rpe', 'at'], number, `${path}.feedback`);
        optional(fb, ['note', 'nextTimeNote', 'completion'], text, `${path}.feedback`);
        if (fb.feel != null) strings(fb.feel, `${path}.feedback.feel`);
        if (fb.pain != null && object(fb.pain, `${path}.feedback.pain`)) {
          if (fb.pain.parts != null) strings(fb.pain.parts, `${path}.feedback.pain.parts`);
          optional(fb.pain, ['note'], text, `${path}.feedback.pain`);
        }
      }
    };
    if (!object(data, 'data')) return problems;
    // Prevent prototype keys reaching ordinary object maps used by schedule/import consumers.
    const safeKeys = (v, path) => {
      if (!v || typeof v !== 'object') return;
      Object.keys(v).forEach((key) => {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(`${path}.${key}`);
        safeKeys(v[key], `${path}.${key}`);
      });
    };
    safeKeys(data, 'data');
    if (data.plans != null) array(data.plans, 'data.plans', (p, path) => plan(p, path, true));
    if (data.sessions != null && object(data.sessions, 'data.sessions')) {
      const seen = new Set();
      Object.entries(data.sessions).forEach(([month, list]) => {
        if (!monthOK(month)) fail(`data.sessions.${month}`);
        array(list, `data.sessions.${month}`, (s, path) => {
          session(s, path, month);
          if (s && seen.has(s.id)) fail(`${path}.id 重复`);
          if (s) seen.add(s.id);
        });
      });
    }
    if (data.ongoing != null) session(data.ongoing, 'data.ongoing', null, true);
    if (data.schedule != null && object(data.schedule, 'data.schedule')) Object.entries(data.schedule).forEach(([day, v]) => {
      if (!dateOK(day)) fail(`data.schedule.${day}`);
      const path = `data.schedule.${day}`;
      if (!object(v, path)) return;
      if (v.dateKey != null && v.dateKey !== day) fail(`${path}.dateKey`);
      optional(v, ['note', 'status'], text, path);
      if (v.sessions != null) strings(v.sessions, `${path}.sessions`);
      if (v.planned != null) array(v.planned, `${path}.planned`, (p, pp) => {
        if (!object(p, pp)) return;
        id(p.id, `${pp}.id`);
        optional(p, ['planId', 'planName'], text, pp);
      });
    });
    if (data.settings != null && object(data.settings, 'data.settings')) {
      optional(data.settings, ['confirmTimeoutMs', 'defaultRestMs', 'schemaVersion'], number, 'data.settings');
      ['knownCategories', 'hiddenCategories'].forEach((key) => {
        if (data.settings[key] != null) strings(data.settings[key], `data.settings.${key}`);
      });
      if (data.settings.vibrateOnRestEnd != null && typeof data.settings.vibrateOnRestEnd !== 'boolean') fail('data.settings.vibrateOnRestEnd');
    }
    if (data.meta != null && object(data.meta, 'data.meta') && data.meta.months != null) {
      array(data.meta.months, 'data.meta.months', (m, path) => { if (!monthOK(m)) fail(path); });
    }
    return problems;
  }

  function wipeAll() {
    assertWritable();
    visibleKeys().forEach(remove);
  }

  /**
   * 导入。
   *  mode='replace' 全量替换；mode='merge' 合并（默认），按 id 去重，
   *  已存在的不覆盖（除非 overwrite=true），日程取并集。
   */
  function importAll(payload, opts = {}) {
    if (!payload || payload.format !== EXPORT_FORMAT) {
      throw new Error('不是本 App 导出的备份文件');
    }
    if (Number(payload.version) > SCHEMA_VERSION) {
      throw new Error(`备份来自更新的版本（v${payload.version}），请先升级 App`);
    }
    assertWritable();
    if (!Number.isSafeInteger(payload.version) || payload.version < 1) {
      throw new Error('备份版本无效');
    }
    const data = payload.data;
    const mode = opts.mode || 'merge';
    if (!['merge', 'replace'].includes(mode)) throw new Error('导入模式无效');
    const overwrite = !!opts.overwrite;
    const summary = { plans: 0, sessions: 0, days: 0, ongoing: 0, mode };

    // ⚠ 结构自检必须在清空之前：备份结构不对就趁数据还在直接报错，
    // 别先 wipeAll() 再抛错 —— 那样用户只看到一句"导入失败"，数据却真的没了。
    const problems = validatePayload(data);
    if (problems.length) {
      throw new Error('备份文件结构不正确：' + problems.join('；'));
    }

    if (mode === 'replace') return replaceAll(data, opts);

    {
      // 计划
      const plans = listPlans();
      (data.plans || []).forEach((p) => {
        const idx = plans.findIndex((x) => x.id === p.id);
        if (idx >= 0) { if (overwrite) { plans[idx] = p; summary.plans += 1; } }
        else { plans.push(p); summary.plans += 1; }
      });
      writeJson(K.plans, plans);

      // 设置：新库（还没有任何偏好）以备份为准；已有偏好的库则以当前为准，
      // 免得恢复备份把现在的偏好冲回旧值
      const curSettings = readJson(K.settings, {});
      const hasCurSettings = Object.keys(curSettings).length > 0;
      const mergedSettings = (mode === 'replace' || !hasCurSettings)
        ? { ...(data.settings || {}) }
        : { ...(data.settings || {}), ...curSettings };
      writeJson(K.settings, mergedSettings);

      // 会话
      const months = new Set(listMonths());
      Object.keys(data.sessions || {}).forEach((month) => {
        const buckets = sessionsInMonth(month);
        const seen = new Set(buckets.map((s) => s.id));
        (data.sessions[month] || []).forEach((s) => {
          if (seen.has(s.id)) { if (overwrite) { const i = buckets.findIndex((x) => x.id === s.id); buckets[i] = s; summary.sessions += 1; } }
          else { buckets.push(s); seen.add(s.id); summary.sessions += 1; }
        });
        writeJson(K.sessionPrefix + month, buckets);
        months.add(month);
      });

      // meta：months 之外的字段（seeded 等）也要带过来，
      // 否则「导出 → 导入 → 再导出」不恒等，清空过的库导入后示例还会自己长回来。
      const metaIncoming = (data.meta && typeof data.meta === 'object') ? data.meta : {};
      saveMeta({
        ...getMeta(),
        ...metaIncoming,
        schemaVersion: SCHEMA_VERSION,
        months: Array.from(months).sort(),
      });

      // 进行中的训练：替换模式直接恢复；合并模式下已有进行中训练就保留当前的，
      // 不拿备份里的旧会话把正在练的那次覆盖掉。
      const incomingOngoing = (data.ongoing && typeof data.ongoing === 'object') ? data.ongoing : null;
      if (incomingOngoing) {
        const curOngoing = getOngoing();
        if (mode === 'replace' || !curOngoing) {
          writeJson(K.ongoing, incomingOngoing);
          summary.ongoing = 1;
        }
      }

      // 日程：按天并集
      const sched = getSchedule();
      Object.keys(data.schedule || {}).forEach((day) => {
        const incoming = data.schedule[day] || {};
        const cur = sched[day] || { dateKey: day, planned: [], sessions: [], status: '', note: '' };
        const plannedIds = new Set((cur.planned || []).map((p) => p.id));
        (incoming.planned || []).forEach((p) => {
          if (!plannedIds.has(p.id)) { cur.planned = [...(cur.planned || []), p]; plannedIds.add(p.id); }
        });
        const sessionIds = new Set(cur.sessions || []);
        (incoming.sessions || []).forEach((id) => { if (!sessionIds.has(id)) { cur.sessions = [...(cur.sessions || []), id]; sessionIds.add(id); } });
        if (incoming.status === 'done' || cur.status === 'done') cur.status = 'done';
        else if (incoming.status && !cur.status) cur.status = incoming.status;
        if (incoming.note && !cur.note) cur.note = incoming.note;
        sched[day] = cur;
        summary.days += 1;
      });
      saveSchedule(sched);
    }

    return summary;
  }

  /** 简单用量统计，设置页用来提醒"该导出了" */
  function usage() {
    let bytes = 0;
    const keys = [];
    visibleKeys().forEach((key) => {
      const value = readRaw(key);
      if (value != null) { keys.push(key); bytes += value.length; }
    });
    return { keys: keys.length, bytes, sessions: allSessions().length, plans: listPlans().length };
  }

  return {
    getStorageStatus, onStatus,
    // meta
    getMeta, saveMeta, listMonths,
    // settings
    getSettings, saveSettings,
    // 训练类别
    listCategories, rememberCategory, forgetCategory,
    // plans
    listPlans, getPlan, savePlan, deletePlan,
    // schedule
    getSchedule, saveSchedule,
    // sessions
    sessionsInMonth, allSessions, getSession, commitSession, deleteSession,
    // ongoing
    getOngoing, saveOngoing, clearOngoing, finishSession,
    // backup
    exportAll, importAll, wipeAll, usage,
    // 测试/调试用
    _keys: K,
  };
}

/* ------------------------------------------------------------------ 单例 */

let _store = null;

export function initStore(backend) {
  _store = createStore(backend);
  return _store;
}

export function getStore() {
  if (!_store) {
    throw new Error('store 尚未初始化：请先在 main.js 调用 initStore()');
  }
  return _store;
}

/** 空间不足仍保留可读的持久库；只有无法读取存储时才使用临时内存。 */
export function initBrowserStore() {
  let backend;
  try {
    backend = window.localStorage;
    backend.getItem(K.meta);
    void backend.length;
  } catch (e) {
    console.warn('[store] localStorage 不可用，退化为内存存储', e);
    _store = createStore(memoryBackend(), {
      mode: 'memory', warning: '当前无法使用本地存储，数据仅临时保留，关闭后会丢失；请及时导出备份。',
    });
    return _store;
  }
  _store = createStore(backend);
  return _store;
}
