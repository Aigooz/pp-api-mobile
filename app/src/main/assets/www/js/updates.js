/* Update state is supplied by the native Android updater. */
(function (global) {
  'use strict';
  var U = global.U;
  var h = U.el;
  var info = {};
  try { info = JSON.parse(global.Native && global.Native.device ? global.Native.device() : '{}'); } catch (e) {}
  var android = info.platform === 'android' && global.Native && typeof global.Native.updateCheck === 'function';
  var state = { status: 'idle', release: null, message: '', manual: false };

  function changed() { global.dispatchEvent(new CustomEvent('pp:updates-changed')); }
  function check(manual) {
    if (!android || state.status === 'checking') return;
    state.manual = !!manual;
    state.status = 'checking';
    state.message = '';
    changed();
    try { global.Native.updateCheck(!!manual); }
    catch (e) { state.status = 'error'; state.message = '无法检查更新'; changed(); }
  }

  global.__nativeUpdate = function (status, raw) {
    var data = {};
    try { data = JSON.parse(raw || '{}'); } catch (e) {}
    if (status === 'checking') state.status = 'checking';
    else if (status === 'available' || status === 'downloading' || status === 'ready') {
      if (status === 'available' && ['downloading', 'ready'].indexOf(state.status) >= 0 &&
          state.release && state.release.version === data.version) return;
      state.status = status;
      state.release = data;
      state.message = '';
      if (status === 'available' && !state.manual && data.version && U.store.get('update_prompted', '') !== data.version) {
        U.store.set('update_prompted', data.version);
        U.toast('发现新版本 ' + data.version + '，点击顶部更新图标查看', 'ok');
      }
    } else if (status === 'current') {
      if (['downloading', 'ready'].indexOf(state.status) >= 0) return;
      state.status = 'current';
      state.release = null;
      state.message = '';
    } else if (status === 'error') {
      state.status = 'error';
      state.message = data.message || '更新失败，请稍后重试';
    }
    changed();
  };

  function render() {
    var page = h('div', { class: 'page updates-page' });
    var version = info.app || '预览版';
    page.appendChild(h('div', { class: 'updates-version' },
      h('img', { src: 'img/pp-logo.jpg', alt: '', width: '52', height: '52' }),
      h('div', null, h('strong', null, 'Pp API'), h('div', { class: 'small muted' }, '当前版本 ' + version))));
    if (!android) {
      page.appendChild(h('div', { class: 'notice', style: { marginTop: '16px' } }, info.platform === 'ios'
        ? 'iOS 更新需要通过 TestFlight 或 App Store 安装。目前尚未配置苹果分发渠道。'
        : '请在 Android 客户端中检查和安装更新。'));
      return page;
    }
    var content = h('div', { class: 'section updates-content' });
    page.appendChild(content);

    function paint() {
      if (!page.isConnected) return;
      content.innerHTML = '';
      var release = state.release || {};
      var statusText = {
        idle: '检查是否有新版本', checking: '正在检查更新…', current: '当前已是最新版本',
        available: '发现新版本 ' + (release.version || ''), downloading: '正在下载新版本',
        ready: '下载完成，可以安装', error: state.message
      };
      content.appendChild(h('div', { class: 'updates-status' },
        h('span', { class: 'updates-status-icon', html: U.ic(state.status === 'error' ? 'alert' : 'refresh', 18) }),
        h('div', { class: 'updates-status-copy' }, h('strong', null, statusText[state.status] || ''),
          h('div', { class: 'tiny muted' }, state.status === 'downloading' ? '下载进度可在系统通知中查看' : 'GitHub Releases'))));
      if (release.notes && ['available', 'downloading', 'ready'].indexOf(state.status) >= 0) {
        content.appendChild(h('div', { class: 'updates-notes' }, h('strong', null, '更新内容'), h('div', null, release.notes)));
      }
      if (state.status === 'available') {
        content.appendChild(h('button', { class: 'btn btn-primary btn-block', onclick: function () { global.Native.updateDownload(); } }, '下载更新'));
      } else if (state.status === 'ready') {
        content.appendChild(h('button', { class: 'btn btn-primary btn-block', onclick: function () { global.Native.updateInstall(); } }, '安装更新'));
      } else if (state.status !== 'checking' && state.status !== 'downloading') {
        content.appendChild(h('button', { class: 'btn btn-primary btn-block', onclick: function () { check(true); } }, state.status === 'error' ? '重新检查' : '检查更新'));
      }
      var notificationState = '';
      try { notificationState = global.Native.updateNotificationState(); } catch (e) {}
      content.appendChild(h('div', { class: 'updates-notification' },
        h('div', null, h('strong', null, '更新通知'), h('div', { class: 'tiny muted' }, notificationState === 'enabled' ? '已开启' : '未开启')),
        notificationState !== 'enabled' ? h('button', { class: 'btn btn-sm', onclick: function () { global.Native.updateEnableNotifications(); } }, '开启通知') : null));
    }
    function listener() {
      if (!page.isConnected) { global.removeEventListener('pp:updates-changed', listener); return; }
      paint();
    }
    global.addEventListener('pp:updates-changed', listener);
    setTimeout(function () {
      paint();
      if (global.Native.updateResume) global.Native.updateResume();
    }, 0);
    return page;
  }

  global.Updates = {
    state: state, check: check, render: render, supported: function () { return !!android; },
    version: function () { return info.app || '预览版'; }
  };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) changed(); });
})(window);
