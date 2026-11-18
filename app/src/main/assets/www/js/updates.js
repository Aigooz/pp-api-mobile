/* Update state is supplied by the native Android updater. */
(function (global) {
  'use strict';
  var U = global.U;
  var h = U.el;
  var info = {};
  try { info = JSON.parse(global.Native && global.Native.device ? global.Native.device() : '{}'); } catch (e) {}
  var hasNativeUpdater = !!global.Native && typeof global.Native.updateCheck === 'function';
  var android = info.platform === 'android' && hasNativeUpdater;
  var iosNative = info.platform === 'ios' && hasNativeUpdater;
  var state = { status: 'idle', release: null, message: '', manual: false,
    downloaded: 0, total: 0, speed: 0, attempt: 1 };

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function changed() { global.dispatchEvent(new CustomEvent('pp:updates-changed')); }
  function check(manual) {
    if (!(android || iosNative) || state.status === 'checking') return;
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
      if (data.version) {
        // Progress snapshots only carry the version; keep notes and size from
        // the release payload so a resumed download still renders fully.
        var merged = {};
        var key;
        for (key in (state.release || {})) if (Object.prototype.hasOwnProperty.call(state.release, key)) merged[key] = state.release[key];
        for (key in data) if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== '' && data[key] !== null) merged[key] = data[key];
        state.release = merged;
      }
      state.message = '';
      if (status === 'downloading') {
        state.downloaded = Number(data.downloaded) || 0;
        state.total = Number(data.total) || (state.release && Number(state.release.size)) || 0;
        state.speed = Number(data.speed) || 0;
        state.attempt = Number(data.attempt) || 1;
      } else if (status === 'ready') {
        state.downloaded = state.total || state.downloaded;
        state.speed = 0;
      }
      if (status === 'available' && !state.manual && data.version && U.store.get('update_prompted', '') !== data.version) {
        U.store.set('update_prompted', data.version);
        U.toast('发现新版本 ' + data.version + '，请到“我的 · 软件更新”查看', 'ok');
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

  // Native pushes throttled ticks (iOS) so the visible bar moves without a full
  // re-render; the page keeps its own node references and just repaints them.
  var tickSink = null;
  global.__ppUpdateTick = function (raw) {
    var data = {};
    try { data = JSON.parse(raw || '{}'); } catch (e) { return; }
    if (state.status !== 'downloading') return;
    if (data.downloaded !== undefined) state.downloaded = Number(data.downloaded) || 0;
    if (data.total) state.total = Number(data.total) || state.total;
    if (data.speed !== undefined) state.speed = Number(data.speed) || 0;
    if (data.attempt) state.attempt = Number(data.attempt) || 1;
    if (tickSink) tickSink();
  };

  function render() {
    var page = h('div', { class: 'page updates-page' });
    var version = info.app || '预览版';
    page.appendChild(h('div', { class: 'updates-version' },
      h('img', { src: 'img/pp-logo.jpg', alt: '', width: '52', height: '52' }),
      h('div', null, h('strong', null, 'Pp API'), h('div', { class: 'small muted' }, '当前版本 ' + version))));
    if (!android && !iosNative) {
      var ios = info.platform === 'ios';
      page.appendChild(h('div', { class: 'notice', style: { marginTop: '16px' } }, ios
        ? 'iOS 安装包需要使用自己的 Apple ID 签名后安装；更新时也需要重新签名。'
        : '请在 Android 客户端中检查和安装更新。'));
      if (ios) {
        page.appendChild(h('button', { class: 'btn btn-primary btn-block', style: { marginTop: '16px' }, onclick: function () {
          global.Native.open('https://github.com/Aigooz/pp-api-mobile/releases/latest');
        } }, '打开 GitHub 下载页面'));
      }
      return page;
    }
    if (iosNative) {
      page.appendChild(h('div', { class: 'updates-hint', style: { marginBottom: '12px' } },
        'iOS 安装包会下载到应用内，安装时通过系统分享导出，仍需用自己的 Apple ID 重新签名。'));
    }
    var content = h('div', { class: 'section updates-content' });
    page.appendChild(content);

    // Live nodes for the progress card. The bar is updated in place so the
    // download never flickers while the page is polling the native service.
    var refs = null;
    var timer = null;

    function stopPolling() {
      if (timer) { clearTimeout(timer); timer = null; }
      tickSink = null;
    }

    function applyProgress() {
      if (!refs) return;
      var total = state.total, done = state.downloaded;
      var known = total > 0;
      var percent = known ? Math.min(100, Math.max(0, done * 100 / total)) : 0;
      refs.card.classList.toggle('indeterminate', !known);
      refs.bar.style.width = known ? percent.toFixed(1) + '%' : '35%';
      refs.pct.textContent = known ? (percent >= 100 ? '100%' : percent.toFixed(1) + '%') : formatBytes(done);
      refs.size.textContent = known
        ? formatBytes(done) + ' / ' + formatBytes(total)
        : '已下载 ' + formatBytes(done);
      refs.speed.textContent = state.speed > 0 ? formatBytes(state.speed) + '/s' : '正在连接…';
      refs.attempt.textContent = state.attempt > 1 ? '第 ' + state.attempt + ' 次尝试' : '传输中';
    }

    function poll() {
      timer = null;
      if (!refs || state.status !== 'downloading' || !global.Native.updateProgress) return;
      var snap = {};
      try { snap = JSON.parse(global.Native.updateProgress() || '{}'); } catch (e) { snap = {}; }
      if (snap.downloaded !== undefined) state.downloaded = Number(snap.downloaded) || 0;
      if (snap.total) state.total = Number(snap.total) || 0;
      else if (!state.total && state.release) state.total = Number(state.release.size) || 0;
      if (snap.speed !== undefined) state.speed = Number(snap.speed) || 0;
      if (snap.attempt) state.attempt = Number(snap.attempt) || 1;
      if (snap.state === 'ready') {
        state.status = 'ready';
        state.message = '';
        stopPolling();
        changed();
        return;
      }
      if (snap.state === 'error' || snap.state === 'cancelled') {
        state.status = 'error';
        state.message = snap.message || (snap.state === 'cancelled' ? '已取消下载' : '下载失败');
        stopPolling();
        changed();
        return;
      }
      applyProgress();
      timer = setTimeout(poll, 500);
    }

    function startPolling() {
      if (timer || !global.Native.updateProgress) return;
      timer = setTimeout(poll, 260);
    }

    function paint() {
      if (!page.isConnected) return;
      content.innerHTML = '';
      refs = null;
      var release = state.release || {};
      var statusText = {
        idle: '检查是否有新版本', checking: '正在检查更新…', current: '当前已是最新版本',
        available: '发现新版本 ' + (release.version || ''), downloading: '正在下载新版本',
        ready: '下载完成，可以安装', error: state.message
      };
      content.appendChild(h('div', { class: 'updates-status' },
        h('span', { class: 'updates-status-icon', html: U.ic(state.status === 'error' ? 'alert' : 'refresh', 18) }),
        h('div', { class: 'updates-status-copy' }, h('strong', null, statusText[state.status] || ''),
          h('div', { class: 'tiny muted' }, state.status === 'downloading'
            ? '在应用内即可查看进度，可退到后台继续下载'
            : 'GitHub Releases'))));
      if (release.notes && ['available', 'downloading', 'ready'].indexOf(state.status) >= 0) {
        content.appendChild(h('div', { class: 'updates-notes' }, h('strong', null, '更新内容'), h('div', null, release.notes)));
      }
      if (state.status === 'downloading') {
        var card = h('div', { class: 'updates-progress', role: 'progressbar', 'aria-label': '下载进度' });
        var bar = h('i');
        var pct = h('div', { class: 'updates-progress-pct' }, '0%');
        var size = h('div', { class: 'updates-progress-size' }, '');
        var speed = h('span', null, '正在连接…');
        var attempt = h('span', null, '传输中');
        card.appendChild(h('div', { class: 'updates-progress-head' }, pct, size));
        card.appendChild(h('div', { class: 'progress' }, bar));
        card.appendChild(h('div', { class: 'updates-progress-meta' }, speed, attempt));
        content.appendChild(card);
        content.appendChild(h('div', { class: 'updates-hint' },
          '网络较慢时会自动重试并断点续传，进度和已下载部分都会保留，不会中断请求。'));
        content.appendChild(h('button', { class: 'btn btn-block', onclick: function () {
          if (global.Native.updateCancel) global.Native.updateCancel();
        } }, '取消下载'));
        refs = { card: card, bar: bar, pct: pct, size: size, speed: speed, attempt: attempt };
        applyProgress();
        tickSink = applyProgress;
        startPolling();
      }
      if (state.status === 'available') {
        content.appendChild(h('button', { class: 'btn btn-primary btn-block', onclick: function () { global.Native.updateDownload(); } }, '下载更新'));
      } else if (state.status === 'ready') {
        if (state.total > 0) {
          content.appendChild(h('div', { class: 'updates-hint' }, '安装包 ' + formatBytes(state.total) + ' 已下载并通过校验。'));
        }
        content.appendChild(h('button', { class: 'btn btn-primary btn-block', onclick: function () { global.Native.updateInstall(); } },
          iosNative ? '导出安装包' : '安装更新'));
      } else if (state.status !== 'checking' && state.status !== 'downloading') {
        content.appendChild(h('button', { class: 'btn btn-primary btn-block', onclick: function () { check(true); } }, state.status === 'error' ? '重新检查' : '检查更新'));
      }
      if (android) {
        var notificationState = '';
        try { notificationState = global.Native.updateNotificationState(); } catch (e) {}
        content.appendChild(h('div', { class: 'updates-notification' },
          h('div', null, h('strong', null, '更新通知'), h('div', { class: 'tiny muted' }, notificationState === 'enabled' ? '已开启' : '未开启')),
          notificationState !== 'enabled' ? h('button', { class: 'btn btn-sm', onclick: function () { global.Native.updateEnableNotifications(); } }, '开启通知') : null));
      }
    }
    function listener() {
      if (!page.isConnected) { global.removeEventListener('pp:updates-changed', listener); stopPolling(); return; }
      paint();
    }
    global.addEventListener('pp:updates-changed', listener);
    page.addEventListener('pp:page-activate', function () {
      if (state.status === 'downloading') startPolling();
    });
    page.addEventListener('pp:page-deactivate', stopPolling);
    page.addEventListener('pp:page-dispose', function () {
      stopPolling();
      global.removeEventListener('pp:updates-changed', listener);
    });
    setTimeout(function () {
      paint();
      if (global.Native.updateResume) global.Native.updateResume();
    }, 0);
    return page;
  }

  global.Updates = {
    state: state, check: check, render: render, supported: function () { return !!(android || iosNative); },
    version: function () { return info.app || '预览版'; }
  };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) changed(); });
})(window);
