package com.looma.agent;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

/** AlarmManager work survives a destroyed WebView; no foreground service is used. */
public final class TodoScheduler {
    public static final String ACTION_DUE = "com.looma.agent.TODO_DUE";
    public static final String EXTRA_SPACE = "looma_todo_space";
    public static final String EXTRA_ID = "looma_todo_id";
    public static final int PERMISSION_REQUEST = 704;
    private static final String CHANNEL_ID = "looma_todos";

    private TodoScheduler() {}

    private static void channel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(new NotificationChannel(
                CHANNEL_ID, "Looma 待办提醒", NotificationManager.IMPORTANCE_DEFAULT));
    }

    private static boolean notificationsGranted(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || !manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        channel(context);
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        return channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    private static boolean exactGranted(Context context) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        return alarms != null && (Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms());
    }

    public static JSONObject capabilities(Context context) throws Exception {
        synchronized (TodoStore.LOCK) {
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("background", context.getSystemService(AlarmManager.class) != null);
            out.put("notifications", notificationsGranted(context) ? "granted" : "denied");
            out.put("exactAlarms", Build.VERSION.SDK_INT < 31 ? "not-required" : exactGranted(context) ? "granted" : "denied");
            out.put("enabled", TodoStore.get(context).enabled());
            return out;
        }
    }

    public static String request(Activity activity, String commandJson) {
        synchronized (TodoStore.LOCK) {
            try {
                JSONObject command = new JSONObject(commandJson);
                String op = command.optString("op", "");
                TodoStore store = TodoStore.get(activity);
                if ("list".equals(op)) {
                    String space = null;
                    if (command.has("space")) {
                        Object rawSpace = command.get("space");
                        if (!(rawSpace instanceof String)) throw new IllegalArgumentException("无效待办空间");
                        space = (String) rawSpace;
                    }
                    return new JSONObject().put("ok", true).put("todos", store.list(space)).toString();
                }
                if ("put".equals(op)) {
                    if (!command.has("expectedRevision")) throw new IllegalArgumentException("expectedRevision 缺失");
                    JSONObject todo = store.put(command.getJSONObject("todo"), command.get("expectedRevision"));
                    try {
                        cancel(activity, todo);
                        reconcileOne(activity, todo);
                    } catch (RuntimeException ignored) {
                        // Persistence succeeded. Do not report a failed save or prompt a duplicate retry
                        // solely because the OS declined scheduling; Receiver still rechecks revisions.
                    }
                    return new JSONObject().put("ok", true).put("todo", todo).toString();
                }
                if ("replaceAll".equals(op)) {
                    JSONArray previous = store.list(null);
                    // Validation and transaction finish before touching any old alarm.
                    store.replaceAll(command.getJSONArray("todos"));
                    for (int i = 0; i < previous.length(); i++) {
                        try { cancel(activity, previous.getJSONObject(i)); }
                        catch (RuntimeException ignored) { /* A stale alarm will recheck the new truth source. */ }
                    }
                    reconcile(activity);
                    return new JSONObject().put("ok", true).toString();
                }
                if ("configure".equals(op)) {
                    if (!(command.get("enabled") instanceof Boolean)) throw new IllegalArgumentException("enabled 必须是布尔值");
                    store.setEnabled(command.getBoolean("enabled"));
                    reconcile(activity);
                    return capabilities(activity).toString();
                }
                if ("requestPermissions".equals(op)) {
                    store.setEnabled(true);
                    activity.runOnUiThread(() -> requestPermissions(activity));
                    reconcile(activity);
                    return capabilities(activity).toString();
                }
                if ("capabilities".equals(op)) return capabilities(activity).toString();
                throw new IllegalArgumentException("未知待办命令");
            } catch (Exception e) {
                try { return new JSONObject().put("ok", false).put("error", e instanceof IllegalArgumentException ? e.getMessage() : "原生待办存储操作失败").toString(); }
                catch (Exception ignored) { return "{\"ok\":false,\"error\":\"原生待办操作失败\"}"; }
            }
        }
    }

    private static void requestPermissions(Activity activity) {
        if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, PERMISSION_REQUEST);
        } else {
            requestExactPermission(activity);
        }
    }

    public static void requestExactPermission(Activity activity) {
        if (Build.VERSION.SDK_INT >= 31 && TodoStore.get(activity).enabled() && notificationsGranted(activity) && !exactGranted(activity)) {
            try {
                Intent settings = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                        Uri.parse("package:" + activity.getPackageName()));
                activity.startActivity(settings);
            } catch (Exception ignored) {
                // No compatible settings UI: capabilities continues to report denied.
            }
        }
    }

    private static String tag(JSONObject todo) { return "todo:" + todo.optString("space") + ":" + todo.optString("id"); }

    private static Uri identity(JSONObject todo, String kind) {
        return new Uri.Builder().scheme("looma-todo").authority(kind)
                .appendPath(todo.optString("space")).appendPath(todo.optString("id")).build();
    }

    private static PendingIntent alarmIntent(Context context, JSONObject todo) {
        Intent intent = new Intent(context, TodoReceiver.class).setAction(ACTION_DUE).setData(identity(todo, "alarm"));
        intent.putExtra(EXTRA_SPACE, todo.optString("space"));
        intent.putExtra(EXTRA_ID, todo.optString("id"));
        intent.putExtra("revision", todo.optLong("revision"));
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    public static void cancelNotification(Context context, JSONObject todo) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(tag(todo), 0);
    }

    private static void cancelAlarm(Context context, JSONObject todo) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        PendingIntent pending = alarmIntent(context, todo);
        if (alarms != null) alarms.cancel(pending);
        pending.cancel();
    }

    private static void cancel(Context context, JSONObject todo) {
        cancelAlarm(context, todo);
        cancelNotification(context, todo);
    }

    private static void reconcileOne(Context context, JSONObject todo) {
        cancelAlarm(context, todo);
        if (!TodoStore.get(context).enabled() || !notificationsGranted(context)
                || !"pending".equals(todo.optString("status")) || !todo.has("dueAt")
                || todo.optBoolean("needsTime", false)) {
            cancelNotification(context, todo);
            return;
        }
        if (todo.optLong("notifiedRevision", 0) == todo.optLong("revision")) return;
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (alarms == null) return;
        long due = TodoRules.parseDueAt(todo.optString("dueAt"));
        long when = Math.max(System.currentTimeMillis() + 100, due);
        PendingIntent pending = alarmIntent(context, todo);
        try {
            if (exactGranted(context)) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pending);
            else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pending);
        } catch (SecurityException denied) {
            // Exact permission can be revoked between the check and setExact.
            try { alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pending); }
            catch (RuntimeException ignored) { /* Stored todo remains pending and retryable. */ }
        }
    }

    public static void reconcile(Context context) {
        synchronized (TodoStore.LOCK) {
            try {
                JSONArray todos = TodoStore.get(context).list(null);
                for (int i = 0; i < todos.length(); i++) reconcileOne(context, todos.getJSONObject(i));
            } catch (Exception ignored) { /* Do not crash boot or the Activity on inaccessible storage. */ }
        }
    }

    public static void fire(Context context, Intent intent) {
        synchronized (TodoStore.LOCK) {
            try {
                TodoStore store = TodoStore.get(context);
                JSONObject todo = store.find(intent.getStringExtra(EXTRA_SPACE), intent.getStringExtra(EXTRA_ID));
                if (todo == null || !store.enabled() || !notificationsGranted(context) || !todo.has("dueAt") || todo.optBoolean("needsTime", false)) return;
                long due = TodoRules.parseDueAt(todo.getString("dueAt"));
                long now = System.currentTimeMillis();
                if (!TodoRules.shouldNotify(todo.getString("status"), todo.getLong("revision"),
                        todo.optLong("notifiedRevision", 0), intent.getLongExtra("revision", -1), due, now)) {
                    // A backwards time change must not lose a still-future current alarm.
                    if (due > now && todo.getLong("revision") == intent.getLongExtra("revision", -1)) reconcileOne(context, todo);
                    return;
                }
                Intent open = new Intent(context, MainActivity.class).setAction("com.looma.agent.TODO_FOCUS")
                        .setData(identity(todo, "focus")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                open.putExtra(EXTRA_SPACE, todo.getString("space"));
                open.putExtra(EXTRA_ID, todo.getString("id"));
                PendingIntent click = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                Notification notification = new Notification.Builder(context, CHANNEL_ID)
                        .setSmallIcon(android.R.drawable.ic_popup_reminder)
                        .setContentTitle(todo.getString("title"))
                        .setContentText(TodoRules.notificationBody(todo.getString("dueAt"), now))
                        .setContentIntent(click).setAutoCancel(true)
                        .setVisibility(Notification.VISIBILITY_PRIVATE).build();
                NotificationManager manager = context.getSystemService(NotificationManager.class);
                if (manager == null) return;
                manager.notify(tag(todo), 0, notification);
                // Never stamp a failed notify as sent. All mutations share the same lock.
                store.markNotified(todo, now);
            } catch (Exception ignored) { /* Permission/OS failures do not mark the record delivered. */ }
        }
    }
}
