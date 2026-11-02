/**
 * ui.js —— 界面公共件：图标、吉祥物、底部弹层、轻提示。
 * 全部内联 SVG + 原生 DOM，零第三方依赖，离线可用。
 */

import { esc } from './util.js';
import { setKeyboardMode } from './native.js';
export { esc };

/* ------------------------------------------------------------------ 图标 */

const ICONS = {
  plans: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  train: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 11h18"/>',
  stats: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  play: '<path d="M7 4l12 8-12 8z" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  skip: '<path d="M6 5l9 7-9 7zM18 5v14"/>',
  fire: '<path d="M12 3c3 4 5 6 5 9a5 5 0 01-10 0c0-3 2-5 5-9z"/>',
  thigh: '<path d="M6 4v7a6 6 0 006 6h6M6 11h5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  // 三根带滑块的横杆（"调节/设置"），刻意不用齿轮+放射线那种——那看着像太阳
  settings: '<path d="M4 7h16M4 12h16M4 17h16"/>'
    + '<circle cx="9" cy="7" r="2.6" fill="#fff"/>'
    + '<circle cx="15" cy="12" r="2.6" fill="#fff"/>'
    + '<circle cx="8" cy="17" r="2.6" fill="#fff"/>',
  download: '<path d="M12 4v11M7 12l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 20V9M7 12l5-5 5 5M4 4h16"/>',
  note: '<path d="M6 3h9l5 5v13H6zM15 3v5h5"/>',
  // 月牙：标休息日用
  moon: '<path d="M20.5 14.3A8.5 8.5 0 019.7 3.5a8.5 8.5 0 1010.8 10.8z"/>',
};

export function icon(name, size = 24) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/* --------------------------------------------------------------- 吉祥物 */

/** 圆滚滚的小熊。mood: 'ready' | 'rest' | 'done' */
export function mascot(mood = 'ready', size = 140) {
  const belly = mood === 'rest' ? '#7ed9c0' : mood === 'done' ? '#ffd166' : '#ff8fa3';
  const eyes = mood === 'done'
    ? '<path d="M45 46 q4 -5 8 0" fill="none" stroke="#4a3f55" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M67 46 q4 -5 8 0" fill="none" stroke="#4a3f55" stroke-width="3" stroke-linecap="round"/>'
    : '<circle cx="49" cy="46" r="3.6" fill="#4a3f55"/><circle cx="71" cy="46" r="3.6" fill="#4a3f55"/>';
  const mouth = mood === 'done'
    ? '<path d="M53 57 q7 7 14 0" fill="none" stroke="#4a3f55" stroke-width="3" stroke-linecap="round"/>'
    : '<path d="M55 57 q5 5 10 0" fill="none" stroke="#4a3f55" stroke-width="3" stroke-linecap="round"/>';
  const zzz = mood === 'rest'
    ? '<text x="92" y="34" font-size="14" fill="#8a7e95" font-weight="700">z</text>' +
      '<text x="102" y="24" font-size="11" fill="#b9aec3" font-weight="700">z</text>'
    : '';
  return `<svg viewBox="0 0 120 120" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="36" cy="30" r="13" fill="#e0b088" stroke="#4a3f55" stroke-width="3"/>
    <circle cx="84" cy="30" r="13" fill="#e0b088" stroke="#4a3f55" stroke-width="3"/>
    <circle cx="60" cy="50" r="30" fill="#f0c9a4" stroke="#4a3f55" stroke-width="3"/>
    ${eyes}
    <ellipse cx="41" cy="57" rx="6" ry="4" fill="#ffb3c1" opacity=".85"/>
    <ellipse cx="79" cy="57" rx="6" ry="4" fill="#ffb3c1" opacity=".85"/>
    ${mouth}
    <path d="M38 96 q0-24 22-24 t22 24 z" fill="${belly}" stroke="#4a3f55" stroke-width="3"/>
    <g stroke="#4a3f55" stroke-width="3" stroke-linecap="round">
      <line x1="28" y1="86" x2="92" y2="86"/>
      <rect x="18" y="78" width="12" height="16" rx="4" fill="#8ecae6"/>
      <rect x="90" y="78" width="12" height="16" rx="4" fill="#8ecae6"/>
    </g>
    <circle cx="30" cy="86" r="6" fill="#f0c9a4" stroke="#4a3f55" stroke-width="3"/>
    <circle cx="90" cy="86" r="6" fill="#f0c9a4" stroke="#4a3f55" stroke-width="3"/>
    ${zzz}
  </svg>`;
}

export function emptyState(title, hint = '', mood = 'ready') {
  return `<div class="empty">${mascot(mood, 110)}<h3>${esc(title)}</h3>
    ${hint ? `<p class="muted">${esc(hint)}</p>` : ''}</div>`;
}

/* ------------------------------------------------------------- 底部弹层 */

let currentSheet = null;

export function closeSheet() {
  if (currentSheet && currentSheet.parentNode) currentSheet.parentNode.removeChild(currentSheet);
  currentSheet = null;
  // 弹层关掉后不再需要给键盘让位：继续让位会把 WebView 压矮，把底栏顶上去
  setKeyboardMode(false);
}

/**
 * 打开底部弹层。
 * 返回 { root, close }；root 里可以直接 querySelector 绑事件。
 * 点遮罩关闭；点弹层本身不关。
 */
export function openSheet({ title = '', body = '', footer = '', dismissible = true, onMount } = {}) {
  closeSheet();
  const mask = document.createElement('div');
  mask.className = 'sheet-mask';
  mask.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      ${title ? `<div class="row is-between" style="margin-bottom:12px">
        <h3>${esc(title)}</h3>
        ${dismissible ? `<button class="chip" data-close aria-label="关闭">${icon('close', 18)}</button>` : ''}
      </div>` : ''}
      <div data-body>${body}</div>
      ${footer ? `<div data-footer style="margin-top:16px">${footer}</div>` : ''}
    </div>`;
  mask.addEventListener('click', (e) => {
    if (e.target === mask && dismissible) closeSheet();
  });
  const btn = mask.querySelector('[data-close]');
  if (btn) btn.addEventListener('click', closeSheet);
  document.body.appendChild(mask);
  // 弹层打开时告诉原生「把键盘高度并进 WebView 底边距」——
  // 否则弹层（挂在 body 上，不在 .screen 里）会被系统键盘盖住，
  // 弹层里的输入框看不见也点不着。
  // 以前只有 closeSheet 会调 setKeyboardMode(false)，true 从来没发出去过，
  // 原生那边专门为此写的 IME inset 机制等于从没启用。
  setKeyboardMode(true);
  currentSheet = mask;
  const api = {
    root: mask,
    close: closeSheet,
    $: (sel) => mask.querySelector(sel),
    $$: (sel) => Array.from(mask.querySelectorAll(sel)),
  };
  if (onMount) onMount(api);
  return api;
}

/** 二次确认，返回 Promise<boolean>（删除记录这类不可逆操作用） */
export function confirmSheet({ title = '确认', message = '', okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeSheet(); resolve(v); };
    openSheet({
      title,
      // 必须不可点遮罩关闭：否则 Promise 永远不会 resolve，调用处的 await 会一直挂着
      dismissible: false,
      body: `<p class="muted">${esc(message)}</p>`,
      footer: `<div class="stack">
        <button class="btn-sticker is-big ${danger ? '' : 'is-accent'}" data-ok
          ${danger ? 'style="border-color:var(--danger-dk);box-shadow:0 4px 0 var(--danger-dk);background:var(--danger);color:#fff"' : ''}>${esc(okText)}</button>
        <button class="btn-sticker is-big is-ghost" data-cancel>${esc(cancelText)}</button>
      </div>`,
      onMount: ({ $ }) => {
        $('[data-ok]').addEventListener('click', () => finish(true));
        $('[data-cancel]').addEventListener('click', () => finish(false));
      },
    });
  });
}

/* ------------------------------------------------------------- 轻提示 */

let toastTimer = null;
export function toast(message, ms = 2200) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = `position:fixed;left:50%;bottom:88px;transform:translateX(-50%);
      background:#4a3f55;color:#fff;padding:10px 18px;border-radius:999px;
      font-size:14px;z-index:99;max-width:86vw;text-align:center;
      box-shadow:0 6px 18px rgba(74,63,85,.28);pointer-events:none`;
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, ms);
}

/* --------------------------------------------------------------- 小工具 */

export function stepLabel(step) {
  if (!step) return '';
  const n = step.setTotal > 1 ? `第 ${step.setIndex + 1}/${step.setTotal} 组` : '单组';
  return n;
}

/** 老数据里的两个英文旧值 → 中文 */
const CATEGORY_ALIASES = { strength: '力量', cardio: '有氧' };

/**
 * 类别显示名。
 * 类别现在是**用户自由输入**的文本，但早期版本存的是 strength/cardio 两个 id，
 * 这里统一兜成中文，老计划不用迁移也能正常显示。
 */
export function categoryLabel(category) {
  const c = String(category == null ? '' : category).trim();
  if (!c) return '力量';
  return CATEGORY_ALIASES[c.toLowerCase()] || c;
}

/**
 * 用哪套配色。
 * 类别可以随便起名，所以按关键词判断：像"跑/骑行/游泳"这种归到有氧（薄荷绿），
 * 其余一律力量色（珊瑚粉）。不追求给每个类别都配一种颜色 —— 那要维护一张调色板，
 * 收益不值当。
 */
export function categoryTheme(category) {
  const c = categoryLabel(category).toLowerCase();
  const cardioWords = ['有氧', '跑', '走', '骑行', '单车', '游泳', '跳绳', '划船', '椭圆', '攀爬', '爬楼'];
  return cardioWords.some((w) => c.includes(w)) ? 'cardio' : 'strength';
}

/** 上面那套配色的 CSS 类名 */
export function categoryClass(category) {
  return categoryTheme(category) === 'cardio' ? 'is-cardio' : 'is-strength';
}

/** 目标的一句话描述，列表里显示用 */
export function targetText(spec, mode) {
  if (!spec) return '';
  const parts = [];
  if (spec.reps != null) parts.push(`${spec.reps} 次`);
  if (spec.weightKg != null && spec.weightKg > 0) parts.push(`${spec.weightKg} kg`);
  if (spec.durationS != null) parts.push(spec.durationS >= 60 ? `${Math.round(spec.durationS / 60)} 分钟` : `${spec.durationS} 秒`);
  if (spec.distanceKm != null) parts.push(`${spec.distanceKm} km`);
  if (spec.paceSPerKm != null) parts.push(`${paceText(spec.paceSPerKm)}/km`);
  return parts.join(' · ');
}

export function paceText(secPerKm) {
  if (secPerKm == null) return '';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s < 10 ? '0' + s : s}`;
}
