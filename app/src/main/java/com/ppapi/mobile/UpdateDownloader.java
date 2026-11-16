package com.ppapi.mobile;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Streams a release asset to disk.
 *
 * <p>The transfer is driven by the app instead of DownloadManager so a slow
 * connection cannot be cancelled by an inactivity policy we do not control.
 * Reads have a generous inactivity window (not a whole-request deadline), the
 * partial file is kept between attempts, and each retry continues with a Range
 * request instead of starting over.
 */
final class UpdateDownloader {
    interface Progress {
        /** @param attempt 1 for the first pass; larger values mean a resumed retry. */
        void onProgress(long downloaded, long total, long bytesPerSecond, int attempt);
    }

    static final class Cancelled extends IOException {
        Cancelled() { super("已取消下载"); }
    }

    private static final int CONNECT_TIMEOUT = 30000;
    /** Time allowed between two reads. Slow links are fine; a dead socket is not. */
    private static final int READ_TIMEOUT = 180000;
    private static final int MAX_ATTEMPTS = 20;
    private static final int BUFFER = 64 * 1024;
    private static final long PROGRESS_INTERVAL = 200L;

    private UpdateDownloader() {}

    static File partFile(File target) { return new File(target.getPath() + UpdateClient.PART_SUFFIX); }

    static void run(File target, JSONObject release, AtomicBoolean cancel, Progress progress) throws Exception {
        String url = release.getString("url");
        long expected = release.getLong("size");
        File part = partFile(target);
        File parent = part.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("下载目录不可用");
        Exception last = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (cancel.get()) throw new Cancelled();
            long already = part.isFile() ? part.length() : 0;
            if (already > expected) { if (!part.delete()) throw new IOException("无法清理临时文件"); already = 0; }
            if (already == expected && expected > 0) { finish(part, target); return; }
            progress.onProgress(already, expected, 0, attempt);
            try {
                transfer(url, part, expected, cancel, progress, attempt);
                if (part.length() != expected) throw new IOException("连接提前结束");
                finish(part, target);
                progress.onProgress(expected, expected, 0, attempt);
                return;
            } catch (Cancelled cancelled) {
                throw cancelled;
            } catch (Exception error) {
                last = error;
                if (cancel.get()) throw new Cancelled();
                if (attempt == MAX_ATTEMPTS) break;
                long wait = Math.min(20000L, 1500L * (1L << Math.min(4, attempt - 1)));
                // Keep the partial file: the next attempt resumes from here.
                try {
                    Thread.sleep(wait);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new Cancelled();
                }
                progress.onProgress(part.isFile() ? part.length() : 0, expected, 0, attempt + 1);
            }
        }
        throw new IOException("下载失败：" + (last == null ? "网络不可用" : String.valueOf(last.getMessage())), last);
    }

    private static void finish(File part, File target) throws IOException {
        if (target.isFile() && !target.delete()) throw new IOException("无法覆盖旧安装包");
        if (!part.renameTo(target)) throw new IOException("无法保存安装包");
    }

    private static void transfer(String url, File part, long expected, AtomicBoolean cancel,
                                 Progress progress, int attempt) throws IOException {
        long already = part.isFile() ? part.length() : 0;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(CONNECT_TIMEOUT);
            connection.setReadTimeout(READ_TIMEOUT);
            connection.setInstanceFollowRedirects(true);
            connection.setUseCaches(false);
            // Identity keeps byte offsets stable for Range, and the length comparable to the asset size.
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("User-Agent", "PpAPI-Android-Updater");
            if (already > 0) connection.setRequestProperty("Range", "bytes=" + already + "-");
            int status = connection.getResponseCode();
            if (status == 416) {
                // Nothing left to send: treat a full-size part as complete, otherwise retry from zero.
                if (already == expected) return;
                if (!part.delete()) throw new IOException("无法重置下载");
                throw new IOException("服务器拒绝了续传请求");
            }
            if (status != 200 && status != 206) throw new IOException("更新源返回 " + status);
            long start = status == 206 ? already : 0;
            if (status == 200 && already > 0) {
                // The server ignored Range; start the file over rather than corrupting it.
                already = 0;
                start = 0;
            }
            long total = totalBytes(connection, expected, start);
            long done = start;
            long windowStart = System.currentTimeMillis();
            long windowBytes = 0;
            long lastReport = 0L;
            try (InputStream raw = new BufferedInputStream(connection.getInputStream(), BUFFER);
                 FileOutputStream out = new FileOutputStream(part, start > 0)) {
                byte[] buffer = new byte[BUFFER];
                int count;
                while ((count = raw.read(buffer)) != -1) {
                    if (cancel.get()) throw new Cancelled();
                    out.write(buffer, 0, count);
                    done += count;
                    windowBytes += count;
                    long now = System.currentTimeMillis();
                    if (now - lastReport >= PROGRESS_INTERVAL) {
                        lastReport = now;
                        long span = now - windowStart;
                        long speed = span > 0 ? windowBytes * 1000L / span : 0;
                        if (span >= 2000) { windowStart = now; windowBytes = 0; }
                        progress.onProgress(done, total > 0 ? total : expected, speed, attempt);
                    }
                }
                out.flush();
            }
            progress.onProgress(done, total > 0 ? total : expected, 0, attempt);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Resolves the full asset size, which differs between a 200 and a 206 response. */
    private static long totalBytes(HttpURLConnection connection, long fallback, long resumedFrom) {
        String range = connection.getHeaderField("Content-Range");
        if (range != null) {
            int slash = range.lastIndexOf('/');
            if (slash >= 0) {
                try { return Long.parseLong(range.substring(slash + 1).trim()); } catch (NumberFormatException ignored) {}
            }
        }
        long length = connection.getContentLengthLong();
        // On a 206 the reported length is only the remaining slice.
        if (length > 0) return resumedFrom > 0 ? length + resumedFrom : length;
        return fallback;
    }

    static String humanSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(Locale.US, "%.0f KB", bytes / 1024.0);
        return String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0));
    }
}
