/**
 * native.js —— Capacitor 原生桥封装。
 *
 * 关键约定（番茄钟踩过的坑）：**大整数一律用字符串过桥**。
 * Capacitor 的 getDouble 对 org.json 解析成 Long 的大数值会返回 null，
 * 曾导致服务拿到默认值把计时归零。这里统一 String(...) 之后再传给原生。
 *
 * 浏览器预览时没有原生插件：所有方法安全降级为 no-op，
 * 界面照常可用（只是没有通知栏卡片），这样在电脑上就能开发调试。
 */

function cap() {
  return (typeof window !== 'undefined' && window.Capacitor) || null;
}

export function isNative() {
  const c = cap();
  return !!(c && typeof c.isNativePlatform === 'function' && c.isNativePlatform());
}

function timerPlugin() {
  const c = cap();
  return (c && c.Plugins && c.Plugins.RestTimer) || null;
}

/**
 * 把当前计时状态同步给原生，用于刷新通知栏卡片。
 * fire-and-forget：失败也不影响 App 内计时，只记一条 warn。
 */
export async function syncNotification(state) {
  const p = timerPlugin();
  if (!p) return { ok: false, reason: 'no-native' };
  try {
    return await p.update({
      sessionId: String(state.sessionId || ''),
      phase: String(state.phase || ''),
      itemName: String(state.itemName || ''),
      label: String(state.label || ''),
      anchorTs: String(Math.round(state.anchorTs || 0)),
      restEndTs: String(Math.round(state.restEndTs || 0)),
      plannedRestMs: String(Math.round(state.plannedRestMs || 0)),
      confirmDeadline: String(Math.round(state.confirmDeadline || 0)),
    });
  } catch (e) {
    console.warn('[native] syncNotification 失败（不影响 App 内计时）', e);
    return { ok: false, reason: String(e) };
  }
}

export async function stopNotification() {
  const p = timerPlugin();
  if (!p) return { ok: false, reason: 'no-native' };
  try {
    return await p.stop();
  } catch (e) {
    console.warn('[native] stopNotification 失败', e);
    return { ok: false, reason: String(e) };
  }
}

/**
 * 读回原生状态，用于对账：
 *  - 询问阶段被锁屏/切走时，原生可能已经自动套用了计划间歇（autoApplied=true）
 *  - App 被杀后重开，原生可能还在计时
 */
export async function readNativeState() {
  const p = timerPlugin();
  if (!p) return null;
  try {
    const r = await p.getState();
    const raw = r && r.state;
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && obj.sessionId ? obj : null;
  } catch (e) {
    console.warn('[native] readNativeState 失败', e);
    return null;
  }
}

/** 浏览器降级震动；安卓上「休息结束」的震动由前台服务负责 */
export function vibrate(pattern = 200) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (e) { /* 忽略 */ }
}

/* ------------------------------------------------- 到点提醒（必须走原生） */

/**
 * 请原生服务做「休息结束」提醒：震动 + 一条高优先级通知。
 *
 * 为什么必须调它（这个 bug 真踩过）：App 在前台时，JS 的计时器（250ms）会比
 * 原生服务的 1 秒 tick 更早发现休息到点。如果 JS 直接切到下一组，就会把状态推成
 * phase='set'，原生那边的到点检测便永远等不到 restEndTs —— 结果就是
 * **既不震动、也没有「休息结束」通知**。
 *
 * 原生自己保留了一条后台路径（JS 被系统冻结时由它发现到点）；
 * 服务侧用 restEndTs 去重，所以两边同时察觉也只提醒一次。
 */
export async function notifyRestDone(state) {
  const p = timerPlugin();
  if (!p || typeof p.restDone !== 'function') return { ok: false, reason: 'no-native' };
  try {
    await p.restDone({
      sessionId: String(state.sessionId || ''),
      phase: String(state.phase || 'rest'),
      itemName: String(state.itemName || ''),
      label: String(state.label || ''),
      anchorTs: String(Math.round(state.anchorTs || 0)),
      restEndTs: String(Math.round(state.restEndTs || 0)),
      plannedRestMs: String(Math.round(state.plannedRestMs || 0)),
      confirmDeadline: '0',
    });
    return { ok: true };
  } catch (e) {
    console.warn('[native] notifyRestDone 失败（不影响 App 内计时）', e);
    return { ok: false, reason: String(e) };
  }
}

/**
 * 消费「点常驻通知要回到训练页」的标记。
 *
 * 原生在通知的 intent 里带了这个标记（冷启动走 onCreate、热恢复走 onNewIntent），
 * 这里取一次清一次。JS 在启动时和每次回到前台时各查一次 —— 取到就把训练页摆到前面，
 * 而不是像以前那样只把 App 唤回"上次待着的那个页面"。
 */
export async function consumeOpenTrain() {
  const p = timerPlugin();
  if (!p || typeof p.consumeOpenTrain !== 'function') return false;
  try {
    const r = await p.consumeOpenTrain();
    return !!(r && r.open);
  } catch (e) {
    console.warn('[native] consumeOpenTrain 失败', e);
    return false;
  }
}

/**
 * 告诉原生当前是不是"有弹层打开"。
 *
 * 弹层打开时让原生把键盘高度并进 WebView 底边距，弹层里的输入框才不会被键盘盖住；
 * 普通界面则必须让原生**别**压矮 WebView —— 否则贴底的 Tab 栏会被键盘一起顶上去。
 */
export async function setKeyboardMode(sheetOpen) {
  const p = timerPlugin();
  if (!p || typeof p.setKeyboardMode !== 'function') return;
  try {
    await p.setKeyboardMode({ sheetOpen: !!sheetOpen });
  } catch (e) {
    console.warn('[native] setKeyboardMode 失败', e);
  }
}
