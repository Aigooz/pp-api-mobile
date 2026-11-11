package com.ppapi.mobile;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;

final class UpdateClient {
    static final String REPOSITORY = UpdateRules.REPOSITORY;
    static final String API_URL = "https://api.github.com/repos/" + REPOSITORY + "/releases/latest";
    static final String ASSET_NAME = UpdateRules.ASSET_NAME;
    static final String PREFERENCES = "ppapi_updates";
    static final String RELEASE_KEY = "release";
    static final String DOWNLOAD_RELEASE_KEY = "download_release";
    static final String DOWNLOAD_KEY = "download_id";

    private UpdateClient() {}

    static JSONObject fetchLatest() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(API_URL).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(20000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/vnd.github+json");
        connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
        connection.setRequestProperty("User-Agent", "PpAPI-Android-Updater");
        try {
            int status = connection.getResponseCode();
            if (status == 404) throw new IllegalStateException("未找到 GitHub 更新源");
            if (status != 200) throw new IllegalStateException("GitHub 暂时无法访问 (" + status + ")");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (InputStream in = connection.getInputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = in.read(buffer)) != -1) {
                    if (out.size() + count > 512 * 1024) throw new IllegalStateException("版本信息过大");
                    out.write(buffer, 0, count);
                }
            }
            JSONObject response = new JSONObject(out.toString("UTF-8"));
            if (response.optBoolean("draft") || response.optBoolean("prerelease")) return null;
            String tag = response.optString("tag_name", "");
            JSONArray assets = response.optJSONArray("assets");
            if (assets == null) throw new IllegalStateException("没有找到 Android 安装包");
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.optJSONObject(i);
                if (asset == null || !ASSET_NAME.equals(asset.optString("name")) ||
                        !"uploaded".equals(asset.optString("state"))) continue;
                JSONObject release = new JSONObject();
                release.put("tag", tag);
                release.put("version", tag.startsWith("v") ? tag.substring(1) : tag);
                String notes = response.optString("body", "");
                release.put("notes", notes.length() > 12000 ? notes.substring(0, 12000) : notes);
                release.put("url", asset.optString("browser_download_url", ""));
                release.put("digest", asset.optString("digest", "").toLowerCase(Locale.US));
                release.put("size", asset.optLong("size", 0));
                validateRelease(release);
                return release;
            }
            throw new IllegalStateException("没有找到 Android 安装包");
        } finally {
            connection.disconnect();
        }
    }

    static void validateRelease(JSONObject release) throws Exception {
        String tag = release.optString("tag", "");
        String url = release.optString("url", "");
        long size = release.optLong("size", 0);
        UpdateRules.validate(tag, release.optString("version", ""), url, release.optString("digest", ""), size);
    }

    static int compareVersions(String first, String second) {
        return UpdateRules.compareVersions(first, second);
    }

    static String currentVersion(Context context) {
        try { return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName; }
        catch (PackageManager.NameNotFoundException e) { return "0.0.0"; }
    }

    @SuppressWarnings("deprecation")
    static void verifyApk(Context context, File file, JSONObject release) throws Exception {
        validateRelease(release);
        if (!file.isFile() || file.length() != release.getLong("size")) throw new IllegalStateException("安装包大小不匹配，请重新下载");
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[32768];
            int count;
            while ((count = in.read(buffer)) != -1) sha.update(buffer, 0, count);
        }
        StringBuilder hash = new StringBuilder("sha256:");
        for (byte b : sha.digest()) hash.append(String.format(Locale.US, "%02x", b & 0xff));
        if (!hash.toString().equals(release.getString("digest"))) throw new IllegalStateException("安装包校验失败，请重新下载");
        PackageManager manager = context.getPackageManager();
        PackageInfo installed = manager.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNATURES);
        PackageInfo candidate = manager.getPackageArchiveInfo(file.getAbsolutePath(), PackageManager.GET_SIGNATURES);
        if (candidate == null || !context.getPackageName().equals(candidate.packageName) ||
                compareVersions(candidate.versionName == null ? "" : candidate.versionName, currentVersion(context)) <= 0 ||
                !release.getString("version").equals(candidate.versionName) ||
                versionCode(candidate) <= versionCode(installed) || !sameSignatures(installed.signatures, candidate.signatures)) {
            throw new IllegalStateException("安装包版本或签名不匹配");
        }
    }

    @SuppressWarnings("deprecation")
    private static long versionCode(PackageInfo info) {
        return android.os.Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private static boolean sameSignatures(Signature[] current, Signature[] candidate) {
        if (current == null || candidate == null || current.length == 0 || current.length != candidate.length) return false;
        return Arrays.asList(current).containsAll(Arrays.asList(candidate));
    }
}
