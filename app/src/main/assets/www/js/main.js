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

    var view, appbar, titleEl, subEl, actionsEl, tabbar, glassSurface;
  var tabIndicator, tabButtons = [], tabDrag = null;
  var currentPath = '';
  var publicGeneration = 0;
  var pageCache = Object.create(null), activePage = null, preloadGeneration = 0;
  var cachedRoutes = { '/home': true, '/plaza': true, '/channel-status': true, '/chat': true, '/keys': true, '/me': true };
  var LIVE_REFRESH_MS = 60000;
  var BALANCE_REFRESH_MS = 10000;
  var liveTimer = null, balanceTimer = null, livePending = false, balancePending = false, liveLastAt = 0;
  var THEMES = [
    { key: 'auto', name: '跟随系统', sub: '自动切换海蓝浅色与深色', colors: ['#0873ca', '#0e1113'] },
    { key: 'ocean', name: '海蓝', sub: '默认主题', colors: ['#0873ca', '#2f607a'] },
    { key: 'mint', name: '薄荷', sub: '清爽青绿色', colors: ['#0b8f7a', '#1d7164'] },
    { key: 'sunset', name: '日落', sub: '暖橙色调', colors: ['#d55d2d', '#b34d2d'] },
    { key: 'violet', name: '星紫', sub: '紫罗兰色调', colors: ['#7357d6', '#674bbd'] },
    { key: 'rose', name: '玫瑰', sub: '柔粉色色调', colors: ['#c84b76', '#ac3e67'] },
    { key: 'dark', name: '深色', sub: '经典深色模式', colors: ['#2c91e4', '#0e1113'] },
    { key: 'mint-dark', name: '深海', sub: '深色与青绿色', colors: ['#46c7ac', '#123a34'] },
    { key: 'sunset-dark', name: '暖夜', sub: '深色与暖橙色', colors: ['#f08a5b', '#43251d'] },
    { key: 'violet-dark', name: '夜幕', sub: '深色与星紫', colors: ['#a58bf5', '#2d2453'] },
    { key: 'rose-dark', name: '暗玫', sub: '深色与玫红', colors: ['#ef83a8', '#451d30'] }
  ];
  var THEME_KEYS = THEMES.map(function (item) { return item.key; });

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
    '/purchase': { title: '充值中心', tab: 'me', render: function () { return global.PagesPayment.renderPurchase(); } },
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
    tabIndicator = U.el('span', { class: 'tab-indicator', 'aria-hidden': 'true' });
    tabbar.appendChild(tabIndicator);
    tabButtons = [];
    TABS.forEach(function (t) {
      var b = U.el('button', { class: 'tab', 'data-tab': t.key, html: U.ic(t.icon, 22) + '<span>' + t.label + '</span>' });
      b.addEventListener('click', function () { if (location.hash !== t.path) App.go(t.path); });
      tabButtons.push(b);
      tabbar.appendChild(b);
    });
    setupTabIndicator();
    if (global.PpGlass) glassSurface = global.PpGlass.create(tabbar);
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
    var themeBtn = U.el('button', { class: 'icon-btn', html: U.ic('moon', 22), title: '切换明暗', 'aria-label': '切换明暗', 'data-theme-toggle': 'true' });
    function paintThemeButton() {
      var dark = /(^|-)dark$/.test(document.documentElement.getAttribute('data-theme') || '');
      themeBtn.innerHTML = U.ic(dark ? 'sun' : 'moon', 22);
      themeBtn.title = dark ? '切换到亮色' : '切换到暗色';
      themeBtn.setAttribute('aria-label', themeBtn.title);
    }
    themeBtn.addEventListener('click', function () { toggleLightDark(); paintThemeButton(); });
    global.addEventListener('pp:theme-changed', paintThemeButton);
    var refreshBtn = U.el('button', { class: 'icon-btn', html: U.ic('refresh', 22), title: '刷新', 'aria-label': '刷新' });
    refreshBtn.addEventListener('click', function () {
      Api.clearCache();
      U.toast('正在刷新…');
      boot(true);
    });
    actionsEl.appendChild(updateBtn);
    actionsEl.appendChild(themeBtn);
    actionsEl.appendChild(refreshBtn);
    paintThemeButton();

    if (global.requestAnimationFrame) requestAnimationFrame(syncSpace); else setTimeout(syncSpace, 16);
    window.addEventListener('resize', syncSpace);
    if (global.ResizeObserver) {
      try { new ResizeObserver(syncSpace).observe(tabbar); } catch (e) {}
    }

    var scrollFrame = 0;
    view.addEventListener('scroll', function () {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(function () {
        scrollFrame = 0;
        var scrolled = view.scrollTop > 4;
        appbar.classList.toggle('scrolled', scrolled);
        document.body.classList.toggle('scrolled', scrolled);
      });
    }, { passive: true });
  }

  function activeTabIndex() {
    var index = 0;
    tabButtons.forEach(function (button, i) { if (button.classList.contains('active')) index = i; });
    return index;
  }

  function tabCenter(index) {
    var button = tabButtons[index];
    if (!button) return { left: 0, width: 0 };
    var bar = tabbar.getBoundingClientRect();
    var rect = button.getBoundingClientRect();
    var border = parseFloat(getComputedStyle(tabbar).borderLeftWidth) || 0;
    return { left: rect.left - bar.left - border, width: rect.width };
  }

  function placeTabIndicator(index, stretch, offset) {
    if (!tabIndicator) return;
    var target = tabCenter(index);
    var width = Math.max(46, Math.min(54, target.width * .86));
    var firstPlace = tabIndicator.getAttribute('data-placed') !== '1';
    if (firstPlace) tabIndicator.style.transition = 'none';
    tabIndicator.style.width = width + 'px';
    var center = target.left + target.width / 2 + (offset || 0);
    tabIndicator.style.transform = 'translateX(' + (center - width / 2) + 'px) scaleX(' + (stretch || 1) + ')';
    if (firstPlace) {
      void tabIndicator.offsetWidth;
      tabIndicator.style.transition = '';
      tabIndicator.setAttribute('data-placed', '1');
    }
  }

  function syncTabIndicator() {
    if (!tabIndicator || !tabButtons.length || tabbar.style.display === 'none') return;
    placeTabIndicator(activeTabIndex());
  }

  function setupTabIndicator() {
    var startX = 0, startIndex = 0, moved = false;
    function point(event) {
      var touch = event.touches && event.touches[0];
      return touch ? touch.clientX : event.clientX;
    }
    function move(event) {
      if (!tabDrag) return;
      var x = point(event);
      var delta = x - startX;
      moved = moved || Math.abs(delta) > 6;
      var origin = tabCenter(startIndex);
      var width = Math.max(46, Math.min(54, origin.width * .86));
      var center = origin.left + origin.width / 2 + delta;
      tabIndicator.style.transform = 'translateX(' + (center - width / 2) + 'px) scaleX(' +
        (1 + Math.min(.22, Math.abs(delta) / origin.width * .22)) + ')';
      if (event.cancelable) event.preventDefault();
    }
    function end(event) {
      if (!tabDrag) return;
      var current = tabDrag;
      tabDrag = null;
      tabbar.classList.remove('dragging');
      if (!moved && current.allowClick) return;
      var nearest = startIndex, best = Infinity;
      var bar = tabbar.getBoundingClientRect();
      var pointer = point(event || current.lastEvent || { clientX: startX });
      tabButtons.forEach(function (button, index) {
        var rect = button.getBoundingClientRect();
        var center = rect.left + rect.width / 2 - bar.left;
        var distance = Math.abs(pointer - (bar.left + center));
        if (distance < best) { best = distance; nearest = index; }
      });
      var target = TABS[nearest];
      if (target && location.hash !== target.path) App.go(target.path);
      else placeTabIndicator(nearest);
    }
    function begin(event) {
      if (event.button && event.button !== 0) return;
      startX = point(event);
      startIndex = activeTabIndex();
      moved = false;
      var target = event.target.closest ? event.target.closest('.tab') : null;
      tabDrag = { allowClick: !target, lastEvent: event };
      tabbar.classList.add('dragging');
      placeTabIndicator(startIndex);
    }
    tabbar.addEventListener('touchstart', begin, { passive: true });
    tabbar.addEventListener('touchmove', move, { passive: false });
    tabbar.addEventListener('touchend', end, { passive: true });
    tabbar.addEventListener('touchcancel', end, { passive: true });
    tabbar.addEventListener('mousedown', begin);
    document.addEventListener('mousemove', function (event) {
      if (!tabDrag) return;
      tabDrag.lastEvent = event;
      move(event);
    });
    document.addEventListener('mouseup', function (event) {
      if (!tabDrag) return;
      tabDrag.lastEvent = event;
      end(event);
    });
    global.addEventListener('resize', syncTabIndicator);
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
    syncTabIndicator();
  }

  function applyTheme() {
    var mode = THEME_KEYS.indexOf(S.theme) >= 0 ? S.theme : 'ocean';
    var resolved = mode === 'auto' && global.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : mode;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-mode', mode);
    var meta = document.querySelector('meta[name="theme-color"]');
    var dark = /(^|-)dark$/.test(resolved);
    var color = dark ? '#0e1113' : getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#f5f6f8';
    if (meta) meta.setAttribute('content', color);
    if (global.Native && global.Native.statusBar) {
      global.Native.statusBar(color, !dark);
    }
    global.dispatchEvent(new CustomEvent('pp:theme-changed', { detail: { theme: resolved } }));
  }

  function toggleLightDark() {
    var currentDark = /(^|-)dark$/.test(document.documentElement.getAttribute('data-theme') || '');
    setTheme(currentDark ? 'ocean' : 'dark');
  }

  function setTheme(key, quiet) {
    if (THEME_KEYS.indexOf(key) < 0) key = 'ocean';
    S.theme = key;
    U.store.set('theme', key);
    applyTheme();
    if (!quiet) U.toast('已切换到' + (THEMES.filter(function (item) { return item.key === key; })[0] || {}).name, 'ok');
  }

  function openThemePicker() {
    var host = U.el('div', { class: 'theme-grid' });
    function paint() {
      host.innerHTML = '';
      THEMES.forEach(function (theme) {
        var active = S.theme === theme.key;
        host.appendChild(U.el('button', {
          type: 'button', class: 'theme-choice' + (active ? ' active' : ''),
          'aria-pressed': active ? 'true' : 'false',
          style: { '--swatch': theme.colors[0], '--swatch-2': theme.colors[1] },
          onclick: function () { setTheme(theme.key); paint(); }
        },
          U.el('span', { class: 'theme-choice-name' }, U.el('i'), theme.name),
          U.el('small', null, theme.sub),
          active ? U.el('span', { class: 'theme-choice-check', html: U.ic('check', 17) }) : null
        ));
      });
    }
    paint();
    U.sheet({ title: '主题外观', body: host, actions: [{ label: '完成' }] });
  }
  global.AppTheme = { set: setTheme, open: openThemePicker, themes: THEMES };

  function parseHash() {
    var raw = (location.hash || '').replace(/^#/, '');
    if (!raw) return { path: '/home', param: '' };
    var parts = raw.split('/').filter(Boolean);
    if (parts[1] === undefined) return { path: '/' + parts[0], param: '' };
    return { path: '/' + parts[0], param: parts.slice(1).join('/') };
  }

  function pageEvent(entry, name) {
    if (entry && entry.slot.firstElementChild) entry.slot.firstElementChild.dispatchEvent(new CustomEvent('pp:page-' + name));
  }

  function disposePage(entry) {
    if (!entry) return;
    pageEvent(entry, 'dispose');
    if (entry.slot.parentNode) entry.slot.remove();
    if (pageCache[entry.path] === entry) delete pageCache[entry.path];
    if (activePage === entry) activePage = null;
  }

  function clearPages() {
    preloadGeneration++;
    if (activePage && !cachedRoutes[activePage.path]) disposePage(activePage);
    Object.keys(pageCache).forEach(function (path) { disposePage(pageCache[path]); });
    activePage = null;
  }

  function makePage(path, param) {
    var def = ROUTES[path], entry = { path: path, slot: U.el('div', { class: 'route-slot' }), scroll: 0 };
    if (cachedRoutes[path]) pageCache[path] = entry;
    try {
      var node = path === '/announcements' && param ? C.renderAnnouncements(param) : def.render(param);
      if (node) entry.slot.appendChild(node);
    } catch (e) {
      entry.slot.appendChild(U.el('div', { class: 'page' },
        U.el('div', { class: 'empty' }, U.el('p', null, '页面加载出错'), U.el('small', null, String(e && e.message || e)))));
    }
    return entry;
  }

  function preloadPages() {
    var generation = ++preloadGeneration;
    var paths = Api.AUTH.isLogged() ? ['/plaza', '/keys', '/chat', '/me', '/home', '/channel-status'] : ['/plaza', '/channel-status'];
    function scheduleNext(callback) {
      if (global.requestIdleCallback) global.requestIdleCallback(callback, { timeout: 900 });
      else setTimeout(callback, 160);
    }
    function next() {
      if (generation !== preloadGeneration || !view) return;
      var path = paths.shift();
      if (!path) return;
      if (!pageCache[path]) makePage(path, '');
      if (paths.length) scheduleNext(next);
    }
    scheduleNext(next);
  }

  function renderRoute(force) {
    force = force === true;
    var r = parseHash();
    var def = ROUTES[r.path];
    if (!def) { def = ROUTES['/home']; r.path = '/home'; }

    if (!force && activePage && activePage.path === r.path && activePage.param === r.param) return;
    if (activePage) {
      activePage.scroll = view.scrollTop;
      pageEvent(activePage, 'deactivate');
      if (cachedRoutes[activePage.path] && !force) activePage.slot.remove();
      else disposePage(activePage);
      activePage = null;
    }
    if (force && pageCache[r.path]) disposePage(pageCache[r.path]);

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
    syncTabIndicator();

    var entry = pageCache[r.path] || makePage(r.path, r.param);
    entry.param = r.param;
    activePage = entry;
    view.appendChild(entry.slot);
    view.scrollTop = entry.scroll || 0;
    var routeScrolled = view.scrollTop > 4;
    appbar.classList.toggle('scrolled', routeScrolled);
    document.body.classList.toggle('scrolled', routeScrolled);
    pageEvent(entry, 'activate');
    syncSpace();
  }

  var App = global.App = {
    go: function (path, replace) {
      if (!path) path = '#/home';
      if (path.charAt(0) !== '#') path = '#' + path;
      if (replace) {
        location.replace(path);
        renderRoute(true);
      } else if (location.hash === path) {
        renderRoute(true);
      } else {
        location.hash = path;
      }
    },
    resetAccountState: function () {
      publicGeneration++;
      clearPages();
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
      preloadPages();
    },
    isPageRetained: function (node) {
      if (!node) return false;
      if (node.isConnected) return true;
      return Object.keys(pageCache).some(function (path) { return pageCache[path].slot.contains(node); });
    },
    isPageActive: function (node) { return !!(node && activePage && activePage.slot.contains(node) && activePage.slot.isConnected); },
    invalidatePages: clearPages,
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
        global.dispatchEvent(new CustomEvent('pp:user-updated'));
        return u;
      }).catch(function (e) {
        if ((e.status === 401 || e.code === 'UNAUTHORIZED') &&
            (Api.AUTH.matches(context) || !Api.AUTH.currentId())) {
          S.user = null;
          S.keys = [];
          if (['/home', '/dashboard', '/keys', '/usage', '/me', '/redeem', '/purchase', '/affiliate'].indexOf(currentPath) >= 0) renderRoute(true);
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
        if (currentPath === '/home' && !S.user) renderRoute(true);
      }).catch(function () {}),
      Api.plaza(true).then(function (p) {
        if (generation !== publicGeneration) return;
        S.plaza = p;
        S.plazaLoading = false;
        if (pageCache['/plaza']) pageEvent(pageCache['/plaza'], 'plaza-updated');
        if (currentPath === '/home' && !S.user) renderRoute(true);
      }).catch(function () {
        if (generation !== publicGeneration) return;
        S.plazaLoading = false;
        if (pageCache['/plaza']) pageEvent(pageCache['/plaza'], 'plaza-updated');
      })
    ]);
  }

  function requestLiveData(options) {
    return Promise.all([
      Api.settings().then(function (s) {
        S.settings = s;
        document.title = (s && s.site_name) || 'Pp API';
        return { kind: 'settings', value: s };
      }).catch(function () { shellRefreshFailed('settings'); return null; }),
      Api.plaza(true).then(function (p) {
        S.plaza = p;
        S.plazaLoading = false;
        if (pageCache['/plaza']) pageEvent(pageCache['/plaza'], 'plaza-updated');
        return { kind: 'plaza', value: p };
      }).catch(function () { S.plazaLoading = false; shellRefreshFailed('plaza'); return null; }),
      Api.channelStatus().then(function (data) {
        return { kind: 'channel', value: data };
      }).catch(function () { shellRefreshFailed('channel'); return null; })
    ]).then(function (results) {
      liveLastAt = Date.now();
      var changed = {};
      results.forEach(function (result) {
        if (!result) return;
        changed[result.kind] = result.value;
      });
      global.dispatchEvent(new CustomEvent('pp:live-refreshed', {
        detail: { reason: options && options.reason || 'timer', changed: changed, at: liveLastAt }
      }));
      return changed;
    }).then(function (changed) {
      options = options || {};
      if (!changed.plaza) return changed;
      return Promise.resolve().then(function () {
        var known = U.store.get('plaza_channel_snapshot', null);
        var snapshot = null;
        var groups = [];
        ((changed.plaza && changed.plaza.groups) || []).forEach(function (group) {
          var models = Array.isArray(group.models) ? group.models.map(function (model) { return model && (model.name || model.id || String(model)); }).filter(Boolean) : [];
          if (!models.length) return;
          groups.push({ id: group.id, name: group.name || '未命名分组', platform: group.platform || '', models: models,
            subscription: group.subscription_type === 'subscription', updatedAt: group.updated_at || group.updatedAt || '' });
        });
        var signature = groups.map(function (group) {
          return [group.id, group.name, group.platform, group.subscription, group.updatedAt, group.models.slice().sort().join(',')].join(':');
        }).sort().join('|');
        var summary = changed.channel && Array.isArray(changed.channel.items) ? changed.channel.items : [];
        var next = { signature: signature, groups: groups, at: Date.now(), summary: summary };
        var previous = known && typeof known === 'object' ? known : null;
        var added = [];
        if (previous && previous.signature !== signature) {
          var oldNames = (previous.groups || []).map(function (group) { return String(group.id) + ':' + group.name; });
          groups.forEach(function (group) {
            if (oldNames.indexOf(String(group.id) + ':' + group.name) < 0) added.push(group.name);
          });
        }
        U.store.set('plaza_channel_snapshot', next);
        if (added.length) {
          global.dispatchEvent(new CustomEvent('pp:content-added', { detail: { groups: added, count: added.length } }));
          if (changed.plaza && currentPath !== '/plaza') U.toast('模型广场新增 ' + added.length + ' 个分组，已更新', 'ok');
        }
        return changed;
      }).catch(function () { return changed; });
    });
  }

  function shellRefreshFailed(kind) {
    global.dispatchEvent(new CustomEvent('pp:live-refresh-failed', { detail: { kind: kind } }));
  }

  function scheduleLiveRefresh(delay) {
    clearTimeout(liveTimer);
    var wait = delay === undefined ? LIVE_REFRESH_MS : Math.max(5000, delay);
    liveTimer = setTimeout(function () {
      liveTimer = null;
      if (!document.hidden) refreshLive('timer');
      else scheduleLiveRefresh(LIVE_REFRESH_MS);
    }, wait);
  }

  function refreshLive(reason) {
    if (livePending) return Promise.resolve(null);
    livePending = true;
    return requestLiveData({ reason: reason }).then(function (result) {
      return result;
    }).catch(function () { return null; }).then(function (result) {
      livePending = false;
      if (!document.hidden) scheduleLiveRefresh();
      return result;
    });
  }

  function scheduleBalanceRefresh() {
    clearTimeout(balanceTimer);
    balanceTimer = setTimeout(function () {
      balanceTimer = null;
      if (!document.hidden && Api.AUTH.isLogged()) refreshBalance();
      else scheduleBalanceRefresh();
    }, BALANCE_REFRESH_MS);
  }

  function refreshBalance() {
    if (balancePending || !Api.AUTH.isLogged()) return Promise.resolve(null);
    balancePending = true;
    var context = Api.AUTH.context();
    return Api.me({ balanceOnly: true }).then(function (user) {
      if (!Api.AUTH.matches(context)) return null;
      S.user = user;
      global.dispatchEvent(new CustomEvent('pp:user-updated'));
      return user;
    }).catch(function () { return null; }).then(function (user) {
      balancePending = false;
      scheduleBalanceRefresh();
      return user;
    });
  }

  function bindLiveRefresh() {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        clearTimeout(liveTimer);
        liveTimer = null;
        clearTimeout(balanceTimer);
        balanceTimer = null;
      } else {
        refreshLive('visible');
        refreshBalance();
      }
    });
    global.addEventListener('online', function () { refreshLive('online'); refreshBalance(); });
    global.addEventListener('pp:keys-changed', function () { refreshLive('keys'); });
    scheduleBalanceRefresh();
    scheduleLiveRefresh(12000);
  }
  global.__ppLiveRefresh = function (reason) { return refreshLive(reason || 'manual'); };
  global.__ppBalanceRefresh = function () { return refreshBalance(); };

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
      bindLiveRefresh();
      if (global.matchMedia) {
        try {
          matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (S.theme === 'auto') applyTheme(); });
        } catch (e) {}
      }
    }
    if (isRefresh) clearPages();
    renderRoute(isRefresh);
    loadPublic();
    if (Api.AUTH.isLogged()) {
      App.refreshUser();
    }
    if (!isRefresh && global.Updates && global.Updates.supported()) {
      global.Updates.check(false);
    }
    preloadPages();
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
