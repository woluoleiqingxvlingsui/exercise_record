/**
 * model.js —— 领域模型与纯逻辑。不碰 DOM、不碰存储，`node --test` 直接可测。
 *
 * 层级：Plan → Stage（热身/正式/放松）→ Item（动作/跑段）→ Set（组）
 * 这套四层结构正好对上需求里的「热身与正式组各自的具体安排 + 二者的组间歇 + 组数」。
 */

import { uid, localDateKey, deepClone, firstNum } from './util.js';

export const STRENGTH = 'strength';
export const CARDIO = 'cardio';

/* ==========================================================================
   1. 计划展开
   ========================================================================== */

/**
 * 展开一个 item 的组定义。
 * 支持两种写法：
 *   sets: [ {...}, {...} ]                      逐组精确（金字塔训练）
 *   sets: { repeat: 3, of: {...} }              简写：3 组相同的
 */
export function expandSets(item) {
  const sets = item && item.sets;
  if (!sets) return [];
  if (Array.isArray(sets)) return sets.map((s) => ({ ...s }));
  const n = Math.max(1, Math.floor(sets.repeat || 1));
  const of = sets.of || {};
  return Array.from({ length: n }, () => ({ ...of }));
}

/**
 * 「一组做完之后歇多久」。
 *
 * **每个动作只有一个「组间歇」**：做完每一组（含该动作的最后一组）都按它休息；
 * 只有整份计划的最后一步是 0（后面没有内容了，再倒计时没意义）。
 *
 * 刻意不做「组间 / 最后一组后 / 换动作过渡 / 阶段过渡」那套多级间歇：
 * 层级一多，用户就得猜到底哪一条在生效 —— 实践中真的踩过
 * 「阶段过渡填了 120 秒，实际一直走 60 秒」这种坑，而且光看界面没人能猜到原因。
 * 个别组想临时改长短，训练中的「灵活调整」当场改即可（走 restOverrideMs）。
 */
function computeRestPlanned(plan, steps, idx) {
  const step = steps[idx];
  const stage = ((plan.stages || [])[step.stageIndex]) || {};
  const item = ((stage.items || [])[step.itemIndex]) || {};

  if (idx >= steps.length - 1) return 0;
  return firstNum(item.defaultRestMs, 90_000);
}

/**
 * 把计划摊平成有序步骤列表，供训练播放器逐步推进。
 * 每个步骤带 restPlannedMs（模板原值）与 restOverrideMs（本次训练里用户现改的）。
 */
export function buildTimeline(plan) {
  const steps = [];
  const stages = (plan && plan.stages) || [];

  stages.forEach((stage, si) => {
    const items = stage.items || [];
    items.forEach((item, ii) => {
      const specs = expandSets(item);
      specs.forEach((spec, ki) => {
        steps.push({
          id: uid('step'),
          stageIndex: si,
          stageKind: stage.kind || 'main',
          stageName: stage.name || '',
          itemIndex: ii,
          itemId: item.id || `item_${si}_${ii}`,
          itemName: item.name || '',
          mode: item.mode || 'reps',
          setIndex: ki,
          setTotal: specs.length,
          spec: { ...spec },
          // 连续型（有氧慢跑/长距离）只正计时，不弹询问、不计组间歇
          continuous: item.mode === 'distance' || item.mode === 'duration',
          restPlannedMs: 0,
          restOverrideMs: null,
        });
      });
    });
  });

  steps.forEach((s, i) => { s.restPlannedMs = computeRestPlanned(plan, steps, i); });
  return steps;
}

/** 该步骤实际采用的休息时长：用户现改的优先 */
export function effectiveRest(step) {
  if (!step) return 0;
  return step.restOverrideMs != null ? step.restOverrideMs : step.restPlannedMs;
}

/** 灵活调整面板的常用档位 */
export const REST_PRESETS_MS = [30000, 60000, 90000, 120000, 150000, 180000, 240000];

/**
 * 灵活调整可选的间歇档位 = 预设档 ∪ {计划值}。
 *
 * 计划值**必须**在列表里：计划可以是 45 秒这种非预设值，如果只给固定档位，
 * 用户就看不到哪一档代表"原计划"，等于把参照基准弄丢了 —— 而这个面板的全部意义
 * 就是"拿计划当参考、再决定改不改"。
 */
export function restOptions(plannedMs, presets = REST_PRESETS_MS) {
  const plan = Math.max(0, Math.round(plannedMs || 0));
  return Array.from(new Set([...presets, plan])).sort((a, b) => a - b);
}

/* ==========================================================================
   2. 会话
   ========================================================================== */

export function sessionFromPlan(plan, startedAt = Date.now()) {
  return {
    id: uid('sess'),
    dateKey: localDateKey(startedAt),
    planId: plan.id || '',
    planName: plan.name || '',
    // 快照：之后改模板不会污染历史记录
    planSnapshot: deepClone(plan),
    startedAt,
    endedAt: 0,
    status: 'ongoing',
    cursor: 0,
    timeline: buildTimeline(plan),
    entries: [],
    adjustments: [],
    feedback: null,
  };
}

export function currentStep(session) {
  if (!session) return null;
  return session.timeline[session.cursor] || null;
}

export function isLastStep(session) {
  return !session || session.cursor >= session.timeline.length;
}

/**
 * 补记一条训练记录（没在 App 里跟着练完，但确实练了）。
 *
 * 为什么要有它：现实里大量训练是在 App 之外完成的 —— 按着计划练了但没走播放器，
 * 或者只是在外面跑了 30 分钟有氧。以前想把这件事记进统计，只能把计划里的组挨个
 * 点一遍「完成/跳过」，既麻烦又会把"没记录的组"变成假的偏离。补记只落一条**事实**：
 * 哪天、什么类别、练了多久。
 *
 * 两种用法：
 *   manualSession({ dateKey, plan })                  —— 按计划补记（知道今天练了哪套）
 *   manualSession({ dateKey, category, name, ... })  —— 简单记一笔（例如「有氧 30 分钟」）
 */
export function manualSession({ dateKey, category = '', name = '', plan = null, loggedSec = 0 }) {
  // 日期键非法时不能让它变成 NaN：NaN 存进 JSON 会变成 null，
  // 之后统计按 startedAt 归期就会掉出所有区间，记录凭空消失。
  const key = /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || '')) ? dateKey : localDateKey();
  const label = name || (plan ? plan.name : category || '训练');
  // 锚在当天中午：统计页按 startedAt 归期，正午不会因为时区/夏令时偏到前后一天
  const parsed = new Date(`${key}T12:00:00`).getTime();
  const at = Number.isFinite(parsed) ? parsed : Date.now();
  return {
    id: uid('sess'),
    dateKey: key,
    planId: plan ? (plan.id || '') : '',
    planName: label,
    // 补记也留快照：至少要保住「类别」，否则统计里的"按类别"认不出这条
    planSnapshot: plan ? deepClone(plan) : { name: label, category, stages: [] },
    startedAt: at,
    endedAt: at,
    status: 'done',
    source: 'manual',
    /** 用户记的时长（秒）。统计一律以它为准，没有才回落到自动计时 */
    loggedSec: Math.max(0, Math.round(Number(loggedSec) || 0)),
    cursor: 0,
    timeline: [],
    entries: [],
    adjustments: [],
    feedback: null,
  };
}

/** 是不是补记的记录（界面据此换个说法，不必展示"逐组记录"） */
export function isManual(session) {
  return !!(session && session.source === 'manual');
}

export function progress(session) {
  const total = (session && session.timeline.length) || 0;
  const done = (session && session.entries.length) || 0;
  return { done, total, ratio: total ? Math.min(1, done / total) : 0 };
}

/**
 * 完成当前步骤并记录实际完成情况。
 * opts.restMs   —— 本次实际采用的休息时长（灵活调整时传入）
 * opts.decision —— 'plan' | 'flex' | 'auto'
 */
export function completeStep(session, actual = {}, opts = {}) {
  const step = currentStep(session);
  if (!step) return null;

  const plannedRest = step.restPlannedMs;
  const override = opts.restMs != null ? opts.restMs : step.restOverrideMs;
  const restActualMs = override != null ? override : plannedRest;

  const entry = {
    stepId: step.id,
    stageKind: step.stageKind,
    itemName: step.itemName,
    setIndex: step.setIndex,
    setTotal: step.setTotal,
    planned: deepClone(step.spec),
    actual: { ...actual },
    restPlannedMs: plannedRest,
    restActualMs,
    decision: opts.decision || (override != null && override !== plannedRest ? 'flex' : 'plan'),
    completedAt: opts.at != null ? opts.at : Date.now(),
  };
  entry.deviated = isDeviated(entry);

  session.entries.push(entry);
  session.cursor += 1;
  return entry;
}

/** 实际与计划有出入即算「偏离」，便于日后回看「今天哪里没按计划来」 */
export function isDeviated(entry) {
  // 自动推进的组：用户根本没机会填实际值（actual 是空的），
  // 拿它跟计划比必然"有出入" —— 那不是偏离，是没填。
  if (entry && entry.decision === 'auto') return false;
  const p = entry.planned || {};
  const a = entry.actual || {};
  const diff = (x, y) => {
    if (x == null && y == null) return false;
    return Number(x || 0) !== Number(y || 0);
  };
  if (diff(p.reps, a.reps)) return true;
  if (diff(p.weightKg, a.weightKg)) return true;
  if (diff(p.durationS, a.durationS)) return true;
  if (diff(p.distanceKm, a.distanceKm)) return true;
  if (diff(p.paceSPerKm, a.paceSPerKm)) return true;
  if (entry.restPlannedMs !== entry.restActualMs) return true;
  return false;
}

export function recordAdjustment(session, adj) {
  if (!session) return null;
  const rec = { at: adj.at != null ? adj.at : Date.now(), ...adj };
  session.adjustments.push(rec);
  return rec;
}

/** 本组间歇改成 restMs（只影响这一步），并留痕 */
export function overrideStepRest(session, index, restMs, reason = '') {
  const step = session.timeline[index];
  if (!step) return null;
  const before = effectiveRest(step);
  step.restOverrideMs = restMs;
  recordAdjustment(session, {
    scope: 'rest', stepId: step.id, field: 'restMs', from: before, to: restMs, reason,
  });
  return step;
}

/** 重新计算每个 item 的组序与后续休息（增删组之后调用） */
function regroup(session) {
  const groups = new Map();
  session.timeline.forEach((s) => {
    const k = `${s.stageIndex}::${s.itemId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  });
  groups.forEach((list) => {
    list.forEach((s, i) => { s.setIndex = i; s.setTotal = list.length; });
  });
  session.timeline.forEach((step, idx) => {
    step.restPlannedMs = computeRestPlanned(session.planSnapshot, session.timeline, idx);
  });
}

/** 给某动作加一组（插在该动作最后一组之后） */
export function addSetToItem(session, itemId) {
  const idxs = session.timeline
    .map((s, i) => (s.itemId === itemId ? i : -1))
    .filter((i) => i >= 0);
  if (!idxs.length) return null;
  const lastIdx = idxs[idxs.length - 1];
  const copy = deepClone(session.timeline[lastIdx]);
  copy.id = uid('step');
  copy.restOverrideMs = null;   // 新组不继承旧组的临时改动
  session.timeline.splice(lastIdx + 1, 0, copy);
  const before = idxs.length;
  regroup(session);
  recordAdjustment(session, {
    scope: 'sets', itemId, field: 'setTotal', from: before, to: before + 1,
  });
  return copy;
}

/** 删掉某一步（跳过下一组 / 减一组）。不允许删已完成或当前步。 */
export function removeStep(session, index, reason = '') {
  if (index <= session.cursor || index >= session.timeline.length) return null;
  const [gone] = session.timeline.splice(index, 1);
  regroup(session);
  recordAdjustment(session, {
    scope: 'sets', stepId: gone.id, itemId: gone.itemId,
    field: 'skip', from: `${gone.itemName} 第${gone.setIndex + 1}组`, to: '', reason,
  });
  return gone;
}

/**
 * 跳过**当前**这一组（训练主界面的「跳过这一组」按钮）。
 *
 * 与 removeStep 的区别：removeStep 拒绝删掉当前步和已完成的步
 * （index <= cursor 一律返回 null），它只服务于"跳过后面的组"。
 * 跳当前组是另一回事 —— 这一组用户确实没做，要从时间线里摘掉，
 * 游标停在同一位置（也就是自动落到下一组）。
 *
 * 之前界面上那个按钮直接调 removeStep(session, session.cursor)，
 * 拿到 null 却不检查，界面照样弹「已跳过本组」——
 * 实际什么都没发生，用户被卡在同一组反复点。
 */
export function skipCurrentStep(session, reason = '') {
  if (!session) return null;
  const idx = session.cursor;
  if (idx < 0 || idx >= session.timeline.length) return null;
  const [gone] = session.timeline.splice(idx, 1);
  // 组序与后续间歇要重算（少了一组，后面的编号和休息都要跟着走）
  regroup(session);
  recordAdjustment(session, {
    scope: 'sets', stepId: gone.id, itemId: gone.itemId,
    field: 'skip', from: `${gone.itemName} 第${gone.setIndex + 1}组`, to: '', reason,
  });
  return gone;
}

/** 跳到时间线里的某一步（**只能往前跳**）。
 *
 * 往回跳会让同一组被 completeStep 记两次（reps/容量/偏离组数重复计，
 * completionRate 甚至能超过 1），所以这里明确挡住回跳。
 */
export function gotoStep(session, index) {
  if (!session || index < session.cursor || index >= session.timeline.length) return false;
  const before = session.cursor;
  session.cursor = index;
  recordAdjustment(session, { scope: 'cursor', field: 'cursor', from: before, to: index });
  return true;
}

export function finishSession(session, status = 'done', at = Date.now()) {
  session.status = status;
  session.endedAt = at;
  return session;
}

/**
 * 会话小结：完成度、总容量、总时长、休息总时长、偏离与调整次数
 *
 * **durationMs 才是对外的"训练时长"**：优先用用户自己记的 loggedSec
 * （正式组按容量控制、有氧在 Keep 上计时，都不该由 App 的秒表说了算），
 * 没有记录过才回落到 startedAt→endedAt 的自动计时。
 * elapsedMs 保留为"App 实际计时的流逝时间"，两者含义不同，别混用。
 */
export function summarizeSession(session) {
  const entries = (session && session.entries) || [];
  const total = (session && session.timeline ? session.timeline.length : 0);
  let reps = 0, volumeKg = 0, distanceKm = 0, durationS = 0, restMs = 0;

  entries.forEach((e) => {
    const a = e.actual || {};
    const r = Number(a.reps) || 0;
    reps += r;
    if (a.weightKg != null) volumeKg += (Number(a.weightKg) || 0) * r;
    distanceKm += Number(a.distanceKm) || 0;
    durationS += Number(a.durationS) || 0;
    restMs += Number(e.restActualMs) || 0;
  });

  const endedAt = session && session.endedAt ? session.endedAt : Date.now();
  const startedAt = (session && session.startedAt) || endedAt;
  const elapsedMs = Math.max(0, endedAt - startedAt);
  // 用户记录的时长：必须是有限非负数。
  // 导入的备份里 loggedSec 可能是 "abc" 或 NaN —— 放行的话 durationMs 就是 NaN，
  // 统计页 reduce 一次就变成 NaN，整个周期的总时长一起废掉。
  const rawLogged = session && session.loggedSec != null ? Number(session.loggedSec) : null;
  const loggedSec = (rawLogged != null && Number.isFinite(rawLogged) && rawLogged >= 0) ? rawLogged : null;

  return {
    done: entries.length,
    total,
    reps,
    volumeKg: Math.round(volumeKg * 10) / 10,
    distanceKm: Math.round(distanceKm * 100) / 100,
    durationS,
    restMs,
    elapsedMs,
    /** 用户记录的时长（分钟），没记过就是 null */
    loggedMin: loggedSec == null ? null : Math.round(loggedSec / 60),
    /** 统计口径的训练时长：用户记录的优先 */
    durationMs: loggedSec == null ? elapsedMs : Math.max(0, loggedSec * 1000),
    isManual: isManual(session),
    deviations: entries.filter((e) => e.deviated).length,
    adjustments: ((session && session.adjustments) || []).length,
    completionRate: total ? entries.length / total : 0,
  };
}

/* ==========================================================================
   3. 训练日程（日历）
   ========================================================================== */

export function emptyDay(dateKey) {
  return { dateKey, planned: [], sessions: [], status: '', note: '' };
}

/**
 * 写入某天。传 sessionId 表示"这天练了"，会自动把状态置为 done。
 * status: '' | 'planned' | 'done' | 'skipped' | 'rest'
 */
export function upsertDay(schedule, dateKey, patch = {}) {
  const { sessionId, ...rest } = patch;
  const cur = schedule[dateKey] || emptyDay(dateKey);
  const next = { ...cur, ...rest };
  next.planned = Array.isArray(next.planned) ? next.planned : [];
  next.sessions = Array.isArray(next.sessions) ? next.sessions : [];

  if (sessionId) {
    if (!next.sessions.includes(sessionId)) next.sessions.push(sessionId);
    if (next.status !== 'skipped') next.status = 'done';
  }
  schedule[dateKey] = next;
  return next;
}

export function addPlanned(schedule, dateKey, planned) {
  const day = schedule[dateKey] || emptyDay(dateKey);
  day.planned = [...(day.planned || []), { id: uid('pl'), ...planned }];
  if (!day.status || day.status === 'rest') day.status = 'planned';
  schedule[dateKey] = day;
  return day;
}

export function removePlanned(schedule, dateKey, plannedId) {
  const day = schedule[dateKey];
  if (!day) return null;
  day.planned = (day.planned || []).filter((p) => p.id !== plannedId);
  if (!day.planned.length && day.status === 'planned') {
    day.status = day.sessions.length ? 'done' : '';
  }
  return day;
}

export function setDayStatus(schedule, dateKey, status) {
  const day = schedule[dateKey] || emptyDay(dateKey);
  day.status = status;
  schedule[dateKey] = day;
  return day;
}
