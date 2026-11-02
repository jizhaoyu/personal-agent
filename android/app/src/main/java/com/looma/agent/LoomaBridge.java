package com.looma.agent;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

public final class LoomaBridge {
    private static final String CHANNEL_ID = "looma_due_reminders";
    private static final Pattern PRIVATE_KEY_PATTERN =
            Pattern.compile("-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----", Pattern.CASE_INSENSITIVE);

    private final Activity activity;
    private final KeyStoreVault vault;
    private volatile boolean contentProtected = true;

    public LoomaBridge(Activity activity) {
        this.activity = activity;
        this.vault = new KeyStoreVault(activity.getApplicationContext());
        ensureNotificationChannel();
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Looma 到期提醒",
                    NotificationManager.IMPORTANCE_DEFAULT
            );
            NotificationManager manager = activity.getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    public static String sanitizeClipboard(String text) {
        if (text == null) return "";
        String trimmed = text.trim();
        if (trimmed.isEmpty() || trimmed.length() > 12000) return "";
        if (PRIVATE_KEY_PATTERN.matcher(trimmed).find()) {
            return "[SECURITY INTERCEPT] 检测到包含私钥特征，底座已自动阻止载入待办，保护您的凭据安全。";
        }
        return trimmed;
    }

    @JavascriptInterface
    public String readClipboard() {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence raw = clip.getItemAt(0).coerceToText(activity);
            return sanitizeClipboard(raw != null ? raw.toString() : "");
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public boolean setContentProtection(final boolean enabled) {
        activity.runOnUiThread(() -> {
            if (enabled) {
                activity.getWindow().setFlags(
                        WindowManager.LayoutParams.FLAG_SECURE,
                        WindowManager.LayoutParams.FLAG_SECURE
                );
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }
            contentProtected = enabled;
        });
        contentProtected = enabled;
        return contentProtected;
    }

    @JavascriptInterface
    public boolean isContentProtected() {
        return contentProtected;
    }

    @JavascriptInterface
    public String getModelStatus() {
        try {
            JSONObject out = new JSONObject();
            String baseUrl = vault.getApiBaseUrl();
            boolean isLocal = baseUrl.startsWith("http://localhost") || baseUrl.startsWith("http://127.0.0.1");
            out.put("configured", vault.hasApiKey() || isLocal);
            out.put("persistent", true);
            out.put("enabled", vault.isEnabled());
            out.put("apiBaseUrl", baseUrl);
            out.put("modelName", vault.getModelName());
            return out.toString();
        } catch (Exception e) {
            return "{\"configured\":false,\"persistent\":true,\"enabled\":false}";
        }
    }

    @JavascriptInterface
    public String saveModelConnection(String payloadJson) {
        try {
            JSONObject input = new JSONObject(payloadJson);
            String apiBaseUrl = input.optString("apiBaseUrl", "https://api.deepseek.com/v1").trim();
            String modelName = input.optString("modelName", "deepseek-chat").trim();
            String apiKey = input.optString("apiKey", "");
            boolean enabled = input.optBoolean("enabled", false);
            vault.saveConnection(apiBaseUrl, modelName, apiKey, enabled);
            return getModelStatus();
        } catch (Exception e) {
            return "{\"error\":\"AndroidKeyStore 硬件凭据写入失败\"}";
        }
    }

    @JavascriptInterface
    public String clearModelConnection() {
        vault.clear();
        return "{\"cleared\":true}";
    }

    @JavascriptInterface
    public String proposeModel(String payloadJson) {
        try {
            JSONObject input = new JSONObject(payloadJson);
            String text = input.optString("text", "");
            String now = input.optString("now", "");
            JSONObject context = input.optJSONObject("context");
            String prompt = "你是只生成待用户确认候选的客户跟进解析器。只根据输入抽取事实，不得虚构金额单位、成交阶段或客户时间。返回 JSON：{\"operations\":[]}\n"
                    + "当前时间：" + now + "\n"
                    + "当前选中项目：" + (context != null ? context.toString() : "null") + "\n"
                    + "输入原文：" + text;
            String content = invokeChatCompletion(prompt);
            JSONObject res = new JSONObject();
            res.put("content", content);
            return res.toString();
        } catch (Exception e) {
            return "{\"error\":\"移动端模型请求未完成，已保留本地解析结果\"}";
        }
    }

    @JavascriptInterface
    public String recallModel(String payloadJson) {
        try {
            JSONObject input = new JSONObject(payloadJson);
            String query = input.optString("query", "");
            JSONArray evidence = input.optJSONArray("evidence");
            String prompt = "根据以下本地证据简要回答用户回忆问题，不得编造证据外事实：\n问题："
                    + query + "\n证据：" + (evidence != null ? evidence.toString() : "[]");
            String content = invokeChatCompletion(prompt);
            JSONObject res = new JSONObject();
            res.put("content", content);
            return res.toString();
        } catch (Exception e) {
            return "{\"error\":\"移动端回忆增强请求失败\"}";
        }
    }

    private String invokeChatCompletion(String userPrompt) throws Exception {
        String baseUrl = vault.getApiBaseUrl().replaceAll("/+$", "");
        String apiKey = vault.readApiKey();
        URL url = new URL(baseUrl + "/chat/completions");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(18000);
        conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        if (!apiKey.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + apiKey);
        }
        conn.setDoOutput(true);

        JSONObject body = new JSONObject();
        body.put("model", vault.getModelName());
        body.put("temperature", 0.1);
        JSONArray messages = new JSONArray();
        JSONObject msg = new JSONObject();
        msg.put("role", "user");
        msg.put("content", userPrompt);
        messages.put(msg);
        body.put("messages", messages);

        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(payload);
        }

        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new RuntimeException("HTTP " + code);
        }

        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
        }
        JSONObject parsed = new JSONObject(sb.toString());
        return parsed.getJSONArray("choices")
                .getJSONObject(0)
                .getJSONObject("message")
                .optString("content", "");
    }

    @JavascriptInterface
    public boolean notifyDue(int count) {
        if (count <= 0) return false;
        try {
            NotificationManager manager = (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return false;
            Notification.Builder builder = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    ? new Notification.Builder(activity, CHANNEL_ID)
                    : new Notification.Builder(activity);
            builder.setSmallIcon(android.R.drawable.ic_popup_reminder)
                    .setContentTitle("Looma 跟进提醒")
                    .setContentText("当前有 " + Math.min(count, 9999) + " 项待办或等待回音已到期。")
                    .setAutoCancel(true);
            manager.notify(1001, builder.build());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public void minimizeApp() {
        activity.runOnUiThread(() -> activity.moveTaskToBack(true));
    }

    @JavascriptInterface
    public void closeApp() {
        activity.runOnUiThread(activity::finishAndRemoveTask);
    }
}
