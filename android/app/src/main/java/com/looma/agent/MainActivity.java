package com.looma.agent;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final String ENTRY_URL = "file:///android_asset/www/index.html";
    private static final int REQUEST_FILE_CHOOSER = 4101;
    private static final int REQUEST_EXPORT_BACKUP = 4102;

    private WebView webView;
    private JSONObject pendingTodoFocus;
    private boolean pageReady;
    private float cachedSafeTopDp = 0f;
    private float cachedSafeBottomDp = 0f;
    private float cachedImeBottomDp = 0f;
    private ValueCallback<Uri[]> pendingFileChooserCallback;
    private String pendingExportRequestId;
    private byte[] pendingExportBytes;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        captureTodoFocus(getIntent());

        // 1. 安全自检软校验（防异常闪退保护）
        try {
            SecurityShield.enforceRuntimeIntegrity(this);
        } catch (Throwable ignored) {
        }

        // 2. 硬件级防截屏、防录屏与多任务切换界面遮蔽 (FLAG_SECURE)
        try {
            Window window = getWindow();
            window.setFlags(
                    WindowManager.LayoutParams.FLAG_SECURE,
                    WindowManager.LayoutParams.FLAG_SECURE
            );

            // 沉浸式与刘海屏/挖孔屏全面适配（针对小米 MIUI/HyperOS, OPPO ColorOS, vivo OriginOS）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams lp = window.getAttributes();
                lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(lp);
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                window.setDecorFitsSystemWindows(false);
            }

            applySystemBarStyle(window, true);
        } catch (Throwable ignored) {
        }

        // 3. 构建 WebView 并初始化设置
        try {
            webView = new WebView(this);
            webView.setBackgroundColor(Color.parseColor("#f7f1e5"));

            // 禁用过度拉伸与多余滚动条，消除小米与 vivo 边缘弹性重影拉扯
            webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
            webView.setVerticalScrollBarEnabled(false);
            webView.setHorizontalScrollBarEnabled(false);
            setContentView(webView);

            // 生产模式下封禁 WebView 远程调试端口
            boolean isDebugBuild = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            WebView.setWebContentsDebuggingEnabled(isDebugBuild);

            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(false);
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setAllowUniversalAccessFromFileURLs(false);
            settings.setSavePassword(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

            // 小米/OPPO/vivo 核心 WebView 行为适配修复
            // A. 锁定 100% 网页文本缩放比，防止 OPPO/vivo 系统大字号与老人机模式撑爆排版
            settings.setTextZoom(100);

            // B. 禁用系统级强制深色模式，防止 MIUI/ColorOS/OriginOS 自动暴力反色导致黑底黑字
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                settings.setForceDark(WebSettings.FORCE_DARK_OFF);
            }

            // C. 页面自适应与排版缩放，禁用意外双指缩放及缩放控件
            settings.setUseWideViewPort(true);
            settings.setLoadWithOverviewMode(true);
            settings.setSupportZoom(false);
            settings.setBuiltInZoomControls(false);
            settings.setDisplayZoomControls(false);

            // 4. 挂载原生安全桥接接口 window.LoomaAndroid
            webView.addJavascriptInterface(new LoomaBridge(this), "LoomaAndroid");
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    String reqUrl = request != null && request.getUrl() != null ? request.getUrl().toString() : "";
                    return !reqUrl.startsWith("file:///android_asset/www/");
                }

                @Override public void onPageFinished(WebView view, String url) {
                    if (!ENTRY_URL.equals(url)) return;
                    pageReady = true;
                    syncWindowInsetsNow();
                    dispatchTodoFocus(40);
                    publishTodoCapabilities();
                }
            });
            webView.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onShowFileChooser(
                        WebView view,
                        ValueCallback<Uri[]> filePathCallback,
                        FileChooserParams fileChooserParams
                ) {
                    if (pendingFileChooserCallback != null) {
                        pendingFileChooserCallback.onReceiveValue(null);
                        pendingFileChooserCallback = null;
                    }
                    pendingFileChooserCallback = filePathCallback;
                    try {
                        Intent intent = fileChooserParams != null
                                ? fileChooserParams.createIntent()
                                : new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("application/json");
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        startActivityForResult(intent, REQUEST_FILE_CHOOSER);
                        return true;
                    } catch (Throwable t) {
                        if (pendingFileChooserCallback != null) {
                            pendingFileChooserCallback.onReceiveValue(null);
                            pendingFileChooserCallback = null;
                        }
                        return false;
                    }
                }
            });

            View decorView = getWindow().getDecorView();
            decorView.setOnApplyWindowInsetsListener((v, insets) -> {
                updateInsetsFromWindowInsets(insets);
                return v.onApplyWindowInsets(insets);
            });
            syncWindowInsetsNow();
            decorView.requestApplyInsets();

            // 5. 加载本地打包的前端工作台
            webView.loadUrl(ENTRY_URL);
        } catch (Throwable t) {
            // 兜底异常处理
        }
    }

    @SuppressWarnings("deprecation")
    static void applySystemBarStyle(Window window, boolean isLightBackground) {
        if (window == null) return;
        int bgColor = Color.parseColor(isLightBackground ? "#f7f1e5" : "#090A0F");

        window.clearFlags(
                WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION
        );
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(bgColor);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }

        View decor = window.getDecorView();
        if (decor != null) {
            decor.setBackgroundColor(bgColor);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            final int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            final int appearance = isLightBackground ? mask : 0;
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(appearance, mask);
            } else if (decor != null) {
                decor.post(() -> {
                    WindowInsetsController attached = window.getInsetsController();
                    if (attached != null) {
                        attached.setSystemBarsAppearance(appearance, mask);
                    }
                });
            }
        } else if (decor != null) {
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
            if (isLightBackground) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            }
            decor.setSystemUiVisibility(flags);
        }
    }

    void applyBarStyle(boolean isLightBackground) {
        applySystemBarStyle(getWindow(), isLightBackground);
        if (webView != null) {
            webView.setBackgroundColor(Color.parseColor(isLightBackground ? "#f7f1e5" : "#090A0F"));
        }
    }

    private void syncWindowInsetsNow() {
        View decor = getWindow() != null ? getWindow().getDecorView() : null;
        if (decor != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            WindowInsets rootInsets = decor.getRootWindowInsets();
            if (rootInsets != null) {
                updateInsetsFromWindowInsets(rootInsets);
                return;
            }
        }
        injectWindowInsets();
    }

    @SuppressWarnings("deprecation")
    private void updateInsetsFromWindowInsets(WindowInsets insets) {
        if (insets == null) return;
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;

        int topPx;
        int bottomPx;
        int imePx = 0;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Insets sys = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
            );
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            topPx = sys.top;
            bottomPx = sys.bottom;
            imePx = Math.max(0, ime.bottom - sys.bottom);
        } else {
            topPx = insets.getSystemWindowInsetTop();
            bottomPx = insets.getSystemWindowInsetBottom();
        }

        cachedSafeTopDp = topPx / density;
        cachedSafeBottomDp = bottomPx / density;
        cachedImeBottomDp = imePx / density;
        injectWindowInsets();
    }

    private void injectWindowInsets() {
        if (webView == null) return;
        final String script = String.format(
                Locale.US,
                "(function(){var r=document.documentElement;if(!r)return;"
                        + "r.setAttribute('data-platform','android');"
                        + "r.style.setProperty('--looma-safe-top','%.2fpx');"
                        + "r.style.setProperty('--looma-safe-bottom','%.2fpx');"
                        + "r.style.setProperty('--looma-ime-bottom','%.2fpx');"
                        + "})();",
                cachedSafeTopDp,
                cachedSafeBottomDp,
                cachedImeBottomDp
        );
        webView.evaluateJavascript(script, null);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView == null) {
            moveTaskToBack(true);
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return Boolean(window.__loomaHandleBack&&window.__loomaHandleBack());}catch(e){return false;}})()",
                result -> {
                    if (isFinishing() || isDestroyed()) return;
                    if ("true".equals(result)) return;
                    if (webView != null && webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        moveTaskToBack(true);
                    }
                }
        );
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureTodoFocus(intent);
        dispatchTodoFocus(40);
    }

    private void captureTodoFocus(Intent intent) {
        if (intent == null) return;
        String space = intent.getStringExtra(TodoScheduler.EXTRA_SPACE);
        String id = intent.getStringExtra(TodoScheduler.EXTRA_ID);
        if (!TodoStore.validSpace(space) || id == null || id.trim().isEmpty() || id.length() > 200) return;
        try { pendingTodoFocus = new JSONObject().put("space", space).put("id", id); }
        catch (Exception ignored) {}
        intent.removeExtra(TodoScheduler.EXTRA_SPACE);
        intent.removeExtra(TodoScheduler.EXTRA_ID);
    }

    private void dispatchTodoFocus(int retries) {
        if (!pageReady || webView == null || pendingTodoFocus == null) return;
        final JSONObject focus = pendingTodoFocus;
        String payload = focus.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        String script = "(function(){var p=" + payload + ";if(typeof window.__loomaTodoFocus==='function'){"
                + "window.__loomaTodoFocus(p);window.__loomaPendingTodoFocus=null;return true;}"
                + "window.__loomaPendingTodoFocus=p;return false;})()";
        webView.evaluateJavascript(script, result -> {
            if (pendingTodoFocus != focus) return;
            if ("true".equals(result)) pendingTodoFocus = null;
            else if (retries > 0 && webView != null) webView.postDelayed(() -> dispatchTodoFocus(retries - 1), 250);
        });
    }

    private void publishTodoCapabilities() {
        if (!pageReady || webView == null) return;
        try {
            String script = "window.dispatchEvent(new CustomEvent('looma:todo-capabilities',{detail:"
                    + TodoScheduler.capabilities(this).toString() + "}));";
            webView.evaluateJavascript(script, null);
        } catch (Exception ignored) {}
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == TodoScheduler.PERMISSION_REQUEST) {
            TodoScheduler.requestExactPermission(this);
            TodoScheduler.reconcile(this);
            publishTodoCapabilities();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        try {
            SecurityShield.enforceRuntimeIntegrity(this);
        } catch (Throwable ignored) {
        }
        View decor = getWindow() != null ? getWindow().getDecorView() : null;
        if (decor != null) {
            decor.requestApplyInsets();
        }
        TodoScheduler.reconcile(this);
        publishTodoCapabilities();
        dispatchTodoFocus(40);
    }

    void launchExportBackup(final String requestId, final String suggestedName, final String jsonContent) {
        launchSaveDocument(requestId, suggestedName, "application/json", jsonContent, false);
    }

    private static String normalizeDocumentMimeType(String mimeType, String suggestedName, boolean isBase64) {
        String lowerMime = mimeType != null ? mimeType.trim().toLowerCase(Locale.US) : "";
        if ("image/png".equals(lowerMime)) return "image/png";
        if ("text/plain".equals(lowerMime)) return "text/plain";
        if ("application/json".equals(lowerMime) || "application/x-ndjson".equals(lowerMime) || "application/jsonl".equals(lowerMime)) {
            return "application/json";
        }
        String lowerName = suggestedName != null ? suggestedName.trim().toLowerCase(Locale.US) : "";
        if (lowerName.endsWith(".png")) return "image/png";
        if (lowerName.endsWith(".json") || lowerName.endsWith(".jsonl")) return "application/json";
        if (lowerName.endsWith(".txt")) return "text/plain";
        return isBase64 ? "image/png" : "text/plain";
    }

    void launchSaveDocument(
            final String requestId,
            final String suggestedName,
            final String mimeType,
            final String content,
            final boolean isBase64
    ) {
        if (requestId == null || requestId.trim().isEmpty()) return;
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            if (pendingExportRequestId != null) {
                notifyBackupExportResult(requestId, false, false, "已有导出窗口打开中，请先完成当前保存。");
                return;
            }
            if (content == null || content.isEmpty()) {
                notifyBackupExportResult(requestId, false, false, "保存内容为空。");
                return;
            }

            final String safeMime = normalizeDocumentMimeType(mimeType, suggestedName, isBase64);
            final byte[] bytes;
            final int maxBytes = 16 * 1024 * 1024;
            if (isBase64) {
                String raw = content.trim();
                int marker = raw.indexOf(";base64,");
                if (raw.regionMatches(true, 0, "data:", 0, 5) && marker > 0) {
                    raw = raw.substring(marker + 8);
                }
                if (raw.isEmpty() || raw.length() > 22 * 1024 * 1024) {
                    notifyBackupExportResult(requestId, false, false, "文件内容编码无效或超出 16MB 限制。");
                    return;
                }
                try {
                    bytes = Base64.decode(raw, Base64.DEFAULT);
                } catch (IllegalArgumentException e) {
                    notifyBackupExportResult(requestId, false, false, "文件内容编码解析失败。");
                    return;
                }
                if (bytes == null || bytes.length == 0 || bytes.length > maxBytes) {
                    notifyBackupExportResult(requestId, false, false, "文件大小超出 16MB 限制。");
                    return;
                }
            } else {
                bytes = content.getBytes(StandardCharsets.UTF_8);
                if (bytes.length == 0 || bytes.length > maxBytes) {
                    notifyBackupExportResult(requestId, false, false, "文件大小超出 16MB 限制。");
                    return;
                }
            }

            String defaultName = "image/png".equals(safeMime)
                    ? "Looma-export.png"
                    : ("text/plain".equals(safeMime) ? "Looma-report.txt" : "Looma-v5-backup.json");
            String safeName = (suggestedName != null && !suggestedName.trim().isEmpty())
                    ? suggestedName.trim().replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]", "_").replaceAll("^\\.+", "")
                    : defaultName;
            if (safeName.isEmpty()) safeName = defaultName;
            if (safeName.length() > 120) safeName = safeName.substring(0, 120);

            pendingExportRequestId = requestId;
            pendingExportBytes = bytes;
            try {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(safeMime);
                intent.putExtra(Intent.EXTRA_TITLE, safeName);
                startActivityForResult(intent, REQUEST_EXPORT_BACKUP);
            } catch (Throwable t) {
                pendingExportRequestId = null;
                pendingExportBytes = null;
                notifyBackupExportResult(requestId, false, false, "无法打开系统文件保存器，请检查系统文档权限。");
            }
        });
    }

    private void evaluateJsObjectCallback(String fnName, JSONObject payload) {
        if (webView == null || fnName == null || payload == null) return;
        String jsArg = payload.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        String script = "(function(){if(typeof window." + fnName + "==='function'){window." + fnName + "(" + jsArg + ");}})();";
        webView.post(() -> {
            if (webView != null) {
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private void notifyBackupExportResult(String requestId, boolean ok, boolean canceled, String error) {
        if (webView == null || requestId == null) return;
        try {
            JSONObject payload = new JSONObject();
            payload.put("requestId", requestId);
            payload.put("ok", ok);
            payload.put("canceled", canceled);
            payload.put("error", error == null ? "" : error);
            evaluateJsObjectCallback("__loomaOnBackupExportResult", payload);
        } catch (Throwable ignored) {
        }
    }

    void notifyUpdateCheckResult(String requestId, JSONObject result) {
        if (webView == null || requestId == null || result == null) return;
        try {
            JSONObject payload = new JSONObject();
            payload.put("requestId", requestId);
            payload.put("result", result);
            evaluateJsObjectCallback("__loomaOnUpdateCheckResult", payload);
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FILE_CHOOSER) {
            ValueCallback<Uri[]> callback = pendingFileChooserCallback;
            pendingFileChooserCallback = null;
            if (callback != null) {
                Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                if (result == null && resultCode == RESULT_OK && data != null && data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
                callback.onReceiveValue(result);
            }
            return;
        }
        if (requestCode == REQUEST_EXPORT_BACKUP) {
            String requestId = pendingExportRequestId;
            byte[] bytes = pendingExportBytes;
            pendingExportRequestId = null;
            pendingExportBytes = null;
            if (requestId == null) return;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                notifyBackupExportResult(requestId, false, true, "");
                return;
            }
            Uri uri = data.getData();
            OutputStream out = null;
            try {
                try {
                    out = getContentResolver().openOutputStream(uri, "wt");
                } catch (Throwable ignored) {
                    out = getContentResolver().openOutputStream(uri);
                }
                if (out == null) {
                    notifyBackupExportResult(requestId, false, false, "无法写入所选文件位置。");
                    return;
                }
                out.write(bytes != null ? bytes : new byte[0]);
                out.flush();
                notifyBackupExportResult(requestId, true, false, "");
            } catch (Throwable t) {
                notifyBackupExportResult(requestId, false, false, "文件写入失败，请换一个目录重试。");
            } finally {
                if (out != null) {
                    try {
                        out.close();
                    } catch (Throwable ignored) {
                    }
                }
            }
        }
    }

    @Override
    protected void onDestroy() {
        if (pendingFileChooserCallback != null) {
            try {
                pendingFileChooserCallback.onReceiveValue(null);
            } catch (Throwable ignored) {
            }
            pendingFileChooserCallback = null;
        }
        pendingExportRequestId = null;
        pendingExportBytes = null;
        if (webView != null) {
            try {
                webView.removeJavascriptInterface("LoomaAndroid");
                webView.destroy();
            } catch (Throwable ignored) {
            }
            webView = null;
        }
        super.onDestroy();
    }
}
