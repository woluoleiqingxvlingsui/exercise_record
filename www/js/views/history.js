/**
 * views/history.js —— 训练记录 / 反馈 / 统计。
 *
 * 反馈是需求里明确要的：练完记录当日感受，方便回过头调整安排。
 * 统计只用 CSS 画柱状图（零依赖、跟卡通风格更搭）；
 * www/chart.umd.js 已经备着，日后要更复杂的图可以直接用。
 */

import {
  localDateKey, monthKeyOf, fmtClock, fmtRest, fmtLong,
  periodRange, periodLabel, periodBuckets, shiftPeriod,
} from '../util.js';
import { summarizeSession } from '../model.js';
import {
  esc, icon, mascot, emptyState, openSheet, closeSheet, confirmSheet, toast,
  categoryLabel, categoryClass,
} from '../ui.js';

/* ------------------------------------------------------------------ 统计 */

/**
 * 组序显示（"第 2/4 组"里的那个 "2/4"）。
 *
 * 这两个数字来自存储里的记录，理论上就是数字；但备份可以是从别处粘来的 JSON，
 * 里面塞什么都有可能。所以这里先转成数字（不让字符串参与 + 运算），
 * 再过 esc —— 拼进 innerHTML 的动态内容必须转义，
 * 否则一个 `"setIndex":"<img src=x onerror=…>"` 就能在 App 上下文里执行脚本。
 */
function setNo(e) {
  const i = Number(e && e.setIndex);
  const t = Number(e && e.setTotal);
  const a = Number.isFinite(i) ? String(i + 1) : '?';
  const b = Number.isFinite(t) ? String(t) : '?';
  return `${esc(a)}/${esc(b)}`;
}

/**
 * 统计页：按 周 / 月 / 年 三种粒度看训练时长，并且能前后翻着看不同周、月、年。
 *
 * **时长口径 = 用户自己记的时长**（session.loggedSec，在训练结束后的面板里填，
 * 补记时也填）；没记过才回落到 App 的自动计时。
 * 原因很实际：正式组是按容量控制时间的、有氧在 Keep 之类的软件里计时，
 * App 秒表从点开始到点结束算出来的流逝时间，并不等于真实的训练时间。
 */
export function renderStats(container, ctx) {
  const { store } = ctx;
  let gran = 'week';            // week | month | year
  let anchor = localDateKey();  // 当前查看周期的锚点日期

  // 一条记录的时长（毫秒）：用户记的优先
  const msOf = (s) => {
    const sm = summarizeSession(s);
    return sm.durationMs;
  };

  const paint = () => {
    const { start, end } = periodRange(gran, anchor);
    const list = store.allSessions()
      .filter((s) => {
        // 归期一律用 dateKey（会话创建时就定下的那天）。
        // 以前用 localDateKey(startedAt)：设备换了时区、或者导入了别处导出的备份，
        // 同一条记录会被算到前一天，日历（用 dateKey）却还在当天 —— 两边对不上。
        const k = s.dateKey || localDateKey(s.startedAt || 0);
        return k >= start && k <= end;
      })
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

    const totalMs = list.reduce((t, s) => t + msOf(s), 0);

    // 按训练类别聚合（类别由用户自己命名，所以这里是动态分组）
    const byCat = new Map();
    list.forEach((s) => {
      const label = categoryLabel(s.planSnapshot && s.planSnapshot.category);
      const cur = byCat.get(label) || { label, count: 0, ms: 0 };
      cur.count += 1;
      cur.ms += msOf(s);
      byCat.set(label, cur);
    });
    const cats = Array.from(byCat.values()).sort((a, b) => b.ms - a.ms);

    // 按桶聚合：年的桶是"月"，周/月的桶是"天"
    const buckets = periodBuckets(gran, anchor);
    const byMonth = !!(buckets[0] && buckets[0].isMonth);
    const acc = new Map();
    list.forEach((s) => {
      const day = s.dateKey || localDateKey(s.startedAt || 0);
      const key = byMonth ? monthKeyOf(day) : day;
      acc.set(key, (acc.get(key) || 0) + Math.round(msOf(s) / 60000));
    });
    const filled = buckets.map((b) => ({ ...b, min: acc.get(b.key) || 0 }));
    const peak = Math.max(30, ...filled.map((b) => b.min));
    const dense = gran === 'month';   // 一个月 28–31 根柱子，要画细一点、标签隔几个才显示

    container.innerHTML = `
      <div class="row" style="gap:8px;margin-bottom:12px">
        ${[['week', '周'], ['month', '月'], ['year', '年']].map(([g, label]) =>
          `<button class="chip ${gran === g ? 'is-on' : ''}" data-gran="${g}">按${label}</button>`).join('')}
      </div>

      <div class="row is-between" style="margin-bottom:10px">
        <button class="chip" data-prev aria-label="上一个">${icon('back', 16)}</button>
        <strong>${esc(periodLabel(gran, anchor))}</strong>
        <button class="chip" data-next aria-label="下一个" style="transform:rotate(180deg)">${icon('back', 16)}</button>
      </div>

      <div class="card-soft stack center">
        <div class="muted">训练总时长</div>
        <div class="num" style="font-size:38px">${esc(fmtLong(totalMs))}</div>
        <div class="muted" style="font-size:11px">按你自己记录的时长统计</div>
        <div class="row" style="justify-content:center;gap:28px;margin-top:8px">
          <div class="center">
            <div class="num" style="font-size:22px">${list.length}</div>
            <div class="muted">次</div>
          </div>
          <div class="center">
            <div class="num" style="font-size:22px">${list.length ? esc(fmtLong(totalMs / list.length)) : '—'}</div>
            <div class="muted">平均每次</div>
          </div>
        </div>
      </div>

      <div class="card-soft stack" style="margin-top:12px">
        <div class="row is-between">
          <strong>${byMonth ? '每月' : '每天'}时长</strong>
          <span class="muted">分钟</span>
        </div>
        <div style="display:flex;align-items:flex-end;gap:${dense ? '2px' : '4px'};height:110px">
          ${filled.map((b, i) => `
            <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;min-width:0">
              <div style="width:100%;height:${Math.round((b.min / peak) * 86)}px;min-height:${b.min ? 4 : 2}px;
                background:${b.min ? 'var(--cardio)' : 'var(--line)'};border-radius:6px 6px 3px 3px"></div>
              <span style="font-size:${dense ? '8px' : '9px'};color:var(--ink-faint)">
                ${(gran !== 'month' || i === 0 || (i + 1) % 5 === 0) ? esc(b.label) : ''}
              </span>
            </div>`).join('')}
        </div>
      </div>

      ${cats.length ? `<div class="card-soft stack" style="margin-top:12px">
        <div class="row is-between"><strong>按类别</strong><span class="muted">时长 · 次数</span></div>
        ${cats.map((c) => `
          <div class="stack" style="gap:4px">
            <div class="row is-between">
              <span>${esc(c.label)}</span>
              <span class="muted">${esc(fmtLong(c.ms))} · ${c.count} 次</span>
            </div>
            <div style="height:8px;background:var(--line);border-radius:99px;overflow:hidden">
              <div style="height:100%;width:${totalMs ? Math.round((c.ms / totalMs) * 100) : 0}%;
                background:${categoryClass(c.label) === 'is-cardio' ? 'var(--cardio)' : 'var(--strength)'};
                border-radius:99px"></div>
            </div>
          </div>`).join('')}
      </div>` : ''}

      <h3 style="margin:16px 0 8px">这个周期的训练</h3>
      ${!list.length ? emptyState('这个周期没有训练记录', '用上面的箭头换个周期看看') : ''}
      <div class="stack">
        ${list.map((s) => {
          const sm = summarizeSession(s);
          const durText = sm.loggedMin == null
            ? `${esc(fmtClock(sm.durationMs))}（自动计时）`
            : `${esc(fmtLong(sm.durationMs))}`;
          return `<div class="card-soft is-flat stack" data-session="${esc(s.id)}">
            <div class="row is-between">
              <strong>${esc(s.planName || (s.planSnapshot && s.planSnapshot.name) || '自由训练')}</strong>
              <span class="muted">${esc(s.dateKey)}</span>
            </div>
            <div class="muted">${sm.isManual ? '' : `${sm.done}/${sm.total} 组 · `}${durText}
              ${sm.reps ? ` · ${sm.reps} 次` : ''}${sm.distanceKm ? ` · ${sm.distanceKm} km` : ''}</div>
            <div class="row" style="gap:6px;flex-wrap:wrap">
              ${sm.isManual ? '<span class="chip is-on">记录</span>' : ''}
              ${s.status !== 'done' ? '<span class="chip">提前结束</span>' : ''}
              ${sm.adjustments ? `<span class="chip">调整 ${sm.adjustments} 次</span>` : ''}
              ${sm.isManual ? '' : (s.feedback ? '<span class="chip is-on">已记感受</span>' : '<span class="chip">未记感受</span>')}
            </div>
          </div>`;
        }).join('')}
      </div>
    `;

    container.querySelectorAll('[data-gran]').forEach((b) => b.addEventListener('click', () => {
      gran = b.dataset.gran;
      anchor = localDateKey();   // 换粒度时回到"现在"，免得停在一个奇怪的周期上
      paint();
    }));
    container.querySelector('[data-prev]').addEventListener('click', () => {
      anchor = shiftPeriod(gran, anchor, -1);
      paint();
    });
    container.querySelector('[data-next]').addEventListener('click', () => {
      anchor = shiftPeriod(gran, anchor, 1);
      paint();
    });
    container.querySelectorAll('[data-session]').forEach((el) => {
      el.addEventListener('click', () => openSessionDetail(store, el.dataset.session, paint));
    });
  };

  paint();
}

/* -------------------------------------------------------------- 会话详情 */

export function openSessionDetail(store, sessionId, onChange) {
  const session = store.getSession(sessionId);
  if (!session) { toast('找不到这条记录'); return; }
  const sm = summarizeSession(session);
  const fb = session.feedback || {};

  const feelOptions = ['精力充沛', '状态一般', '有点疲惫', '睡眠不足'];
  const painParts = ['肩', '肘', '腕', '腰', '膝', '踝'];
  let feel = Array.isArray(fb.feel) ? fb.feel.slice() : [];
  let painPartsSel = (fb.pain && fb.pain.parts) ? fb.pain.parts.slice() : [];
  // RPE 只能是 1..10 的数字：备份里的值不可信（可能是字符串、HTML、甚至 NaN）。
  // 既要限范围，也要转义 —— 这个值直接拼进 innerHTML，
  // 一个 `rpe: "<img src=x onerror=…>"` 就能在 App 上下文里执行脚本。
  const rpeNum = Number(fb.rpe);
  let rpe = Number.isFinite(rpeNum) ? Math.min(10, Math.max(1, Math.round(rpeNum))) : 6;
  // 时长默认预填自动计时的分钟数，用户改成实际练的时间即可（补记本身就是用户填的）
  // 用 sm.loggedMin（那边已经校验过是有限数），别直接拿 session.loggedSec 算 ——
  // 备份里塞个 "abc" 的话这里会算出 NaN，预填进输入框就成了 "NaN"。
  const defaultMin = sm.loggedMin != null
    ? sm.loggedMin
    : Math.max(1, Math.round(sm.elapsedMs / 60000));
  let loggedMin = defaultMin;

  openSheet({
    title: '训练详情',
    body: `
      <div class="stack">
        <div class="card-soft is-flat stack">
          <div class="row is-between">
            <strong>${esc(session.planName || '自由训练')}</strong>
            <span class="chip">${esc(session.dateKey)}</span>
          </div>
          <div class="muted">${sm.isManual
            ? `记录 · ${esc(categoryLabel(session.planSnapshot && session.planSnapshot.category))} · ${esc(fmtLong(sm.durationMs))}`
            : `完成 ${sm.done}/${sm.total} 组 · 计时 ${esc(fmtClock(sm.elapsedMs))} · 休息合计 ${esc(fmtClock(sm.restMs))}`}</div>
          <div class="row" style="gap:6px;flex-wrap:wrap">
            ${sm.reps ? `<span class="chip">${sm.reps} 次</span>` : ''}
            ${sm.volumeKg ? `<span class="chip">容量 ${sm.volumeKg} kg</span>` : ''}
            ${sm.distanceKm ? `<span class="chip">${sm.distanceKm} km</span>` : ''}
            ${sm.adjustments ? `<span class="chip">调整 ${sm.adjustments} 次</span>` : ''}
            ${sm.deviations ? `<span class="chip">偏离 ${sm.deviations} 组</span>` : ''}
          </div>
        </div>

        ${sm.isManual ? '' : `
        <div class="stack">
          <strong>逐组记录</strong>
          ${(session.entries || []).map((e) => `<div class="row is-between card-soft is-flat">
            <span>${esc(e.itemName)} <span class="muted">${setNo(e)}</span></span>
            <span class="muted">${esc(entryActualText(e))} · 歇 ${esc(fmtRest(e.restActualMs))}
              ${e.decision === 'flex' ? ' · 调整' : e.decision === 'auto' ? ' · 自动' : ''}</span>
          </div>`).join('') || '<p class="muted">没有已完成的组</p>'}
        </div>`}

        ${(session.adjustments || []).length ? `<details class="card-soft is-flat">
          <summary style="font-weight:800;cursor:pointer">过程中改了什么（${session.adjustments.length}）</summary>
          <div class="stack" style="margin-top:8px">
            ${session.adjustments.map((a) => `<div class="muted">${esc(adjText(a))}</div>`).join('')}
          </div>
        </details>` : ''}

        <div class="card-soft stack">
          <strong>这次的记录</strong>

          <label class="stack" style="gap:4px">
            <span class="muted">训练时长（分钟）</span>
            <input data-min type="number" inputmode="decimal" min="1" step="1" value="${loggedMin}"
              style="padding:12px;border:2.5px solid var(--line);border-radius:16px;width:100%;font-weight:700">
            <span class="muted" style="font-size:11px;line-height:1.35">
              统计里的时长<b>以这里为准</b>。App 的秒表只记录流逝时间，正式组按容量控制、有氧在别处计时，
              所以填你实际练的时间就好（已预填计时结果，改一下即可）。
            </span>
          </label>

          <strong>今天的感受</strong>

          <label class="stack" style="gap:4px">
            <span class="muted">整体强度 RPE：<span class="num" data-rpe-val>${esc(rpe)}</span> / 10</span>
            <input type="range" min="1" max="10" step="1" value="${esc(rpe)}" data-rpe style="width:100%">
          </label>

          <div class="stack" style="gap:6px">
            <span class="muted">体感</span>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              ${feelOptions.map((f) => `<button class="chip ${feel.includes(f) ? 'is-on' : ''}" data-feel="${esc(f)}">${esc(f)}</button>`).join('')}
            </div>
          </div>

          <div class="stack" style="gap:6px">
            <span class="muted">不适部位</span>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <button class="chip ${painPartsSel.length === 0 ? 'is-on' : ''}" data-pain-none>无</button>
              ${painParts.map((p) => `<button class="chip ${painPartsSel.includes(p) ? 'is-on' : ''}" data-pain="${esc(p)}">${esc(p)}</button>`).join('')}
            </div>
          </div>

          <label class="stack" style="gap:4px">
            <span class="muted">备注</span>
            <textarea data-note rows="2" style="padding:12px;border:2.5px solid var(--line);border-radius:16px;width:100%">${esc(fb.note || '')}</textarea>
          </label>

          <label class="stack" style="gap:4px">
            <span class="muted">下次想调整什么</span>
            <textarea data-next rows="2" style="padding:12px;border:2.5px solid var(--line);border-radius:16px;width:100%">${esc(fb.nextTimeNote || '')}</textarea>
          </label>
        </div>
      </div>`,
    footer: `<div class="stack">
      <button class="btn-sticker is-big is-accent" data-save-fb>保存</button>
      <button class="btn-sticker is-big is-ghost" data-del danger>删除这条记录</button>
    </div>`,
    onMount: ({ $, root }) => {
      $('[data-rpe]').addEventListener('input', (e) => {
        rpe = Number(e.target.value);
        root.querySelector('[data-rpe-val]').textContent = String(rpe);
      });
      root.querySelectorAll('[data-feel]').forEach((b) => b.addEventListener('click', () => {
        const f = b.dataset.feel;
        feel = feel.includes(f) ? feel.filter((x) => x !== f) : [...feel, f];
        b.classList.toggle('is-on', feel.includes(f));
      }));
      root.querySelectorAll('[data-pain]').forEach((b) => b.addEventListener('click', () => {
        const p = b.dataset.pain;
        painPartsSel = painPartsSel.includes(p) ? painPartsSel.filter((x) => x !== p) : [...painPartsSel, p];
        paintPain(root);
      }));
      root.querySelector('[data-pain-none]').addEventListener('click', () => {
        painPartsSel = [];
        paintPain(root);
      });

      $('[data-min]').addEventListener('input', (e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n) && n > 0) loggedMin = n;
      });

      $('[data-save-fb]').addEventListener('click', () => {
        // 时长是这次记录的核心：写回 loggedSec，之后统计一律以它为准
        session.loggedSec = Math.max(0, Math.round(loggedMin * 60));
        session.feedback = {
          rpe,
          feel: feel.slice(),
          pain: { parts: painPartsSel.slice(), note: '' },
          completion: sm.isManual
            ? '记录'
            : (session.entries.length >= session.timeline.length ? '全部完成' : '部分完成'),
          note: $('[data-note]').value,
          nextTimeNote: $('[data-next]').value,
          at: Date.now(),
        };
        store.commitSession(session);
        closeSheet();
        toast('已保存');
        if (onChange) onChange();
      });

      $('[data-del]').addEventListener('click', async () => {
        if (!(await confirmSheet({ title: '删除记录', message: '删除后无法恢复，确定吗？', okText: '删除', danger: true }))) return;
        store.deleteSession(session.id);
        // 日程里也把这天摘掉
        const sched = store.getSchedule();
        const day = sched[session.dateKey];
        if (day) {
          day.sessions = (day.sessions || []).filter((x) => x !== session.id);
          if (!day.sessions.length && !(day.planned || []).length) {
            delete sched[session.dateKey];
          } else if (!day.sessions.length && day.status === 'done') {
            // 记录删光了，这天就不该再显示「已练」——
            // 但还留着安排计划的条目，所以只把状态退回去，别把整天删掉。
            day.status = 'planned';
          }
          store.saveSchedule(sched);
        }
        closeSheet();
        toast('已删除');
        if (onChange) onChange();
      });
    },
  });

  function paintPain(root) {
    root.querySelectorAll('[data-pain]').forEach((b) => b.classList.toggle('is-on', painPartsSel.includes(b.dataset.pain)));
    root.querySelector('[data-pain-none]').classList.toggle('is-on', painPartsSel.length === 0);
  }
}

function entryActualText(e) {
  const a = e.actual || {};
  const parts = [];
  if (a.reps != null) parts.push(`${a.reps} 次`);
  if (a.weightKg) parts.push(`${a.weightKg} kg`);
  if (a.durationS) parts.push(fmtClock(a.durationS * 1000));
  if (a.distanceKm) parts.push(`${a.distanceKm} km`);
  const planned = e.planned || {};
  const pParts = [];
  if (planned.reps != null) pParts.push(`${planned.reps} 次`);
  if (planned.distanceKm != null) pParts.push(`${planned.distanceKm} km`);
  if (!parts.length) return '—';
  return `${parts.join(' ')}${pParts.length && e.deviated ? `（计划 ${pParts.join(' ')}）` : ''}`;
}

function adjText(a) {
  if (a.scope === 'rest') return `间歇 ${fmtRest(a.from)} → ${fmtRest(a.to)}${a.reason ? `（${a.reason}）` : ''}`;
  if (a.scope === 'sets' && a.field === 'setTotal') return `组数 ${a.from} → ${a.to}`;
  if (a.scope === 'sets' && a.field === 'skip') return `跳过：${a.from}${a.reason ? `（${a.reason}）` : ''}`;
  return `${a.scope}.${a.field || ''} ${a.from ?? ''} → ${a.to ?? ''}`;
}
