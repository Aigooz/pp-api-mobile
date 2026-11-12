package com.ppapi.mobile;

public final class UpdateRulesTest {
    private static final String HASH = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String URL = "https://github.com/Aigooz/pp-api-mobile/releases/download/v1.2.3/Pp-API-android.apk";

    private static void require(boolean value) {
        if (!value) throw new AssertionError();
    }

    private static void invalid(String tag, String version, String url, String digest, long size) {
        try {
            UpdateRules.validate(tag, version, url, digest, size);
            throw new AssertionError("invalid update accepted");
        } catch (IllegalArgumentException expected) {}
    }

    public static void main(String[] args) {
        require(UpdateRules.compareVersions("1.2.0", "1.1.9") > 0);
        require(UpdateRules.compareVersions("v2.0.0", "1.99.99") > 0);
        require(UpdateRules.compareVersions("1.2.3", "v1.2.3") == 0);
        require(UpdateRules.compareVersions("1.2.2", "1.2.3") < 0);
        require(UpdateRules.compareVersions("invalid", "1.2.3") == 0);
        UpdateRules.validate("v1.2.3", "1.2.3", URL, HASH, 1024);
        invalid("v1.2.3", "1.2.4", URL, HASH, 1024);
        invalid("v1.2.3", "1.2.3", URL.replace("github.com", "github.com.attacker.test"), HASH, 1024);
        invalid("v1.2.3", "1.2.3", URL.replace("Aigooz", "someone"), HASH, 1024);
        invalid("v1.2.3", "1.2.3", URL.replace("pp-api-mobile/releases", "pp-api-mobile-updates/releases"), HASH, 1024);
        invalid("v1.2.3", "1.2.3", URL.replace("v1.2.3/", "v1.2.4/"), HASH, 1024);
        invalid("v1.2.3", "1.2.3", URL + "?download=1", HASH, 1024);
        invalid("v1.2.3", "1.2.3", URL, "", 1024);
        invalid("v1.2.3", "1.2.3", URL, HASH, 0);
        invalid("v1.2.3", "1.2.3", URL, HASH, UpdateRules.MAX_SIZE + 1);
        invalid("v1.2.3-beta", "1.2.3-beta", URL, HASH, 1024);
        System.out.println("Update rules: version ordering and release validation passed");
    }
}
