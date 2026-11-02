#include <jni.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/ptrace.h>

// 1. 扫描 /proc/self/status 检测 TracerPid (反 gdb / lldb / ida_server 挂载)
static bool isTracerAttached() {
    FILE* fp = fopen("/proc/self/status", "r");
    if (!fp) return false;
    char line[256];
    int tracerPid = 0;
    while (fgets(line, sizeof(line), fp)) {
        if (strncmp(line, "TracerPid:", 10) == 0) {
            tracerPid = atoi(&line[10]);
            break;
        }
    }
    fclose(fp);
    return tracerPid != 0;
}

// 2. 扫描 /proc/self/maps 检测 Frida / Xposed / LSPosed / Substrate 内存注入特征
static bool isHookFrameworkInjected() {
    FILE* fp = fopen("/proc/self/maps", "r");
    if (!fp) return false;
    char line[512];
    bool detected = false;
    const char* signatures[] = {
        "frida-agent",
        "frida-gadget",
        "gum-js-loop",
        "XposedBridge.jar",
        "libxposed",
        "lsposed",
        "libsubstrate"
    };
    const size_t sigCount = sizeof(signatures) / sizeof(signatures[0]);
    while (fgets(line, sizeof(line), fp)) {
        for (size_t i = 0; i < sigCount; i++) {
            if (strstr(line, signatures[i]) != nullptr) {
                detected = true;
                break;
            }
        }
        if (detected) break;
    }
    fclose(fp);
    return detected;
}

extern "C"
JNIEXPORT jboolean JNICALL
Java_com_looma_agent_SecurityShield_nativeSelfCheck(JNIEnv* env, jclass clazz) {
    if (isTracerAttached() || isHookFrameworkInjected()) {
        _exit(0xDEAD);
        return JNI_FALSE;
    }
    return JNI_TRUE;
}
