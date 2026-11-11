/* Shell: state, router, app bar, tabs, theme, boot. */
(function (global) {
  'use strict';
  var U = global.U;
  var C = global.PagesCore;

  var S = global.S = {
    user: Api.AUTH.user(),
    settings: null,
    plaza: null,
    plazaLoading: true,
    keys: [],
    plazaGroup: 0,
    usageRange: 'today',
    chatModel: '',
    theme: U.store.get('theme', 'auto')
  };

  var view, appbar, titleEl, subEl, actionsEl, tabbar;
  var currentPath = '';
  var publicGeneration = 0;

  var ROUTES = {
    '/home': { title: 'Pp API', tab: 'home', render: function () { return C.renderHome(); } },
    '/dashboard': { title: '仪表盘', tab: 'home', render: function () { return global.PagesDashboard.renderDashboard(); } },
    '/plaza': { title: '模型广场', tab: 'plaza', render: function () { return C.renderPlaza(); } },
    '/channel-status': { title: '渠道状态', tab: 'plaza', render: function () { return global.PagesChannel.render(); } },
    '/chat': { title: '对话', tab: 'chat', render: function () { return global.PagesChat.renderChat(); }, full: true },
    '/keys': { title: '我的令牌', tab: 'keys', render: function () { return global.PagesUser.renderKeys(); } },
    '/usage': { title: '用量明细', tab: 'me', render: function () { return global.PagesUser.renderUsage(); } },
    '/me': { title: '我的', tab: 'me', render: function () { return global.PagesUser.renderMe(); } },
    '/accounts': { title: '账号管理', tab: 'me', render: function () { return global.PagesUser.renderAccounts(); } },
    '/redeem': { title: '兑换码', tab: 'me', render: function () { return global.PagesUser.renderRedeem(); } },
    '/purchase': { title: '充值中心', tab: 'me', render: function () { return global.PagesUser.renderPurchase(); } },
    '/affiliate': { title: '邀请返利', tab: 'me', render: function () { return global.PagesUser.renderAffiliate(); } },
    '/about': { title: '关于', tab: 'me', render: function () { return C.renderAbout(); } },
    '/updates': { title: '软件更新', tab: 'me', render: function () { return global.Updates.render(); } },
    '/announcements': { title: '平台公告', tab: 'home', render: function () { return C.renderAnnouncements(); } },
    '/login': { title: '登录', tab: '', render: function () { return global.PagesAuth.renderLogin(); }, hideTab: true },
    '/register': { title: '注册', tab: '', render: function () { return global.PagesAuth.renderRegister(); }, hideTab: true },
    '/forgot': { title: '找回密码', tab: '', render: function () { return global.PagesAuth.renderForgot(); }, hideTab: true }
  };

  var TABS = [
    { key: 'home', path: '#/home', label: '首页', icon: 'home' },
    { key: 'plaza', path: '#/plaza', label: '模型', icon: 'grid' },
    { key: 'chat', path: '#/chat', label: '对话', icon: 'chat' },
    { key: 'keys', path: '#/keys', label: '令牌', icon: 'key' },
    { key: 'me', path: '#/me', label: '我的', icon: 'user' }
  ];

  function buildShell() {
    var app = U.$('#app');
    app.innerHTML = '';
    var mark = '<img class="brand-mark" src="img/pp-logo.jpg" alt="">';
    titleEl = U.el('div', { class: 'appbar-title' });
    subEl = U.el('div', { class: 'small muted' });
    actionsEl = U.el('div', { class: 'appbar-actions' });
    var backBtn = U.el('button', { class: 'icon-btn', html: U.ic('back', 20), style: { marginLeft: '-6px' } });
    backBtn.addEventListener('click', function () { history.back(); });
    var leading = U.el('div', { class: 'row appbar-leading', style: { gap: '8px' } }, U.el('span', { html: mark }), titleEl);
    appbar = U.el('header', { class: 'appbar' },
      leading,
      actionsEl
    );
    view = U.el('main', { id: 'view' });
    var fade = U.el('div', { class: 'bottom-fade' });
    tabbar = U.el('nav', { class: 'tabbar' });
    TABS.forEach(function (t) {
      var b = U.el('button', { class: 'tab', 'data-tab': t.key, html: U.ic(t.icon, 22) + '<span>' + t.label + '</span>' });
      b.addEventListener('click', function () { App.go(t.path); });
      tabbar.appendChild(b);
    });
    app.appendChild(appbar);
    app.appendChild(view);
    app.appendChild(fade);
    app.appendChild(tabbar);

    var updateBtn = U.el('button', { class: 'icon-btn update-indicator', html: U.ic('refresh', 19), title: '查看软件更新', 'aria-label': '查看软件更新' });
    function updateIndicator() {
      var status = global.Updates && global.Updates.state.status;
      updateBtn.style.display = ['available', 'downloading', 'ready'].indexOf(status) >= 0 ? 'inline-flex' : 'none';
    }
    updateBtn.addEventListener('click', function () { App.go('#/updates'); });
    global.addEventListener('pp:updates-changed', updateIndicator);
    updateIndicator();
    var themeBtn = U.el('button', { class: 'icon-btn', html: U.ic('sparkle', 19), title: '切换主题' });
    themeBtn.addEventListener('click', toggleTheme);
    var refreshBtn = U.el('button', { class: 'icon-btn', html: U.ic('refresh', 19), title: '刷新' });
    refreshBtn.addEventListener('click', function () {
      Api.clearCache();
      U.toast('正在刷新…');
      boot(true);
    });
    actionsEl.appendChild(updateBtn);
    actionsEl.appendChild(themeBtn);
    actionsEl.appendChild(refreshBtn);

    requestAnimationFrame(syncSpace);
    window.addEventListener('resize', syncSpace);
    if (global.ResizeObserver) {
      try { new ResizeObserver(syncSpace).observe(tabbar); } catch (e) {}
    }

    view.addEventListener('scroll', function () {
      if (view.scrollTop > 4) appbar.classList.add('scrolled');
      else appbar.classList.remove('scrolled');
    });
  }

  // Distance from the bottom of the viewport to the top of the floating bar,
  // so the scroll area and the chat composer never hide underneath it.
  function syncSpace() {
    if (!tabbar || tabbar.style.display === 'none') return;
    var rect = tabbar.getBoundingClientRect();
    if (!rect.height) return;
    var space = Math.max(0, Math.round(global.innerHeight - rect.top));
    document.documentElement.style.setProperty('--tabbar-space', space + 'px');
    document.documentElement.style.setProperty('--tabbar-h', Math.round(rect.height) + 'px');
  }

  function applyTheme() {
    var mode = S.theme;
    var dark = mode === 'dark' || (mode === 'auto' && global.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (global.Native && global.Native.statusBar) {
      global.Native.statusBar(dark ? '#0e1113' : '#f5f6f8', !dark);
    }
  }

  function toggleTheme() {
    S.theme = (document.documentElement.getAttribute('data-theme') === 'dark') ? 'light' : 'dark';
    U.store.set('theme', S.theme);
    applyTheme();
    U.toast(S.theme === 'dark' ? '深色模式' : '浅色模式');
  }

  function parseHash() {
    var raw = (location.hash || '').replace(/^#/, '');
    if (!raw) return { path: '/home', param: '' };
    var parts = raw.split('/').filter(Boolean);
    if (parts[1] === undefined) return { path: '/' + parts[0], param: '' };
    return { path: '/' + parts[0], param: parts.slice(1).join('/') };
  }

  function renderRoute() {
    var r = parseHash();
    var def = ROUTES[r.path];
    if (!def) { def = ROUTES['/home']; r.path = '/home'; }

    if (currentPath === '/chat' && r.path !== '/chat') {
      document.body.classList.remove('chat-mode');
    }
    currentPath = r.path;

    titleEl.textContent = r.path === '/home' && S.user ? '仪表盘' : def.title;
    subEl.textContent = r.path === '/home' && !S.user ? 'AI API Gateway · 统一模型接入' : '';
    titleEl.appendChild(subEl);

    if (def.hideTab) tabbar.style.display = 'none';
    else tabbar.style.display = 'flex';
    if (def.full) document.body.classList.add('chat-mode');

    Array.prototype.forEach.call(tabbar.children, function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === def.tab);
    });

    view.innerHTML = '';
    try {
      var node = def.render(r.param);
      if (node) view.appendChild(node);
    } catch (e) {
      view.appendChild(U.el('div', { class: 'page' },
        U.el('div', { class: 'empty' }, U.el('p', null, '页面加载出错'), U.el('small', null, String(e && e.message || e)))));
    }
    view.scrollTop = 0;
    syncSpace();

    if (r.path === '/announcements' && r.param) {
      view.innerHTML = '';
      view.appendChild(C.renderAnnouncements(r.param));
    }
  }

  var App = global.App = {
    go: function (path, replace) {
      if (!path) path = '#/home';
      if (path.charAt(0) !== '#') path = '#' + path;
      if (replace) {
        location.replace(path);
        renderRoute();
      } else if (location.hash === path) {
        renderRoute();
      } else {
        location.hash = path;
      }
    },
    resetAccountState: function () {
      publicGeneration++;
      S.user = Api.AUTH.user();
      S.keys = [];
      S.groupNames = {};
      S.plaza = null;
      S.plazaLoading = true;
      S.plazaGroup = 0;
      S.chatModel = '';
      S.useSelectedChatModel = false;
      Api.clearCache();
      U.closeOverlay();
    },
    switchAccount: function (id) {
      var pending = Api.AUTH.switchTo(id);
      if (Api.AUTH.currentId() === id) {
        App.go('#/home', true);
        App.refreshPublic();
        App.refreshUser();
      }
      return pending;
    },
    refreshPublic: function () { return loadPublic(); },
    refreshUser: function () {
      if (!Api.AUTH.isLogged()) { S.user = null; return Promise.resolve(null); }
      var context = Api.AUTH.context();
      return Api.me().then(function (u) {
        if (!Api.AUTH.matches(context)) return null;
        S.user = u;
        if (currentPath === '/home' || currentPath === '/dashboard' || currentPath === '/me' || currentPath === '/purchase') renderRoute();
        return u;
      }).catch(function (e) {
        if ((e.status === 401 || e.code === 'UNAUTHORIZED') &&
            (Api.AUTH.matches(context) || !Api.AUTH.currentId())) {
          S.user = null;
          S.keys = [];
          if (['/home', '/dashboard', '/keys', '/usage', '/me', '/redeem', '/purchase', '/affiliate'].indexOf(currentPath) >= 0) renderRoute();
        }
        return null;
      });
    }
  };

  global.addEventListener('pp:auth-changed', function (event) {
    if (!event.detail) return;
    App.resetAccountState();
    if (event.detail.reason !== 'expired') return;
    App.refreshPublic();
    U.toast('登录已过期，请重新登录', 'err');
    if (['/home', '/dashboard', '/chat', '/keys', '/usage', '/me', '/redeem', '/purchase', '/affiliate'].indexOf(currentPath) >= 0) {
      App.go('#/accounts', true);
    }
  });

  function loadPublic() {
    var generation = ++publicGeneration;
    return Promise.all([
      Api.settings().then(function (s) {
        if (generation !== publicGeneration) return;
        S.settings = s;
        if (s && s.registration_enabled === false) ROUTES['/register'] = ROUTES['/register'];
        document.title = (s && s.site_name) || 'Pp API';
        if (currentPath === '/home' && !S.user) renderRoute();
      }).catch(function () {}),
      Api.plaza().then(function (p) {
        if (generation !== publicGeneration) return;
        S.plaza = p;
        S.plazaLoading = false;
        // never re-render the chat page from a background load: it would
        // rebuild the page under the user and drop in-progress state.
        if ((currentPath === '/home' && !S.user) || currentPath === '/plaza') renderRoute();
      }).catch(function () {
        if (generation !== publicGeneration) return;
        S.plazaLoading = false;
        if (currentPath === '/plaza') renderRoute();
      })
    ]);
  }

  // Keep inputs above the soft keyboard. Two cases:
  //  * WebView resizes (adjustResize): innerHeight shrinks, --kb stays 0.
  //  * WebView is overlaid by the IME: visualViewport shrinks, --kb = overlap.
  function bindKeyboard() {
    var vv = global.visualViewport;
    function update() {
      var kb = 0;
      if (vv) {
        kb = Math.round(global.innerHeight - vv.height - (vv.offsetTop || 0));
      }
      if (kb < 80) kb = 0;
      document.documentElement.style.setProperty('--kb', kb + 'px');
      document.body.classList.toggle('kb-open', kb > 0);
    }
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }
    global.addEventListener('resize', update);
    setTimeout(update, 400);

    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (!t || !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      setTimeout(function () {
        try {
          t.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (err) {
          try { t.scrollIntoView(); } catch (e2) {}
        }
      }, 320);
    });
  }

  function boot(isRefresh) {
    if (!isRefresh) {
      applyTheme();
      buildShell();
      bindKeyboard();
      window.addEventListener('hashchange', renderRoute);
      if (global.matchMedia) {
        try {
          matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (S.theme === 'auto') applyTheme(); });
        } catch (e) {}
      }
    }
    renderRoute();
    loadPublic();
    if (Api.AUTH.isLogged()) {
      App.refreshUser();
    }
    if (!isRefresh && global.Updates && global.Updates.supported()) {
      global.Updates.check(false);
    }
    // insets
    if (global.__insetTop) applyInsets(global.__insetTop, global.__insetBottom || 0);
  }

  function applyInsets(top, bottom) {
    global.__insetTop = top;
    global.__insetBottom = bottom;
    document.documentElement.style.setProperty('--safe-top', (top || 0) + 'px');
    document.documentElement.style.setProperty('--safe-bottom', (bottom || 0) + 'px');
    var app = U.$('#app');
    if (app) app.style.height = '100%';
    syncSpace();
  }
  global.__applyInsets = function (top, bottom) { applyInsets(top, bottom); };

  document.addEventListener('DOMContentLoaded', function () {
    boot(false);
  });
  // WebView may already be loaded when scripts run
  if (document.readyState !== 'loading') boot(false);
})(window);
