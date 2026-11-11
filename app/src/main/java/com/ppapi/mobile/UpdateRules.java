package com.ppapi.mobile;

import java.util.regex.Pattern;

final class UpdateRules {
    static final String REPOSITORY = "Aigooz/pp-api-mobile-updates";
    static final String ASSET_NAME = "Pp-API-android.apk";
    static final long MAX_SIZE = 100L * 1024 * 1024;
    private static final Pattern TAG = Pattern.compile("v?[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6}");
    private static final Pattern DIGEST = Pattern.compile("sha256:[0-9a-f]{64}");

    private UpdateRules() {}

    static void validate(String tag, String version, String url, String digest, long size) {
        String expectedUrl = "https://github.com/" + REPOSITORY + "/releases/download/" + tag + "/" + ASSET_NAME;
        String expectedVersion = tag.startsWith("v") ? tag.substring(1) : tag;
        if (!TAG.matcher(tag).matches() || !expectedVersion.equals(version) || !expectedUrl.equals(url) ||
                !DIGEST.matcher(digest).matches() || size <= 0 || size > MAX_SIZE) {
            throw new IllegalArgumentException("更新包信息不完整或不可信");
        }
    }

    static int compareVersions(String first, String second) {
        String a = first.startsWith("v") ? first.substring(1) : first;
        String b = second.startsWith("v") ? second.substring(1) : second;
        if (!TAG.matcher(a).matches() || !TAG.matcher(b).matches()) return 0;
        String[] aa = a.split("\\."), bb = b.split("\\.");
        for (int i = 0; i < 3; i++) {
            int difference = Integer.parseInt(aa[i]) - Integer.parseInt(bb[i]);
            if (difference != 0) return difference;
        }
        return 0;
    }
}
