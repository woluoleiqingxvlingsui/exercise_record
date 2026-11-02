/**
 * views/train.js —— 训练播放器（本 App 的核心界面）。
 *
 * 每组流程（按需求确定）：
 *   完成本组 → 弹出询问「按计划推进 / 灵活调整」 → 选完才进入组间歇倒计时
 * 选「灵活调整」时**必须显著显示原计划间歇作为参考**，用户可自定本组时长。
 *
 * 职责划分：
 *   JS 侧是唯一决策者与数据源；原生侧只负责把倒计时画到通知栏并在到点震动。
 *   每次状态变化都调 syncNotification 镜像过去，原生不做业务判断
 *   （唯一例外：询问期被锁屏时原生会按 confirmDeadline 自动套用计划间歇，
 *     回来时靠 readNativeState 的 autoApplied 对账）。
 */

import {
  currentStep, isLastStep, completeStep, progress, overrideStepRest,
  addSetToItem, removeStep, skipCurrentStep, finishSession, summarizeSession, restOptions,
} from '../model.js';
import { fmtClock, fmtRest, fmtDelta, toNumOrNull } from '../util.js';
import {
  syncNotification, stopNotification, readNativeState, vibrate, notifyRestDone,
} from '../native.js';
import {
  esc, icon, mascot, openSheet, closeSheet, confirmSheet, toast, stepLabel, targetText,
  categoryClass,
} from '../ui.js';

const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

export function createPlayer({ store, session, onExit, onFinish, onDiscarded }) {
  const root = document.createElement('div');
  const settings = store.getSettings();

  let phase = 'set';          // set | confirm | rest | continuous | done
  let chosenRestMs = null;    // 灵活调整选定的本组间歇
  let restEndTs = 0;
  let restTotalMs = 0;
  let confirmAt = 0;
  let lastEntry = null;
  let ticker = null;
  let sheetApi = null;
  let settled = false;        // 询问是否已落定，防重复点击/重复兜底
  let timeoutHandled = false; // 兜底只处理一次，防重复触发

  /* ------------------------------------------------------------ 生命周期 */

  /**
   * 换阶段，并把阶段**落盘**（session.uiPhase）。
   *
   * 必须落盘的原因：App 被杀后重开，phase 会退化成 'set'，
   * 就不知道上次是停在「等用户选」还是「正在休息」——
   * 而这两种情况恰恰要靠它才能和原生那边对账
   * （原生可能已经按 confirmDeadline 自动推进了）。
   */
  function setPhase(p) {
    phase = p;
    session.uiPhase = p;
    try {
      store.saveOngoing(session);
    } catch (e) {
      console.warn('[train] 保存进行中状态失败', e);
    }
  }

  /**
   * 启动播放器。
   *
   * 刻意**先同步渲染一次**，再异步去跟原生对账：
   * 调用方（main.js、集成测试）习惯 start() 之后立刻就能看到界面，
   * 渲染要是被 await 挡住，界面会慢一拍才出来。
   *
   * 对账可能改变阶段（认领原生那边已经在走的倒计时），
   * 所以对账完再重绘一次。
   */
  function start() {
    // 上次停在哪个阶段（从存盘里读回来的）
    const prevPhase = session.uiPhase || 'set';

    if (isLastStep(session) || session.status !== 'ongoing') {
      if (session.status === 'ongoing' && isLastStep(session)) finishNow();
      else { phase = 'done'; session.uiPhase = 'done'; }
    } else {
      const step = currentStep(session);
      phase = step.continuous ? 'continuous' : 'set';
    }

    ticker = setInterval(onTick, 250);
    render();
    pushNative();

    reconcileWithNative(prevPhase).then(() => {
      render();
      pushNative();
    });
  }

  function destroy() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    closeSheet();
  }

  /* --------------------------------------------------- 与原生对账（兜底） */

  /**
   * 与原生对账。
   *
   * 原生在「询问」阶段被锁屏时，会按 confirmDeadline 自动套用计划间歇
   * （phase 变 'rest'）。JS 这边必须认领它，否则：
   *   ① 间歇从头再数一遍（JS 自己起一个 restEndTs）；
   *   ② 这一组没有记录（用户回来还得再点一次「完成本组」）；
   *   ③ 「询问超时，已按计划推进」这句话永远不出现。
   *
   * prevPhase 是存盘里读回来的「上次停在哪」——
   * 只有它能区分「原生在自动推进」和「原生只是还在上一轮的休息里」。
   */
  async function reconcileWithNative(prevPhase) {
    const ns = await readNativeState();
    if (!ns || ns.sessionId !== session.id) {
      // 原生那边根本没有这次训练的状态：回到正常流程，让用户自己决定
      if (prevPhase === 'rest') { phase = 'set'; restEndTs = 0; restTotalMs = 0; }
      return;
    }

    const nativeResting = ns.phase === 'rest' && ns.restEndTs > Date.now();

    if (prevPhase === 'confirm' && nativeResting) {
      // 询问期间锁屏/切走了，原生已经替我们按计划推进
      adoptAutoApplied(ns);
      return;
    }
    if (prevPhase === 'confirm' && ns.phase === 'confirm') {
      // 原生那边还在等选择（还没到兜底时间）→ 把询问重新摆出来，
      // 顺便把兜底时间重新给满，用户不用接着上次那点残时间等
      phase = 'confirm';
      confirmAt = Date.now();
      openConfirm();
      return;
    }
    if (prevPhase === 'rest' && nativeResting) {
      // 接着上次的倒计时，别从头再数
      phase = 'rest';
      restTotalMs = Number(ns.plannedRestMs) || 0;
      chosenRestMs = restTotalMs;
      restEndTs = ns.restEndTs;
      session.uiPhase = 'rest';
      return;
    }
    // 原生那边没有可接的倒计时 → 回到正常流程
    if (prevPhase === 'rest') { phase = 'set'; restEndTs = 0; restTotalMs = 0; }
  }

  function adoptAutoApplied(ns) {
    const step = currentStep(session);
    if (!step || settled) return;
    settled = true;
    // 落一条 decision='auto' 的记录，让日后回看知道"这次是自动推进的"
    lastEntry = completeStep(session, {}, { restMs: step.restPlannedMs, decision: 'auto' });
    phase = 'rest';
    session.uiPhase = 'rest';
    restTotalMs = step.restPlannedMs;
    chosenRestMs = step.restPlannedMs;
    restEndTs = ns.restEndTs;
    store.saveOngoing(session);
    closeSheet();
    toast('询问超时，已按计划推进');
    render();
    pushNative();
  }

  /* ----------------------------------------------------------- 倒计时 */

  function onTick() {
    const now = Date.now();
    if (phase === 'confirm' && !settled) {
      const limit = settings.confirmTimeoutMs;
      if (limit > 0 && now - confirmAt >= limit) { onConfirmTimeout(); return; }
    }
    if (phase === 'rest') {
      if (now >= restEndTs) {
        // 顺序很重要：必须先让原生提醒（震动 + 通知），再切下一组。
        // 反过来的话状态被推成 set，原生就永远等不到到点，提醒直接消失。
        alertRestDoneNative();
        onRestDone();
        return;
      }
    }
    if (phase === 'confirm' || phase === 'rest') renderTickerOnly();
  }

  /**
   * 询问超时兜底。
   *
   * 先问原生：它是不是**已经**按 confirmDeadline 自动推进了？
   * 是的话直接认领它那边的倒计时（restEndTs 用原生的那个），
   * 别在这儿重新起一个 —— 否则间歇会被"从头再数一遍"，
   * 用户看到的剩余时间和通知栏里的对不上。
   */
  async function onConfirmTimeout() {
    if (settled || timeoutHandled) return;
    timeoutHandled = true;
    let ns = null;
    try { ns = await readNativeState(); } catch (e) { ns = null; }
    const nativeResting = !!ns && ns.sessionId === session.id
      && ns.phase === 'rest' && ns.restEndTs > Date.now();
    if (nativeResting) { adoptAutoApplied(ns); return; }
    const step = currentStep(session);
    if (!step) { finishNow(); return; }
    applyDecision('plan', step.restPlannedMs, 'auto');
  }

  function renderTickerOnly() {
    const now = Date.now();
    if (phase === 'rest') {
      const el = root.querySelector('[data-ticker]');
      if (!el) return;
      const left = Math.max(0, restEndTs - now);
      el.textContent = fmtClock(left);
      const ring = root.querySelector('[data-ring]');
      if (ring) {
        const p = restTotalMs > 0 ? left / restTotalMs : 0;
        ring.setAttribute('stroke-dashoffset', String(RING_C * (1 - p)));
      }
    } else if (phase === 'confirm') {
      // 询问浮层挂在 body 上，不在 root 里 —— 要从 sheetApi 上取
      const el = sheetApi && sheetApi.root.querySelector('[data-ticker]');
      if (el) el.textContent = `已等待 ${fmtClock(now - confirmAt)}`;
    }
  }

  /**
   * 到点提醒走原生：震动 + 「休息结束」通知。
   * WebView 里的 navigator.vibrate 在安卓上不生效，只当浏览器预览的降级用。
   */
  function alertRestDoneNative() {
    const next = currentStep(session);
    notifyRestDone({
      sessionId: session.id,
      phase: 'rest',
      itemName: next ? next.itemName : '',
      label: next ? `下一组 ${stepLabel(next)}` : '',
      restEndTs,
      plannedRestMs: restTotalMs,
    });
    vibrate(200);
  }

  function onRestDone() {
    const step = currentStep(session);
    chosenRestMs = null;
    settled = false;
    if (!step) { finishNow(); return; }
    phase = step.continuous ? 'continuous' : 'set';
    session.uiPhase = phase;
    try { store.saveOngoing(session); } catch (e) { /* 配额满不阻断 */ }
    render();
    pushNative();
  }

  /* --------------------------------------------------- 询问 → 决策 */

  function openConfirm() {
    if (settled) return;
    confirmAt = Date.now();
    timeoutHandled = false;
    // 这一组做完之后还有没有组？没有的话就没有间歇可言
    const isLast = session.cursor + 1 >= session.timeline.length;
    setPhase('confirm');
    pushNative();

    const step = currentStep(session);
    const planned = step.restPlannedMs;
    const limit = settings.confirmTimeoutMs;

    sheetApi = openSheet({
      title: '本组完成 · 下一步？',
      dismissible: false,
      body: `
        <div class="stack">
          <div class="card-soft is-flat center">
            <div class="muted" data-ticker>已等待 0:00</div>
            <p class="muted" style="margin:6px 0 0">${isLast ? '这是最后一组，选完就收工' : '选完才进入组间歇倒计时'}</p>
          </div>
          <button class="btn-sticker is-big is-accent" data-plan>
            ${isLast ? '完成这次训练' : `按计划推进 · 休息 ${esc(fmtRest(planned))}`}
          </button>
          <button class="btn-sticker is-big is-ghost" data-flex>
            灵活调整
          </button>
          ${limit > 0 ? `<p class="muted center">${Math.round(limit / 1000)} 秒内没选，自动按计划推进</p>` : ''}
        </div>`,
      onMount: ({ $ }) => {
        $('[data-plan]').addEventListener('click', () => applyDecision('plan', planned, 'plan'));
        $('[data-flex]').addEventListener('click', () => openFlexPanel());
      },
    });
  }

  /** 灵活调整面板：把「原计划间歇」放在最显眼的位置当参考 */
  function openFlexPanel() {
    const step = currentStep(session);
    const planned = step.restPlannedMs;
    let value = chosenRestMs != null ? chosenRestMs : planned;

    // 档位里一定包含「计划值」本身：计划可能是 45 秒这种非预设值，
    // 少了它用户就看不到哪一档代表计划，参考基准就丢了。
    const options = restOptions(planned);

    // 整份计划的最后一步后面没有组了，不该有间歇。
    // 这时还让用户选时长、然后默默丢掉是最糟的体验 ——
    // 记录里会写着"实际间歇 60 秒"，却根本没有那次倒计时。
    const isLast = session.cursor + 1 >= session.timeline.length;

    openSheet({
      title: '灵活调整本组间歇',
      body: `
        <div class="stack">
          <div class="ref-banner">
            <span class="label">${isLast ? '组间歇' : '原计划间歇'}</span>
            <span class="value num">${isLast ? '最后一组不安排' : esc(fmtRest(planned))}</span>
          </div>

          ${isLast ? `
            <div class="card-soft is-flat">
              <p class="muted">这是最后一组，后面没有组了 —— 本次不会安排间歇，休息时长在这里不适用。</p>
            </div>` : `
            <div class="row" style="flex-wrap:wrap;gap:8px" data-presets>
              ${options.map((ms) => `
                <button class="chip ${ms === planned ? 'is-on' : ''}" data-ms="${ms}">
                  ${esc(fmtRest(ms))}${ms === planned ? ' · 计划' : ''}
                </button>`).join('')}
            </div>

            <div class="card-soft is-flat">
              <div class="row is-between">
                <button class="btn-sticker is-sm" data-minus>−15 秒</button>
                <div class="center">
                  <div class="muted">本组休息</div>
                  <div class="num" style="font-size:28px" data-value>${esc(fmtClock(value))}</div>
                </div>
                <button class="btn-sticker is-sm" data-plus>+15 秒</button>
              </div>
              <div class="center muted" style="margin-top:8px" data-delta></div>
            </div>`}

          <details class="card-soft is-flat">
            <summary style="font-weight:800;cursor:pointer">更多调整</summary>
            <div class="stack" style="margin-top:12px">
              <div class="row" style="gap:8px;flex-wrap:wrap">
                <button class="chip" data-add-set>给这个动作 +1 组</button>
                <button class="chip" data-del-set>−1 组</button>
                <button class="chip" data-skip>跳过下一组</button>
                <button class="chip" data-end-item>结束本动作</button>
              </div>
              <p class="muted">每一次调整都会记进本次训练，日后能回看当时改了什么。</p>
            </div>
          </details>
        </div>`,
      footer: `<div class="stack">
        <button class="btn-sticker is-big is-accent" data-start>${isLast ? '完成训练' : '开始休息'}</button>
        <button class="btn-sticker is-big is-ghost" data-back>返回</button>
      </div>`,
      onMount: ({ $, $$ }) => {
        const valueEl = $('[data-value]');
        const deltaEl = $('[data-delta]');

        const paint = () => {
          // 最后一组没有间歇控件，这几个元素不存在
          if (!valueEl || !deltaEl) return;
          valueEl.textContent = fmtClock(value);
          const d = value - planned;
          deltaEl.textContent = d === 0 ? '与计划一致' : `比计划 ${fmtDelta(d)}`;
          deltaEl.style.color = d === 0 ? 'var(--ink-soft)' : (d > 0 ? 'var(--purple-dk)' : 'var(--cardio-dk)');
          $$('[data-presets] .chip').forEach((c) => {
            c.classList.toggle('is-on', Number(c.dataset.ms) === value);
          });
        };

        $$('[data-presets] .chip').forEach((c) => {
          c.addEventListener('click', () => { value = Number(c.dataset.ms); paint(); });
        });
        $('[data-plus]').addEventListener('click', () => { value += 15000; paint(); });
        $('[data-minus]').addEventListener('click', () => { value = Math.max(0, value - 15000); paint(); });

        $('[data-add-set]').addEventListener('click', () => {
          addSetToItem(session, step.itemId);
          store.saveOngoing(session);
          toast('已加 1 组');
        });
        $('[data-del-set]').addEventListener('click', () => {
          const idx = session.timeline.findIndex((s, i) => i > session.cursor && s.itemId === step.itemId);
          if (idx < 0) { toast('这个动作已经没有可减的组了'); return; }
          removeStep(session, idx, '临时减组');
          store.saveOngoing(session);
          toast('已减 1 组');
        });
        $('[data-skip]').addEventListener('click', () => {
          if (session.cursor + 1 >= session.timeline.length) { toast('已经是最后一组了'); return; }
          const removed = removeStep(session, session.cursor + 1, '跳过下一组');
          if (removed) { store.saveOngoing(session); toast(`已跳过：${removed.itemName}`); }
        });
        $('[data-end-item]').addEventListener('click', () => {
          let n = 0;
          while (session.cursor + 1 < session.timeline.length
                 && session.timeline[session.cursor + 1].itemId === step.itemId) {
            removeStep(session, session.cursor + 1, '结束本动作');
            n += 1;
          }
          store.saveOngoing(session);
          toast(n ? `本动作剩余 ${n} 组已略过` : '这个动作已经到最后一组');
        });

        $('[data-start]').addEventListener('click', () => {
          if (isLast) {
            // 最后一组：没有间歇可言，直接把这一组完成掉
            applyDecision('plan', 0, 'plan');
            return;
          }
          // 显式记一次调整，留痕：原计划 vs 本次采用
          if (value !== planned) overrideStepRest(session, session.cursor, value, '灵活调整');
          applyDecision('flex', value, 'flex');
        });
        $('[data-back]').addEventListener('click', () => openConfirm());

        paint();
      },
    });
  }

  /** 落定本次决策并进入休息（或直接推进） */
  function applyDecision(kind, restMs, source) {
    if (settled) return;
    settled = true;
    const step = currentStep(session);
    if (!step) { finishNow(); return; }

    // 这一组做完之后还有没有组？没有的话就不该有间歇。
    // （整份计划最后一步 restPlannedMs 本来就是 0，
    //   但用户在灵活调整里选的值不能被"默默丢掉"再写进记录 ——
    //   那样记录里会写着"实际间歇 60 秒"，却根本没有那次倒计时，
    //   还会被算成"偏离计划 1 组"。）
    const willBeLast = session.cursor + 1 >= session.timeline.length;
    const effectiveRest = willBeLast ? 0 : Math.max(0, restMs || 0);

    const actual = collectActual(step);
    lastEntry = completeStep(session, actual, { restMs: effectiveRest, decision: source || kind });
    chosenRestMs = effectiveRest;

    const goingRest = effectiveRest > 0;
    if (goingRest) {
      phase = 'rest';
      session.uiPhase = 'rest';
      restTotalMs = effectiveRest;
      restEndTs = Date.now() + effectiveRest;
    }
    store.saveOngoing(session);
    closeSheet();

    if (!goingRest) {
      settleReset();
      onRestDone();
      pushNative();
      return;
    }
    render();
    pushNative();
  }

  function settleReset() {
    settled = false;
    chosenRestMs = null;
    timeoutHandled = false;
  }

  /* ----------------------------------------------------- 组间休息控制 */

  function skipRest() {
    skipRestToNext('已跳过休息');
  }

  function skipRestToNext(msg) {
    settleReset();
    if (msg) toast(msg);
    onRestDone();
  }

  /* ------------------------------------------------------- 完成本组 */

  function finishSet() {
    const step = currentStep(session);
    if (!step) { finishNow(); return; }

    if (step.continuous) {
      // 连续有氧段：不弹询问，但有过渡间歇就走过渡间歇
      const restMs = step.restPlannedMs;
      const entry = completeStep(session, collectActual(step), { restMs, decision: 'plan' });
      lastEntry = entry;
      store.saveOngoing(session);
      if (restMs > 0 && !isLastStep(session)) {
        phase = 'rest';
        session.uiPhase = 'rest';
        restTotalMs = restMs;
        restEndTs = Date.now() + restMs;
        store.saveOngoing(session);
      } else {
        onRestDone();
        pushNative();
        return;
      }
      render();
      pushNative();
      return;
    }
    openConfirm();
  }

  function finishNow() {
    finishSession(session, isLastStep(session) && session.entries.length ? 'done' : 'aborted');
    // 阶段要在 store.finishSession 之前定下来：
    // finishSession 会把 ex.ongoing 清掉，之后再存就等于把进行中的训练又写回来了。
    phase = 'done';
    session.uiPhase = 'done';
    store.finishSession(session);
    stopNotification();
    render();
    if (onFinish) onFinish(session);
  }

  /* ----------------------------------------------------------- 渲染 */

  function collectActual(step) {
    const read = (name) => toNumOrNull((root.querySelector(`[data-in="${name}"]`) || {}).value);
    if (!step) return {};
    if (step.mode === 'reps') {
      return { reps: read('reps'), weightKg: read('weightKg') };
    }
    if (step.mode === 'duration') {
      const min = read('durMin');
      const sec = read('durSec');
      const total = (min != null || sec != null) ? (min || 0) * 60 + (sec || 0) : null;
      return { durationS: total };
    }
    return { distanceKm: read('distanceKm'), durationS: read('durTotal') };
  }

  function actualInputs(step) {
    const p = step.spec || {};
    if (step.mode === 'reps') {
      return `<div class="row" style="gap:10px">
        ${field('reps', '实际次数', p.reps)}
        ${field('weightKg', '重量 kg', p.weightKg)}
      </div>`;
    }
    if (step.mode === 'duration') {
      const s = p.durationS || 0;
      return `<div class="row" style="gap:10px">
        ${field('durMin', '实际分钟', Math.floor(s / 60))}
        ${field('durSec', '秒', s % 60)}
      </div>`;
    }
    return `<div class="row" style="gap:10px">
      ${field('distanceKm', '实际距离 km', p.distanceKm)}
      ${field('durTotal', '用时（秒）', '')}
    </div>`;
  }

  function field(name, label, value) {
    return `<label class="stack" style="flex:1;gap:4px">
      <span class="muted">${esc(label)}</span>
      <input data-in="${name}" type="number" inputmode="decimal" value="${value == null ? '' : esc(String(value))}"
        style="padding:12px;border:2.5px solid var(--line);border-radius:16px;background:#fff;width:100%">
    </label>`;
  }

  function render() {
    const step = currentStep(session);
    const { done, total } = progress(session);

    if (phase === 'done' || !step) {
      renderDone();
      return;
    }

    const head = `
      <div class="row is-between" style="margin-bottom:8px">
        <button class="chip" data-exit>${icon('back', 16)} 退出</button>
        <span class="muted">已完成 ${done}/${total} 组</span>
      </div>
      <div style="height:6px;background:var(--line);border-radius:99px;overflow:hidden;margin-bottom:16px">
        <div style="height:100%;width:${Math.round((done / total) * 100)}%;background:var(--accent);border-radius:99px"></div>
      </div>`;

    if (phase === 'rest') {
      const next = currentStep(session);
      const left = Math.max(0, restEndTs - Date.now());
      const p = restTotalMs > 0 ? left / restTotalMs : 0;
      root.innerHTML = `${head}
        <div class="card-soft stack center">
          <div class="muted">组间歇休息中</div>
          <div style="position:relative;display:inline-block">
            <svg viewBox="0 0 120 120" width="200" height="200" style="transform:rotate(-90deg)">
              <circle cx="60" cy="60" r="${RING_R}" fill="none" stroke="var(--line)" stroke-width="10"/>
              <circle data-ring cx="60" cy="60" r="${RING_R}" fill="none" stroke="var(--cardio)"
                stroke-width="10" stroke-linecap="round"
                stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C * (1 - p)}"/>
            </svg>
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
              <span class="num" style="font-size:40px" data-ticker>${esc(fmtClock(left))}</span>
            </div>
          </div>
          <div class="ref-banner">
            <span class="label">本次间歇</span>
            <span class="value num">${esc(fmtRest(restTotalMs))}</span>
          </div>
          ${lastEntry ? `<p class="muted">上一组计划 ${esc(fmtRest(lastEntry.restPlannedMs))}
            ${lastEntry.deviated ? `· 与计划有出入` : ''}</p>` : ''}
          <div style="font-weight:800">下一组：${esc(next ? next.itemName : '')}</div>
          <div class="muted">${esc(stepLabel(next))} · ${esc(targetText(next && next.spec, next && next.mode))}</div>
        </div>
        <div class="stack" style="margin-top:16px">
          <button class="btn-sticker is-big is-cardio" data-next>开始下一组</button>
          <button class="btn-sticker is-big is-ghost" data-skip-rest>跳过休息</button>
        </div>`;
      root.querySelector('[data-next]').addEventListener('click', () => skipRestToNext(''));
      root.querySelector('[data-skip-rest]').addEventListener('click', skipRest);
      root.querySelector('[data-exit]').addEventListener('click', () => exitAsk());
      return;
    }

    // set / continuous
    const isCont = phase === 'continuous';
    root.innerHTML = `${head}
      <div class="card-soft stack">
        <div class="row is-between">
          <span class="chip ${categoryClass(session.planSnapshot.category)}">
            ${esc(stageName(step))}
          </span>
          <span class="chip">${esc(stepLabel(step))}</span>
        </div>
        <h2>${esc(step.itemName)}</h2>
        <p class="muted">目标：${esc(targetText(step.spec, step.mode)) || '自由发挥'}</p>
        ${step.spec && step.spec.note ? `<p class="muted">${esc(step.spec.note)}</p>` : ''}
        <div style="margin-top:8px">${actualInputs(step)}</div>
        ${isCont ? `<div class="center" style="margin-top:8px">
          <div class="muted">本段已进行</div>
          <div class="num" style="font-size:30px" data-cont-clock>0:00</div>
        </div>` : ''}
        ${!isCont && step.restPlannedMs > 0 ? `<p class="muted">本组计划间歇：${esc(fmtRest(step.restPlannedMs))}</p>` : ''}
      </div>
      <div class="stack" style="margin-top:16px">
        <button class="btn-sticker is-big is-accent" data-done>${isCont ? '完成本段' : '完成本组'}</button>
        <button class="btn-sticker is-big is-ghost" data-skip>跳过这一组</button>
      </div>`;

    root.querySelector('[data-done]').addEventListener('click', finishSet);
    root.querySelector('[data-exit]').addEventListener('click', () => exitAsk());
    root.querySelector('[data-skip]').addEventListener('click', () => {
      // ⚠ 以前这里调的是 removeStep(session, session.cursor)，
      // 而 removeStep 明确拒绝删当前步（index <= cursor 一律返回 null）——
      // 于是"什么都没发生"，界面却照样弹「已跳过本组」，用户被卡在同一组反复点。
      // 现在用 skipCurrentStep：把当前这组从时间线里摘掉，游标停在原地（即下一组）。
      const gone = skipCurrentStep(session, '跳过本组');
      if (!gone) { toast('这一组跳不了'); return; }
      store.saveOngoing(session);
      if (isLastStep(session)) finishNow();
      else { toast(`已跳过：${gone.itemName}`); render(); }
    });

    if (isCont) {
      const startedAt = Date.now();
      const clock = root.querySelector('[data-cont-clock]');
      const t = setInterval(() => {
        if (!clock.isConnected) { clearInterval(t); return; }
        clock.textContent = fmtClock(Date.now() - startedAt);
      }, 500);
    }

    if (phase === 'set' || phase === 'continuous') pushNative();
  }

  function stageName(step) {
    const map = { warmup: '热身', main: '正式组', cooldown: '放松' };
    return map[step.stageKind] || step.stageName || '训练';
  }

  function renderDone() {
    const s = summarizeSession(session);
    root.innerHTML = `
      <div class="card-soft stack center">
        ${mascot('done', 130)}
        <h2>这堂练完了！</h2>
        <p class="muted">完成 ${s.done}/${s.total} 组 · 用时 ${esc(fmtClock(s.elapsedMs))}</p>
        <div class="row" style="flex-wrap:wrap;gap:8px;justify-content:center">
          ${s.reps ? `<span class="chip">共 ${s.reps} 次</span>` : ''}
          ${s.volumeKg ? `<span class="chip">容量 ${s.volumeKg} kg</span>` : ''}
          ${s.distanceKm ? `<span class="chip">${s.distanceKm} km</span>` : ''}
          <span class="chip">休息合计 ${esc(fmtClock(s.restMs))}</span>
          ${s.adjustments ? `<span class="chip">调整 ${s.adjustments} 次</span>` : ''}
          ${s.deviations ? `<span class="chip">偏离计划 ${s.deviations} 组</span>` : ''}
        </div>
      </div>
      <div class="stack" style="margin-top:16px">
        <button class="btn-sticker is-big is-accent" data-finish>记一下今天的感受</button>
        <button class="btn-sticker is-big is-ghost" data-close>先不记，回首页</button>
      </div>`;
    root.querySelector('[data-close]').addEventListener('click', () => { if (onExit) onExit(); });
    root.querySelector('[data-finish]').addEventListener('click', () => { if (onFinish) onFinish(session); });
  }

  function exitAsk() {
    openSheet({
      title: '要结束这次训练吗？',
      body: `<div class="stack">
        <p class="muted"><strong>结束并保存</strong>：把已完成的组存进记录，未完成的标注为提前结束。</p>
        <p class="muted"><strong>结束，并不保存</strong>：本次训练整个丢掉，不留任何记录。</p>
      </div>`,
      footer: `<div class="stack">
        <button class="btn-sticker is-big" data-abort>结束并保存</button>
        <button class="btn-sticker is-big is-ghost" data-discard
          style="border-color:var(--danger-dk);box-shadow:0 4px 0 var(--danger-dk);color:var(--danger-dk)">结束，并不保存</button>
        <button class="btn-sticker is-big is-ghost" data-continue>继续训练</button>
      </div>`,
      onMount: ({ $ }) => {
        $('[data-abort]').addEventListener('click', () => { closeSheet(); finishNow(); });
        $('[data-continue]').addEventListener('click', closeSheet);
        $('[data-discard]').addEventListener('click', async () => {
          closeSheet();
          const ok = await confirmSheet({
            title: '确定不保存？',
            message: '本次训练已记录的组会全部丢弃，无法恢复。',
            okText: '丢弃并结束',
            danger: true,
          });
          if (ok) discardSession();
        });
      },
    });
  }

  /** 结束但不保存：清掉进行中的会话，既不落库也不写日程 */
  function discardSession() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    settled = false;
    store.clearOngoing();
    stopNotification();
    if (onDiscarded) onDiscarded(session);
  }

  /* -------------------------------------------------- 推送给原生通知栏 */

  function pushNative() {
    const step = currentStep(session);
    if (!step && phase !== 'rest') return;
    const label = phase === 'rest'
      ? `下一组 ${stepLabel(step)}`
      : stepLabel(step);

    const base = {
      sessionId: session.id,
      itemName: step ? step.itemName : '',
    };

    let payload;
    if (phase === 'rest') {
      payload = { ...base, phase: 'rest', label,
        restEndTs, plannedRestMs: restTotalMs, anchorTs: 0, confirmDeadline: 0 };
    } else if (phase === 'confirm') {
      payload = { ...base, phase: 'confirm', label,
        anchorTs: confirmAt, restEndTs: 0,
        plannedRestMs: step ? step.restPlannedMs : 0,
        confirmDeadline: settings.confirmTimeoutMs > 0 ? confirmAt + settings.confirmTimeoutMs : 0 };
    } else if (phase === 'continuous') {
      payload = { ...base, phase: 'continuous', label: '',
        anchorTs: Date.now(), restEndTs: 0, plannedRestMs: 0, confirmDeadline: 0 };
    } else {
      payload = { ...base, phase: 'set', label,
        anchorTs: Date.now(), restEndTs: 0, plannedRestMs: 0, confirmDeadline: 0 };
    }
    syncNotification(payload);
  }

  return { root, start, destroy };
}
