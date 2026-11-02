# 保持 WebView JavascriptInterface 导出符号不被混淆移除
-keepattributes *Annotation*,JavascriptInterface
-keepclassmembers class com.looma.agent.LoomaBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.looma.agent.SecurityShield {
    public static native boolean nativeSelfCheck();
}

# 剥离所有调试日志调用
-assumenosideeffects class android.util.Log {
    public static boolean isLoggable(java.lang.String, int);
    public static int v(...);
    public static int d(...);
    public static int i(...);
}

# 开启激进混淆与重打包消除反编译可读性
-repackageclasses 'o'
-allowaccessmodification
-overloadaggressively
