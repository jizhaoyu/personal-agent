package com.looma.agent;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import java.io.File;

public final class SecurityShield {
    private static final String TAG = "LoomaSecurity";

    public static void enforceRuntimeIntegrity(Context context) {
        // 安全自检软检测与静默容错，杜绝调用 System.exit/Runtime.exit，
        // 彻底解决小米 MIUI/HyperOS、OPPO ColorOS、vivo OriginOS 性能守护进程或游戏加速探测时导致的误杀秒退。
        try {
            if (isDeviceRooted()) {
                Log.w(TAG, "Device rooted environment detected");
            }
        } catch (Throwable t) {
            Log.e(TAG, "Security check error ignored: " + t.getMessage());
        }
    }

    public static boolean isTracerPidNonZero() {
        return false;
    }

    public static boolean isFridaOrHookDetected() {
        return false;
    }

    public static boolean isDeviceRooted() {
        try {
            String buildTags = Build.TAGS;
            if (buildTags != null && buildTags.contains("test-keys")) return true;
            String[] suPaths = {
                "/system/bin/su",
                "/system/xbin/su",
                "/sbin/su",
                "/data/local/xbin/su",
                "/data/local/bin/su",
                "/system/sd/xbin/su"
            };
            for (String path : suPaths) {
                if (new File(path).exists()) return true;
            }
        } catch (Throwable ignored) {
        }
        return false;
    }
}
