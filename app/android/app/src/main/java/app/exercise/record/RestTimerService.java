package app.exercise.record;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 训练计时前台服务：通知栏常驻计时卡（**只读展示，不带任何按钮**）。
 *
 * 与番茄钟（正计时专注）的关键区别：
 *  1. 组间歇是**倒计时** —— setWhen(restEndTs) + setUsesChronometer(true)
 *     + setChronometerCountDown(true)，由 SystemUI 每秒绘制，本进程被冻结也照样走字。
 *  2. 到点只**震动**提醒，不再额外发通知：休息结束就进入下一组，而常驻卡那时已经
 *     变成「训练中 · 第 x/x 组」，再发一条「休息结束」纯属重复。
 *  3. 询问兜底 —— 完成一组后 App 会问「按计划推进 / 灵活调整」。若用户此时锁屏或切走，
 *     由本服务在 confirmDeadline 到达时自动套用计划间歇并置 autoApplied=true，
 *     App 恢复时据此记为 decision='auto'。用户无需任何操作。
 *
 * 关于「到点提醒」为什么有两个触发源（重要，别改成只有一个）：
 *   App 在前台时，JS 自己的计时器（250ms）会比本服务的 1 秒 tick 更早发现休息结束，
 *   并立刻把状态推成「下一组」—— 那样本服务的 rest 分支就永远等不到 restEndTs 到点，
 *   于是根本不震动（这个 bug 真出现过）。所以：
 *     · 前台：JS 察觉到到点后，用 ACTION_ALERT 叫本服务来震动；
 *     · 后台：JS 被冻结，本服务自己的 tick 发现到点，自己震动。
 *   alertRestDone() 用 lastAlertedRestEndTs 去重，保证一次休息只震一次。
 *
 * 不持 WakeLock：走字由系统绘制，服务只做事件驱动的发布/重发（与番茄钟同策略）。
 * 状态写 SharedPreferences：被系统回收重建（START_STICKY 传回 null intent）时恢复。
 */
public class RestTimerService extends Service {

    public static final String TAG = "ExerciseTimer";
    public static final String ACTION_UPDATE = "app.exercise.record.timer.UPDATE";
    public static final String ACTION_ALERT = "app.exercise.record.timer.ALERT_REST_DONE";
    public static final String ACTION_STOP = "app.exercise.record.timer.STOP";
    public static final String EXTRA_STATE = "state";

    private static final String CH_TIMER = "exercise-timer-v1";
    /** 历史遗留渠道：1.x 版本用它发过「休息结束」通知，现在不再使用，顺手删掉 */
    private static final String CH_REST_DONE_LEGACY = "exercise-rest-done-v1";
    private static final int NOTIF_TIMER = 0x4521;

    /** 休息 / 等待选择：需要秒级精度（到点提醒、兜底触发） */
    private static final long TICK_ACTIVE_MS = 1_000L;
    /** 其余阶段：只需心跳自愈，避免无谓唤醒 */
    private static final long TICK_IDLE_MS = 60_000L;
    /** ready 阶段（休息已结束、等用户回来）闲置超时后自行退场，避免常驻通知赖着不走 */
    private static final long READY_IDLE_TIMEOUT_MS = 30 * 60 * 1000L;

    /** 状态持久化位置：插件侧（RestTimerPlugin）也要读同一份，故公开 */
    public static final String PREFS = "exercise_timer_state";
    public static final String PREF_KEY = "state";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private JSONObject state = new JSONObject();
    private boolean tickScheduled = false;
    private boolean isForeground = false;

    /** 去重：已经为哪一次休息的结束时刻震过了（一次休息只震一次） */
    private long lastAlertedRestEndTs = 0;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            tickScheduled = false;
            onTick();
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (ACTION_STOP.equals(action)) {
                shutdown();
                return START_NOT_STICKY;
            }

            String raw = intent.getStringExtra(EXTRA_STATE);
            if (raw != null && !raw.trim().isEmpty()) {
                try {
                    state = new JSONObject(raw);
                    persist();
                } catch (JSONException e) {
                    Log.w(TAG, "bad state payload, keeping previous", e);
                }
            }

            if (ACTION_ALERT.equals(action)) {
                // 前台由 JS 察觉到点，叫服务来震动
                if (state.optString("sessionId").isEmpty()) {
                    // 服务是被 startForegroundService() 拉起来的：不自己退场，
                    // Android 的 5~10 秒看门狗会判它「启动后没进前台」，
                    // 抛 ForegroundServiceDidNotStartInTimeException 直接把进程打死
                    shutdown();
                    return START_NOT_STICKY;
                }
                if (!startAsForeground(buildTimerNotification())) {
                    abortStart();
                    return START_NOT_STICKY;
                }
                fireRestDone();
                return START_STICKY;
            }
        } else {
            // START_STICKY 重建：从偏好恢复；没有有效会话就退场
            restore();
            if (state.optString("sessionId").isEmpty()) {
                stopSelf();
                return START_NOT_STICKY;
            }
        }

        if (state.optString("sessionId").isEmpty()) {
            shutdown();
            return START_NOT_STICKY;
        }

        if (!startAsForeground(buildTimerNotification())) {
            abortStart();
            return START_NOT_STICKY;
        }
        scheduleTick();
        return START_STICKY;
    }

    // ------------------------------------------------------------------ tick

    private void onTick() {
        try {
            String phase = phase();
            long now = System.currentTimeMillis();

            if ("rest".equals(phase)) {
                if (restEndTs() > 0 && now >= restEndTs()) {
                    fireRestDone();
                    return;
                }
                if (Build.VERSION.SDK_INT < 24) {
                    // API < 24 没有倒计时 chronometer，只能靠重绘刷新剩余时间文本
                    updateNotification();
                }
            } else if ("confirm".equals(phase)) {
                long deadline = confirmDeadline();
                if (deadline > 0 && now >= deadline) {
                    autoApplyPlan();
                } else if (deadline > 0 && Build.VERSION.SDK_INT < 24) {
                    // API < 24 没有倒计时 chronometer，通知里的剩余时间文本要靠重绘刷新
                    updateNotification();
                }
            } else if ("ready".equals(phase)) {
                long since = now - state.optLong("readyAt", now);
                if (since > READY_IDLE_TIMEOUT_MS) {
                    Log.i(TAG, "ready idle timeout, shutting down");
                    shutdown();
                    return;
                }
                updateNotification();
            } else {
                // set / continuous：60 秒心跳自愈重发
                updateNotification();
            }
        } catch (Exception e) {
            Log.w(TAG, "tick failed", e);
        }
        scheduleTick();
    }

    private void scheduleTick() {
        if (tickScheduled) {
            return;
        }
        String p = phase();
        long delay = ("rest".equals(p) || "confirm".equals(p)) ? TICK_ACTIVE_MS : TICK_IDLE_MS;
        tickScheduled = true;
        handler.postDelayed(tick, delay);
    }

    private void cancelTick() {
        if (tickScheduled) {
            handler.removeCallbacks(tick);
            tickScheduled = false;
        }
    }

    // --------------------------------------------------------------- 状态迁移

    /** 询问超时兜底：自动套用计划间歇并打标，App 恢复时据此记为 decision='auto' */
    private void autoApplyPlan() {
        try {
            long deadline = confirmDeadline();
            long planned = plannedRestMs();
            if (planned <= 0) {
                planned = 90_000L;
            }
            state.put("phase", "rest");
            state.put("anchorTs", 0);
            state.put("restEndTs", deadline + planned);
            state.put("confirmDeadline", 0);
            state.put("autoApplied", true);
            state.put("autoAppliedAt", System.currentTimeMillis());
            persist();
            updateNotification();
            Log.i(TAG, "confirm deadline passed; auto-applied planned rest " + planned + "ms");
        } catch (JSONException e) {
            Log.w(TAG, "autoApplyPlan failed", e);
        }
    }

    private void fireRestDone() {
        alertRestDone();
        try {
            state.put("phase", "ready");
            state.put("restEndTs", 0);
            state.put("anchorTs", System.currentTimeMillis());
            state.put("readyAt", System.currentTimeMillis());
            persist();
            updateNotification();
        } catch (JSONException e) {
            Log.w(TAG, "fireRestDone failed", e);
        }
    }

    /**
     * 到点提醒：只震动。
     *
     * 刻意**不再发「休息结束」通知** —— 休息结束紧接着就是下一组的「训练中 · 第 x/x 组」
     * 常驻卡，再来一条独立通知是重复信息，纯噪音。
     *
     * 用 lastAlertedRestEndTs 去重：前台 JS 与后台 tick 可能同时察觉到点，
     * 不能因此震两次。
     */
    private void alertRestDone() {
        long endTs = restEndTs();
        if (endTs > 0 && endTs == lastAlertedRestEndTs) {
            return;
        }
        lastAlertedRestEndTs = endTs;
        vibrateAlert();
    }

    // ------------------------------------------------------------- 通知构建

    private boolean startAsForeground(Notification n) {
        try {
            ServiceCompat.startForeground(
                this, NOTIF_TIMER, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            isForeground = true;
            return true;
        } catch (Exception e) {
            Log.w(TAG, "startForeground rejected", e);
            return false;
        }
    }

    private void updateNotification() {
        Notification n = buildTimerNotification();
        if (!isForeground) {
            startAsForeground(n);
            return;
        }
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }
        try {
            nm.notify(NOTIF_TIMER, n);
        } catch (Exception e) {
            Log.w(TAG, "notify failed", e);
        }
    }

    private Notification buildTimerNotification() {
        ensureChannels();
        String phase = phase();
        String label = state.optString("label", "");
        String item = state.optString("itemName", "");

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_TIMER)
            .setSmallIcon(R.drawable.ic_stat_timer)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(contentIntent());

        if ("set".equals(phase)) {
            b.setContentTitle(label.isEmpty() ? "训练中" : "训练中 · " + label)
                .setContentText(item)
                .setShowWhen(true)
                .setWhen(anchorTs() > 0 ? anchorTs() : System.currentTimeMillis())
                .setUsesChronometer(true);
        } else if ("continuous".equals(phase)) {
            b.setContentTitle(item.isEmpty() ? "有氧进行中" : item)
                .setContentText(label.isEmpty() ? "进行中" : label)
                .setShowWhen(true)
                .setWhen(anchorTs() > 0 ? anchorTs() : System.currentTimeMillis())
                .setUsesChronometer(true);
        } else if ("confirm".equals(phase)) {
            long deadline = confirmDeadline();
            b.setContentTitle("本组完成 · 等待选择");
            if (Build.VERSION.SDK_INT >= 24 && deadline > 0) {
                // 用户要看到的是「还剩多久会自动推进到下一组」，不是「这组已经过了多久」。
                // 与 rest 分支同款：倒计时交给系统绘制，本进程被冻结也照走。
                b.setContentText("到点自动按计划推进")
                    .setShowWhen(true)
                    .setWhen(deadline)
                    .setUsesChronometer(true)
                    .setChronometerCountDown(true);
            } else {
                // API < 24 没有倒计时 chronometer，只能靠重绘刷新剩余时间文本
                b.setContentText(deadline > 0
                        ? ("还剩 " + fmtClock(Math.max(0, deadline - System.currentTimeMillis())) + " 自动推进")
                        : "回到 App 选「按计划推进」或「灵活调整」")
                    .setShowWhen(false);
            }
        } else if ("rest".equals(phase)) {
            long end = restEndTs();
            b.setContentTitle(label.isEmpty() ? "组间歇" : "组间歇 · " + label);
            if (Build.VERSION.SDK_INT >= 24 && end > 0) {
                // 倒计时交给系统绘制：本进程被冻结也照走，且不需要 WakeLock
                b.setContentText("休息中")
                    .setShowWhen(true)
                    .setWhen(end)
                    .setUsesChronometer(true)
                    .setChronometerCountDown(true);
            } else {
                long left = end > 0 ? Math.max(0, end - System.currentTimeMillis()) : 0;
                b.setContentText("剩余 " + fmtClock(left)).setShowWhen(false);
            }
        } else {
            b.setContentTitle(label.isEmpty() ? "休息结束" : "休息结束 · " + label)
                .setContentText("回到 App 开始本组")
                .setShowWhen(false);
        }

        if (Build.VERSION.SDK_INT >= 31) {
            b.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return b.build();
    }

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < 26) {
            return;
        }
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }
        NotificationChannel timer = new NotificationChannel(
            CH_TIMER, getString(R.string.timer_channel_name), NotificationManager.IMPORTANCE_DEFAULT);
        timer.setSound(null, null);
        timer.setShowBadge(false);
        // 渠道级锁屏可见性：不显式设的话 HyperOS 可能按隐私内容处理，锁屏不给显示
        timer.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(timer);

        // 老版本建过「休息结束」渠道并一直在通知设置里留着，这里主动清掉
        nm.deleteNotificationChannel(CH_REST_DONE_LEGACY);
    }

    /**
     * 点常驻通知回到 **训练页**（而不是"上次待着的那个页面"）。
     *
     * 实现方式：intent 带上 EXTRA_OPEN_TRAIN，MainActivity 收到后置一个标记，
     * 由 JS 侧消费（见 RestTimerPlugin.consumeOpenTrain）。这样冷启动与热恢复
     * 两条路径都能覆盖，也不用在原生里往 WebView 注入脚本。
     */
    private PendingIntent contentIntent() {
        Intent i = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_OPEN_TRAIN, true);
        return PendingIntent.getActivity(
            this,
            1,
            i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ------------------------------------------------------------------ 震动

    private void vibrateAlert() {
        try {
            Vibrator v;
            if (Build.VERSION.SDK_INT >= 31) {
                VibratorManager vm =
                    (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                v = vm != null ? vm.getDefaultVibrator() : null;
            } else {
                v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (v == null || !v.hasVibrator()) {
                Log.w(TAG, "no vibrator available");
                return;
            }
            // 休息结束是"该上杠了"的信号，一声短震太容易被错过。
            // 5 声 400ms、间隔 200ms，总共约 2.8 秒后自己停 ——
            // 不用取消逻辑，也就不存在"震个没完"的风险。
            long[] pattern = {0, 400, 200, 400, 200, 400, 200, 400, 200, 400};
            if (Build.VERSION.SDK_INT >= 26) {
                v.vibrate(VibrationEffect.createWaveform(pattern, -1));
            } else {
                v.vibrate(pattern, -1);
            }
        } catch (Exception e) {
            Log.w(TAG, "vibrate failed", e);
        }
    }

    // ------------------------------------------------------------------ 收尾

    /**
     * startForeground 失败时的退场路径。
     *
     * 服务是被 startForegroundService() 拉起来的：系统已经在等它 5~10 秒内进前台，
     * 超时就抛 ForegroundServiceDidNotStartInTimeException 把进程打死。
     * 所以失败分支必须自己 stopSelf()，同时把通知撤掉（别留一张孤儿卡在通知栏）。
     *
     * 这里**不清**持久化的会话状态：JS 那边还活着、会再推一次状态回来，
     * 抹掉反而让下次对账读到空状态。
     */
    private void abortStart() {
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        } catch (Exception e) {
            Log.w(TAG, "stopForeground failed", e);
        }
        isForeground = false;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.cancel(NOTIF_TIMER);
        }
        stopSelf();
    }

    private void shutdown() {
        cancelTick();
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        } catch (Exception e) {
            Log.w(TAG, "stopForeground failed", e);
        }
        isForeground = false;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.cancel(NOTIF_TIMER);
        }
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        state = new JSONObject();
        lastAlertedRestEndTs = 0;
        stopSelf();
    }

    /** specialUse 理论上不触发系统超时，但国产 ROM 魔改行为不可预测，一行代码买保险 */
    @Override
    public void onTimeout(int startId, int fgsType) {
        Log.w(TAG, "onTimeout fgsType=" + fgsType + ", stopping");
        shutdown();
    }

    @Override
    public void onDestroy() {
        cancelTick();
        super.onDestroy();
    }

    // ------------------------------------------------------------ 状态读写辅助

    private String phase() {
        return state.optString("phase", "");
    }

    private long anchorTs() {
        return state.optLong("anchorTs", 0);
    }

    private long restEndTs() {
        return state.optLong("restEndTs", 0);
    }

    private long confirmDeadline() {
        return state.optLong("confirmDeadline", 0);
    }

    private long plannedRestMs() {
        return state.optLong("plannedRestMs", 0);
    }

    private void persist() {
        SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        sp.edit().putString(PREF_KEY, state.toString()).apply();
    }

    private void restore() {
        SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = sp.getString(PREF_KEY, null);
        if (raw == null) {
            return;
        }
        try {
            state = new JSONObject(raw);
        } catch (JSONException e) {
            Log.w(TAG, "restore failed", e);
        }
    }

    /** 短格式：37:42 / 1:02:33 */
    private static String fmtClock(long ms) {
        long s = Math.max(0, ms) / 1000;
        long h = s / 3600;
        long m = (s % 3600) / 60;
        long sec = s % 60;
        if (h > 0) {
            return h + ":" + two(m) + ":" + two(sec);
        }
        return m + ":" + two(sec);
    }

    private static String two(long v) {
        return v < 10 ? "0" + v : String.valueOf(v);
    }
}
