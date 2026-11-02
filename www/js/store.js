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

import { monthKeyOf, deepClone, uid } from './util.js';

export const SCHEMA_VERSION = 1;
export const EXPORT_FORMAT = 'exercise-record';

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

export function createStore(backend) {
  const readJson = (key, fallback) => {
    try {
      const raw = backend.getItem(key);
      if (raw == null || raw === '') return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  };

  const writeJson = (key, value) => {
    try {
      backend.setItem(key, JSON.stringify(value));
    } catch (e) {
      throw new QuotaError('本地存储写入失败（可能空间已满），请尽快在设置里导出备份', e);
    }
  };

  const remove = (key) => { try { backend.removeItem(key); } catch (e) { /* ignore */ } };

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
    if (typeof backend.length === 'number' && typeof backend.key === 'function') {
      for (let i = 0; i < backend.length; i += 1) {
        const k = backend.key(i);
        if (k && k.startsWith(K.sessionPrefix)) {
          const m = k.slice(K.sessionPrefix.length);
          if (m) months.add(m);
        }
      }
    }
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

  /** 当前全部数据的快照（全量替换导入失败时用来回滚） */
  function snapshotAll() {
    const sessions = {};
    listMonths().forEach((m) => { sessions[m] = sessionsInMonth(m); });
    return {
      plans: readJson(K.plans, []),
      schedule: getSchedule(),
      settings: readJson(K.settings, {}),
      meta: getMeta(),
      ongoing: readJson(K.ongoing, null),
      sessions,
    };
  }

  function restoreAll(snap) {
    // 逐项写回，某一项失败不能连累其它项。
    // 写失败恰好说明该项**没被覆盖**（原值还在盘上），那正好不用管。
    const tryWrite = (key, value) => {
      try { writeJson(key, value); } catch (_) { /* 忽略这一项 */ }
    };
    tryWrite(K.plans, snap.plans);
    tryWrite(K.schedule, snap.schedule);
    tryWrite(K.settings, snap.settings);
    tryWrite(K.meta, snap.meta);
    if (snap.ongoing) tryWrite(K.ongoing, snap.ongoing); else remove(K.ongoing);
    Object.keys(snap.sessions || {}).forEach((m) => tryWrite(K.sessionPrefix + m, snap.sessions[m]));
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
    if (data.plans != null && !Array.isArray(data.plans)) problems.push('data.plans 不是数组');
    if (data.schedule != null && (typeof data.schedule !== 'object' || Array.isArray(data.schedule))) {
      problems.push('data.schedule 不是对象');
    }
    if (data.settings != null && (typeof data.settings !== 'object' || Array.isArray(data.settings))) {
      problems.push('data.settings 不是对象');
    }
    if (data.sessions != null) {
      if (typeof data.sessions !== 'object' || Array.isArray(data.sessions)) {
        problems.push('data.sessions 不是对象');
      } else {
        Object.keys(data.sessions).forEach((m) => {
          if (!Array.isArray(data.sessions[m])) problems.push(`data.sessions.${m} 不是数组`);
        });
      }
    }
    if (data.meta != null && (typeof data.meta !== 'object' || Array.isArray(data.meta))) {
      problems.push('data.meta 不是对象');
    }
    if (data.ongoing != null && (typeof data.ongoing !== 'object' || Array.isArray(data.ongoing))) {
      problems.push('data.ongoing 不是对象');
    }
    return problems;
  }

  function wipeAll() {
    remove(K.plans); remove(K.schedule); remove(K.settings);
    remove(K.ongoing); remove(K.meta);
    listMonths().forEach((m) => remove(K.sessionPrefix + m));
    // 兜底：后端支持枚举就全清（防止 meta 丢失导致月份桶变孤儿）
    if (typeof backend.length === 'number' && typeof backend.key === 'function') {
      const keys = [];
      for (let i = 0; i < backend.length; i += 1) {
        const k = backend.key(i);
        if (k && k.startsWith('ex.')) keys.push(k);
      }
      keys.forEach(remove);
    }
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
    const data = payload.data || {};
    const mode = opts.mode || 'merge';
    const overwrite = !!opts.overwrite;
    const summary = { plans: 0, sessions: 0, days: 0, ongoing: 0, mode };

    // ⚠ 结构自检必须在清空之前：备份结构不对就趁数据还在直接报错，
    // 别先 wipeAll() 再抛错 —— 那样用户只看到一句"导入失败"，数据却真的没了。
    const problems = validatePayload(data);
    if (problems.length) {
      throw new Error('备份文件结构不正确：' + problems.join('；'));
    }

    // 全量替换：先拍快照，写入过程中任何一步失败都回滚，绝不留下"清了一半"的库
    const snap = mode === 'replace' ? snapshotAll() : null;
    if (mode === 'replace') wipeAll();

    try {
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
    } catch (e) {
      // 替换模式写失败 → 把原库原样还回去
      if (snap) {
        try { restoreAll(snap); } catch (_) { /* 回滚也失败就只剩原错误了 */ }
      }
      throw e;
    }

    return summary;
  }

  /** 简单用量统计，设置页用来提醒"该导出了" */
  function usage() {
    let bytes = 0;
    const keys = [];
    if (typeof backend.length === 'number' && typeof backend.key === 'function') {
      for (let i = 0; i < backend.length; i += 1) {
        const k = backend.key(i);
        if (k && k.startsWith('ex.')) {
          keys.push(k);
          bytes += (backend.getItem(k) || '').length;
        }
      }
    }
    return { keys: keys.length, bytes, sessions: allSessions().length, plans: listPlans().length };
  }

  return {
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

/** 浏览器环境：优先 localStorage；不可用（隐私模式等）退化到内存，功能不炸只是不持久 */
export function initBrowserStore() {
  let backend;
  try {
    const probe = '__ex_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    backend = window.localStorage;
  } catch (e) {
    console.warn('[store] localStorage 不可用，退化为内存存储（本次数据不会保留）', e);
    backend = memoryBackend();
  }
  return initStore(backend);
}
