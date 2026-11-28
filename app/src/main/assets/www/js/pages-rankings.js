/* Public platform rankings shown alongside the model plaza. */
(function (global) {
  'use strict';
  var U = global.U;
  var C = global.PagesCore;
  var h = C.h;
  var PERIODS = [
    { key: 'today', label: '今天' },
    { key: 'week', label: '本周' },
    { key: 'month', label: '本月' },
    { key: 'year', label: '今年' },
    { key: 'rt', label: '实时' }
  ];
  var REFRESH_MS = 5000;
  var COLORS = ['#0873ca', '#0b8f7a', '#d98819', '#c84b76', '#7357d6', '#2bb6c9', '#8fbf3f'];
  var PERIOD_META = {
    today: { name: '今天', win: '过去 24 小时', step: '每小时' },
    week: { name: '本周', win: '过去 7 天', step: '每天' },
    month: { name: '本月', win: '过去 30 天', step: '每天' },
    year: { name: '今年', win: '过去 12 个月', step: '每月' }
  };
  var REALTIME_META = { win: '最近 30 分钟', step: '每分钟' };

  function number(value) {
    var n = Number(value);
    return isFinite(n) && n >= 0 ? n : 0;
  }

  function duration(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return '—';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 1 : 2) + ' s';
    return Math.round(n) + ' ms';
  }

  function short(value) {
    var n = number(value);
    if (n >= 1e8) return { value: (n / 1e8).toFixed(2), unit: '亿' };
    if (n >= 1e6) return { value: U.num(Math.round(n / 1e4)), unit: '万' };
    return { value: U.num(Math.round(n)), unit: '' };
  }

  function formatTokens(value) {
    var item = short(value);
    return item.value + item.unit;
  }

  function percentText(value) {
    var n = Number(value);
    if (!isFinite(n)) return '—';
    if (n === 0) return '0%';
    if (n >= 99.999) return '100%';
    if (n >= 99.9) return n.toFixed(2) + '%';
    if (n >= 10) return n.toFixed(1) + '%';
    if (n >= .01) return n.toFixed(2) + '%';
    return n.toFixed(3) + '%';
  }

  function share(value, total) {
    var n = number(value), all = number(total);
    return all ? n / all * 100 : 0;
  }

  function axisFormat(max) {
    var top = number(max);
    return function (value) {
      var n = number(value);
      if (top >= 1e8) return (n / 1e8).toFixed(2) + '亿';
      if (top >= 1e6) return U.num(Math.round(n / 1e4)) + '万';
      return U.num(Math.round(n));
    };
  }

  function svg(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }

  function timestamp(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (isNaN(date.getTime())) return U.datetime(value);
    return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日 ' +
      String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') +
      ':' + String(date.getSeconds()).padStart(2, '0');
  }

  function periodMeta(period) {
    if (period === 'rt') return REALTIME_META;
    return PERIOD_META[period] || PERIOD_META.today;
  }

  function visiblePoints(data, values, period) {
    var length = Math.min((data.labels || []).length, values.length);
    if (!length) return 0;
    if (period === 'rt') return length;
    var visible = length;
    var generated = new Date(data.generated_at);
    if (!isNaN(generated.getTime())) {
      if (period === 'today') visible = Math.min(length, generated.getHours() + 1);
      else if (period === 'week') visible = Math.min(length, ((generated.getDay() + 6) % 7) + 1);
      else if (period === 'month') visible = Math.min(length, generated.getDate());
      else visible = Math.min(length, generated.getMonth() + 1);
    }
    for (var i = length - 1; i >= visible; i--) {
      if (number(values[i]) > 0) return i + 1;
    }
    return Math.max(1, visible);
  }

  function trendValues(data, view) {
    var length = (data.labels || []).length;
    if (view === 'requests') return (data.requests_series || []).slice(0, length).map(number);
    var values = new Array(length).fill(0);
    (data.series || []).forEach(function (item) {
      (item.values || []).slice(0, length).forEach(function (value, index) { values[index] += number(value); });
    });
    return values;
  }

  function trendChart(requestValues, tokenValues, labels) {
    var count = Math.min(requestValues.length, tokenValues.length, labels.length);
    if (!count) return C.emptyState('暂无可绘制数据', '', 'chart');
    requestValues = requestValues.slice(0, count);
    tokenValues = tokenValues.slice(0, count);
    labels = labels.slice(0, count);
    var width = Math.max(280, count <= 12 ? 320 : count * 25);
    var height = 218;
    var left = 44, right = 48, top = 42, bottom = 28;
    var plotWidth = width - left - right;
    var plotHeight = height - top - bottom;

    function scale(values) {
      var max = Math.max.apply(null, values) || 1;
      var magnitude = Math.pow(10, Math.floor(Math.log(max * 1.15) / Math.LN10));
      var scaled = max * 1.15 / magnitude;
      return magnitude * (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10);
    }

    var requestMax = scale(requestValues);
    var tokenMax = scale(tokenValues);
    var requestAxis = axisFormat(requestMax);
    var tokenAxis = axisFormat(tokenMax);
    var x = function (index) { return left + (count === 1 ? plotWidth / 2 : index * plotWidth / (count - 1)); };
    var requestY = function (value) { return top + plotHeight - number(value) / requestMax * plotHeight; };
    var tokenY = function (value) { return top + plotHeight - number(value) / tokenMax * plotHeight; };
    var chart = svg('svg', {
      viewBox: '0 0 ' + width + ' ' + height, width: String(width), height: String(height),
      class: 'rankings-trend-svg', role: 'img', 'data-chart': 'combined',
      'aria-label': '请求与 Token 趋势，' + count + ' 个时段'
    });

    var legendY = 9;
    var requestLegend = svg('circle', { cx: left + 5, cy: legendY, r: 4, class: 'rankings-legend-request' });
    var requestLegendText = svg('text', { x: left + 13, y: legendY + 3.5, class: 'rankings-legend-text' });
    requestLegendText.textContent = '请求';
    var tokenLegend = svg('circle', { cx: left + 62, cy: legendY, r: 4, class: 'rankings-legend-token' });
    var tokenLegendText = svg('text', { x: left + 70, y: legendY + 3.5, class: 'rankings-legend-text' });
    tokenLegendText.textContent = 'Token';
    chart.appendChild(requestLegend);
    chart.appendChild(requestLegendText);
    chart.appendChild(tokenLegend);
    chart.appendChild(tokenLegendText);

    [0, .25, .5, .75, 1].forEach(function (part) {
      var yy = top + plotHeight - plotHeight * part;
      chart.appendChild(svg('line', { x1: left, x2: left + plotWidth, y1: yy, y2: yy, class: 'rankings-grid-line' }));
      var requestTick = svg('text', { x: left - 5, y: yy + 3, 'text-anchor': 'end', class: 'rankings-axis-text' });
      requestTick.textContent = requestAxis(requestMax * part);
      chart.appendChild(requestTick);
      var tokenTick = svg('text', { x: left + plotWidth + 5, y: yy + 3, class: 'rankings-axis-text' });
      tokenTick.textContent = tokenAxis(tokenMax * part);
      chart.appendChild(tokenTick);
    });

    function path(values, y) {
      return values.map(function (value, index) {
        return (index ? 'L' : 'M') + x(index).toFixed(1) + ' ' + y(value).toFixed(1);
      }).join(' ');
    }

    var tokenLine = path(tokenValues, tokenY);
    var tokenArea = tokenLine + ' L' + x(count - 1).toFixed(1) + ' ' + (top + plotHeight) +
      ' L' + x(0).toFixed(1) + ' ' + (top + plotHeight) + ' Z';
    chart.appendChild(svg('path', { d: tokenArea, class: 'rankings-trend-area' }));
    chart.appendChild(svg('path', { d: tokenLine, class: 'rankings-trend-line rankings-trend-token' }));
    chart.appendChild(svg('path', { d: path(requestValues, requestY), class: 'rankings-trend-line rankings-trend-request' }));

    var step = count <= 7 ? 1 : count <= 14 ? 2 : count <= 26 ? 4 : 8;
    var ticks = [];
    for (var index = count - 1; index >= 0; index -= step) ticks.push(index);
    if (ticks[ticks.length - 1] !== 0 && count <= 31) ticks.push(0);
    ticks.reverse().forEach(function (index) {
      var text = svg('text', {
        x: x(index), y: height - 7, 'text-anchor': index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle',
        class: 'rankings-axis-text'
      });
      text.textContent = labels[index] || '';
      chart.appendChild(text);
    });

    var guideX = svg('line', {
      x1: 0, x2: 0, y1: top, y2: top + plotHeight,
      class: 'rankings-trend-guide rankings-trend-guide-x'
    });
    var requestGuideY = svg('line', {
      x1: left, x2: left + plotWidth, y1: 0, y2: 0,
      class: 'rankings-trend-guide rankings-trend-guide-request-y'
    });
    var tokenGuideY = svg('line', {
      x1: left, x2: left + plotWidth, y1: 0, y2: 0,
      class: 'rankings-trend-guide rankings-trend-guide-token-y'
    });
    var requestActive = svg('circle', { r: 4.5, class: 'rankings-trend-active rankings-trend-active-request' });
    var tokenActive = svg('circle', { r: 4.5, class: 'rankings-trend-active rankings-trend-active-token' });
    var readout = svg('g', { class: 'rankings-chart-readout' });
    var readoutBox = svg('rect', { height: '51', rx: '7' });
    var readoutLabel = svg('text', { y: '15', class: 'rankings-chart-readout-label' });
    var readoutRequests = svg('text', { y: '29', class: 'rankings-chart-readout-value rankings-chart-readout-request' });
    var readoutTokens = svg('text', { y: '43', class: 'rankings-chart-readout-value rankings-chart-readout-token' });
    readout.appendChild(readoutBox);
    readout.appendChild(readoutLabel);
    readout.appendChild(readoutRequests);
    readout.appendChild(readoutTokens);
    guideX.style.display = 'none';
    requestGuideY.style.display = 'none';
    tokenGuideY.style.display = 'none';
    requestActive.style.display = 'none';
    tokenActive.style.display = 'none';
    readout.style.display = 'none';
    chart.appendChild(guideX);
    chart.appendChild(requestGuideY);
    chart.appendChild(tokenGuideY);
    chart.appendChild(requestActive);
    chart.appendChild(tokenActive);
    chart.appendChild(readout);
    var baseLabel = '请求与 Token 趋势，' + count + ' 个时段';
    var lastIndex = -1;

    function activate(event) {
      var rect = chart.getBoundingClientRect();
      if (!rect.width) return;
      var chartX = (event.clientX - rect.left) * width / rect.width;
      var index = count === 1 ? 0 : Math.round((chartX - left) / plotWidth * (count - 1));
      index = Math.max(0, Math.min(count - 1, index));
      if (index === lastIndex && readout.style.display !== 'none') return;
      lastIndex = index;
      var pointX = x(index);
      var requestPointY = requestY(requestValues[index]);
      var tokenPointY = tokenY(tokenValues[index]);
      var label = labels[index] || '';
      var requestText = U.num(requestValues[index]) + ' 次请求';
      var tokenText = formatTokens(tokenValues[index]) + ' Token';
      guideX.style.display = '';
      guideX.setAttribute('x1', String(pointX));
      guideX.setAttribute('x2', String(pointX));
      requestGuideY.style.display = '';
      requestGuideY.setAttribute('y1', String(requestPointY));
      requestGuideY.setAttribute('y2', String(requestPointY));
      tokenGuideY.style.display = '';
      tokenGuideY.setAttribute('y1', String(tokenPointY));
      tokenGuideY.setAttribute('y2', String(tokenPointY));
      requestActive.style.display = '';
      requestActive.setAttribute('cx', String(pointX));
      requestActive.setAttribute('cy', String(requestPointY));
      tokenActive.style.display = '';
      tokenActive.setAttribute('cx', String(pointX));
      tokenActive.setAttribute('cy', String(tokenPointY));
      var boxWidth = Math.min(plotWidth, Math.max(116, Math.max(label.length * 6 + 18,
        requestText.length * 6 + 18, tokenText.length * 6 + 18)));
      var boxX = Math.max(left, Math.min(left + plotWidth - boxWidth, pointX - boxWidth / 2));
      readout.style.display = '';
      readoutBox.setAttribute('x', String(boxX));
      readoutBox.setAttribute('y', '2');
      readoutBox.setAttribute('width', String(boxWidth));
      readoutLabel.setAttribute('x', String(boxX + 8));
      readoutRequests.setAttribute('x', String(boxX + 8));
      readoutTokens.setAttribute('x', String(boxX + 8));
      readoutLabel.textContent = label;
      readoutRequests.textContent = requestText;
      readoutTokens.textContent = tokenText;
      chart.setAttribute('aria-label', baseLabel + '，' + label + '，' + requestText + '，' + tokenText);
    }

    function hide() {
      lastIndex = -1;
      guideX.style.display = 'none';
      requestGuideY.style.display = 'none';
      tokenGuideY.style.display = 'none';
      requestActive.style.display = 'none';
      tokenActive.style.display = 'none';
      readout.style.display = 'none';
      chart.setAttribute('aria-label', baseLabel);
    }

    var touching = false;
    var hit = svg('rect', {
      x: left, y: top, width: plotWidth, height: plotHeight,
      fill: 'transparent', class: 'rankings-trend-hit'
    });
    hit.addEventListener('pointerdown', function (event) {
      touching = true;
      activate(event);
      if (hit.setPointerCapture) {
        try { hit.setPointerCapture(event.pointerId); } catch (error) {}
      }
    });
    hit.addEventListener('pointermove', function (event) {
      if (event.pointerType === 'touch' && !touching) return;
      activate(event);
    });
    hit.addEventListener('pointerup', function () { touching = false; });
    hit.addEventListener('pointercancel', function () { touching = false; });
    hit.addEventListener('pointerleave', function (event) {
      if (event.pointerType === 'mouse') hide();
    });
    chart.appendChild(hit);
    return chart;
  }

  function donut(items, total) {
    var ring = svg('svg', {
      viewBox: '0 0 120 120', class: 'rankings-donut', role: 'img',
      'aria-label': '模型 Token 占比，共 ' + items.length + ' 个模型'
    });
    ring.appendChild(svg('circle', { cx: 60, cy: 60, r: 43, class: 'rankings-donut-track' }));
    var offset = 0;
    items.forEach(function (item, index) {
      var span = total ? number(item.total) / total * 100 : 0;
      if (span <= 0) return;
      var gap = items.length > 1 ? Math.min(.8, span / 3) : 0;
      ring.appendChild(svg('circle', {
        cx: 60, cy: 60, r: 43, pathLength: 100,
        'stroke-dasharray': Math.max(.4, span - gap) + ' ' + (100 - Math.max(.4, span - gap)),
        'stroke-dashoffset': -(offset + gap / 2),
        transform: 'rotate(-90 60 60)', class: 'rankings-donut-segment',
        stroke: COLORS[index % COLORS.length], 'data-share': span.toFixed(3)
      }));
      offset += span;
    });
    return ring;
  }

  function metric(label, value, detail, icon) {
    return h('div', { class: 'rankings-metric' },
      h('span', { class: 'rankings-metric-label' }, h('i', { html: U.ic(icon || 'chart', 16) }), label),
      h('strong', null, value),
      h('small', null, detail));
  }

  function rankingList(items, options) {
    options = options || {};
    var sorted = (Array.isArray(items) ? items : []).slice().sort(function (a, b) {
      return number(b.total) - number(a.total);
    });
    if (!sorted.length) return C.emptyState(options.empty || '暂无排行数据', '', 'chart');
    var total = sorted.reduce(function (sum, item) { return sum + number(item.total); }, 0);
    return h('div', { class: 'rankings-rank-list' }, sorted.map(function (item, index) {
      var name = String(item.name || item.model || '未命名');
      var vendor = options.kind === 'model' ? item.vendor : '';
      var ratio = share(item.total, total);
      return h('div', { class: 'rankings-rank-row' },
        h('span', { class: 'rankings-rank-number' + (index < 3 ? ' top' : '') }, String(index + 1)),
        h('span', { class: 'rankings-rank-mark', 'aria-hidden': 'true', style: { background: COLORS[index % COLORS.length] } },
          vendor ? h('b', null, String(vendor).slice(0, 1).toUpperCase()) : h('b', null, String(name).slice(0, 1).toUpperCase())),
        h('span', { class: 'rankings-rank-name' },
          h('strong', { title: name }, name),
          vendor && vendor !== name ? h('small', null, vendor) : null),
        h('span', { class: 'rankings-rank-value' }, h('b', null, formatTokens(item.total)),
          h('small', null, percentText(ratio))),
        h('span', { class: 'rankings-rank-bar', 'aria-hidden': 'true' },
          h('i', { style: { width: Math.min(100, ratio).toFixed(2) + '%' } })));
    }));
  }

  function latencyStrip(latency) {
    var data = latency || {};
    return h('div', { class: 'rankings-latency' },
      h('div', { class: 'rankings-latency-lead' },
        h('span', null, '平均响应'),
        h('strong', null, duration(data.avg)),
        h('small', null, 'P50 ' + duration(data.p50))),
      h('div', { class: 'rankings-latency-grid' },
        [['P90', data.p90], ['P99', data.p99], ['最快', data.min], ['最慢', data.max]].map(function (row) {
          return h('div', null, h('span', null, row[0]), h('b', null, duration(row[1])));
        })));
  }

  function shapePanel(stream, users, requests) {
    var streaming = number(stream && stream.stream), plain = number(stream && stream.plain);
    var total = streaming + plain;
    var streamShare = total ? streaming / total * 100 : 0;
    var top = number(users && users.top1), userCount = number(users && users.total);
    var concentration = share(top, requests);
    var ring = svg('svg', { viewBox: '0 0 52 52', class: 'rankings-concentration', 'aria-hidden': 'true' });
    ring.appendChild(svg('circle', { cx: 26, cy: 26, r: 21, class: 'rankings-concentration-track' }));
    ring.appendChild(svg('circle', {
      cx: 26, cy: 26, r: 21, pathLength: 100,
      'stroke-dasharray': Math.max(0, concentration).toFixed(2) + ' 100',
      transform: 'rotate(-90 26 26)', class: 'rankings-concentration-value'
    }));
    return h('div', { class: 'rankings-shape' },
      h('div', { class: 'rankings-shape-stream' },
        h('div', { class: 'rankings-shape-head' }, h('strong', null, '调用形态'), h('span', null, '流式 ' + percentText(streamShare))),
        h('div', { class: 'rankings-stream-bar', role: 'img', 'aria-label': '流式 ' + percentText(streamShare) + '，同步 ' + percentText(100 - streamShare) },
          h('i', { class: 'stream', style: { width: Math.max(0, streamShare).toFixed(2) + '%' } }),
          h('i', { class: 'plain', style: { width: Math.max(0, 100 - streamShare).toFixed(2) + '%' } })),
        h('div', { class: 'rankings-shape-values' },
          h('span', null, h('i', { class: 'stream' }), '流式 ', h('b', null, U.num(streaming))),
          h('span', null, h('i', { class: 'plain' }), '同步 ', h('b', null, U.num(plain))))),
      h('div', { class: 'rankings-shape-users' },
        h('div', { class: 'rankings-concentration-wrap' }, ring,
          h('b', null, percentText(concentration))),
        h('div', null, h('strong', null, '用户集中度'),
          h('small', null, '头部 ' + U.num(top) + ' 次 · 共 ' + U.num(userCount) + ' 位调用方'))));
  }

  function render() {
    var storedPeriod = U.store.get('rankings_period', 'today');
    var period = PERIODS.some(function (item) { return item.key === storedPeriod; }) ? storedPeriod : 'today';
    var data = null, pending = false, queued = false, retryTimer = null, liveCooldown = 0, disposed = false;
    var updatedAt = 0, failedAt = 0, failureCount = 0, requestToken = 0;
    var host = h('div', { class: 'page rankings-page' }, C.modelTabs('rankings'));
    var state = h('div', { class: 'rankings-state', 'aria-live': 'polite' }, '正在加载平台数据…');
    var updatedNode = h('span', { class: 'rankings-updated-at' }, '');
    var refreshStatus = h('span', { class: 'rankings-refresh-value' }, '5 秒');
    var periodGroup = h('div', { class: 'rankings-periods', role: 'group', 'aria-label': '统计周期' });
    var chartHost = h('div', { class: 'rankings-trend-scroll' });
    var ranksHost = h('div', { class: 'rankings-ranks' });
    var shareHost = h('div', { class: 'rankings-share' });
    var qualityHost = h('div', { class: 'rankings-quality' });
    var sourceWarning = h('div', { class: 'rankings-source-warning', role: 'status' });
    sourceWarning.hidden = true;
    var reload = h('button', {
      class: 'icon-btn', type: 'button', title: '刷新平台数据', 'aria-label': '刷新平台数据',
      html: U.ic('refresh', 18), onclick: function () { load(true); }
    });

    PERIODS.forEach(function (item) {
      periodGroup.appendChild(h('button', {
        type: 'button', 'data-period': item.key, class: period === item.key ? 'active' : '',
        'aria-pressed': period === item.key ? 'true' : 'false',
        onclick: function () { selectPeriod(item.key); }
      }, item.label));
    });
    var controls = h('section', { class: 'rankings-controls' },
      h('div', { class: 'rankings-control-head' }, h('div', { class: 'rankings-live-status' },
        h('span', { class: 'rankings-live-dot' }), state, updatedNode), reload),
      periodGroup,
      h('div', { class: 'rankings-control-secondary' },
        h('div', { class: 'rankings-refresh-control' },
          h('span', null, '自动刷新'), refreshStatus)));
    host.appendChild(controls);
    var content = h('div'); host.appendChild(content);

    var summaryHost = h('section', { class: 'rankings-summary' });
    var trendSection = h('section', { class: 'rankings-panel rankings-trend-panel' },
      h('div', { class: 'rankings-panel-head' },
        h('div', null, h('strong', null, '平台趋势'),
          h('small', { class: 'rankings-chart-sub' }, '')),
        h('span', { class: 'badge teal rankings-chart-total' }, '—')),
      chartHost,
      h('div', { class: 'rankings-chart-axis-note' }));
    var rankingsPanel = h('section', { class: 'rankings-panel rankings-ranks-panel' },
      h('div', { class: 'rankings-panel-head' },
        h('div', null, h('strong', null, '模型排行'), h('small', null, '按 Token 消耗排序')),
        h('span', { class: 'badge rankings-model-count' }, '—')),
      ranksHost);
    var sharePanel = h('section', { class: 'rankings-panel rankings-share-panel' },
      h('div', { class: 'rankings-panel-head' },
        h('div', null, h('strong', null, '模型占比'), h('small', null, 'Token 分布'))),
      shareHost);
    var vendorPanel = h('section', { class: 'rankings-panel rankings-vendor-panel' },
      h('div', { class: 'rankings-panel-head' },
        h('div', null, h('strong', null, '厂商排行'), h('small', null, '按 Token 消耗排序')),
        h('span', { class: 'badge rankings-vendor-count' }, '—')),
      h('div', { class: 'rankings-vendor-list' }));
    content.appendChild(sourceWarning);
    content.appendChild(summaryHost);
    content.appendChild(trendSection);
    content.appendChild(rankingsPanel);
    content.appendChild(h('div', { class: 'rankings-two-column' }, sharePanel, vendorPanel));
    content.appendChild(h('section', { class: 'rankings-panel rankings-quality-panel' },
      h('div', { class: 'rankings-panel-head' },
        h('div', null, h('strong', null, '运行质量'), h('small', null, '延迟与调用形态'))),
      qualityHost));

    function selectPeriod(next) {
      if (period === next) return;
      period = next; U.store.set('rankings_period', period);
      paintControls();
      load(true);
    }

    function paintControls() {
      Array.prototype.forEach.call(periodGroup.querySelectorAll('[data-period]'), function (button) {
        var active = button.getAttribute('data-period') === period;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    function paintChart() {
      if (!data) return;
      var tokenValues = trendValues(data, 'tokens');
      var requestSeries = trendValues(data, 'requests');
      var visible = visiblePoints(data, requestSeries.concat(tokenValues), period);
      var requestValues = requestSeries.slice(0, visible);
      tokenValues = tokenValues.slice(0, visible);
      var labels = (data.labels || []).slice(0, visible);
      chartHost.innerHTML = '';
      if (!tokenValues.length) {
        chartHost.appendChild(C.emptyState('暂无趋势数据', '切换周期后再试', 'chart'));
      } else {
        chartHost.appendChild(trendChart(requestValues, tokenValues, labels));
      }
      var meta = periodMeta(period);
      var subtitle = trendSection.querySelector('.rankings-chart-sub');
      subtitle.textContent = meta.win + ' · ' + meta.step + ' · 请求与 Token';
      trendSection.querySelector('.rankings-chart-total').textContent =
        U.num(number(data.summary && data.summary.requests)) + ' 次';
    }

    function sourceTokenMismatch() {
      if (!data) return false;
      var rawSummary = number((data.summary || {}).tokens || data.total);
      var series = new Array((data.labels || []).length).fill(0);
      (data.series || []).forEach(function (item) {
        (item.values || []).forEach(function (value, index) {
          if (index < series.length) series[index] += number(value);
        });
      });
      var rawSeries = series.reduce(function (sum, value) { return sum + value; }, 0);
      var rawModels = (data.models || []).reduce(function (sum, item) { return sum + number(item.total); }, 0);
      var tolerance = Math.max(1, rawSummary * .001);
      return (rawSeries > tolerance && Math.abs(rawSummary - rawSeries) > tolerance) ||
        (rawModels > tolerance && Math.abs(rawSummary - rawModels) > tolerance);
    }

    function paint() {
      if (!data) return;
      clearInitialContent();
      var summary = data.summary || {}, latency = data.latency || {}, stream = data.stream || {};
      var requests = number(summary.requests), tokens = number(summary.tokens || data.total);
      var requestsSeries = data.requests_series || [], labels = data.labels || [];
      var peak = Math.max.apply(null, requestsSeries.length ? requestsSeries.map(number) : [0]);
      var peakIndex = requestsSeries.map(number).indexOf(peak);
      var streamTotal = number(stream.stream) + number(stream.plain);
      sourceWarning.hidden = !sourceTokenMismatch();
      sourceWarning.textContent = sourceWarning.hidden ? '' :
        '平台汇总与模型明细暂不一致。总消耗按接口汇总口径展示，模型排行与趋势按接口明细展示。';
      summaryHost.innerHTML = '';
      summaryHost.appendChild(metric('请求数', U.num(requests),
        peak > 0 && labels[peakIndex] ? '峰值 ' + labels[peakIndex] + ' · ' + U.num(peak) + ' 次' : '暂无峰值', 'activity'));
      summaryHost.appendChild(metric('Token 消耗', formatTokens(tokens),
        requests ? '平台原始值 ' + U.num(number(summary.tokens || data.total)) + ' · 均 ' +
          formatTokens(tokens / requests) + ' / 次' : '平台原始值 ' +
          U.num(number(summary.tokens || data.total)), 'bolt'));
      summaryHost.appendChild(metric('平均响应', duration(latency.avg),
        latency.p50 != null ? 'P50 ' + duration(latency.p50) + ' · P99 ' + duration(latency.p99) : '—', 'clock'));
      summaryHost.appendChild(metric('流式占比', streamTotal ? percentText(number(stream.stream) / streamTotal * 100) : '—',
        streamTotal ? U.num(stream.plain) + ' 次同步调用' : '暂无调用', 'branch'));
      paintChart();
      var models = (Array.isArray(data.models) ? data.models : []).slice().sort(function (a, b) { return number(b.total) - number(a.total); });
      var vendors = (Array.isArray(data.vendors) ? data.vendors : []).slice().sort(function (a, b) { return number(b.total) - number(a.total); });
      ranksHost.innerHTML = '';
      ranksHost.appendChild(rankingList(models, { kind: 'model', empty: '本周期暂无模型调用' }));
      rankingsPanel.querySelector('.rankings-model-count').textContent = models.length + ' 个模型';
      var modelTotals = models.reduce(function (sum, item) { return sum + number(item.total); }, 0);
      shareHost.innerHTML = '';
      if (!models.length) shareHost.appendChild(C.emptyState('暂无占比数据', '', 'chart'));
      else {
        shareHost.appendChild(h('div', { class: 'rankings-share-body' },
          h('div', { class: 'rankings-donut-wrap' }, donut(models, modelTotals)),
          h('div', { class: 'rankings-share-legend' }, models.slice(0, 8).map(function (item, index) {
            return h('div', { class: 'rankings-share-row' },
              h('i', { style: { background: COLORS[index % COLORS.length] } }),
              h('span', { title: item.name }, item.name || '未命名'),
              h('b', null, percentText(share(item.total, modelTotals))));
          }))));
      }
      var vendorList = vendorPanel.querySelector('.rankings-vendor-list');
      vendorList.innerHTML = '';
      vendorList.appendChild(rankingList(vendors, { kind: 'vendor', empty: '本周期暂无厂商调用' }));
      vendorPanel.querySelector('.rankings-vendor-count').textContent = vendors.length + ' 家';
      qualityHost.innerHTML = '';
      qualityHost.appendChild(latencyStrip(latency));
      qualityHost.appendChild(shapePanel(stream, data.users || {}, requests));
      var generated = timestamp(data.generated_at);
      state.textContent = '实时';
      updatedNode.textContent = '更新于 ' + generated;
    }

    function isPageActive() { return App.isPageActive(host); }

    function clearInitialContent() {
      content.classList.remove('rankings-content-initial');
      var leftovers = content.querySelectorAll('.rankings-loading, .rankings-initial-error');
      Array.prototype.forEach.call(leftovers, function (node) { node.remove(); });
    }

    function showInitial(kind) {
      clearInitialContent();
      content.classList.add('rankings-content-initial');
      content.insertBefore(h('div', { class: kind === 'loading' ? 'rankings-loading' : 'dashboard-error rankings-initial-error' },
        kind === 'loading' ? '正在加载平台数据…' : '暂时无法获取平台数据',
        kind === 'loading' ? null : h('button', { type: 'button', onclick: function () { load(true); } }, '重试')), content.firstChild);
    }

    function scheduleFailure() {
      clearTimeout(retryTimer);
      retryTimer = null;
      if (!isPageActive()) return;
      var wait = Math.min(300000, REFRESH_MS * Math.pow(2, Math.min(6, failureCount - 1)));
      var remaining = Math.max(0, wait - (Date.now() - failedAt));
      retryTimer = setTimeout(function () { retryTimer = null; load(false); }, remaining);
    }

    function load(manual) {
      if (!manual && !isPageActive()) return;
      if (pending) {
        if (manual) queued = true;
        return;
      }
      clearTimeout(retryTimer);
      retryTimer = null;
      pending = true;
      queued = false;
      reload.disabled = true;
      if (!data) {
        state.textContent = '正在加载平台数据…';
        showInitial('loading');
      }
      var sequence = ++requestToken;
      var requestedPeriod = period, requestedStep = period === 'rt' ? '1m' : '';
      Api.rankings(requestedPeriod, requestedStep).then(function (result) {
        if (sequence !== requestToken || !App.isPageRetained(host)) return;
        if (requestedPeriod !== period) {
          queued = true;
          return;
        }
        data = result;
        updatedAt = Date.now();
        failedAt = 0;
        failureCount = 0;
        paint();
      }).catch(function () {
        if (sequence !== requestToken || !App.isPageRetained(host)) return;
        if (requestedPeriod !== period) {
          queued = true;
          return;
        }
        failedAt = Date.now();
        failureCount++;
        state.textContent = data ? '更新失败，显示上次数据' : '平台数据加载失败';
        if (data && updatedNode.textContent) {
          updatedNode.textContent = updatedNode.textContent.replace(/^更新于 /, '上次更新于 ');
        }
        if (!data) {
          showInitial('error');
        }
      }).then(function () {
        pending = false; reload.disabled = false;
        if (!App.isPageRetained(host)) return;
        if (queued) load(false);
        else if (failureCount) scheduleFailure();
      });
    }

    function onLiveRefreshed() {
      if (disposed || !isPageActive() || failureCount) return;
      if (Date.now() - liveCooldown < REFRESH_MS) return;
      liveCooldown = Date.now();
      load(false);
    }

    host.addEventListener('pp:page-activate', function () {
      clearTimeout(retryTimer);
      retryTimer = null;
      if (!isPageActive()) return;
      if (failureCount) scheduleFailure();
      else if (!updatedAt || Date.now() - updatedAt >= REFRESH_MS) load(false);
    });
    host.addEventListener('pp:page-deactivate', function () {
      clearTimeout(retryTimer);
      retryTimer = null;
    });
    host.addEventListener('pp:page-refresh', function () { load(true); });
    host.addEventListener('pp:page-dispose', function () {
      disposed = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      requestToken++;
      global.removeEventListener('pp:live-refreshed', onLiveRefreshed);
    });
    if (!disposed) global.addEventListener('pp:live-refreshed', onLiveRefreshed);
    paintControls();
    if (isPageActive()) load(false);
    else state.textContent = '等待实时刷新…';
    return host;
  }

  global.PagesRankings = { render: render, short: short, duration: duration };
})(window);
