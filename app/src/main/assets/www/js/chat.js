/* Chat workspace: message branches, resilient streaming, history and settings. */
(function (global) {
  'use strict';

  var U = global.U;
  var C = global.PagesCore;
  var Store = global.PagesChatStore;
  var Tests = global.PagesChatTests;
  var h = C.h;
  var emptyState = C.emptyState;
  var pick = C.pick;
  var arrOf = C.arrOf;
  var activeChat = null;
  var SUGGESTS = [
    '用一句话解释量子纠缠',
    '帮我写一封简短的请假邮件',
    '把这段代码改成 Python 并解释',
    '给新产品起 10 个中文名字'
  ];
  global.addEventListener('pp:auth-changed', function () {
    if (activeChat) activeChat();
    activeChat = null;
  });

  var markdown = null;
  if (global.markdownit && global.texmath && global.katex) {
    markdown = global.markdownit({ html: false, linkify: false, breaks: true })
      .use(global.texmath, {
        engine: global.katex,
        delimiters: ['dollars', 'brackets'],
        katexOptions: { trust: false, maxExpand: 100, maxSize: 20, throwOnError: false }
      });
    markdown.validateLink = function (url) { return /^(https?:\/\/|mailto:)/i.test(url); };
    markdown.renderer.rules.image = function (tokens, idx) {
      return U.esc(tokens[idx].content || '图片');
    };
    markdown.renderer.rules.fence = function (tokens, idx) {
      var token = tokens[idx];
      var lang = String(token.info || '').trim().split(/\s+/)[0] || '代码';
      return '<div class="chat-code"><div class="chat-code-head"><span>' + U.esc(lang) +
        '</span><button type="button" class="chat-code-copy" aria-label="复制代码" title="复制代码">' +
        U.ic('copy', 15) + '</button></div><pre><code>' + U.esc(token.content) + '</code></pre></div>';
    };
    markdown.inline.ruler.before('escape', 'chat_math_brackets', function (state, silent) {
      var opening = state.src.slice(state.pos, state.pos + 2);
      if (opening !== '\\[' && opening !== '\\(') return false;
      var closing = opening === '\\[' ? '\\]' : '\\)';
      var end = state.src.indexOf(closing, state.pos + 2);
      var nextOpen = state.src.indexOf(opening, state.pos + 2);
      var newline = state.src.indexOf('\n', state.pos + 2);
      if (end >= 0 && ((nextOpen >= 0 && nextOpen < end) ||
          (opening === '\\(' && newline >= 0 && newline < end))) end = -1;
      if (end >= 0 && opening === '\\[') {
        if (!silent) {
          var token = state.push('chat_math_display', '', 0);
          token.content = state.src.slice(state.pos + 2, end);
        }
        state.pos = end + 2;
        return true;
      }
      if (end >= 0) return false;
      if (!silent) state.pending += opening;
      state.pos += 2;
      return true;
    });
    markdown.renderer.rules.chat_math_display = function (tokens, idx) {
      return '<span class="chat-math-display">' + global.texmath.render(tokens[idx].content, true,
        { trust: false, maxExpand: 100, maxSize: 20, throwOnError: false }) + '</span>';
    };
  }

  function md(text) {
    try { return markdown ? markdown.render(String(text || '')) : U.esc(text || ''); }
    catch (e) { return U.esc(text || ''); }
  }

  // Estimated locally for context budgeting, not presented as billing usage.
  function estimateText(text) {
    var ascii = 0, other = 0;
    Array.from(String(text || '')).forEach(function (character) {
      if (character.charCodeAt(0) < 128) ascii++;
      else other++;
    });
    return Math.ceil(ascii / 4 + other * 1.3);
  }

  function isImageModel(name) {
    return /(gpt-image|dall-?e|flux|seedream|imagen|wanx|qwen-image|nano-banana|midjourney|ideogram|recraft)/i.test(String(name || ''));
  }

  function imageDataUri(value) {
    var base64 = String(value || '').replace(/\s+/g, '');
    var mime = /^\/9j\//.test(base64) ? 'image/jpeg' :
      /^R0lGOD/.test(base64) ? 'image/gif' :
      /^UklGR/.test(base64) ? 'image/webp' : 'image/png';
    return 'data:' + mime + ';base64,' + base64;
  }

  function extractImage(data) {
    var items = (data && (data.data || data.images || data.output || data.results)) || [];
    if (!Array.isArray(items)) items = [items];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (typeof item === 'string') {
        if (/^(https?:|data:)/.test(item)) return item;
        continue;
      }
      if (!item) continue;
      var base64 = item.b64_json || item.base64 || item.image_base64 || item.b64;
      if (base64) return String(base64).indexOf('data:') === 0 ? base64 : imageDataUri(base64);
      var url = item.url || item.image_url || item.image || (item.image && item.image.url);
      if (url) return url;
    }
    return data && typeof data.url === 'string' ? data.url : '';
  }

  function extractText(data) {
    var choice = data && data.choices && data.choices[0];
    if (!choice) return data && typeof data.content === 'string' ? data.content : '';
    var content = choice.message && choice.message.content;
    if (Array.isArray(content)) {
      return content.map(function (part) {
        return typeof part === 'string' ? part : part && (part.text || part.content) || '';
      }).join('');
    }
    return String(content || choice.text || '');
  }

  function extractReasoning(data) {
    var choice = data && data.choices && data.choices[0];
    if (!choice) return '';
    var message = choice.delta || choice.message || {};
    return String(message.reasoning_content || message.reasoning || '');
  }

  function extractUsage(data) {
    if (!data || typeof data !== 'object') return null;
    return data.usage || (data.choices && data.choices[0] && data.choices[0].usage) || null;
  }

  function mergeUsage(previous, next) {
    if (!next || typeof next !== 'object') return previous || null;
    return Object.assign({}, previous || {}, next);
  }

  function prettyErr(error) {
    var text = String(error || '').trim();
    if (/^<(!doctype|html)/i.test(text)) return '服务返回了网页错误页（可能被网关或代理拦截）';
    try {
      var parsed = JSON.parse(text);
      if (parsed) {
        var message = parsed.error ?
          (typeof parsed.error === 'string' ? parsed.error : parsed.error.message || parsed.error.msg) :
          (parsed.message || parsed.msg);
        if (message) return String(message).slice(0, 300);
      }
    } catch (e) {}
    return text.slice(0, 300) || '请求失败';
  }

  function roleLabel(message) {
    return message.role === 'user' ? '我' : message.role === 'assistant' ? '助手' : '系统';
  }

  function summaryUsage(usage) {
    if (!usage) return '';
    var prompt = Number(usage.prompt_tokens || usage.input_tokens || 0);
    var completion = Number(usage.completion_tokens || usage.output_tokens || 0);
    var total = Number(usage.total_tokens || prompt + completion || 0);
    return total ? 'Tokens ' + U.num(prompt) + ' + ' + U.num(completion) + ' = ' + U.num(total) : '';
  }

  function timingLabel(message) {
    if (!message || !message.finishedAt || !message.createdAt) return '';
    var seconds = Math.max(0, (message.finishedAt - message.createdAt) / 1000);
    return seconds < .1 ? '' : seconds.toFixed(seconds < 10 ? 1 : 0) + 's';
  }

  function pageIconButton(icon, label, handler) {
    var button = h('button', {
      class: 'tool-btn', type: 'button', html: U.ic(icon, 18),
      'aria-label': label, title: label, onclick: handler
    });
    return button;
  }

  function actionButton(icon, label, handler, extraClass) {
    return h('button', {
      class: extraClass || '', type: 'button', title: label, 'aria-label': label,
      html: U.ic(icon, 15), onclick: function (event) {
        event.stopPropagation();
        handler(event);
      }
    });
  }

  function messageActions(items, className) {
    return h('div', { class: 'msg-actions ' + (className || '') }, items);
  }

  function renderChat() {
    if (!Api.AUTH.isLogged()) return global.PagesUser.needLogin();
    if (activeChat) activeChat();

    var authContext = Api.AUTH.context();
    var accountId = Api.AUTH.currentId();
    var state = Store.load(accountId);
    var session = Store.activeSession(state);
    if (!session) {
      session = Store.makeSession(global.S.chatModel);
      state.sessions.push(session);
      state.activeId = session.id;
      Store.save(accountId, state);
    }
    if (global.S.useSelectedChatModel && global.S.chatModel) {
      session.model = global.S.chatModel;
      global.S.useSelectedChatModel = false;
    }

    var disposed = false;
    var streaming = false;
    var draftTimer = 0;
    var saveTimer = 0;
    var scrollFrame = 0;
    var keys = global.S.keys || [];
    var modelList = [];
    var modelLimits = {};
    var modelLimitsKey = null;
    var plazaLimitSource = null;
    var plazaLimits = {};
    var modelsRun = 0;
    var runSeq = 0;
    var currentRun = null;
    var currentController = null;
    var testOverlay = null;
    var paintTestDialog = null;
    var storageWarningShown = false;

    function isCurrent() {
      return !disposed && Api.AUTH.matches(authContext) && Api.AUTH.currentId() === accountId;
    }

    function saveNow() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = 0;
      }
      session.updatedAt = Date.now();
      Store.save(accountId, state);
    }

    function saveSoon(delay) {
      if (saveTimer) return;
      saveTimer = global.setTimeout(function () {
        saveTimer = 0;
        if (!disposed) saveNow();
      }, delay || 240);
    }

    function abortGeneration(markStopped) {
      runSeq++;
      currentRun = null;
      if (currentController) {
        try { currentController.abort(); } catch (e) {}
        currentController = null;
      }
      if (!streaming) return;
      streaming = false;
      setBusy(false);
      var node = (session.nodes || []).filter(function (item) {
        return item.messages.some(function (message) { return message.pending; });
      }).pop();
      var message = node && Store.selected(node);
      if (message) {
        message.pending = false;
        message.stopped = !!markStopped;
        message.finishedAt = Date.now();
        if (!message.content && !message.image && !message.error) {
          message.content = markStopped ? '（已停止生成）' : '（连接已断开）';
        }
      }
      saveNow();
      paint();
    }

    activeChat = function () {
      if (disposed) return;
      if (testOverlay) testOverlay.close();
      abortGeneration(false);
      if (draftTimer) clearTimeout(draftTimer);
      if (saveTimer) clearTimeout(saveTimer);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      page.removeEventListener('pp:page-activate', onActivate);
      page.removeEventListener('pp:page-deactivate', onDeactivate);
      page.removeEventListener('pp:page-dispose', onDispose);
      global.removeEventListener('pp:keys-updated', onKeysUpdated);
      global.removeEventListener('pp:keys-changed', onKeysChanged);
      global.removeEventListener('pp:plaza-updated', onPlazaUpdated);
      global.removeEventListener('pp:chat-storage-warning', onStorageWarning);
      global.removeEventListener('pp:chat-test-updated', onTestUpdated);
      disposed = true;
    };

    var page = h('div', { class: 'page chat-wrap' });
    var msgsHost = h('div', { id: 'msgs', 'aria-live': 'polite' });
    var info = h('div', { class: 'composer-meta' });
    var tokenButton = h('button', {
      class: 'token-estimate-btn', type: 'button',
      'aria-label': '查看 Token 使用量估算'
    });
    var modelChip = h('button', { class: 'chip', type: 'button' },
      h('span', null, session.model || '选择模型'));
    var keyChip = h('button', { class: 'chip', type: 'button' }, h('span', null, '令牌'));
    var settingBtn = pageIconButton('settings', '对话设置', openSettings);
    var historyBtn = pageIconButton('clock', '历史对话', openHistory);
    var testBtn = h('button', {
      class: 'chat-test-trigger', type: 'button', title: '一键测试', 'aria-label': '一键测试',
      html: U.ic('activity', 17), onclick: openChatTest
    });

    page.appendChild(h('div', { class: 'chat-toolbar' },
      h('div', { class: 'chips' }, modelChip, keyChip), testBtn, settingBtn, historyBtn));
    page.appendChild(msgsHost);

    var input = h('textarea', {
      rows: '1', placeholder: '输入消息', 'aria-label': '输入消息',
      autocomplete: 'off', spellcheck: 'false'
    });
    input.value = session.draft || '';
    var send = h('button', {
      class: 'send-btn', type: 'button', html: U.ic('send', 18),
      'aria-label': '发送消息', title: '发送消息'
    });
    page.appendChild(h('div', { class: 'composer' },
      h('div', { class: 'composer-box' }, input, send),
      h('div', { class: 'composer-footer' }, info, tokenButton)));

    function activeKey() {
      return keys.filter(function (key) {
        return String(key.id) === String(session.keyId);
      })[0] || keys.filter(function (key) {
        return String(key.status) === 'active';
      })[0] || keys[0] || null;
    }

    function onTestUpdated() {
      var batch = Tests.current();
      testBtn.setAttribute('data-test-state', batch ? batch.running ? 'running' : 'complete' : 'idle');
      testBtn.title = batch ? batch.running ? '一键测试：正在测试' : '一键测试：测试已结束' : '一键测试';
      if (paintTestDialog) paintTestDialog();
    }

    function openChatTest() {
      if (testOverlay) return;
      var batch = Tests.current();
      var key = activeKey();
      var validKey = key && key.key && String(key.status || 'active') === 'active';
      if (!validKey && !batch) { U.toast('请先选择可用令牌', 'err'); return; }
      key = key || {};

      var groupKey = key.group_id == null || key.group_id === '' ? null : String(key.group_id);
      var groupNameKey = String((key.group && key.group.name) || pick(key, 'group_name') || '').trim().toLowerCase();
      var models = C.plazaModels(global.S.plaza).filter(function (model) {
        var sameGroup = groupKey !== null ? String(model.groupId || '') === groupKey :
          !!groupNameKey && String(model.group || '').trim().toLowerCase() === groupNameKey;
        return sameGroup && !isImageModel(model.name) && (!model.mode || model.mode === 'token');
      }).filter(function (model, index, all) {
        return all.findIndex(function (candidate) { return candidate.name === model.name; }) === index;
      });
      var groupName = pick(key, 'group_name') || (key.group && key.group.name) ||
        (global.S.groupNames && global.S.groupNames[key.group_id]) ||
        (models[0] && models[0].group) || (key.group_id ? '分组 #' + key.group_id : '默认分组');
      if (!models.length && !batch) {
        U.toast('当前分组没有可测试的文本模型', 'err');
        return;
      }

      var permittedNames = null;
      var groupMode = true;
      var selectedModel = '';
      var busy = false;
      var lastBatch = null;
      var overlay = null;
      function dialogCurrent() {
        return !!overlay && testOverlay === overlay && isCurrent() && App.isPageActive(page);
      }
      var content = h('div', { class: 'chat-test-panel' });
      var disclosure = h('div', { class: 'chat-test-disclosure' },
        h('strong', null, '测试会产生实际费用'),
        h('p', null, '仅测试当前令牌所属分组的可用文本模型，每个模型 1 次真实计费请求，失败不重试；最多 4 个并行。关闭此窗口或切换软件内页面不会停止测试。'));
      var scope = h('div', { class: 'chat-test-scope' });
      var scopeLabel = h('div', { class: 'chat-test-scope-label' });
      var modeButtons = h('div', { class: 'chat-test-modes' });
      var list = h('div', { class: 'chat-test-models' });
      var progress = h('div', { class: 'chat-test-progress', 'aria-live': 'polite' }, '尚未开始');
      var results = h('div', { class: 'chat-test-results' });
      var refreshButton;
      var stopButton;

      function inScope() {
        var available = permittedNames ? models.filter(function (model) { return permittedNames.indexOf(model.name) >= 0; }) : [];
        return groupMode ? available : available.filter(function (model) { return model.name === selectedModel; });
      }
      function paintScope() {
        var running = !!(Tests.current() && Tests.current().running);
        var available = permittedNames ? models.filter(function (model) { return permittedNames.indexOf(model.name) >= 0; }) : [];
        var scoped = inScope();
        scopeLabel.textContent = (groupMode ? '整个分组' : '单个模型') + ' · ' + groupName + ' · ' + scoped.length + ' 个请求';
        modeButtons.innerHTML = '';
        modeButtons.appendChild(h('button', {
          class: 'chat-test-mode' + (groupMode ? ' active' : ''), type: 'button',
          disabled: busy || running,
          'aria-pressed': groupMode ? 'true' : 'false', text: '整个分组',
          onclick: function () { groupMode = true; paintScope(); }
        }));
        modeButtons.appendChild(h('button', {
          class: 'chat-test-mode' + (!groupMode ? ' active' : ''), type: 'button',
          disabled: busy || running,
          'aria-pressed': !groupMode ? 'true' : 'false', text: '单个模型',
          onclick: function () { groupMode = false; if (!selectedModel && available.length) selectedModel = available[0].name; paintScope(); }
        }));
        list.innerHTML = '';
        if (!permittedNames) {
          list.appendChild(h('div', { class: 'chat-test-empty' }, '正在读取此令牌可用的模型…'));
        } else if (!available.length) {
          list.appendChild(h('div', { class: 'chat-test-empty' }, '令牌未返回此分组的可用模型'));
        } else {
          available.forEach(function (model) {
            if (groupMode) list.appendChild(h('div', { class: 'chat-test-model-name', text: model.name }));
            else list.appendChild(h('button', {
                class: 'chat-test-model' + (selectedModel === model.name ? ' active' : ''),
                type: 'button', 'aria-pressed': selectedModel === model.name ? 'true' : 'false',
                disabled: busy || running,
                text: model.name, onclick: function () { selectedModel = model.name; paintScope(); }
              }));
          });
        }
        refreshButton.disabled = busy || running || !scoped.length || !validKey;
        refreshButton.textContent = running ? '并行测试进行中…' : busy ? '等待确认…' : '开始测试 ' + scoped.length + ' 个模型';
      }
      function metric(value, suffix) {
        return value === null || value === undefined || !isFinite(Number(value)) ? '—' : U.num(Number(value)) + (suffix || '');
      }
      function seconds(value) {
        return value === null || value === undefined || !isFinite(Number(value)) ? '—' : (Number(value) / 1000).toFixed(2) + ' 秒';
      }
      function addResult(model, result) {
        var latency = { first: result.first, total: result.total };
        var levels = global.UsageAnalysis ? global.UsageAnalysis.latencyLevels(latency) : {};
        var pending = result.state === 'running' || result.state === 'queued';
        var label = pending ? result.state === 'running' ? '测试中' : '等待并发空位' : result.error ? '失败' : result.cancelled ? '已停止' : !result.output ? '无文本输出' : '完成';
        var output = result.error || result.output || (pending ? '等待模型响应…' : result.cancelled ? '已取消' : '无文本输出');
        results.appendChild(h('article', { class: 'chat-test-result' },
          h('div', { class: 'chat-test-result-head' }, h('strong', null, model), h('span', { class: 'badge ' + (result.error ? 'danger' : pending || result.cancelled ? '' : !result.output ? 'warn' : 'ok') }, label)),
          h('div', { class: 'chat-test-metrics' },
            h('div', null, h('span', null, '输入 Token'), h('strong', null, metric(result.inputTokens))),
            h('div', null, h('span', null, '输出 Token'), h('strong', null, metric(result.outputTokens))),
            h('div', null, h('span', null, '缓存读取'), h('strong', null, metric(result.cacheRead))),
            h('div', null, h('span', null, '缓存写入'), h('strong', null, metric(result.cacheWrite))),
            h('div', null, h('span', null, 'Token 合计'), h('strong', null, metric(result.totalTokens))),
            h('div', null, h('span', null, '首次输出 · 客户端'), h('strong', { class: 'latency-' + (levels.first || 'unknown') }, seconds(result.first))),
            h('div', null, h('span', null, '总耗时 · 客户端'), h('strong', { class: 'latency-' + (levels.total || 'unknown') }, seconds(result.total)))
          ),
          h('div', { class: 'chat-test-result-text' }, h('span', null, '输入'), h('p', null, result.prompt || '请用一句话回答：1+1 等于几？')),
          h('div', { class: 'chat-test-result-text' }, h('span', null, '输出'), h('p', null, output.slice(0, 1800) + (output.length > 1800 ? '…' : '')))
        ));
      }
      function paintResults() {
        var current = Tests.current();
        stopButton.hidden = !(current && current.running);
        if (current) {
          progress.textContent = current.running ? '正在并行测试 · ' + current.completed + '/' + current.items.length + ' 个模型 · 最多 ' + current.parallel + ' 并行' :
            current.stopped ? '测试已停止 · ' + current.completed + '/' + current.items.length + ' 个模型' : '测试完成 · ' + current.completed + '/' + current.items.length + ' 个模型';
          if (current !== lastBatch) {
            lastBatch = current;
            renderedStates = [];
            results.innerHTML = '';
          }
          current.items.forEach(function (item, index) {
            var signature = item.state + ':' + item.first + ':' + item.inputTokens + ':' + Math.floor((item.total || 0) / 250);
            if (renderedStates[index] === signature) return;
            var previous = results.children[index];
            addResult(item.model, item);
            if (previous) results.replaceChild(results.lastElementChild, previous);
            renderedStates[index] = signature;
          });
        }
        paintScope();
      }
      var renderedStates = [];
      function runTest() {
        if (busy || (Tests.current() && Tests.current().running) || !dialogCurrent()) return false;
        if (!permittedNames) { U.toast('请等待令牌模型列表加载完成', 'err'); return false; }
        var selected = inScope();
        if (!selected.length) { U.toast('没有可测试的模型', 'err'); return false; }
        busy = true;
        refreshButton.disabled = true;
        refreshButton.textContent = '等待确认…';
        progress.textContent = '等待确认计费测试…';
        U.confirm('确认发起计费测试', '将使用令牌「' + (key.name || U.maskKey(key.key)) + '」测试 ' + selected.length + ' 个模型，共 ' + selected.length + ' 次真实调用，最多 ' + Math.min(Tests.maxParallel, selected.length) + ' 个并行。每次调用都会按站内规则产生费用。关闭窗口或切换软件内页面后仍会继续，已发送的请求停止后也可能计费。', '确认并测试').then(function (confirmed) {
          busy = false;
          if (!confirmed || !dialogCurrent()) {
            paintScope();
            progress.textContent = confirmed ? '测试已关闭。' : '测试未开始，没有发起任何调用。';
            return;
          }
          var currentKey = keys.filter(function (candidate) { return String(candidate.id) === String(key.id); })[0];
          if (!currentKey || currentKey.key !== key.key || String(currentKey.status || 'active') !== 'active' || String(currentKey.group_id || '') !== String(key.group_id || '')) {
            progress.textContent = '令牌已发生变化，请关闭窗口后重新选择。'; paintScope(); return;
          }
          Tests.start({ key: currentKey, groupName: groupName, models: selected.map(function (model) { return model.name; }) });
          paintResults();
        });
        return false;
      }

      refreshButton = h('button', { class: 'btn btn-primary chat-test-start', type: 'button', text: '读取令牌可用模型', disabled: true });
      stopButton = h('button', { class: 'btn chat-test-stop', type: 'button', text: '停止测试', hidden: true, onclick: function () { Tests.stop(); } });
      content.appendChild(disclosure);
      content.appendChild(scope);
      scope.appendChild(scopeLabel);
      scope.appendChild(modeButtons);
      scope.appendChild(list);
      content.appendChild(refreshButton);
      content.appendChild(stopButton);
      content.appendChild(progress);
      content.appendChild(results);
      refreshButton.addEventListener('click', runTest);
      overlay = U.sheet({
        title: '一键测试', body: content,
        onClose: function () {
          if (testOverlay === overlay) testOverlay = null;
          if (paintTestDialog === paintResults) paintTestDialog = null;
        },
        actions: [{ label: '关闭' }]
      });
      testOverlay = overlay;
      paintTestDialog = paintResults;
      if (validKey) Api.modelsWithKey(key.key).then(function (response) {
        if (!dialogCurrent()) return;
        var items = Array.isArray(response) ? response : (response && (response.data || response.models)) || [];
        permittedNames = items.map(function (item) { return typeof item === 'string' ? item : String(item && (item.id || item.name) || ''); }).filter(Boolean);
        var firstModel = models.filter(function (model) { return permittedNames.indexOf(model.name) >= 0; })[0];
        selectedModel = firstModel ? firstModel.name : '';
        paintScope();
      }).catch(function (error) {
        if (!dialogCurrent()) return;
        permittedNames = [];
        progress.textContent = '无法确认此令牌可用的模型：' + prettyErr(error);
        paintScope();
      });
      paintResults();
    }

    function modelLimit() {
      if (modelLimits[session.model]) return modelLimits[session.model];
      if (plazaLimitSource !== global.S.plaza) {
        plazaLimitSource = global.S.plaza;
        plazaLimits = {};
        paintLimitSource(plazaLimitSource);
      }
      var values = plazaLimits[session.model] || [];
      return values.length === 1 ? values[0] : 0;
    }

    function paintLimitSource(source) {
      plazaLimits = {};
      C.plazaModels(source).forEach(function (model) {
        var value = Number(model.context);
        if (!(value > 0 && isFinite(value))) return;
        if (!plazaLimits[model.name]) plazaLimits[model.name] = [];
        if (plazaLimits[model.name].indexOf(value) < 0) plazaLimits[model.name].push(value);
      });
    }

    function estimate() {
      var image = isImageModel(session.model);
      var context = image ? { messages: [], omitted: 0, total: 0 } :
        Store.contextMessages(session, null, session.settings);
      var contextTokens = context.messages.reduce(function (total, message) {
        return total + estimateText(message.content) + 4;
      }, 0);
      var draftText = input.value.trim();
      var inputTokens = draftText ? estimateText(draftText) + 4 : 0;
      return {
        input: inputTokens,
        context: contextTokens,
        count: context.messages.length,
        omitted: context.omitted,
        total: contextTokens + inputTokens,
        limit: image ? 0 : modelLimit(),
        image: image
      };
    }

    function paintEstimate() {
      var value = estimate();
      tokenButton.textContent = 'Token 估算 · ' + U.num(value.total);
    }

    function paintInfo() {
      info.innerHTML = '';
      var key = activeKey();
      info.appendChild(h('span', { class: 'nowrap' }, session.model || '未选择模型'));
      info.appendChild(h('span', null, '·'));
      info.appendChild(h('span', { class: 'nowrap' },
        key ? ('令牌 ' + (key.name || U.maskKey(key.key))) : '未选择令牌'));
      if (isImageModel(session.model)) info.appendChild(h('span', { class: 'badge teal' }, '生图'));
      if (session.settings.systemPrompt) info.appendChild(h('span', { class: 'badge teal' }, '系统提示词'));
      var usage = estimate();
      if (usage.limit && !usage.image) {
        var ratio = Math.min(100, usage.total / usage.limit * 100);
        info.appendChild(h('span', {
          class: 'context-meter' + (ratio >= 90 ? ' danger' : ratio >= 70 ? ' warn' : ''),
          title: '上下文估算 ' + U.num(usage.total) + ' / ' + U.num(usage.limit),
          'aria-label': '上下文使用 ' + ratio.toFixed(0) + '%'
        }, h('i', { style: { width: ratio + '%' } })));
      }
      paintEstimate();
    }

    function openEstimate() {
      var value = estimate();
      var rows = [
        ['当前输入', '约 ' + U.num(value.input)],
        ['上下文', '约 ' + U.num(value.context)],
        ['上下文消息数', U.num(value.count)],
        ['自动裁剪', value.omitted ? value.omitted + ' 条较早消息' : '未触发'],
        ['总计', '约 ' + U.num(value.total)],
        ['模型限制', value.image ? '不适用' : value.limit ? U.num(value.limit) : '未知']
      ];
      U.sheet({
        title: 'Token 使用量估算',
        body: h('div', { class: 'token-details' },
          rows.map(function (row) {
            return h('div', { class: 'token-row' }, h('span', null, row[0]), h('strong', null, row[1]));
          }),
          h('p', { class: 'token-note' }, value.image ?
            '生图请求仅发送当前输入；图片用量无法在此估算。' :
            '根据实际发送上下文粗略估算。上游返回 usage 时，消息底部会显示精确值。')),
        actions: [{ label: '关闭' }]
      });
    }

    function nearBottom() {
      var main = document.querySelector('main');
      return !main || main.scrollHeight - main.scrollTop - main.clientHeight < 220;
    }

    function scrollToBottom(force) {
      if (!App.isPageActive(page) || (!force && !nearBottom())) return;
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(function () {
        scrollFrame = 0;
        var main = document.querySelector('main');
        if (main && App.isPageActive(page)) main.scrollTop = main.scrollHeight;
      });
    }

    function fillBubble(body, message) {
      body.innerHTML = '';
      if (message.pending && isImageModel(session.model) && !message.content) {
        body.appendChild(h('div', { class: 'img-wrap' }, h('div', { class: 'img-loading' })));
        body.appendChild(h('div', { class: 'tiny muted', style: { marginTop: '8px' } }, '正在生成图片…'));
        return;
      }
      if (message.reasoning) {
        var reasoning = h('details', { class: 'chat-reasoning' },
          h('summary', null, '思考过程'),
          h('div', { class: 'markdown-body reasoning-body', html: md(message.reasoning) }));
        body.appendChild(reasoning);
      }
      if (message.content) {
        body.appendChild(message.role === 'user' ?
          h('div', { class: 'bubble-text user-text' }, message.content) :
          h('div', { class: 'bubble-text markdown-body', html: md(message.content) }));
      }
      if (message.image) {
        var image = h('img', { class: 'gen', alt: '生成图片', src: message.image });
        image.addEventListener('click', function (event) {
          event.stopPropagation();
          U.sheet({
            title: '生成结果',
            body: h('div', null, h('img', { src: message.image, style: { width: '100%', borderRadius: '8px' } })),
            actions: [{ label: '关闭' }]
          });
        });
        body.appendChild(image);
      }
      if (message.error) {
        body.appendChild(h('div', { class: 'err-box' }, '⚠ ' + message.error));
        if (message.detail) body.appendChild(h('div', { class: 'err-detail' }, message.detail));
      }
      if (message.pending && !message.image) {
        body.appendChild(h('span', { class: 'typing', 'aria-label': '正在生成' }, h('i'), h('i'), h('i')));
      }
      if (!body.children.length) body.appendChild(h('span', { class: 'tiny muted' }, '（无内容）'));
    }

    function messageMeta(message) {
      var bits = [];
      if (message.role !== 'user') {
        if (message.model) bits.push(message.model);
        bits.push(U.datetime(message.finishedAt || message.createdAt));
        var timing = timingLabel(message);
        if (timing) bits.push('耗时 ' + timing);
        var usage = summaryUsage(message.usage);
        if (usage) bits.push(usage);
      }
      if (message.stopped) bits.push('已停止');
      if (message.favorite) bits.push('已收藏');
      if (!bits.length) return null;
      return h('div', { class: 'chat-message-meta' + (message.role === 'user' ? ' me' : '') },
        bits.map(function (bit) { return h('span', null, bit); }));
    }

    function candidateSwitcher(node, message) {
      if (!node || node.messages.length < 2) return null;
      function go(index) {
        if (streaming) return;
        Store.selectCandidate(node, index);
        session.updatedAt = Date.now();
        saveNow();
        paint();
      }
      return h('div', { class: 'message-branches', role: 'group', 'aria-label': '回答版本' },
        h('button', {
          type: 'button', 'aria-label': '上一个回答', title: '上一个回答',
          disabled: node.selectIndex <= 0 ? '' : null,
          onclick: function () { go(node.selectIndex - 1); }
        }, '‹'),
        h('span', { class: 'branch-count' }, (node.selectIndex + 1) + ' / ' + node.messages.length),
        h('button', {
          type: 'button', 'aria-label': '下一个回答', title: '下一个回答',
          disabled: node.selectIndex >= node.messages.length - 1 ? '' : null,
          onclick: function () { go(node.selectIndex + 1); }
        }, '›'));
    }

    function rowFor(node, message, index) {
      var isUser = message.role === 'user';
      var row = h('div', {
        class: 'bubble-row ' + (isUser ? 'me' : 'ai'),
        'data-node-id': node.id,
        'data-message-id': message.id
      });
      var body = h('div', { class: 'bubble' + (message.favorite ? ' is-favorite' : '') });
      fillBubble(body, message);
      if (!isUser) row.appendChild(h('div', {
        class: 'chat-avatar', 'aria-hidden': 'true', html: U.ic('sparkle', 16)
      }));
      row.appendChild(body);
      return row;
    }

    function messageMenu(node, message, index) {
      var options = [];
      function add(label, icon, handler, danger) {
        options.push(h('button', {
          class: 'list-item' + (danger ? ' text-danger' : ''), type: 'button',
          onclick: function () {
            U.closeOverlay();
            handler();
          }
        }, h('span', { class: 'li-icon', html: U.ic(icon, 17) }),
          h('div', { class: 'li-body' }, h('div', { class: 'li-title' }, label))));
      }
      add(message.favorite ? '取消收藏' : '收藏这条消息', 'star', function () {
        message.favorite = !message.favorite;
        saveNow();
        paint();
      });
      add('复制消息内容', 'copy', function () {
        U.copy(Store.messageText(message));
      });
      if (message.role === 'user' && !streaming) {
        add('编辑并创建新版本', 'edit', function () { editMessage(node, message); });
      }
      if (message.role === 'assistant' && !streaming) {
        add('重新生成这一条', 'refresh', function () {
          regenerateNode(node, false);
        });
        add('非流式重试', 'play', function () {
          regenerateNode(node, true);
        });
      }
      if (!message.pending && !streaming) {
        add('保留到这里并另建对话', 'branch', function () { branchFrom(node); });
      }
      if (node.messages.length > 1 && message.role === 'assistant') {
        add('删除当前回答版本', 'trash', function () { removeCandidate(node, message); }, true);
      } else {
        add('从对话中删除', 'trash', function () { deleteMessage(node, message); }, true);
      }
      U.sheet({ title: '消息操作', body: h('div', { class: 'chat-action-menu' }, options) });
    }

    function inlineActions(node, message) {
      if (message.pending) return null;
      var items = [];
      if (message.error && message.role === 'assistant') {
        items.push(h('button', {
          class: 'retry-action', type: 'button', title: '重试',
          'aria-label': '重试', onclick: function (event) {
            event.stopPropagation();
            regenerateNode(node, false);
          }
        }, U.ic('refresh', 14), h('span', null, '重试')));
        items.push(h('button', {
          class: 'retry-action', type: 'button', title: '非流式重试',
          'aria-label': '非流式重试', onclick: function (event) {
            event.stopPropagation();
            regenerateNode(node, true);
          }
        }, U.ic('play', 14), h('span', null, '非流式')));
      }
      items.push(actionButton('copy', '复制消息', function () {
        U.copy(Store.messageText(message));
      }));
      if (message.role === 'user' && !streaming) {
        items.push(actionButton('edit', '编辑并创建新版本', function () { editMessage(node, message); }));
      }
      if (message.role === 'assistant' && !streaming) {
        items.push(actionButton('refresh', '重新生成', function () { regenerateNode(node, false); }, 'retry-action'));
      }
      items.push(actionButton('more', '更多消息操作', function () {
        messageMenu(node, message);
      }));
      var actions = messageActions(items, message.role === 'user' ? 'me' : 'ai');
      actions.setAttribute('data-node-id', node.id);
      actions.setAttribute('data-message-id', message.id);
      return actions;
    }

    function paint() {
      msgsHost.innerHTML = '';
      if (!session.nodes.length) {
        var welcome = h('div', { class: 'chat-welcome' },
          h('div', { class: 'chat-welcome-icon', html: U.ic('chat', 25) }),
          h('h2', null, '开始新的对话'),
          h('p', null, session.model || '选择模型后开始'));
        msgsHost.appendChild(welcome);
        if (!keys.length) {
          welcome.appendChild(h('div', { class: 'chat-welcome-actions' },
            h('button', {
              class: 'btn btn-primary btn-sm', type: 'button',
              onclick: function () { App.go('#/keys'); }
            }, '创建我的第一个令牌')));
        } else {
          msgsHost.appendChild(h('div', { class: 'suggests' }, SUGGESTS.map(function (text) {
            return h('button', {
              class: 'suggest', type: 'button',
              onclick: function () {
                input.value = text;
                saveDraft();
                autoGrow();
                paintEstimate();
                input.focus();
              }
            }, text);
          })));
        }
      } else {
        session.nodes.forEach(function (node, index) {
          var message = Store.selected(node);
          if (!message) return;
          var row = rowFor(node, message, index);
          var switcher = candidateSwitcher(node, message);
          if (switcher) row.querySelector('.bubble').appendChild(switcher);
          var meta = messageMeta(message);
          if (meta) row.querySelector('.bubble').appendChild(meta);
          msgsHost.appendChild(row);
          var actions = inlineActions(node, message);
          if (actions) msgsHost.appendChild(actions);
        });
      }
      paintEstimate();
      paintInfo();
    }

    function saveDraft() {
      session.draft = input.value;
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = global.setTimeout(function () {
        draftTimer = 0;
        if (!disposed) Store.saveDraft(accountId, state, session.id, session.draft);
      }, 250);
    }

    function sendMessage() {
      if (streaming) {
        U.toast('正在生成，可先停止');
        return;
      }
      var text = input.value.trim();
      if (!text) return;
      if (!session.model) {
        U.toast('请先选择模型', 'err');
        selectModel();
        return;
      }
      if (!activeKey()) {
        U.toast('请先创建并选择令牌', 'err');
        return;
      }
      var node = Store.appendUserNode(session, text, {
        model: session.model,
        keyName: (activeKey() || {}).name || ''
      });
      input.value = '';
      session.draft = '';
      autoGrow();
      saveNow();
      paint();
      scrollToBottom(true);
      if (isImageModel(session.model)) runImage(node, text);
      else runCompletion(node, false, null);
    }

    function editablePrompt(node) {
      var message = Store.selected(node);
      if (!message || message.role !== 'user') return '';
      return message.content;
    }

    function editMessage(node, message) {
      if (streaming) return;
      var draft = h('textarea', { class: 'textarea chat-edit-input', rows: '5', 'aria-label': '编辑消息' });
      draft.value = message.content;
      U.sheet({
        title: '编辑并创建新版本',
        body: h('div', null, draft,
          h('p', { class: 'tiny muted' }, '旧问题和回答会保留，可在版本切换中找回。')),
        actions: [
          { label: '取消' },
          {
            label: '保存并重新生成', kind: 'primary', onClick: function () {
              var value = draft.value.trim();
              if (!value) { U.toast('消息不能为空', 'err'); return false; }
              var replacement = Store.normalizeMessage(Object.assign({}, message, {
                id: Store.uid('m'),
                content: value,
                error: '',
                detail: '',
                pending: false,
                stopped: false,
                createdAt: Date.now(),
                finishedAt: 0
              }), 'user');
              node.messages.push(replacement);
              node.selectIndex = node.messages.length - 1;
              session.nodes = session.nodes.slice(0, session.nodes.indexOf(node) + 1);
              if (!session.title || session.title === '新对话') session.title = Store.titleOf(session);
              saveNow();
              paint();
              if (isImageModel(session.model)) runImage(node, value);
              else runCompletion(node, false, null);
              return true;
            }
          }
        ]
      });
    }

    function deleteMessage(node, message) {
      U.confirm('删除消息', '这会从当前对话中移除这条消息，相关回答也会一并移除。', '删除', true)
        .then(function (ok) {
          if (!ok || !isCurrent()) return;
          Store.removeNode(session, node);
          saveNow();
          paint();
          U.toast('已删除消息', 'ok');
        });
    }

    function removeCandidate(node, message) {
      U.confirm('删除这个回答版本', '其他回答版本会保留。', '删除', true).then(function (ok) {
        if (!ok || !isCurrent()) return;
        Store.removeCandidate(node, message);
        saveNow();
        paint();
        U.toast('已删除回答版本', 'ok');
      });
    }

    function branchFrom(node) {
      var index = session.nodes.indexOf(node);
      if (index < 0) return;
      var copy = Store.makeSession(session.model, session.keyId);
      copy.title = Store.titleOf(session);
      copy.settings = Store.normalizeSettings(session.settings);
      copy.nodes = Store.clone(session.nodes.slice(0, index + 1));
      copy.draft = '';
      copy.createdAt = Date.now();
      copy.updatedAt = Date.now();
      state.sessions.unshift(copy);
      state.activeId = copy.id;
      saveNow();
      U.closeOverlay();
      App.go('#/chat', true);
    }

    function buildPayload(node, forceNonStream) {
      var upto = session.nodes.indexOf(node) + 1;
      var context = Store.contextMessages(session, upto, session.settings);
      var payload = { model: session.model, messages: context.messages, stream: !forceNonStream };
      var temperature = session.settings.temperature;
      if (temperature !== null && temperature !== '' && isFinite(Number(temperature))) {
        payload.temperature = Number(temperature);
      }
      var maxTokens = session.settings.maxTokens;
      if (maxTokens !== null && maxTokens !== '' && Number(maxTokens) > 0) {
        payload.max_tokens = Number(maxTokens);
      }
      return payload;
    }

    function setBusy(on) {
      streaming = on;
      send.innerHTML = on ? U.ic('close', 18) : U.ic('send', 18);
      send.setAttribute('aria-label', on ? '停止生成' : '发送消息');
      send.title = on ? '停止生成' : '发送消息';
      send.style.background = on ? 'var(--danger)' : '';
    }

    function setMessageContent(target, message, run) {
      if (!isCurrent() || !run || run.id !== currentRun || message.runId !== run.id) return;
      target.innerHTML = '';
      if (message.reasoning) {
        target.appendChild(h('details', { class: 'chat-reasoning', open: '' },
          h('summary', null, '思考过程'),
          h('div', { class: 'markdown-body reasoning-body', html: md(message.reasoning) })));
      }
      target.appendChild(message.content ?
        h('div', { class: 'bubble-text markdown-body', html: md(message.content) }) :
        h('span', { class: 'typing', 'aria-label': '正在生成' }, h('i'), h('i'), h('i')));
    }

    function runCompletion(promptNode, forceNonStream, existingNode) {
      if (disposed || !isCurrent()) return;
      var key = activeKey();
      if (!session.model) {
        U.toast('请先选择模型', 'err');
        selectModel();
        return;
      }
      if (!key) {
        U.toast('请先创建并选择令牌', 'err');
        return;
      }
      var node = existingNode ||
        Store.appendAssistantNode(session, promptNode, { model: session.model });
      var message = Store.selected(node);
      if (!message) return;
      var run = { id: Store.uid('run'), seq: ++runSeq };
      currentRun = run;
      message.pending = true;
      message.error = '';
      message.detail = '';
      message.model = session.model;
      message.keyName = key.name || '';
      message.runId = run.id;
      message.createdAt = Date.now();
      message.finishedAt = 0;
      saveNow();
      setBusy(true);
      paint();
      scrollToBottom(true);

      var targetRow = document.querySelector('.bubble-row[data-message-id="' + message.id + '"] .bubble');
      var frame = 0;
      var completed = false;
      var fallbackStarted = false;
      var payload = buildPayload(promptNode || node, forceNonStream);

      function stillCurrent() {
        return isCurrent() && currentRun === run && run.seq === runSeq;
      }
      function finish() {
        if (completed || !stillCurrent()) return;
        completed = true;
        message.pending = false;
        message.finishedAt = Date.now();
        currentRun = null;
        currentController = null;
        setBusy(false);
        saveNow();
        paint();
        scrollToBottom();
      }
      function fail(error, status, detail) {
        if (!stillCurrent()) return;
        completed = true;
        message.pending = false;
        message.error = prettyErr(error);
        message.detail = (detail ? detail + '\n' : '') +
          (status ? 'HTTP ' + status + '\n' : '') + String(error || '').slice(0, 700);
        message.finishedAt = Date.now();
        currentRun = null;
        currentController = null;
        setBusy(false);
        saveNow();
        paint();
        U.toast('生成失败，可从消息菜单重试', 'err');
      }
      function paintStream() {
        frame = 0;
        if (!stillCurrent() || !targetRow) return;
        setMessageContent(targetRow, message, run);
        paintEstimate();
        scrollToBottom();
      }
      function applyDelta(data) {
        if (!stillCurrent()) return;
        var choice = data && data.choices && data.choices[0];
        if (!choice) {
          var usage = extractUsage(data);
          if (usage) message.usage = mergeUsage(message.usage, usage);
          return;
        }
        var delta = choice.delta || choice.message || {};
        var content = typeof delta.content === 'string' ? delta.content : '';
        var reasoning = delta.reasoning_content || delta.reasoning || '';
        if (content) message.content += content;
        if (reasoning) message.reasoning += reasoning;
        if (choice.finish_reason) message.finishReason = choice.finish_reason;
        message.usage = mergeUsage(message.usage, extractUsage(data));
        if ((content || reasoning) && !frame) frame = global.setTimeout(paintStream, 48);
      }

      function nonStream(reason) {
        if (!stillCurrent() || fallbackStarted) return;
        fallbackStarted = true;
        if (currentController) {
          try { currentController.abort(); } catch (e) {}
          currentController = null;
        }
        var oncePayload = Object.assign({}, payload, { stream: false });
        Api.chatOnce(key.key, oncePayload).then(function (data) {
          if (!stillCurrent()) return;
          var text = extractText(data);
          var reasoning = extractReasoning(data);
          if (text) message.content = text;
          if (reasoning) message.reasoning = reasoning;
          message.usage = mergeUsage(message.usage, extractUsage(data));
          if (!text) {
            var image = extractImage(data);
            if (image) message.image = image;
            else throw new Error('接口未返回文本：' + JSON.stringify(data).slice(0, 200));
          }
          message.error = '';
          finish();
        }).catch(function (error) {
          fail(error.message || reason || '请求失败', error.status, '流式回退：' + reason);
        });
      }

      if (forceNonStream) {
        nonStream('主动使用非流式请求');
        return;
      }

      try {
        currentController = Api.chatStream(payload, key.key, {
          idleTimeoutMs: 90000,
          onEvent: function (data) {
            if (!stillCurrent() || completed) return;
            if (data && data.error) {
              fail(data.error.message || data.error, 0, '');
              return;
            }
            applyDelta(data);
          },
          onDone: function () {
            if (!stillCurrent()) return;
            if (!message.content && !message.reasoning && !message.image) {
              message.content = '（无内容返回）';
            }
            message.error = '';
            finish();
          },
          onError: function (error, status) {
            if (!stillCurrent()) return;
            if (!status || status === 0 || status >= 500 ||
                /超时|网络|timeout|network/i.test(String(error))) {
              nonStream(String(error));
              return;
            }
            fail(error, status, '流式请求失败');
          }
        });
      } catch (error) {
        nonStream(error.message || '无法建立流式连接');
      }
    }

    function runImage(promptNode, prompt) {
      var key = activeKey();
      if (!key) {
        U.toast('请先创建并选择令牌', 'err');
        return;
      }
      var node = Store.appendAssistantNode(session, promptNode, { model: session.model });
      var message = Store.selected(node);
      var run = { id: Store.uid('run'), seq: ++runSeq };
      currentRun = run;
      message.pending = true;
      message.runId = run.id;
      message.createdAt = Date.now();
      saveNow();
      setBusy(true);
      paint();
      scrollToBottom(true);

      function current() {
        return isCurrent() && currentRun === run && run.seq === runSeq;
      }
      function end() {
        if (!current()) return;
        message.pending = false;
        message.finishedAt = Date.now();
        currentRun = null;
        currentController = null;
        setBusy(false);
        saveNow();
        paint();
        scrollToBottom();
      }
      function failed(error, detail) {
        if (!current()) return;
        message.error = prettyErr(error);
        message.detail = String(detail || error || '').slice(0, 700);
        end();
        U.toast('图片生成失败', 'err');
      }
      function request(payload) {
        return Api.generateImage(key.key, payload).then(function (data) {
          if (!current()) return;
          var image = extractImage(data);
          if (!image) {
            var text = extractText(data);
            throw new Error(text || ('接口未返回图片：' + JSON.stringify(data).slice(0, 220)));
          }
          message.image = image;
          message.usage = mergeUsage(message.usage, extractUsage(data));
          var first = Array.isArray(data.data) ? (data.data[0] || {}) : {};
          if (first.revised_prompt) message.revision = String(first.revised_prompt);
          end();
        });
      }
      request({ model: session.model, prompt: prompt, n: 1, size: '1024x1024' })
        .catch(function (error) {
          if (!current()) return;
          if (/size|resolution|invalid|unsupported|unknown/i.test(String(error.message || ''))) {
            return request({ model: session.model, prompt: prompt })
              .catch(function (second) { failed(second.message || error.message, '模型：' + session.model); });
          }
          failed(error.message || '请求失败', '模型：' + session.model);
        });
    }

    function regenerateNode(node, forceNonStream) {
      if (streaming || !node) return;
      var index = session.nodes.indexOf(node);
      if (index < 0) return;
      var promptNode = null;
      var prompt = '';
      var selectedMessage = Store.selected(node);
      if (selectedMessage && selectedMessage.role === 'user') {
        promptNode = node;
        prompt = selectedMessage.content;
      } else if (selectedMessage && selectedMessage.role === 'assistant') {
        promptNode = session.nodes[index - 1];
        prompt = promptNode && editablePrompt(promptNode);
      }
      if (!promptNode || !prompt) {
        U.toast('找不到对应的用户消息', 'err');
        return;
      }
      if (selectedMessage && selectedMessage.role === 'user') {
        session.nodes = session.nodes.slice(0, index + 1);
        saveNow();
        paint();
        if (isImageModel(session.model)) runImage(promptNode, prompt);
        else runCompletion(promptNode, !!forceNonStream, null);
        return;
      }
      if (!selectedMessage || selectedMessage.role !== 'assistant') {
        U.toast('这条消息不能重新生成', 'err');
        return;
      }
      var newMessage = Store.normalizeMessage({
        role: 'assistant', content: '', pending: true,
        model: session.model, createdAt: Date.now()
      }, 'assistant');
      Store.addCandidate(node, newMessage);
      session.nodes = session.nodes.slice(0, index + 1);
      saveNow();
      paint();
      if (isImageModel(session.model)) runImage(promptNode, editablePrompt(promptNode));
      else runCompletion(promptNode, !!forceNonStream, node);
    }

    send.addEventListener('click', function () {
      if (streaming) {
        abortGeneration(true);
        U.toast('已停止生成', 'ok');
        return;
      }
      sendMessage();
    });
    input.addEventListener('input', function () {
      session.draft = input.value;
      saveDraft();
      autoGrow();
      paintEstimate();
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
      }
    });

    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.max(38, Math.min(120, input.scrollHeight)) + 'px';
      input.style.overflowY = input.scrollHeight > 120 ? 'auto' : 'hidden';
    }

    function selectModel() {
      if (!modelList.length) {
        loadModels(function () {
          if (modelList.length) selectModel();
          else U.toast('暂无可用模型', 'err');
        });
        return;
      }
      var search = h('input', { class: 'input', placeholder: '搜索模型…', style: { marginBottom: '10px' } });
      var host = h('div', { class: 'chat-model-picker' });
      function paintList() {
        var keyword = search.value.trim().toLowerCase();
        host.innerHTML = '';
        var list = modelList.filter(function (name) {
          return !keyword || name.toLowerCase().indexOf(keyword) >= 0;
        }).slice(0, 300);
        if (!list.length) host.appendChild(emptyState('没有匹配的模型', '', 'grid'));
        list.forEach(function (name) {
          host.appendChild(h('button', {
            class: 'list-item', type: 'button',
            onclick: function () {
              session.model = name;
              global.S.chatModel = name;
              saveNow();
              modelChip.firstChild.textContent = name;
              U.closeOverlay();
              paintInfo();
            }
          }, h('span', { class: 'li-icon', html: U.ic('sparkle', 16) }),
            h('div', { class: 'li-body' }, h('div', { class: 'li-title' }, name)),
            isImageModel(name) ? h('span', { class: 'badge teal' }, '生图') : null));
        });
      }
      search.addEventListener('input', paintList);
      paintList();
      U.sheet({ title: '选择模型（' + modelList.length + '）', body: h('div', null, search, host) });
    }

    function selectKey() {
      if (!keys.length) {
        App.go('#/keys');
        return;
      }
      var host = h('div', { class: 'chat-key-picker' });
      keys.forEach(function (key) {
        host.appendChild(h('button', {
          class: 'list-item', type: 'button',
          onclick: function () {
            session.keyId = key.id;
            saveNow();
            keyChip.firstChild.textContent = '令牌 · ' + (key.name || U.maskKey(key.key));
            U.closeOverlay();
            paintInfo();
            loadModels();
          }
        }, h('span', { class: 'li-icon', html: U.ic('key', 16) }),
          h('div', { class: 'li-body' },
            h('div', { class: 'li-title' }, key.name || '未命名'),
            h('div', { class: 'li-sub mono' }, U.maskKey(key.key || ''))),
          String(key.status) === 'active' ? h('span', { class: 'badge ok' }, '可用') :
            h('span', { class: 'badge' }, '已停用')));
      });
      U.sheet({ title: '选择令牌', body: host });
    }

    function applyModelList(list) {
      if (!isCurrent()) return;
      modelList = list.filter(Boolean);
      if (!session.model && modelList.length) {
        session.model = modelList[0];
        global.S.chatModel = session.model;
        modelChip.firstChild.textContent = session.model;
        saveNow();
      }
      paintInfo();
    }

    function loadModels(callback) {
      var key = activeKey();
      var run = ++modelsRun;
      var scopeKey = key ? String(key.id) + ':' + String(key.group_id || '') + ':' + key.key : '';
      if (modelLimitsKey !== scopeKey) {
        modelLimits = {};
        modelLimitsKey = scopeKey;
      }
      paintEstimate();
      function fallback() {
        if (!isCurrent() || run !== modelsRun) return;
        var names = [];
        C.plazaModels(global.S.plaza).forEach(function (model) {
          if (names.indexOf(model.name) < 0) names.push(model.name);
        });
        applyModelList(names);
        if (callback) callback();
      }
      if (!key) {
        fallback();
        return;
      }
      Api.modelsWithKey(key.key).then(function (data) {
        if (!isCurrent() || run !== modelsRun) return;
        var items = Array.isArray(data) ? data : (data && (data.data || data.models)) || [];
        var names = items.map(function (item) {
          return typeof item === 'string' ? item : item.id || item.name;
        }).filter(Boolean);
        modelLimits = {};
        items.forEach(function (item) {
          if (!item || typeof item !== 'object') return;
          var context = Number(pick(item, 'context_length', 'max_context_tokens', 'context_window'));
          if (context > 0 && isFinite(context)) modelLimits[item.id || item.name] = context;
        });
        if (!names.length) {
          fallback();
          return;
        }
        applyModelList(names);
        if (callback) callback();
      }).catch(fallback);
    }

    function openSettings() {
      var systemPrompt = h('textarea', {
        class: 'textarea', rows: '3', maxlength: '16000',
        placeholder: '告诉助手如何回答，例如：使用简洁的中文，先给出结论。'
      });
      systemPrompt.value = session.settings.systemPrompt || '';
      var temperature = h('input', {
        class: 'input', type: 'number', min: '0', max: '2', step: '0.1',
        placeholder: '模型默认（0–2）', inputmode: 'decimal'
      });
      temperature.value = session.settings.temperature === null ? '' : String(session.settings.temperature);
      var maxTokens = h('input', {
        class: 'input', type: 'number', min: '1', step: '1',
        placeholder: '模型默认', inputmode: 'numeric'
      });
      maxTokens.value = session.settings.maxTokens === null ? '' : String(session.settings.maxTokens);
      var maxContext = h('input', {
        class: 'input', type: 'number', min: '2', step: '1',
        placeholder: '默认 40', inputmode: 'numeric'
      });
      maxContext.value = String(session.settings.maxContext || 40);

      var body = h('div', null,
        h('div', { class: 'field' }, h('label', null, '系统提示词'), systemPrompt),
        h('div', { class: 'row', style: { gap: '10px' } },
          h('div', { class: 'field', style: { flex: '1' } }, h('label', null, '随机性 temperature'), temperature),
          h('div', { class: 'field', style: { flex: '1' } }, h('label', null, '最大输出 tokens'), maxTokens)),
        h('div', { class: 'field' }, h('label', null, '上下文消息上限'), maxContext,
          h('p', { class: 'field-help' }, '超出时自动保留最近的消息，并避免以孤立回答开头。')),
        h('div', { class: 'divider' }),
        h('div', { class: 'chat-settings-grid' },
          h('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: function () {
              U.confirm('清空当前对话', '只清空当前会话的消息，历史对话仍保留。', '清空', true)
                .then(function (ok) {
                  if (!ok || !isCurrent()) return;
                  Store.clearSession(session);
                  input.value = '';
                  saveNow();
                  U.closeOverlay();
                  paint();
                });
            }
          }, '清空对话'),
          h('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: exportMarkdown
          }, '复制 Markdown'),
          h('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: exportJson
          }, '导出 JSON'),
          h('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: importJson
          }, '导入 JSON')));

      U.sheet({
        title: '对话设置',
        body: body,
        actions: [
          { label: '取消' },
          {
            label: '保存', kind: 'primary', onClick: function () {
              session.settings.systemPrompt = systemPrompt.value.trim();
              var t = temperature.value.trim();
              session.settings.temperature = t === '' ? null : Math.max(0, Math.min(2, Number(t)));
              var m = maxTokens.value.trim();
              session.settings.maxTokens = m === '' ? null : Math.max(1, Math.floor(Number(m)));
              var c = maxContext.value.trim();
              session.settings.maxContext = c === '' ? 40 : Math.max(2, Math.floor(Number(c)));
              saveNow();
              paintInfo();
              U.toast('设置已保存', 'ok');
              return true;
            }
          }
        ]
      });
    }

    function exportMarkdown() {
      if (!session.nodes.length) {
        U.toast('还没有内容可复制');
        return;
      }
      var output = ['# ' + (session.title || '对话'), ''];
      if (session.settings.systemPrompt) output.push('> 系统提示词：' + session.settings.systemPrompt, '');
      session.nodes.forEach(function (node) {
        var message = Store.selected(node);
        if (!message) return;
        output.push('## ' + roleLabel(message), '', Store.messageText(message), '');
        if (message.usage) output.push('`' + summaryUsage(message.usage) + '`', '');
      });
      U.copy(output.join('\n'));
    }

    function exportJson() {
      var payload = {
        version: 3,
        exportedAt: new Date().toISOString(),
        sessions: Store.clone(state.sessions)
      };
      U.copy(JSON.stringify(payload, null, 2));
    }

    function importJson() {
      var field = h('textarea', {
        class: 'textarea', rows: '8',
        placeholder: '粘贴 Pp 对话 JSON'
      });
      U.sheet({
        title: '导入对话',
        body: h('div', null, field,
          h('p', { class: 'field-help' }, '导入会新增到当前账号，不会覆盖现有对话。')),
        actions: [
          { label: '取消' },
          {
            label: '导入', kind: 'primary', onClick: function () {
              var imported;
              try { imported = Store.importState(JSON.parse(field.value)); }
              catch (error) {
                U.toast(error.message || 'JSON 格式不正确', 'err');
                return false;
              }
              if (!imported.sessions.length) {
                U.toast('没有可导入的对话', 'err');
                return false;
              }
              imported.sessions.forEach(function (item) {
                item.id = Store.uid('c');
                state.sessions.push(item);
              });
              state.activeId = imported.sessions[0].id;
              saveNow();
              U.closeOverlay();
              App.go('#/chat', true);
              U.toast('已导入 ' + imported.sessions.length + ' 个对话', 'ok');
              return true;
            }
          }
        ]
      });
    }

    function openHistory() {
      var list = state.sessions.slice().sort(function (a, b) {
        return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt;
      });
      var search = h('input', {
        class: 'input chat-history-search', type: 'search',
        placeholder: '搜索历史对话', 'aria-label': '搜索历史对话'
      });
      var rows = h('div', { class: 'chat-history-list' });
      var host = h('div', null,
        h('div', { class: 'chat-history-head' },
          h('button', {
            class: 'btn btn-primary btn-block', type: 'button',
            onclick: function () {
              var next = Store.makeSession(session.model, session.keyId);
              state.sessions.unshift(next);
              state.activeId = next.id;
              saveNow();
              U.closeOverlay();
              App.go('#/chat', true);
            }
          }, '＋ 新对话'),
          h('button', {
            class: 'tool-btn', type: 'button', title: '导出全部对话',
            'aria-label': '导出全部对话', html: U.ic('doc', 18),
            onclick: function () { exportJson(); }
          })),
        search,
        rows);

      function paintList() {
        var query = search.value.trim().toLowerCase();
        rows.innerHTML = '';
        var visible = list.filter(function (item) {
          if (!query) return true;
          return String(item.title || '新对话').toLowerCase().indexOf(query) >= 0 ||
            Store.allText(item).toLowerCase().indexOf(query) >= 0;
        });
        if (!visible.length) {
          rows.appendChild(emptyState(query ? '没有找到相关对话' : '还没有历史对话',
            query ? '换个关键词试试' : '发起第一轮对话后会出现在这里', 'chat'));
          return;
        }
        visible.forEach(function (item) { rows.appendChild(historyRow(item)); });
      }

      function historyRow(item) {
        var isActive = item.id === session.id;
        var row = h('div', {
          class: 'list-item' + (item.pinned ? ' pinned' : ''),
          role: 'button', tabindex: '0',
          onclick: function () {
            state.activeId = item.id;
            saveNow();
            U.closeOverlay();
            App.go('#/chat', true);
          },
          onkeydown: function (event) {
            if (event.key === 'Enter' || event.key === ' ') event.currentTarget.click();
          }
        }, h('span', { class: 'li-icon', html: U.ic(isActive ? 'chat' : 'doc', 16) }),
          h('div', { class: 'li-body' },
            h('div', { class: 'li-title nowrap' },
              (item.pinned ? '置顶 · ' : '') + (item.title || '新对话')),
            h('div', { class: 'li-sub' },
              Store.sessionCount(state, item) + ' 条 · ' + U.ago(item.updatedAt))),
          isActive ? h('span', { class: 'badge teal' }, '当前') : null);
        var pin = h('button', {
          class: 'icon-btn', type: 'button', title: item.pinned ? '取消置顶' : '置顶对话',
          'aria-label': (item.pinned ? '取消置顶 ' : '置顶 ') + item.title,
          html: U.ic('pin', 16),
          onclick: function (event) {
            event.stopPropagation();
            item.pinned = !item.pinned;
            saveNow();
            paintList();
          }
        });
        var rename = h('button', {
          class: 'icon-btn', type: 'button', title: '重命名对话',
          'aria-label': '重命名 ' + item.title, html: U.ic('edit', 16),
          onclick: function (event) {
            event.stopPropagation();
            var name = h('input', { class: 'input', value: item.title, maxlength: '60', 'aria-label': '对话名称' });
            U.sheet({
              title: '重命名对话',
              body: name,
              actions: [
                { label: '取消' },
                {
                  label: '保存', kind: 'primary', onClick: function () {
                    var value = name.value.trim();
                    if (!value) {
                      U.toast('名称不能为空', 'err');
                      return false;
                    }
                    item.title = value;
                    item.updatedAt = Date.now();
                    saveNow();
                    paintList();
                    return true;
                  }
                }
              ]
            });
          }
        });
        var remove = h('button', {
          class: 'icon-btn', type: 'button', title: '删除对话',
          'aria-label': '删除 ' + item.title, html: U.ic('trash', 16),
          onclick: function (event) {
            event.stopPropagation();
            U.confirm('删除对话', '「' + item.title + '」将被永久删除。', '删除', true)
              .then(function (ok) {
                if (!ok || !isCurrent()) return;
                state.sessions = state.sessions.filter(function (candidate) {
                  return candidate.id !== item.id;
                });
                if (state.activeId === item.id) {
                  state.activeId = state.sessions[0] ? state.sessions[0].id : '';
                }
                saveNow();
                U.closeOverlay();
                App.go('#/chat', true);
              });
          }
        });
        row.appendChild(h('div', { class: 'li-tail' }, pin, rename, remove));
        return row;
      }

      search.addEventListener('input', paintList);
      paintList();
      U.sheet({ title: '历史对话', body: host });
    }

    modelChip.addEventListener('click', selectModel);
    keyChip.addEventListener('click', selectKey);
    tokenButton.addEventListener('click', openEstimate);
    settingBtn.addEventListener('click', openSettings);
    historyBtn.addEventListener('click', openHistory);

    msgsHost.addEventListener('click', function (event) {
      var codeCopy = event.target.closest('.chat-code-copy');
      if (codeCopy) {
        var code = codeCopy.closest('.chat-code').querySelector('pre code');
        if (code) U.copy(code.textContent);
        return;
      }
      var retry = event.target.closest('.retry-action');
      if (retry) {
        var nodeId = retry.closest('.msg-actions').getAttribute('data-node-id');
        var node = session.nodes.filter(function (item) { return item.id === nodeId; })[0];
        regenerateNode(node, retry.getAttribute('aria-label') === '非流式重试');
        return;
      }
      var link = event.target.closest('.markdown-body a');
      if (!link) return;
      event.preventDefault();
      var url = link.getAttribute('href') || '';
      if (!/^(https?:\/\/|mailto:)/i.test(url)) return;
      U.confirm('打开外部链接', url, '打开').then(function (ok) {
        if (!ok || !isCurrent()) return;
        if (global.Native && global.Native.open) global.Native.open(url);
        else global.open(url, '_blank', 'noopener,noreferrer');
      });
    });

    function updateKeys(items) {
      if (!isCurrent()) return;
      var hadKeys = keys.length > 0;
      keys = Array.isArray(items) ? items : [];
      global.S.keys = keys;
      var key = activeKey();
      if (key) {
        if (!session.keyId) {
          session.keyId = key.id;
          saveSoon();
        }
        keyChip.firstChild.textContent = '令牌 · ' + (key.name || U.maskKey(key.key));
      } else {
        keyChip.firstChild.textContent = '无可用令牌';
      }
      if (hadKeys !== (keys.length > 0) && !session.nodes.length) paint();
      paintInfo();
      loadModels(function () {
        if (session.model && !isImageModel(session.model)) paintInfo();
      });
    }

    function onPlazaUpdated(event) {
      if (!isCurrent()) return;
      var plaza = event && event.detail && event.detail.plaza;
      if (plaza) {
        plazaLimitSource = plaza;
        paintLimitSource(plazaLimitSource);
        paintInfo();
      }
    }

    function onKeysUpdated(event) {
      if (event.detail && event.detail.account === authContext.id && Array.isArray(event.detail.items)) {
        updateKeys(event.detail.items);
      }
    }
    function onKeysChanged() {
      if (!isCurrent()) return;
      Api.keys(1, 100).then(function (data) {
        if (isCurrent()) updateKeys(arrOf(data));
      }).catch(function () {});
    }
    function onStorageWarning(event) {
      if (storageWarningShown) return;
      storageWarningShown = true;
      U.toast(event.detail && event.detail.compact ?
        '聊天记录较多，已保留最近内容' : '聊天存储空间已满，请导出后清理', 'err');
    }
    function onActivate() {
      if (!isCurrent()) return;
      onTestUpdated();
      if (global.S.useSelectedChatModel && global.S.chatModel) {
        session.model = global.S.chatModel;
        global.S.useSelectedChatModel = false;
        modelChip.firstChild.textContent = session.model;
        saveSoon();
        paintInfo();
      }
    }
    function onDispose() {
      if (activeChat) activeChat();
      activeChat = null;
    }
    function onDeactivate() {
      if (testOverlay) testOverlay.close();
      if (input === document.activeElement) input.blur();
    }

    global.addEventListener('pp:keys-updated', onKeysUpdated);
    global.addEventListener('pp:keys-changed', onKeysChanged);
    global.addEventListener('pp:plaza-updated', onPlazaUpdated);
    global.addEventListener('pp:chat-storage-warning', onStorageWarning);
    global.addEventListener('pp:chat-test-updated', onTestUpdated);
    page.addEventListener('pp:page-activate', onActivate);
    page.addEventListener('pp:page-deactivate', onDeactivate);
    page.addEventListener('pp:page-dispose', onDispose);

    if (session.model) global.S.chatModel = session.model;
    onTestUpdated();
    modelChip.firstChild.textContent = session.model || '选择模型';
    autoGrow();
    paint();
    Api.keys(1, 100).then(function (data) {
      updateKeys(arrOf(data));
    }).catch(function () {
      if (!isCurrent()) return;
      keyChip.firstChild.textContent = '令牌加载失败';
    });

    return page;
  }

  function removeAccountData(accountId) {
    Store.remove(accountId);
  }

  global.PagesChat = {
    renderChat: renderChat,
    removeAccountData: removeAccountData
  };
})(window);
