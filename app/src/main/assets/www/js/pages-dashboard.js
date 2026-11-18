/* Account dashboard: summary, usage breakdown and recent requests. */
(function (global) {
  'use strict';
  var U = global.U;
  var C = global.PagesCore;
  var h = C.h, section = C.section, card = C.card, pick = C.pick, arrOf = C.arrOf;

  function number(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  function money(value) {
    var n = number(value);
    if (n && Math.abs(n) < 0.000001) return '$' + n.toPrecision(4);
    // Money reads as money: two decimals above a cent, and more only when it would round to 0.
    if (n !== 0 && Math.abs(n) < 0.01) return '$' + n.toFixed(4);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Balance is a live, spendable figure: keep all four decimals visible instead of rounding cents away.
  function balanceMoney(value) { return '$' + U.usd(value); }
  function token(value) { return U.tokens(number(value)); }
  function svg(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }

  function niceMax(value) {
    if (value <= 0) return 1;
    var magnitude = Math.pow(10, Math.floor(Math.log(value) / Math.LN10));
    var scaled = value / magnitude;
    return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * magnitude;
  }

  function cacheHit(row) {
    var read = Math.max(0, number(row.cache_read_tokens));
    var base = Math.max(0, number(row.input_tokens)) + read + Math.max(0, number(row.cache_creation_tokens));
    return base ? read / base * 100 : 0;
  }

  // ---------- donut ----------
  var DONUT_COLORS = ['#4f7cf7', '#22b07d', '#f0a03c', '#e5646b', '#8b6bf0', '#e268a8', '#2bb6c9', '#8fbf3f'];

  function shade(hex, amount) {
    var value = String(hex).replace('#', '');
    var rgb = [0, 2, 4].map(function (i) {
      var channel = parseInt(value.substr(i, 2), 16) / 255;
      channel = amount >= 0 ? channel + (1 - channel) * amount : channel * (1 + amount);
      return Math.round(Math.min(1, Math.max(0, channel)) * 255);
    });
    return '#' + rgb.map(function (c) { return ('0' + c.toString(16)).slice(-2); }).join('');
  }

  function donut(models, total) {
    var NS = 'http://www.w3.org/2000/svg';
    var R = 44, CX = 60, CY = 60;
    var ring = svg('svg', { viewBox: '0 0 120 120', class: 'dashboard-donut', role: 'img',
      'aria-label': '模型 Token 分布，共 ' + models.length + ' 个模型，总计 ' + U.num(total) + ' Tokens' });
    var defs = document.createElementNS(NS, 'defs');
    models.forEach(function (_, index) {
      var color = DONUT_COLORS[index % DONUT_COLORS.length];
      var gradient = svg('linearGradient', { id: 'donut-grad-' + index, x1: '0', y1: '0', x2: '1', y2: '1' });
      gradient.appendChild(svg('stop', { offset: '0%', 'stop-color': shade(color, 0.18) }));
      gradient.appendChild(svg('stop', { offset: '100%', 'stop-color': shade(color, -0.14) }));
      defs.appendChild(gradient);
    });
    var glow = svg('filter', { id: 'donut-glow', x: '-20%', y: '-20%', width: '140%', height: '140%' });
    glow.appendChild(svg('feDropShadow', { dx: '0', dy: '2', stdDeviation: '2.4', 'flood-color': '#0b1220', 'flood-opacity': '0.22' }));
    defs.appendChild(glow);
    ring.appendChild(defs);
    ring.appendChild(svg('circle', { cx: CX, cy: CY, r: R, fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': 13 }));
    var slices = svg('g', { filter: 'url(#donut-glow)', class: 'dashboard-donut-slices' });
    var offset = 0;
    var visible = models.filter(function (model) { return total && number(model.total_tokens) > 0; }).length;
    models.forEach(function (model, index) {
      var share = total ? Math.max(0, number(model.total_tokens)) / total * 100 : 0;
      if (share > 0) {
        // Leave a hairline gap between slices so neighbouring tones stay legible.
        var gap = visible > 1 ? Math.min(share * 0.4, share > 4 ? 0.8 : 0.45) : 0;
        slices.appendChild(svg('circle', { cx: CX, cy: CY, r: R, fill: 'none',
          stroke: 'url(#donut-grad-' + index + ')', 'stroke-width': 13, pathLength: 100,
          'data-share': Math.round(share * 1000) / 1000,
          'stroke-dasharray': (share - gap) + ' ' + (100 - share + gap), 'stroke-dashoffset': -(offset + gap / 2),
          transform: 'rotate(-90 60 60)', class: 'dashboard-donut-segment' }));
      }
      offset += share;
    });
    ring.appendChild(slices);
    return ring;
  }
  function percentText(value) {
    return value === null || value === undefined || !isFinite(Number(value)) ? '未知' : Number(value).toFixed(1) + '%';
  }

  function chartDate(value) {
    var date = String(value || '');
    var match = date.match(/^\d{4}-(\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
    return match ? match[1] + (match[2] ? ' ' + match[2] : '') : date;
  }

  function metric(label, value, detail, icon, action, valueClass) {
    return h(action ? 'button' : 'div', { class: 'card dashboard-metric dashboard-quality-item', onclick: action || null },
      h('div', { class: 'dashboard-metric-label' }, h('i', { html: U.ic(icon, 16) }), label),
      h('strong', valueClass ? { class: valueClass } : null, value),
      h('div', { class: 'dashboard-metric-detail' }, (Array.isArray(detail) ? detail : [detail]).map(function (line) {
        return h('div', null, line);
      }))
    );
  }

  function renderDashboard() {
    if (!Api.AUTH.isLogged()) return global.PagesUser.needLogin();
    var account = Api.AUTH.context();
    var page = h('div', { class: 'page dashboard' });
    var summaryHost = h('div', { class: 'dashboard-summary' }, h('div', { class: 'dashboard-loading' }, '正在加载账户统计…'));
    var platformHost = h('div');
    var trendHost = h('div');
    var modelHost = h('div');
    var recentHost = h('div');
    var end = new Date();
    var start = new Date();
    start.setDate(end.getDate() - 6);
    var startInput = U.dateTimeField({ kind: 'date', compact: true, value: U.ymd(start), label: '开始日期' });
    var endInput = U.dateTimeField({ kind: 'date', compact: true, value: U.ymd(end), label: '结束日期' });
    var startTime = U.dateTimeField({ kind: 'time', compact: true, value: '00:00', label: '开始时间' });
    var endTime = U.dateTimeField({ kind: 'time', compact: true, value: '23:59', label: '结束时间' });
    var granularity = U.store.get('dashboard_granularity:' + encodeURIComponent(account.id), 'day');
    if (granularity !== 'hour') granularity = 'day';
    var rangeMode = U.store.get('dashboard_range_mode:' + encodeURIComponent(account.id), '7d');
    if (['today', '7d', '30d', 'custom'].indexOf(rangeMode) < 0) rangeMode = '7d';
    var requestVersion = 0, summaryVersion = 0, lastSummary = null, appliedQuery = null, refreshedAt = Date.now(), refreshTimer = null;
    var totalConcurrency = null;
    function current() { return Api.AUTH.matches(account) && App.isPageRetained(page); }

    var granularityControl = h('div', { class: 'seg dashboard-granularity', 'aria-label': '统计粒度' },
      ['day', 'hour'].map(function (value) {
        return h('button', { class: value === granularity ? 'active' : '', onclick: function () {
          granularity = value;
          U.store.set('dashboard_granularity:' + encodeURIComponent(account.id), granularity);
          Array.prototype.forEach.call(granularityControl.children, function (button, index) {
            button.className = index === (value === 'day' ? 0 : 1) ? 'active' : '';
          });
          loadCharts();
        } }, value === 'day' ? '按日' : '按小时');
      })
    );

    var advanced = h('div', { class: 'dashboard-controls dashboard-advanced' + (rangeMode === 'custom' ? '' : ' is-collapsed') },
      h('div', { class: 'dashboard-date-row' },
        h('label', null, '开始日期', startInput), h('label', null, '结束日期', endInput)),
      h('div', { class: 'dashboard-date-row dashboard-time-row' },
        h('label', null, '开始时间', startTime), h('label', null, '结束时间', endTime)),
      h('div', { class: 'dashboard-control-row' },
        h('span', { class: 'tiny muted dashboard-range-note' }, '按设备本地时间统计，包含结束分钟'),
        h('button', { class: 'btn btn-sm', onclick: loadCharts }, '应用日期')));
    var rangeControl = h('div', { class: 'seg dashboard-range-presets', 'aria-label': '统计时段' },
      [{ k: 'today', t: '今日' }, { k: '7d', t: '近 7 天' }, { k: '30d', t: '近 30 天' }, { k: 'custom', t: '自定义' }].map(function (item) {
        return h('button', { class: item.k === rangeMode ? 'active' : '', onclick: function () { applyPreset(item.k); } }, item.t);
      }));
    function applyPreset(mode) {
      rangeMode = mode;
      U.store.set('dashboard_range_mode:' + encodeURIComponent(account.id), mode);
      var last = new Date(), first = new Date();
      first.setDate(last.getDate() - (mode === '7d' ? 6 : mode === '30d' ? 29 : 0));
      startInput.value = U.ymd(first);
      endInput.value = U.ymd(last);
      startTime.value = '00:00';
      endTime.value = '23:59';
      Array.prototype.forEach.call(rangeControl.children, function (button) {
        button.className = button.textContent === ({ today: '今日', '7d': '近 7 天', '30d': '近 30 天', custom: '自定义' })[mode] ? 'active' : '';
      });
      advanced.classList.toggle('is-collapsed', mode !== 'custom');
      if (mode !== 'custom') loadCharts();
    }
    if (rangeMode !== 'custom') {
      var presetStart = new Date(), presetEnd = new Date();
      presetStart.setDate(presetEnd.getDate() - (rangeMode === '30d' ? 29 : rangeMode === '7d' ? 6 : 0));
      startInput.value = U.ymd(presetStart);
      endInput.value = U.ymd(presetEnd);
    }
    var dateControls = h('div', { class: 'dashboard-range-panel' },
      h('div', { class: 'dashboard-range-head' }, rangeControl,
        h('button', { class: 'icon-btn dashboard-more-range', title: '更多时间设置', 'aria-label': '更多时间设置', html: U.ic('calendar', 18), onclick: function () {
          if (rangeMode !== 'custom') {
            rangeMode = 'custom';
            Array.prototype.forEach.call(rangeControl.children, function (button) {
              button.className = button.textContent === '自定义' ? 'active' : '';
            });
          }
          advanced.classList.remove('is-collapsed');
          advanced.setAttribute('aria-hidden', 'false');
        } })),
      advanced);

    page.appendChild(summaryHost);
    page.appendChild(platformHost);
    page.appendChild(section('用量分析', null, null, dateControls));
    page.appendChild(h('div', { class: 'dashboard-charts' }, modelHost, trendHost));
    page.appendChild(recentHost);
    page.appendChild(section('快捷操作', null, null, h('div', { class: 'dashboard-quick-actions' }, [
      { icon: 'key', label: '令牌', path: '#/keys' },
      { icon: 'chart', label: '用量', path: '#/usage' },
      { icon: 'card', label: '充值', path: '#/purchase' },
      { icon: 'gift', label: '兑换', path: '#/redeem' },
      { icon: 'bell', label: '公告', path: '#/announcements' },
      { icon: 'grid', label: '批量生图（官网）', url: Api.ORIGIN + '/batch-image' }
    ].map(function (item) {
      return h('button', { class: 'quick', onclick: function () {
        if (item.url) C.open(item.url);
        else App.go(item.path);
      } },
        h('i', { html: U.ic(item.icon, 18) }), h('span', null, item.label));
    }))));

    function renderSummary(stats) {
      var todayCache = number(stats.today_cache_creation_tokens) + number(stats.today_cache_read_tokens);
      var totalCache = number(stats.total_cache_creation_tokens) + number(stats.total_cache_read_tokens);
      var duration = number(stats.average_duration_ms);
      var reliability = global.UsageAnalysis.values(stats);
      var todayInput = number(stats.today_input_tokens), todayWrite = number(stats.today_cache_creation_tokens), todayRead = number(stats.today_cache_read_tokens);
      var todayHit = todayInput + todayWrite + todayRead > 0 ? todayRead / (todayInput + todayWrite + todayRead) * 100 : null;
      var todayErrors = global.UsageAnalysis.values({ total_requests: number(stats.today_requests), total_errors: stats.today_errors,
        error_count: stats.today_error_count, errors: stats.today_errors, status_known: stats.today_status_known }).errors;
      var todaySuccess = global.UsageAnalysis.values({ total_requests: number(stats.today_requests), success_rate: stats.today_success_rate,
        success_requests: stats.today_success_requests, total_errors: todayErrors, status_known: stats.today_status_known }).successRate;
      var successValue = todaySuccess != null ? todaySuccess : reliability.successRate;
      var successLabel = todaySuccess != null ? '今日成功率' : '请求成功率';
      var successDetail = todaySuccess != null
        ? (todayErrors == null ? '今日出错未提供' : '今日出错 ' + U.num(todayErrors)) +
          (reliability.successRate == null ? '' : ' · 累计 ' + percentText(reliability.successRate))
        : '累计 ' + (reliability.errors == null ? '请求结果未提供' : '出错 ' + U.num(reliability.errors));
      var concurrencyText = totalConcurrency == null ? '—' : U.num(totalConcurrency) + ' 路';
      var requestDetail = ['累计 ' + U.num(number(stats.total_requests))];
      if (todaySuccess != null) requestDetail.push('今日成功率 ' + percentText(todaySuccess));
      if (todayErrors != null) requestDetail.push('今日出错 ' + U.num(todayErrors));
      if (reliability.successRate != null) requestDetail.push('总成功率 ' + percentText(reliability.successRate));
      if (reliability.errors != null) requestDetail.push('累计出错 ' + U.num(reliability.errors));
      summaryHost.innerHTML = '';
      var totalHit = reliability.cacheHitRate;
      var balanceCard = h('button', {
        class: 'card dashboard-metric dashboard-balance-block', type: 'button',
        onclick: function () { App.go('#/purchase'); }
      },
        h('span', { class: 'dashboard-metric-label' }, h('i', { html: U.ic('card', 16) }), '账户余额'),
        h('strong', { class: 'dashboard-balance-value' }, balanceMoney(C.balanceOf(global.S.user || Api.AUTH.user() || {}))),
        h('span', { class: 'dashboard-balance-hint' }, '可用余额 · 点击充值'));
      summaryHost.appendChild(h('div', { class: 'dashboard-overview' },
        h('section', { class: 'card dashboard-hero-card' },
          h('div', { class: 'dashboard-hero-top' },
            h('div', { class: 'dashboard-balance-wrap' }, h('div', { class: 'dashboard-eyebrow' }, '账户概览'), balanceCard),
            h('div', { class: 'dashboard-hero-secondary' },
              metric('今日费用', money(stats.today_actual_cost), ['今日标准 ' + money(stats.today_cost), '累计实际 ' + money(stats.total_actual_cost), '累计标准 ' + money(stats.total_cost)], 'card'),
              metric('今日 Tokens', token(stats.today_tokens), ['输入 ' + token(stats.today_input_tokens), '输出 ' + token(stats.today_output_tokens), '缓存 ' + token(todayCache)], 'bolt'))),
          h('div', { class: 'dashboard-live-strip' },
            h('span', { class: 'dashboard-live-mark' }, h('i'), '实时'),
            h('strong', null, U.num(number(stats.rpm)) + ' RPM'),
            h('span', null, U.num(number(stats.tpm)) + ' TPM · 平均响应 ' +
              (duration >= 1000 ? (duration / 1000).toFixed(2) + ' s' : Math.round(duration) + ' ms') + ' · 当前并发 ' + concurrencyText),
            h('time', { class: 'dashboard-updated', datetime: new Date(refreshedAt).toISOString() }, '更新于 ' + new Date(refreshedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })))),
        h('section', { class: 'card dashboard-quality' },
          h('div', { class: 'dashboard-quality-head' },
            h('div', null, h('strong', null, '运行质量'), h('span', null, '请求、缓存与令牌状态')),
            h('button', { class: 'dashboard-inline-action', onclick: function () { App.go('#/usage'); } }, '查看用量 ›')),
          h('div', { class: 'dashboard-quality-grid' },
            metric('今日请求', U.num(number(stats.today_requests)), requestDetail, 'chart'),
            successValue == null ? null : metric(successLabel, percentText(successValue), successDetail, 'shield'),
            metric('今日缓存命中率', percentText(todayHit), '累计 ' + percentText(totalHit) + ' · 缓存读 ' + token(stats.total_cache_read_tokens), 'bolt'),
            metric('API 令牌', U.num(number(stats.total_api_keys)), U.num(number(stats.active_api_keys)) + ' 个启用', 'key', function () { App.go('#/keys'); })))));
      summaryHost.appendChild(h('div', { class: 'dashboard-overview-actions' },
        h('button', { class: 'btn', onclick: function () { App.go('#/keys'); } }, h('span', { html: U.ic('key', 16) }), '管理令牌'),
        h('button', { class: 'btn', onclick: function () { App.go('#/usage'); } }, h('span', { html: U.ic('chart', 16) }), '用量明细'),
        h('button', { class: 'btn', onclick: App.refreshPublic }, h('span', { html: U.ic('refresh', 16) }), '同步模型')));
    }

    function loadConcurrency() {
      var cached = global.S.keys;
      var request = cached && cached.length ? Promise.resolve({ items: cached }) : Api.keys(1, 100);
      return request.then(function (result) {
        if (!current()) return;
        var items = arrOf(result), sum = 0, known = 0;
        if (items.length) global.S.keys = items;
        items.forEach(function (key) {
          var value = pick(key, 'current_concurrency');
          if (value === undefined || value === null || value === '' || !isFinite(Number(value)) || Number(value) < 0) return;
          sum += Number(value);
          known++;
        });
        totalConcurrency = items.length && known === items.length ? sum : (known ? sum : null);
        if (lastSummary) renderSummary(lastSummary);
      }).catch(function () {});
    }

    function renderPlatforms(stats, quotas) {
      var byName = {};
      (Array.isArray(stats.by_platform) ? stats.by_platform : []).forEach(function (item) { byName[item.platform] = { stats: item }; });
      (Array.isArray(quotas.platform_quotas) ? quotas.platform_quotas : []).forEach(function (item) {
        if (item.daily_limit_usd == null && item.weekly_limit_usd == null && item.monthly_limit_usd == null) return;
        if (!byName[item.platform]) byName[item.platform] = { stats: {} };
        byName[item.platform].quota = item;
      });
      var names = Object.keys(byName).sort();
      var actual = names.reduce(function (sum, name) { return sum + number(byName[name].stats.total_actual_cost); }, 0);
      var today = names.reduce(function (sum, name) { return sum + number(byName[name].stats.today_actual_cost); }, 0);
      var other = Math.max(0, number(stats.total_actual_cost) - actual);
      var otherToday = Math.max(0, number(stats.today_actual_cost) - today);
      if (other > 0.000001 || otherToday > 0.000001) {
        names.push('其他');
        byName['其他'] = { stats: { total_actual_cost: other, today_actual_cost: otherToday } };
      }
      platformHost.innerHTML = '';
      if (!names.length) return;
      platformHost.appendChild(section('平台用量', null, null, h('div', { class: 'dashboard-platforms' }, names.map(function (name) {
        var item = byName[name], st = item.stats, quota = item.quota || {};
        return h('div', { class: 'dashboard-platform' },
          h('div', { class: 'row between' }, h('strong', null, name), h('b', null, money(st.total_actual_cost))),
          h('div', { class: 'dashboard-platform-detail' }, '今日 ' + money(st.today_actual_cost) + ' · 请求 ' + U.num(number(st.total_requests)) + ' · ' + token(st.total_tokens) + ' tokens'),
          ['daily', 'weekly', 'monthly'].map(function (period, index) {
            var limit = quota[period + '_limit_usd'];
            if (limit == null) return null;
            var used = number(quota[period + '_usage_usd']);
            var pct = number(limit) > 0 ? Math.min(100, Math.max(0, used / number(limit) * 100)) : 100;
            return h('div', { class: 'dashboard-quota' },
              h('div', { class: 'row between' }, h('span', null, ['每日额度', '每周额度', '每月额度'][index]),
                h('span', null, number(limit) === 0 ? '已禁用' : money(used) + ' / ' + money(limit))),
              h('div', { class: 'progress' + (pct >= 95 ? ' danger' : pct >= 75 ? ' warn' : '') }, h('i', { style: { width: pct + '%' } })),
              quota[period + '_window_resets_at'] ? h('div', { class: 'tiny muted' }, '重置 ' + U.datetime(quota[period + '_window_resets_at'])) : null);
          })
        );
      }))));
    }

    function loading(host) {
      host.innerHTML = '';
      host.appendChild(h('div', { class: 'dashboard-loading' }, '加载中…'));
    }

    function showError(host, title, retry) {
      host.innerHTML = '';
      host.appendChild(h('div', { class: 'dashboard-error' }, title, ' ', h('button', { onclick: retry }, '重试')));
    }

    function loadSummary(silent) {
      var version = ++summaryVersion;
      if (silent !== true || !lastSummary) loading(summaryHost);
      return Api.usageDashboard().then(function (stats) {
        if (!current() || version !== summaryVersion) return;
        stats = stats || {};
        lastSummary = stats;
        renderSummary(stats);
        renderPlatforms(stats, {});
        loadConcurrency();
        return Api.platformQuotas().then(function (quotas) { if (current() && version === summaryVersion) renderPlatforms(stats, quotas || {}); }).catch(function () {
          if (current() && version === summaryVersion) platformHost.appendChild(h('div', { class: 'dashboard-error' }, '平台额度暂不可用 ', h('button', { onclick: loadSummary }, '重试')));
        });
      }).catch(function () { if (current() && version === summaryVersion && (silent !== true || !lastSummary)) showError(summaryHost, '账户统计加载失败', loadSummary); });
    }

    function query() {
      return { start_date: startInput.value, end_date: endInput.value };
    }

    function renderTrend(data) {
      var trend = data && Array.isArray(data.trend) ? data.trend : [];
      trendHost.innerHTML = '';
      if (!trend.length) {
        trendHost.appendChild(section('Token 使用趋势', null, null, h('div', { class: 'dashboard-empty' }, '所选时段暂无用量')));
        return;
      }
      var tokenSeries = [
        { key: 'input_tokens', label: '输入', color: '#3b82f6' },
        { key: 'output_tokens', label: '输出', color: '#10b981' },
        { key: 'cache_creation_tokens', label: '缓存写入', color: '#f59e0b' },
        { key: 'cache_read_tokens', label: '缓存读取', color: '#06b6d4' }
      ];
      var series = tokenSeries.concat([{ key: 'cache_hit_rate', label: '缓存命中率', color: '#8b5cf6', percent: true }]);
      var rows = trend;
      var max = 0;
      rows.forEach(function (row) {
        series.forEach(function (item) { if (!item.percent) max = Math.max(max, number(row[item.key])); });
      });
      max = niceMax(max);
      var width = Math.max(360, Math.min(2400, 90 + Math.max(rows.length - 1, 1) * 36));
      var height = 220, left = 48, right = width - 38, top = 12, bottom = 181;
      var plotWidth = right - left, plotHeight = bottom - top;
      function xAt(index) { return rows.length === 1 ? (left + right) / 2 : left + index * plotWidth / (rows.length - 1); }
      function yAt(item, row) {
        var value = item.percent ? cacheHit(row) / 100 : Math.max(0, number(row[item.key])) / max;
        return bottom - value * plotHeight;
      }
      var chart = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, preserveAspectRatio: 'none', class: 'dashboard-trend-svg',
        role: 'group', 'aria-label': 'Token 用量趋势图', style: width > 360 ? 'min-width:' + width + 'px' : '' });
      for (var tick = 0; tick <= 4; tick++) {
        var y = bottom - tick * plotHeight / 4;
        chart.appendChild(svg('line', { x1: left, y1: y, x2: right, y2: y, class: 'dashboard-chart-grid' }));
        var leftLabel = svg('text', { x: left - 5, y: y + 4, 'text-anchor': 'end', class: 'dashboard-chart-label' });
        leftLabel.textContent = token(max * tick / 4);
        chart.appendChild(leftLabel);
        var rightLabel = svg('text', { x: right + 5, y: y + 4, class: 'dashboard-chart-percent' });
        rightLabel.textContent = tick * 25 + '%';
        chart.appendChild(rightLabel);
      }
      var steps = Math.max(1, Math.floor(plotWidth / 105));
      var labelStep = Math.max(1, Math.ceil((rows.length - 1) / steps));
      rows.forEach(function (row, index) {
        if (index !== 0 && index !== rows.length - 1 &&
            (index % labelStep !== 0 || right - xAt(index) < 65)) return;
        var label = svg('text', { x: xAt(index), y: bottom + 19,
          'text-anchor': index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle', class: 'dashboard-chart-label' });
        label.textContent = chartDate(row.date);
        chart.appendChild(label);
      });
      tokenSeries.forEach(function (item) {
        var path = rows.map(function (row, index) {
          return (index ? 'L' : 'M') + xAt(index).toFixed(2) + ' ' + yAt(item, row).toFixed(2);
        }).join(' ');
        chart.appendChild(svg('path', { d: path, fill: 'none', stroke: item.color, 'stroke-width': 2.5,
          'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          class: 'dashboard-trend-line', 'data-series': item.key }));
      });
      var hitPath = rows.map(function (row, index) {
        return (index ? 'L' : 'M') + xAt(index).toFixed(2) + ' ' + yAt(series[series.length - 1], row).toFixed(2);
      }).join(' ');
      chart.appendChild(svg('path', { d: hitPath, fill: 'none', stroke: '#8b5cf6', 'stroke-width': 1.8,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': '5 5',
        class: 'dashboard-trend-line dashboard-trend-rate', 'data-series': 'cache_hit_rate' }));
      var indicator = svg('g', { 'pointer-events': 'none' });
      chart.appendChild(indicator);
      var detail = h('div', { class: 'dashboard-chart-detail', 'aria-live': 'polite' });
      function selectRow(row, index) {
        var input = number(row.input_tokens), read = number(row.cache_read_tokens), write = number(row.cache_creation_tokens);
        detail.innerHTML = '';
        detail.appendChild(h('strong', null, String(row.date || '')));
        detail.appendChild(h('div', { class: 'dashboard-detail-values' }, [
          ['输入', token(input)], ['输出', token(row.output_tokens)], ['缓存写入', token(write)],
          ['缓存读取', token(read)], ['缓存命中率', cacheHit(row).toFixed(1) + '%'],
          ['实际', money(row.actual_cost)], ['标准', money(row.cost)]
        ].map(function (item) { return h('span', null, item[0] + ' ', h('b', null, item[1])); })));
        while (indicator.firstChild) indicator.removeChild(indicator.firstChild);
        indicator.appendChild(svg('line', { x1: xAt(index), y1: top, x2: xAt(index), y2: bottom, class: 'dashboard-chart-indicator' }));
        tokenSeries.forEach(function (item) {
          indicator.appendChild(svg('circle', { cx: xAt(index), cy: yAt(item, row), r: 3.5,
            fill: item.color, stroke: 'var(--surface)', 'stroke-width': 1.5 }));
        });
        indicator.appendChild(svg('circle', { cx: xAt(index), cy: yAt(series[series.length - 1], row), r: 3,
          fill: '#8b5cf6', stroke: 'var(--surface)', 'stroke-width': 1.5 }));
      }
      rows.forEach(function (row, index) {
        var start = index ? (xAt(index - 1) + xAt(index)) / 2 : left;
        var end = index < rows.length - 1 ? (xAt(index) + xAt(index + 1)) / 2 : right;
        var hit = svg('rect', { x: start, y: top, width: Math.max(1, end - start), height: plotHeight,
          fill: 'transparent', tabindex: 0, role: 'button', class: 'dashboard-trend-point',
          'aria-label': String(row.date || '') + '，输入 ' + U.num(number(row.input_tokens)) + '，输出 ' + U.num(number(row.output_tokens)) + '，缓存命中率 ' + cacheHit(row).toFixed(1) + '%' });
        hit.addEventListener('click', function () { selectRow(row, index); });
        hit.addEventListener('focus', function () { selectRow(row, index); });
        hit.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectRow(row, index); } });
        chart.appendChild(hit);
      });
      selectRow(rows[rows.length - 1], rows.length - 1);
      trendHost.appendChild(section('Token 使用趋势', null, null, h('div', { class: 'dashboard-chart' },
        h('div', { class: 'dashboard-chart-head' }, h('strong', null, 'Token 用量'),
          h('div', { class: 'dashboard-granularity-inline' }, granularityControl)),
        h('div', { class: 'dashboard-legend' }, series.map(function (item) {
          return h('span', null, h('i', { style: { background: item.color } }), item.label);
        })),
        h('div', { class: 'dashboard-chart-scroll' }, chart),
        detail
      )));
    }

    function renderModels(data) {
      var models = data && Array.isArray(data.models) ? data.models.slice() : [];
      modelHost.innerHTML = '';
      if (!models.length) {
        modelHost.appendChild(section('模型分布', null, null, h('div', { class: 'dashboard-empty' }, '所选时段暂无模型调用')));
        return;
      }
      models.sort(function (a, b) { return number(b.total_tokens) - number(a.total_tokens); });
      var colors = DONUT_COLORS;
      var total = models.reduce(function (sum, model) { return sum + Math.max(0, number(model.total_tokens)); }, 0);
      var shares = models.map(function (model) { return total ? Math.max(0, number(model.total_tokens)) / total * 100 : 0; });
      var ring = donut(models, total);
      var legend = h('div', { class: 'dashboard-donut-legend' }, models.slice(0, 4).map(function (model, index) {
        return h('div', { class: 'dashboard-donut-legend-row' },
          h('i', { style: { background: colors[index % colors.length] } }),
          h('span', { class: 'dashboard-donut-legend-name' }, model.model || '未知模型'),
          h('b', null, shares[index] >= 10 ? shares[index].toFixed(0) + '%' : shares[index] >= 0.1 ? shares[index].toFixed(1) + '%' : '<0.1%'));
      }).concat(models.length > 4 ? [h('div', { class: 'dashboard-donut-legend-more' }, '另有 ' + (models.length - 4) + ' 个模型')] : []));
      var head = h('thead', null, h('tr', null, ['模型', '请求', 'Token', '实际', '标准'].map(function (name) { return h('th', { scope: 'col' }, name); })));
      var body = h('tbody', null, models.map(function (model, index) {
        return h('tr', null,
          h('th', { scope: 'row' }, h('span', { class: 'dashboard-model-cell' },
            h('i', { style: { background: colors[index % colors.length] } }), h('span', null, model.model || '未知模型'))),
          h('td', { 'data-label': '请求' }, U.num(number(model.requests))),
          h('td', { 'data-label': 'Token' }, token(model.total_tokens)),
          h('td', { 'data-label': '实际', class: 'dashboard-model-actual' }, money(model.actual_cost)),
          h('td', { 'data-label': '标准' }, money(pick(model, 'cost', 'total_cost'))));
      }));
      modelHost.appendChild(section('模型分布', null, null, h('div', { class: 'dashboard-models' },
        h('div', { class: 'dashboard-donut-block' },
          h('div', { class: 'dashboard-donut-wrap' }, ring,
            h('div', { class: 'dashboard-donut-center', 'aria-hidden': 'true' }, h('strong', null, token(total)), h('span', null, '总 Tokens'))),
          legend),
        h('div', { class: 'dashboard-model-table-scroll' },
          h('table', { class: 'dashboard-model-table', 'aria-label': '模型调用明细' }, head, body))
      )));
    }

    function renderRecent(data) {
      var records = arrOf(data).slice(0, 5);
      recentHost.innerHTML = '';
      recentHost.appendChild(section('最近调用', '全部记录', function () { App.go('#/usage'); }, records.length
        ? h('div', { class: 'dashboard-recent' }, records.map(function (item) {
            var tok = global.UsageAnalysis.tokenBreakdown(item);
            var lat = global.UsageAnalysis.latency(item);
            return h('div', { class: 'dashboard-recent-row' },
              h('div', { class: 'dashboard-recent-info' }, h('strong', null, item.model || '请求'),
                h('small', null, U.datetime(item.created_at)),
                h('small', { class: 'recent-tokens' }, '↓' + token(tok.input) + ' ↑' + token(tok.output) + ' ⚙' + token(tok.cache)),
                lat && (lat.first != null || lat.tps) ? h('small', { class: 'recent-latency' },
                  '首字 ' + global.UsageAnalysis.ms(lat.first) + ' · 总耗时 ' + global.UsageAnalysis.ms(lat.total) +
                  (lat.tps ? ' · ' + lat.tps.toFixed(1) + ' tok/s' : '')) : null),
              h('div', { class: 'dashboard-recent-price' }, h('b', null, money(item.actual_cost)), h('small', null, '标准 ' + money(item.total_cost))));
          })) : h('div', { class: 'dashboard-empty' }, '所选时段暂无调用记录')));
    }

    function loadCharts(silent) {
      var version = ++requestVersion;
      if (silent !== true) {
        try {
          appliedQuery = { range: global.UsageAnalysis.parseRange(startInput.value, startTime.value, endInput.value, endTime.value),
            query: query(), granularity: granularity };
        } catch (error) { U.toast(error.message, 'err'); return; }
      }
      if (!appliedQuery) return;
      var range = appliedQuery.range, q = appliedQuery.query, selectedGranularity = appliedQuery.granularity;
      if (silent !== true) { loading(trendHost); loading(modelHost); loading(recentHost); }
      if (!range.wholeDays) {
        global.UsageAnalysis.fetchRecords(range).then(function (records) {
          if (!current() || version !== requestVersion) return;
          var result = global.UsageAnalysis.aggregate(records, selectedGranularity);
          renderTrend({ trend: result.trend });
          renderModels({ models: result.models });
          renderRecent(result.records);
        }).catch(function (error) {
          if (!current() || version !== requestVersion || silent === true) return;
          [trendHost, modelHost, recentHost].forEach(function (host) { showError(host, error.message || '时段统计加载失败', loadCharts); });
        });
        return;
      }
      Api.usageTrend(Object.assign({ granularity: selectedGranularity }, q)).then(function (data) {
        if (current() && version === requestVersion) renderTrend(data);
      }).catch(function () { if (current() && version === requestVersion && silent !== true) showError(trendHost, '趋势加载失败', loadCharts); });
      Api.usageModels(q).then(function (data) {
        if (current() && version === requestVersion) renderModels(data);
      }).catch(function () { if (current() && version === requestVersion && silent !== true) showError(modelHost, '模型分布加载失败', loadCharts); });
      Api.usageLogs(Object.assign({ page: 1, page_size: 5 }, q)).then(function (data) {
        if (current() && version === requestVersion) renderRecent(data);
      }).catch(function () { if (current() && version === requestVersion && silent !== true) showError(recentHost, '调用记录加载失败', loadCharts); });
    }

    function refreshVisible() {
      if (!current() || !App.isPageActive(page)) return;
      refreshedAt = Date.now();
      loadSummary(true);
      loadCharts(true);
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshVisible, 60000);
    }
    function liveUpdated(event) {
      if (!current() || !App.isPageActive(page)) return;
      refreshedAt = Date.now();
      loadSummary(true);
      loadCharts(true);
      if (event && event.detail && event.detail.reason === 'visible') {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refreshVisible, 60000);
      }
    }
    function userUpdated() {
      if (!current()) return;
      var balanceValue = summaryHost.querySelector('.dashboard-balance-value');
      if (balanceValue) balanceValue.textContent = balanceMoney(C.balanceOf(global.S.user || Api.AUTH.user() || {}));
      else if (lastSummary) renderSummary(lastSummary);
    }
    function manualUpdated() {
      if (!current()) return;
      refreshedAt = Date.now();
      loadSummary(true);
      loadCharts(true);
    }
    global.addEventListener('pp:user-updated', userUpdated);
    global.addEventListener('pp:live-refreshed', liveUpdated);
    global.addEventListener('pp:manual-refreshed', manualUpdated);
    page.addEventListener('pp:page-activate', function () {
      clearTimeout(refreshTimer);
      refreshVisible();
      refreshTimer = setTimeout(refreshVisible, 60000);
    });
    page.addEventListener('pp:page-deactivate', function () { clearTimeout(refreshTimer); });
    page.addEventListener('pp:page-dispose', function () {
      clearTimeout(refreshTimer);
      global.removeEventListener('pp:user-updated', userUpdated);
      global.removeEventListener('pp:live-refreshed', liveUpdated);
      global.removeEventListener('pp:manual-refreshed', manualUpdated);
    });
    loadSummary();
    loadCharts();
    return page;
  }

  global.PagesDashboard = { renderDashboard: renderDashboard };
})(window);
