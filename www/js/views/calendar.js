/**
 * views/calendar.js —— 训练日程（日历）。
 *
 * 需求：能直观看到哪天练了什么，方便安排计划；训练记录由 App 自动写入，
 * 同时允许用户自己改（加计划、标休息日、删条目）。
 *
 * 交互参考小米日历的月视图：
 *   · 折叠态（默认）—— 每格只在日期下方点一个**同色**圆点，只回答"这天练没练"，
 *     不再按类别分色（类别是用户自由命名的，维护一张调色板不值当）。
 *   · 展开态 —— 在网格上**向下滑**就展开，每天格子下面直接列出当天练了什么；
 *     再向上滑收起。展开/收起**只有手势**，没有按钮（需求明确要的就是这个）。
 */

import { localDateKey, monthKeyOf, addMonths, daysInMonth, firstWeekdayOfMonth, fmtClock, fmtLong } from '../util.js';
import {
  summarizeSession, manualSession, upsertDay, emptyDay, addPlanned, removePlanned, setDayStatus,
} from '../model.js';
import { esc, icon, openSheet, closeSheet, toast, categoryLabel } from '../ui.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];

/** 一格里最多摆几条，超出的折成「还有 N 条」——摆满会把月视图撑得没法看 */
const MAX_CHIPS = 2;

/**
 * 这条记录算不算「真练过」。
 *
 * 有完成的组、或本身就是补记的（source='manual'）才算；
 * 一组都没做完就「结束并保存」留下的空壳不算 ——
 * 让它在日历上显示成实心圆点的话，用户会以为那天练了，其实没有。
 */
function isRealTraining(s) {
  if (!s) return false;
  if (s.source === 'manual') return true;
  return ((s.entries || []).length || 0) > 0;
}

/* ---------------------------------------------------------------- 手势参数 */
/** 展开态每格的高度：要装得下日期 + 两行条目（详见 openRowFor 的说明） */
const OPEN_ROW = 80;
/** 手指拖这么远（px）算完全展开：太小一碰就展开，太大又像推不动 */
const DRAG_FULL = 120;
/** 超过 100% 之后的阻尼，做出"拉不动了"的橡皮筋感 */
const RUBBER = 0.45;
/** 松手时的速度阀（px/ms）：快速轻扫就算没拖够也该生效 */
const FLICK_V = 0.55;
/** 拖过一半才把条目放出来，避免半路"啪"地冒出一堆字 */
const REVEAL_AT = 0.55;

/**
 * 展开状态记住：切一下 Tab 再回来不该被重置成折叠。
 * 只存在内存里 —— 不写进设置，退出 App 就恢复默认，不打扰用户。
 */
let rememberedOpen = false;

export function renderCalendar(container, ctx) {
  const { store } = ctx;
  let month = monthKeyOf(localDateKey());
  let selected = localDateKey();
  let open = rememberedOpen;   // 是否展开（显示当天具体练了什么）
  let swallowUntil = 0;        // 手势结束后这段时间内的点击要吞掉（避免误选某天）

  const paint = () => {
    const sched = store.getSchedule();
    const sessions = store.allSessions();
    const byDate = new Map();
    sessions.forEach((s) => {
      if (!byDate.has(s.dateKey)) byDate.set(s.dateKey, []);
      byDate.get(s.dateKey).push(s);
    });

    /**
     * 翻到别的月份时，选中日也得跟着走。
     * 以前只改 month 不改 selected：网格已经是 12 月了，下面那块还写着 11 月 2 日。
     */
    const goMonth = (delta) => {
      month = addMonths(month, delta);
      const d = Number(String(selected).slice(8, 10));
      const max = daysInMonth(month);
      const day = Math.min(Number.isFinite(d) && d > 0 ? d : 1, max);
      selected = `${month}-${day < 10 ? '0' + day : day}`;
      paint();
    };

    const total = daysInMonth(month);
    const lead = firstWeekdayOfMonth(month);
    const today = localDateKey();

    const cells = [];
    for (let i = 0; i < lead; i += 1) cells.push('<div></div>');
    for (let d = 1; d <= total; d += 1) {
      const key = `${month}-${d < 10 ? '0' + d : d}`;
      const day = sched[key];
      const list = byDate.get(key) || [];
      const entries = dayEntries(list, day);
      // 「已练」= 当天真有练过的内容。
      // 一组都没做完就「结束并保存」留下的空记录不算 ——
      // 否则日历上会出现实心圆点、日程显示「已练」，可那天其实什么也没练。
      const done = list.some(isRealTraining);
      const markClass = done ? '' : entries.length ? 'is-plan' : 'is-none';
      const isToday = key === today;
      const isSel = key === selected;

      // 展开后每格只有固定的 2 行位置：超出的折成 "+N" 药丸，
      // 而不是再堆一行"还有 N 条"——那会把格子撑爆、字挤成一团。
      const extra = Math.max(0, entries.length - MAX_CHIPS);
      const visible = entries.slice(0, extra ? MAX_CHIPS - 1 : MAX_CHIPS);
      const chips = visible.map((e) =>
        `<span class="cal-ev ${e.kind === 'plan' ? 'is-plan' : ''}">${esc(e.label)}</span>`).join('')
        + (extra ? `<span class="cal-more">+${extra}</span>` : '');

      cells.push(`<button class="cal-cell ${isSel ? 'is-sel' : ''} ${isToday ? 'is-today' : ''}" data-day="${key}">
        <span class="d">${d}</span>
        <span class="cal-mark ${markClass}"></span>
        ${day && day.status === 'rest' ? '<span class="cal-rest">休</span>' : ''}
        <span class="cal-events">${chips}</span>
      </button>`);
    }

    container.innerHTML = `
      <div class="row is-between" style="margin-bottom:12px">
        <button class="chip" data-prev>${icon('back', 16)}</button>
        <h3>${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月</h3>
        <button class="chip" data-next style="transform:rotate(180deg)">${icon('back', 16)}</button>
      </div>
      <div class="card-soft cal">
        <div class="cal-head">
          ${WD.map((w) => `<div class="center muted" style="font-size:12px">${w}</div>`).join('')}
        </div>
        <div class="cal-grid ${open ? 'is-open' : ''}" data-grid>${cells.join('')}</div>
        <div class="row cal-legend" style="margin-top:10px;gap:10px;flex-wrap:wrap">
          <span class="row" style="gap:4px"><span class="cal-mark"></span><span class="muted" style="font-size:12px">当天有训练</span></span>
          <span class="row" style="gap:4px"><span class="cal-mark is-plan"></span><span class="muted" style="font-size:12px">有安排未练</span></span>
        </div>
        </div>
      <div class="card-soft stack" data-day-panel style="margin-top:12px"></div>
    `;

    container.querySelector('[data-prev]').addEventListener('click', () => goMonth(-1));
    container.querySelector('[data-next]').addEventListener('click', () => goMonth(1));
    container.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
      // 甩一下手指之后浏览器还会补发一次 click，不吞掉就会误选某一天
      if (Date.now() < swallowUntil) { swallowUntil = 0; return; }
      selected = b.dataset.day;
      paint();
    }));

    const grid = container.querySelector('[data-grid]');
    syncRowHeight(grid, open);          // 折叠态按实际列宽校准成正方形
    installSwipe(grid);
    paintDayPanel(container.querySelector('[data-day-panel]'), selected, byDate, paint, store, ctx);
  };

  /**
   * 跟手拖拽 + 松手吸附。
   *
   * 之前是「越过阈值 → 瞬间切换」：手指动的时候界面纹丝不动，切换瞬间整块网格从
   * ~300px 撑到 ~470px、下面内容被顶走一截 —— 这就是"不像手势"和"顿一下"的由来。
   * 现在改成：拖动时行高实时跟着手指走（两端带橡皮筋阻尼），松手按**位移 + 速度**
   * 吸附到展开或收起，过渡把剩下的距离送到位；条目拖过半程才出现，避免半路冒字。
   *
   * ⚠ 手势仍然**独占**（touch-action:none + preventDefault）：不这么做，展开后页面变长，
   * "上滑收起"会和"上滑翻页面"抢同一根手指。
   * 代价是：在日历这块区域里没法靠滑动翻页面，要翻得在日历以外的区域划 —— 这是有意换的。
   */
  function installSwipe(grid) {
    if (!grid) return;
    let startY = null;
    let startT = 0;
    let lastY = null;
    let lastT = 0;
    let moved = false;
    let progress = open ? 1 : 0;

    /** 0~1 的展开进度 → 行高，写进 CSS 变量（每格一起变） */
    const apply = (p) => {
      progress = Math.max(-0.12, Math.min(1, p));
      const collapsed = collapsedRow(grid);
      const rowH = collapsed + (openRowFor(grid) - collapsed) * progress;
      grid.style.setProperty('--cal-row', `${rowH.toFixed(2)}px`);
      grid.classList.toggle('is-open', progress >= REVEAL_AT);
    };

    const settle = (target, byGesture) => {
      open = !!target;
      rememberedOpen = open;                  // 切 Tab 回来还保持刚才的展开态
      grid.classList.remove('is-dragging');   // 恢复过渡，把剩下的距离送到位
      grid.classList.toggle('is-open', open);
      grid.style.setProperty('--cal-row', `${open ? openRowFor(grid) : collapsedRow(grid)}px`);
      // 到位的物理确认：没有震动的设备会静默失败，不影响别的逻辑
      if (byGesture && navigator.vibrate) { try { navigator.vibrate(8); } catch (err) { /* 忽略 */ } }
    };

    grid.addEventListener('touchstart', (e) => {
      const y = e.touches[0].clientY;
      startY = y; lastY = y;
      startT = Date.now(); lastT = startT;
      moved = false;
      progress = open ? 1 : 0;
      grid.classList.add('is-dragging');      // 拖动中不要过渡，否则会粘滞
      apply(progress);
    }, { passive: true });

    grid.addEventListener('touchmove', (e) => {
      // 先把这次手势吃掉，页面不再跟着动
      if (e.cancelable) e.preventDefault();
      if (startY == null) return;
      const y = e.touches[0].clientY;
      const dy = y - startY;
      if (Math.abs(dy) > 8) moved = true;
      lastY = y; lastT = Date.now();

      const raw = dy / DRAG_FULL;
      // 两端都做橡皮筋：越过展开上限 / 低于折叠下限后，阻力明显变大
      let p = raw;
      if (raw > 1) p = 1 + (raw - 1) * RUBBER;
      else if (raw < -0.12) p = -0.12 + (raw + 0.12) * RUBBER;
      apply(p);
    }, { passive: false });

    const finish = () => {
      if (startY == null) return;
      const dt = lastT - startT;
      const v = dt > 0 ? (lastY - startY) / dt : 0;   // px/ms，正 = 向下拖
      let target;
      if (v > FLICK_V && progress > 0.06) target = 1;        // 快速下扫 → 展开
      else if (v < -FLICK_V && progress < 0.94) target = 0;  // 快速上扫 → 收起
      else target = progress > 0.5 ? 1 : 0;                 // 否则看拖到哪一半
      settle(target, moved);
      startY = null; lastY = null;
      if (moved) swallowUntil = Date.now() + 350;    // 只吞紧随其后的那一次点击
    };
    grid.addEventListener('touchend', finish);
    grid.addEventListener('touchcancel', () => {
      if (startY != null) settle(progress > 0.5 ? 1 : 0, false);
      startY = null; lastY = null;
    });
  }

  paint();
}

/** 折叠态行高 = 列宽（格子才是正方形）；网格 gap 是 2px × 6 */
function collapsedRow(grid) {
  const cols = 7;
  const gap = 2;
  const w = (grid.clientWidth || 320) - gap * (cols - 1);
  return Math.max(38, Math.round(w / cols));
}

/**
 * 展开态的行高。
 * 80px 是照着展开态的实际内容算出来的：日期 16 + 间距 4 + 条目 18.5 ×2 行（含间距）
 * + 上下内边距/描边 ≈ 68px，留一截余量。
 * ——之前定的 78px 装不下"两条 + 还有 N 条"那三行，文字会挤成一团甚至溢出格子。
 * 另外必须保证**比折叠态高**：宽屏上（桌面预览）一列能宽到 100px 以上，
 * 固定 78px 反而会让"展开"变成变矮，手势方向整个反过来。
 */
function openRowFor(grid) {
  return Math.max(OPEN_ROW, collapsedRow(grid) + 28);
}

/**
 * 按当前状态把行高落到 CSS 变量上（重建 DOM、切月份后都要重新校准）。
 * 首次落地要**关掉过渡**，否则新节点会从 CSS 默认值"长"到目标高度，
 * 页面刚打开就自己动一下。
 */
function syncRowHeight(grid, open) {
  if (!grid) return;
  grid.classList.add('is-instant');
  grid.style.setProperty('--cal-row', `${open ? openRowFor(grid) : collapsedRow(grid)}px`);
  requestAnimationFrame(() => requestAnimationFrame(() => grid.classList.remove('is-instant')));
}

/** 某天要显示的条目：练过的排前面，手动安排的排在后面 */
function dayEntries(sessions, day) {
  const out = [];
  (sessions || []).forEach((s) => {
    // 空壳记录（一组都没做完就结束）不算"练过"，
    // 不该在格子里占一条 —— 否则圆点还没实心、下面却列着它，看着自相矛盾。
    if (!isRealTraining(s)) return;
    out.push({ kind: 'done', label: s.planName || (s.planSnapshot && s.planSnapshot.name) || '自由训练' });
  });
  ((day && day.planned) || []).forEach((p) => {
    out.push({ kind: 'plan', label: p.planName || '计划' });
  });
  return out;
}

function paintDayPanel(panel, dateKey, byDate, repaint, store, ctx) {
  const sched = store.getSchedule();
  const day = sched[dateKey] || emptyDay(dateKey);
  const sessions = byDate.get(dateKey) || [];
  const [y, m, d] = dateKey.split('-');

  panel.innerHTML = `
    <div class="row is-between">
      <h3>${Number(m)} 月 ${Number(d)} 日 周${WD[new Date(Number(y), Number(m) - 1, Number(d)).getDay()]}</h3>
      <span class="chip">${day.status === 'done' ? '已练' : day.status === 'rest' ? '休息日' : day.status === 'planned' ? '有安排' : day.status === 'skipped' ? '跳过' : '无记录'}</span>
    </div>

    ${sessions.length ? sessions.map((s) => {
      const sm = summarizeSession(s);
      // 事后记一笔的记录没有逐组数据，头部就别再显示 "0/0 组"，直说是记一笔的
      if (sm.isManual) {
        const catLabel = categoryLabel(s.planSnapshot && s.planSnapshot.category);
        const showCat = catLabel && catLabel !== (s.planName || '');
        return `<div class="card-soft is-flat stack">
          <div class="row is-between">
            <strong>${esc(s.planName || '记录')}</strong>
            <span class="muted">记录 · ${sm.loggedMin == null ? '—' : esc(fmtLong(sm.durationMs))}</span>
          </div>
          ${showCat ? `<div class="muted">${esc(catLabel)}</div>` : ''}
          <button class="btn-sticker is-sm is-ghost" data-open-session="${esc(s.id)}">查看详情</button>
        </div>`;
      }
      return `<div class="card-soft is-flat stack">
        <div class="row is-between">
          <strong>${esc(s.planName || (s.planSnapshot && s.planSnapshot.name) || '自由训练')}</strong>
          <span class="muted">${sm.done}/${sm.total} 组</span>
        </div>
        <div class="muted">${sm.loggedMin == null
          ? `${esc(fmtClock(sm.elapsedMs))}（App 计时）`
          : esc(fmtLong(sm.durationMs))} ·
          ${esc(categoryLabel(s.planSnapshot && s.planSnapshot.category))}
          ${sm.distanceKm ? ` · ${sm.distanceKm} km` : ''}
          ${sm.reps ? ` · ${sm.reps} 次` : ''}</div>
        ${s.feedback ? `<div class="chip is-on">RPE ${esc(s.feedback.rpe != null ? s.feedback.rpe : '-')}</div>` : ''}
        <button class="btn-sticker is-sm is-ghost" data-open-session="${esc(s.id)}">查看详情</button>
      </div>`;
    }).join('') : '<p class="muted">这天没有训练记录。</p>'}

    ${(day.planned || []).length ? `<div class="stack">
      ${day.planned.map((p) => `<div class="row is-between card-soft is-flat">
        <span>${esc(p.planName || '计划')}</span>
        <button class="chip" data-rm-planned="${esc(p.id)}">${icon('trash', 14)}</button>
      </div>`).join('')}
    </div>` : ''}

    <div class="cal-actions">
      <button class="chip" data-log>${icon('note', 14)}<span>记录训练</span></button>
      <button class="chip" data-add-plan>${icon('plus', 14)}<span>安排计划</span></button>
      <button class="chip ${day.status === 'rest' ? 'is-on' : ''}" data-rest>${icon('moon', 14)}<span>休息日</span></button>
    </div>`;

  panel.querySelectorAll('[data-open-session]').forEach((b) => b.addEventListener('click', () => {
    if (ctx && ctx.onOpenSession) ctx.onOpenSession(b.dataset.openSession);
  }));

  panel.querySelectorAll('[data-rm-planned]').forEach((b) => b.addEventListener('click', () => {
    const s = store.getSchedule();
    removePlanned(s, dateKey, b.dataset.rmPlanned);
    store.saveSchedule(s);
    toast('已移除');
    repaint();
  }));

  panel.querySelector('[data-log]').addEventListener('click', () => {
    openLogSheet(store, dateKey, repaint);
  });

  panel.querySelector('[data-add-plan]').addEventListener('click', () => {
    const plans = store.listPlans();
    if (!plans.length) { toast('先去「计划」建一个训练计划'); return; }
    openSheet({
      title: `给 ${m} 月 ${d} 日安排计划`,
      body: `<div class="stack">${plans.map((p) =>
        `<button class="btn-sticker is-big is-ghost" data-pick="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>`,
      onMount: ({ $, root }) => {
        root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
          const p = store.getPlan(b.dataset.pick);
          const s = store.getSchedule();
          addPlanned(s, dateKey, { planId: p.id, planName: p.name });
          store.saveSchedule(s);
          closeSheet();
          toast('已加入日程');
          repaint();
        }));
      },
    });
  });

  panel.querySelector('[data-rest]').addEventListener('click', () => {
    const s = store.getSchedule();
    const cur = s[dateKey] || emptyDay(dateKey);
    setDayStatus(s, dateKey, cur.status === 'rest' ? '' : 'rest');
    store.saveSchedule(s);
    repaint();
  });
}

/* -------------------------------------------------------------- 记录训练 */

/**
 * 记一笔"这天练了什么"。
 *
 * 两种记法：
 *   「按计划记录」—— 今天确实按某套计划练了，选计划 + 填时长；
 *   「简单记一笔」—— 忙起来只想留下"练了有氧 30 分钟"这种事实，不牵扯任何计划。
 *
 * 时长一律由用户填（统计以它为准），因为正式组按容量控制、有氧在别处计时，
 * App 秒表算出来的流逝时间不等于真实的训练时间。
 */
function openLogSheet(store, dateKey, onDone) {
  const plans = store.listPlans();
  const [y, m, d] = dateKey.split('-');
  let mode = plans.length ? 'plan' : 'quick';
  let planId = '';
  let category = '';
  let catInput = '';
  let minutes = mode === 'plan' ? 60 : 30;

  const inputStyle = 'padding:12px;border:2.5px solid var(--line);border-radius:16px;background:#fff;width:100%;font-weight:600';

  const paint = () => {
    const selPlan = store.getPlan(planId);
    const cats = Array.from(new Set(
      store.listCategories().map((c) => categoryLabel(c)).filter(Boolean)
    ));

    openSheet({
      title: `记录 ${Number(m)} 月 ${Number(d)} 日的训练`,
      body: `<div class="stack">
        <div class="row" style="gap:8px">
          <button class="chip ${mode === 'plan' ? 'is-on' : ''}" data-mode="plan">按计划记录</button>
          <button class="chip ${mode === 'quick' ? 'is-on' : ''}" data-mode="quick">简单记一笔</button>
        </div>

        ${mode === 'plan' ? `
          <div class="stack" style="gap:6px">
            <span class="muted">今天练的是哪套</span>
            <div class="row" style="gap:6px;flex-wrap:wrap">
              ${plans.map((p) => `<button class="chip ${planId === p.id ? 'is-on' : ''}" data-pick-plan="${esc(p.id)}">${esc(p.name)}</button>`).join('')}
            </div>
            ${selPlan ? `<span class="muted" style="font-size:12px">类别：${esc(categoryLabel(selPlan.category))}</span>` : '<span class="muted" style="font-size:12px">选完只记这一条，不会去改计划本身。</span>'}
          </div>` : `
          <div class="stack" style="gap:6px">
            <span class="muted">训练类别</span>
            <div class="row" style="gap:6px;flex-wrap:wrap">
              ${cats.map((c) => `<button class="chip ${category === c ? 'is-on' : ''}" data-pick-cat="${esc(c)}">${esc(c)}</button>`).join('')}
            </div>
            <input data-cat-input value="${esc(catInput)}" placeholder="也可以自己写一个，比如「有氧」" style="${inputStyle}">
          </div>`}

        <label class="stack" style="gap:4px">
          <span class="muted">练了多久（分钟）</span>
          <input data-min type="number" inputmode="decimal" min="1" step="1" value="${minutes}" style="${inputStyle}">
          <span class="muted" style="font-size:11px;line-height:1.35">统计里的训练时长以这个为准，填你实际练的时间就行。</span>
        </label>
      </div>`,
      footer: `<button class="btn-sticker is-big is-accent" data-save-log>保存这条记录</button>`,
      onMount: ({ $, root }) => {
        root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
          mode = b.dataset.mode;
          // 两种记法的常见时长不一样，给个合适的默认值，少一步输入
          minutes = mode === 'plan' ? 60 : 30;
          if (mode === 'quick' && !category && !catInput && selPlanCategory(plans, planId)) category = selPlanCategory(plans, planId);
          paint();
        }));

        root.querySelectorAll('[data-pick-plan]').forEach((b) => b.addEventListener('click', () => {
          planId = b.dataset.pickPlan;
          paint();
        }));

        root.querySelectorAll('[data-pick-cat]').forEach((b) => b.addEventListener('click', () => {
          category = b.dataset.pickCat;
          catInput = '';
          paint();
        }));

        const catInputEl = root.querySelector('[data-cat-input]');
        if (catInputEl) catInputEl.addEventListener('input', () => { catInput = catInputEl.value; });

        const minEl = root.querySelector('[data-min]');
        if (minEl) minEl.addEventListener('input', () => {
          const n = Number(minEl.value);
          if (Number.isFinite(n) && n > 0) minutes = n;
        });

        $('[data-save-log]').addEventListener('click', () => {
          const loggedSec = Math.round((Number(minEl ? minEl.value : minutes) || 0) * 60);
          if (!(loggedSec > 0)) { toast('填一下练了多少分钟'); return; }

          let session;
          if (mode === 'plan') {
            const plan = store.getPlan(planId);
            if (!plan) { toast('先选一个练过的计划'); return; }
            session = manualSession({ dateKey, plan, loggedSec });
          } else {
            const cat = String(catInput || category || '').trim();
            if (!cat) { toast('写个训练类别'); return; }
            store.rememberCategory(cat);           // 填过的类别下次还能一键选
            session = manualSession({ dateKey, category: cat, loggedSec });
          }

          store.commitSession(session);
          const sched = store.getSchedule();
          upsertDay(sched, dateKey, { sessionId: session.id });
          store.saveSchedule(sched);
          closeSheet();
          toast(`已记录：${session.planName} · ${Math.round(loggedSec / 60)} 分钟`);
          if (onDone) onDone();
        });
      },
    });
  };

  paint();
}

function selPlanCategory(plans, planId) {
  const p = plans.find((x) => x.id === planId);
  return p ? categoryLabel(p.category) : '';
}
