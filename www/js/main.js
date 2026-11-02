/**
 * main.js —— 应用入口：装存储、铺示例、Tab 路由、训练会话编排、设置。
 */

import { initBrowserStore, SCHEMA_VERSION } from './store.js';
import { seedPlans, shouldSeed } from './seed.js';
import { localDateKey } from './util.js';
import { sessionFromPlan, upsertDay } from './model.js';
import { esc, openSheet, closeSheet, toast, confirmSheet, emptyState, categoryLabel, categoryClass, mascot } from './ui.js';
import { renderPlans } from './views/plans.js';
import { createPlayer } from './views/train.js';
import { renderCalendar } from './views/calendar.js';
import { renderStats, openSessionDetail } from './views/history.js';
import { stopNotification, isNative, consumeOpenTrain } from './native.js';

/* ------------------------------------------------------------------ 启动 */

const store = initBrowserStore();

// 只在「第一次装 App」时铺示例：用 meta.seeded 标记，
// 否则用户把示例删光后下次启动又会冒出来，很烦人。
try {
  const meta = store.getMeta();
  if (!meta.seeded) {
    if (shouldSeed(store.listPlans())) seedPlans().forEach((p) => store.savePlan(p));
    store.saveMeta({ ...meta, seeded: true });
  }
} catch (e) {
  console.warn('[main] 首次铺示例失败（不影响使用）', e);
}

const app = { tab: 'plans', player: null, playerStarted: false, session: null };

const screen = document.getElementById('screen');
const tabbar = document.getElementById('tabbar');

/* --------------------------------------------------------------- Tab 路由 */

function switchTab(tab) {
  app.tab = tab;
  Array.from(tabbar.querySelectorAll('[data-tab]')).forEach((b) => {
    b.classList.toggle('is-on', b.dataset.tab === tab);
  });
  renderTab();
}

function renderTab() {
  if (app.tab !== 'train' && app.player) {
    // 离开训练页不销毁播放器（计时与通知要继续），只是不再显示
  }
  if (app.tab === 'plans') return renderPlans(screen, { store, onStart: startPlan });
  if (app.tab === 'train') return renderTrainTab();
  if (app.tab === 'calendar') {
    return renderCalendar(screen, { store, onOpenSession: (id) => openSessionDetail(store, id, renderTab) });
  }
  if (app.tab === 'stats') {
    return renderStats(screen, { store, onOpenSession: (id) => openSessionDetail(store, id, renderTab) });
  }
}

tabbar.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});

/* --------------------------------------------------------------- 训练页 */

function renderTrainTab() {
  if (app.player) {
    screen.innerHTML = '';
    screen.appendChild(app.player.root);
    if (!app.playerStarted) { app.playerStarted = true; app.player.start(); }
    return;
  }

  const ongoing = store.getOngoing();
  const plans = store.listPlans();
  const today = localDateKey();
  const todayDone = store.allSessions().filter((s) => s.dateKey === today);

  screen.innerHTML = `
    ${ongoing ? `<div class="card-soft stack" style="margin-bottom:12px">
      <div class="row is-between"><strong>上次训练还没结束</strong>
        <span class="muted">已记 ${ongoing.entries ? ongoing.entries.length : 0} 组</span></div>
      <div class="muted">${esc(ongoing.planSnapshot ? ongoing.planSnapshot.name : '训练')} · ${esc(ongoing.dateKey)}</div>
      <div class="row" style="gap:8px">
        <button class="btn-sticker is-sm is-accent" data-resume>继续这次训练</button>
        <button class="btn-sticker is-sm is-ghost" data-discard>放弃并保存</button>
      </div>
    </div>` : ''}

    ${todayDone.length ? `<div class="card-soft stack" style="margin-bottom:12px">
      <strong>今天已练 ${todayDone.length} 次</strong>
      ${todayDone.map((s) => `<div class="muted">· ${esc(s.planName || '训练')}（${(s.entries || []).length} 组）</div>`).join('')}
      <button class="chip" data-open-today>查看并记感受</button>
    </div>` : ''}

    <h3 style="margin:8px 0">选一个计划开始</h3>
    ${!plans.length ? emptyState('还没有计划', '点「新建计划」建一个，或者先把内置示例当模板改') : ''}
    <div class="stack">
      ${plans.map((p) => `<button class="btn-sticker is-big ${categoryClass(p.category)}" data-start="${esc(p.id)}">
        ${esc(p.name)}
        <span style="font-weight:600;opacity:.85;font-size:13px">${esc(categoryLabel(p.category))}</span>
      </button>`).join('')}
    </div>
    ${!isNative() ? `<p class="muted center" style="margin-top:16px">当前是浏览器预览：组间歇倒计时只在页面内计时，通知栏计时卡要装到手机上才有</p>` : ''}
  `;

  const resume = screen.querySelector('[data-resume]');
  if (resume) {
    resume.addEventListener('click', () => {
      ongoing.status = 'ongoing';
      mountPlayer(ongoing);
    });
  }
  const discard = screen.querySelector('[data-discard]');
  if (discard) {
    discard.addEventListener('click', async () => {
      if (await confirmSheet({ title: '放弃这次训练', message: '已记录的组会保存下来。', okText: '放弃并保存' })) {
        finalizeSession(ongoing, { openFeedback: false });
      }
    });
  }
  const openToday = screen.querySelector('[data-open-today]');
  if (openToday) openToday.addEventListener('click', () => openSessionDetail(store, todayDone[0].id, renderTab));

  screen.querySelectorAll('[data-start]').forEach((b) => {
    b.addEventListener('click', () => {
      const plan = store.getPlan(b.dataset.start);
      if (!plan) return;
      startPlan(plan);
    });
  });
}

function startPlan(plan) {
  if (app.player) { toast('先结束当前这次训练'); return; }
  const session = sessionFromPlan(plan);
  store.saveOngoing(session);
  mountPlayer(session);
}

function mountPlayer(session) {
  app.session = session;
  app.playerStarted = false;
  app.player = createPlayer({
    store,
    session,
    onExit: () => {
      // 回首页但不销毁：计时/通知继续，稍后可从「继续这次训练」回来
      dropPlayer();
      switchTab('plans');
    },
    onFinish: (s) => finalizeSession(s, { openFeedback: true }),
    onDiscarded: () => {
      dropPlayer();
      app.session = null;
      switchTab('train');
      toast('本次训练已丢弃，没有留下记录');
    },
  });
  switchTab('train');
}

/**
 * 丢掉播放器。
 *
 * **一定要 destroy**：播放器的 250ms ticker 只在 destroy 里清，
 * 而 createPlayer 返回的 destroy 以前全项目没人调用 ——
 * 于是每练完一次训练就漏一个 4Hz 的定时器，持续唤醒 CPU，
 * 还把整份 session 对象钉在内存里。
 */
function dropPlayer() {
  if (app.player && typeof app.player.destroy === 'function') {
    try { app.player.destroy(); } catch (e) { console.warn('[main] 销毁播放器失败', e); }
  }
  app.player = null;
  app.playerStarted = false;
}

/**
 * 启动时若上次训练没结束，立刻弹出来问 —— 不用用户自己切到「训练」页去找。
 * 三个选项对应「继续 / 结束并保存 / 结束，并不保存」。
 */
function promptResume(ongoing) {
  const doneCount = (ongoing.entries || []).length;
  const total = (ongoing.timeline || []).length;
  openSheet({
    title: '上次训练还没结束',
    // 不设可点遮罩关闭：这是启动时的主决策，必须明确选一个
    dismissible: false,
    body: `<div class="stack">
      <div class="card-soft is-flat stack">
        <strong>${esc(ongoing.planSnapshot ? ongoing.planSnapshot.name : '训练')}</strong>
        <div class="muted">${esc(ongoing.dateKey)} · 已完成 ${doneCount}/${total} 组</div>
      </div>
      <p class="muted">「继续」接着往下练；两个结束选项一个会存记录、一个直接丢掉。</p>
    </div>`,
    footer: `<div class="stack">
      <button class="btn-sticker is-big is-accent" data-resume>继续这次训练</button>
      <button class="btn-sticker is-big is-ghost" data-save>结束并保存</button>
      <button class="btn-sticker is-big is-ghost" data-discard
        style="border-color:var(--danger-dk);box-shadow:0 4px 0 var(--danger-dk);color:var(--danger-dk)">结束，并不保存</button>
    </div>`,
    onMount: ({ $ }) => {
      $('[data-resume]').addEventListener('click', () => {
        closeSheet();
        ongoing.status = 'ongoing';
        mountPlayer(ongoing);
      });
      $('[data-save]').addEventListener('click', () => {
        closeSheet();
        finalizeSession(ongoing, { openFeedback: false });
      });
      $('[data-discard]').addEventListener('click', async () => {
        const ok = await confirmSheet({
          title: '确定不保存？',
          message: '本次训练已记录的组会全部丢弃，无法恢复。',
          okText: '丢弃并结束',
          danger: true,
        });
        if (!ok) return;
        closeSheet();
        store.clearOngoing();
        stopNotification();
        toast('已丢弃，没有留下记录');
        switchTab('train');
      });
    },
  });
}

/** 收尾：落库 + 写日程 + 停通知（可重复调用，按 id 覆盖） */
function finalizeSession(session, { openFeedback = true } = {}) {
  if (!session.endedAt) session.endedAt = Date.now();
  if (session.status === 'ongoing') {
    session.status = session.entries && session.entries.length ? 'done' : 'aborted';
  }
  store.finishSession(session);

  // 日程自动记录：练了哪天就写哪天（跨零点归开始日）
  try {
    const sched = store.getSchedule();
    // 一组都没做完的「结束并保存」不该把这天标成「已练」：
    // 否则日历上会出现实心圆点、日程显示「已练」，可那天其实什么也没练。
    if ((session.entries || []).length > 0) {
      upsertDay(sched, session.dateKey, { sessionId: session.id });
      store.saveSchedule(sched);
    }
  } catch (e) {
    console.warn('[main] 写日程失败', e);
  }

  stopNotification();
  dropPlayer();
  app.session = null;

  switchTab('train');
  if (openFeedback) {
    setTimeout(() => openSessionDetail(store, session.id, renderTab), 120);
  } else {
    toast('已保存');
  }
}

/* ------------------------------------------------------------------ 设置 */

document.getElementById('btn-settings').addEventListener('click', openSettings);

function openSettings() {
  const s = store.getSettings();
  const usage = store.usage();
  let exportText = '';
  try { exportText = JSON.stringify(store.exportAll()); } catch (e) { exportText = ''; }

  openSheet({
    title: '设置',
    body: `
      <div class="stack">
        <label class="stack" style="gap:4px">
          <span class="muted">自动兜底秒数</span>
          <input data-timeout type="number" inputmode="numeric" value="${Math.round((s.confirmTimeoutMs || 0) / 1000)}"
            style="padding:12px;border:2.5px solid var(--line);border-radius:16px;width:100%">
        </label>
        <p class="muted">超过这个时间没选择，就自动按计划推进并标注「自动」，免得放下手机后根本没在计时。填 0 表示关闭。</p>

        <div class="card-soft is-flat stack">
          <strong>数据备份</strong>
          <p class="muted">数据只存在这台手机上（卸载即清空），建议定期导出留一份。<br>
            当前：${usage.plans} 个计划 · ${usage.sessions} 条训练记录 · 约 ${Math.round(usage.bytes / 1024)} KB</p>
          <button class="btn-sticker is-sm" data-export>导出为文本</button>
          <button class="btn-sticker is-sm is-ghost" data-import>从文本导入</button>
        </div>

        <div class="card-soft is-flat stack">
          <strong>危险操作</strong>
          <button class="btn-sticker is-sm is-ghost" data-wipe style="border-color:var(--danger-dk);box-shadow:0 4px 0 var(--danger-dk);color:var(--danger-dk)">清空全部数据</button>
        </div>
      </div>`,
    footer: `<button class="btn-sticker is-big is-accent" data-save>保存设置</button>`,
    onMount: ({ $ }) => {
      $('[data-save]').addEventListener('click', () => {
        const sec = Math.max(0, Number($('[data-timeout]').value) || 0);
        store.saveSettings({ confirmTimeoutMs: sec * 1000 });
        closeSheet();
        toast('设置已保存');
      });

      $('[data-export]').addEventListener('click', () => {
        openSheet({
          title: '导出备份',
          body: `<div class="stack">
            <p class="muted">下面是全部数据的 JSON。复制后存到备忘录 / 微信文件传输助手 / 电脑上都行。</p>
            <textarea data-out rows="10" style="padding:12px;border:2.5px solid var(--line);border-radius:16px;width:100%;font-size:12px">${esc(exportText)}</textarea>
          </div>`,
          footer: `<div class="stack">
            <button class="btn-sticker is-big is-accent" data-copy>复制全部</button>
            <button class="btn-sticker is-big is-ghost" data-close2>关闭</button>
          </div>`,
          onMount: ({ $: $2 }) => {
            $2('[data-copy]').addEventListener('click', async () => {
              const ta = $2('[data-out]');
              ta.focus(); ta.select();
              try {
                if (navigator.clipboard) await navigator.clipboard.writeText(ta.value);
                else document.execCommand('copy');
                toast('已复制，去粘到别处保存吧');
              } catch (e) {
                toast('复制失败，请长按文本框手动复制');
              }
            });
            $2('[data-close2]').addEventListener('click', () => openSettings());
          },
        });
      });

      $('[data-import]').addEventListener('click', () => {
        openSheet({
          title: '从文本导入',
          body: `<div class="stack">
            <p class="muted">把之前导出的 JSON 粘进来。默认「合并」：已有的记录不会被覆盖。</p>
            <textarea data-in rows="10" style="padding:12px;border:2.5px solid var(--line);border-radius:16px;width:100%;font-size:12px" placeholder='{"format":"exercise-record",...}'></textarea>
            <div class="row" style="gap:8px">
              <button class="chip" data-mode-merge>合并</button>
              <button class="chip" data-mode-replace>全量替换</button>
            </div>
          </div>`,
          footer: `<div class="stack">
            <button class="btn-sticker is-big is-accent" data-do>开始导入</button>
            <button class="btn-sticker is-big is-ghost" data-close3>取消</button>
          </div>`,
          onMount: ({ $: $3, root }) => {
            let mode = 'merge';
            root.querySelectorAll('[data-mode-merge]').forEach((b) => b.classList.add('is-on'));
            $3('[data-mode-merge]').addEventListener('click', () => {
              mode = 'merge';
              $3('[data-mode-merge]').classList.add('is-on');
              $3('[data-mode-replace]').classList.remove('is-on');
            });
            $3('[data-mode-replace]').addEventListener('click', () => {
              mode = 'replace';
              $3('[data-mode-replace]').classList.add('is-on');
              $3('[data-mode-merge]').classList.remove('is-on');
            });
            $3('[data-close3]').addEventListener('click', () => openSettings());
            $3('[data-do]').addEventListener('click', () => {
              try {
                const payload = JSON.parse($3('[data-in]').value);
                const summary = store.importAll(payload, { mode });
                closeSheet();
                toast(`导入完成：计划 ${summary.plans} · 记录 ${summary.sessions} · 日程 ${summary.days} 天`);
                renderTab();
              } catch (e) {
                toast(`导入失败：${e.message}`);
              }
            });
          },
        });
      });

      $('[data-wipe]').addEventListener('click', async () => {
        if (!(await confirmSheet({ title: '清空全部数据', message: '计划、记录、日程全部删除，无法恢复！建议先导出备份。', okText: '确认清空', danger: true }))) return;
        store.wipeAll();
        // seeded 保持 true：清空是用户主动要的，别让示例计划下次启动又长回来
        store.saveMeta({ ...store.getMeta(), schemaVersion: SCHEMA_VERSION, seeded: true });
        closeSheet();
        toast('已清空');
        switchTab('plans');
      });
    },
  });
}

/* ------------------------------------------------- 键盘弹出时的内容让位 */

/**
 * 键盘由系统直接盖在 WebView 上（原生刻意不再压矮 WebView —— 那样贴底的 Tab 栏
 * 会被一起顶上去，这个 bug 出现过）。所以这里自己量：
 * 用 visualViewport 算出键盘高度写进 --kb，让 .screen 多出一段底部空间，
 * 被聚焦的输入框才能滚到键盘上方，不然就是盲打。
 */
(function installKeyboardSpacer() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`);
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
})();

// 聚焦输入框时把它滚到键盘上方（否则键盘盖住的地方看不见也点不着）
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
  setTimeout(() => {
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { /* 忽略 */ }
  }, 260);
});

/* -------------------------------------------------------------------- 启动 */

/**
 * 点常驻训练通知进来 → 直接落到**训练页**。
 *
 * 以前只是把 App 唤回"上次待着的那个页面"（因为 intent 只 target MainActivity），
 * 对一条"训练中 · 第 x/x 组"的常驻通知来说这不够直观。
 *
 * 冷启动：MainActivity.onCreate 里置了标记；热恢复：走 onNewIntent。
 * 两种情况都由这里消费标记 —— 所以启动时和每次回到前台都要查一次。
 */
async function honorOpenTrainRequest() {
  if (!(await consumeOpenTrain())) return false;
  closeSheet();                     // 收起可能开着的弹层（含「继续训练」问询）
  const ongoing = store.getOngoing();
  if (ongoing && !app.player) {
    ongoing.status = 'ongoing';
    mountPlayer(ongoing);           // 直接接着练，不用再点一次「继续」
  } else {
    switchTab('train');
  }
  return true;
}

// 每次回到前台查一次：点通知把 App 从后台唤回时走这条
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') honorOpenTrainRequest();
});

// 启动时若有进行中的训练，直接摆到眼前问一句 ——
// 不用用户自己切到「训练」页去找那张卡片。
const bootOngoing = store.getOngoing();
switchTab(bootOngoing ? 'train' : 'plans');
if (bootOngoing) promptResume(bootOngoing);

// 冷启动就是"点通知进来的"情况：上面的问询会被收掉，直接进训练页
honorOpenTrainRequest();
