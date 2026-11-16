package com.ppapi.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.File;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Foreground download host.
 *
 * <p>Running as a foreground service keeps the transfer alive when the app is
 * backgrounded or the screen turns off, and gives the user a system progress bar
 * next to the in-app one.
 */
public final class UpdateService extends Service {
    static final String CHANNEL_ID = "ppapi_update_download";
    private static final int NOTIFICATION_ID = 8022;

    static final String ACTION_START = "com.ppapi.mobile.UPDATE_START";
    static final String ACTION_CANCEL = "com.ppapi.mobile.UPDATE_CANCEL";
    static final String EXTRA_RELEASE = "release";

    private static final AtomicBoolean CANCEL = new AtomicBoolean(false);
    private static volatile Thread worker;

    // Snapshot of the live transfer, polled by the WebView side while a download runs.
    static volatile long dlDone, dlTotal, dlSpeed;
    static volatile int dlAttempt = 1;
    static volatile String dlState = "idle";
    static volatile String dlMessage = "";
    static volatile String dlVersion = "";

    static boolean running() { return worker != null && worker.isAlive(); }
    static void requestCancel() {
        CANCEL.set(true);
        Thread current = worker;
        if (current != null) current.interrupt();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        if (ACTION_CANCEL.equals(intent.getAction())) {
            requestCancel();
            return START_NOT_STICKY;
        }
        String raw = intent.getStringExtra(EXTRA_RELEASE);
        if (raw == null) { stopSelf(); return START_NOT_STICKY; }
        if (running()) return START_NOT_STICKY;
        CANCEL.set(false);
        dlState = "running"; dlMessage = ""; dlDone = 0; dlTotal = 0; dlSpeed = 0; dlAttempt = 1;
        try { dlVersion = new JSONObject(raw).optString("version", ""); } catch (Exception ignored) { dlVersion = ""; }
        startForeground(NOTIFICATION_ID, notification(0, 0, "准备下载", 0));
        Thread thread = new Thread(new Task(raw), "ppapi-update-download");
        worker = thread;
        thread.start();
        return START_NOT_STICKY;
    }

    private final class Task implements Runnable {
        private final String raw;
        private long lastNotify = 0L;

        Task(String raw) { this.raw = raw; }

        @Override public void run() {
            try {
                JSONObject release = new JSONObject(raw);
                UpdateClient.validateRelease(release);
                File target = MainActivity.updateFile(UpdateService.this);
                if (target == null) throw new IllegalStateException("下载目录不可用");
                UpdateDownloader.run(target, release, CANCEL, new UpdateDownloader.Progress() {
                    @Override public void onProgress(long downloaded, long total, long speed, int attempt) {
                        publish(downloaded, total, speed, attempt);
                    }
                });
                UpdateClient.verifyApk(UpdateService.this, target, release);
                UpdateClient.prefs(UpdateService.this).edit()
                        .putString(UpdateClient.READY_VERSION_KEY, release.getString("version")).apply();
                dlState = "ready"; dlMessage = "";
                downloadFinished(release, null);
            } catch (UpdateDownloader.Cancelled cancelled) {
                dlState = "cancelled"; dlMessage = "已取消下载";
                downloadFinished(null, "已取消下载");
            } catch (Exception error) {
                String message = error.getMessage() == null ? "下载失败" : error.getMessage();
                dlState = "error"; dlMessage = message;
                downloadFinished(null, message);
            } finally {
                worker = null;
                stopForeground(true);
                stopSelf();
            }
        }

        private void publish(long downloaded, long total, long speed, int attempt) {
            dlDone = downloaded; dlTotal = total; dlSpeed = speed; dlAttempt = attempt;
            long now = System.currentTimeMillis();
            if (now - lastNotify < 400 && downloaded > 0 && total > 0 && downloaded < total) return;
            lastNotify = now;
            int percent = total > 0 ? (int) Math.min(100, Math.max(0, downloaded * 100 / total)) : 0;
            String text = total > 0
                    ? UpdateDownloader.humanSize(downloaded) + " / " + UpdateDownloader.humanSize(total) + " · " + percent + "%"
                    : UpdateDownloader.humanSize(downloaded);
            if (speed > 0) text += " · " + UpdateDownloader.humanSize(speed) + "/s";
            if (attempt > 1) text += " · 第 " + attempt + " 次尝试";
            try {
                NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (manager != null) manager.notify(NOTIFICATION_ID, notification(downloaded, total, text, percent));
            } catch (SecurityException ignored) {}
        }
    }

    private void downloadFinished(JSONObject release, String message) {
        try {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.cancel(NOTIFICATION_ID);
        } catch (Exception ignored) {}
        MainActivity.notifyDownloadFinished(this, release, message);
    }

    private Notification notification(long downloaded, long total, String text, int percent) {
        Intent open = new Intent(this, MainActivity.class).setAction(MainActivity.ACTION_UPDATE)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, channel())
                : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("Pp API 正在下载更新")
                .setContentText(text)
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setContentIntent(pending);
        if (total > 0) builder.setProgress(100, percent, false);
        else builder.setProgress(0, 0, true);
        Intent cancel = new Intent(this, UpdateService.class).setAction(ACTION_CANCEL);
        PendingIntent stop = PendingIntent.getService(this, 1, cancel, flags);
        builder.addAction(new Notification.Action.Builder(
                Build.VERSION.SDK_INT >= 23 ? android.R.drawable.ic_menu_close_clear_cancel : 0, "取消", stop).build());
        return builder.build();
    }

    private String channel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "更新下载",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.createNotificationChannel(channel);
        }
        return CHANNEL_ID;
    }
}
