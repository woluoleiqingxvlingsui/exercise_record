import { test } from 'node:test';
import assert from 'node:assert/strict';

import { seedPlans, shouldSeed } from '../www/js/seed.js';
import { buildTimeline, expandSets } from '../www/js/model.js';

test('内置示例包含力量与有氧各若干，结构完整', () => {
  const plans = seedPlans();
  assert.ok(plans.length >= 5, '至少覆盖引体/卧推 + 三种有氧');

  const cats = new Set(plans.map((p) => p.category));
  assert.ok(cats.has('strength'));
  assert.ok(cats.has('cardio'));

  plans.forEach((p) => {
    assert.ok(p.id && p.name, '计划要有 id 和名字');
    assert.ok(['strength', 'cardio'].includes(p.category), `${p.name} 类别合法`);
    assert.ok(Array.isArray(p.stages) && p.stages.length, `${p.name} 至少一个阶段`);
    p.stages.forEach((st) => {
      assert.ok(['warmup', 'main', 'cooldown'].includes(st.kind), `${p.name} 阶段类型合法`);
      assert.ok(Array.isArray(st.items) && st.items.length, `${p.name}/${st.name} 至少一个动作`);
      st.items.forEach((it) => {
        assert.ok(it.name, `${p.name} 动作要有名字`);
        assert.ok(['reps', 'duration', 'distance'].includes(it.mode), `${it.name} 模式合法`);
        assert.ok(expandSets(it).length > 0, `${it.name} 至少一组`);
      });
    });
  });
});

test('每个示例计划都能成功摊平成时间线，且没有 0 组的空计划', () => {
  seedPlans().forEach((p) => {
    const tl = buildTimeline(p);
    assert.ok(tl.length > 0, `${p.name} 时间线非空`);
    tl.forEach((s) => {
      assert.ok(s.itemName, '每步都有动作名');
      assert.ok(s.restPlannedMs >= 0, '间歇不能为负');
      assert.ok(s.setTotal >= 1);
      assert.ok(s.setIndex >= 0 && s.setIndex < s.setTotal, '组序号在范围内');
    });
  });
});

test('示例里的 id 全局唯一（重复 id 会让编辑和删除指错对象）', () => {
  const ids = [];
  seedPlans().forEach((p) => {
    ids.push(p.id);
    p.stages.forEach((st) => {
      ids.push(st.id);
      st.items.forEach((it) => ids.push(it.id));
    });
  });
  const uniq = new Set(ids);
  assert.equal(uniq.size, ids.length, '存在重复 id');
});

test('引体日展开成 10 组，且热身/正式/放松齐全', () => {
  const plan = seedPlans().find((p) => p.name === '引体日');
  const tl = buildTimeline(plan);
  assert.equal(tl.length, 10);
  assert.equal(tl[0].stageKind, 'warmup');
  assert.equal(tl[4].stageKind, 'main');
  assert.equal(tl[7].stageKind, 'cooldown');
  assert.equal(tl[4].itemName, '引体向上');
  assert.equal(tl[9].restPlannedMs, 0, '计划最后一步不休息');
});

test('built-in 有氧间歇计划有组间歇，长距离跑是连续段', () => {
  const interval = seedPlans().find((p) => p.name.includes('强度跑'));
  const tlInterval = buildTimeline(interval);
  const reps = tlInterval.filter((s) => s.itemName === '1000m 间歇');
  assert.equal(reps.length, 4);
  assert.ok(reps[0].restPlannedMs >= 60000, '间歇跑要有组间歇');
  assert.equal(reps[0].continuous, true, '跑段属于连续型（只正计时，不弹询问）');

  const long = seedPlans().find((p) => p.name === '长距离跑');
  const tlLong = buildTimeline(long);
  assert.ok(tlLong.every((s) => s.continuous), '长距离跑全是连续段');
});

test('shouldSeed 只在完全没有计划时为真', () => {
  assert.equal(shouldSeed([]), true);
  assert.equal(shouldSeed(undefined), true);
  assert.equal(shouldSeed([{ id: 'x' }]), false);
});
