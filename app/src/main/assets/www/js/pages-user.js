/* 令牌 / 用量 / 我的 / 兑换 / 充值 / 邀请 */
(function (global) {
  'use strict';
  var U = global.U;
  var C = global.PagesCore;
  var h = C.h, section = C.section, listItem = C.listItem, emptyState = C.emptyState, card = C.card;
  var arrOf = C.arrOf, pick = C.pick, balanceOf = C.balanceOf, open = C.open;

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
    var children = [
      h('div', { class: 'keycard-top' },
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { class: 'keycard-name nowrap', onclick: function (e) { e.stopPropagation(); openKeyDetail(k); } }, k.name || '未命名令牌', h('span', { class: 'tiny muted', style: { marginLeft: '6px' } }, '›')),
          h('div', { class: 'keycard-key' },
            h('span', { class: 'mono' }, U.maskKey(k.key || '')),
            h('button', {
              class: 'icon-btn', style: { width: '28px', height: '28px' },
              html: U.ic('copy', 15),
              onclick: function (e) { e.stopPropagation(); U.copy(k.key || ''); }
            })
          )
        ),
        statusBadge(k)
      ),
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
        h('div', null, '创建', h('b', null, U.date(pick(k, 'created_at', 'createdAt')))),
        h('div', null, '到期', h('b', null, exp ? U.date(exp) : '永不'))
      ),
      h('div', { class: 'row', style: { gap: '6px' } },
        h('button', {
          class: 'btn btn-sm', style: { flex: '1' },
          onclick: function () { openKeyEditor(k, reload); }
        }, '编辑'),
        h('button', {
          class: 'btn btn-sm', style: { flex: '1' },
          onclick: function (e) {
            e.stopPropagation();
            var next = String(k.status) === 'inactive' ? 'active' : 'inactive';
            Api.keyUpdate(k.id, { status: next }).then(function () {
              U.toast(next === 'active' ? '已启用' : '已停用', 'ok');
              global.dispatchEvent(new CustomEvent('pp:keys-changed'));
              reload();
            }).catch(function (err) { U.toast(err.message, 'err'); });
          }
        }, String(k.status) === 'inactive' ? '启用' : '停用'),
        h('button', {
          class: 'btn btn-sm btn-danger', style: { flex: '1' },
          onclick: function (e) {
            e.stopPropagation();
            U.confirm('删除令牌', '删除后使用该令牌的客户端将立即失效，且不可恢复。', '删除', true).then(function (ok) {
              if (!ok) return;
              Api.keyDelete(k.id).then(function () {
                U.toast('已删除', 'ok');
                global.dispatchEvent(new CustomEvent('pp:keys-changed'));
                reload();
              }).catch(function (err) { U.toast(err.message, 'err'); });
            });
          }
        }, '删除')
      )
    ];
    if (String(k.status) !== 'active') children[0].style.opacity = '0.72';
    var node = h('div', { class: 'card', style: { marginBottom: '10px' } }, h('div', { class: 'keycard' }, children));
    function loadStats() {
      var today = U.ymd(new Date());
      var query = { api_key_id: k.id, start_date: today, end_date: today };
      try { query.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
      stats.textContent = '今日用量加载中…';
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
        function refreshConcurrency() {
          if (!current() || !App.isPageActive(page)) return;
          Api.keys(1, 100).then(function (result) {
            if (!current()) return;
            var values = Object.create(null);
            arrOf(result).forEach(function (item) { values[String(item.id)] = pick(item, 'current_concurrency'); });
            cards.forEach(function (item) { item.setConcurrency(values[item.id]); });
          }).catch(function () {
            if (current()) cards.forEach(function (item) { item.setConcurrency(undefined); });
          }).then(function () { if (current() && App.isPageActive(page)) concurrencyTimer = setTimeout(refreshConcurrency, 30000); });
        }
        if (App.isPageActive(page)) concurrencyTimer = setTimeout(refreshConcurrency, 30000);
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
      if (loadedAt && Date.now() - loadedAt >= 30000) reload(true);
      else if (loadedAt && cards.length) { clearTimeout(concurrencyTimer); concurrencyTimer = setTimeout(function () { reload(true); }, 30000); }
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
  function renderUsage() {
    if (!Api.AUTH.isLogged()) return needLogin();
    var page = h('div', { class: 'page' });
    var range = global.S.usageRange || 'today';
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
    var seg = h('div', { class: 'seg' }, [
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

    page.appendChild(seg);
    page.appendChild(h('div', { class: 'dashboard-controls section' },
      h('div', { class: 'dashboard-date-row' }, h('label', null, '开始日期', startInput), h('label', null, '结束日期', endInput)),
      h('div', { class: 'dashboard-date-row dashboard-time-row' }, h('label', null, '开始时间', startTime), h('label', null, '结束时间', endTime)),
      h('div', { class: 'dashboard-control-row' }, h('span', { class: 'tiny muted' }, '本地时间，包含结束分钟'),
        h('button', { class: 'btn btn-sm', onclick: function () {
          Array.prototype.forEach.call(seg.children, function (b) { b.className = ''; });
          load();
        } }, '应用时间'))));
    page.appendChild(statsHost);
    page.appendChild(trendHost);
    page.appendChild(modelHost);
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
        statsHost.innerHTML = '';
        statsHost.appendChild(h('div', { class: 'grid-2' },
          h('div', { class: 'card stat' }, h('b', null, '$' + U.credits(cost)), h('span', null, '花费')),
          h('div', { class: 'card stat' }, h('b', null, U.num(reqs)), h('span', null, '请求数')),
          h('div', { class: 'card stat' }, h('b', null, U.tokens(inTok)), h('span', null, '输入 tokens')),
          h('div', { class: 'card stat' }, h('b', null, U.tokens(outTok)), h('span', null, '输出 tokens'))
        ));
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
        trendHost.appendChild(section('消耗趋势', null, null, card(h('div', { style: { padding: '14px' } },
          h('div', { class: 'bars' }, list.map(function (x, i) {
            var v = Number(pick(x, 'actual_cost', 'cost', 'total_cost', 'credits', 'value') || 0);
            return h('i', null, h('b', { style: { height: Math.max(4, Math.round(v / max * 66)) + 'px' } }));
          })),
          h('div', { class: 'axis' },
            h('span', null, U.date(pick(list[0], 'date', 'day', 'bucket')) || ''),
            h('span', null, '峰值 $' + U.price(max))
          )
        ))));
      }).catch(function (error) { if (version === requestVersion && !precise) trendHost.appendChild(h('div', { class: 'notice warn' }, error.message || '趋势加载失败')); });

      (precise ? precise.then(function (data) { return { models: data.models }; }) : Api.usageModels(q)).then(function (d) {
        if (version !== requestVersion) return;
        var list = d && Array.isArray(d.models) ? d.models : arrOf(d);
        if (!list.length) { modelHost.innerHTML = ''; return; }
        list.sort(function (a, b) { return Number(pick(b, 'actual_cost', 'total_cost', 'cost') || 0) - Number(pick(a, 'actual_cost', 'total_cost', 'cost') || 0); });
        var top = list;
        modelHost.innerHTML = '';
        modelHost.appendChild(section('模型消耗', null, null, card(top.map(function (m) {
          var cost = Number(pick(m, 'actual_cost', 'total_cost', 'cost') || 0);
          var reqs = Number(pick(m, 'requests', 'request_count', 'count') || 0);
          return h('div', { class: 'model-row' },
            h('div', { class: 'model-avatar' }, String(pick(m, 'model', 'name') || '?').slice(0, 2)),
            h('div', { style: { flex: '1', minWidth: '0' } },
              h('div', { class: 'model-name nowrap' }, pick(m, 'model', 'name') || '未知模型'),
              h('div', { class: 'model-sub' }, U.num(reqs) + ' 次请求')),
            h('div', { class: 'price' }, h('b', null, '$' + U.credits(cost)))
          );
        }))));
      }).catch(function (error) { if (version === requestVersion && !precise) modelHost.appendChild(h('div', { class: 'notice warn' }, error.message || '模型统计加载失败')); });

      (precise ? precise.then(function (data) { return data.records.slice(0, 25); }) : Api.usageLogs(Object.assign({ page: 1, page_size: 25 }, q))).then(function (d) {
        if (version !== requestVersion) return;
        var list = arrOf(d);
        logsHost.innerHTML = '';
        logsHost.appendChild(section('调用记录', null, null,
          list.length ? card(list.map(function (log) {
            var ok = String(pick(log, 'status', 'status_code') || 'success');
            var bad = /error|fail|4\d\d|5\d\d/.test(ok);
            return h('div', { class: 'list-item' },
              h('span', { class: 'li-icon', style: { background: bad ? 'rgba(229,72,77,.1)' : '' }, html: U.ic(bad ? 'alert' : 'bolt', 16) }),
              h('div', { class: 'li-body' },
                h('div', { class: 'li-title nowrap', style: { fontSize: '13px' } }, pick(log, 'model', 'model_name') || '请求'),
                h('div', { class: 'li-sub' },
                  U.datetime(pick(log, 'created_at', 'timestamp', 'time')) + ' · ' +
                  U.tokens(Number(pick(log, 'total_tokens') || (Number(log.input_tokens || 0) + Number(log.output_tokens || 0) + Number(log.cache_creation_tokens || 0) + Number(log.cache_read_tokens || 0)))) + ' tokens')
              ),
              h('div', { class: 'li-tail' }, h('span', { class: bad ? 'badge danger' : 'badge' }, '$' + U.price(Number(pick(log, 'actual_cost', 'total_cost', 'cost') || 0))))
            );
          })) : emptyState('暂无记录', '发起调用后会显示在这里', 'chart')));
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
        listItem('refresh', '软件更新', '检查新版本与更新通知', null, function () { App.go('#/updates'); }),
        listItem('doc', '关于 Pp API', '版本、条款与联系方式', null, function () { App.go('#/about'); })
      )));
      return guestPage;
    }
    var page = h('div', { class: 'page' });
    var u = global.S.user || Api.AUTH.user() || {};
    var email = pick(u, 'email', 'username') || '—';
    var role = pick(u, 'role', 'user_role') || '';
    var roleText = /admin/.test(String(role)) ? '管理员' : (/observer/.test(String(role)) ? '观察者' : '用户');

    var balanceBadge = h('span', { class: 'badge teal' }, '$' + U.credits(balanceOf(u)));
    page.appendChild(h('div', { class: 'card pad' },
      h('div', { class: 'row' },
        h('div', {
          style: {
            width: '46px', height: '46px', borderRadius: '15px', background: 'var(--teal)',
            color: '#fff', display: 'grid', placeItems: 'center', fontSize: '19px', fontWeight: '700'
          }
        }, String(email).slice(0, 1).toUpperCase()),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { style: { fontWeight: '700' }, class: 'nowrap' }, email),
          h('div', { class: 'tiny muted' }, 'ID ' + (pick(u, 'id', 'user_id') || '—') + ' · ' + roleText)
        ),
        balanceBadge
      )
    ));

    page.appendChild(section(null, null, null, h('div', { class: 'grid-2' },
      h('button', { class: 'quick', style: { padding: '14px 6px' }, onclick: function () { App.go('#/purchase'); } },
        h('i', { html: U.ic('card', 18) }), h('span', null, '充值余额')),
      h('button', { class: 'quick', style: { padding: '14px 6px' }, onclick: function () { App.go('#/redeem'); } },
        h('i', { html: U.ic('gift', 18) }), h('span', null, '兑换码'))
    )));

    page.appendChild(h('div', { class: 'section' }, h('div', { class: 'list' },
      listItem('key', '我的令牌', '创建与管理 API 令牌', null, function () { App.go('#/keys'); }),
      listItem('chart', '用量明细', '调用记录与消耗趋势', null, function () { App.go('#/usage'); }),
      listItem('card', '充值中心', '余额与订阅套餐', null, function () { App.go('#/purchase'); }),
      listItem('users', '邀请返利', '邀请好友获得返利', null, function () { App.go('#/affiliate'); })
    )));

    page.appendChild(h('div', { class: 'section' }, h('div', { class: 'list' },
      listItem('users', '账号管理', '切换或添加账号', null, function () { App.go('#/accounts'); }),
      listItem('lock', '修改密码', '定期更换更安全', null, function () { openPasswordSheet(); }),
      listItem('refresh', '清除本地缓存', '重新拉取模型与公告', null, function () {
        Api.clearCache();
        U.toast('已清除', 'ok');
      })
    )));

    page.appendChild(h('div', { class: 'section' }, h('div', { class: 'list' },
      listItem('refresh', '软件更新', '检查新版本与更新通知', null, function () { App.go('#/updates'); }),
      listItem('doc', '关于 Pp API', '版本、条款与联系方式', null, function () { App.go('#/about'); }),
      listItem('external', '访问官网（浏览器）', Api.ORIGIN, null, function () { C.open(Api.ORIGIN); })
    )));

    page.appendChild(h('div', { class: 'section' },
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
      if (App.isPageRetained(page)) balanceBadge.textContent = '$' + U.credits(balanceOf(global.S.user || Api.AUTH.user() || {}));
    }
    global.addEventListener('pp:user-updated', updateUser);
    page.addEventListener('pp:page-dispose', function () { global.removeEventListener('pp:user-updated', updateUser); });
    return page;
  }

  function renderAccounts() {
    var page = h('div', { class: 'page' });
    var accounts = Api.AUTH.accounts();
    var warning = Api.AUTH.storageWarning();
    if (warning) page.appendChild(h('div', { class: 'notice warn', style: { marginBottom: '12px' } }, warning));

    if (!accounts.length) {
      page.appendChild(emptyState('还没有保存的账号', '登录后可在此切换账号', 'users'));
    } else {
      var list = h('div', { class: 'list account-list' });
      accounts.forEach(function (item) {
        var select = h('button', {
          class: 'account-select', type: 'button',
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
          h('span', { class: 'account-avatar', html: U.ic('user', 18) }),
          h('span', { class: 'account-body' },
            h('span', { class: 'account-email' }, item.email),
            h('span', { class: 'account-status' }, item.active ? '当前账号' : item.expired ? '登录已过期，点击重新登录' : '点击切换')
          ),
          item.active ? h('span', { class: 'badge teal' }, '当前') : h('span', { class: 'account-chevron', html: U.ic('chevron', 16) })
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
        list.appendChild(h('div', { class: 'account-row' }, select, remove));
      });
      page.appendChild(list);
    }
    page.appendChild(h('button', {
      class: 'btn btn-primary btn-block', style: { marginTop: '16px' },
      onclick: function () { App.loginEmail = ''; App.go('#/login'); }
    }, h('span', { html: U.ic('plus', 16) }), '添加账号'));
    return page;
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
    var page = h('div', { class: 'page' });
    var input = h('input', { class: 'input mono', placeholder: '输入兑换码，例如 ABCD-EFGH-1234', style: { textTransform: 'uppercase' } });
    var histHost = h('div', { class: 'section' });

    page.appendChild(h('div', { class: 'card pad' },
      h('div', { style: { fontSize: '16px', fontWeight: '700', marginBottom: '4px' } }, '兑换余额'),
      h('div', { class: 'small muted', style: { marginBottom: '14px' } }, '输入有效的兑换码，额度将立即到账。'),
      input,
      h('button', {
        class: 'btn btn-primary btn-block', style: { marginTop: '12px' },
        onclick: function () {
          var code = input.value.trim();
          if (!code) { U.toast('请输入兑换码', 'err'); return; }
          Api.redeem(code).then(function (d) {
            var got = pick(d || {}, 'credits', 'amount', 'value', 'quota');
            U.toast(got ? '兑换成功 +$' + got : '兑换成功', 'ok');
            input.value = '';
            loadHistory();
            App.refreshUser();
          }).catch(function (e) { U.toast(e.message, 'err'); });
        }
      }, '立即兑换')
    ));

    page.appendChild(histHost);

    function loadHistory() {
      histHost.innerHTML = '';
      Api.redeemHistory().then(function (d) {
        var list = arrOf(d);
        if (!list.length) return;
        histHost.appendChild(section('兑换记录', null, null, card(list.slice(0, 20).map(function (r) {
          return h('div', { class: 'list-item' },
            h('span', { class: 'li-icon', html: U.ic('gift', 16) }),
            h('div', { class: 'li-body' },
              h('div', { class: 'li-title', style: { fontSize: '13px' } }, pick(r, 'code', 'redeem_code') || '兑换码'),
              h('div', { class: 'li-sub' }, U.datetime(pick(r, 'created_at', 'used_at', 'time')))
            ),
            h('div', { class: 'li-tail' }, '+$' + U.credits(Number(pick(r, 'credits', 'amount', 'value', 'quota') || 0)))
          );
        }))));
      }).catch(function () {});
    }
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
    renderKeys: renderKeys, renderUsage: renderUsage, renderMe: renderMe, renderAccounts: renderAccounts,
    renderRedeem: renderRedeem, renderAffiliate: renderAffiliate,
    needLogin: needLogin
  };
})(window);
