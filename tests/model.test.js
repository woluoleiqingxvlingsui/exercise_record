import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  expandSets, buildTimeline, effectiveRest, sessionFromPlan, currentStep,
  completeStep, isDeviated, overrideStepRest, addSetToItem, removeStep, gotoStep,
  finishSession, summarizeSession, progress, restOptions, REST_PRESETS_MS,
  emptyDay, upsertDay, addPlanned, removePlanned, setDayStatus,
  manualSession, isManual,
} from '../www/js/model.js';
import { localDateKey } from '../www/js/util.js';

const localDateKeyOf = localDateKey;

/** 一份贴近真实的「引体日」，把五种休息优先级都覆盖到 */
function pullupPlan() {
  return {
    id: 'plan_pullup',
    name: '引体日',
    category: 'strength',
    stages: [
      {
        id: 'st_warm', kind: 'warmup', name: '热身', restAfterStageMs: 120000,
        items: [
          { id: 'it_band', name: '弹力带肩袖', mode: 'reps', defaultRestMs: 45000,
            sets: { repeat: 2, of: { reps: 15 } } },
          { id: 'it_scap', name: '悬垂肩胛', mode: 'reps', defaultRestMs: 45000, restAfterItemMs: 60000,
            sets: { repeat: 2, of: { reps: 8 } } },
        ],
      },
      {
        id: 'st_main', kind: 'main', name: '正式组',
        items: [
          { id: 'it_pull', name: '引体向上', mode: 'reps',
            defaultRestMs: 90000, lastSetRestMs: 150000,
            // 第一组显式指定 120s，后面组按默认
            sets: [{ reps: 8, weightKg: 0, restAfterMs: 120000 }, { reps: 8 }, { reps: 6 }] },
        ],
      },
      {
        id: 'st_cool', kind: 'cooldown', name: '放松',
        items: [
          { id: 'it_hang', name: '悬垂放松', mode: 'duration', defaultRestMs: 30000,
            sets: { repeat: 3, of: { durationS: 20 } } },
        ],
      },
    ],
  };
}

test('expandSets 支持简写 repeat 与逐组数组两种写法', () => {
  assert.equal(expandSets({ sets: { repeat: 3, of: { reps: 8 } } }).length, 3);
  assert.deepEqual(expandSets({ sets: { repeat: 2, of: { reps: 15 } } })[0], { reps: 15 });
  assert.equal(expandSets({ sets: [{ reps: 8 }, { reps: 6 }] }).length, 2);
  assert.equal(expandSets({}).length, 0);
  assert.equal(expandSets({ sets: { repeat: 1, of: {} } }).length, 1);
});

test('buildTimeline 按 阶段→动作→组 摊平，顺序正确', () => {
  const tl = buildTimeline(pullupPlan());
  assert.equal(tl.length, 10);
  assert.deepEqual(tl.map((s) => s.itemName), [
    '弹力带肩袖', '弹力带肩袖', '悬垂肩胛', '悬垂肩胛',
    '引体向上', '引体向上', '引体向上',
    '悬垂放松', '悬垂放松', '悬垂放松',
  ]);
  assert.equal(tl[0].setIndex, 0);
  assert.equal(tl[1].setTotal, 2);
  assert.equal(tl[4].stageKind, 'main');
  assert.equal(tl[4].setTotal, 3);
});

test('组间歇：每个动作一个值，做完每一组（含最后一组）都按它休息', () => {
  const tl = buildTimeline(pullupPlan());
  // 弹力带肩袖外旋：两组都 45s
  assert.equal(tl[0].restPlannedMs, 45000);
  assert.equal(tl[1].restPlannedMs, 45000, '该动作末组之后也是自己的组间歇');
  // 悬垂肩胛：两组都 45s（不再有"换动作过渡"这种层级）
  assert.equal(tl[2].restPlannedMs, 45000);
  assert.equal(tl[3].restPlannedMs, 45000);
  // 引体向上：三组都 90s（不再区分"最后一组后"）
  assert.equal(tl[4].restPlannedMs, 90000);
  assert.equal(tl[5].restPlannedMs, 90000);
  assert.equal(tl[6].restPlannedMs, 90000);
  // 悬垂放松：前两组 30s
  assert.equal(tl[7].restPlannedMs, 30000);
  assert.equal(tl[8].restPlannedMs, 30000);
  // 整份计划的最后一步不休息（后面没内容了，再倒计时没意义）
  assert.equal(tl[9].restPlannedMs, 0);
});

test('已废弃的多级间歇字段即使还留在老数据里，也完全不生效', () => {
  const plan = pullupPlan();
  // 故意把旧字段塞回去：模型必须当它们不存在
  plan.stages[0].restAfterStageMs = 999000;
  plan.stages[1].items[0].lastSetRestMs = 888000;
  plan.stages[1].items[0].restAfterItemMs = 777000;
  plan.stages[1].items[0].sets[0].restAfterMs = 666000;

  const tl = buildTimeline(plan);
  assert.equal(tl[3].restPlannedMs, 45000, '阶段过渡间歇应被忽略');
  assert.equal(tl[4].restPlannedMs, 90000, '每组自己的 restAfterMs 应被忽略');
  assert.equal(tl[6].restPlannedMs, 90000, '「最后一组后」「换动作过渡」应被忽略');
});

test('连续有氧段标记为 continuous（不弹询问、不计组间歇）', () => {
  const plan = {
    id: 'p', name: '有氧', category: 'cardio',
    stages: [{ id: 's', kind: 'main', name: '主课',
      items: [{ id: 'i', name: '主课跑', mode: 'distance', defaultRestMs: 60000,
        sets: { repeat: 1, of: { distanceKm: 6 } } }] }],
  };
  const tl = buildTimeline(plan);
  assert.equal(tl.length, 1);
  assert.equal(tl[0].continuous, true);
});

test('sessionFromPlan 快照隔离：之后改模板不影响历史', () => {
  const plan = pullupPlan();
  const session = sessionFromPlan(plan, new Date(2026, 2, 5, 10).getTime());
  assert.equal(session.dateKey, '2026-03-05');

  plan.stages[1].items[0].name = '改过的名字';
  assert.equal(session.planSnapshot.stages[1].items[0].name, '引体向上');
  assert.equal(session.timeline[4].itemName, '引体向上');
});

test('按计划推进：实际休息 = 计划休息，不算偏离', () => {
  const session = sessionFromPlan(pullupPlan());
  session.cursor = 4;
  const entry = completeStep(session, { reps: 8, weightKg: 0 }, { decision: 'plan' });
  assert.equal(entry.restPlannedMs, 90000);
  assert.equal(entry.restActualMs, 90000);
  assert.equal(entry.decision, 'plan');
  assert.equal(entry.deviated, false);
  assert.equal(session.cursor, 5);
});

test('★ 灵活调整本组间歇：仍保留原计划时长作参考，同时记下实际值', () => {
  const session = sessionFromPlan(pullupPlan());
  session.cursor = 4;                        // 引体第 1 组，该动作的组间歇是 90s
  const step = currentStep(session);
  assert.equal(step.restPlannedMs, 90000);

  const entry = completeStep(session, { reps: 8, weightKg: 0 },
    { restMs: 150000, decision: 'flex' });    // 用户改成 150s

  // 这两条就是需求的核心：原计划必须留着当参考，实际用的是用户选的
  assert.equal(entry.restPlannedMs, 90000, '原计划 90s 必须保留');
  assert.equal(entry.restActualMs, 150000, '实际采用用户选的 150s');
  assert.equal(entry.decision, 'flex');
  assert.equal(entry.deviated, true);
});

test('灵活调整选了和计划一样的时长，仍记为 flex（是用户主动选的）', () => {
  const session = sessionFromPlan(pullupPlan());
  session.cursor = 4;
  const entry = completeStep(session, { reps: 8 }, { restMs: 90000, decision: 'flex' });
  assert.equal(entry.restPlannedMs, 90000);
  assert.equal(entry.restActualMs, 90000);
  assert.equal(entry.decision, 'flex');
  assert.equal(entry.deviated, false, '时长没变就不算偏离');
});

test('overrideStepRest 改本组间歇并留痕，且不动模板原值', () => {
  const session = sessionFromPlan(pullupPlan());
  session.cursor = 4;
  assert.equal(effectiveRest(session.timeline[4]), 90000);
  overrideStepRest(session, 4, 180000, '状态差');
  assert.equal(session.timeline[4].restOverrideMs, 180000);
  assert.equal(session.timeline[4].restPlannedMs, 90000, '模板原值不动');
  assert.equal(effectiveRest(session.timeline[4]), 180000);
  assert.equal(session.adjustments.length, 1);
  assert.equal(session.adjustments[0].from, 90000);
  assert.equal(session.adjustments[0].to, 180000);
  assert.equal(session.adjustments[0].reason, '状态差');

  const entry = completeStep(session, { reps: 8 });
  assert.equal(entry.restPlannedMs, 90000, '原计划仍是参考值');
  assert.equal(entry.restActualMs, 180000);
});

test('isDeviated 能识别次数/重量/距离/休息的出入', () => {
  const base = { planned: { reps: 8 }, actual: { reps: 8 }, restPlannedMs: 90000, restActualMs: 90000 };
  assert.equal(isDeviated(base), false);
  assert.equal(isDeviated({ ...base, actual: { reps: 6 } }), true);
  assert.equal(isDeviated({ ...base, actual: { reps: 8, weightKg: 5 }, planned: { reps: 8, weightKg: 0 } }), true);
  assert.equal(isDeviated({ ...base, restActualMs: 120000 }), true);
});

test('addSetToItem 加一组后 setTotal 同步刷新', () => {
  const session = sessionFromPlan(pullupPlan());
  session.cursor = 4;
  addSetToItem(session, 'it_pull');
  const pull = session.timeline.filter((s) => s.itemId === 'it_pull');
  assert.equal(pull.length, 4);
  assert.deepEqual(pull.map((s) => s.setTotal), [4, 4, 4, 4]);
  assert.deepEqual(pull.map((s) => s.setIndex), [0, 1, 2, 3]);
  assert.equal(session.timeline.length, 11);
  assert.ok(session.adjustments.some((a) => a.scope === 'sets' && a.to === 4));
});

test('removeStep 跳过下一组，且不允许删当前或已完成的步骤', () => {
  const session = sessionFromPlan(pullupPlan());
  session.cursor = 4;
  const gone = removeStep(session, 5, '器械被占');
  assert.equal(gone.itemName, '引体向上');
  assert.equal(session.timeline.length, 9);
  assert.equal(session.timeline.filter((s) => s.itemId === 'it_pull').length, 2);
  // 当前步与已完成步不许删
  assert.equal(removeStep(session, 4), null);
  assert.equal(removeStep(session, 1), null);
});

test('gotoStep 只能跳到合法范围', () => {
  const session = sessionFromPlan(pullupPlan());
  assert.equal(gotoStep(session, 3), true);
  assert.equal(session.cursor, 3);
  assert.equal(gotoStep(session, 999), false);
  assert.equal(gotoStep(session, -1), false);
});

test('progress 与 finishSession', () => {
  const session = sessionFromPlan(pullupPlan(), new Date(2026, 2, 5, 10).getTime());
  completeStep(session, { reps: 15 });
  assert.deepEqual(progress(session), { done: 1, total: 10, ratio: 0.1 });
  finishSession(session, 'done', new Date(2026, 2, 5, 11).getTime());
  assert.equal(session.status, 'done');
  assert.ok(session.endedAt > session.startedAt);
});

test('summarizeSession 汇总容量/时长/偏离/调整次数', () => {
  const session = sessionFromPlan(pullupPlan(), new Date(2026, 2, 5, 10, 0, 0).getTime());
  session.cursor = 4; // 走到正式组：第 1 组计划休息 120s，第 2 组计划 90s
  completeStep(session, { reps: 8, weightKg: 10 }, { at: new Date(2026, 2, 5, 10, 2, 0).getTime() });
  completeStep(session, { reps: 6, weightKg: 10 }, { restMs: 60000, decision: 'flex',
    at: new Date(2026, 2, 5, 10, 4, 0).getTime() });
  finishSession(session, 'done', new Date(2026, 2, 5, 10, 6, 0).getTime());

  const s = summarizeSession(session);
  assert.equal(s.done, 2);
  assert.equal(s.total, 10);
  assert.equal(s.reps, 14);
  assert.equal(s.volumeKg, 140);
  assert.equal(s.restMs, 90000 + 60000);
  assert.equal(s.elapsedMs, 6 * 60000);
  assert.equal(s.deviations, 2); // 两组都与计划有出入（重量/次数）
});

test('训练时长以用户记录的 loggedSec 为准，没记才回落自动计时', () => {
  const session = sessionFromPlan(pullupPlan(), new Date(2026, 2, 5, 10, 0, 0).getTime());
  finishSession(session, 'done', new Date(2026, 2, 5, 10, 6, 0).getTime());

  // 没记时长：统计沿用自动计时，老数据不受影响
  let s = summarizeSession(session);
  assert.equal(s.loggedMin, null);
  assert.equal(s.durationMs, 6 * 60000);

  // 记了时长：统计用记的（哪怕 App 只流逝了 6 分钟，用户练了 75 分钟）
  session.loggedSec = 75 * 60;
  s = summarizeSession(session);
  assert.equal(s.loggedMin, 75);
  assert.equal(s.durationMs, 75 * 60000);
  assert.equal(s.elapsedMs, 6 * 60000, 'elapsedMs 仍表示 App 实际计时的流逝时间');
});

test('补记训练：按计划补记 / 简单记一笔', () => {
  const plan = pullupPlan();

  const byPlan = manualSession({ dateKey: '2026-03-05', plan, loggedSec: 50 * 60 });
  assert.equal(byPlan.status, 'done');
  assert.equal(byPlan.source, 'manual');
  assert.equal(byPlan.planName, plan.name);
  assert.equal(byPlan.loggedSec, 3000);
  assert.equal(byPlan.dateKey, '2026-03-05');
  // 锚在当天中午：统计按 startedAt 归期，不能偏到前后一天
  assert.equal(localDateKeyOf(byPlan.startedAt), '2026-03-05');
  assert.equal(byPlan.timeline.length, 0);
  assert.equal(byPlan.entries.length, 0);
  const ps = summarizeSession(byPlan);
  assert.equal(ps.isManual, true);
  assert.equal(isManual(byPlan), true);
  assert.equal(isManual(sessionFromPlan(plan)), false, '正常跟练的记录不算补记');
  assert.equal(ps.durationMs, 3000 * 1000);
  assert.equal(ps.loggedMin, 50);
  // 类别要留在快照里，否则统计的"按类别"认不出这条
  assert.equal(byPlan.planSnapshot.category, plan.category);

  const quick = manualSession({ dateKey: '2026-03-06', category: '有氧', loggedSec: 30 * 60 });
  assert.equal(quick.planName, '有氧', '没给名字就用类别名当标题');
  assert.equal(quick.planSnapshot.category, '有氧');
  assert.equal(summarizeSession(quick).durationMs, 1800 * 1000);

  // 没给时长也不能是 NaN
  const zero = manualSession({ dateKey: '2026-03-06', category: '有氧' });
  assert.equal(zero.loggedSec, 0);
  assert.equal(summarizeSession(zero).durationMs, 0);
});

test('日程：upsertDay 传 sessionId 会把当天标成 done', () => {
  const sched = {};
  const day = upsertDay(sched, '2026-03-05', { sessionId: 'sess_1' });
  assert.equal(day.status, 'done');
  assert.deepEqual(day.sessions, ['sess_1']);
  // 重复写入不产生重复 id
  upsertDay(sched, '2026-03-05', { sessionId: 'sess_1' });
  assert.deepEqual(sched['2026-03-05'].sessions, ['sess_1']);
});

test('日程：计划条目增删与状态流转', () => {
  const sched = {};
  addPlanned(sched, '2026-03-06', { planId: 'p1', planName: '引体日' });
  assert.equal(sched['2026-03-06'].status, 'planned');
  assert.equal(sched['2026-03-06'].planned.length, 1);

  const id = sched['2026-03-06'].planned[0].id;
  removePlanned(sched, '2026-03-06', id);
  assert.equal(sched['2026-03-06'].planned.length, 0);
  assert.equal(sched['2026-03-06'].status, '', '没有计划也没练过，状态清空');

  setDayStatus(sched, '2026-03-07', 'rest');
  assert.equal(sched['2026-03-07'].status, 'rest');
  assert.deepEqual(emptyDay('2026-03-08'), { dateKey: '2026-03-08', planned: [], sessions: [], status: '', note: '' });
});

test('日程：先计划后完成，状态升级为 done 且保留计划', () => {
  const sched = {};
  addPlanned(sched, '2026-03-09', { planId: 'p1', planName: '引体日' });
  upsertDay(sched, '2026-03-09', { sessionId: 'sess_9' });
  assert.equal(sched['2026-03-09'].status, 'done');
  assert.equal(sched['2026-03-09'].planned.length, 1, '计划条目要留着，便于对照');
  assert.deepEqual(sched['2026-03-09'].sessions, ['sess_9']);
});

test('★ restOptions 一定包含计划值本身（否则灵活调整里看不到"哪一档是计划"）', () => {
  // 45 秒不是预设档位，但它是合法计划值，必须出现在档位里 —— 这是参考基准
  const odd = restOptions(45000);
  assert.ok(odd.includes(45000), '45 秒这种非预设的计划值必须出现在档位里');

  // 计划值恰好等于预设档时不能重复
  const exact = restOptions(90000);
  assert.equal(exact.filter((v) => v === 90000).length, 1, '计划值与预设重合时不能重复');
  assert.deepEqual(exact, [...REST_PRESETS_MS]);

  // 始终升序，便于界面按顺序展示
  assert.deepEqual(odd, [...odd].sort((a, b) => a - b), '档位应按时间升序');

  // 「不休息」也是合法计划值
  assert.ok(restOptions(0).includes(0));
});
