/* Public channel monitoring shown alongside the model plaza. */
(function (global) {
  'use strict';
  var U = global.U;
  var C = global.PagesCore;
  var h = C.h;

  function numeric(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return isFinite(n) && n >= 0 ? n : null;
  }

  function duration(value) {
    var n = numeric(value);
    return n === null ? '—' : n >= 1000 ? (n / 1000).toFixed(2) + ' s' : Math.round(n) + ' ms';
  }

  function percentage(value) {
    var n = numeric(value);
    return n === null ? '—' : n.toFixed(1) + '%';
  }

  function statusInfo(status, availability) {
    if (status === 'failed' || status === 'error') return { kind: 'error', label: '故障' };
    if (status === 'unknown' || !status) return { kind: 'unknown', label: '未知' };
    if (status === 'degraded') return { kind: 'warning', label: '偏慢' };
    if (status !== 'operational') return { kind: 'unknown', label: '未知' };
    var value = numeric(availability);
    return value !== null && value < 95 ? { kind: 'warning', label: '波动' } : { kind: 'ok', label: '正常' };
  }

  function average(items, key) {
    var values = items.map(function (item) { return numeric(item[key]); }).filter(function (value) { return value !== null; });
    return values.length ? values.reduce(function (sum, value) { return sum + value; }, 0) / values.length : null;
  }

  function historyDetails(item) {
    var entries = Array.isArray(item.timeline) ? item.timeline.slice().sort(function (a, b) {
      return String(b.at || '').localeCompare(String(a.at || ''));
    }) : [];
    var body = h('div', { class: 'channel-history' });
    if (!entries.length) body.appendChild(C.emptyState('暂无探测记录', '', 'alert'));
    entries.forEach(function (entry) {
      var state = statusInfo(entry.status);
      body.appendChild(h('div', { class: 'channel-history-row' },
        h('span', null, U.datetime(entry.at)),
        h('span', { class: 'channel-state ' + state.kind }, state.label),
        h('span', null, duration(entry.latency_ms)),
        h('span', { class: 'muted' }, '网络 ' + duration(entry.ping_ms))));
    });
    U.sheet({ title: item.model || '探测记录', body: body, actions: [{ label: '关闭' }] });
  }

  function latencyChart(items) {
    var buckets = {};
    var cutoff = Date.now() - 12 * 60 * 60 * 1000;
    items.forEach(function (item) {
      (Array.isArray(item.timeline) ? item.timeline : []).forEach(function (entry) {
        var time = new Date(entry.at).getTime();
        var value = numeric(entry.latency_ms);
        if (!isFinite(time) || time < cutoff || value === null) return;
        var minute = Math.floor(time / 60000) * 60000;
        if (!buckets[minute]) buckets[minute] = { sum: 0, count: 0 };
        buckets[minute].sum += value;
        buckets[minute].count++;
      });
    });
    var times = Object.keys(buckets).map(Number).sort(function (a, b) { return a - b; });
    if (!times.length) return null;
    var values = times.map(function (time) { return buckets[time].sum / buckets[time].count; });
    var max = Math.max.apply(null, values) || 1;
    var ns = 'http://www.w3.org/2000/svg';
    function svg(tag, attrs) {
      var node = document.createElementNS(ns, tag);
      Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]); });
      return node;
    }
    var chart = svg('svg', { viewBox: '0 0 320 110', preserveAspectRatio: 'none', class: 'channel-latency-chart',
      role: 'img', 'aria-label': '近 12 小时平均响应延迟趋势' });
    for (var i = 0; i < 3; i++) chart.appendChild(svg('line', { x1: 0, x2: 320, y1: 10 + i * 44, y2: 10 + i * 44, class: 'dashboard-chart-grid' }));
    var first = times[0], span = times[times.length - 1] - first;
    var points = times.map(function (time, index) {
      var x = span ? (time - first) * 314 / span + 3 : 160;
      return x.toFixed(1) + ',' + (98 - values[index] * 88 / max).toFixed(1);
    });
    chart.appendChild(svg('polyline', { points: points.join(' '), fill: 'none', stroke: '#0873ca',
      'stroke-width': '2', 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    if (times.length === 1) {
      var point = points[0].split(',');
      chart.appendChild(svg('circle', { cx: point[0], cy: point[1], r: '3', fill: '#0873ca' }));
    }
    return h('section', { class: 'channel-trend' },
      h('div', { class: 'channel-heading' }, h('strong', null, '平均响应趋势'), h('span', null, '近 12 小时')),
      h('div', { class: 'channel-chart-body' },
        h('div', { class: 'channel-chart-axis' }, h('span', null, duration(max)), h('span', null, duration(max / 2)), h('span', null, '0 ms')),
        chart),
      h('div', { class: 'channel-chart-labels' }, h('span', null, U.datetime(first)), h('span', null, U.datetime(times[times.length - 1]))));
  }

  function render() {
    var host = h('div', { class: 'page channel-page' }, C.modelTabs('status'));
    var controls = h('div', { class: 'channel-controls' });
    var content = h('div', { class: 'channel-content' });
    var group = '';
    var search = '';
    var data = null;
    var pending = false;
    var timer = null;
    var updatedAt = 0;
    var state = h('div', { class: 'channel-update', 'aria-live': 'polite' }, '正在加载渠道状态…');
    var reload = h('button', { class: 'icon-btn', title: '刷新渠道状态', 'aria-label': '刷新渠道状态',
      html: U.ic('refresh', 18), onclick: load });
    var searchInput = h('input', { class: 'input', type: 'search', placeholder: '搜索模型或厂商', 'aria-label': '搜索渠道',
      oninput: function (event) { search = event.target.value.trim().toLowerCase(); paint(); } });
    var groups = h('div', { class: 'chips channel-groups', 'aria-label': '渠道分组' });
    controls.appendChild(h('div', { class: 'channel-update-row' }, state, reload));
    controls.appendChild(searchInput);
    controls.appendChild(groups);
    host.appendChild(controls);
    host.appendChild(content);

    function metric(label, value, extra) {
      return h('div', { class: 'channel-metric' }, h('span', null, label), h('strong', null, value), extra ? h('small', null, extra) : null);
    }

    function paint() {
      if (!data) return;
      var items = data.items.filter(function (item) { return item && typeof item === 'object'; });
      var names = [];
      items.forEach(function (item) {
        var name = String(item.group || '未分组');
        if (names.indexOf(name) < 0) names.push(name);
      });
      if (group && names.indexOf(group) < 0) group = '';
      groups.innerHTML = '';
      [''].concat(names).forEach(function (name) {
        var count = name ? items.filter(function (item) { return String(item.group || '未分组') === name; }).length : items.length;
        groups.appendChild(h('button', { class: 'chip' + (group === name ? ' active' : ''),
          'aria-pressed': group === name ? 'true' : 'false', onclick: function () { group = name; paint(); } },
          (name || '全部') + ' ' + count));
      });
      var filtered = items.filter(function (item) {
        return (!group || String(item.group || '未分组') === group) && (!search ||
          [item.model, item.group, item.vendorLabel, item.vendor].join(' ').toLowerCase().indexOf(search) >= 0);
      });
      var bad = filtered.filter(function (item) { return item.status === 'failed' || item.status === 'error'; }).length;
      var unknown = filtered.filter(function (item) { return !item.status || ['operational', 'degraded', 'failed', 'error'].indexOf(item.status) < 0; }).length;
      var slow = filtered.filter(function (item) { return statusInfo(item.status, item.availability).kind === 'warning'; }).length;
      content.innerHTML = '';
      if (!filtered.length) {
        content.appendChild(C.emptyState(items.length ? '没有匹配的渠道' : '暂无渠道状态', items.length ? '换个关键词或分组试试' : '', 'search'));
        return;
      }
      var summary = h('div', { class: 'channel-summary' },
        metric('监控模型', String(filtered.length)),
        metric('平均可用率', percentage(average(filtered, 'availability')), '近 7 天'),
        metric('平均响应', duration(average(filtered, 'latency'))),
        metric('当前状态', bad ? bad + ' 个故障' : unknown ? unknown + ' 个未知' : slow ? slow + ' 个波动' : '全部正常'));
      content.appendChild(summary);
      var chart = latencyChart(filtered);
      if (chart) content.appendChild(chart);
      content.appendChild(h('div', { class: 'channel-heading channel-list-heading' },
        h('strong', null, '模型明细'), h('span', null, '最近探测记录')));
      content.appendChild(h('div', { class: 'channel-legend' },
        [['ok', '正常'], ['warning', '波动'], ['error', '故障'], ['unknown', '未知']].map(function (entry) {
          return h('span', null, h('i', { class: 'channel-bar ' + entry[0] }), entry[1]);
        })));
      var list = h('div', { class: 'channel-list' });
      filtered.forEach(function (item) {
        var status = statusInfo(item.status, item.availability);
        var timeline = Array.isArray(item.timeline) ? item.timeline.slice().sort(function (a, b) {
          return String(a.at || '').localeCompare(String(b.at || ''));
        }).slice(-24) : [];
        var bars = h('button', { class: 'channel-timeline', title: '查看探测记录',
          'aria-label': '查看 ' + (item.model || '模型') + ' 的探测记录', onclick: function () { historyDetails(item); } },
          timeline.length ? timeline.map(function (entry) {
            var info = statusInfo(entry.status);
            return h('span', { class: 'channel-bar ' + info.kind, title: U.datetime(entry.at) + ' · ' + info.label + ' · ' + duration(entry.latency_ms) });
          }) : h('span', { class: 'channel-no-history' }, '暂无探测记录'));
        list.appendChild(h('article', { class: 'channel-item' },
          h('div', { class: 'channel-item-head' },
            h('div', { class: 'channel-item-title' }, h('strong', null, String(item.model || '未命名模型')),
              h('span', null, [item.group, item.vendorLabel || item.vendor].filter(Boolean).join(' · '))),
            h('span', { class: 'channel-state ' + status.kind }, status.label)),
          h('div', { class: 'channel-values' },
            h('span', null, '响应 ', h('b', null, duration(item.latency))),
            h('span', null, '网络 ', h('b', null, duration(item.ping))),
            h('span', null, '可用率 ', h('b', null, percentage(item.availability)))),
          bars));
      });
      content.appendChild(list);
    }

    function schedule() {
      clearTimeout(timer);
      if (App.isPageActive(host)) timer = setTimeout(load, Math.max(0, 60000 - (Date.now() - updatedAt)));
    }

    function load() {
      if (pending) return;
      pending = true;
      reload.disabled = true;
      if (!data) state.textContent = '正在加载渠道状态…';
      Api.channelStatus().then(function (result) {
        if (!App.isPageRetained(host)) return;
        data = result;
        updatedAt = Date.now();
        state.textContent = '更新 ' + U.datetime(result.updatedAt);
        paint();
      }).catch(function () {
        if (!App.isPageRetained(host)) return;
        updatedAt = Date.now();
        state.textContent = data ? '更新失败，显示上次数据' : '渠道状态加载失败';
        if (!data) {
          content.innerHTML = '';
          content.appendChild(h('div', { class: 'dashboard-error' }, '暂时无法获取渠道状态 ', h('button', { onclick: load }, '重试')));
        }
      }).then(function () {
        pending = false;
        reload.disabled = false;
        schedule();
      });
    }

    host.addEventListener('pp:page-activate', function () {
      if (!updatedAt || Date.now() - updatedAt >= 60000) load();
      else schedule();
    });
    host.addEventListener('pp:page-deactivate', function () { clearTimeout(timer); });
    host.addEventListener('pp:page-dispose', function () { clearTimeout(timer); });
    load();
    return host;
  }

  global.PagesChannel = { render: render, statusInfo: statusInfo };
})(window);
