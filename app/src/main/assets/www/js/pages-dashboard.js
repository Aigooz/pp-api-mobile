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
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  }
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

  function chartDate(value) {
    var date = String(value || '');
    var match = date.match(/^\d{4}-(\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
    return match ? match[1] + (match[2] ? ' ' + match[2] : '') : date;
  }

  function metric(label, value, detail, icon, action) {
    return h(action ? 'button' : 'div', { class: 'card dashboard-metric', onclick: action || null },
      h('div', { class: 'dashboard-metric-label' }, h('i', { html: U.ic(icon, 16) }), label),
      h('strong', null, value),
      h('div', { class: 'dashboard-metric-detail' }, detail)
    );
  }

  function renderDashboard() {
    if (!Api.AUTH.isLogged()) return global.PagesUser.needLogin();
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
    var granularity = 'day';
    var requestVersion = 0, summaryVersion = 0, lastSummary = null, appliedQuery = null, refreshedAt = Date.now(), refreshTimer = null;
    var account = Api.AUTH.context();
    function current() { return Api.AUTH.matches(account) && App.isPageRetained(page); }

    var granularityControl = h('div', { class: 'seg dashboard-granularity', 'aria-label': '统计粒度' },
      ['day', 'hour'].map(function (value) {
        return h('button', { class: value === granularity ? 'active' : '', onclick: function () {
          granularity = value;
          Array.prototype.forEach.call(granularityControl.children, function (button, index) {
            button.className = index === (value === 'day' ? 0 : 1) ? 'active' : '';
          });
          loadCharts();
        } }, value === 'day' ? '按日' : '按小时');
      })
    );

    var dateControls = h('div', { class: 'dashboard-controls' },
      h('div', { class: 'dashboard-date-row' },
        h('label', null, '开始日期', startInput), h('label', null, '结束日期', endInput)),
      h('div', { class: 'dashboard-date-row dashboard-time-row' },
        h('label', null, '开始时间', startTime), h('label', null, '结束时间', endTime)),
      h('div', { class: 'tiny muted dashboard-range-note' }, '按设备本地时间统计，包含结束分钟'),
      h('div', { class: 'dashboard-control-row' }, granularityControl,
        h('button', { class: 'btn btn-sm', onclick: loadCharts }, '应用日期'))
    );

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
      summaryHost.innerHTML = '';
      summaryHost.appendChild(h('div', { class: 'dashboard-grid' },
        metric('账户余额', money(C.balanceOf(global.S.user || Api.AUTH.user() || {})), '可用余额', 'card', function () { App.go('#/purchase'); }),
        metric('API 令牌', U.num(number(stats.total_api_keys)), U.num(number(stats.active_api_keys)) + ' 个启用', 'key', function () { App.go('#/keys'); }),
        metric('今日请求', U.num(number(stats.today_requests)), '累计 ' + U.num(number(stats.total_requests)), 'chart'),
        metric('今日费用', money(stats.today_actual_cost), '标准 ' + money(stats.today_cost) + ' · 累计实际 ' + money(stats.total_actual_cost) + ' / 标准 ' + money(stats.total_cost), 'card'),
        metric('今日 Tokens', token(stats.today_tokens), '输入 ' + token(stats.today_input_tokens) + ' · 输出 ' + token(stats.today_output_tokens) + ' · 缓存 ' + token(todayCache), 'bolt'),
        metric('累计 Tokens', token(stats.total_tokens), '输入 ' + token(stats.total_input_tokens) + ' · 输出 ' + token(stats.total_output_tokens) + ' · 缓存 ' + token(totalCache), 'chart'),
        metric('实时性能', U.num(number(stats.rpm)) + ' RPM', U.num(number(stats.tpm)) + ' TPM', 'bolt'),
        metric('平均响应', duration >= 1000 ? (duration / 1000).toFixed(2) + ' s' : Math.round(duration) + ' ms', '平均处理时间', 'clock')
      ));
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
      Api.usageDashboard().then(function (stats) {
        if (!current() || version !== summaryVersion) return;
        stats = stats || {};
        lastSummary = stats;
        renderSummary(stats);
        renderPlatforms(stats, {});
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
      var series = [
        { key: 'input_tokens', label: '输入', color: '#3b82f6' },
        { key: 'output_tokens', label: '输出', color: '#10b981' },
        { key: 'cache_creation_tokens', label: '缓存写入', color: '#f59e0b' },
        { key: 'cache_read_tokens', label: '缓存读取', color: '#06b6d4' },
        { key: 'cache_hit_rate', label: '缓存命中率', color: '#8b5cf6', percent: true }
      ];
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
      series.forEach(function (item) {
        var path = rows.map(function (row, index) {
          return (index ? 'L' : 'M') + xAt(index).toFixed(2) + ' ' + yAt(item, row).toFixed(2);
        }).join(' ');
        chart.appendChild(svg('path', { d: path, fill: 'none', stroke: item.color, 'stroke-width': 2.5,
          'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': item.percent ? '5 5' : '',
          class: 'dashboard-trend-line', 'data-series': item.key }));
      });
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
        series.forEach(function (item) {
          indicator.appendChild(svg('circle', { cx: xAt(index), cy: yAt(item, row), r: 3.5,
            fill: item.color, stroke: 'var(--surface)', 'stroke-width': 1.5 }));
        });
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
      var colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
      var total = models.reduce(function (sum, model) { return sum + Math.max(0, number(model.total_tokens)); }, 0);
      var ring = svg('svg', { viewBox: '0 0 120 120', class: 'dashboard-donut', role: 'img',
        'aria-label': '模型分布，总计 ' + U.num(total) + ' Tokens' });
      ring.appendChild(svg('circle', { cx: 60, cy: 60, r: 43, fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': 19 }));
      var offset = 0;
      models.forEach(function (model, index) {
        var share = total ? Math.max(0, number(model.total_tokens)) / total * 100 : 0;
        if (share > 0) ring.appendChild(svg('circle', { cx: 60, cy: 60, r: 43, fill: 'none',
          stroke: colors[index % colors.length], 'stroke-width': 19, pathLength: 100,
          'stroke-dasharray': share + ' ' + (100 - share), 'stroke-dashoffset': -offset,
          transform: 'rotate(-90 60 60)', class: 'dashboard-donut-segment' }));
        offset += share;
      });
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
        h('div', { class: 'dashboard-donut-wrap' }, ring,
          h('div', { class: 'dashboard-donut-center', 'aria-hidden': 'true' }, h('strong', null, token(total)), h('span', null, '总 Tokens'))),
        h('div', { class: 'dashboard-model-table-scroll' },
          h('table', { class: 'dashboard-model-table', 'aria-label': '模型调用明细' }, head, body))
      )));
    }

    function renderRecent(data) {
      var records = arrOf(data).slice(0, 5);
      recentHost.innerHTML = '';
      recentHost.appendChild(section('最近调用', '全部记录', function () { App.go('#/usage'); }, records.length
        ? h('div', { class: 'dashboard-recent' }, records.map(function (item) {
            var tokens = number(item.input_tokens) + number(item.output_tokens);
            return h('div', { class: 'dashboard-recent-row' },
              h('div', { class: 'dashboard-recent-info' }, h('strong', null, item.model || '请求'), h('small', null, U.datetime(item.created_at) + ' · ' + token(tokens) + ' tokens')),
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
    function userUpdated() { if (current() && lastSummary) renderSummary(lastSummary); }
    global.addEventListener('pp:user-updated', userUpdated);
    page.addEventListener('pp:page-activate', function () {
      clearTimeout(refreshTimer);
      if (Date.now() - refreshedAt >= 60000) refreshVisible();
      else refreshTimer = setTimeout(refreshVisible, 60000 - (Date.now() - refreshedAt));
    });
    page.addEventListener('pp:page-deactivate', function () { clearTimeout(refreshTimer); });
    page.addEventListener('pp:page-dispose', function () { clearTimeout(refreshTimer); global.removeEventListener('pp:user-updated', userUpdated); });
    loadSummary();
    loadCharts();
    return page;
  }

  global.PagesDashboard = { renderDashboard: renderDashboard };
})(window);
