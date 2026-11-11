/* 对话工作台：多会话历史、参数设置、流式输出 */
(function (global) {
  'use strict';
  var U = global.U;
  var C = global.PagesCore;
  var h = C.h, emptyState = C.emptyState, pick = C.pick, arrOf = C.arrOf;

  var STORE = 'chat_store_v2';
  var MAX_SESSIONS = 30;
  var activeChat = null;
  global.addEventListener('pp:auth-changed', function () {
    if (activeChat) activeChat();
    activeChat = null;
  });
  var SUGGESTS = [
    '用一句话解释量子纠缠',
    '帮我写一封简短的请假邮件',
    '把这段代码改成 Python 并解释',
    '给新产品起 10 个中文名字'
  ];

  function md(text) {
    var s = U.esc(text || '');
    s = s.replace(/```([\s\S]*?)```/g, function (m, code) {
      return '<pre>' + code.replace(/^\n+|\n+$/g, '') + '</pre>';
    });
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/^###\s+(.+)$/gm, '<b>$1</b>');
    s = s.replace(/^##\s+(.+)$/gm, '<b>$1</b>');
    return s;
  }

  function newId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function makeSession(model, keyId) {
    return {
      id: newId(),
      title: '新对话',
      messages: [],
      model: model || '',
      keyId: keyId || 0,
      settings: { systemPrompt: '', temperature: null, maxTokens: null },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  function titleOf(messages) {
    var first = messages.filter(function (m) { return m.role === 'user'; })[0];
    if (!first) return '新对话';
    var t = String(first.content || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 22) || '新对话';
  }

  function loadState(storeKey) {
    var st = U.store.get(storeKey, null);
    if (!st || !Array.isArray(st.sessions)) {
      var legacyOwner = U.store.get('chat_legacy_owner', '');
      var canMigrate = !!legacyOwner && legacyOwner === Api.AUTH.currentId();
      st = canMigrate ? U.store.get(STORE, null) : null;
      if (!st || !Array.isArray(st.sessions)) st = { activeId: '', sessions: [] };
      var legacy = canMigrate && !st.sessions.length ? U.store.get('chat_messages', []) : [];
      if (Array.isArray(legacy) && legacy.length) {
        var s = makeSession();
        s.messages = legacy.filter(function (m) { return m && m.role; });
        s.title = titleOf(s.messages);
        st.sessions.push(s);
        st.activeId = s.id;
      }
    }
    st.sessions = st.sessions.filter(function (s) { return s && Array.isArray(s.messages); });
    st.sessions.forEach(function (s) {
      s.settings = s.settings || { systemPrompt: '', temperature: null, maxTokens: null };
      s.settings.systemPrompt = s.settings.systemPrompt || '';
      if (s.settings.temperature === undefined) s.settings.temperature = null;
      if (s.settings.maxTokens === undefined) s.settings.maxTokens = null;
    });
    return st;
  }

  function renderChat() {
    if (!Api.AUTH.isLogged()) return global.PagesUser.needLogin();
    if (activeChat) activeChat();

    var authContext = Api.AUTH.context();
    var storeKey = STORE + ':' + encodeURIComponent(Api.AUTH.currentId());
    var state = loadState(storeKey);
    var session = state.sessions.filter(function (s) { return s.id === state.activeId; })[0];
    if (!session) {
      session = state.sessions[0] || makeSession(global.S.chatModel);
      if (!state.sessions.length) state.sessions.push(session);
      state.activeId = session.id;
    }
    if (global.S.useSelectedChatModel && global.S.chatModel) {
      session.model = global.S.chatModel;
      global.S.useSelectedChatModel = false;
    }

    var streaming = false;
    var controller = null;
    var keys = global.S.keys || [];
    var modelList = [];
    var stopped = false;
    var disposed = false;
    var imageRun = 0;

    function isCurrent() { return !disposed && Api.AUTH.matches(authContext); }
    activeChat = function () {
      if (disposed) return;
      stopped = true;
      imageRun++;
      if (controller) { try { controller.abort(); } catch (e) {} }
      if (streaming) {
        var last = session.messages[session.messages.length - 1];
        if (last && last.role === 'assistant') {
          last.pending = false;
          if (!last.content && !last.image && !last.error) last.content = '（已停止）';
          save();
        }
      }
      disposed = true;
    };

    function save() {
      session.updatedAt = Date.now();
      state.sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      state.sessions = state.sessions.slice(0, MAX_SESSIONS);
      U.store.set(storeKey, state);
    }
    save();

    // ---------- shell ----------
    var page = h('div', { class: 'page chat-wrap' });
    var msgsHost = h('div', { id: 'msgs' });
    var info = h('div', { class: 'composer-meta' });

    var modelChip = h('button', { class: 'chip' }, h('span', null, session.model || '选择模型'));
    var keyChip = h('button', { class: 'chip' }, h('span', null, '令牌'));
    var settingBtn = h('button', { class: 'tool-btn', html: U.ic('settings', 18), 'aria-label': '对话设置' });
    var historyBtn = h('button', { class: 'tool-btn', html: U.ic('clock', 18), 'aria-label': '历史对话' });

    page.appendChild(h('div', { class: 'chat-toolbar' },
      h('div', { class: 'chips' }, modelChip, keyChip),
      settingBtn, historyBtn
    ));
    page.appendChild(msgsHost);

    var input = h('textarea', { rows: '1', placeholder: '输入消息，Shift+Enter 换行' });
    var send = h('button', { class: 'send-btn', html: U.ic('send', 18) });
    page.appendChild(h('div', { class: 'composer' },
      h('div', { class: 'composer-box' }, input, send), info));

    // ---------- helpers ----------
    function activeKey() {
      return keys.filter(function (k) { return String(k.id) === String(session.keyId); })[0] ||
        keys.filter(function (k) { return String(k.status) === 'active'; })[0] || keys[0] || null;
    }

    function paintInfo() {
      info.innerHTML = '';
      var key = activeKey();
      info.appendChild(h('span', { class: 'nowrap' }, session.model || '未选择模型'));
      info.appendChild(h('span', null, '·'));
      info.appendChild(h('span', { class: 'nowrap' }, key ? ('令牌 ' + (key.name || U.maskKey(key.key))) : '未选择令牌'));
      if (isImageModel(session.model)) {
        info.appendChild(h('span', { class: 'badge teal', style: { flex: '0 0 auto' } }, '生图'));
      }
      if (session.settings.systemPrompt) {
        info.appendChild(h('span', { class: 'badge teal', style: { marginLeft: 'auto' } }, '已设系统提示词'));
      }
    }

    function scrollBottom(force) {
      if (!App.isPageActive(page)) return;
      var main = document.querySelector('main');
      if (!main) return;
      var near = main.scrollHeight - main.scrollTop - main.clientHeight < 200;
      if (force || near) main.scrollTop = main.scrollHeight;
    }

    function isImageModel(name) {
      return /(gpt-image|dall-?e|flux|seedream|imagen|wanx|qwen-image|nano-banana|midjourney|ideogram|recraft)/i.test(String(name || ''));
    }

    function extractImage(d) {
      var arr = (d && (d.data || d.images || d.output || d.results)) || [];
      if (!Array.isArray(arr)) arr = [arr];
      for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        if (typeof it === 'string') {
          if (/^(https?:|data:)/.test(it)) return it;
          continue;
        }
        if (!it) continue;
        var b64 = it.b64_json || it.base64 || it.image_base64 || it.b64;
        if (b64) return String(b64).indexOf('data:') === 0 ? b64 : 'data:image/png;base64,' + b64;
        var u = it.url || it.image_url || it.image || (it.image && it.image.url);
        if (u) return u;
      }
      if (d && typeof d.url === 'string') return d.url;
      return '';
    }

    function extractText(d) {
      var c = d && d.choices && d.choices[0];
      if (c) return (c.message && c.message.content) || c.text || '';
      if (d && typeof d.content === 'string') return d.content;
      return '';
    }

    function prettyErr(err) {
      var s = String(err || '').trim();
      if (/^<(!doctype|html)/i.test(s)) return '服务返回了网页错误页（可能被网关/代理拦截，或该模型不支持此接口）';
      try {
        var j = JSON.parse(s);
        if (j) {
          if (j.error) return (typeof j.error === 'string' ? j.error : (j.error.message || j.error.msg || JSON.stringify(j.error))).slice(0, 300);
          if (j.message) return String(j.message).slice(0, 300);
        }
      } catch (e) {}
      return s.slice(0, 300) || '请求失败';
    }

    function fillBubble(body, msg) {
      body.innerHTML = '';
      if (msg.pending) {
        body.appendChild(h('div', { class: 'img-wrap' }, h('div', { class: 'img-loading' })));
        body.appendChild(h('div', { class: 'tiny muted', style: { marginTop: '8px' } }, '正在生成图片…'));
        return;
      }
      if (msg.content) {
        body.appendChild(h('div', { class: 'bubble-text', html: md(msg.content) }));
      }
      if (msg.image) {
        var img = h('img', { class: 'gen', alt: '生成图片', src: msg.image });
        img.addEventListener('click', function (e) {
          e.stopPropagation();
          U.sheet({
            title: '生成结果',
            body: h('div', null, h('img', { src: msg.image, style: { width: '100%', borderRadius: '14px' } })),
            actions: [{ label: '关闭' }]
          });
        });
        body.appendChild(img);
      }
      if (msg.error) {
        body.appendChild(h('div', { class: 'err-box' }, '⚠ ' + msg.error));
        if (msg.detail) body.appendChild(h('div', { class: 'err-detail' }, msg.detail));
      }
    }

    function bubble(msg) {
      var isUser = msg.role === 'user';
      var row = h('div', { class: 'bubble-row ' + (isUser ? 'me' : 'ai') });
      var body = h('div', { class: 'bubble' });
      fillBubble(body, msg);
      body.addEventListener('click', function (e) {
        if (e.target && e.target.tagName === 'IMG') return;
        if (msg.content) U.copy(msg.content);
      });
      row.appendChild(body);
      return row;
    }

    function paint() {
      msgsHost.innerHTML = '';
      if (!session.messages.length) {
        msgsHost.appendChild(h('div', { style: { paddingTop: '28px' } },
          emptyState('开始新的对话', '选好模型与令牌，直接提问。消息走官方 /v1 接口，按实际 token 计费。', 'chat')));
        if (!keys.length) {
          msgsHost.appendChild(h('div', { style: { textAlign: 'center', marginTop: '-12px' } },
            h('button', { class: 'btn btn-primary btn-sm', onclick: function () { App.go('#/keys'); } }, '创建我的第一个令牌')));
        } else {
          msgsHost.appendChild(h('div', { class: 'suggests' }, SUGGESTS.map(function (t) {
            return h('button', {
              class: 'suggest',
              onclick: function () { input.value = t; autoGrow(); input.focus(); }
            }, t);
          })));
        }
        return;
      }
      session.messages.forEach(function (m, i) {
        msgsHost.appendChild(bubble(m));
        var last = i === session.messages.length - 1;
        if (m.role !== 'user' && last && !streaming && !m.pending) {
          var actions = [];
          if (m.content) actions.push(h('button', { onclick: function () { U.copy(m.content); } }, '复制'));
          if (m.error) {
            actions.push(h('button', { onclick: regenerate }, '重试'));
            actions.push(h('button', { onclick: regenerateStreaming }, '非流式重试'));
          } else {
            actions.push(h('button', { onclick: regenerate }, m.image ? '再生成一张' : '重新生成'));
          }
          if (actions.length) msgsHost.appendChild(h('div', { class: 'msg-actions' }, actions));
        }
      });
      scrollBottom(true);
    }

    function persistAndPaint() {
      if (!session.title || session.title === '新对话') session.title = titleOf(session.messages);
      save();
      paint();
    }

    // ---------- request payload ----------
    function buildPayload(upto) {
      var msgs = session.messages.slice(0, upto)
        .filter(function (m) { return m.content && m.content.length > 0; })
        .map(function (m) { return { role: m.role, content: m.content }; });
      if (session.settings.systemPrompt) {
        msgs.unshift({ role: 'system', content: session.settings.systemPrompt });
      }
      var p = { model: session.model, messages: msgs, stream: true };
      var t = session.settings.temperature;
      if (t !== null && t !== '' && isFinite(Number(t))) p.temperature = Number(t);
      var m = session.settings.maxTokens;
      if (m !== null && m !== '' && Number(m) > 0) p.max_tokens = Number(m);
      return p;
    }

    function setBusy(on) {
      streaming = on;
      send.innerHTML = on ? U.ic('close', 18) : U.ic('send', 18);
      send.style.background = on ? 'var(--danger)' : '';
    }

    // ---------- text chat (SSE, with non-stream fallback) ----------
    function runCompletion(forceNonStream) {
      var key = activeKey();
      if (!session.model) { U.toast('请先选择模型', 'err'); selectModel(); return; }
      if (!key) { U.toast('请先创建并选择令牌', 'err'); return; }
      controller = null;

      var aiMsg = { role: 'assistant', content: '' };
      session.messages.push(aiMsg);
      save();
      var row = bubble(aiMsg);
      var target = row.querySelector('.bubble');
      target.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
      msgsHost.appendChild(row);
      scrollBottom(true);
      setBusy(true);
      stopped = false;

      var payload = buildPayload(session.messages.length - 1);
      var done = false;

      function fail(err, status, detail) {
        aiMsg.error = prettyErr(err);
        aiMsg.detail = (detail ? detail + '\n' : '') + (status ? 'HTTP ' + status + '\n' : '') +
          String(err || '').slice(0, 700);
        persistAndPaint();
        U.toast('生成失败，可点「重试」', 'err');
      }

      function ok(text) {
        aiMsg.content = text;
        aiMsg.error = null;
        aiMsg.detail = '';
        persistAndPaint();
      }

      function nonStreamFallback(reason) {
        if (done) return;
        done = true;
        Api.chatOnce(key.key, payload).then(function (d) {
          if (stopped || !isCurrent()) return;
          var text = extractText(d);
          if (!text) {
            var img = extractImage(d);
            if (img) { aiMsg.image = img; aiMsg.content = ''; persistAndPaint(); return; }
            throw new Error('接口未返回文本：' + JSON.stringify(d).slice(0, 200));
          }
          ok(text);
        }).catch(function (e) {
          if (stopped || !isCurrent()) return;
          fail(e.message || '请求失败', e.status || 0, '流式失败：' + reason + '\n非流式回退失败：' + (e.message || ''));
        }).then(function () {
          if (isCurrent()) setBusy(false);
        });
      }

      function finish(err, status, detail) {
        if (done || !isCurrent()) return;
        if (!err) {
          done = true;
          setBusy(false);
          if (!aiMsg.content) {
            aiMsg.content = '（无内容返回）';
            persistAndPaint();
          } else {
            persistAndPaint();
          }
          scrollBottom();
          return;
        }
        if (stopped) {
          done = true;
          setBusy(false);
          if (!aiMsg.content) aiMsg.content = '（已停止）';
          persistAndPaint();
          scrollBottom();
          return;
        }
        // retry once without streaming for transport-ish failures
        var retryable = !status || status === 0 || status >= 500 || /网络|超时|timed? ?out|network/i.test(String(err));
        if (retryable) {
          nonStreamFallback(String(err) + (status ? ' (' + status + ')' : ''));
          return;
        }
        done = true;
        setBusy(false);
        fail(err, status, detail);
      }

      if (forceNonStream) {
        nonStreamFallback('手动选择非流式');
        return;
      }

      controller = Api.chatStream(payload, key.key, {
        onEvent: function (j) {
          if (!isCurrent()) return;
          var choice = j && j.choices && j.choices[0];
          if (!choice) {
            if (j && j.error) finish((j.error && j.error.message) || '上游返回错误', 0, '');
            return;
          }
          var d = choice.delta || choice.message || {};
          var chunk = d.content || d.reasoning_content || '';
          if (chunk) {
            aiMsg.content += chunk;
            target.innerHTML = md(aiMsg.content);
            scrollBottom();
          }
        },
        onDone: function () { finish(null); },
        onError: function (msg, status) { finish(msg || '网络错误', status); }
      });

      setTimeout(function () {
        if (isCurrent() && streaming && !done) {
          try { controller.abort(); } catch (e) {}
          finish('请求超时', 0);
        }
      }, 180000);
    }

    // ---------- image generation ----------
    function runImage(prompt) {
      var key = activeKey();
      if (!key) { U.toast('请先创建并选择令牌', 'err'); return; }
      controller = null;
      var run = ++imageRun;
      var aiMsg = { role: 'assistant', content: '', pending: true };
      session.messages.push(aiMsg);
      save();
      paint();
      setBusy(true);

      function end() {
        if (run !== imageRun || !isCurrent()) return;
        aiMsg.pending = false;
        setBusy(false);
        persistAndPaint();
        scrollBottom();
      }

      function done(img, revised) {
        if (run !== imageRun || !isCurrent()) return;
        aiMsg.image = img;
        if (revised && typeof revised === 'string') aiMsg.content = '';
        end();
      }

      function failed(err, detail) {
        if (run !== imageRun || !isCurrent()) return;
        aiMsg.error = prettyErr(err);
        aiMsg.detail = (detail ? detail + '\n' : '') + String(err || '').slice(0, 700);
        end();
        U.toast('图片生成失败', 'err');
      }

      function call(payload) {
        return Api.generateImage(key.key, payload).then(function (d) {
          var img = extractImage(d);
          if (!img) {
            var t = extractText(d);
            throw new Error(t || ('接口未返回图片：' + JSON.stringify(d).slice(0, 220)));
          }
          var arr = (d && d.data) || [];
          var first = Array.isArray(arr) ? (arr[0] || {}) : {};
          done(img, first.revised_prompt);
        });
      }

      var base = { model: session.model, prompt: prompt, n: 1, size: '1024x1024' };
      call(base).catch(function (e) {
        if (!isCurrent()) return;
        var msg = String(e.message || '');
        // some gateways reject size/n; retry with the minimal payload
        if (/size|resolution|invalid|unsupported|unknown/i.test(msg)) {
          return call({ model: session.model, prompt: prompt }).catch(function (e2) {
            failed(e2.message || msg, '模型：' + session.model);
          });
        }
        failed(msg, '模型：' + session.model);

      });
    }

    function sendMessage() {
      if (streaming) { U.toast('正在生成，可先停止'); return; }
      var text = input.value.trim();
      if (!text) return;
      if (!session.model) { U.toast('请先选择模型', 'err'); selectModel(); return; }
      if (!activeKey()) { U.toast('请先创建并选择令牌', 'err'); return; }
      input.value = '';
      autoGrow();
      session.messages.push({ role: 'user', content: text });
      if (!session.title || session.title === '新对话') session.title = titleOf(session.messages);
      save();
      paint();
      if (isImageModel(session.model)) runImage(text);
      else runCompletion(false);
    }

    function regenerate(forceNonStream) {
      if (streaming) return;
      var lastUser = null;
      while (session.messages.length) {
        var m = session.messages[session.messages.length - 1];
        if (m.role === 'user') { lastUser = m; break; }
        session.messages.pop();
      }
      if (!lastUser) return;
      save();
      paint();
      if (isImageModel(session.model)) runImage(lastUser.content);
      else runCompletion(!!forceNonStream);
    }

    function regenerateStreaming() { regenerate(true); }

    send.addEventListener('click', function () {
      if (streaming) {
        stopped = true;
        imageRun++;
        if (controller) { try { controller.abort(); } catch (e) {} }
        else {
          var last = session.messages[session.messages.length - 1];
          if (last && last.role === 'assistant') {
            last.pending = false;
            if (!last.content) last.content = '（已停止）';
          }
          setBusy(false);
          persistAndPaint();
        }
        return;
      }
      sendMessage();
    });
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(120, input.scrollHeight) + 'px';
    }

    // ---------- model & key pickers ----------
    function selectModel() {
      if (!modelList.length) { loadModels(function () { selectModel(); }); return; }
      var q = h('input', { class: 'input', placeholder: '搜索模型…', style: { marginBottom: '10px' } });
      var host = h('div', { style: { maxHeight: '50vh', overflowY: 'auto' } });
      function paintList() {
        var kw = q.value.trim().toLowerCase();
        host.innerHTML = '';
        var list = modelList.filter(function (m) { return !kw || m.toLowerCase().indexOf(kw) >= 0; });
        if (!list.length) {
          host.appendChild(h('div', { class: 'empty' }, h('p', null, '没有匹配的模型')));
        }
        list.slice(0, 300).forEach(function (m) {
          host.appendChild(h('div', {
            class: 'list-item',
            onclick: function () {
              session.model = m;
              global.S.chatModel = m;
              save();
              modelChip.firstChild.textContent = m;
              U.closeOverlay();
              paintInfo();
            }
          },
            h('div', { class: 'li-body' }, h('div', { class: 'li-title', style: { fontSize: '13px' } }, m)),
            isImageModel(m) ? h('span', { class: 'badge teal', style: { flex: '0 0 auto' } }, '生图') : null
          ));
        });
      }
      q.addEventListener('input', paintList);
      paintList();
      U.sheet({ title: '选择模型（' + modelList.length + '）', body: h('div', null, q, host) });
    }

    function selectKey() {
      if (!keys.length) { App.go('#/keys'); return; }
      var host = h('div', null);
      keys.forEach(function (k) {
        host.appendChild(h('div', {
          class: 'list-item',
          onclick: function () {
            session.keyId = k.id;
            save();
            keyChip.firstChild.textContent = '令牌 · ' + (k.name || U.maskKey(k.key));
            U.closeOverlay();
            paintInfo();
            loadModels();
          }
        },
          h('div', { class: 'li-body' },
            h('div', { class: 'li-title' }, k.name || '未命名'),
            h('div', { class: 'li-sub mono' }, U.maskKey(k.key || ''))),
          String(k.status) === 'active' ? h('span', { class: 'badge ok' }, '可用') : h('span', { class: 'badge' }, '已停用')
        ));
      });
      host.appendChild(h('div', { class: 'list-item', onclick: function () { U.closeOverlay(); App.go('#/keys'); } },
        h('div', { class: 'li-body' }, h('div', { class: 'li-title' }, '管理令牌 ›'))));
      U.sheet({ title: '选择令牌', body: host });
    }

    function applyModelList(list) {
      if (!isCurrent()) return;
      modelList = list;
      if (!session.model && modelList.length) {
        session.model = modelList[0];
        save();
        global.S.chatModel = session.model;
        modelChip.firstChild.textContent = session.model;
        paintInfo();
      }
    }

    function loadModels(cb) {
      var key = activeKey();
      var fallback = function () {
        if (!isCurrent()) return;
        var names = [];
        C.plazaModels(global.S.plaza).forEach(function (m) { if (names.indexOf(m.name) < 0) names.push(m.name); });
        applyModelList(names);
        if (cb) cb();
      };
      if (!key) { fallback(); return; }
      Api.modelsWithKey(key.key).then(function (d) {
        if (!isCurrent()) return;
        var arr = Array.isArray(d) ? d : (d && (d.data || d.models)) || [];
        var list = arr.map(function (m) { return typeof m === 'string' ? m : (m.id || m.name); }).filter(Boolean);
        if (!list.length) { fallback(); return; }
        applyModelList(list);
        if (cb) cb();
      }).catch(fallback);
    }

    // ---------- settings ----------
    function openSettings() {
      var sp = h('textarea', { class: 'textarea', rows: '3', maxlength: '16000', placeholder: '告诉助手如何回答，例如：使用简洁的中文，先给出结论。' });
      sp.value = session.settings.systemPrompt || '';
      var temp = h('input', { class: 'input', type: 'number', min: '0', max: '2', step: '0.1', placeholder: '模型默认（0–2）', inputmode: 'decimal' });
      temp.value = session.settings.temperature === null ? '' : String(session.settings.temperature);
      var maxTok = h('input', { class: 'input', type: 'number', min: '1', step: '1', placeholder: '模型默认', inputmode: 'numeric' });
      maxTok.value = session.settings.maxTokens === null ? '' : String(session.settings.maxTokens);

      var body = h('div', null,
        h('div', { class: 'field' }, h('label', null, '系统提示词'), sp),
        h('div', { class: 'row', style: { gap: '10px' } },
          h('div', { class: 'field', style: { flex: '1' } }, h('label', null, '随机性 temperature'), temp),
          h('div', { class: 'field', style: { flex: '1' } }, h('label', null, '最大输出 tokens'), maxTok)
        ),
        h('div', { class: 'divider' }),
        h('div', { class: 'row', style: { gap: '8px' } },
          h('button', {
            class: 'btn btn-sm', style: { flex: '1' },
            onclick: function () {
              if (!session.messages.length) { U.toast('当前对话已经是空的'); return; }
              U.confirm('清空当前对话', '只清空当前会话的消息，历史对话仍保留。', '清空', true).then(function (ok) {
                if (!ok) return;
                session.messages = [];
                session.title = '新对话';
                save();
                U.closeOverlay();
                paint();
              });
            }
          }, '清空对话'),
          h('button', {
            class: 'btn btn-sm', style: { flex: '1' },
            onclick: function () { exportMarkdown(); }
          }, '复制为 Markdown')
        )
      );

      U.sheet({
        title: '对话设置',
        body: body,
        actions: [
          { label: '取消' },
          {
            label: '保存', kind: 'primary', onClick: function () {
              session.settings.systemPrompt = sp.value.trim();
              var t = temp.value.trim();
              session.settings.temperature = t === '' ? null : Math.max(0, Math.min(2, Number(t)));
              var m = maxTok.value.trim();
              session.settings.maxTokens = m === '' ? null : Math.max(1, Math.floor(Number(m)));
              save();
              paintInfo();
              U.toast('设置已保存', 'ok');
              return true;
            }
          }
        ]
      });
    }

    function exportMarkdown() {
      if (!session.messages.length) { U.toast('还没有内容可复制'); return; }
      var out = ['# ' + (session.title || '对话'), ''];
      if (session.settings.systemPrompt) out.push('> 系统提示词：' + session.settings.systemPrompt, '');
      session.messages.forEach(function (m) {
        out.push('## ' + (m.role === 'user' ? '用户' : '助手'), '', m.content, '');
      });
      U.copy(out.join('\n'));
    }

    // ---------- history ----------
    function openHistory() {
      var list = state.sessions.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      var host = h('div', null);
      host.appendChild(h('button', {
        class: 'btn btn-primary btn-block', style: { marginBottom: '12px' },
        onclick: function () {
          var s = makeSession(session.model, session.keyId);
          state.sessions.unshift(s);
          state.activeId = s.id;
          save();
          U.closeOverlay();
          App.go('#/chat');
        }
      }, '＋ 新对话'));

      if (!list.length) {
        host.appendChild(emptyState('还没有历史对话', '发起第一轮对话后会出现在这里', 'chat'));
      }
      list.forEach(function (s) {
        var active = s.id === session.id;
        var item = h('div', {
          class: 'list-item',
          onclick: function () {
            state.activeId = s.id;
            save();
            U.closeOverlay();
            App.go('#/chat');
          }
        },
          h('span', { class: 'li-icon', html: U.ic(active ? 'chat' : 'doc', 16) }),
          h('div', { class: 'li-body' },
            h('div', { class: 'li-title nowrap' }, s.title || '新对话'),
            h('div', { class: 'li-sub' }, s.messages.length + ' 条 · ' + U.ago(s.updatedAt))),
          active ? h('span', { class: 'badge teal' }, '当前') : null
        );
        var del = h('button', {
          class: 'icon-btn', style: { width: '32px', height: '32px' },
          html: U.ic('trash', 16),
          onclick: function (e) {
            e.stopPropagation();
            U.confirm('删除对话', '「' + (s.title || '新对话') + '」将被永久删除。', '删除', true).then(function (ok) {
              if (!ok) return;
              state.sessions = state.sessions.filter(function (x) { return x.id !== s.id; });
              if (state.activeId === s.id) state.activeId = (state.sessions[0] || {}).id || '';
              save();
              U.closeOverlay();
              App.go('#/chat');
            });
          }
        });
        item.appendChild(h('div', { class: 'li-tail' }, del));
        host.appendChild(item);
      });

      U.sheet({ title: '历史对话', body: host });
    }

    modelChip.addEventListener('click', selectModel);
    keyChip.addEventListener('click', selectKey);
    settingBtn.addEventListener('click', openSettings);
    historyBtn.addEventListener('click', openHistory);

    // ---------- boot ----------
    if (session.model) global.S.chatModel = session.model;
    modelChip.firstChild.textContent = session.model || '选择模型';
    paintInfo();
    paint();

    function updateKeys(items) {
      if (!isCurrent()) return;
      keys = items;
      global.S.keys = keys;
      var key = activeKey();
      if (key) {
        if (!session.keyId) { session.keyId = key.id; save(); }
        keyChip.firstChild.textContent = '令牌 · ' + (key.name || U.maskKey(key.key));
      } else {
        keyChip.firstChild.textContent = '无可用令牌';
      }
      if (session.model && modelList.length) global.S.chatModel = session.model;
      if (!session.messages.length) paint();
      loadModels(function () {
        if (!session.model && modelList.length) {
          session.model = modelList[0];
          save();
          modelChip.firstChild.textContent = session.model;
          paintInfo();
        }
      });
    }
    function onKeysUpdated(event) {
      if (event.detail && event.detail.account === authContext.id && Array.isArray(event.detail.items)) updateKeys(event.detail.items);
    }
    function onKeysChanged() {
      if (!isCurrent()) return;
      Api.keys(1, 100).then(function (data) { updateKeys(arrOf(data)); }).catch(function () {});
    }
    global.addEventListener('pp:keys-updated', onKeysUpdated);
    global.addEventListener('pp:keys-changed', onKeysChanged);
    page.addEventListener('pp:page-activate', function () {
      if (global.S.useSelectedChatModel && global.S.chatModel) {
        session.model = global.S.chatModel;
        global.S.useSelectedChatModel = false;
        modelChip.firstChild.textContent = session.model;
        save(); paintInfo();
      }
    });
    page.addEventListener('pp:page-dispose', function () {
      global.removeEventListener('pp:keys-updated', onKeysUpdated);
      global.removeEventListener('pp:keys-changed', onKeysChanged);
      if (activeChat) activeChat();
      activeChat = null;
    });
    Api.keys(1, 100).then(function (d) {
      updateKeys(arrOf(d));
    }).catch(function () {
      if (!isCurrent()) return;
      keyChip.firstChild.textContent = '令牌加载失败';
    });

    return page;
  }

  function removeAccountData(id) {
    U.store.del(STORE + ':' + encodeURIComponent(id));
    if (U.store.get('chat_legacy_owner', '') === id) {
      U.store.del(STORE);
      U.store.del('chat_messages');
      U.store.del('chat_legacy_owner');
    }
  }

  global.PagesChat = { renderChat: renderChat, removeAccountData: removeAccountData };
})(window);
