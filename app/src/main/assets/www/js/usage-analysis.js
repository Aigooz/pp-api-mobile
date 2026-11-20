/* Exact time ranges are assembled from complete paginated usage records. */
(function (global) {
  'use strict';
  var U = global.U;
  var PAGE_SIZE = 500;
  var MAX_RECORDS = 20000;
  var MAX_SEARCH_RECORDS = 100000;

  function parseRange(startDate, startTime, endDate, endTime) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
        !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) throw new Error('请选择完整的日期和时间');
    var start = new Date(startDate + 'T' + startTime + ':00');
    var end = new Date(endDate + 'T' + endTime + ':00');
    function matches(date, day, time) {
      return isFinite(date.getTime()) && U.ymd(date) === day &&
        String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') === time;
    }
    if (!matches(start, startDate, startTime) || !matches(end, endDate, endTime) || start > end) {
      throw new Error('请选择有效的起止时间');
    }
    return { start: start, endExclusive: new Date(end.getTime() + 60000), startDate: startDate, endDate: endDate,
      wholeDays: startTime === '00:00' && endTime === '23:59' && start.getTimezoneOffset() === -480 && end.getTimezoneOffset() === -480 };
  }

  function failure(message) { return new Error(message); }
  function metricNumber(row, names) {
    for (var i = 0; i < names.length; i++) {
      var value = row[names[i]];
      if (value === null || value === undefined || value === '') continue;
      if (isFinite(Number(value))) return Number(value);
    }
    return null;
  }
  function recordStatus(row) {
    var code = metricNumber(row, ['status_code', 'http_status', 'statusCode']);
    var text = String(row.status == null ? '' : row.status).trim().toLowerCase();
    if (!(code >= 100 && code <= 599) && /^\d{3}$/.test(text)) code = Number(text);
    if (code >= 400 && code <= 599) return 'error';
    if (code >= 200 && code < 300) return 'success';
    if (/error|fail|exception|timeout|cancel|reject/.test(text) || row.success === false) return 'error';
    if (/^(success|succeeded|ok|complete|completed)$/.test(text) || row.success === true) return 'success';
    return 'unknown';
  }
  function isErrorRecord(row) { return recordStatus(row) === 'error'; }
  function fetchRecords(range, options) {
    options = options || {};
    // The service filters dates in its own timezone. Pad both sides, then filter instants locally.
    var q = { start_date: range.wholeDays ? range.startDate : U.ymd(new Date(range.start.getTime() - 86400000)),
      end_date: range.wholeDays ? range.endDate : U.ymd(new Date(range.endExclusive.getTime() + 86400000)), page_size: PAGE_SIZE };
    var records = [], seen = Object.create(null), expected = null, scanned = 0;
    function fetchPage(page) {
      if (options.current && !options.current()) return Promise.reject(failure('查询已取消'));
      return (options.list || Api.usageLogs)(Object.assign({ page: page }, q)).then(function (data) {
        if (!data || !Array.isArray(data.items) || !Number.isInteger(Number(data.total)) || Number(data.total) < 0 ||
            Number(data.page) !== page || !Number.isInteger(Number(data.page_size)) || Number(data.page_size) <= 0) {
          throw failure('调用记录分页信息不完整，无法准确统计');
        }
        var total = Number(data.total);
        var limitRecords = options.match ? MAX_SEARCH_RECORDS : MAX_RECORDS;
        if (total > limitRecords) {
          var limit = failure('所选时段超过 ' + limitRecords + ' 条记录，请缩小时间范围后再检索');
          limit.recordLimit = true;
          throw limit;
        }
        if (expected === null) expected = total;
        if (total !== expected || scanned + data.items.length > expected) throw failure('记录在查询期间发生变化，请重新查询');
        data.items.forEach(function (row) {
          if (!row || row.id == null || seen[String(row.id)]) throw failure('调用记录不完整或重复，请重新查询');
          seen[String(row.id)] = true;
          var when = new Date(row.created_at).getTime();
          if (!row.created_at || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(String(row.created_at)) || !isFinite(when)) {
            throw failure('调用记录缺少带时区的有效时间，无法准确统计');
          }
          if (when >= range.start.getTime() && when < range.endExclusive.getTime() && (!options.match || options.match(row))) records.push(row);
        });
        scanned += data.items.length;
        if (options.progress) options.progress(scanned, expected);
        if (scanned === expected) return records;
        if (!data.items.length || data.items.length < Number(data.page_size)) throw failure('调用记录未完整返回，请重新查询');
        return fetchPage(page + 1);
      });
    }
    return fetchPage(1);
  }

  function aggregate(records, granularity) {
    var models = Object.create(null), buckets = Object.create(null), totals = { total_requests: 0, total_input_tokens: 0, total_output_tokens: 0,
      total_cache_creation_tokens: 0, total_cache_read_tokens: 0, total_actual_cost: 0, total_cost: 0,
      total_errors: 0, success_requests: 0, status_known: 0 };
    var fields = ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'actual_cost', 'total_cost'];
    records.forEach(function (row) {
      fields.forEach(function (field) {
        if (row[field] == null || row[field] === '' || !isFinite(Number(row[field]))) {
          throw failure('调用记录缺少 ' + field + '，无法准确统计');
        }
      });
      var date = new Date(row.created_at);
      var bucket = U.ymd(date) + (granularity === 'hour' ? ' ' + String(date.getHours()).padStart(2, '0') + ':00' : '');
      var name = String(row.model || '未知模型');
      if (!models[name]) models[name] = { model: name, requests: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 0, cost: 0, actual_cost: 0 };
      if (!buckets[bucket]) buckets[bucket] = { date: bucket, requests: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 0, cost: 0, actual_cost: 0 };
      var m = models[name], b = buckets[bucket];
      m.requests++; b.requests++; totals.total_requests++;
      var status = recordStatus(row);
      if (status === 'error') totals.total_errors++;
      if (status === 'success') totals.success_requests++;
      if (status !== 'unknown') totals.status_known++;
      ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens'].forEach(function (field) {
        var n = Number(row[field]); m[field] += n; b[field] += n; totals['total_' + field] += n;
        m.total_tokens += n; b.total_tokens += n;
      });
      m.cost += Number(row.total_cost); b.cost += Number(row.total_cost); totals.total_cost += Number(row.total_cost);
      m.actual_cost += Number(row.actual_cost); b.actual_cost += Number(row.actual_cost); totals.total_actual_cost += Number(row.actual_cost);
    });
    if (totals.status_known !== totals.total_requests || !totals.total_requests) {
      totals.total_errors = null;
      totals.success_requests = null;
    }
    records.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    return { stats: totals, trend: Object.keys(buckets).sort().map(function (key) { return buckets[key]; }),
      models: Object.keys(models).map(function (key) { return models[key]; }), records: records };
  }

  function values(stats) {
    var requests = Number(stats && (stats.total_requests != null ? stats.total_requests : stats.requests)) || 0;
    var errors = metricNumber(stats || {}, ['total_errors', 'error_count', 'errors', 'failed_requests', 'failed_count']);
    var successRate = metricNumber(stats || {}, ['success_rate', 'request_success_rate']);
    if (successRate != null && successRate <= 1) successRate *= 100;
    var known = metricNumber(stats || {}, ['status_known']);
    var successes = metricNumber(stats || {}, ['success_requests', 'successful_requests']);
    if (known !== null && known < requests) { errors = null; successes = null; }
    if (successRate == null && requests > 0) {
      if (successes != null && successes >= 0 && successes <= requests) successRate = successes / requests * 100;
      else if (errors != null && errors >= 0 && errors <= requests) successRate = (requests - errors) / requests * 100;
    }
    var input = Number(stats && (stats.total_input_tokens != null ? stats.total_input_tokens : stats.input_tokens)) || 0;
    var write = Number(stats && (stats.total_cache_creation_tokens != null ? stats.total_cache_creation_tokens : stats.cache_creation_tokens)) || 0;
    var read = Number(stats && (stats.total_cache_read_tokens != null ? stats.total_cache_read_tokens : stats.cache_read_tokens)) || 0;
    var base = input + write + read;
    var hitRate = metricNumber(stats || {}, ['cache_hit_rate', 'cache_rate']);
    if (hitRate != null && hitRate <= 1) hitRate *= 100;
    if (hitRate == null && base > 0) hitRate = read / base * 100;
    return { successRate: successRate, cacheHitRate: hitRate, errors: errors };
  }

  // Per-request latency view. The service sends duration_ms and first_token_ms; TPS is the
  // output rate after the first token, which is what the site's 输出 TPS column reports.
  function latency(row) {
    if (!row) return null;
    var total = metricNumber(row, ['duration_ms', 'duration', 'latency_ms']);
    var first = metricNumber(row, ['first_token_ms', 'ttft_ms', 'first_byte_ms']);
    var output = metricNumber(row, ['output_tokens']);
    if (total !== null && total < 0) total = null;
    if (first !== null && first < 0) first = null;
    var tps = metricNumber(row, ['output_tps', 'tps', 'tokens_per_second']);
    if (tps === null && row.stream !== false && output !== null && first !== null && total !== null && total > first) {
      tps = output / ((total - first) / 1000);
    }
    if (total === null && first === null && !(tps > 0)) return null;
    return { first: first, total: total, output: output, tps: tps && isFinite(tps) && tps > 0 ? tps : null };
  }
  // Sub2API-style latency bands. First-token and total-duration colors are
  // independent because a fast stream can still finish slowly, and vice versa.
  // TPS is informational only and does not participate in either color.
  function latencyBand(value, warning, orange, danger) {
    var number = Number(value);
    if (value === null || value === undefined || !isFinite(number) || number < 0) return '';
    if (number > danger) return 'bad';
    if (number > orange) return 'orange';
    if (number > warning) return 'warn';
    return 'good';
  }
  function latencyLevels(latency) {
    if (!latency) return { first: '', total: '', overall: '' };
    var first = latencyBand(latency.first, 10000, 30000, 60000);
    var total = latencyBand(latency.total, 60000, 180000, 300000);
    var values = [first, total].filter(Boolean);
    var order = { good: 0, warn: 1, orange: 2, bad: 3 };
    var overall = values.reduce(function (current, value) {
      return !current || order[value] > order[current] ? value : current;
    }, '');
    return { first: first, total: total, overall: overall };
  }
  function latencyLevel(latency) {
    return latencyLevels(latency).overall;
  }
  function tokenBreakdown(row) {
    var input = metricNumber(row, ['input_tokens']) || 0;
    var output = metricNumber(row, ['output_tokens']) || 0;
    var cache = (metricNumber(row, ['cache_read_tokens']) || 0) + (metricNumber(row, ['cache_creation_tokens']) || 0);
    var total = metricNumber(row, ['total_tokens']);
    if (total === null) total = input + output + cache;
    return { input: input, output: output, cache: cache, total: total };
  }
  function ms(value) {
    if (value === null || value === undefined || !isFinite(Number(value))) return '—';
    var n = Number(value);
    if (n < 1000) return Math.round(n) + 'ms';
    if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 2 : 1) + 's';
    return Math.floor(n / 60000) + 'm ' + Math.round(n % 60000 / 1000) + 's';
  }

  global.UsageAnalysis = { parseRange: parseRange, fetchRecords: fetchRecords, aggregate: aggregate, values: values,
    isErrorRecord: isErrorRecord, recordStatus: recordStatus, metricNumber: metricNumber,
    latency: latency, latencyLevel: latencyLevel, latencyLevels: latencyLevels,
    tokenBreakdown: tokenBreakdown, ms: ms };
})(window);
