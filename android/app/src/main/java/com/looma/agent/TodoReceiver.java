package com.looma.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Explicit one-shot alarms plus protected system broadcasts; never needs a WebView. */
public final class TodoReceiver extends BroadcastReceiver {
    private static final ExecutorService WORK = Executors.newSingleThreadExecutor();

    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!TodoScheduler.ACTION_DUE.equals(action)
                && !Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_TIME_CHANGED.equals(action)
                && !Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                && !"android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED".equals(action)) return;
        PendingResult result = goAsync();
        Context app = context.getApplicationContext();
        WORK.execute(() -> {
            try {
                if (TodoScheduler.ACTION_DUE.equals(action)) TodoScheduler.fire(app, intent);
                else TodoScheduler.reconcile(app);
            } finally { result.finish(); }
        });
    }
}
