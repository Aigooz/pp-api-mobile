package com.ppapi.mobile;

import android.app.Activity;
import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Environment;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.WindowInsets;
import android.animation.ArgbEvaluator;
import android.animation.ValueAnimator;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.File;
import java.io.OutputStream;
import java.io.BufferedReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.KeyStore;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;
import java.util.zip.GZIPInputStream;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Pp API Android shell.
 * The whole UI lives in assets/www (a single-page app) and talks to the
 * gateway through {@link Bridge}, which sidesteps WebView CORS limits.
 */
public class MainActivity extends Activity {

    private static final String START_URL = "file:///android_asset/www/index.html";
    static final String ACTION_UPDATE = "com.ppapi.mobile.UPDATE";
    private static final int NOTIFICATION_PERMISSION = 8101;
    private static final int INSTALL_PERMISSION = 8102;

    private WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final ExecutorService streamPool = Executors.newFixedThreadPool(4);
    private final Map<String, FutureTask<Void>> streamJobs = new ConcurrentHashMap<>();
    private final Map<String, HttpURLConnection> active = new ConcurrentHashMap<String, HttpURLConnection>();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private long lastBackPress = 0L;
    private long backNavigationPendingUntil = 0L;
    private boolean openUpdatesOnLoad;
    private Boolean lastKeyboardVisible;
    private int lastKeyboardOverlap = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        w.setStatusBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            w.setNavigationBarColor(Color.TRANSPARENT);
            w.setStatusBarColor(Color.TRANSPARENT);
            w.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            w.setNavigationBarDividerColor(Color.TRANSPARENT);
        }

        web = new WebView(this);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        openUpdatesOnLoad = ACTION_UPDATE.equals(getIntent().getAction());
        web.setBackgroundColor(Color.parseColor("#0E1113"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if (u.toString().startsWith(START_URL + "#") || u.toString().equals(START_URL)) return false;
                if (scheme.equals("https") || scheme.equals("http") || scheme.equals("mailto")) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Work out how much (if any) the window already insets the WebView.
                // With targetSdk 34 the system normally places the view below the
                // status bar, so no extra CSS padding is needed.
                try {
                    int[] loc = new int[2];
                    view.getLocationOnScreen(loc);
                    float d = getResources().getDisplayMetrics().density;
                    int statusBar = 0;
                    int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
                    if (id > 0) statusBar = getResources().getDimensionPixelSize(id);
                    float cssTop = loc[1] > 0 ? 0f : statusBar / (d == 0 ? 1 : d);
                    int navigationBar = 0;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && view.getRootWindowInsets() != null) {
                        navigationBar = view.getRootWindowInsets().getSystemWindowInsetBottom();
                    } else {
                        int navId = getResources().getIdentifier("navigation_bar_height", "dimen", "android");
                        if (navId > 0) navigationBar = getResources().getDimensionPixelSize(navId);
                    }
                    int[] windowLoc = new int[2];
                    view.getLocationInWindow(windowLoc);
                    int alreadyInset = Math.max(0, w.getDecorView().getHeight() - windowLoc[1] - view.getHeight());
                    float cssBottom = Math.max(0, navigationBar - alreadyInset) / (d == 0 ? 1 : d);
                    view.evaluateJavascript("window.__applyInsets && window.__applyInsets("
                            + cssTop + "," + cssBottom + ")", null);
                    lastKeyboardVisible = null;
                    syncKeyboardState();
                    if (openUpdatesOnLoad) {
                        openUpdatesOnLoad = false;
                        view.evaluateJavascript("window.App && window.App.go('#/updates', true)", null);
                    }
                } catch (Exception ignored) {}
            }
        });

        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "Native");
        web.loadUrl(START_URL);

        setContentView(web);
        web.getViewTreeObserver().addOnGlobalLayoutListener(this::syncKeyboardState);
        UpdateJobService.schedule(this);
    }

    private void syncKeyboardState() {
        if (web == null || web.getHeight() == 0) return;
        Rect frame = new Rect();
        web.getWindowVisibleDisplayFrame(frame);
        int[] location = new int[2];
        web.getLocationOnScreen(location);
        float density = Math.max(1f, getResources().getDisplayMetrics().density);
        boolean visible;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && web.getRootWindowInsets() != null) {
            visible = web.getRootWindowInsets().isVisible(WindowInsets.Type.ime());
        } else {
            visible = web.getRootView().getHeight() - frame.height() > 120f * density;
        }
        // adjustResize may already end the WebView at the keyboard edge. Only
        // send the still-covered portion, never the full IME height twice.
        int overlap = visible ? Math.max(0, Math.round((location[1] + web.getHeight() - frame.bottom) / density)) : 0;
        if (lastKeyboardVisible != null && lastKeyboardVisible == visible && lastKeyboardOverlap == overlap) return;
        lastKeyboardVisible = visible;
        lastKeyboardOverlap = overlap;
        web.evaluateJavascript("window.__ppKeyboard={visible:" + visible + ",overlap:" + overlap
                + "};window.__applyKeyboard&&window.__applyKeyboard(window.__ppKeyboard)", null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (ACTION_UPDATE.equals(intent.getAction())) callJs("window.App && window.App.go('#/updates', true)");
    }

    private String jsStr(String s) {
        if (s == null) return "null";
        return JSONObject.quote(s);
    }

    private void callJs(final String js) {
        ui.post(new Runnable() {
            @Override public void run() {
                if (web != null) {
                    try { web.evaluateJavascript(js, null); } catch (Exception ignored) {}
                }
            }
        });
    }

    private static String b64(String s) {
        return Base64.encodeToString(s.getBytes(java.nio.charset.Charset.forName("UTF-8")), Base64.NO_WRAP);
    }

    private HttpURLConnection openConn(String method, String url, String headersJson, String body) throws Exception {
        URL target = new URL(url);
        String host = target.getHost();
        if (!"https".equalsIgnoreCase(target.getProtocol())
                || !("ipkey.vip".equalsIgnoreCase(host) || "api.ipkey.vip".equalsIgnoreCase(host))
                || target.getUserInfo() != null || (target.getPort() != -1 && target.getPort() != 443)) {
            throw new SecurityException("Unsupported network destination");
        }
        HttpURLConnection c = (HttpURLConnection) target.openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(20000);
        c.setReadTimeout(120000);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("Accept-Encoding", "gzip");
        c.setRequestProperty("User-Agent", "PpAPI-Android/1.0");
        if (headersJson != null && headersJson.length() > 2) {
            JSONObject h = new JSONObject(headersJson);
            Iterator<String> it = h.keys();
            while (it.hasNext()) {
                String k = it.next();
                String v = h.optString(k, null);
                if (v != null) c.setRequestProperty(k, v);
            }
        }
        if (body != null && body.length() > 0 && !"GET".equals(method) && !"DELETE".equals(method)) {
            c.setDoOutput(true);
            byte[] bytes = body.getBytes("UTF-8");
            c.setFixedLengthStreamingMode(bytes.length);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            OutputStream os = c.getOutputStream();
            os.write(bytes);
            os.flush();
            os.close();
        }
        return c;
    }

    private static String readAll(InputStream raw) throws Exception {
        if (raw == null) return "";
        InputStream in = new BufferedInputStream(raw);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    private static String readBody(HttpURLConnection c) throws Exception {
        int code = c.getResponseCode();
        String enc = c.getContentEncoding();
        InputStream raw = code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (raw != null && enc != null && enc.toLowerCase().contains("gzip")) {
            raw = new GZIPInputStream(new BufferedInputStream(raw));
        }
        return readAll(raw);
    }

    private static String headersJson(HttpURLConnection c) {
        JSONObject o = new JSONObject();
        try {
            for (Map.Entry<String, java.util.List<String>> e : c.getHeaderFields().entrySet()) {
                if (e.getKey() == null || e.getValue() == null || e.getValue().isEmpty()) continue;
                try { o.put(e.getKey().toLowerCase(), e.getValue().get(0)); } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
        return o.toString();
    }

    @Override
    public void onBackPressed() {
        if (web != null) {
            long now = System.currentTimeMillis();
            if (now < backNavigationPendingUntil) {
                return;
            }
            backNavigationPendingUntil = now + 120L;
            web.evaluateJavascript("window.__ppBack ? window.__ppBack() : false", new ValueCallback<String>() {
                @Override public void onReceiveValue(String handled) {
                    if ("true".equals(handled)) return;
                    exitAfterBack();
                }
            });
            return;
        }
        exitAfterBack();
    }

    private void exitAfterBack() {
        long now = System.currentTimeMillis();
        if (now - lastBackPress < 2000) {
            super.onBackPressed();
        } else {
            lastBackPress = now;
            Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onDestroy() {
        pool.shutdownNow();
        streamPool.shutdownNow();
        for (FutureTask<Void> task : streamJobs.values()) task.cancel(true);
        streamJobs.clear();
        for (HttpURLConnection c : active.values()) {
            try { c.disconnect(); } catch (Exception ignored) {}
        }
        if (web != null) web.destroy();
        super.onDestroy();
    }

    static File updateFile(Context context) {
        File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        return dir == null ? null : new File(dir, UpdateClient.ASSET_NAME);
    }

    private void updateCallback(String state, JSONObject data) {
        if ("downloading".equals(state) && data != null && !data.has("version")) {
            // Progress snapshots only carry numbers; merge in the release the page needs.
            try {
                JSONObject release = savedRelease(UpdateClient.DOWNLOAD_RELEASE_KEY);
                for (String key : new String[]{"version", "tag", "notes", "url", "size"}) {
                    if (release.has(key)) data.put(key, release.get(key));
                }
            } catch (Exception ignored) {}
        }
        callJs("window.__nativeUpdate && window.__nativeUpdate(" + jsStr(state) + "," + jsStr(data == null ? "{}" : data.toString()) + ")");
    }

    private void updateError(String message) {
        JSONObject result = new JSONObject();
        try { result.put("message", message); } catch (Exception ignored) {}
        updateCallback("error", result);
    }

    private JSONObject savedRelease(String key) throws Exception {
        String raw = UpdateClient.prefs(MainActivity.this).getString(key, "");
        JSONObject release = new JSONObject(raw);
        UpdateClient.validateRelease(release);
        return release;
    }

    private void checkUpdate(final boolean notifyIfCurrent) {
        updateCallback("checking", null);
        pool.execute(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject release = UpdateClient.fetchLatest();
                    if (release != null && UpdateClient.compareVersions(release.getString("version"), UpdateClient.currentVersion(MainActivity.this)) > 0) {
                        if (!UpdateClient.prefs(MainActivity.this).edit().putString(UpdateClient.RELEASE_KEY, release.toString()).commit()) {
                            throw new IllegalStateException("无法保存更新信息");
                        }
                        updateCallback("available", release);
                    } else {
                        UpdateClient.prefs(MainActivity.this).edit().remove(UpdateClient.RELEASE_KEY).apply();
                        updateCallback("current", null);
                    }
                } catch (Exception e) { updateError(e.getMessage() == null ? "检查更新失败" : e.getMessage()); }
            }
        });
    }

    static void notifyDownloadFinished(Context context, JSONObject release, String message) {
        MainActivity activity = mainActivity(context);
        if (activity == null) return; // The page polls a service progress snapshot.
        activity.ui.post(new Runnable() {
            @Override public void run() {
                if (release != null) activity.updateCallback("ready", release);
                else activity.updateError(message == null ? "下载失败" : message);
            }
        });
    }

    static void notifyDownloadCancelled(Context context) {
        MainActivity activity = mainActivity(context);
        if (activity != null) activity.updateError("已取消下载");
    }

    private static MainActivity mainActivity(Context context) {
        return context instanceof MainActivity ? (MainActivity) context : null;
    }

    private void downloadUpdate() {
        try {
            JSONObject release = savedRelease(UpdateClient.RELEASE_KEY);
            if (UpdateClient.compareVersions(release.getString("version"), UpdateClient.currentVersion(this)) <= 0) throw new IllegalStateException("当前已是最新版本");
            File target = updateFile(this);
            if (target == null) throw new IllegalStateException("下载目录不可用");
            if (target.exists() && !target.delete()) throw new IllegalStateException("无法清理旧安装包");
            File part = UpdateDownloader.partFile(target);
            if (part.isFile() && part.length() > release.getLong("size") && !part.delete()) throw new IllegalStateException("无法清理临时文件");
            if (!UpdateClient.prefs(MainActivity.this).edit().putString(UpdateClient.DOWNLOAD_RELEASE_KEY, release.toString()).commit()) {
                throw new IllegalStateException("无法保存下载任务");
            }
            Intent service = new Intent(this, UpdateService.class)
                    .setAction(UpdateService.ACTION_START)
                    .putExtra(UpdateService.EXTRA_RELEASE, release.toString());
            if (Build.VERSION.SDK_INT >= 26) {
                startForegroundService(service);
            } else {
                startService(service);
            }
            updateCallback("downloading", release);
        } catch (Exception e) { updateError(e.getMessage() == null ? "下载失败" : e.getMessage()); }
    }

    /** Live progress snapshot for the WebView; polled while the update page is open. */
    private JSONObject progressSnapshot() {
        JSONObject data = new JSONObject();
        try {
            data.put("downloaded", UpdateService.dlDone);
            data.put("total", UpdateService.dlTotal);
            data.put("speed", UpdateService.dlSpeed);
            data.put("attempt", UpdateService.dlAttempt);
            data.put("state", UpdateService.dlState);
            data.put("message", UpdateService.dlMessage);
            data.put("running", UpdateService.running());
        } catch (Exception ignored) {}
        return data;
    }

    private void installUpdate() {
        File file = updateFile(this);
        if (file == null || !file.isFile()) { updateError("请先下载更新"); return; }
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            try {
                startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())), INSTALL_PERMISSION);
            } catch (Exception e) { updateError("请在系统设置中允许本应用安装更新"); }
            return;
        }
        pool.execute(new Runnable() {
            @Override public void run() {
                try {
                    UpdateClient.verifyApk(MainActivity.this, updateFile(MainActivity.this), savedRelease(UpdateClient.DOWNLOAD_RELEASE_KEY));
                    Uri uri = UpdateFileProvider.uriFor(MainActivity.this);
                    Intent install = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    grantUriPermission("com.android.packageinstaller", uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    grantUriPermission("com.google.android.packageinstaller", uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    ui.post(new Runnable() { @Override public void run() {
                        try {
                            startActivity(install);
                            // The installer is a separate task; keep the app task out of
                            // the foreground until the user returns to it explicitly.
                            // This prevents Android from recreating a blank activity when
                            // the package replacement completes.
                            moveTaskToBack(true);
                        }
                        catch (Exception e) { updateError("无法打开系统安装器"); }
                    } });
                } catch (Exception e) { updateError(e.getMessage() == null ? "无法打开安装器" : e.getMessage()); }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == INSTALL_PERMISSION) {
            if (Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls()) installUpdate();
            else updateError("未允许安装更新，可稍后在系统设置中开启");
        }
    }

    /** JS <-> native bridge. Every method runs on the WebView's JS thread. */
    public class Bridge {

        private static final String AUTH_KEY_ALIAS = "ppapi.auth.v1";
        private static final String AUTH_PREFERENCES = "ppapi_secure";
        private static final String AUTH_VALUE = "auth_vault";

        private SecretKey authKey() throws Exception {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            if (keyStore.containsAlias(AUTH_KEY_ALIAS)) {
                return (SecretKey) keyStore.getKey(AUTH_KEY_ALIAS, null);
            }
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(AUTH_KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build());
            return generator.generateKey();
        }

        @JavascriptInterface
        public String secureMode() { return "sync"; }

        @JavascriptInterface
        public synchronized String secureGet() {
            String stored = getSharedPreferences(AUTH_PREFERENCES, MODE_PRIVATE).getString(AUTH_VALUE, "");
            if (stored.isEmpty()) return "";
            try {
                byte[] combined = Base64.decode(stored, Base64.NO_WRAP);
                if (combined.length <= 12) return null;
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, authKey(), new GCMParameterSpec(128, combined, 0, 12));
                byte[] plain = cipher.doFinal(combined, 12, combined.length - 12);
                return new String(plain, "UTF-8");
            } catch (Exception e) {
                return null;
            }
        }

        @JavascriptInterface
        public synchronized boolean secureSet(String value) {
            if (value == null) return false;
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, authKey());
                byte[] iv = cipher.getIV();
                byte[] encrypted = cipher.doFinal(value.getBytes("UTF-8"));
                byte[] combined = new byte[iv.length + encrypted.length];
                System.arraycopy(iv, 0, combined, 0, iv.length);
                System.arraycopy(encrypted, 0, combined, iv.length, encrypted.length);
                return getSharedPreferences(AUTH_PREFERENCES, MODE_PRIVATE).edit()
                        .putString(AUTH_VALUE, Base64.encodeToString(combined, Base64.NO_WRAP)).commit();
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void http(final String id, final String method, final String url,
                         final String headers, final String body) {
            pool.execute(new Runnable() {
                @Override public void run() {
                    HttpURLConnection c = null;
                    try {
                        c = openConn(method, url, headers, body);
                        active.put(id, c);
                        String text = readBody(c);
                        int status = c.getResponseCode();
                        String h = headersJson(c);
                        callJs("window.__nativeHttp(" + jsStr(id) + "," + status + ","
                                + jsStr(b64(text)) + "," + jsStr(h) + ")");
                    } catch (Exception e) {
                        String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                        callJs("window.__nativeHttp(" + jsStr(id) + ",0," + jsStr(b64("")) + ","
                                + jsStr("{\"error\":" + JSONObject.quote(msg) + "}") + ")");
                    } finally {
                        active.remove(id);
                        if (c != null) c.disconnect();
                    }
                }
            });
        }

        @JavascriptInterface
        public void stream(final String id, final String method, final String url,
                           final String headers, final String body) {
            FutureTask<Void> task = new FutureTask<Void>(new Runnable() {
                @Override public void run() {
                    HttpURLConnection c = null;
                    try {
                        if (Thread.currentThread().isInterrupted()) return;
                        c = openConn(method, url, headers, body);
                        active.put(id, c);
                        if (Thread.currentThread().isInterrupted()) return;
                        c.setReadTimeout(300000);
                        int status = c.getResponseCode();
                        if (status >= 400) {
                            String err = readAll(c.getErrorStream());
                            callJs("window.__nativeEnd(" + jsStr(id) + "," + jsStr(err) + ","
                                    + status + ")");
                            return;
                        }
                        String enc = c.getContentEncoding();
                        InputStream raw = c.getInputStream();
                        if (enc != null && enc.toLowerCase().contains("gzip")) {
                            raw = new GZIPInputStream(new BufferedInputStream(raw));
                        }
                        BufferedReader br = new BufferedReader(new InputStreamReader(raw, "UTF-8"), 8192);
                        String line;
                        while ((line = br.readLine()) != null) {
                            if (!active.containsKey(id)) break;
                            callJs("window.__nativeChunk(" + jsStr(id) + "," + jsStr(b64(line)) + ")");
                        }
                        callJs("window.__nativeEnd(" + jsStr(id) + ",null," + status + ")");
                    } catch (Exception e) {
                        String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                        callJs("window.__nativeEnd(" + jsStr(id) + "," + jsStr(msg) + ",0)");
                    } finally {
                        active.remove(id);
                        if (c != null) c.disconnect();
                    }
                }
            }, null) {
                @Override protected void done() { streamJobs.remove(id); }
            };
            streamJobs.put(id, task);
            streamPool.execute(task);
        }

        @JavascriptInterface
        public void abort(final String id) {
            FutureTask<Void> task = streamJobs.remove(id);
            if (task != null) task.cancel(true);
            HttpURLConnection c = active.remove(id);
            if (c != null) {
                try { c.disconnect(); } catch (Exception ignored) {}
            }
        }

        @JavascriptInterface
        public void toast(final String msg) {
            ui.post(new Runnable() {
                @Override public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void copy(final String text) {
            ui.post(new Runnable() {
                @Override public void run() {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Pp API", text));
                }
            });
        }

        @JavascriptInterface
        public void open(final String url) {
            ui.post(new Runnable() {
                @Override public void run() {
                    try {
                        Uri uri = Uri.parse(url);
                        String scheme = uri.getScheme();
                        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)
                                && !"mailto".equalsIgnoreCase(scheme)) return;
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "无法打开链接", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void vibrate(final int ms) {
            try {
                android.os.Vibrator v = (android.os.Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null) v.vibrate(ms);
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public String device() {
            JSONObject o = new JSONObject();
            try {
                o.put("model", Build.MODEL);
                o.put("brand", Build.BRAND);
                o.put("release", Build.VERSION.RELEASE);
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("app", UpdateClient.currentVersion(MainActivity.this));
                o.put("platform", "android");
            } catch (Exception ignored) {}
            return o.toString();
        }

        @JavascriptInterface
        public void updateCheck(final boolean notifyIfCurrent) { checkUpdate(notifyIfCurrent); }

        @JavascriptInterface
        public void updateDownload() { downloadUpdate(); }

        @JavascriptInterface
        public void updateInstall() { ui.post(new Runnable() { @Override public void run() { installUpdate(); } }); }

        @JavascriptInterface
        public void updateResume() {
            if (UpdateService.running()) { updateCallback("downloading", progressSnapshot()); return; }
            try {
                JSONObject release = savedRelease(UpdateClient.DOWNLOAD_RELEASE_KEY);
                if (UpdateClient.compareVersions(release.getString("version"), UpdateClient.currentVersion(MainActivity.this)) <= 0) {
                    UpdateClient.prefs(MainActivity.this).edit().remove(UpdateClient.DOWNLOAD_RELEASE_KEY)
                            .remove(UpdateClient.READY_VERSION_KEY).apply();
                    return;
                }
                File file = updateFile(MainActivity.this);
                if (file != null && file.isFile() && release.getString("version").equals(
                        UpdateClient.prefs(MainActivity.this).getString(UpdateClient.READY_VERSION_KEY, ""))) {
                    pool.execute(new Runnable() {
                        @Override public void run() {
                            try {
                                UpdateClient.verifyApk(MainActivity.this, file, release);
                                updateCallback("ready", release);
                            } catch (Exception e) { updateError(e.getMessage() == null ? "安装包校验失败" : e.getMessage()); }
                        }
                    });
                    return;
                }
                File part = file == null ? null : UpdateDownloader.partFile(file);
                if (part != null && part.isFile() && part.length() > 0) {
                    updateCallback("downloading", progressSnapshot());
                }
            } catch (Exception e) { updateError("更新下载记录无效，请重新检查更新"); }
        }

        @JavascriptInterface
        public String updateProgress() { return progressSnapshot().toString(); }

        @JavascriptInterface
        public void updateCancel() { UpdateService.requestCancel(); }

        @JavascriptInterface
        public String updateNotificationState() {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return "disabled";
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager == null) return "disabled";
            if (Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled()) return "disabled";
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel channel = manager.getNotificationChannel("ppapi_updates");
                if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return "disabled";
            }
            return "enabled";
        }

        @JavascriptInterface
        public void updateEnableNotifications() {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
                    !UpdateClient.prefs(MainActivity.this).getBoolean("notification_asked", false)) {
                UpdateClient.prefs(MainActivity.this).edit().putBoolean("notification_asked", true).apply();
                ui.post(new Runnable() { @Override public void run() { requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION); } });
            } else {
                ui.post(new Runnable() { @Override public void run() {
                    Intent settings = Build.VERSION.SDK_INT >= 26
                            ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
                            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
                    try { startActivity(settings); } catch (Exception ignored) {}
                } });
            }
        }

        @JavascriptInterface
        public void statusBar(final String color, final boolean darkIcons) {
            ui.post(new Runnable() {
                @Override public void run() {
                    try {
                        Window w = getWindow();
                        final int target = Color.parseColor(color);
                        ValueAnimator animator = ValueAnimator.ofObject(new ArgbEvaluator(), w.getStatusBarColor(), target);
                        animator.setDuration(280);
                        animator.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
                            @Override public void onAnimationUpdate(ValueAnimator valueAnimator) {
                                int tint = (Integer) valueAnimator.getAnimatedValue();
                                getWindow().setStatusBarColor(tint);
                                getWindow().setNavigationBarColor(tint);
                            }
                        });
                        animator.start();
                        View dv = w.getDecorView();
                        int flags = dv.getSystemUiVisibility();
                          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                              flags |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                                      View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
                          }
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            if (darkIcons) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                            else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                          }
                          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                              if (darkIcons) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                              else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                          }
                          dv.setSystemUiVisibility(flags);
                    } catch (Exception ignored) {}
                }
            });
        }

        @JavascriptInterface
        public void keepAwake(final boolean on) {
            ui.post(new Runnable() {
                @Override public void run() {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }
    }
}
