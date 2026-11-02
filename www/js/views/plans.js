/**
 * views/plans.js —— 训练计划：列表 + 编辑器。
 *
 * 编辑器是数据驱动的：输入框改动只写回 draft、不整页重绘（否则会丢焦点），
 * 只有增删阶段/动作/组这类结构变化才重绘。
 * 目标结构完全对应 model.js 的 Plan → Stage → Item → Set。
 */

import { expandSets, buildTimeline } from '../model.js';
import { toNumOrNull, fmtRest, uid } from '../util.js';
import {
  esc, icon, mascot, emptyState, openSheet, closeSheet, confirmSheet, toast,
  categoryLabel, categoryClass, categoryTheme, targetText, paceText,
} from '../ui.js';

/* --------------------------------------------------------------- 小工具 */

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = value;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

const isPerSet = (item) => Array.isArray(item.sets);
const setCount = (item) => (isPerSet(item) ? item.sets.length : (item.sets.repeat || 1));
const setProto = (item) => (isPerSet(item) ? (item.sets[0] || {}) : (item.sets.of || {}));

function newItem(mode = 'reps') {
  return {
    id: uid('it'), name: '', mode, defaultRestMs: 90000,
    sets: { repeat: 3, of: mode === 'reps' ? { reps: 8, weightKg: 0 } : mode === 'duration' ? { durationS: 60 } : { distanceKm: 5 } },
  };
}

function newStage(kind = 'main') {
  return { id: uid('st'), kind, name: kind === 'warmup' ? '热身' : kind === 'cooldown' ? '放松' : '正式组', items: [] };
}

const MODE_LABEL = { reps: '按次数', duration: '按时长', distance: '按距离' };

/* -------------------------------------------------------------- 类别 */

/** 可复用的类别：内置两个 + 用户以前填过的（去重、老的英文值也归一），全部由 store 管 */
function knownCategories(store) {
  const list = store.listCategories().map((s) => categoryLabel(s)).filter(Boolean);
  return Array.from(new Set(list));
}

/**
 * 长按识别：按住 550ms 且期间没挪动才算长按。
 * touch 与 mouse 各绑一套 —— 手机 WebView 走 touch，桌面预览走 mouse。
 */
function onLongPress(el, handler) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  let fired = false;

  const start = (x, y) => {
    sx = x; sy = y; fired = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) { /* 忽略 */ } }
      handler();
    }, 550);
  };
  const move = (x, y) => {
    if (Math.abs(x - sx) > 10 || Math.abs(y - sy) > 10) clearTimeout(timer);
  };
  const end = () => clearTimeout(timer);

  el.addEventListener('touchstart', (e) => { const t = e.touches[0]; start(t.clientX, t.clientY); }, { passive: true });
  el.addEventListener('touchmove', (e) => { const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
  el.addEventListener('mousedown', (e) => start(e.clientX, e.clientY));
  el.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
  el.addEventListener('mouseup', end);
  el.addEventListener('mouseleave', end);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // 长按已经生效时，别让紧接着的 click 顺手把类别切过去
  el.addEventListener('click', (e) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  });
}

/** 长按某个类别 → 确认后从可选项里删掉（已有计划照旧用着这个类别） */
async function forgetCategoryWithConfirm(store, name, onDone) {
  const used = store.listPlans().filter((p) => categoryLabel(p.category) === name).length;
  const ok = await confirmSheet({
    title: '删除类别',
    message: used
      ? `「${name}」已经被 ${used} 个计划用着，删掉的只是这个可选项，计划本身不受影响。`
      : `确定不再保留「${name}」这个类别吗？之后需要的话重新输入又会回来。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  store.forgetCategory(name);
  toast('已删除该类别');
  if (onDone) onDone();
}

/* ------------------------------------------------------------------ 列表 */

export function renderPlans(container, { store, onStart }) {
  const plans = store.listPlans();

  const card = (p) => {
    const tl = buildTimeline(p);
    const setTotal = tl.length;
    const cats = categoryClass(p.category);
    return `<div class="card-soft stack" data-plan="${esc(p.id)}">
      <div class="row is-between">
        <span class="chip is-on ${cats}">${esc(categoryLabel(p.category))}</span>
        <span class="muted">${setTotal} 组</span>
      </div>
      <h3>${esc(p.name)}</h3>
      <div class="muted">${esc((p.stages || []).map((s) => s.name || s.kind).join(' · '))}</div>
      ${p.note ? `<p class="muted">${esc(p.note)}</p>` : ''}
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn-sticker is-sm is-ghost" data-view>查看</button>
        <button class="btn-sticker is-sm ${cats}" data-start>开始</button>
        <button class="btn-sticker is-sm is-ghost" data-edit>${icon('edit', 16)} 编辑</button>
        <button class="btn-sticker is-sm is-ghost" data-del>${icon('trash', 16)}</button>
      </div>
    </div>`;
  };

  // 按类别分组：类别由用户自由命名，所以分组也是动态生成的
  const groups = [];
  plans.forEach((p) => {
    const label = categoryLabel(p.category);
    let g = groups.find((x) => x.label === label);
    if (!g) { g = { label, items: [] }; groups.push(g); }
    g.items.push(p);
  });

  container.innerHTML = `
    <div class="row is-between" style="margin-bottom:12px">
      <span class="muted">共 ${plans.length} 个计划</span>
      <button class="btn-sticker is-sm is-accent" data-new>${icon('plus', 16)} 新建计划</button>
    </div>
    ${!plans.length ? emptyState('还没有训练计划', '点右上角新建，或从内置示例开始改') : ''}
    ${groups.map((g, i) => `<h3 style="margin:${i ? '16px' : '8px'} 0 8px">${esc(g.label)}</h3>
      <div class="stack">${g.items.map(card).join('')}</div>`).join('')}
  `;

  container.querySelector('[data-new]').addEventListener('click', () => {
    const draft = { id: '', name: '新计划', category: '力量', tags: [], note: '', stages: [newStage('warmup'), newStage('main')] };
    openEditor(store, draft, () => renderPlans(container, { store, onStart }));
  });

  container.querySelectorAll('[data-plan]').forEach((el) => {
    const id = el.dataset.plan;
    el.querySelector('[data-start]').addEventListener('click', () => onStart(store.getPlan(id)));
    el.querySelector('[data-view]').addEventListener('click', () => openPlanView(store.getPlan(id)));
    el.querySelector('[data-edit]').addEventListener('click', () => {
      openEditor(store, JSON.parse(JSON.stringify(store.getPlan(id))), () => renderPlans(container, { store, onStart }));
    });
    el.querySelector('[data-del]').addEventListener('click', async () => {
      const p = store.getPlan(id);
      if (await confirmSheet({ title: '删除计划', message: `确定删除「${p.name}」吗？已完成的训练记录不受影响。`, okText: '删除', danger: true })) {
        store.deletePlan(id);
        toast('已删除');
        renderPlans(container, { store, onStart });
      }
    });
  });
}

/* ------------------------------------------------------------ 只读查看 */

/**
 * 只读查看计划安排。
 * 单独做一个入口，是因为「编辑」里点错一下就改了计划 —— 只想确认安排时不该走那条路。
 * 这个弹层里**没有任何可改动的控件**，只有「关闭」。
 */
export function openPlanView(plan) {
  if (!plan) { toast('找不到这个计划'); return; }
  const tl = buildTimeline(plan);
  const modeLabel = { reps: '按次数', duration: '按时长', distance: '按距离' };
  const restText = (ms) => (ms ? fmtRest(ms) : '不休息');

  const stagesHtml = (plan.stages || []).map((st) => {
    const kind = st.kind === 'warmup' ? '热身' : st.kind === 'cooldown' ? '放松' : '正式';
    const itemsHtml = (st.items || []).map((it) => {
      const sets = expandSets(it);
      const rows = sets.map((s, k) => {
        const target = targetText(s, it.mode) || '自由发挥';
        return `<div class="row is-between" style="padding:2px 0">
          <span class="muted">第 ${k + 1} 组</span>
          <span style="text-align:right">${esc(target)}</span>
        </div>`;
      }).join('');

      const extras = [`组间歇 ${restText(it.defaultRestMs)}`];

      return `<div class="card-soft is-flat stack">
        <div class="row is-between">
          <strong>${esc(it.name || '未命名动作')}</strong>
          <span class="chip">${esc(modeLabel[it.mode] || '按次数')}</span>
        </div>
        ${rows}
        <div class="muted" style="font-size:12px">${esc(extras.join(' · '))}</div>
      </div>`;
    }).join('');

    return `<div class="stack">
      <div class="row is-between">
        <strong>${esc(kind)}${st.name && st.name !== kind ? ' · ' + esc(st.name) : ''}</strong>
      </div>
      ${itemsHtml}
    </div>`;
  }).join('');

  openSheet({
    title: '查看计划',
    body: `<div class="stack">
      <div class="card-soft is-flat stack">
        <div class="row is-between">
          <strong>${esc(plan.name)}</strong>
          <span class="chip is-on ${categoryClass(plan.category)}">${esc(categoryLabel(plan.category))}</span>
        </div>
        <div class="muted">共 ${tl.length} 组</div>
        ${plan.note ? `<p class="muted">${esc(plan.note)}</p>` : ''}
      </div>
      ${stagesHtml}
    </div>`,
    footer: '<button class="btn-sticker is-big is-ghost" data-close-view>关闭</button>',
    onMount: ({ $ }) => {
      $('[data-close-view]').addEventListener('click', closeSheet);
    },
  });
}

/* ---------------------------------------------------------------- 编辑器 */

function openEditor(store, draft, onSaved) {
  if (!draft.stages) draft.stages = [newStage('main')];
  let rerender = () => {};

  const render = () => {
    const body = `
      <div class="stack">
        <label class="stack" style="gap:4px">
          <span class="muted">计划名称</span>
          <input data-path="name" value="${esc(draft.name)}" style="${inputStyle()}">
        </label>

        <div class="stack" style="gap:6px">
          <span class="muted">训练类别</span>
          <input data-path="category" value="${esc(categoryLabel(draft.category))}" placeholder="类别" style="${inputStyle()}">
          <div class="row" style="gap:6px;flex-wrap:wrap">
            ${knownCategories(store).map((c) => `<button class="chip is-longpress ${categoryLabel(draft.category) === c ? 'is-on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
          </div>
          <span class="muted" style="font-size:11px">填过的会记住，下次点一下复用；<b>长按</b>某个类别可以把它删掉。</span>
        </div>

        <label class="stack" style="gap:4px">
          <span class="muted">备注</span>
          <textarea data-path="note" rows="2" style="${inputStyle()}">${esc(draft.note || '')}</textarea>
        </label>

        ${draft.stages.map((st, si) => renderStage(st, si)).join('')}

        <button class="btn-sticker is-ghost" data-add-stage>${icon('plus', 16)} 添加阶段</button>
      </div>`;

    openSheet({
      title: draft.id ? '编辑计划' : '新建计划',
      body,
      footer: `<div class="stack">
        <button class="btn-sticker is-big is-accent" data-save>保存计划</button>
        <button class="btn-sticker is-big is-ghost" data-cancel>取消</button>
      </div>`,
      onMount: (handle) => {
        const $ = handle.$;
        // 文本/数值输入：只写回 draft、不整页重绘（否则会丢焦点）
        handle.root.querySelectorAll('[data-path]').forEach((input) => {
          input.addEventListener('input', () => {
            const path = input.dataset.path;
            if (input.dataset.num !== '1') { setPath(draft, path, input.value); return; }
            let v = toNumOrNull(input.value) ?? 0;
            // 界面上按「秒」填的间歇字段，模型里统一存毫秒，避免两套单位混用
            if (input.dataset.sec === '1') v *= 1000;
            setPath(draft, path, v);
          });
        });

        handle.root.querySelectorAll('[data-cat]').forEach((b) => {
          b.addEventListener('click', () => { draft.category = b.dataset.cat; rerender(); });
          onLongPress(b, async () => {
            await forgetCategoryWithConfirm(store, b.dataset.cat, () => {
              // 删掉的正好是当前选中时，顺手退到一个还存在的类别，别让 draft 悬空
              if (categoryLabel(draft.category) === b.dataset.cat) {
                draft.category = knownCategories(store)[0] || '';
              }
            });
            // ⚠ 确认框是另开的一个弹层，而 openSheet 会先把当前这层关掉 ——
            // 所以不管用户是「删除」还是「取消」，编辑器都会被顺手关掉。
            // 不管哪种结果都把编辑器重新摆回去：
            // 否则点「取消」会发现整个编辑器没了，刚才的改动全丢。
            rerender();
          });
        });

        $('[data-add-stage]').addEventListener('click', () => {
          draft.stages.push(newStage(draft.stages.length ? 'main' : 'warmup'));
          rerender();
        });

        bindStructural(handle);

        $('[data-save]').addEventListener('click', () => save());
        $('[data-cancel]').addEventListener('click', closeSheet);
      },
    });
  };

  function renderStage(st, si) {
    const kindChips = ['warmup', 'main', 'cooldown'].map((k) => {
      const lbl = k === 'warmup' ? '热身' : k === 'cooldown' ? '放松' : '正式';
      return `<button class="chip ${st.kind === k ? 'is-on' : ''}" data-stage-kind="${si}" data-k="${k}">${lbl}</button>`;
    }).join('');

    return `<div class="card-soft stack" data-stage="${si}">
      <div class="row is-between">
        <div class="row" style="gap:6px">${kindChips}</div>
        <button class="chip" data-del-stage="${si}">${icon('trash', 16)}</button>
      </div>
      <input data-path="stages.${si}.name" value="${esc(st.name || '')}" placeholder="阶段名称" style="${inputStyle()}">
      ${(st.items || []).map((it, ii) => renderItem(it, si, ii)).join('')}
      <button class="btn-sticker is-sm is-ghost" data-add-item="${si}">${icon('plus', 16)} 添加动作</button>
    </div>`;
  }

  function renderItem(it, si, ii) {
    const per = isPerSet(it);
    const n = setCount(it);
    const proto = setProto(it);
    const mode = it.mode || 'reps';

    const modeChips = ['reps', 'duration', 'distance'].map((m) =>
      `<button class="chip ${mode === m ? 'is-on' : ''}" data-item-mode="${si}.${ii}" data-m="${m}">${MODE_LABEL[m]}</button>`).join('');

    const targetFields = (obj, path) => {
      if (mode === 'reps') {
        return `${numField('次数', `${path}.reps`, obj.reps)}
                ${numField('重量 kg', `${path}.weightKg`, obj.weightKg)}`;
      }
      if (mode === 'duration') {
        return numField('时长（秒）', `${path}.durationS`, obj.durationS);
      }
      return `${numField('距离 km', `${path}.distanceKm`, obj.distanceKm)}
              ${numField('配速 秒/km', `${path}.paceSPerKm`, obj.paceSPerKm)}`;
    };

    return `<div class="card-soft is-flat stack" data-item="${si}.${ii}">
      <div class="row is-between">
        <input data-path="stages.${si}.items.${ii}.name" value="${esc(it.name || '')}" placeholder="动作名称" style="${inputStyle()};flex:1">
        <button class="chip" data-del-item="${si}.${ii}">${icon('trash', 16)}</button>
      </div>
      <div class="row" style="gap:6px;flex-wrap:wrap">${modeChips}</div>

      ${per ? '' : `
      <label class="stack" style="gap:4px">
        <span class="muted">组数</span>
        <input data-num="1" data-path="stages.${si}.items.${ii}.sets.repeat" type="number" inputmode="numeric"
          value="${n}" style="${inputStyle()}">
      </label>`}

      ${per
        ? (it.sets || []).map((s, k) => `
          <div class="card-soft is-flat stack" style="background:var(--bg-2)">
            <div class="row is-between"><span class="muted">第 ${k + 1} 组</span>
              <button class="chip" data-del-set="${si}.${ii}">${icon('trash', 14)}</button></div>
            <div class="row" style="gap:8px">${targetFields(s, `stages.${si}.items.${ii}.sets.${k}`)}</div>
          </div>`).join('')
        : `<div class="row" style="gap:8px">${targetFields(proto, `stages.${si}.items.${ii}.sets.of`)}</div>`}

      <div class="row" style="gap:6px;flex-wrap:wrap">
        <button class="chip" data-toggle-perset="${si}.${ii}">${per ? '简化为统一组' : '展开逐组编辑'}</button>
        ${per ? `<button class="chip" data-add-set="${si}.${ii}">${icon('plus', 14)} 加一组</button>` : ''}
      </div>

      ${numField('组间歇（秒）', `stages.${si}.items.${ii}.defaultRestMs`, Math.round((it.defaultRestMs || 0) / 1000), true,
        '每做完一组都按它休息；个别组想临时改，训练中点「灵活调整」。')}
    </div>`;
  }

  /** sec=true 表示这个字段界面上填的是「秒」，写回 draft 时会 ×1000 存成毫秒 */
  function numField(label, path, displayValue, sec = false, hint = '') {
    return `<label class="stack" style="gap:4px;flex:1">
      <span class="muted">${esc(label)}</span>
      <input data-num="1" ${sec ? 'data-sec="1"' : ''} data-path="${path}" type="number" inputmode="numeric"
        value="${displayValue == null || displayValue === '' ? '' : Math.round(displayValue)}" style="${inputStyle()}">
      ${hint ? `<span class="muted" style="font-size:11px;line-height:1.35">${esc(hint)}</span>` : ''}
    </label>`;
  }

  function inputStyle() {
    return 'padding:12px;border:2.5px solid var(--line);border-radius:16px;background:#fff;width:100%;font-weight:600';
  }

  /** 结构类操作：改完整体重绘 */
  function bindStructural(handle) {
    const root = handle.root;

    root.querySelectorAll('[data-stage-kind]').forEach((b) => b.addEventListener('click', () => {
      const si = Number(b.dataset.stageKind);
      draft.stages[si].kind = b.dataset.k;
      draft.stages[si].name = b.dataset.k === 'warmup' ? '热身' : b.dataset.k === 'cooldown' ? '放松' : '正式组';
      rerender();
    }));

    root.querySelectorAll('[data-del-stage]').forEach((b) => b.addEventListener('click', () => {
      draft.stages.splice(Number(b.dataset.delStage), 1);
      rerender();
    }));

    root.querySelectorAll('[data-add-item]').forEach((b) => b.addEventListener('click', () => {
      draft.stages[Number(b.dataset.addItem)].items.push(newItem(categoryTheme(draft.category) === 'cardio' ? 'distance' : 'reps'));
      rerender();
    }));

    root.querySelectorAll('[data-del-item]').forEach((b) => b.addEventListener('click', () => {
      const [si, ii] = b.dataset.delItem.split('.').map(Number);
      draft.stages[si].items.splice(ii, 1);
      rerender();
    }));

    root.querySelectorAll('[data-item-mode]').forEach((b) => b.addEventListener('click', () => {
      const [si, ii] = b.dataset.itemMode.split('.').map(Number);
      const it = draft.stages[si].items[ii];
      it.mode = b.dataset.m;
      const fresh = b.dataset.m === 'reps' ? { reps: 8, weightKg: 0 }
        : b.dataset.m === 'duration' ? { durationS: 60 } : { distanceKm: 5 };
      if (isPerSet(it)) it.sets = it.sets.map(() => ({ ...fresh }));
      else it.sets = { repeat: it.sets.repeat || 1, of: fresh };
      rerender();
    }));

    root.querySelectorAll('[data-toggle-perset]').forEach((b) => b.addEventListener('click', () => {
      const [si, ii] = b.dataset.togglePerset.split('.').map(Number);
      const it = draft.stages[si].items[ii];
      if (isPerSet(it)) {
        const proto = { ...(it.sets[0] || {}) };
        delete proto.restAfterMs;
        it.sets = { repeat: Math.max(1, it.sets.length), of: proto };
      } else {
        it.sets = Array.from({ length: Math.max(1, it.sets.repeat || 1) }, () => ({ ...(it.sets.of || {}) }));
      }
      rerender();
    }));

    root.querySelectorAll('[data-add-set]').forEach((b) => b.addEventListener('click', () => {
      const [si, ii] = b.dataset.addSet.split('.').map(Number);
      const it = draft.stages[si].items[ii];
      it.sets.push({ ...(it.sets[it.sets.length - 1] || {}) });
      rerender();
    }));

    root.querySelectorAll('[data-del-set]').forEach((b) => b.addEventListener('click', () => {
      const [si, ii] = b.dataset.delSet.split('.').map(Number);
      const it = draft.stages[si].items[ii];
      if (it.sets.length <= 1) { toast('至少留一组'); return; }
      it.sets.pop();
      rerender();
    }));
  }

  /** 保存前清洗：单位在输入时就已统一为毫秒，这里只做兜底与一致性修正 */
  function normalize() {
    const clean = (v) => Math.max(0, Math.round(Number(v) || 0));
    draft.stages.forEach((st) => {
      // 已废弃的多级间歇字段：老计划再保存一次就自动清干净（模型已不再读它们）
      delete st.restAfterStageMs;
      (st.items || []).forEach((it) => {
        it.defaultRestMs = clean(it.defaultRestMs);
        delete it.lastSetRestMs;
        delete it.restAfterItemMs;
        if (isPerSet(it)) {
          it.sets.forEach((s) => { delete s.restAfterMs; });
        } else if (it.sets && it.sets.of) {
          delete it.sets.of.restAfterMs;
        }
        if (!it.name || !it.name.trim()) it.name = '未命名动作';
      });
    });
  }

  function save() {
    if (!draft.name || !draft.name.trim()) { toast('给计划起个名字吧'); return; }
    const hasItem = draft.stages.some((s) => (s.items || []).length);
    if (!hasItem) { toast('至少添加一个动作'); return; }

    // 类别：去空格；老的 strength/cardio 归一成中文；顺手记进"用过的类别"
    const rawCat = String(draft.category == null ? '' : draft.category).trim();
    draft.category = rawCat ? categoryLabel(rawCat) : '力量';
    store.rememberCategory(draft.category);

    normalize();
    const saved = store.savePlan(JSON.parse(JSON.stringify(draft)));
    closeSheet();
    toast(`已保存「${saved.name}」`);
    if (onSaved) onSaved();
  }

  // 让内部结构操作能触达重绘
  rerender = () => { closeSheet(); render(); };
  render();
}

/* -------------------------------------------------- 计划详情/预览（备用） */

export function planSummary(plan) {
  const tl = buildTimeline(plan);
  return (plan.stages || []).map((st) => {
    const items = (st.items || []).map((it) => `${it.name} ×${expandSets(it).length}`).join('、');
    return `${st.name || st.kind}：${items}`;
  }).join('\n') + `\n共 ${tl.length} 组`;
}
