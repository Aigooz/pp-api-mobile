package com.ppapi.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONObject;

public final class UpdateJobService extends JobService {
    private static final int JOB_ID = 8021;
    private static final String CHANNEL_ID = "ppapi_updates";

    static void schedule(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return;
        for (JobInfo existing : scheduler.getAllPendingJobs()) {
            if (existing.getId() == JOB_ID) return;
        }
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(context, UpdateJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(12L * 60 * 60 * 1000)
                .setPersisted(true)
                .build();
        scheduler.schedule(job);
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject release = UpdateClient.fetchLatest();
                    if (release != null && UpdateClient.compareVersions(release.getString("version"), UpdateClient.currentVersion(UpdateJobService.this)) > 0) {
                        notifyUpdate(release.getString("version"));
                    }
                } catch (Exception ignored) {
                    // A later scheduled check can retry network or GitHub failures.
                } finally {
                    jobFinished(params, false);
                }
            }
        }, "ppapi-update-check").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) { return false; }

    private void notifyUpdate(String version) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (version.equals(getSharedPreferences(UpdateClient.PREFERENCES, MODE_PRIVATE).getString("notified_version", ""))) return;
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        if (Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "软件更新", NotificationManager.IMPORTANCE_DEFAULT));
            NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return;
        }
        Intent intent = new Intent(this, MainActivity.class).setAction(MainActivity.ACTION_UPDATE)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(this, 0, intent, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Pp API 有新版本")
                .setContentText("版本 " + version + " 已发布，点击查看更新")
                .setContentIntent(pending)
                .setAutoCancel(true);
        try {
            manager.notify(JOB_ID, builder.build());
            getSharedPreferences(UpdateClient.PREFERENCES, MODE_PRIVATE).edit().putString("notified_version", version).apply();
        } catch (SecurityException ignored) {}
    }
}
