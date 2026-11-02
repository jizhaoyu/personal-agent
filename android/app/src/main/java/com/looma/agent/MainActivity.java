package com.looma.agent;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

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

            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.parseColor("#090A0F"));

            // 状态栏图标与导航栏图标设为浅色（暗色主题下高对比度可见，解决 ColorOS/OriginOS 黑底黑字隐形问题）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                window.setDecorFitsSystemWindows(false);
                android.view.WindowInsetsController controller = window.getInsetsController();
                if (controller != null) {
                    controller.setSystemBarsAppearance(0,
                            android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS |
                            android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
                }
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                View decor = window.getDecorView();
                decor.setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                );
            }
        } catch (Throwable ignored) {
        }

        // 3. 构建 WebView 并初始化设置
        try {
            webView = new WebView(this);
            webView.setBackgroundColor(Color.parseColor("#090A0F"));

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

            // C. 页面自适应与排版缩放
            settings.setUseWideViewPort(true);
            settings.setLoadWithOverviewMode(true);

            // 4. 挂载原生安全桥接接口 window.LoomaAndroid
            webView.addJavascriptInterface(new LoomaBridge(this), "LoomaAndroid");
            webView.setWebViewClient(new WebViewClient());
            webView.setWebChromeClient(new WebChromeClient());

            // 5. 加载本地打包的前端工作台
            webView.loadUrl("file:///android_asset/www/index.html");
        } catch (Throwable t) {
            // 兜底异常处理
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        try {
            SecurityShield.enforceRuntimeIntegrity(this);
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onDestroy() {
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
