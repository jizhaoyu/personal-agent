package com.looma.agent;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Debug;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.net.InetSocketAddress;
import java.net.Socket;

public final class SecurityShield {
    static {
        try {
            System.loadLibrary("looma_guard");
        } catch (UnsatisfiedLinkError ignored) {
            // Fallback to Java-layer checks if JNI library is not present in preview builds
        }
    }

    public static native boolean nativeSelfCheck();

    public static void enforceRuntimeIntegrity(Context context) {
        boolean isDebugBuild = (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!isDebugBuild) {
            if (Debug.isDebuggerConnected() || Debug.waitingForDebugger()) {
                Runtime.getRuntime().exit(1);
            }
            if (isFridaOrHookDetected() || isTracerPidNonZero()) {
                Runtime.getRuntime().exit(1);
            }
            try {
                nativeSelfCheck();
            } catch (UnsatisfiedLinkError ignored) {
            }
        }
    }

    public static boolean isTracerPidNonZero() {
        File status = new File("/proc/self/status");
        if (!status.exists()) return false;
        try (BufferedReader reader = new BufferedReader(new FileReader(status))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("TracerPid:")) {
                    String pid = line.substring(10).trim();
                    return !"0".equals(pid);
                }
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    public static boolean isFridaOrHookDetected() {
        File maps = new File("/proc/self/maps");
        if (maps.exists()) {
            try (BufferedReader reader = new BufferedReader(new FileReader(maps))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String lower = line.toLowerCase();
                    if (lower.contains("frida") || lower.contains("xposed") || lower.contains("lsposed") || lower.contains("substrate")) {
                        return true;
                    }
                }
            } catch (Exception ignored) {
            }
        }
        int[] fridaPorts = {27042, 27043};
        for (int port : fridaPorts) {
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress("127.0.0.1", port), 80);
                return true;
            } catch (Exception ignored) {
            }
        }
        return false;
    }

    public static boolean isDeviceRooted() {
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
        return false;
    }
}
