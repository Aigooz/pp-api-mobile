/* Small helpers: DOM, formatting, storage, icons, overlays. */
(function (global) {
  'use strict';

  // ---------- DOM ----------
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    var kids = [];
    for (var i = 2; i < arguments.length; i++) kids.push(arguments[i]);
    (function add(list) {
      list.forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        if (Array.isArray(c)) { add(c); return; }
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    })(kids);
    return node;
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- format ----------
  function num(v, digits) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    var d = digits === undefined ? 0 : digits;
    return n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function credits(v) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a === 0) return '0';
    if (a >= 1000) return (n / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    if (a < 0.01) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    if (a < 1) return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return n.toFixed(2).replace(/\.00$/, '');
  }
  function tokens(v) {
    var n = Number(v) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
    return String(Math.round(n));
  }
  function price(v) {
    var n = Number(v);
    if (!isFinite(n) || n === 0) return '0';
    if (Math.abs(n) < 0.01) return n.toFixed(4);
    return n.toFixed(2);
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function date(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function datetime(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function ago(v) {
    var t = new Date(v).getTime();
    if (!isFinite(t)) return '';
    var s = (Date.now() - t) / 1000;
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
    return date(v);
  }
  function maskKey(k) {
    if (!k) return '';
    if (k.length <= 12) return k.slice(0, 4) + '***';
    return k.slice(0, 6) + '…' + k.slice(-4);
  }
  function ymd(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // ---------- storage ----------
  var store = {
    get: function (k, fallback) {
      try {
        var v = localStorage.getItem('pp_api_' + k);
        if (v === null) return fallback;
        return JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set: function (k, v) {
      try { localStorage.setItem('pp_api_' + k, JSON.stringify(v)); } catch (e) {}
    },
    del: function (k) {
      try { localStorage.removeItem('pp_api_' + k); } catch (e) {}
    }
  };

  // ---------- icons ----------
  var PATHS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/>',
    plaza: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 21 2m-3 3 2 2m-5 1 2 2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c.9-3.8 3.8-5.5 7.5-5.5s6.6 1.7 7.5 5.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.4"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/>',
    edit: '<path d="M4 20h4L20 8l-4-4L4 16v4Z"/><path d="m14 6 4 4"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.4"/><path d="M20 4v7h-7"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    back: '<path d="m15 6-6 6 6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    gift: '<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M3 12h18M12 8v13"/><path d="M12 8c-1.8 0-4-.7-4-2.6C8 3.5 9.6 3 10.6 3.5 11.8 4 12 6 12 8Zm0 0c1.8 0 4-.7 4-2.6 0-1.9-1.6-2.4-2.6-1.9C12.2 4 12 6 12 8Z"/>',
    chart: '<path d="M4 20V10m5 10V4m5 16v-7m5 7V8"/>',
    card: '<rect x="3" y="5" width="18" height="14" rx="2.4"/><path d="M3 10h18"/>',
    bell: '<path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5 1.5 5h-15S6 13 6 9Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a1.7 1.7 0 0 0-1.6-1H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3 8.6a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 8 3h.1A1.7 1.7 0 0 0 9 1.4V1a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 3a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 8v.1a1.7 1.7 0 0 0 1.6 1H23a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    send: '<path d="M21 3 10.5 13.5M21 3l-6.5 18-4-8-8-4L21 3Z"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m4 12.5 5 5L20 6.5"/>',
    alert: '<path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v5m0 3v.5"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    shield: '<path d="M12 3 4 6v6c0 4.5 3.4 7.7 8 9 4.6-1.3 8-4.5 8-9V6l-8-3Z"/>',
    doc: '<path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/>',
    bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2.4"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2.4"/><path d="m3.5 7 8.5 6 8.5-6"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18.5h2"/>',
    star: '<path d="m12 3 2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.4 6.4 20.3l1.2-6.3L3 9.6l6.3-.8L12 3Z"/>',
    grid: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4-2v-4L3 5Z"/>',
    users: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c.7-3.4 3.1-5 6.2-5s5.5 1.6 6.2 5"/><path d="M16 5.2a3.2 3.2 0 0 1 0 6.1M18 15.2c2 .6 3.2 2.1 3.7 4.8"/>'
  };
  function ic(name, size) {
    var p = PATHS[name] || '';
    var s = size || 20;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }

  // ---------- toast ----------
  function toast(msg, type) {
    var host = $('.toast-host');
    if (!host) {
      host = el('div', { class: 'toast-host' });
      document.body.appendChild(host);
    }
    var t = el('div', { class: 'toast ' + (type || ''), text: String(msg) });
    host.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(6px)';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }, type === 'err' ? 3200 : 2100);
  }

  // ---------- overlays ----------
  function closeOverlay() {
    var s = $('.scrim'); if (s) s.parentNode.removeChild(s);
    var sh = $('.sheet'); if (sh) sh.parentNode.removeChild(sh);
  }
  function sheet(opts) {
    closeOverlay();
    var scrim = el('div', { class: 'scrim', onclick: closeOverlay });
    var box = el('div', { class: 'sheet' }, [
      el('div', { class: 'sheet-handle' }),
      opts.title ? el('h3', { text: opts.title }) : null,
      opts.body
    ]);
    var actions = el('div', { class: 'sheet-actions' });
    if (opts.actions) {
      opts.actions.forEach(function (a) {
        actions.appendChild(el('button', {
          class: 'btn ' + (a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : ''),
          text: a.label,
          onclick: function () {
            if (a.onClick) {
              var r = a.onClick();
              if (r === false) return;
            }
            closeOverlay();
          }
        }));
      });
      box.appendChild(actions);
    }
    document.body.appendChild(scrim);
    document.body.appendChild(box);
    return { close: closeOverlay, box: box };
  }
  function confirm(title, message, okLabel, danger) {
    return new Promise(function (resolve) {
      sheet({
        title: title,
        body: el('p', { class: 'small muted', text: message || '', style: { whiteSpace: 'pre-line' } }),
        actions: [
          { label: '取消', onClick: function () { resolve(false); } },
          { label: okLabel || '确定', kind: danger ? 'danger' : 'primary', onClick: function () { resolve(true); } }
        ]
      });
    });
  }

  // ---------- misc ----------
  function copy(text) {
    if (global.Native && global.Native.copy) {
      global.Native.copy(String(text));
      toast('已复制', 'ok');
      return;
    }
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(String(text));
      else {
        var ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
        ta.value = String(text);
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      toast('已复制', 'ok');
    } catch (e) { toast('复制失败', 'err'); }
  }
  function haptic() {
    try { if (global.Native && global.Native.vibrate) global.Native.vibrate(12); } catch (e) {}
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  global.U = {
    el: el, $: $, esc: esc, ic: ic, toast: toast, sheet: sheet, confirm: confirm,
    closeOverlay: closeOverlay, copy: copy, haptic: haptic, sleep: sleep,
    num: num, credits: credits, tokens: tokens, price: price, date: date, datetime: datetime,
    ago: ago, maskKey: maskKey, ymd: ymd, pad: pad, store: store
  };
})(window);
