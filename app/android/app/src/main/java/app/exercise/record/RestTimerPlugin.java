package app.exercise.record;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 暴露给 JS 的训练计时通知开关（window.Capacitor.Plugins.RestTimer）。
 *
 * 设计要点：**原生只做展示与到点提醒，不做业务判断**。
 * JS 每次状态变化调用 update 把完整状态推下来，服务照着画通知。
 * 两个例外，都是为了避免"前台 JS 抢跑"造成的问题：
 *  1. restDone —— JS 在前台先察觉到休息到点，叫服务来震动 + 发通知
 *     （否则 JS 立刻把状态改成下一组，服务的到点检测永远不触发）。
 *  2. 询问超时兜底（见 RestTimerService.autoApplyPlan）—— 锁屏时 JS 被冻结，
 *     由服务按 confirmDeadline 自动套用计划间歇，JS 回来用 getState 对账。
 *
 * POST_NOTIFICATIONS 只影响通知可不可见，不影响服务能否运行——
 * 未授权时 startForeground 照样成功，所以 fire-and-forget，不阻塞。
 */
@CapacitorPlugin(name = "RestTimer")
public class RestTimerPlugin extends Plugin {

    private static final int NOTIF_PERMISSION_REQUEST_CODE = 0x4523;

    @PluginMethod
    public void update(PluginCall call) {
        ensureNotificationPermission();
        JSONObject s = buildState(call);
        if (s == null) {
            call.reject("bad state");
            return;
        }
        if (s.optString("sessionId").isEmpty()) {
            call.reject("sessionId required");
            return;
        }
        if (!dispatch(RestTimerService.ACTION_UPDATE, s)) {
            // 投递失败（后台启动限制等）：resolve ok:false 而不是 reject，
            // JS 侧 syncNotification 拿到 {ok:false} 就能知道通知没跟上
            call.resolve(failResult("start service rejected"));
            return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /**
     * 休息到点提醒。JS 在前台察觉到点后调用，状态仍是 rest 阶段；
     * 服务用 restEndTs 去重，保证一次休息只震一次、只发一条通知。
     */
    @PluginMethod
    public void restDone(PluginCall call) {
        JSONObject s = buildState(call);
        if (s == null) {
            call.reject("bad state");
            return;
        }
        if (s.optString("sessionId").isEmpty()) {
            call.reject("sessionId required");
            return;
        }
        if (!dispatch(RestTimerService.ACTION_ALERT, s)) {
            call.resolve(failResult("start service rejected"));
            return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            Intent i = new Intent(getContext(), RestTimerService.class)
                .setAction(RestTimerService.ACTION_STOP);
            getContext().startService(i);
        } catch (Exception e) {
            Log.w(RestTimerService.TAG, "stop failed", e);
            call.resolve(failResult("stop request rejected"));
            return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /**
     * 读回原生当前状态（JSON 字符串形式，避免嵌套对象过桥的类型坑）。
     * JS 在恢复训练、以及对账询问兜底时调用。
     */
    @PluginMethod
    public void getState(PluginCall call) {
        JSObject ret = new JSObject();
        String raw = readPersistedState();
        ret.put("state", raw == null ? "" : raw);
        call.resolve(ret);
    }

    /**
     * 消费「点常驻通知要回到训练页」的标记。
     * JS 在启动时、以及每次回到前台各查一次；查到就切到训练页。
     */
    @PluginMethod
    public void consumeOpenTrain(PluginCall call) {
        bridge.executeOnMainThread(() -> {
            JSObject ret = new JSObject();
            ret.put("open", MainActivity.consumePendingOpenTrain());
            call.resolve(ret);
        });
    }

    /**
     * 切换"键盘让位"模式。
     * sheetOpen=true：把键盘高度并进 WebView 底边距 —— 弹层里的输入框不会被键盘盖住。
     * 平时 false：WebView 保持满高，底部 Tab 栏才不会被键盘顶起来。
     */
    @PluginMethod
    public void setKeyboardMode(PluginCall call) {
        boolean sheetOpen = Boolean.TRUE.equals(call.getBoolean("sheetOpen", false));
        bridge.executeOnMainThread(() -> {
            try {
                MainActivity.setImeInsetEnabled(sheetOpen);
                AppCompatActivity act = getActivity();
                if (act instanceof MainActivity) {
                    android.webkit.WebView wv = ((MainActivity) act).getBridge().getWebView();
                    if (wv != null) {
                        androidx.core.view.ViewCompat.requestApplyInsets(wv);
                    }
                }
            } catch (Exception e) {
                Log.w(RestTimerService.TAG, "setKeyboardMode failed", e);
            }
            call.resolve();
        });
    }

    // ------------------------------------------------------------------ 内部

    private JSONObject buildState(PluginCall call) {
        JSONObject s = new JSONObject();
        try {
            putString(s, "sessionId", call.getString("sessionId"));
            putString(s, "stepId", call.getString("stepId"));
            putString(s, "phase", call.getString("phase"));
            putString(s, "itemName", call.getString("itemName"));
            putString(s, "label", call.getString("label"));

            // 数值一律走字符串传桥：Capacitor 的 getDouble 对大整数
            //（org.json 解析为 Long）会返回 null，曾导致服务拿到默认值、
            // 把计时归零。番茄钟踩过这个坑，这里沿用同样的规避。
            putLong(s, "anchorTs", call.getString("anchorTs"));
            putLong(s, "restEndTs", call.getString("restEndTs"));
            putLong(s, "plannedRestMs", call.getString("plannedRestMs"));
            putLong(s, "confirmDeadline", call.getString("confirmDeadline"));
            carryAutoApplied(s, call.getString("sessionId"));
        } catch (JSONException e) {
            Log.w(RestTimerService.TAG, "build state failed", e);
            return null;
        }
        return s;
    }

    /**
     * 把 autoApplied 标记从已持久化的状态里带过来。
     *
     * 这个标记是**原生侧自己写的**：询问超时后 RestTimerService.autoApplyPlan()
     * 置 autoApplied=true 并落盘，JS 回来时靠 getState() 对账、记成 decision='auto'。
     * JS 并不知道这个标记，所以 update() 若每次都写死 false，
     * 就会把服务刚记下的「已自动推进」抹掉，对账随之失效。
     *
     * 换了训练（sessionId 不同）就不带，免得上一场的标记漏进这一场。
     */
    private void carryAutoApplied(JSONObject s, String sessionId) throws JSONException {
        boolean applied = false;
        long appliedAt = 0;
        String raw = readPersistedState();
        if (raw != null && !raw.trim().isEmpty()) {
            try {
                JSONObject prev = new JSONObject(raw);
                if (sessionId != null && !sessionId.isEmpty()
                        && sessionId.equals(prev.optString("sessionId", ""))
                        && s.optString("stepId", "").equals(prev.optString("stepId", ""))) {
                    applied = prev.optBoolean("autoApplied", false);
                    appliedAt = prev.optLong("autoAppliedAt", 0);
                }
            } catch (JSONException e) {
                Log.w(RestTimerService.TAG, "read persisted state failed", e);
            }
        }
        s.put("autoApplied", applied);
        if (applied) {
            s.put("autoAppliedAt", appliedAt);
        }
    }

    /** 读服务落盘的状态（JSON 字符串）；没有就是 null */
    private String readPersistedState() {
        try {
            return getContext()
                .getSharedPreferences(RestTimerService.PREFS, android.content.Context.MODE_PRIVATE)
                .getString(RestTimerService.PREF_KEY, null);
        } catch (Exception e) {
            Log.w(RestTimerService.TAG, "read persisted state failed", e);
            return null;
        }
    }

    private boolean dispatch(String action, JSONObject state) {
        Intent i = new Intent(getContext(), RestTimerService.class)
            .setAction(action)
            .putExtra(RestTimerService.EXTRA_STATE, state.toString());
        try {
            ContextCompat.startForegroundService(getContext(), i);
            return true;
        } catch (Exception e) {
            // 后台启动限制等导致投递失败：不影响 App 内计时，但要告诉调用方
            Log.w(RestTimerService.TAG, action + " rejected", e);
            return false;
        }
    }

    /** 统一的失败结果：ok=false + 简短原因（JS 侧靠 ok 字段判断） */
    private JSObject failResult(String reason) {
        JSObject ret = new JSObject();
        ret.put("ok", false);
        ret.put("reason", reason);
        return ret;
    }

    private void putString(JSONObject o, String key, String v) throws JSONException {
        o.put(key, v == null ? "" : v);
    }

    private void putLong(JSONObject o, String key, String raw) throws JSONException {
        long v = 0L;
        if (raw != null && !raw.trim().isEmpty()) {
            try {
                v = Long.parseLong(raw.trim());
            } catch (NumberFormatException ignored) {
                v = 0L;
            }
        }
        o.put(key, v);
    }

    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) {
            return;
        }
        bridge.executeOnMainThread(() -> {
            AppCompatActivity activity = getActivity();
            if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
                return;
            }
            if (ActivityCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
                return;
            }
            try {
                ActivityCompat.requestPermissions(
                    activity,
                    new String[] { Manifest.permission.POST_NOTIFICATIONS },
                    NOTIF_PERMISSION_REQUEST_CODE);
            } catch (Exception e) {
                Log.w(RestTimerService.TAG, "notification permission request failed", e);
            }
        });
    }
}
