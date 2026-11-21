/* Account-scoped diagnostics outlive chat pages and result sheets. */
(function (global) {
  'use strict';

  var job = null;
  var cancelRequests = null;
  var notifyTimer = 0;
  var elapsedTimer = 0;
  var MAX_PARALLEL = 4;

  function current() {
    return job && Api.AUTH.currentId() === job.accountId ? job : null;
  }

  function notify(immediate) {
    if (immediate && notifyTimer) { clearTimeout(notifyTimer); notifyTimer = 0; }
    if (notifyTimer) return;
    function emit() {
      notifyTimer = 0;
      global.dispatchEvent(new CustomEvent('pp:chat-test-updated'));
    }
    if (immediate) emit();
    else notifyTimer = setTimeout(emit, 80);
  }

  function firstValue(values) {
    for (var i = 0; i < values.length; i++) {
      if (values[i] !== undefined && values[i] !== null && values[i] !== '' && isFinite(Number(values[i]))) return Number(values[i]);
    }
    return null;
  }

  function usageMetrics(usage) {
    usage = usage || {};
    var details = usage.prompt_tokens_details || usage.input_tokens_details || {};
    var creation = usage.cache_creation || usage.prompt_cache_creation || {};
    var input = firstValue([usage.prompt_tokens, usage.input_tokens]);
    var output = firstValue([usage.completion_tokens, usage.output_tokens]);
    var read = firstValue([usage.cache_read_input_tokens, usage.cached_tokens, details.cached_tokens, details.cache_read_input_tokens, details.cache_read_tokens]);
    var write = firstValue([usage.cache_creation_input_tokens, usage.cache_write_tokens, details.cache_creation_tokens, details.cache_creation_input_tokens]);
    if (write === null) {
      var five = firstValue([creation.ephemeral_5m_input_tokens]);
      var hour = firstValue([creation.ephemeral_1h_input_tokens]);
      if (five !== null || hour !== null) write = (five || 0) + (hour || 0);
    }
    var total = firstValue([usage.total_tokens]);
    if (total === null && input !== null && output !== null) {
      total = input + output;
      // Anthropic excludes separate cache fields from input_tokens.
      if (usage.prompt_tokens == null && (usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null || usage.cache_creation)) total += (read || 0) + (write || 0);
    }
    return { inputTokens: input, outputTokens: output, cacheRead: read, cacheWrite: write, totalTokens: total };
  }

  function start(options) {
    if (job && job.running) return null;
    var key = options.key;
    var context = Api.AUTH.context();
    if (!Api.AUTH.isLogged() || !key || !key.key || String(key.status || 'active') !== 'active') return null;
    var names = options.models.filter(function (name, index, all) { return name && all.indexOf(name) === index; });
    if (!names.length) return null;
    var prompt = '请用一句话回答：1+1 等于几？';
    var batch = {
      accountId: Api.AUTH.currentId(), keyId: key.id, keyName: key.name || U.maskKey(key.key),
      groupId: key.group_id, groupName: options.groupName, running: true, stopped: false,
      completed: 0, startedAt: Date.now(), finishedAt: null, parallel: Math.min(MAX_PARALLEL, names.length),
      items: names.map(function (name) {
        return Object.assign({ model: name, state: 'queued', prompt: prompt, output: '', error: '',
          cancelled: false, first: null, total: null }, usageMetrics(null));
      })
    };
    job = batch;
    var nextIndex = 0;
    var active = [];
    var token = key.key;
    function valid() { return job === batch && Api.AUTH.matches(context) && Api.AUTH.currentId() === batch.accountId; }
    function now() { return global.performance && global.performance.now ? global.performance.now() : Date.now(); }
    function endBatch() {
      if (batch.completed !== batch.items.length) return;
      batch.running = false;
      batch.finishedAt = Date.now();
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = 0;
      cancelRequests = null;
      token = null;
    }
    function run(item) {
      item.state = 'running';
      var began = now(), usage = {}, settled = false, transport = null;
      item.elapsedStartedAt = began;
      function finish(extra) {
        if (settled) return;
        settled = true;
        active.splice(active.indexOf(cancel), 1);
        Object.assign(item, usageMetrics(usage), extra || {});
        item.total = Math.max(0, now() - began);
        delete item.elapsedStartedAt;
        item.state = item.cancelled ? 'cancelled' : item.error ? 'error' : item.output ? 'complete' : 'empty';
        batch.completed++;
        endBatch();
        if (valid()) { pump(); notify(false); }
      }
      function cancel() {
        if (transport) transport.abort();
        finish({ cancelled: true });
      }
      active.push(cancel);
      try {
        transport = Api.chatStream({
          model: item.model, stream: true, stream_options: { include_usage: true }, max_tokens: 64,
          messages: [{ role: 'user', content: prompt }]
        }, token, {
          idleTimeoutMs: 120000,
          onEvent: function (data) {
            if (settled || !valid()) return;
            var latestKeys = global.S.keys || [];
            var latestKey = latestKeys.filter(function (candidate) { return String(candidate.id) === String(batch.keyId); })[0];
            if (!latestKey || latestKey.key !== token || String(latestKey.status || 'active') !== 'active' || String(latestKey.group_id || '') !== String(batch.groupId || '')) {
              if (transport) transport.abort();
              finish({ error: '令牌已失效或发生变化' });
              return;
            }
            if (data && data.error) {
              if (transport) transport.abort();
              finish({ error: String(data.error.message || data.error.msg || data.error || '请求失败').slice(0, 600) });
              return;
            }
            var choice = data && data.choices && data.choices[0];
            var nextUsage = data && data.usage || choice && choice.usage;
            if (nextUsage) {
              usage = Object.assign({}, usage, nextUsage);
              Object.assign(item, usageMetrics(usage));
            }
            var delta = choice && (choice.delta || choice.message) || {};
            var part = delta.content;
            var piece = typeof part === 'string' ? part : Array.isArray(part) ? part.map(function (value) { return value && (value.text || value.content) || ''; }).join('') : '';
            var first = item.first === null && (piece.trim() || String(delta.reasoning_content || delta.reasoning || '').trim());
            if (first) item.first = Math.max(0, now() - began);
            if (piece && item.output.length < 2400) item.output += piece.slice(0, 2400 - item.output.length);
            if (first || nextUsage) notify(false);
          },
          onDone: function () { finish(); },
          onError: function (error, status) { finish({ error: String(error || ('HTTP ' + (status || '错误'))).slice(0, 600) }); }
        });
        if (settled && transport) transport.abort();
      } catch (error) { finish({ error: error.message || '请求失败' }); }
    }
    function pump() {
      if (!valid() || batch.stopped || !batch.running) return;
      while (active.length < MAX_PARALLEL && nextIndex < batch.items.length) run(batch.items[nextIndex++]);
    }
    cancelRequests = function () {
      batch.stopped = true;
      batch.items.forEach(function (item) {
        if (item.state !== 'queued') return;
        item.state = 'cancelled'; item.cancelled = true; batch.completed++;
      });
      active.slice().forEach(function (cancel) { cancel(); });
      endBatch();
      notify(true);
    };
    elapsedTimer = setInterval(function () {
      if (!valid() || !batch.running) return;
      var activeRequest = false;
      batch.items.forEach(function (item) {
        if (item.state !== 'running' || item.elapsedStartedAt == null) return;
        item.total = Math.max(0, now() - item.elapsedStartedAt);
        activeRequest = true;
      });
      if (activeRequest) notify(false);
    }, 250);
    pump();
    notify(true);
    return batch;
  }

  function stop() { if (cancelRequests) cancelRequests(); }
  global.addEventListener('pp:auth-changed', function () {
    stop(); job = null; notify(true);
  });
  global.addEventListener('pp:keys-updated', function (event) {
    var batch = current(), detail = event.detail || {};
    if (!batch || !batch.running || detail.account !== batch.accountId || !Array.isArray(detail.items)) return;
    var key = detail.items.filter(function (item) { return String(item.id) === String(batch.keyId); })[0];
    if (!key || String(key.status || 'active') !== 'active' || String(key.group_id || '') !== String(batch.groupId || '')) stop();
  });
  global.PagesChatTests = { current: current, start: start, stop: stop, maxParallel: MAX_PARALLEL };
})(window);
