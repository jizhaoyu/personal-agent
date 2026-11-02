package com.looma.agent;

import android.annotation.SuppressLint;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {
    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 1. 启动前执行反调试、反 Frida/Xposed 与 TracerPid 安全熔断自检
        SecurityShield.enforceRuntimeIntegrity(this);

        super.onCreate(savedInstanceState);

        // 2. 默认激活硬件级防截屏、防录屏与多任务切换界面高斯遮蔽 (FLAG_SECURE)
        Window window = getWindow();
        window.setFlags(
                WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE
        );
        window.setStatusBarColor(Color.parseColor("#090A0F"));
        window.setNavigationBarColor(Color.parseColor("#090A0F"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#090A0F"));
        setContentView(webView);

        // 3. 生产模式下彻底封禁 WebView 远程调试端口
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

        // 4. 挂载原生安全桥接接口 window.LoomaAndroid
        webView.addJavascriptInterface(new LoomaBridge(this), "LoomaAndroid");
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());

        // 5. 加载本地打包的前端工作台
        webView.loadUrl("file:///android_asset/www/index.html");

        // 6. 物理返回键处理
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        SecurityShield.enforceRuntimeIntegrity(this);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("LoomaAndroid");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
