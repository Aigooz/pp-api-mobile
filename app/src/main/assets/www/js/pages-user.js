/* 令牌 / 用量 / 我的 / 兑换 / 充值 / 邀请 */
(function (global) {
  'use strict';
  var U = global.U;
  var C = global.PagesCore;
  var h = C.h, section = C.section, listItem = C.listItem, emptyState = C.emptyState, card = C.card;
  var arrOf = C.arrOf, pick = C.pick, balanceOf = C.balanceOf, open = C.open;
  // Live cards (keys, concurrency, today's usage) share the app-wide 10s balance beat.
  var KEY_LIVE_MS = 10000;

  function needLogin() {
    var box = h('div', { class: 'page' },
      emptyState('请先登录', '登录后即可管理你的账户与令牌', 'lock'),
      h('div', { style: { maxWidth: '320px', margin: '0 auto' } },
        h('button', { class: 'btn btn-primary btn-block', onclick: function () { App.loginEmail = ''; App.go('#/login'); } }, '去登录'),
        Api.AUTH.accounts().length ? h('button', { class: 'btn btn-block', style: { marginTop: '8px' }, onclick: function () { App.go('#/accounts'); } }, '账号管理') : null,
        h('button', { class: 'btn btn-ghost btn-block', style: { marginTop: '8px' }, onclick: function () { App.go('#/register'); } }, '注册新账号')
      )
    );
    return box;
  }

  // ---------------- keys ----------------
  function statusBadge(k) {
    var st = String(k.status || 'active');
    var map = {
      active: ['正常', 'ok'], inactive: ['已停用', ''], disabled: ['已停用', ''],
      expired: ['已过期', 'warn'], quota_exhausted: ['额度用尽', 'danger']
    };
    var m = map[st] || [st, ''];
    return h('span', { class: 'badge ' + m[1] }, m[0]);
  }

  function keyCard(k, reload, account, versionIsCurrent) {
    var quota = Number(pick(k, 'quota', 'total_quota', 'quota_limit') || 0);
    var usedValue = pick(k, 'used_quota', 'quota_used', 'used');
    var used = usedValue === undefined || !isFinite(Number(usedValue)) ? null : Number(usedValue);
    var pct = quota > 0 ? Math.min(100, Math.round(used / quota * 100)) : 0;
    var group = pick(k, 'group_name') || (k.group && k.group.name) ||
      (global.S && global.S.groupNames && global.S.groupNames[k.group_id]) ||
      (k.group_id ? '分组 #' + k.group_id : '默认分组');
    var exp = pick(k, 'expires_at', 'expired_at');

    var concurrency = h('strong');
    function setConcurrency(value) {
      concurrency.textContent = value !== undefined && value !== null && value !== '' && isFinite(Number(value)) && Number(value) >= 0 ? U.num(Number(value)) : '—';
    }
    setConcurrency(pick(k, 'current_concurrency'));
    var stats = h('div', { class: 'key-usage', 'aria-live': 'polite' }, h('span', { class: 'tiny muted' }, '今日用量加载中…'));
    var menu = h('div', { class: 'key-card-menu', hidden: true },
      h('button', { type: 'button', onclick: function () { menu.hidden = true; openKeyEditor(k, reload); } }, h('span', { html: U.ic('edit', 15) }), '编辑令牌'),
      h('button', { type: 'button', onclick: function () {
        menu.hidden = true;
        var next = String(k.status) === 'inactive' ? 'active' : 'inactive';
        Api.keyUpdate(k.id, { status: next }).then(function () {
          U.toast(next === 'active' ? '已启用' : '已停用', 'ok');
          global.dispatchEvent(new CustomEvent('pp:keys-changed'));
          reload();
        }).catch(function (err) { U.toast(err.message, 'err'); });
      } }, h('span', { html: U.ic(String(k.status) === 'inactive' ? 'play' : 'pause', 15) }), String(k.status) === 'inactive' ? '启用令牌' : '暂停令牌'),
      h('button', { class: 'danger', type: 'button', onclick: function () {
        menu.hidden = true;
        U.confirm('删除令牌', '删除后使用该令牌的客户端将立即失效，且不可恢复。', '删除', true).then(function (ok) {
          if (!ok) return;
          Api.keyDelete(k.id).then(function () {
            U.toast('已删除', 'ok');
            global.dispatchEvent(new CustomEvent('pp:keys-changed'));
            reload();
          }).catch(function (err) { U.toast(err.message, 'err'); });
        });
      } }, h('span', { html: U.ic('trash', 15) }), '删除令牌'));
    var menuButton = h('button', { class: 'key-card-more', type: 'button', title: '更多操作', 'aria-label': '更多操作 ' + (k.name || '令牌'),
      html: U.ic('more', 18), onclick: function (event) { event.stopPropagation(); menu.hidden = !menu.hidden; } });
    var children = [
      h('div', { class: 'keycard-top' },
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { class: 'keycard-name nowrap', onclick: function (e) { e.stopPropagation(); openKeyDetail(k); } }, k.name || '未命名令牌', h('span', { class: 'tiny muted', style: { marginLeft: '6px' } }, '›')),
          h('div', { class: 'keycard-key' },
            h('span', { class: 'mono' }, U.maskKey(k.key || '')),
            h('button', {
              class: 'icon-btn key-card-copy',
              html: U.ic('copy', 15),
              onclick: function (e) { e.stopPropagation(); U.copy(k.key || ''); }
            })
          )
        ),
        h('div', { class: 'key-card-tools' }, statusBadge(k), menuButton)
      ),
      menu,
      quota > 0
        ? h('div', null,
            h('div', { class: 'row between', style: { marginBottom: '5px' } },
              h('span', { class: 'tiny muted' }, '额度已用 ' + (used === null ? '—' : '$' + U.credits(used)) + ' / $' + U.credits(quota)),
              h('span', { class: 'tiny muted' }, used === null ? '—' : pct + '%')),
            used === null ? null : h('div', { class: 'progress' + (pct > 90 ? ' danger' : pct > 70 ? ' warn' : '') }, h('i', { style: { width: pct + '%' } })))
        : h('div', { class: 'tiny muted' }, '额度不限 · 额度已用 ' + (used === null ? '—' : '$' + U.credits(used))),
      h('div', { class: 'key-concurrency' }, h('span', null, '当前并发'), concurrency),
      stats,
      h('div', { class: 'meta-grid' },
        h('div', null, '分组', h('b', { class: 'nowrap' }, group)),
        h('div', null, '到期', h('b', null, exp ? U.date(exp) : '永不'))
      )
    ];
    if (String(k.status) !== 'active') children[0].style.opacity = '0.72';
    var node = h('div', { class: 'card', style: { marginBottom: '10px' } }, h('div', { class: 'keycard' }, children));
    function loadStats(silent) {
      var today = U.ymd(new Date());
      var query = { api_key_id: k.id, start_date: today, end_date: today };
      try { query.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
      if (silent !== true) stats.textContent = '今日用量加载中…';
      var request = Number.isSafeInteger(Number(k.id)) && Number(k.id) > 0 ? Api.usageStats(query) : Promise.reject(new Error('令牌信息不完整'));
      return request.then(function (data) {
        if (!Api.AUTH.matches(account) || !versionIsCurrent() || !App.isPageRetained(node)) return;
        var requests = pick(data, 'total_requests', 'requests', 'request_count');
        var tokens = pick(data, 'total_tokens');
        var cost = pick(data, 'total_actual_cost');
        if (requests === undefined || tokens === undefined || cost === undefined ||
            !isFinite(Number(requests)) || !isFinite(Number(tokens)) || !isFinite(Number(cost))) throw new Error('用量数据不完整');
        stats.innerHTML = '';
        stats.appendChild(h('div', { class: 'key-usage-grid' },
          h('span', null, '今日请求', h('b', null, U.num(Number(requests)))),
          h('span', null, '今日 Tokens', h('b', null, U.tokens(Number(tokens)))),
          h('span', null, '今日花费', h('b', null, '$' + U.credits(Number(cost))))));
      }).catch(function () {
        if (!Api.AUTH.matches(account) || !versionIsCurrent() || !App.isPageRetained(node)) return;
        if (silent === true) return;
        stats.innerHTML = '';
        stats.appendChild(h('span', null, '今日用量暂不可用 '));
        stats.appendChild(h('button', { type: 'button', onclick: function () { loadStats(); } }, '重试'));
      });
    }
    return { node: node, id: String(k.id), loadStats: loadStats, setConcurrency: setConcurrency };
  }

  function openKeyDetail(k) {
    var base = Api.V1;
    var curl = 'curl ' + base + '/chat/completions \\\n  -H "Authorization: Bearer ' + (k.key || 'YOUR_KEY') + '" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model":"MODEL","messages":[{"role":"user","content":"Hello"}]}\'';
    var body = h('div', null,
      h('div', { class: 'kv' }, h('span', null, '名称'), h('b', null, k.name || '未命名')),
      h('div', { class: 'kv' }, h('span', null, '状态'), h('b', null, String(k.status || 'active'))),
      h('div', { class: 'kv' }, h('span', null, 'Base URL'), h('b', { class: 'mono', style: { fontSize: '11.5px' } }, base)),
      h('div', { class: 'kv' }, h('span', null, '令牌'), h('b', { class: 'mono', style: { fontSize: '11.5px' } }, k.key || '—')),
      h('div', { class: 'divider' }),
      h('div', { class: 'tiny muted', style: { marginBottom: '6px' } }, 'curl 示例'),
      h('pre', { class: 'mono', style: { background: 'var(--surface-2)', padding: '10px', borderRadius: '10px', fontSize: '10.5px', overflowX: 'auto', whiteSpace: 'pre' } }, curl),
      h('div', { class: 'row', style: { gap: '8px', marginTop: '12px' } },
        h('button', { class: 'btn btn-sm', style: { flex: '1' }, onclick: function () { U.copy(base); } }, '复制 Base URL'),
        h('button', { class: 'btn btn-sm', style: { flex: '1' }, onclick: function () { U.copy(k.key || ''); } }, '复制令牌'),
        h('button', { class: 'btn btn-sm', style: { flex: '1' }, onclick: function () { U.copy(curl); } }, '复制 curl')
      ),
      h('div', { class: 'notice', style: { marginTop: '12px' } }, '兼容 OpenAI / Anthropic 协议，可直接填入 Cherry Studio、ChatBox、Cline 等客户端。')
    );
    U.sheet({ title: '令牌与客户端配置', body: body, actions: [{ label: '关闭' }] });
  }

  function renderKeys() {
    if (!Api.AUTH.isLogged()) return needLogin();
    var page = h('div', { class: 'page' });
    var host = h('div', { style: { marginTop: '10px' } });
    var account = Api.AUTH.context(), requestVersion = 0, concurrencyTimer = null, loadedAt = 0, cards = [];
    var restartLive = null;
    page.appendChild(h('div', { class: 'row between', style: { marginBottom: '4px' } },
      h('div', { class: 'tiny muted' }, '令牌用于调用 API，请勿泄露给他人'),
      h('button', { class: 'btn btn-primary btn-sm', onclick: function () { openKeyEditor(null, reload); } },
        h('span', { html: U.ic('plus', 14) }), '新建')
    ));
    page.appendChild(host);

    function reload(silent) {
      silent = silent === true;
      clearTimeout(concurrencyTimer);
      var version = ++requestVersion;
      function current() { return version === requestVersion && Api.AUTH.matches(account) && App.isPageRetained(page); }
      if (!silent || !loadedAt) {
        host.innerHTML = '';
        host.appendChild(h('div', { class: 'card pad' }, h('div', { class: 'skeleton', style: { height: '60px' } })));
      }
      if (!global.S.groupNames) global.S.groupNames = {};
      Api.groups().then(function (gs) {
        if (!current()) return;
        arrOf(gs).forEach(function (g) { global.S.groupNames[g.id] = g.name; });
      }).catch(function () {});
      Api.keys(1, 100).then(function (d) {
        if (!current()) return;
        var items = arrOf(d);
        global.S.keys = items;
        loadedAt = Date.now();
        global.dispatchEvent(new CustomEvent('pp:keys-updated', { detail: { account: account.id, items: items } }));
        host.innerHTML = '';
        if (!items.length) {
          host.appendChild(emptyState('还没有令牌', '创建一个令牌即可在客户端调用模型', 'key'));
          return;
        }
        cards = items.map(function (k) { return keyCard(k, reload, account, current); });
        cards.forEach(function (item) { host.appendChild(item.node); });
        var next = 0;
        function loadNext() {
          if (!current() || next >= cards.length) return;
          cards[next++].loadStats().then(loadNext);
        }
        for (var i = 0; i < Math.min(4, cards.length); i++) loadNext();
        // Concurrency for every key arrives in one request; per-key usage rotates so a
        // long key list never turns the 10s beat into a burst of calls.
        var statsCursor = 0;
        function refreshLive() {
          if (!current() || !App.isPageActive(page)) return;
          var batch = cards.slice(statsCursor, statsCursor + 3);
          statsCursor = (statsCursor + 3) % Math.max(1, cards.length);
          Promise.all([
            Api.keys(1, 100).then(function (result) {
              if (!current()) return;
              var values = Object.create(null);
              arrOf(result).forEach(function (item) {
                values[String(item.id)] = pick(item, 'current_concurrency');
              });
              cards.forEach(function (item) { item.setConcurrency(values[item.id]); });
            }).catch(function () {
              if (current()) cards.forEach(function (item) { item.setConcurrency(undefined); });
            }),
            Promise.all(batch.map(function (item) { return item.loadStats(true).catch(function () {}); }))
          ]).then(function () {
            if (current() && App.isPageActive(page)) concurrencyTimer = setTimeout(refreshLive, KEY_LIVE_MS);
          });
        }
        restartLive = function () { concurrencyTimer = setTimeout(refreshLive, KEY_LIVE_MS); };
        if (App.isPageActive(page)) restartLive();
        host.appendChild(h('div', { class: 'card', style: { marginTop: '6px' } },
          h('div', { class: 'list-item', onclick: function () { U.copy(Api.V1); } },
            h('span', { class: 'li-icon', html: U.ic('external', 16) }),
            h('div', { class: 'li-body' },
              h('div', { class: 'li-title', style: { fontSize: '13px' } }, 'Base URL'),
              h('div', { class: 'li-sub mono' }, Api.V1)),
            h('div', { class: 'li-tail', html: U.ic('copy', 16) })
          )));
      }).catch(function (e) {
        if (!current()) return;
        if (!silent || !loadedAt) { host.innerHTML = ''; host.appendChild(emptyState('加载失败', e.message, 'alert')); }
      });
    }
    page.addEventListener('pp:page-activate', function () {
      // Re-entering the tab only restarts the 10s live beat; a full reload waits until the
      // cached list is genuinely stale so cached navigation stays instant.
      if (loadedAt && Date.now() - loadedAt >= 30000) reload(true);
      else if (restartLive) { clearTimeout(concurrencyTimer); restartLive(); }
    });
    page.addEventListener('pp:page-deactivate', function () { clearTimeout(concurrencyTimer); });
    page.addEventListener('pp:page-dispose', function () { clearTimeout(concurrencyTimer); requestVersion++; });
    reload();
    return page;
  }

  function openKeyEditor(k, reload) {
    var isEdit = !!k;
    var groups = [], groupsState = 'loading', selectedGroup = k && k.group_id ? String(k.group_id) : '';
    var name = h('input', { class: 'input', placeholder: '例如：我的电脑', value: (k && k.name) || '' });
    var groupText = h('span', { class: 'group-picker-value' }, '正在加载分组…');
    var groupSel = h('button', { type: 'button', class: 'input group-picker-trigger', 'aria-label': '选择分组',
      onclick: openGroups }, groupText, h('span', { html: U.ic('down', 17) }));
    var quota = h('input', { class: 'input', type: 'number', inputmode: 'decimal', placeholder: '不限额度', value: k && k.quota ? String(k.quota) : '' });
    var exp = U.dateTimeField({ kind: 'date', label: '到期时间', optional: true, value: k && k.expires_at ? U.date(k.expires_at) : '' });
    var custom = isEdit ? null : h('input', { class: 'input', placeholder: '留空自动生成（可选）' });

    function groupLabel() {
      var selected = groups.filter(function (g) { return String(g.id) === selectedGroup; })[0];
      groupText.textContent = groupsState === 'loading' ? '正在加载分组…' : groupsState === 'error' ? '加载失败，点击重试' :
        selected ? (selected.name || '分组 ' + selected.id) : selectedGroup ? '原分组不可用，请重新选择' : '请选择分组';
    }
    function loadGroups() {
      groupsState = 'loading'; groupLabel();
      Api.groups().then(function (d) { groups = arrOf(d); groupsState = 'ready'; groupLabel(); })
        .catch(function () { groupsState = 'error'; groupLabel(); });
    }
    function openGroups() {
      if (groupsState === 'loading') return;
      if (groupsState === 'error') { loadGroups(); return; }
      var search = h('input', { class: 'input group-search', type: 'search', placeholder: '搜索分组', 'aria-label': '搜索分组' });
      var list = h('div', { class: 'group-options', role: 'listbox', 'aria-label': '可用分组' });
      var dialog;
      function paintGroups() {
        var query = search.value.trim().toLowerCase();
        var matches = groups.filter(function (g) { return String(g.name || ('分组 ' + g.id)).toLowerCase().indexOf(query) >= 0; });
        list.innerHTML = '';
        if (!matches.length) { list.appendChild(h('div', { class: 'picker-empty' }, groups.length ? '没有找到分组' : '暂无可用分组')); return; }
        matches.forEach(function (g) {
          var chosen = String(g.id) === selectedGroup;
          list.appendChild(h('button', { type: 'button', role: 'option', 'aria-selected': chosen ? 'true' : 'false',
            class: 'group-option' + (chosen ? ' active' : ''), onclick: function () {
              selectedGroup = String(g.id); groupLabel(); dialog.close();
            } }, h('span', null, g.name || ('分组 ' + g.id)), chosen ? h('span', { html: U.ic('check', 17) }) : null));
        });
      }
      search.addEventListener('input', paintGroups);
      paintGroups();
      dialog = U.picker({ title: '选择分组', body: h('div', null, search, list), actions: [{ label: '取消' }] });
    }
    loadGroups();

    var body = h('div', null,
      h('div', { class: 'field' }, h('label', null, '名称'), name),
      h('div', { class: 'field' }, h('label', null, '分组'), groupSel),
      h('div', { class: 'field' }, h('label', null, '额度（美元，留空不限）'), quota),
      h('div', { class: 'field' }, h('label', null, '到期时间（可选）'), exp),
      custom ? h('div', { class: 'field' }, h('label', null, '自定义令牌（可选）'), custom) : null
    );

    U.sheet({
      title: isEdit ? '编辑令牌' : '新建令牌',
      body: body,
      actions: [
        { label: '取消' },
        {
          label: isEdit ? '保存' : '创建',
          kind: 'primary',
          onClick: function () {
            if (!name.value.trim()) { U.toast('请填写名称', 'err'); return false; }
            if (groupsState !== 'ready' || !groups.some(function (g) { return String(g.id) === selectedGroup; })) { U.toast('请选择可用分组', 'err'); return false; }
            var payload = { name: name.value.trim() };
            payload.group_id = Number(selectedGroup);
            var qv = Number(quota.value);
            if (quota.value !== '' && isFinite(qv) && qv > 0) payload.quota = qv;
            if (exp.value) {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(exp.value)) { U.toast('请输入有效的到期日期', 'err'); return false; }
              var when = new Date(exp.value + 'T23:59:59');
              if (isNaN(when.getTime()) || U.ymd(when) !== exp.value) { U.toast('请输入有效的到期日期', 'err'); return false; }
              if (isEdit) {
                payload.expires_at = when.toISOString();
              } else {
                payload.expires_in_days = Math.max(1, Math.ceil((when.getTime() - Date.now()) / 86400000));
              }
            } else if (isEdit && k.expires_at) payload.expires_at = '';
            if (custom && custom.value.trim()) payload.custom_key = custom.value.trim();
            var p = isEdit ? Api.keyUpdate(k.id, payload) : Api.keyCreate(payload);
            p.then(function (d) {
              global.dispatchEvent(new CustomEvent('pp:keys-changed'));
              if (!isEdit && d && d.key) {
                U.sheet({
                  title: '令牌创建成功',
                  body: h('div', null,
                    h('p', { class: 'small muted' }, '请立即复制保存，之后页面仅显示掩码。'),
                    h('div', { class: 'card pad mono small', style: { wordBreak: 'break-all' } }, d.key)),
                  actions: [
                    { label: '复制', onClick: function () { U.copy(d.key); } },
                    { label: '完成', kind: 'primary', onClick: function () {} }
                  ]
                });
              } else {
                U.toast(isEdit ? '已保存' : '已创建', 'ok');
              }
              if (reload) reload();
            }).catch(function (e) { U.toast(e.message, 'err'); });
            return true;
          }
        }
      ]
    });
  }

  // ---------------- usage ----------------
  function usageMetric(label, value, hint, tone) {
    return h('div', { class: 'usage-metric' + (tone ? ' ' + tone : '') },
      h('span', null, label), h('strong', null, value), hint ? h('small', null, hint) : null);
  }

  function usageCurrency(value) {
    var n = Math.max(0, Number(value) || 0);
    if (n === 0) return '$0';
    if (n < 0.01) return '$' + n.toPrecision(3);
    if (n < 100) return '$' + n.toFixed(2);
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function usageTrendChart(list) {
    var rows = list.map(function (item) {
      return {
        date: String(pick(item, 'date', 'day', 'bucket') || ''),
        value: Number(pick(item, 'actual_cost', 'cost', 'total_cost', 'credits', 'value') || 0),
        tokens: Number(pick(item, 'total_tokens', 'tokens') || 0)
      };
    });
    var rawMax = Math.max.apply(null, rows.map(function (row) { return row.value; }).concat([0]));
    var magnitude = Math.pow(10, Math.floor(Math.log(Math.max(rawMax, 0.000001)) / Math.LN10));
    var scale = rawMax / magnitude;
    var max = (scale <= 1 ? 1 : scale <= 2 ? 2 : scale <= 5 ? 5 : 10) * magnitude;
    var steps = [1, .75, .5, .25, 0];
    var left = 45, right = 10, top = 12, bottom = 28, width = 320, height = 176;
    var plotWidth = width - left - right, plotHeight = height - top - bottom;
    var baseline = top + plotHeight;
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('class', 'usage-trend-svg');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', '所选时段消耗趋势');
    var gradientId = 'usage-trend-fill-' + String(Date.now()) + '-' + String(Math.random()).slice(2);
    var defs = document.createElementNS(NS, 'defs');
    var gradient = document.createElementNS(NS, 'linearGradient');
    gradient.setAttribute('id', gradientId);
    gradient.setAttribute('x1', '0'); gradient.setAttribute('y1', '0');
    gradient.setAttribute('x2', '0'); gradient.setAttribute('y2', '1');
    var topStop = document.createElementNS(NS, 'stop');
    topStop.setAttribute('offset', '0%'); topStop.setAttribute('stop-color', '#4f7cf7'); topStop.setAttribute('stop-opacity', '.32');
    var bottomStop = document.createElementNS(NS, 'stop');
    bottomStop.setAttribute('offset', '100%'); bottomStop.setAttribute('stop-color', '#4f7cf7'); bottomStop.setAttribute('stop-opacity', '0');
    gradient.appendChild(topStop); gradient.appendChild(bottomStop); defs.appendChild(gradient); svg.appendChild(defs);
    steps.forEach(function (step) {
      var y = top + plotHeight * (1 - step);
      var line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(left)); line.setAttribute('x2', String(left + plotWidth));
      line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
      line.setAttribute('class', step === 0 ? 'usage-trend-baseline' : 'usage-trend-grid');
      svg.appendChild(line);
      var label = document.createElementNS(NS, 'text');
      label.setAttribute('x', String(left - 8)); label.setAttribute('y', String(y + 3.5));
      label.setAttribute('text-anchor', 'end'); label.setAttribute('class', 'usage-trend-y-label');
      label.textContent = usageCurrency(max * step);
      svg.appendChild(label);
    });
    if (!rows.length) return svg;
    function xAt(index) { return rows.length === 1 ? left + plotWidth / 2 : left + index * plotWidth / (rows.length - 1); }
    function yAt(row) { return top + plotHeight - Math.min(1, Math.max(0, row.value) / max) * plotHeight; }
    var linePoints = rows.map(function (row, index) { return xAt(index).toFixed(2) + ',' + yAt(row).toFixed(2); });
    var area = 'M' + left + ' ' + baseline + ' ' + rows.map(function (row, index) {
      return 'L' + xAt(index).toFixed(2) + ' ' + yAt(row).toFixed(2);
    }).join(' ') + ' L' + (left + plotWidth) + ' ' + baseline + ' Z';
    var fill = document.createElementNS(NS, 'path');
    fill.setAttribute('d', area); fill.setAttribute('fill', 'url(#' + gradientId + ')');
    svg.appendChild(fill);
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', rows.map(function (row, index) { return (index ? 'L' : 'M') + xAt(index).toFixed(2) + ' ' + yAt(row).toFixed(2); }).join(' '));
    path.setAttribute('class', 'usage-trend-line');
    svg.appendChild(path);
    var guide = document.createElementNS(NS, 'line');
    guide.setAttribute('class', 'usage-trend-guide'); guide.style.display = 'none';
    svg.appendChild(guide);
    var active = document.createElementNS(NS, 'circle');
    active.setAttribute('r', '4.5'); active.setAttribute('class', 'usage-trend-active'); active.style.display = 'none';
    svg.appendChild(active);
    var tip = document.createElementNS(NS, 'g');
    tip.setAttribute('class', 'usage-trend-tip'); tip.style.display = 'none';
    var tipBox = document.createElementNS(NS, 'rect');
    tipBox.setAttribute('height', '38'); tipBox.setAttribute('rx', '7');
    var tipDate = document.createElementNS(NS, 'text');
    tipDate.setAttribute('x', '9'); tipDate.setAttribute('y', '15'); tipDate.setAttribute('class', 'usage-trend-tip-date');
    var tipValue = document.createElementNS(NS, 'text');
    tipValue.setAttribute('x', '9'); tipValue.setAttribute('y', '30'); tipValue.setAttribute('class', 'usage-trend-tip-value');
    tip.appendChild(tipBox); tip.appendChild(tipDate); tip.appendChild(tipValue); svg.appendChild(tip);
    var lastIndex = -1;
    function activate(event) {
      var rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      var pointer = event.touches && event.touches[0] ? event.touches[0] : event;
      var chartX = (pointer.clientX - rect.left) * width / rect.width;
      var index = rows.length === 1 ? 0 : Math.round((chartX - left) / plotWidth * (rows.length - 1));
      index = Math.max(0, Math.min(rows.length - 1, index));
      if (index === lastIndex && guide.style.display !== 'none') return;
      lastIndex = index;
      var row = rows[index], x = xAt(index), y = yAt(row);
      guide.style.display = '';
      guide.setAttribute('x1', String(x)); guide.setAttribute('x2', String(x));
      guide.setAttribute('y1', String(top)); guide.setAttribute('y2', String(baseline));
      active.style.display = '';
      active.setAttribute('cx', String(x)); active.setAttribute('cy', String(y));
      var boxWidth = Math.min(148, Math.max(94, row.date.length * 6 + 18));
      var boxX = Math.max(left, Math.min(left + plotWidth - boxWidth, x - boxWidth / 2));
      tip.style.display = '';
      tipBox.setAttribute('x', String(boxX)); tipBox.setAttribute('y', '2');
      tipBox.setAttribute('width', String(boxWidth));
      tipDate.setAttribute('x', String(boxX + 8));
      tipValue.setAttribute('x', String(boxX + 8));
      tipDate.textContent = U.date(row.date) || row.date;
      tipValue.textContent = usageCurrency(row.value) + (row.tokens ? ' · ' + U.tokens(row.tokens) : '');
      svg.setAttribute('aria-label', row.date + ' 消耗 ' + usageCurrency(row.value));
    }
    function hide() {
      lastIndex = -1; guide.style.display = 'none'; active.style.display = 'none'; tip.style.display = 'none';
      svg.setAttribute('aria-label', '所选时段消耗趋势');
    }
    svg.addEventListener('pointermove', activate);
    svg.addEventListener('pointerdown', activate);
    svg.addEventListener('pointerup', hide);
    svg.addEventListener('pointercancel', hide);
    svg.addEventListener('pointerleave', hide);
    rows.forEach(function (row, index) {
      var focus = document.createElementNS(NS, 'circle');
      focus.setAttribute('cx', String(xAt(index))); focus.setAttribute('cy', String(yAt(row)));
      focus.setAttribute('r', '9'); focus.setAttribute('class', 'usage-trend-hit');
      var dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', String(xAt(index))); dot.setAttribute('cy', String(yAt(row)));
      dot.setAttribute('r', '2.6'); dot.setAttribute('class', 'usage-trend-dot');
      svg.appendChild(dot);
      focus.addEventListener('pointerenter', function () {
        var rect = svg.getBoundingClientRect();
        activate({ clientX: xAt(index) / width * rect.width + rect.left });
      });
      svg.appendChild(focus);
    });
    svg.setAttribute('data-points', linePoints.join(' '));
    return svg;
  }

  function renderUsage() {
    if (!Api.AUTH.isLogged()) return needLogin();
    var page = h('div', { class: 'page' });
    var range = global.S.usageRange || 'today';
    var statusFilter = 'all';
    var searchFilter = '';
    var statsHost = h('div', { class: 'section' });
    var trendHost = h('div', { class: 'section' });
    var modelHost = h('div', { class: 'section' });
    var logsHost = h('div', { class: 'section' });
    var end = new Date(), start = new Date();
    start.setDate(end.getDate() - (range === '7d' ? 6 : range === '30d' ? 29 : 0));
    var startInput = U.dateTimeField({ kind: 'date', compact: true, value: U.ymd(start), label: '开始日期' });
    var endInput = U.dateTimeField({ kind: 'date', compact: true, value: U.ymd(end), label: '结束日期' });
    var startTime = U.dateTimeField({ kind: 'time', compact: true, value: '00:00', label: '开始时间' });
    var endTime = U.dateTimeField({ kind: 'time', compact: true, value: '23:59', label: '结束时间' });
    var requestVersion = 0;
    var seg = h('div', { class: 'seg usage-range-seg' }, [
      { k: 'today', t: '今日' }, { k: '7d', t: '近 7 天' }, { k: '30d', t: '近 30 天' }
    ].map(function (o) {
      return h('button', {
        class: range === o.k ? 'active' : '',
        onclick: function () {
          range = o.k; global.S.usageRange = o.k;
          Array.prototype.forEach.call(seg.children, function (b) { b.className = ''; });
          this.className = 'active';
          var last = new Date(), first = new Date();
          first.setDate(last.getDate() - (range === '7d' ? 6 : range === '30d' ? 29 : 0));
          startInput.value = U.ymd(first); endInput.value = U.ymd(last);
          startTime.value = '00:00'; endTime.value = '23:59';
          load();
        }
      }, o.t);
    }));

    var timeButton = h('button', { class: 'icon-btn usage-time-icon', type: 'button', title: '自定义时间', 'aria-label': '自定义时间', html: U.ic('calendar', 18),
      onclick: function () {
        var advanced = page.querySelector('.usage-advanced');
        if (!advanced) return;
        advanced.hidden = !advanced.hidden;
        timeButton.classList.toggle('active', !advanced.hidden);
        if (!advanced.hidden) {
          var firstField = advanced.querySelector('.picker-input');
          if (firstField) setTimeout(function () { firstField.focus(); }, 60);
        }
      } });
    page.appendChild(h('div', { class: 'usage-toolbar' }, seg,
      timeButton));
    page.appendChild(h('div', { class: 'dashboard-controls section usage-advanced', hidden: true },
      h('div', { class: 'dashboard-date-row' }, h('label', null, '开始日期', startInput), h('label', null, '结束日期', endInput)),
      h('div', { class: 'dashboard-date-row dashboard-time-row' }, h('label', null, '开始时间', startTime), h('label', null, '结束时间', endTime)),
      h('div', { class: 'dashboard-control-row' }, h('span', { class: 'tiny muted' }, '本地时间，包含结束分钟'),
        h('button', { class: 'btn btn-sm', onclick: function () {
          Array.prototype.forEach.call(seg.children, function (b) { b.className = ''; });
          load();
        } }, '应用时间'))));
    page.appendChild(statsHost);
    var search = h('input', { class: 'input usage-search', type: 'search', placeholder: '搜索模型或令牌', 'aria-label': '搜索调用记录',
      oninput: function (event) { searchFilter = event.target.value.trim().toLowerCase(); if (logsHost._logs) renderLogs(logsHost._logs); } });
    var logTools = h('div', { class: 'usage-log-tools' },
      h('div', { class: 'usage-log-tools-head' }, h('div', null, h('strong', null, '调用记录'), h('span', null, '按请求查看 Token、耗时与费用')),
        h('div', { class: 'usage-status-seg', role: 'group', 'aria-label': '调用状态' },
          [{ k: 'all', t: '全部' }, { k: 'success', t: '成功' }, { k: 'error', t: '异常' }].map(function (item) {
            return h('button', { class: item.k === statusFilter ? 'active' : '', onclick: function (event) {
              statusFilter = item.k;
              Array.prototype.forEach.call(event.currentTarget.parentNode.children, function (button) { button.className = button === event.currentTarget ? 'active' : ''; });
              if (logsHost._logs) renderLogs(logsHost._logs);
            } }, item.t);
          }))),
      search);
    page.appendChild(trendHost);
    page.appendChild(modelHost);
    page.appendChild(section(null, null, null, logTools));
    page.appendChild(logsHost);

    function load() {
      var version = ++requestVersion, selected;
      try { selected = global.UsageAnalysis.parseRange(startInput.value, startTime.value, endInput.value, endTime.value); }
      catch (error) { U.toast(error.message, 'err'); return; }
      var q = { start_date: selected.startDate, end_date: selected.endDate };
      var precise = selected.wholeDays ? null : global.UsageAnalysis.fetchRecords(selected).then(function (records) {
        return global.UsageAnalysis.aggregate(records, 'day');
      });
      statsHost.innerHTML = '';
      trendHost.innerHTML = ''; modelHost.innerHTML = ''; logsHost.innerHTML = '';
      statsHost.appendChild(h('div', { class: 'grid-2' },
        h('div', { class: 'card stat' }, h('b', { class: 'skeleton', style: { height: '22px', width: '50px', display: 'block' } }), h('span', null, '花费')),
        h('div', { class: 'card stat' }, h('b', { class: 'skeleton', style: { height: '22px', width: '50px', display: 'block' } }), h('span', null, '请求'))
      ));

      (precise ? precise.then(function (data) { return data.stats; }) : Api.usageStats(q)).then(function (d) {
        if (version !== requestVersion) return;
        var st = d || {};
        if (st.data && typeof st.data === 'object') st = st.data;
        if (st.stats && typeof st.stats === 'object') st = st.stats;
        var cost = Number(pick(st, 'total_actual_cost', 'total_cost', 'cost', 'credits_used', 'spend') || 0);
        var reqs = Number(pick(st, 'requests', 'request_count', 'total_requests', 'count') || 0);
        var inTok = Number(pick(st, 'total_input_tokens', 'input_tokens', 'prompt_tokens') || 0);
        var outTok = Number(pick(st, 'total_output_tokens', 'output_tokens', 'completion_tokens') || 0);
        var quality = global.UsageAnalysis.values(st);
        var requests = Number(pick(st, 'total_requests', 'requests', 'request_count') || 0);
        var errors = pick(st, 'total_errors', 'error_count', 'failed_requests');
        var errorCount = errors === undefined || errors === null || errors === '' ? quality.errors : Number(errors);
        var successRate = pick(st, 'success_rate', 'request_success_rate');
        if (successRate !== undefined && successRate !== null && Number(successRate) <= 1) successRate = Number(successRate) * 100;
        var cacheRead = Number(pick(st, 'total_cache_read_tokens', 'cache_read_tokens') || 0);
        var cacheWrite = Number(pick(st, 'total_cache_creation_tokens', 'cache_creation_tokens') || 0);
        var cacheRate = pick(st, 'cache_hit_rate', 'cache_rate');
        if (cacheRate !== undefined && cacheRate !== null && Number(cacheRate) <= 1) cacheRate = Number(cacheRate) * 100;
        if (cacheRate === undefined || cacheRate === null || !isFinite(Number(cacheRate))) {
          var cacheBase = inTok + cacheWrite + cacheRead;
          cacheRate = cacheBase > 0 ? cacheRead / cacheBase * 100 : null;
        }
        if (successRate === undefined || successRate === null || !isFinite(Number(successRate))) {
          successRate = errorCount !== null && errorCount !== undefined && requests > 0 ? Math.max(0, (requests - Number(errorCount)) / requests * 100) : null;
        }
        statsHost.innerHTML = '';
        statsHost.appendChild(h('div', { class: 'usage-summary card' },
          h('div', { class: 'usage-summary-head' }, h('div', null, h('span', { class: 'dashboard-eyebrow' }, '时段概览'),
            h('strong', null, '从 ' + selected.startDate + ' 开始')),
            h('span', { class: 'usage-summary-updated' }, '本地时间')),
          h('div', { class: 'usage-summary-lead' },
            usageMetric('花费', '$' + U.credits(cost), selected.wholeDays ? '按日汇总' : '精确到分钟', 'primary'),
            usageMetric('请求数', U.num(reqs), '调用总量')),
          h('div', { class: 'usage-metric-grid' },
            usageMetric('输入 tokens', U.tokens(inTok), '请求输入'),
            usageMetric('输出 tokens', U.tokens(outTok), '模型输出'),
            usageMetric('成功率', successRate === null || successRate === undefined ? '未知' : Number(successRate).toFixed(1) + '%', errorCount == null ? '状态统计中' : U.num(Number(errorCount)) + ' 个异常', 'success'),
            usageMetric('缓存命中率', cacheRate === null || cacheRate === undefined ? '未知' : Number(cacheRate).toFixed(1) + '%', '缓存读取占比'))));
      }).catch(function (error) {
        if (version !== requestVersion) return;
        statsHost.innerHTML = '';
        statsHost.appendChild(h('div', { class: 'notice warn' }, error.message || '用量统计暂不可用'));
      });

      var tq = Object.assign({}, q);
      tq.granularity = 'day';
      (precise ? precise.then(function (data) { return { trend: data.trend }; }) : Api.usageTrend(tq)).then(function (d) {
        if (version !== requestVersion) return;
        var list = arrOf(d);
        if (!list.length && d && Array.isArray(d.series)) list = d.series;
        if (!list.length && d && Array.isArray(d.dates)) {
          var costs = d.costs || d.values || d.cost || [];
          list = d.dates.map(function (dt, i) { return { date: dt, cost: Number(costs[i] || 0) }; });
        }
        if (!list.length && d && Array.isArray(d.trend)) list = d.trend;
        if (!list.length && d && typeof d === 'object') {
          var keys = Object.keys(d).filter(function (k) { return Array.isArray(d[k]); });
          if (keys.length) list = d[keys[0]];
        }
        if (!list.length) { trendHost.innerHTML = ''; return; }
        trendHost.innerHTML = '';
        var vals = list.map(function (x) { return Number(pick(x, 'actual_cost', 'cost', 'total_cost', 'credits', 'value') || 0); });
        var max = Math.max.apply(null, vals.concat([0.000001]));
        trendHost.appendChild(section('消耗趋势', null, null, h('div', { class: 'usage-chart-card card' },
          h('div', { class: 'usage-chart-head' }, h('strong', null, '时段消耗'),
            h('span', null, '峰值 $' + U.price(max))),
          usageTrendChart(list),
          h('div', { class: 'usage-chart-axis' },
            h('span', null, U.date(pick(list[0], 'date', 'day', 'bucket')) || ''),
            h('span', null, U.date(pick(list[list.length - 1], 'date', 'day', 'bucket')) || '')))));
      }).catch(function (error) { if (version === requestVersion && !precise) trendHost.appendChild(h('div', { class: 'notice warn' }, error.message || '趋势加载失败')); });

      (precise ? precise.then(function (data) { return { models: data.models }; }) : Api.usageModels(q)).then(function (d) {
        if (version !== requestVersion) return;
        var list = d && Array.isArray(d.models) ? d.models : arrOf(d);
        if (!list.length) { modelHost.innerHTML = ''; return; }
        list.sort(function (a, b) { return Number(pick(b, 'actual_cost', 'total_cost', 'cost') || 0) - Number(pick(a, 'actual_cost', 'total_cost', 'cost') || 0); });
        var top = list.slice(0, 8);
        var totalCost = list.reduce(function (sum, item) { return sum + Number(pick(item, 'actual_cost', 'total_cost', 'cost') || 0); }, 0);
        modelHost.innerHTML = '';
        modelHost.appendChild(section('模型消耗', list.length > top.length ? '共 ' + list.length + ' 个模型' : null, null,
          h('div', { class: 'usage-model-list card' }, top.map(function (m) {
            var cost = Number(pick(m, 'actual_cost', 'total_cost', 'cost') || 0);
            var reqs = Number(pick(m, 'requests', 'request_count', 'count') || 0);
            var share = totalCost > 0 ? cost / totalCost * 100 : 0;
            return h('div', { class: 'usage-model-row' },
              h('div', { class: 'model-avatar' }, String(pick(m, 'model', 'name') || '?').slice(0, 2)),
              h('div', { class: 'usage-model-main' },
                h('div', { class: 'row between' }, h('strong', { class: 'usage-model-name nowrap' }, pick(m, 'model', 'name') || '未知模型'),
                  h('b', null, '$' + U.credits(cost))),
                h('div', { class: 'usage-model-meta' }, h('span', null, U.num(reqs) + ' 次请求'), h('span', null, share.toFixed(1) + '% 花费')),
                h('div', { class: 'progress' }, h('i', { style: { width: Math.max(2, share) + '%' } }))
              )
            );
          })
        )));
      }).catch(function (error) { if (version === requestVersion && !precise) modelHost.appendChild(h('div', { class: 'notice warn' }, error.message || '模型统计加载失败')); });

      function renderLogs(list) {
        logsHost._logs = list;
        var visible = list.filter(function (log) {
          var bad = global.UsageAnalysis.isErrorRecord(log);
          if (statusFilter === 'success' && bad || statusFilter === 'error' && !bad) return false;
          if (!searchFilter) return true;
          var model = String(pick(log, 'model', 'model_name') || '').toLowerCase();
          var token = String(pick(log, 'api_key_name') || (log.api_key && log.api_key.name) || '').toLowerCase();
          return (model + ' ' + token).indexOf(searchFilter) >= 0;
        });
        logsHost.innerHTML = '';
        if (!visible.length) {
          logsHost.appendChild(emptyState('没有符合条件的记录', searchFilter || statusFilter !== 'all' ? '试试切换状态或清空搜索' : '发起调用后会显示在这里', 'chart'));
          return;
        }
        logsHost.appendChild(h('div', { class: 'usage-log-list card' }, visible.map(function (log) {
          var bad = global.UsageAnalysis.isErrorRecord(log);
          var tok = global.UsageAnalysis.tokenBreakdown(log);
          var lat = global.UsageAnalysis.latency(log);
          return h('div', { class: 'usage-log-item' },
            h('div', { class: 'usage-log-top' },
              h('span', { class: 'usage-log-state ' + (bad ? 'error' : 'ok') }),
              h('div', { class: 'usage-log-main' },
                h('div', { class: 'usage-log-title' }, h('strong', { class: 'nowrap' }, pick(log, 'model', 'model_name') || '请求'),
                  h('b', null, '$' + U.price(Number(pick(log, 'actual_cost', 'total_cost', 'cost') || 0)))),
                h('div', { class: 'usage-log-sub' }, U.datetime(pick(log, 'created_at', 'timestamp', 'time')) +
                  (log.group && log.group.name ? ' · ' + log.group.name : (log['group.name'] ? ' · ' + log['group.name'] : '')) +
                  (log.api_key && log.api_key.name ? ' · ' + log.api_key.name : '')))),
            h('div', { class: 'usage-token-strip' },
              h('span', null, '输入 ', h('b', null, U.tokens(tok.input))),
              h('span', null, '输出 ', h('b', null, U.tokens(tok.output))),
              h('span', null, '缓存 ', h('b', null, U.tokens(tok.cache))),
              h('span', { class: 'usage-token-total' }, '总计 ', h('b', null, U.tokens(tok.total)))),
            lat ? h('div', { class: 'usage-latency-strip' },
              h('span', null, '首字 ', h('b', null, global.UsageAnalysis.ms(lat.first))),
              h('span', null, '总耗时 ', h('b', null, global.UsageAnalysis.ms(lat.total))),
              lat.tps ? h('span', null, '输出 ', h('b', null, lat.tps.toFixed(1) + ' tok/s')) : null) : null);
        })));
      }
      (precise ? precise.then(function (data) { return data.records.slice(0, 100); }) : Api.usageLogs(Object.assign({ page: 1, page_size: 100 }, q))).then(function (d) {
        if (version !== requestVersion) return;
        renderLogs(arrOf(d));
      }).catch(function (error) { if (version === requestVersion && !precise) logsHost.appendChild(h('div', { class: 'notice warn' }, error.message || '调用记录加载失败')); });
    }
    load();
    return page;
  }

  // ---------------- me ----------------
  function renderMe() {
    if (!Api.AUTH.isLogged()) {
      var guestPage = needLogin();
      guestPage.appendChild(h('div', { class: 'section' }, h('div', { class: 'list' },
        listItem('sparkle', '主题外观', '浅色、深色与多种配色', null, function () { global.AppTheme.open(); }),
        listItem('refresh', '立即刷新', '同步账户余额、公告与模型目录', null, function () { manualRefresh(); }),
        listItem('refresh', '软件更新', '检查新版本与更新通知', null, function () { App.go('#/updates'); }),
        listItem('doc', '关于 Pp API', '版本、条款与联系方式', null, function () { App.go('#/about'); })
      )));
      return guestPage;
    }
    var page = h('div', { class: 'page' });
    var u = global.S.user || Api.AUTH.user() || {};
    var email = pick(u, 'email', 'username') || '—';
    var displayName = pick(u, 'name', 'display_name', 'nickname') || String(email).split('@')[0] || 'Pp 用户';
    var role = pick(u, 'role', 'user_role') || '';
    var roleText = /admin/.test(String(role)) ? '管理员' : (/observer/.test(String(role)) ? '观察者' : '用户');
    var savedAccounts = Api.AUTH.accounts();

    var balanceBadge = h('span', { class: 'badge teal' }, '$' + U.usd(balanceOf(u)));
    var profileCard = h('section', { class: 'me-profile-card' },
      h('button', { class: 'me-profile-main', type: 'button', onclick: function () { App.go('#/profile'); } },
        h('span', { class: 'me-avatar' }, String(displayName || email).slice(0, 1).toUpperCase()),
        h('span', { class: 'me-profile-copy' },
          h('strong', { class: 'nowrap' }, displayName),
          h('span', { class: 'nowrap' }, email),
          h('small', null, 'ID ' + (pick(u, 'id', 'user_id') || '—') + ' · ' + roleText + (savedAccounts.length > 1 ? ' · ' + savedAccounts.length + ' 个账号' : ''))),
        h('span', { class: 'me-profile-chevron', html: U.ic('chevron', 17) })),
      h('div', { class: 'me-wallet-row' },
        h('button', { class: 'me-wallet-main', type: 'button', onclick: function () { App.go('#/purchase'); } },
          h('span', null, '可用余额'), balanceBadge),
        h('button', { class: 'me-account-switch', type: 'button', onclick: function () {
          App.go(savedAccounts.length > 1 ? '#/accounts' : '#/profile');
        } },
          h('span', { html: U.ic(savedAccounts.length > 1 ? 'users' : 'user', 16) }),
          savedAccounts.length > 1 ? '切换账号' : '个人资料'))
    );
    page.appendChild(profileCard);

    page.appendChild(h('div', { class: 'me-action-grid' }, [
      { icon: 'card', label: '充值', sub: '余额与套餐', path: '#/purchase' },
      { icon: 'gift', label: '兑换', sub: '兑换码', path: '#/redeem' },
      { icon: 'chart', label: '订阅', sub: '生效中的套餐', path: '#/subscriptions' },
      { icon: 'doc', label: '订单', sub: '支付记录', path: '#/orders' }
    ].map(function (item) {
      return h('button', { class: 'me-action', type: 'button', onclick: function () { App.go(item.path); } },
      h('span', { class: 'me-action-icon', html: U.ic(item.icon, 18) }),
      h('span', { class: 'me-action-copy' }, h('strong', null, item.label), h('small', null, item.sub)));
    })));

    page.appendChild(h('div', { class: 'section me-section' },
      h('div', { class: 'me-section-label' }, '账户服务'),
      h('div', { class: 'list' },
        listItem('key', '我的令牌', '创建、并发与用量', null, function () { App.go('#/keys'); }),
        listItem('chart', '用量明细', '调用记录与消耗趋势', null, function () { App.go('#/usage'); }),
        listItem('card', '订阅与订单', savedAccounts.length > 1 ? '管理套餐、充值与多账号' : '管理套餐与充值记录', null, function () { App.go('#/purchase'); }),
        listItem('users', '邀请返利', '邀请好友获得返利', null, function () { App.go('#/affiliate'); })
      )));

    page.appendChild(h('div', { class: 'section me-section' },
      h('div', { class: 'me-section-label' }, '账户与应用'),
      h('div', { class: 'list' },
        listItem('users', '账号管理', savedAccounts.length > 1 ? savedAccounts.length + ' 个账号可快速切换' : '添加账号、记住密码', null, function () { App.go('#/accounts'); }),
        listItem('user', '个人资料', '昵称、邮箱与账户信息', null, function () { App.go('#/profile'); }),
        listItem('sparkle', '主题外观', '11 种主题与明暗模式', null, function () { global.AppTheme.open(); }),
        listItem('lock', '修改密码', '定期更换更安全', null, function () { openPasswordSheet(); }),
        listItem('refresh', '软件更新', '检查新版本与更新通知', null, function () { App.go('#/updates'); })
      )));

    page.appendChild(h('div', { class: 'section me-section' },
      h('div', { class: 'me-section-label' }, '更多'),
      h('div', { class: 'list' },
        listItem('refresh', '立即刷新', '同步余额、模型、令牌与实时状态', null, function () { manualRefresh(); }),
        listItem('refresh', '清除本地缓存', '重新拉取模型与公告', null, function () {
          Api.clearCache();
          U.toast('已清除', 'ok');
        }),
        listItem('doc', '关于 Pp API', '版本、条款与联系方式', null, function () { App.go('#/about'); }),
        listItem('external', '访问官网', '在浏览器中打开 ipkey.vip', null, function () { C.open(Api.ORIGIN); })
      )));

    page.appendChild(h('div', { class: 'section me-logout' },
      h('button', {
        class: 'btn btn-block btn-danger',
        onclick: function () {
          U.confirm('退出当前账号', '退出后此账号需要重新登录，其他账号不受影响。', '退出', true).then(function (ok) {
            if (!ok) return;
            var pending = Api.logout();
            App.refreshPublic();
            App.go('#/accounts', true);
            pending.then(function (result) {
              if (result.saved) U.toast('已退出当前账号', 'ok');
              else U.toast('安全存储写入失败，退出状态可能不会在重启后保留。', 'err');
            });
          });
        }
      }, '退出登录')));

    page.appendChild(h('div', { class: 'footer-note' }, 'Pp API ' + (global.Updates ? global.Updates.version() : '1.0.0')));
    function updateUser() {
      if (App.isPageRetained(page)) {
        balanceBadge.textContent = '$' + U.usd(balanceOf(global.S.user || Api.AUTH.user() || {}));
        var next = global.S.user || Api.AUTH.user() || {};
        var nextEmail = pick(next, 'email', 'username') || '—';
        var nextName = pick(next, 'name', 'display_name', 'nickname') || String(nextEmail).split('@')[0] || 'Pp 用户';
        var heading = profileCard.querySelector('.me-profile-copy strong');
        var address = profileCard.querySelector('.me-profile-copy > span');
        if (heading) heading.textContent = nextName;
        if (address) address.textContent = nextEmail;
      }
    }
    global.addEventListener('pp:user-updated', updateUser);
    page.addEventListener('pp:page-dispose', function () { global.removeEventListener('pp:user-updated', updateUser); });
    return page;
  }

  function manualRefresh() {
    U.toast('正在同步…');
    return App.refreshCurrent().then(function () {
      if (Api.AUTH.isLogged()) {
        Api.keys(1, 100).then(function (data) {
          var items = arrOf(data);
          global.S.keys = items;
          global.dispatchEvent(new CustomEvent('pp:keys-updated', { detail: { account: Api.AUTH.currentId(), items: items } }));
        }).catch(function () {});
      }
      U.toast('已同步最新数据', 'ok');
    }).catch(function () {
      U.toast('同步失败，请稍后重试', 'err');
    });
  }

  function renderAccounts() {
    var page = h('div', { class: 'page' });
    var accounts = Api.AUTH.accounts();
    var warning = Api.AUTH.storageWarning();
    if (warning) page.appendChild(h('div', { class: 'notice warn', style: { marginBottom: '12px' } }, warning));

    if (!accounts.length) {
      page.appendChild(emptyState('还没有保存的账号', '登录后可在此切换账号', 'users'));
    } else {
      var list = h('div', { class: 'account-list' });
      accounts.forEach(function (item) {
        var initials = String(item.name || item.email || 'P').replace(/[^a-z0-9\u4e00-\u9fff]/gi, '').slice(0, 1).toUpperCase() || 'P';
        var select = h('button', {
          class: 'account-select', type: 'button', role: 'button',
          'aria-label': item.active ? item.email + '，当前账号' : (item.expired ? '重新登录 ' : '切换到 ') + item.email,
          onclick: function () {
            if (item.active) return;
            if (item.expired) {
              App.loginEmail = item.email;
              App.go('#/login');
              return;
            }
            App.switchAccount(item.id).then(function (saved) {
              if (saved) U.toast('已切换账号', 'ok');
              else U.toast(Api.AUTH.storageWarning() || '安全保存失败，重启后可能恢复原账号。', 'err');
            }).catch(function (e) { U.toast(e.message, 'err'); });
          }
        },
          h('span', { class: 'account-avatar' }, initials),
          h('span', { class: 'account-body' },
            h('span', { class: 'account-name nowrap' }, item.name || item.email.split('@')[0] || item.email),
            h('span', { class: 'account-email nowrap' }, item.email),
            h('span', { class: 'account-meta' },
              item.active ? h('span', { class: 'badge teal' }, '当前账号') : null,
              item.expired ? h('span', { class: 'badge warn' }, '需要重新登录') : h('span', { class: 'account-ready' }, '会话有效'),
              item.rememberPassword ? h('span', { class: 'account-memory' }, h('i', { html: U.ic('lock', 11) }), '已记住密码') : h('span', { class: 'account-memory' }, '未记住密码'))
          ),
          h('span', { class: 'account-switch', 'aria-hidden': 'true' },
            item.active ? h('span', null, '当前') : h('span', null, item.expired ? '再次登录' : '切换'),
            item.active ? null : h('i', { html: U.ic('chevron', 15) }))
        );
        var remove = h('button', {
          class: 'icon-btn account-remove', type: 'button', title: '移除账号', 'aria-label': '移除账号 ' + item.email,
          html: U.ic('trash', 17),
          onclick: function () {
            U.confirm('移除账号', '从本机移除 ' + item.email + ' 并删除其本地对话记录，再次使用时需要重新登录。', '移除', true).then(function (ok) {
              if (!ok) return;
              var pending = Api.AUTH.remove(item.id);
              global.PagesChat.removeAccountData(item.id);
              if (item.active) App.refreshPublic();
              App.go('#/accounts', true);
              pending.then(function (saved) {
                if (saved) U.toast('已移除账号', 'ok');
                else U.toast('安全存储写入失败，移除状态可能不会在重启后保留。', 'err');
              });
            });
          }
        });
        list.appendChild(h('article', { class: 'account-card' + (item.active ? ' active' : '') }, select, remove));
      });
      page.appendChild(list);
    }
    page.appendChild(h('button', {
      class: 'btn btn-primary btn-block', style: { marginTop: '16px' },
      onclick: function () { App.loginEmail = ''; App.go('#/login'); }
    }, h('span', { html: U.ic('plus', 16) }), '添加账号'));
    return page;
  }

  function renderProfile() {
    if (!Api.AUTH.isLogged()) return needLogin();
    var page = h('div', { class: 'page profile-page' });
    var account = Api.AUTH.context();
    var user = global.S.user || Api.AUTH.user() || {};
    var email = pick(user, 'email') || '—';
    var username = String(pick(user, 'username', 'name', 'display_name', 'nickname') || '');
    var role = String(pick(user, 'role', 'user_role') || 'user');
    var roleText = /admin/.test(role) ? '管理员' : (/observer/.test(role) ? '观察者' : '普通用户');
    var createdAt = pick(user, 'created_at', 'createdAt');
    var lastActive = pick(user, 'last_active_at', 'lastActiveAt');
    var saved = Api.AUTH.accounts().filter(function (item) { return item.id === account.id; })[0] || {};

    page.appendChild(h('div', { class: 'profile-hero' },
      h('span', { class: 'profile-avatar' }, String(username || email).slice(0, 1).toUpperCase()),
      h('div', { class: 'profile-identity' },
        h('strong', null, username || String(email).split('@')[0] || 'Pp 用户'),
        h('span', null, email),
        h('div', { class: 'profile-badges' },
          h('span', { class: 'badge teal' }, roleText),
          h('span', { class: 'badge ' + (saved.rememberPassword ? 'ok' : '') }, saved.rememberPassword ? '已记住密码' : '密码未保存'))),
      h('button', { class: 'btn btn-sm profile-switch', type: 'button', onclick: function () { App.go('#/accounts'); } }, '切换账号')));

    var usernameInput = h('input', { class: 'input', maxlength: '48', value: username, placeholder: '设置显示名称', autocomplete: 'nickname' });
    var emailInput = h('input', { class: 'input', type: 'email', value: email, readonly: true, 'aria-readonly': 'true' });
    var save = h('button', { class: 'btn btn-primary btn-block', type: 'button' }, '保存个人资料');
    var usernames = [];
    ['username', 'name', 'display_name', 'nickname'].forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(user, key)) usernames.push(key);
    });
    if (!usernames.length) usernames.push('username');
    if (!usernameInput.value.trim()) usernameInput.value = String(email).split('@')[0] || '';

    save.addEventListener('click', function () {
      var value = usernameInput.value.trim();
      if (!value) { U.toast('请输入显示名称', 'err'); return; }
      if (value === username) { U.toast('个人资料没有变化'); return; }
      var payload = {};
      usernames.forEach(function (key) { payload[key] = value; });
      save.disabled = true;
      save.textContent = '保存中…';
      Api.profileUpdate(payload).then(function () {
        return Api.me();
      }).then(function (latest) {
        if (!Api.AUTH.matches(account)) return;
        global.S.user = latest || Object.assign({}, user, payload);
        global.dispatchEvent(new CustomEvent('pp:user-updated'));
        username = value;
        page.querySelector('.profile-identity > strong').textContent = value;
        page.querySelector('.profile-avatar').textContent = value.slice(0, 1).toUpperCase();
        U.toast('个人资料已更新', 'ok');
      }).catch(function (error) {
        U.toast(error.message || '保存失败', 'err');
      }).then(function () {
        save.disabled = false;
        save.textContent = '保存个人资料';
      });
    });

    page.appendChild(h('div', { class: 'section' },
      h('div', { class: 'me-section-label' }, '基本资料'),
      h('div', { class: 'card profile-form-card' },
        h('div', { class: 'field' }, h('label', null, '显示名称'), usernameInput,
          h('div', { class: 'profile-field-hint' }, '保存后会同步到网站个人资料')),
        h('div', { class: 'field' }, h('label', null, '登录邮箱'), emailInput,
          h('div', { class: 'profile-field-hint' }, '主邮箱由网站账户安全设置管理')),
        h('button', { class: 'btn btn-block', type: 'button', onclick: function () { openPasswordSheet(); } },
          h('span', { html: U.ic('lock', 16) }), '修改登录密码'),
        save)));

    page.appendChild(h('div', { class: 'section' },
      h('div', { class: 'me-section-label' }, '账户信息'),
      h('div', { class: 'profile-details' },
        profileDetail('账户 ID', String(pick(user, 'id', 'user_id') || '—')),
        profileDetail('账户角色', roleText),
        profileDetail('并发上限', Number(pick(user, 'concurrency', 'concurrency_limit') || 0) > 0 ? U.num(pick(user, 'concurrency', 'concurrency_limit')) + ' 路' : '跟随账户'),
        profileDetail('注册时间', createdAt ? U.datetime(createdAt) : '—'),
        profileDetail('最近活跃', lastActive ? U.datetime(lastActive) : '—'),
        profileDetail('安全存储', Api.AUTH.secureAvailable() ? '已启用' : '不可用'))));

    page.appendChild(h('div', { class: 'section' },
      h('div', { class: 'me-section-label' }, '账号安全'),
      h('div', { class: 'list' },
        listItem('users', '账号管理', saved.rememberPassword ? '当前账号已记住密码，可快速恢复登录' : '添加或切换其他账号', null, function () { App.go('#/accounts'); }),
        listItem('lock', '修改密码', '更新安全存储中的已记住密码', null, function () { openPasswordSheet(); }),
        listItem('warning', '退出当前账号', '其他已保存账号不受影响', null, function () {
          U.confirm('退出当前账号', '退出后此账号需要重新登录，其他账号不受影响。', '退出', true).then(function (ok) {
            if (!ok) return;
            var pending = Api.logout();
            App.refreshPublic();
            App.go('#/accounts', true);
            pending.then(function () { U.toast('已退出当前账号', 'ok'); });
          });
        }))));

    return page;
  }

  function profileDetail(label, value) {
    return h('div', { class: 'profile-detail' }, h('span', null, label), h('strong', null, value));
  }

  function openPasswordSheet() {
    var oldP = h('input', { class: 'input', type: 'password', placeholder: '当前密码' });
    var newP = h('input', { class: 'input', type: 'password', placeholder: '新密码（至少 8 位）' });
    var rep = h('input', { class: 'input', type: 'password', placeholder: '再次输入新密码' });
    U.sheet({
      title: '修改密码',
      body: h('div', null,
        h('div', { class: 'field' }, h('label', null, '当前密码'), oldP),
        h('div', { class: 'field' }, h('label', null, '新密码'), newP),
        h('div', { class: 'field' }, h('label', null, '确认新密码'), rep)
      ),
      actions: [
        { label: '取消' },
        {
          label: '保存', kind: 'primary', onClick: function () {
            if (!oldP.value || !newP.value) { U.toast('请填写完整', 'err'); return false; }
            if (newP.value.length < 8) { U.toast('新密码至少 8 位', 'err'); return false; }
            if (newP.value !== rep.value) { U.toast('两次输入不一致', 'err'); return false; }
            Api.changePassword(oldP.value, newP.value).then(function () {
              U.toast('密码已更新', 'ok');
              U.closeOverlay();
            }).catch(function (e) { U.toast(e.message, 'err'); });
            return true;
          }
        }
      ]
    });
  }

  // ---------------- redeem ----------------
  function renderRedeem() {
    if (!Api.AUTH.isLogged()) return needLogin();
    var authContext = Api.AUTH.context();
    var disposed = false, submitting = false, historyRun = 0;
    var page = h('div', { class: 'page' });
    var input = h('input', { class: 'input mono', placeholder: '输入兑换码，例如 ABCD-EFGH-1234', style: { textTransform: 'uppercase' } });
    var histHost = h('div', { class: 'section' });
    var resultHost = h('div', { class: 'redeem-result', hidden: true, 'aria-live': 'polite' });

    function current() { return !disposed && Api.AUTH.matches(authContext); }
    function details(record) {
      var r = record && typeof record === 'object' ? record : {};
      var group = r.group && typeof r.group === 'object' ? r.group : {};
      var type = String(pick(r, 'type', 'redeem_type') || '').toLowerCase();
      var groupType = String(group.subscription_type || '').toLowerCase();
      if (type === 'subscription' || (!type && groupType === 'subscription')) {
        var days = Number(pick(r, 'validity_days', 'duration_days'));
        return { kind: 'subscription', label: String(pick(group, 'name') || pick(r, 'subscription_name', 'plan_name') || '订阅'),
          extra: days > 0 && isFinite(days) ? '有效期 ' + days + ' 天' : '', description: String(group.description || '') };
      }
      if (['balance', 'credit', 'credits', 'quota'].indexOf(type) >= 0) {
        var value = pick(r, 'credits', 'amount', 'value', 'quota');
        var amount = value !== undefined && isFinite(Number(value)) ? '+$' + U.credits(Number(value)) : '';
        return { kind: 'balance', label: '余额', extra: amount, description: '' };
      }
      return { kind: 'unknown', label: '兑换成功', extra: '', description: '' };
    }
    function paintResult(record) {
      var item = details(record);
      resultHost.hidden = false;
      resultHost.innerHTML = '';
      resultHost.appendChild(h('strong', null, item.kind === 'unknown' ? '兑换成功' : '兑换成功 · ' + item.label));
      if (item.extra) resultHost.appendChild(h('span', null, item.extra));
      if (item.description) resultHost.appendChild(h('small', null, item.description));
    }

    var redeemBtn = h('button', {
      class: 'btn btn-primary btn-block', style: { marginTop: '12px' },
      onclick: function () {
        var code = input.value.trim();
        if (submitting) return;
        if (!code) { U.toast('请输入兑换码', 'err'); return; }
        submitting = true;
        redeemBtn.disabled = true;
        redeemBtn.textContent = '兑换中…';
        Api.redeem(code).then(function (d) {
          if (!current()) return;
          var record = d && (d.redeem || d.record) || d;
          paintResult(record);
          U.toast('兑换成功', 'ok');
          input.value = '';
          loadHistory(code, true);
          App.refreshUser();
        }).catch(function (e) {
          if (current()) U.toast(e.message || '兑换失败，请重试', 'err');
        }).then(function () {
          if (!current()) return;
          submitting = false;
          redeemBtn.disabled = false;
          redeemBtn.textContent = '立即兑换';
        });
      }
    }, '立即兑换');

    page.appendChild(h('div', { class: 'card pad' },
      h('div', { style: { fontSize: '16px', fontWeight: '700', marginBottom: '4px' } }, '兑换码'),
      h('div', { class: 'small muted', style: { marginBottom: '14px' } }, '可兑换余额或订阅，具体内容以兑换码为准。'),
      input, redeemBtn, resultHost
    ));

    page.appendChild(histHost);

    function loadHistory(redeemedCode, updateResult) {
      var run = ++historyRun;
      histHost.innerHTML = '';
      histHost.appendChild(h('div', { class: 'small muted' }, '正在加载兑换记录…'));
      Api.redeemHistory().then(function (d) {
        if (!current() || run !== historyRun) return;
        var list = arrOf(d);
        histHost.innerHTML = '';
        if (redeemedCode && updateResult) {
          var found = list.filter(function (r) { return String(pick(r, 'code', 'redeem_code') || '').toLowerCase() === redeemedCode.toLowerCase(); })[0];
          if (found && details(found).kind !== 'unknown') paintResult(found);
        }
        if (!list.length) {
          histHost.appendChild(section('兑换记录', null, null, h('div', { class: 'small muted' }, '暂无兑换记录')));
          return;
        }
        histHost.appendChild(section('兑换记录', null, null, card(list.slice(0, 20).map(function (r) {
          var item = details(r);
          return h('div', { class: 'list-item redeem-history-item' },
            h('span', { class: 'li-icon', html: U.ic('gift', 16) }),
            h('div', { class: 'li-body' },
              h('div', { class: 'redeem-history-heading' }, h('strong', null, item.label), item.extra ? h('span', null, item.extra) : null),
              item.description ? h('div', { class: 'li-sub redeem-description' }, item.description) : null,
              h('div', { class: 'li-sub redeem-code' }, String(pick(r, 'code', 'redeem_code') || '兑换码')),
              h('div', { class: 'li-sub' }, U.datetime(pick(r, 'created_at', 'used_at', 'time')))
            )
          );
        }))));
      }).catch(function () {
        if (!current() || run !== historyRun) return;
        histHost.innerHTML = '';
        histHost.appendChild(section('兑换记录', null, null, h('div', { class: 'row' },
          h('span', { class: 'small muted' }, '加载失败'),
          h('button', { class: 'btn btn-sm', onclick: function () { loadHistory(); } }, '重试'))));
      });
    }
    page.addEventListener('pp:page-dispose', function () { disposed = true; historyRun++; });
    loadHistory();
    return page;
  }

  // ---------------- affiliate ----------------
  function renderAffiliate() {
    if (!Api.AUTH.isLogged()) return needLogin();
    var page = h('div', { class: 'page' });
    var host = h('div', null);
    page.appendChild(host);
    Api.aff().then(function (d) {
      var code = pick(d || {}, 'invite_code', 'code', 'aff_code') || '';
      var link = Api.ORIGIN + '/register?aff=' + encodeURIComponent(code);
      host.appendChild(h('div', { class: 'card pad' },
        h('div', { class: 'tiny muted' }, '我的邀请码'),
        h('div', { style: { fontSize: '24px', fontWeight: '700', letterSpacing: '1px', margin: '4px 0 12px' } }, code || '—'),
        h('button', { class: 'btn btn-sm', onclick: function () { U.copy(link); } }, '复制邀请链接'),
        h('div', { class: 'divider' }),
        h('div', { class: 'grid-2' },
          h('div', { class: 'stat', style: { padding: '0' } },
            h('b', null, U.num(Number(pick(d, 'aff_count', 'referred_count', 'invite_count', 'users') || 0))), h('span', null, '已邀请')),
          h('div', { class: 'stat', style: { padding: '0' } },
            h('b', null, '$' + U.credits(Number(pick(d, 'aff_quota', 'total_rebate', 'rebate', 'earnings', 'balance') || 0))), h('span', null, '可转入余额'))
        ),
        h('button', {
          class: 'btn btn-block', style: { marginTop: '14px' },
          onclick: function () {
            Api.affTransfer().then(function () { U.toast('已转入余额', 'ok'); App.refreshUser(); })
              .catch(function (e) { U.toast(e.message, 'err'); });
          }
        }, '返利转入余额')
      ));
    }).catch(function (e) {
      host.appendChild(emptyState('暂时无法获取邀请信息', e.message, 'users'));
    });
    return page;
  }

  global.PagesUser = {
    renderKeys: renderKeys, renderUsage: renderUsage, renderMe: renderMe, renderAccounts: renderAccounts, renderProfile: renderProfile,
    renderRedeem: renderRedeem, renderAffiliate: renderAffiliate,
    needLogin: needLogin
  };
})(window);
