/* Transport + Pp API client.
   Mobile shells use a native HTTPS bridge; plain browsers use fetch(). */
(function (global) {
  'use strict';

  var ORIGIN = 'https://ipkey.vip';
  var API = ORIGIN + '/api/v1';
  var V1 = 'https://api.ipkey.vip/v1';

  function browserUrl(url) {
    if (global.location.hostname !== '127.0.0.1') return url;
    if (url.indexOf(API + '/') === 0) return '/__proxy/site' + url.slice(ORIGIN.length);
    if (url.indexOf(V1 + '/') === 0) return '/__proxy/model' + url.slice('https://api.ipkey.vip'.length);
    return url;
  }

  // ---------- base64 helpers ----------
  function dec(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var out = '';
    for (var j = 0; j < bytes.length; j++) out += String.fromCharCode(bytes[j]);
    return decodeURIComponent(escape(out));
  }

  // ---------- transport ----------
  var seq = 0;
  var pending = {};
  var streams = {};

  function nativeHttp(method, url, headers, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = 'r' + (++seq);
      var timer = setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          try { global.Native.abort(id); } catch (e) {}
          reject(mkErr(0, 'TIMEOUT', '请求超时，请检查网络'));
        }
      }, timeoutMs || 45000);
      pending[id] = function (status, text, hdrs) {
        clearTimeout(timer);
        delete pending[id];
        if (status === 0) {
          var msg = '网络连接失败';
          try { var h = JSON.parse(hdrs || '{}'); if (h.error) msg = h.error; } catch (e) {}
          reject(mkErr(0, 'NETWORK', msg));
          return;
        }
        resolve({ status: status, text: text, headers: hdrs });
      };
      try {
        global.Native.http(id, method, url, JSON.stringify(headers || {}), body || null);
      } catch (e) {
        clearTimeout(timer);
        delete pending[id];
        reject(mkErr(0, 'BRIDGE', String(e)));
      }
    });
  }

  function fetchHttp(method, url, headers, body) {
    var target = browserUrl(url);
    var requestHeaders = Object.assign({}, headers || {});
    if (target !== url) requestHeaders['X-Pp-Preview'] = '1';
    var opt = { method: method, headers: requestHeaders };
    if (body) opt.body = body;
    return fetch(target, opt).then(function (r) {
      return r.text().then(function (t) {
        return { status: r.status, text: t, headers: '{}' };
      });
    });
  }

  function request(method, url, headers, body, timeoutMs) {
    if (global.Native && global.Native.http) return nativeHttp(method, url, headers, body, timeoutMs);
    return fetchHttp(method, url, headers, body);
  }

  var MSG_MAP = [
    ['invalid email or password', '邮箱或密码错误'],
    ['invalid credentials', '邮箱或密码错误'],
    ['email not verified', '邮箱尚未验证，请先完成邮箱验证'],
    ['email already', '该邮箱已注册'],
    ['user not found', '账号不存在'],
    ['account is disabled', '账号已被禁用'],
    ['account has been banned', '账号已被封禁'],
    ['invalid verification code', '验证码不正确'],
    ['verification code expired', '验证码已过期'],
    ['invalid or expired', '验证码无效或已过期'],
    ['too many requests', '请求过于频繁，请稍后再试'],
    ['rate limit', '请求过于频繁，请稍后再试'],
    ['insufficient balance', '余额不足，请先充值'],
    ['insufficient quota', '额度不足'],
    ['quota exceeded', '额度已用尽'],
    ['invalid token', '令牌无效或已停用'],
    ['token is disabled', '令牌已停用'],
    ['token expired', '令牌已过期'],
    ['not found', '资源不存在'],
    ['internal server error', '服务异常，请稍后再试']
  ];
  function localize(msg) {
    var raw = String(msg || '').trim();
    var low = raw.toLowerCase();
    for (var i = 0; i < MSG_MAP.length; i++) {
      if (low.indexOf(MSG_MAP[i][0]) >= 0) return MSG_MAP[i][1];
    }
    return raw;
  }

  function mkErr(status, code, message) {
    var e = new Error(message || '请求失败');
    e.status = status;
    e.code = code;
    e.message = message || '请求失败';
    return e;
  }

  // ---------- auth state ----------
  var secureMode = '';
  var secureValues = {};
  var secureSequence = 0;
  var persistQueue = Promise.resolve();
  var vault = { version: 1, activeId: '', accounts: [] };
  var authGeneration = 0;
  var lastPersistOk = null;
  try {
    if (global.Native && global.Native.secureMode) secureMode = global.Native.secureMode();
  } catch (e) { secureMode = 'unavailable'; }

  global.__nativeSecure = function (id, ok) {
    var pendingSecure = secureValues[id];
    if (!pendingSecure) return;
    delete secureValues[id];
    clearTimeout(pendingSecure.timer);
    pendingSecure.resolve(!!ok);
  };

  function parseVault(raw) {
    try {
      var value = JSON.parse(raw);
      if (value && value.version === 1 && Array.isArray(value.accounts)) {
        value.accounts = value.accounts.filter(function (a) { return a && typeof a.id === 'string' && typeof a.email === 'string'; });
        if (!value.accounts.some(function (a) { return a.id === value.activeId; })) value.activeId = '';
        return value;
      }
    } catch (e) {}
    return null;
  }

  function loadVault() {
    if (secureMode === 'sync' || secureMode === 'async') {
      try {
        var raw = global.Native.secureGet();
        if (raw === null || raw === undefined) { secureMode = 'unavailable'; return; }
        if (raw) {
          var parsed = parseVault(String(raw));
          if (!parsed) { secureMode = 'unavailable'; return; }
          vault = parsed;
        }
      } catch (e) { secureMode = 'unavailable'; }
    }
  }
  loadVault();

  function secureWrite(snapshot) {
    if (secureMode === 'sync') {
      try { return Promise.resolve(global.Native.secureSet(snapshot) === true); }
      catch (e) { return Promise.resolve(false); }
    }
    if (secureMode === 'async') {
      return new Promise(function (resolve) {
        var id = 'secure' + (++secureSequence);
        var timer = setTimeout(function () { delete secureValues[id]; resolve(false); }, 5000);
        secureValues[id] = { resolve: resolve, timer: timer };
        try { global.Native.secureSet(id, snapshot); }
        catch (e) { clearTimeout(timer); delete secureValues[id]; resolve(false); }
      });
    }
    return Promise.resolve(false);
  }

  function persistVault() {
    var snapshot = JSON.stringify(vault);
    persistQueue = persistQueue.catch(function () {}).then(function () { return secureWrite(snapshot); })
      .then(function (ok) { lastPersistOk = ok; return ok; });
    return persistQueue;
  }

  function account(id) {
    return vault.accounts.filter(function (item) { return item.id === id; })[0] || null;
  }
  function activeAccount() { return account(vault.activeId); }
  function accountId(email, user) {
    if (email) return 'email:' + String(email).trim().toLowerCase();
    if (user && user.id != null) return 'user:' + String(user.id);
    return '';
  }
  function authChanged(reason) {
    authGeneration++;
    if (typeof global.CustomEvent === 'function') {
      global.dispatchEvent(new CustomEvent('pp:auth-changed', { detail: { reason: reason } }));
    }
  }
  function expiredError() { return mkErr(401, 'UNAUTHORIZED', '登录已过期，请重新登录'); }
  function switchedError() { return mkErr(0, 'ACCOUNT_CHANGED', '账号已切换'); }
  function authContext() { return { id: vault.activeId, generation: authGeneration }; }
  function contextMatches(context) { return context.id === vault.activeId && context.generation === authGeneration; }

  function sanitizeUser(user) {
    if (!user || typeof user !== 'object') return null;
    try {
      return JSON.parse(JSON.stringify(user, function (key, value) {
        return /password|passwd|^pwd$/i.test(key) ? undefined : value;
      }));
    } catch (e) { return null; }
  }

  function applySession(item, data) {
    if (!data) return;
    if (data.access_token) item.token = String(data.access_token);
    if (data.refresh_token) item.refresh = String(data.refresh_token);
    if (data.expires_in != null) {
      var ttl = Number(data.expires_in);
      item.expiresAt = ttl > 0 ? Date.now() + ttl * 1000 : 0;
    }
    if (data.user) item.user = sanitizeUser(data.user);
    item.expired = false;
  }

  var AUTH = {
    token: function () { var a = activeAccount(); return a && a.token || ''; },
    refresh: function () { var a = activeAccount(); return a && a.refresh || ''; },
    user: function () { var a = activeAccount(); return a && a.user || null; },
    currentId: function () { return vault.activeId; },
    context: authContext,
    matches: contextMatches,
    accounts: function () {
      return vault.accounts.map(function (a) { return { id: a.id, email: a.email, active: a.id === vault.activeId, expired: !!a.expired || !a.token }; });
    },
    secureAvailable: function () { return secureMode === 'sync' || secureMode === 'async'; },
    storageWarning: function () {
      if (!AUTH.secureAvailable()) return '设备安全存储不可用，关闭应用后账号无法保留。';
      if (lastPersistOk === false) return '设备安全存储写入失败，账号更改可能不会在重启后保留。';
      return '';
    },
    isLogged: function () { return !!AUTH.token(); },
    commit: function (data, email) {
      var user = data && data.user || null;
      var address = String(email || user && user.email || '').trim();
      var id = accountId(address, user);
      if (!id || !data || !data.access_token) throw mkErr(0, 'BAD_SESSION', '登录结果缺少账号或会话信息');
      var existing = account(id);
      if (!existing) {
        existing = { id: id, email: address, token: '', refresh: '', user: null, expired: false };
        vault.accounts.push(existing);
      }
      existing.email = address || existing.email;
      existing.token = '';
      existing.refresh = '';
      existing.expiresAt = 0;
      applySession(existing, data);
      vault.activeId = id;
      authChanged('commit');
      return persistVault();
    },
    setUser: function (u, context) {
      if (!u || context && !contextMatches(context)) return Promise.resolve(false);
      var current = activeAccount();
      if (!current) return Promise.resolve(false);
      current.user = sanitizeUser(u);
      return persistVault();
    },
    expire: function (id, reason) {
      var item = account(id);
      if (!item) return Promise.resolve(false);
      item.token = '';
      item.refresh = '';
      item.expiresAt = 0;
      item.user = null;
      item.expired = true;
      if (vault.activeId === id) { vault.activeId = ''; authChanged(reason || 'expired'); }
      return persistVault();
    },
    switchTo: function (id) {
      var item = account(id);
      if (!item || !item.token) return Promise.reject(mkErr(0, 'ACCOUNT_UNAVAILABLE', '该账号需要重新登录'));
      if (vault.activeId === id) return Promise.resolve(lastPersistOk !== false && AUTH.secureAvailable());
      vault.activeId = id;
      authChanged('switch');
      return persistVault();
    },
    remove: function (id) {
      var wasActive = vault.activeId === id;
      vault.accounts = vault.accounts.filter(function (item) { return item.id !== id; });
      if (wasActive) { vault.activeId = ''; authChanged('remove'); }
      return persistVault();
    },
    clear: function () { return AUTH.expire(vault.activeId); }
  };

  var legacyToken = U.store.get('token', '');
  var legacyUser = U.store.get('user', null);
  var legacyEmail = legacyUser && legacyUser.email;
  if (legacyToken && legacyEmail && !U.store.get('chat_legacy_owner', '')) {
    U.store.set('chat_legacy_owner', accountId(legacyEmail, legacyUser));
  }
  if (legacyToken && legacyEmail && !vault.accounts.length) {
    var legacyId = accountId(legacyEmail, legacyUser);
    vault.accounts.push({ id: legacyId, email: legacyEmail, token: legacyToken, refresh: U.store.get('refresh', ''),
      user: sanitizeUser(legacyUser), expiresAt: U.store.get('expires_at', 0), expired: false });
    vault.activeId = legacyId;
    authChanged('migration');
    persistVault();
  }
  ['token', 'refresh', 'user', 'expires_at'].forEach(function (key) { U.store.del(key); });

  var refreshing = {};
  function refreshToken(context) {
    if (!contextMatches(context)) return Promise.reject(switchedError());
    var key = context.id + ':' + context.generation;
    if (refreshing[key]) return refreshing[key];
    var item = account(context.id);
    var rt = item && item.refresh;
    if (!rt) return Promise.reject(expiredError());
    refreshing[key] = request('POST', API + '/auth/refresh', {
      'Content-Type': 'application/json', 'Accept': 'application/json',
      'Accept-Language': 'zh', 'X-User-UI-Request': '1'
    }, JSON.stringify({ refresh_token: rt })).then(function (res) {
      if (!contextMatches(context)) throw switchedError();
      if (res.status === 0) throw mkErr(0, 'NETWORK', '网络连接失败');
      if (res.status === 429 || res.status >= 500) throw mkErr(res.status, 'SERVER', '服务暂不可用，请稍后再试');
      var j = parse(res);
      if (res.status === 400 || res.status === 401 || res.status === 403) throw expiredError();
      if (!j) throw mkErr(res.status, 'BAD_JSON', '刷新登录状态失败，请稍后再试');
      if ((j.code !== 0 && j.code !== 'SUCCESS' && j.code !== 200) &&
          /token|unauthorized|expired/i.test(String(j.code) + ' ' + String(j.message || j.error || ''))) throw expiredError();
      var refreshed = handle(res, j);
      if (!refreshed || !refreshed.access_token) throw mkErr(res.status, 'BAD_SESSION', '刷新登录状态失败，请稍后再试');
      applySession(item, refreshed);
      return persistVault().then(function () { return refreshed; });
    }).then(function (d) { delete refreshing[key]; return d; }, function (e) { delete refreshing[key]; throw e; });
    return refreshing[key];
  }

  function parse(res) {
    try { return JSON.parse(res.text); } catch (e) { return null; }
  }

  // ---------- JSON API ----------
  function api(path, opts) {
    opts = opts || {};
    var context = authContext();
    var tracked = opts.trackAuth !== false && opts.auth !== false;
    var method = opts.method || 'GET';
    var url = API + path;
    if (opts.query) {
      var qs = [];
      Object.keys(opts.query).forEach(function (k) {
        var v = opts.query[k];
        if (v === undefined || v === null || v === '') return;
        qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      });
      if (qs.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');
    }
    var headers = { 'Accept': 'application/json', 'Accept-Language': 'zh' };
    if (path.indexOf('/admin/') !== 0 && path !== '/admin') {
      headers['X-User-UI-Request'] = '1';
    }
    var body = null;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    if (opts.auth !== false) {
      var t = AUTH.token();
      if (t) headers['Authorization'] = 'Bearer ' + t;
    }
    if (opts.headers) Object.assign(headers, opts.headers);

    function attempt(isRetry) {
      return request(method, url, headers, body).then(function (res) {
        if (tracked && !contextMatches(context)) throw switchedError();
        var j = parse(res);
        if (res.status === 0) {
          var message = '网络连接失败';
          try { var errHeaders = JSON.parse(res.headers || '{}'); if (errHeaders.error) message = errHeaders.error; } catch (e) {}
          throw mkErr(0, 'NETWORK', message);
        }
        if (res.status === 401 && !isRetry && opts.auth !== false && context.id) {
          if (!AUTH.refresh()) return AUTH.expire(context.id).then(function () { throw expiredError(); });
          return refreshToken(context).then(function () {
            if (!contextMatches(context)) throw switchedError();
            var h2 = Object.assign({}, headers, { 'Authorization': 'Bearer ' + AUTH.token() });
            return request(method, url, h2, body).then(function (r2) {
              if (!contextMatches(context)) throw switchedError();
              if (r2.status === 401) return AUTH.expire(context.id).then(function () { throw expiredError(); });
              if (r2.status === 0) throw mkErr(0, 'NETWORK', '网络连接失败');
              return handle(r2, parse(r2));
            });
          }, function (error) {
            if (!contextMatches(context)) throw switchedError();
            if (error.code !== 'UNAUTHORIZED') throw error;
            return AUTH.expire(context.id).then(function () { throw error; });
          });
        }
        return handle(res, j);
      });
    }
    return attempt(false);
  }

  function handle(res, j) {
    if (!j) {
      if (res.status >= 400) throw mkErr(res.status, 'HTTP_' + res.status, '服务暂不可用 (' + res.status + ')');
      return {};
    }
    if (j.code === 0 || j.code === 'SUCCESS' || j.code === 200) return j.data;
    var msg = j.message || j.error || j.msg || (typeof j.code === 'string' ? j.code : '请求失败');
    throw mkErr(res.status >= 400 ? res.status : 400, j.code, localize(msg));
  }

  // ---------- public ----------
  var cache = {};
  var cacheGeneration = 0;
  function cached(key, ttl, loader) {
    var hit = cache[key];
    var now = Date.now();
    if (hit && now - hit.at < ttl) return Promise.resolve(hit.value);
    var generation = cacheGeneration;
    return loader().then(function (v) {
      if (generation === cacheGeneration) cache[key] = { at: now, value: v };
      return v;
    });
  }
  function clearCache() { cache = {}; cacheGeneration++; }

  var Api = {
    ORIGIN: ORIGIN, API: API, V1: V1, AUTH: AUTH, base: api, clearCache: clearCache,
    settings: function () { return cached('settings', 5 * 60e3, function () { return api('/settings/public', { auth: false }); }); },
    plaza: function () { return cached('plaza', 10 * 60e3, function () { return api('/model-plaza'); }); },
    announcements: function () {
      if (!AUTH.isLogged()) return Promise.resolve([]);
      return api('/announcements');
    },
    locale: function () { return api('/locale/default', { auth: false }).catch(function () { return { locale: 'zh' }; }); },

    login: function (email, password, extra) {
      var body = Object.assign({ email: email, password: password }, extra || {});
      var context = authContext();
      return api('/auth/login', { method: 'POST', body: body, auth: false, trackAuth: false }).then(function (d) {
        if (!contextMatches(context)) throw switchedError();
        return AUTH.commit(d, email).then(function (saved) { return { data: d, saved: saved }; });
      }).then(function (result) {
        clearCache();
        return result;
      });
    },
    login2fa: function (payload) {
      var context = authContext();
      return api('/auth/login/2fa', { method: 'POST', body: payload, auth: false, trackAuth: false }).then(function (d) {
        if (!contextMatches(context)) throw switchedError();
        return AUTH.commit(d, payload.email).then(function (saved) { clearCache(); return { data: d, saved: saved }; });
      });
    },
    register: function (payload) {
      var context = authContext();
      return api('/auth/register', { method: 'POST', body: payload, auth: false, trackAuth: false }).then(function (d) {
        if (!contextMatches(context)) throw switchedError();
        return AUTH.commit(d, payload.email).then(function (saved) { clearCache(); return { data: d, saved: saved }; });
      });
    },
    sendCode: function (payload) {
      return api('/auth/send-verify-code', { method: 'POST', body: payload, auth: false });
    },
    forgot: function (payload) {
      return api('/auth/forgot-password', { method: 'POST', body: payload, auth: false });
    },
    reset: function (payload) {
      return api('/auth/reset-password', { method: 'POST', body: payload, auth: false });
    },
    me: function () {
      var context = authContext();
      return api('/auth/me').then(function (d) {
        if (!contextMatches(context)) throw switchedError();
        var u = d && d.user ? d.user : d;
        return AUTH.setUser(u, context).then(function () { return u; });
      });
    },
    logout: function () {
      var context = authContext();
      api('/auth/logout', { method: 'POST' }).catch(function () {});
      return AUTH.expire(context.id, 'logout').then(function (saved) { return { saved: saved }; });
    },

    keys: function (page, size, filters) {
      return api('/keys', { query: Object.assign({ page: page || 1, page_size: size || 50 }, filters || {}) });
    },
    keyCreate: function (payload) { return api('/keys', { method: 'POST', body: payload }); },
    keyUpdate: function (id, payload) { return api('/keys/' + id, { method: 'PUT', body: payload }); },
    keyDelete: function (id) { return api('/keys/' + id, { method: 'DELETE' }); },
    groups: function () { return api('/groups/available'); },

    usageStats: function (query) { return api('/usage/stats', { query: query }); },
    usageDashboard: function () { return api('/usage/dashboard/stats'); },
    usageTrend: function (query) { return api('/usage/dashboard/trend', { query: query }); },
    usageModels: function (query) { return api('/usage/dashboard/models', { query: query }); },
    platformQuotas: function () { return api('/user/platform-quotas'); },
    usageLogs: function (query) { return api('/usage', { query: query }); },
    usageErrors: function (query) { return api('/usage/errors', { query: query }); },

    profileUpdate: function (payload) { return api('/user', { method: 'PUT', body: payload }); },
    changePassword: function (oldP, newP) {
      return api('/user/password', { method: 'PUT', body: { old_password: oldP, new_password: newP } });
    },
    aff: function () { return api('/user/aff'); },
    affTransfer: function () { return api('/user/aff/transfer', { method: 'POST' }); },

    redeemHistory: function () { return api('/redeem/history'); },
    redeem: function (code) { return api('/redeem', { method: 'POST', body: { code: code } }); },

    paymentConfig: function () { return api('/payment/config'); },
    paymentPlans: function () { return api('/payment/plans'); },
    paymentInfo: function () { return api('/payment/checkout-info'); },
    paymentLimits: function () { return api('/payment/limits'); },
    createOrder: function (payload) { return api('/payment/orders', { method: 'POST', body: payload }); },
    myOrders: function (query) { return api('/payment/orders', { query: query }); },
    verifyOrder: function (outTradeNo) { return api('/payment/orders/verify', { method: 'POST', body: { out_trade_no: outTradeNo } }); },

    subscriptions: function () { return api('/subscriptions/active'); },
    // ---- raw OpenAI-compatible calls (used by chat fallbacks & images) ----
    v1Post: function (path, key, payload, timeoutMs) {
      return request('POST', V1 + path, {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'zh',
        'X-User-UI-Request': '1',
        'Authorization': 'Bearer ' + key
      }, JSON.stringify(payload), timeoutMs || 120000).then(function (res) {
        var j = parse(res);
        if (res.status >= 400) throw mkErr(res.status, 'HTTP_' + res.status, readError(j, res.text));
        if (!j) throw mkErr(res.status, 'BAD_JSON', '接口返回无法解析：' + String(res.text || '').slice(0, 200));
        if (j.error && !j.choices && !j.data) throw mkErr(res.status, 'API_ERROR', readError(j, res.text));
        return j;
      });
    },
    chatOnce: function (key, payload) {
      var body = Object.assign({}, payload);
      body.stream = false;
      return Api.v1Post('/chat/completions', key, body, 150000);
    },
    generateImage: function (key, payload) {
      return Api.v1Post('/images/generations', key, payload, 180000);
    },
    modelsWithKey: function (key) {
      return request('GET', V1 + '/models', {
        'Authorization': 'Bearer ' + key, 'Accept': 'application/json',
        'Accept-Language': 'zh', 'X-User-UI-Request': '1'
      }, null)
        .then(function (res) {
          var j = parse(res);
          if (!j || res.status >= 400) throw mkErr(res.status, 'MODELS', (j && j.error && j.error.message) || '无法获取模型列表');
          return j.data || j;
        });
    }
  };

  // ---------- streaming (chat completions) ----------
  // Native bridge pushes base64 lines. Falls back to fetch streaming in browsers.
  function chatStream(payload, key, handlers) {
    var id = 's' + (++seq);
    var headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Accept-Language': 'zh',
      'X-User-UI-Request': '1',
      'Authorization': 'Bearer ' + key
    };
    var parser = makeSseParser(handlers);
    streams[id] = parser;

    if (!(global.Native && global.Native.stream)) {
      // browser fallback
      var ctrl = new AbortController();
      var streamUrl = browserUrl(V1 + '/chat/completions');
      if (streamUrl !== V1 + '/chat/completions') headers['X-Pp-Preview'] = '1';
      fetch(streamUrl, {
        method: 'POST', headers: headers, body: JSON.stringify(payload), signal: ctrl.signal
      }).then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            parser.error(t || ('HTTP ' + r.status), r.status);
          });
        }
        if (!r.body) throw new Error('接口未返回流式内容');
        var reader = r.body.getReader();
        var dec2 = new TextDecoder();
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) { parser.push(dec2.decode()); parser.end(); return; }
            var chunk = dec2.decode(res.value, { stream: true });
            parser.push(chunk);
            return pump();
          });
        }
        return pump();
      }).catch(function (e) { if (e.name !== 'AbortError') parser.error(e.message); })
        .then(function () { delete streams[id]; });
      return { abort: function () { ctrl.abort(); delete streams[id]; } };
    }

    global.Native.stream(id, 'POST', V1 + '/chat/completions', JSON.stringify(headers), JSON.stringify(payload));
    return {
      abort: function () {
        try { global.Native.abort(id); } catch (e) {}
        delete streams[id];
      }
    };
  }

  function makeSseParser(h) {
    var buffer = '', finished = false;
    function line(text) {
      if (finished || text.indexOf('data:') !== 0) return;
      var data = text.slice(5).trim();
      if (data === '[DONE]') { end(); return; }
      try { var value = JSON.parse(data); } catch (e) { return; }
      if (h.onEvent) h.onEvent(value);
    }
    function end() {
      if (finished) return;
      finished = true;
      if (h.onDone) h.onDone();
    }
    return {
      push: function (chunk) {
        if (finished) return;
        buffer += chunk;
        var lines = buffer.split(/\n/);
        buffer = lines.pop();
        lines.forEach(function (part) { line(part.replace(/\r$/, '')); });
      },
      end: function () { if (buffer) line(buffer.replace(/\r$/, '')); end(); },
      error: function (msg, status) {
        if (finished) return;
        finished = true;
        if (h.onError) h.onError(msg, status);
      }
    };
  }

  global.__nativeHttp = function (id, status, b64, headers) {
    var cb = pending[id];
    if (!cb) return;
    var text = '';
    try { text = b64 ? dec(b64) : ''; } catch (e) {}
    cb(status, text, headers);
  };

  global.__nativeChunk = function (id, b64) {
    var s = streams[id];
    if (!s) return;
    var line;
    try { line = dec(b64); } catch (e) { return; }
    s.push(line + '\n');
  };

  global.__nativeEnd = function (id, err, status) {
    var s = streams[id];
    if (!s) return;
    delete streams[id];
    if (err) {
      var msg = err;
      try {
        var j = JSON.parse(err);
        if (j && (j.message || j.error)) msg = (j.error && j.error.message) || j.message;
      } catch (e) {}
      s.error(typeof msg === 'string' ? localize(msg) : '请求失败', status);
    } else {
      s.end();
    }
  };

  Api.chatStream = chatStream;
  function readError(j, raw) {
    var msg = '';
    if (j) {
      if (j.error) msg = typeof j.error === 'string' ? j.error : (j.error.message || j.error.msg || j.error.code || '');
      else msg = j.message || j.msg || '';
    }
    if (!msg) msg = String(raw || '').trim().slice(0, 300);
    return localize(msg) || ('请求失败 (' + (raw || '').slice(0, 80) + ')');
  }

  global.Api = Api;
  global.Api.dec = dec;
})(window);
