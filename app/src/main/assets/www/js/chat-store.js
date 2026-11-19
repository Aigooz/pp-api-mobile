/* Chat persistence and message-tree operations. */
(function (global) {
  'use strict';

  var U = global.U;
  var STORE = 'chat_store_v2';
  var LEGACY_STORE = 'chat_messages';
  var LEGACY_OWNER = 'chat_legacy_owner';
  var MAX_SESSIONS = 30;
  var MAX_IMPORT_SESSIONS = 30;

  function now() { return Date.now(); }
  function uid(prefix) {
    return (prefix || 'c') + now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function textOfContent(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.map(function (part) {
        if (typeof part === 'string') return part;
        return part && (part.text || part.content || '') || '';
      }).join('');
    }
    return value == null ? '' : String(value);
  }
  function compact(value, max) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max || 120);
  }
  function messageText(message) {
    if (!message) return '';
    return textOfContent(message.content) || message.image || '';
  }
  function messageRole(message) {
    if (message && (message.role === 'user' || message.role === 'assistant' || message.role === 'system')) return message.role;
    return 'assistant';
  }
  function selected(node) {
    if (!node || !Array.isArray(node.messages) || !node.messages.length) return null;
    node.selectIndex = Math.max(0, Math.min(node.messages.length - 1, Number(node.selectIndex) || 0));
    return node.messages[node.selectIndex] || node.messages[0];
  }
  function flattenMessages(session) {
    var out = [];
    (session && session.nodes || []).forEach(function (node) {
      var message = selected(node);
      if (message) out.push(message);
    });
    return out;
  }

  function normalizeSettings(raw) {
    var old = raw || {};
    var maxContext = Number(old.maxContext);
    return {
      systemPrompt: String(old.systemPrompt || ''),
      temperature: old.temperature === null || old.temperature === undefined || old.temperature === ''
        ? null : Math.max(0, Math.min(2, Number(old.temperature))),
      maxTokens: old.maxTokens === null || old.maxTokens === undefined || old.maxTokens === ''
        ? null : Math.max(1, Math.floor(Number(old.maxTokens))),
      maxContext: maxContext > 0 ? Math.max(2, Math.floor(maxContext)) : 40
    };
  }

  function normalizeMessage(raw, fallbackRole) {
    if (!raw || typeof raw !== 'object') return null;
    var role = messageRole(raw.role ? raw : { role: fallbackRole });
    var message = {
      id: raw.id || uid('m'),
      role: role,
      content: textOfContent(raw.content),
      reasoning: String(raw.reasoning || raw.reasoning_content || ''),
      image: String(raw.image || ''),
      error: raw.error ? String(raw.error) : '',
      detail: raw.detail ? String(raw.detail) : '',
      pending: !!raw.pending,
      stopped: !!raw.stopped,
      favorite: !!raw.favorite,
      model: String(raw.model || ''),
      keyName: String(raw.keyName || ''),
      usage: raw.usage && typeof raw.usage === 'object' ? clone(raw.usage) : null,
      createdAt: Number(raw.createdAt) || now(),
      finishedAt: Number(raw.finishedAt) || 0,
      runId: String(raw.runId || '')
    };
    if (!message.content && !message.image && !message.error && !message.pending && !message.reasoning) {
      message.content = '';
    }
    return message;
  }

  function nodeFromMessage(message) {
    return { id: uid('n'), messages: [message], selectIndex: 0 };
  }

  // Pair a user message with the following assistant answer. Consecutive
  // assistant messages are grouped as alternate answers to the same prompt.
  function nodesFromLegacy(messages) {
    var nodes = [];
    (messages || []).forEach(function (raw) {
      var message = normalizeMessage(raw, 'assistant');
      if (!message) return;
      var last = nodes[nodes.length - 1];
      if (message.role === 'assistant') {
        if (last && last._assistant && selected(last).role === 'assistant') {
          last.messages.push(message);
          last.selectIndex = last.messages.length - 1;
          return;
        }
        nodes.push({ id: uid('n'), messages: [message], selectIndex: 0, _assistant: true });
        return;
      }
      nodes.push(nodeFromMessage(message));
    });
    return nodes.map(function (node) {
      delete node._assistant;
      return node;
    });
  }

  function normalizeNode(raw, fallbackRole) {
    if (!raw) return null;
    if (Array.isArray(raw.messages)) {
      var group = raw.messages.map(function (message) { return normalizeMessage(message, fallbackRole); }).filter(Boolean);
      if (!group.length) return null;
      return {
        id: raw.id || uid('n'),
        messages: group,
        selectIndex: Math.max(0, Math.min(group.length - 1, Number(raw.selectIndex) || 0))
      };
    }
    var message = normalizeMessage(raw, fallbackRole);
    return message ? nodeFromMessage(message) : null;
  }

  function normalizeSession(raw, model, keyId) {
    var session = raw || {};
    var nodes = Array.isArray(session.nodes)
      ? session.nodes.map(function (node) { return normalizeNode(node, 'assistant'); }).filter(Boolean)
      : nodesFromLegacy(session.messages);
    return {
      id: session.id || uid('c'),
      title: String(session.title || '新对话'),
      nodes: nodes,
      model: String(session.model || model || ''),
      keyId: session.keyId || keyId || 0,
      pinned: !!session.pinned,
      favorite: !!session.favorite,
      draft: String(session.draft || ''),
      settings: normalizeSettings(session.settings),
      createdAt: Number(session.createdAt) || now(),
      updatedAt: Number(session.updatedAt) || now()
    };
  }

  function makeSession(model, keyId) {
    return normalizeSession({ model: model, keyId: keyId }, model, keyId);
  }

  function titleOf(session) {
    var first = flattenMessages(session).filter(function (message) {
      return message.role === 'user' && compact(message.content, 80);
    })[0];
    return first ? compact(first.content, 22) || '新对话' : '新对话';
  }

  function hydrateSession(session) {
    if (!session) return session;
    session.nodes = Array.isArray(session.nodes) ? session.nodes : [];
    Object.defineProperty(session, 'messages', {
      configurable: true,
      enumerable: false,
      get: function () { return flattenMessages(session); },
      set: function (messages) {
        session.nodes = nodesFromLegacy(Array.isArray(messages) ? messages : []);
      }
    });
    return session;
  }

  function serializeState(state) {
    return {
      version: 3,
      activeId: state.activeId || '',
      sessions: (state.sessions || []).map(function (session) {
        return {
          id: session.id,
          title: session.title,
          nodes: session.nodes,
          model: session.model,
          keyId: session.keyId,
          pinned: !!session.pinned,
          favorite: !!session.favorite,
          draft: String(session.draft || ''),
          settings: normalizeSettings(session.settings),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        };
      })
    };
  }

  function load(accountId) {
    var key = STORE + ':' + encodeURIComponent(accountId);
    var state = U.store.get(key, null);
    var changed = false;

    if (!state || !Array.isArray(state.sessions)) {
      var legacyOwner = U.store.get(LEGACY_OWNER, '');
      var canMigrate = !!legacyOwner && legacyOwner === accountId;
      state = canMigrate ? U.store.get(STORE, null) : null;
      if (!state || !Array.isArray(state.sessions)) {
        state = { activeId: '', sessions: [] };
        changed = true;
      }
      var legacy = canMigrate && !state.sessions.length ? U.store.get(LEGACY_STORE, []) : [];
      if (Array.isArray(legacy) && legacy.length) {
        var migrated = makeSession();
        migrated.nodes = nodesFromLegacy(legacy);
        migrated.title = titleOf(migrated);
        state.sessions.push(migrated);
        state.activeId = migrated.id;
        changed = true;
      }
    }

    var sessions = (state.sessions || []).map(function (session) {
      var normalized = normalizeSession(session);
      if (!Array.isArray(session.nodes) || session.version !== 3) changed = true;
      hydrateSession(normalized);
      return normalized;
    });
    sessions.sort(function (a, b) {
      return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt;
    });
    if (sessions.length > MAX_SESSIONS) changed = true;
    sessions = sessions.slice(0, MAX_SESSIONS);
    state = { activeId: state.activeId || (sessions[0] || {}).id || '', sessions: sessions };
    if (changed) save(accountId, state);
    return state;
  }

  function save(accountId, state) {
    if (!state || !Array.isArray(state.sessions)) return false;
    state.sessions.sort(function (a, b) {
      return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt;
    });
    if (state.sessions.length > MAX_SESSIONS) state.sessions = state.sessions.slice(0, MAX_SESSIONS);
    var serialized = serializeState(state);
    try {
      localStorage.setItem('pp_api_' + STORE + ':' + encodeURIComponent(accountId), JSON.stringify(serialized));
      return true;
    } catch (error) {
      // A full conversation store can exceed WebView quota. Keep a compact
      // recovery copy rather than silently losing every session.
      try {
        var compactState = serializeState({
          activeId: state.activeId,
          sessions: state.sessions.slice(0, 6).map(function (session) {
            var copy = serializeState({ sessions: [session] }).sessions[0];
            copy.nodes = copy.nodes.slice(-12);
            return copy;
          })
        });
        localStorage.setItem('pp_api_' + STORE + ':' + encodeURIComponent(accountId), JSON.stringify(compactState));
        global.dispatchEvent(new CustomEvent('pp:chat-storage-warning', { detail: { error: error, compact: true } }));
      } catch (e) {
        global.dispatchEvent(new CustomEvent('pp:chat-storage-warning', { detail: { error: error, compact: false } }));
      }
      return false;
    }
  }

  function saveDraft(accountId, state, sessionId, draft) {
    var session = (state.sessions || []).filter(function (item) { return item.id === sessionId; })[0];
    if (!session) return false;
    session.draft = String(draft || '');
    session.updatedAt = now();
    return save(accountId, state);
  }

  function activeSession(state) {
    return (state.sessions || []).filter(function (session) { return session.id === state.activeId; })[0] ||
      (state.sessions || [])[0] || null;
  }

  function appendUserNode(session, content, meta) {
    var message = normalizeMessage(Object.assign({}, meta || {}, {
      role: 'user', content: content, createdAt: now()
    }), 'user');
    var node = { id: uid('n'), messages: [message], selectIndex: 0 };
    session.nodes.push(node);
    if (!session.title || session.title === '新对话') session.title = titleOf(session);
    session.updatedAt = now();
    return node;
  }

  function appendAssistantNode(session, promptNode, meta) {
    var message = normalizeMessage(Object.assign({}, meta || {}, {
      role: 'assistant', content: '', pending: true, createdAt: now()
    }), 'assistant');
    var node = { id: uid('n'), messages: [message], selectIndex: 0 };
    var index = session.nodes.indexOf(promptNode);
    if (index < 0) index = session.nodes.length - 1;
    session.nodes.splice(index + 1, 0, node);
    session.updatedAt = now();
    return node;
  }

  function replaceAfter(session, node, message) {
    var index = session.nodes.indexOf(node);
    if (index < 0) return null;
    session.nodes = session.nodes.slice(0, index + 1);
    return appendAssistantNode(session, node, message || {});
  }

  function addCandidate(node, message) {
    if (!node || !Array.isArray(node.messages)) return null;
    var normalized = normalizeMessage(message, 'assistant');
    if (!normalized) return null;
    node.messages.push(normalized);
    node.selectIndex = node.messages.length - 1;
    return normalized;
  }

  function selectCandidate(node, index) {
    if (!node || !node.messages || !node.messages.length) return null;
    node.selectIndex = Math.max(0, Math.min(node.messages.length - 1, Number(index) || 0));
    return selected(node);
  }

  function removeCandidate(node, message) {
    if (!node || !Array.isArray(node.messages)) return false;
    var index = node.messages.indexOf(message);
    if (index < 0) return false;
    node.messages.splice(index, 1);
    if (!node.messages.length) return true;
    node.selectIndex = Math.min(node.selectIndex, node.messages.length - 1);
    return false;
  }

  function removeNode(session, node) {
    var index = session.nodes.indexOf(node);
    if (index < 0) return;
    session.nodes.splice(index, 1);
    session.updatedAt = now();
  }

  function clearSession(session) {
    session.nodes = [];
    session.title = '新对话';
    session.draft = '';
    session.updatedAt = now();
  }

  function contextMessages(session, upto, settings) {
    var opts = settings || session.settings || {};
    var visible = flattenMessages(session);
    if (upto !== undefined && upto !== null) visible = visible.slice(0, upto);
    var mapped = visible.filter(function (message) {
      return message && message.role && (textOfContent(message.content).length || message.image);
    }).map(function (message) {
      var item = { role: message.role, content: textOfContent(message.content) };
      if (message.image && message.role === 'user') item.content = (item.content ? item.content + '\n' : '') + message.image;
      return item;
    });
    var maxMessages = Number(opts.maxContext) > 0 ? Math.floor(Number(opts.maxContext)) : 0;
    var omitted = 0;
    if (maxMessages && mapped.length > maxMessages) {
      omitted = mapped.length - maxMessages;
      mapped = mapped.slice(omitted);
      // Do not start the model context with an orphaned assistant turn.
      while (mapped.length && mapped[0].role === 'assistant') mapped.shift();
    }
    if (Object.prototype.hasOwnProperty.call(opts, 'systemPrompt') && opts.systemPrompt) {
      mapped.unshift({ role: 'system', content: String(opts.systemPrompt) });
    }
    return { messages: mapped, omitted: omitted, total: visible.length };
  }

  function allText(session) {
    return flattenMessages(session).map(function (message) { return messageText(message); }).join('\n');
  }

  function sessionCount(state, session) {
    return flattenMessages(session).length;
  }

  function importState(raw) {
    if (!raw || !Array.isArray(raw.sessions)) throw new Error('JSON 中没有 sessions 数组');
    var imported = raw.sessions.slice(0, MAX_IMPORT_SESSIONS).map(function (session) {
      var normalized = normalizeSession(session);
      hydrateSession(normalized);
      return normalized;
    });
    return { activeId: imported[0] ? imported[0].id : '', sessions: imported };
  }

  function remove(accountId) {
    U.store.del(STORE + ':' + encodeURIComponent(accountId));
    if (U.store.get(LEGACY_OWNER, '') === accountId) {
      U.store.del(STORE);
      U.store.del(LEGACY_STORE);
      U.store.del(LEGACY_OWNER);
    }
  }

  global.PagesChatStore = {
    STORE: STORE,
    MAX_SESSIONS: MAX_SESSIONS,
    uid: uid,
    clone: clone,
    compact: compact,
    messageText: messageText,
    messageRole: messageRole,
    selected: selected,
    flattenMessages: flattenMessages,
    normalizeMessage: normalizeMessage,
    normalizeSettings: normalizeSettings,
    makeSession: makeSession,
    titleOf: titleOf,
    load: load,
    save: save,
    saveDraft: saveDraft,
    activeSession: activeSession,
    appendUserNode: appendUserNode,
    appendAssistantNode: appendAssistantNode,
    replaceAfter: replaceAfter,
    addCandidate: addCandidate,
    selectCandidate: selectCandidate,
    removeCandidate: removeCandidate,
    removeNode: removeNode,
    clearSession: clearSession,
    contextMessages: contextMessages,
    allText: allText,
    sessionCount: sessionCount,
    importState: importState,
    remove: remove
  };
})(window);
