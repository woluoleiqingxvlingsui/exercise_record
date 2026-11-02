package app.exercise.record;

import android.content.Intent;
import android.os.Bundle;
import android.view.ViewGroup;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** 点常驻训练通知时带上：告诉 App「把训练页摆到前面」 */
    public static final String EXTRA_OPEN_TRAIN = "app.exercise.record.OPEN_TRAIN";

    /**
     * 待处理的「回到训练页」请求。
     *
     * 用静态标记 + 由 JS 主动消费（RestTimerPlugin.consumeOpenTrain），
     * 而不是在原生里往 WebView 注入脚本：冷启动时 WebView 还没就绪，注入会落空；
     * 标记方式则冷启动与热恢复两条路都能覆盖。
     */
    private static boolean pendingOpenTrain = false;

    /** 读取并清空标记；JS 在启动时和每次回到前台时各查一次 */
    public static boolean consumePendingOpenTrain() {
        boolean v = pendingOpenTrain;
        pendingOpenTrain = false;
        return v;
    }

    /**
     * 是否把键盘高度并进 WebView 的底边距。
     *
     * **只有弹层打开时才需要** —— 目的是让弹层里的输入框不被键盘盖住。
     * 平时必须为 false：把 WebView 压矮会连带把底部 Tab 栏一起顶到键盘上方，
     * 而底栏本就该老实贴底（被键盘盖住没关系，用户明确要的就是这个行为）。
     */
    private static boolean imeInsetEnabled = false;

    public static void setImeInsetEnabled(boolean enabled) {
        imeInsetEnabled = enabled;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前：registerPlugin 只是往 bridgeBuilder 里登记，
        // 实例化发生在 super.onCreate 末尾的 load() 里
        registerPlugin(RestTimerPlugin.class);
        super.onCreate(savedInstanceState);

        if (getIntent() != null && getIntent().getBooleanExtra(EXTRA_OPEN_TRAIN, false)) {
            pendingOpenTrain = true;
        }
        installInsetsListener();
    }

    /** launchMode=singleTask：App 已经在前台时点通知走这里 */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getBooleanExtra(EXTRA_OPEN_TRAIN, false)) {
            pendingOpenTrain = true;
        }
    }

    /**
     * edge-to-edge 下接管 WebView 的 insets（覆盖 CapacitorWebView.edgeToEdgeHandler 装的那个）：
     * 系统栏边距逻辑与 Capacitor 内置一致；另把键盘 inset 合入底边距——
     * Capacitor 内置监听只认系统栏，还把键盘 insets 一并 CONSUME 掉，
     * 输入法弹出时 WebView 完全不让位，底部弹层会被键盘盖住。
     *
     * 本项目弹层很密集（询问、灵活调整、反馈、编辑计划），这条修复必须保留。
     */
    private void installInsetsListener() {
        android.webkit.WebView webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            // 键盘高度只在弹层打开时才并进底边距（保证弹层里的输入框不被挡住）；
            // 平时取 NONE，WebView 保持满高，贴底的 Tab 栏就不会被键盘顶上去了。
            Insets ime = imeInsetEnabled
                ? windowInsets.getInsets(WindowInsetsCompat.Type.ime())
                : Insets.NONE;
            ViewGroup.MarginLayoutParams mlp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            mlp.leftMargin = bars.left;
            mlp.rightMargin = bars.right;
            mlp.topMargin = bars.top;
            mlp.bottomMargin = Math.max(bars.bottom, ime.bottom);
            v.setLayoutParams(mlp);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
