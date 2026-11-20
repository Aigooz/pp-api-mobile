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

  // Announcements are authored as rich HTML by the site. Render that markup,
  // but strip active content and restrict URLs so a compromised post cannot
  // run script inside the WebView.
  var SAFE_TAGS = {
    A: 1, B: 1, BLOCKQUOTE: 1, BR: 1, CODE: 1, DEL: 1, DIV: 1, EM: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HR: 1, I: 1, IMG: 1, LI: 1,
    OL: 1, P: 1, PRE: 1, S: 1, SECTION: 1, SMALL: 1, SPAN: 1, STRONG: 1,
    SUB: 1, SUP: 1, TABLE: 1, TBODY: 1, TD: 1, TH: 1, THEAD: 1, TR: 1, U: 1, UL: 1
  };
  var SAFE_STYLES = {
    'background-color': 1, 'border-left': 1, 'border-radius': 1, color: 1,
    'font-size': 1, 'font-style': 1, 'font-weight': 1, 'letter-spacing': 1,
    'line-height': 1, margin: 1, 'margin-bottom': 1, 'margin-left': 1,
    'margin-right': 1, 'margin-top': 1, 'padding-left': 1, 'text-align': 1,
    'text-decoration': 1, 'white-space': 1
  };
  function safeStyle(raw) {
    var out = [];
    String(raw || '').split(';').forEach(function (part) {
      var at = part.indexOf(':');
      if (at < 0) return;
      var name = part.slice(0, at).trim().toLowerCase();
      var value = part.slice(at + 1).trim();
      if (!SAFE_STYLES[name] || !value || /url\s*\(|expression\s*\(|javascript:|@import/i.test(value)) return;
      // Only plain colours, lengths and keywords are needed by announcements.
      if (!/^[#(),.%\-\w\s]+$/.test(value)) return;
      out.push(name + ':' + value);
    });
    return out.join(';');
  }
  function safeUrl(raw, image) {
    try {
      var url = new URL(String(raw || ''), 'https://ipkey.vip/');
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      if (image && url.protocol !== 'https:') return '';
      return url.href;
    } catch (e) { return ''; }
  }
  function cleanHtml(raw) {
    var source = String(raw || '');
    if (!source) return '';
    if (!global.DOMParser) return esc(source).replace(/\n/g, '<br>');
    var doc = new DOMParser().parseFromString('<div id="pp-safe-root">' + source + '</div>', 'text/html');
    var root = doc.getElementById('pp-safe-root');
    if (!root) return '';
    function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 3) return;
        if (child.nodeType !== 1) { child.remove(); return; }
        var tag = child.tagName;
        if (!SAFE_TAGS[tag]) {
          // Keep the readable contents of wrappers such as <font> or <article>.
          Array.prototype.slice.call(child.childNodes).forEach(function (grand) { node.insertBefore(grand, child); });
          child.remove();
          walk(node);
          return;
        }
        Array.prototype.slice.call(child.attributes).forEach(function (attr) {
          var name = attr.name.toLowerCase();
          if (name === 'style') {
            var style = safeStyle(attr.value);
            if (style) child.setAttribute('style', style); else child.removeAttribute('style');
          } else if ((name === 'href' || name === 'src') && (tag === 'A' || tag === 'IMG')) {
            var url = safeUrl(attr.value, tag === 'IMG');
            if (url) child.setAttribute(name, url); else child.removeAttribute(name);
          } else if (name === 'alt' || name === 'title' || name === 'width' || name === 'height') {
            // These are display-only attributes; keep them without event handlers.
          } else if (name === 'colspan' || name === 'rowspan') {
            // Table layout attributes are safe.
          } else {
            child.removeAttribute(attr.name);
          }
        });
        if (tag === 'IMG' && !child.getAttribute('src')) {
          child.remove();
          return;
        }
        if (tag === 'A' && !child.getAttribute('href')) {
          Array.prototype.slice.call(child.childNodes).forEach(function (grand) { node.insertBefore(grand, child); });
          child.remove();
          return;
        }
        if (tag === 'A' && child.getAttribute('href')) {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        }
        if (tag === 'IMG') {
          child.setAttribute('loading', 'lazy');
          child.setAttribute('referrerpolicy', 'no-referrer');
        }
        walk(child);
      });
    }
    walk(root);
    // The site editor often uses full-width spaces as bullet indentation. On a
    // phone that reads as ragged lines, so turn lists into real list markup.
    Array.prototype.slice.call(root.querySelectorAll('p')).forEach(function (paragraph) {
      var html = paragraph.innerHTML;
      if (html.indexOf('·') < 0 || html.indexOf('<br>') < 0 || html.indexOf('　　　　') < 0) return;
      var list = doc.createElement('div');
      list.className = 'announcement-list';
      html.split(/<br\s*\/?>/i).forEach(function (line) {
        var item = doc.createElement('div');
        var text = line.trim().replace(/^(?:&nbsp;|\s|　)+/, '');
        if (!text) return;
        text = text.replace(/^<span[^>]*>\s*·\s*<\/span>\s*/i, '');
        if (text.charAt(0) === '·') text = text.slice(1).replace(/^(?:&nbsp;|\s|　)+/, '');
        item.innerHTML = text;
        list.appendChild(item);
      });
      paragraph.parentNode.replaceChild(list, paragraph);
    });
    return root.innerHTML;
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
    if (a < 1) return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
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
  // Spendable balance keeps four decimals so sub-cent movements stay visible.
  function usd(v) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
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
  function datetimeSeconds(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
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
    return String(d.getFullYear()).padStart(4, '0') + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
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
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.26 15a1.65 1.65 0 0 0-1.51-1H2.66a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.26 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.58 4.68H9a1.65 1.65 0 0 0 1-1.51V2.66a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .66.4 1.25 1 1.51h.09a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.5 1Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    send: '<path d="M21 3 10.5 13.5M21 3l-6.5 18-4-8-8-4L21 3Z"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/>',
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
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 7h5a5 5 0 0 1 5 5v-4"/>',
    pin: '<path d="M9 4h6l-1 6 4 3v2H6v-2l4-3-1-6Z"/><path d="M12 15v5"/>',
    users: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c.7-3.4 3.1-5 6.2-5s5.5 1.6 6.2 5"/><path d="M16 5.2a3.2 3.2 0 0 1 0 6.1M18 15.2c2 .6 3.2 2.1 3.7 4.8"/>'
  };
  function ic(name, size) {
    var p = PATHS[name] || '';
    var s = size || 20;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }

  // ---------- toast ----------
  var toastTimer = 0;
  function toast(msg, type) {
    var host = $('.toast-host');
    if (!host) {
      host = el('div', { class: 'toast-host' });
      document.body.appendChild(host);
    }
    Array.prototype.forEach.call(host.children, function (old) {
      if (old.parentNode) old.parentNode.removeChild(old);
    });
    clearTimeout(toastTimer);
    var t = el('div', { class: 'toast ' + (type || ''), text: String(msg) });
    host.appendChild(t);
    toastTimer = setTimeout(function () {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(6px)';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }, type === 'err' ? 3200 : 2100);
  }

  // ---------- overlays ----------
  var overlayStack = [];
  function removeOverlay(close) {
    var index = overlayStack.indexOf(close);
    if (index >= 0) overlayStack.splice(index, 1);
  }
  function closeOverlay() {
    var pending = overlayStack.slice();
    for (var i = pending.length - 1; i >= 0; i--) pending[i]();
    var s = $('.scrim'); if (s) s.parentNode.removeChild(s);
    var sh = $('.sheet'); if (sh) sh.parentNode.removeChild(sh);
  }
  function picker(opts) {
    var previous = document.activeElement;
    var shade = el('div', { class: 'picker-scrim' });
    var box = el('div', { class: 'picker-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title, tabindex: '-1' });
    box.appendChild(el('div', { class: 'picker-heading' }, el('h3', { text: opts.title }),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭选择', html: ic('close', 18), onclick: close })));
    box.appendChild(opts.body);
    if (opts.actions) {
      var actions = el('div', { class: 'picker-actions' });
      opts.actions.forEach(function (a) {
        actions.appendChild(el('button', { type: 'button', class: 'btn ' + (a.kind === 'primary' ? 'btn-primary' : ''), text: a.label,
          onclick: function () { if (a.onClick && a.onClick() === false) return; close(); } }));
      });
      box.appendChild(actions);
    }
    function keydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    }
    function close() {
      document.removeEventListener('keydown', keydown);
      if (shade.parentNode) shade.remove();
      if (box.parentNode) box.remove();
      removeOverlay(close);
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
    }
    overlayStack.push(close);
    shade.addEventListener('click', close);
    document.addEventListener('keydown', keydown);
    document.body.appendChild(shade);
    document.body.appendChild(box);
    box.focus();
    return { close: close, box: box };
  }

  function dateTimeField(opts) {
    var kind = opts.kind;
    var input = el('input', { type: 'text', class: 'picker-input', value: opts.value || '',
      placeholder: kind === 'date' ? 'YYYY-MM-DD' : 'HH:MM', 'aria-label': opts.label,
      inputmode: 'text', autocomplete: 'off', spellcheck: 'false' });
    var field = el('span', { class: 'input picker-field' + (opts.compact ? ' dashboard-date' : '') }, input,
      el('button', { type: 'button', class: 'picker-trigger', 'aria-label': '选择' + opts.label,
        html: ic(kind === 'date' ? 'calendar' : 'clock', 17), onclick: function (event) {
          event.preventDefault();
          if (kind === 'date') openDate(); else openTime();
        } }));
    Object.defineProperty(field, 'value', { get: function () { return input.value; }, set: function (v) { input.value = v; } });

    function openDate() {
      var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.value);
      var selected = match ? input.value : '';
      if (match && Number(match[1]) < 1) match = null;
      var current = new Date();
      if (match) {
        var parsed = new Date(0);
        parsed.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        if (ymd(parsed) === selected) current = parsed;
        else selected = '';
      }
      var year = current.getFullYear(), month = current.getMonth();
      var body = el('div', { class: 'calendar-picker' });
      var dialog;
      function paint() {
        body.innerHTML = '';
        body.appendChild(el('div', { class: 'calendar-head' },
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': '上个月', html: ic('back', 18), onclick: function () {
            if (year === 1 && month === 0) return;
            if (--month < 0) { month = 11; year--; } paint();
          } }),
          el('strong', null, year + ' 年 ' + (month + 1) + ' 月'),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': '下个月', html: ic('chevron', 18), onclick: function () {
            if (year === 9999 && month === 11) return;
            if (++month > 11) { month = 0; year++; } paint();
          } })));
        body.appendChild(el('div', { class: 'calendar-week' }, ['日', '一', '二', '三', '四', '五', '六'].map(function (name) { return el('span', null, name); })));
        var first = new Date(0); first.setFullYear(year, month, 1); first.setHours(0, 0, 0, 0);
        var last = new Date(0); last.setFullYear(year, month + 1, 0);
        var grid = el('div', { class: 'calendar-grid' });
        for (var i = 0; i < first.getDay(); i++) grid.appendChild(el('span'));
        for (var day = 1; day <= last.getDate(); day++) (function (number) {
          var value = String(year).padStart(4, '0') + '-' + pad(month + 1) + '-' + pad(number);
          grid.appendChild(el('button', { type: 'button', class: 'calendar-day' + (value === selected ? ' active' : ''),
            'aria-label': value, 'aria-pressed': value === selected ? 'true' : 'false', onclick: function () {
              input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); dialog.close();
            } }, String(number)));
        })(day);
        body.appendChild(grid);
      }
      paint();
      var actions = [{ label: '今天', onClick: function () { input.value = ymd(new Date()); input.dispatchEvent(new Event('change', { bubbles: true })); } }];
      if (opts.optional) actions.push({ label: '清除', onClick: function () { input.value = ''; input.dispatchEvent(new Event('change', { bubbles: true })); } });
      actions.push({ label: '取消' });
      dialog = picker({ title: opts.label, body: body, actions: actions });
    }

    function openTime() {
      var match = /^(\d{2}):(\d{2})$/.exec(input.value);
      var hour = match && Number(match[1]) < 24 ? Number(match[1]) : 0;
      var minute = match && Number(match[2]) < 60 ? Number(match[2]) : 0;
      var hours = el('div', { class: 'time-column', role: 'listbox', 'aria-label': '小时' });
      var minutes = el('div', { class: 'time-column', role: 'listbox', 'aria-label': '分钟' });
      function paintColumn(host, count, selected, change) {
        host.innerHTML = '';
        for (var i = 0; i < count; i++) (function (n) {
          host.appendChild(el('button', { type: 'button', role: 'option', 'aria-selected': n === selected ? 'true' : 'false',
            class: 'time-option' + (n === selected ? ' active' : ''), onclick: function () { change(n); paint(); } }, pad(n)));
        })(i);
      }
      function paint() {
        var hscroll = hours.scrollTop, mscroll = minutes.scrollTop;
        paintColumn(hours, 24, hour, function (n) { hour = n; });
        paintColumn(minutes, 60, minute, function (n) { minute = n; });
        hours.scrollTop = hscroll; minutes.scrollTop = mscroll;
      }
      paint();
      picker({ title: opts.label, body: el('div', { class: 'time-picker' },
        el('div', null, el('div', { class: 'time-label' }, '小时'), hours),
        el('div', null, el('div', { class: 'time-label' }, '分钟'), minutes)),
        actions: [{ label: '取消' }, { label: '确定', kind: 'primary', onClick: function () {
          input.value = pad(hour) + ':' + pad(minute); input.dispatchEvent(new Event('change', { bubbles: true }));
        } }] });
      hours.scrollTop = Math.max(0, hour * 40 - 80); minutes.scrollTop = Math.max(0, minute * 40 - 80);
    }
    return field;
  }
  function sheet(opts) {
    var previous = document.activeElement;
    var closed = false, scrim = null, box = null;
    function close() {
      if (closed) return;
      closed = true;
      if (scrim && scrim.parentNode) scrim.remove();
      if (box && box.parentNode) box.remove();
      removeOverlay(close);
      if (opts.onClose) opts.onClose();
      if (previous && previous.isConnected && typeof previous.focus === 'function') {
        try { previous.focus({ preventScroll: true }); } catch (e) { try { previous.focus(); } catch (e2) {} }
      }
    }
    scrim = el('div', { class: 'scrim', onclick: close });
    box = el('div', { class: 'sheet' }, [
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
            if (closed) return;
            if (a.onClick) {
              var r = a.onClick();
              if (r === false) return;
            }
            close();
          }
        }));
      });
      box.appendChild(actions);
    }
    document.body.appendChild(scrim);
    document.body.appendChild(box);
    overlayStack.push(close);
    return { close: close, box: box };
  }
  function confirm(title, message, okLabel, danger) {
    return new Promise(function (resolve) {
      sheet({
        title: title,
        body: message && message.nodeType === 1 ? message : el('p', { class: 'small muted', text: message || '', style: { whiteSpace: 'pre-line' } }),
        onClose: function () { resolve(false); },
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

  function overlayItem() {
    return overlayStack.length ? overlayStack[overlayStack.length - 1] : null;
  }

  global.U = {
    el: el, $: $, esc: esc, cleanHtml: cleanHtml, ic: ic, toast: toast, sheet: sheet, confirm: confirm, picker: picker, dateTimeField: dateTimeField,
    closeOverlay: closeOverlay,
    hasOverlay: function () { return !!overlayItem(); },
    closeTop: function () {
      var close = overlayItem();
      if (!close) return false;
      close();
      return true;
    },
    copy: copy, haptic: haptic, sleep: sleep,
    num: num, credits: credits, usd: usd, tokens: tokens, price: price, date: date, datetime: datetime,
    datetimeSeconds: datetimeSeconds,
    ago: ago, maskKey: maskKey, ymd: ymd, pad: pad, store: store
  };
})(window);
