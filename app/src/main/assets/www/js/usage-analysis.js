/* Exact time ranges are assembled from complete paginated usage records. */
(function (global) {
  'use strict';
  var U = global.U;
  var PAGE_SIZE = 500;
  var MAX_RECORDS = 20000;

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
  function fetchRecords(range) {
    // The service filters dates in its own timezone. Pad both sides, then filter instants locally.
    var q = { start_date: U.ymd(new Date(range.start.getTime() - 86400000)),
      end_date: U.ymd(new Date(range.endExclusive.getTime() + 86400000)), page_size: PAGE_SIZE };
    var records = [], seen = Object.create(null), expected = null;
    function fetchPage(page) {
      return Api.usageLogs(Object.assign({ page: page }, q)).then(function (data) {
        if (!data || !Array.isArray(data.items) || !Number.isInteger(Number(data.total)) || Number(data.total) < 0 ||
            Number(data.page) !== page || !Number.isInteger(Number(data.page_size)) || Number(data.page_size) <= 0) {
          throw failure('调用记录分页信息不完整，无法准确统计');
        }
        var total = Number(data.total);
        if (total > MAX_RECORDS) throw failure('该范围超过 ' + MAX_RECORDS + ' 条记录，请缩短时间范围');
        if (expected === null) expected = total;
        if (total !== expected || records.length + data.items.length > expected) throw failure('记录在查询期间发生变化，请重新查询');
        data.items.forEach(function (row) {
          if (!row || row.id == null || seen[String(row.id)]) throw failure('调用记录不完整或重复，请重新查询');
          seen[String(row.id)] = true;
          var when = new Date(row.created_at).getTime();
          if (!row.created_at || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(String(row.created_at)) || !isFinite(when)) {
            throw failure('调用记录缺少带时区的有效时间，无法准确统计');
          }
          records.push(row);
        });
        if (records.length === expected) return records.filter(function (row) {
          var when = new Date(row.created_at).getTime();
          return when >= range.start.getTime() && when < range.endExclusive.getTime();
        });
        if (!data.items.length || data.items.length < Number(data.page_size)) throw failure('调用记录未完整返回，请重新查询');
        return fetchPage(page + 1);
      });
    }
    return fetchPage(1);
  }

  function aggregate(records, granularity) {
    var models = Object.create(null), buckets = Object.create(null), totals = { total_requests: 0, total_input_tokens: 0, total_output_tokens: 0,
      total_cache_creation_tokens: 0, total_cache_read_tokens: 0, total_actual_cost: 0, total_cost: 0 };
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
      ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens'].forEach(function (field) {
        var n = Number(row[field]); m[field] += n; b[field] += n; totals['total_' + field] += n;
        m.total_tokens += n; b.total_tokens += n;
      });
      m.cost += Number(row.total_cost); b.cost += Number(row.total_cost); totals.total_cost += Number(row.total_cost);
      m.actual_cost += Number(row.actual_cost); b.actual_cost += Number(row.actual_cost); totals.total_actual_cost += Number(row.actual_cost);
    });
    records.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    return { stats: totals, trend: Object.keys(buckets).sort().map(function (key) { return buckets[key]; }),
      models: Object.keys(models).map(function (key) { return models[key]; }), records: records };
  }

  global.UsageAnalysis = { parseRange: parseRange, fetchRecords: fetchRecords, aggregate: aggregate };
})(window);
