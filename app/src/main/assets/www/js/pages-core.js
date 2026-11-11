/* Shared UI pieces + 首页 / 模型广场 / 公告 / 关于 */
(function (global) {
  'use strict';
  var U = global.U;
  var S = global.S;

  function h(tag, attrs) {
    var kids = [];
    for (var i = 2; i < arguments.length; i++) {
      var a = arguments[i];
      if (Array.isArray(a)) kids = kids.concat(a);
      else kids.push(a);
    }
    return U.el(tag, attrs, kids);
  }

  function section(title, moreText, onMore, children) {
    if (!title) return h('div', { class: 'section' }, children);
    var head = h('div', { class: 'section-head' },
      h('h2', null, title),
      moreText ? h('button', { onclick: onMore }, moreText + ' ›') : null
    );
    return h('div', { class: 'section' }, head, children);
  }

  function listItem(icon, title, sub, tail, onClick) {
    return h('div', { class: 'list-item', onclick: onClick },
      icon ? h('span', { class: 'li-icon', html: U.ic(icon, 17) }) : null,
      h('div', { class: 'li-body' },
        h('div', { class: 'li-title' }, title),
        sub ? h('div', { class: 'li-sub' }, sub) : null
      ),
      tail ? h('div', { class: 'li-tail' }, tail) : null
    );
  }

  function emptyState(title, sub, icon) {
    return h('div', { class: 'empty' },
      h('div', { html: U.ic(icon || 'sparkle', 38) }),
      h('p', null, title),
      sub ? h('small', null, sub) : null
    );
  }

  function card(kids, cls) {
    return h('div', { class: 'card ' + (cls || '') }, kids);
  }

  function arrOf(d, fallback) {
    if (Array.isArray(d)) return d;
    if (!d) return fallback || [];
    var keys = ['items', 'list', 'data', 'records', 'results', 'rows', 'orders', 'plans', 'keys', 'logs'];
    for (var i = 0; i < keys.length; i++) if (Array.isArray(d[keys[i]])) return d[keys[i]];
    return fallback || [];
  }

  function totalOf(d) {
    if (!d) return 0;
    var t = d.total || d.count || d.total_count || d.pagination && (d.pagination.total || d.pagination.total_count);
    return Number(t) || 0;
  }

  function pick(obj) {
    for (var i = 1; i < arguments.length; i++) {
      var k = arguments[i];
      if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return undefined;
  }

  // ---------------- home ----------------
  function renderHome() {
    var S2 = global.S;
    if (S2.user) return global.PagesDashboard.renderDashboard();
    var kids = [];
    var user = S2.user;

    // hero
    var heroRight, heroLabel, heroValue, heroSub;
    if (user) {
      heroLabel = '账户余额';
      heroSub = '';
      heroValue = h('div', { class: 'hero-value' }, '$' + U.credits(balanceOf(user)));
      heroRight = h('button', {
        class: 'hero-chip', style: { border: '1px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.16)' },
        onclick: function () { App.go('#/purchase'); }
      }, '充值 +');
    } else {
      heroLabel = '开始使用';
      heroValue = h('div', { class: 'hero-value', style: { fontSize: '20px' } }, '登录后查看余额');
      heroRight = h('button', {
        class: 'hero-chip', onclick: function () { App.go('#/login'); }
      }, '登录 / 注册');
    }
    kids.push(h('div', {
      class: 'hero',
      onclick: function (e) {
        if (global.S.user) return;
        if (e.target && e.target.closest && e.target.closest('button')) return;
        App.go('#/login');
      }
    },
      h('div', { class: 'row', style: { gap: '10px' } },
        h('img', { src: 'img/pp-logo.jpg', width: '36', height: '36', alt: 'Pp API', style: { borderRadius: '6px' } }),
        h('div', null,
          h('h1', null, 'Pp API'),
          h('p', null, '一个端点，接入主流 AI 模型')
        )
      ),
      h('div', { class: 'hero-row' },
        h('div', null,
          h('div', { class: 'hero-label' }, heroLabel),
          heroValue,
          heroSub ? h('div', { class: 'hero-label' }, heroSub) : null
        ),
        heroRight
      )
    ));

    // quick actions
    var quicks = [
      { icon: 'key', label: '令牌', go: '#/keys' },
      { icon: 'chart', label: '用量', go: '#/usage' },
      { icon: 'card', label: '充值', go: '#/purchase' },
      { icon: 'gift', label: '兑换', go: '#/redeem' }
    ];
    kids.push(h('div', { class: 'section' }, h('div', { class: 'grid-4' },
      quicks.map(function (q) {
        return h('button', { class: 'quick', onclick: function () { App.go(q.go); } },
          h('i', { html: U.ic(q.icon, 18) }), h('span', null, q.label));
      })
    )));

    // stats (logged in)
    if (user) {
      var statsHost = h('div', { class: 'section' }, h('div', { class: 'grid-2' },
        h('div', { class: 'card stat' }, h('b', { class: 'skeleton', style: { width: '58px', height: '22px', display: 'block' } }), h('span', null, '今日消耗')),
        h('div', { class: 'card stat' }, h('b', { class: 'skeleton', style: { width: '58px', height: '22px', display: 'block' } }), h('span', null, '今日请求'))
      ));
      kids.push(statsHost);
      loadTodayStats(statsHost);
    }

    // announcements
    var annHost = h('div', { class: 'section' });
    kids.push(annHost);
    Api.announcements().then(function (list) {
      var items = arrOf(list);
      if (!items.length) {
        annHost.appendChild(section('平台公告', '全部', function () { App.go('#/announcements'); },
          card([h('div', { style: { padding: '14px' } }, h('div', { class: 'small muted' }, Api.AUTH.isLogged() ? '暂无公告' : '登录后查看公告'))])));
        return;
      }
      var first = items[0];
      annHost.appendChild(section('平台公告', '全部', function () { App.go('#/announcements'); },
        card([h('div', { class: 'list-item', style: { alignItems: 'flex-start' }, onclick: function () { App.go('#/announcements/' + (first.id || 0)); } },
          h('span', { class: 'li-icon', html: U.ic('bell', 17) }),
          h('div', { class: 'li-body' },
            h('div', { class: 'li-title' }, pick(first, 'title', 'name') || '公告'),
            h('div', { class: 'li-sub', style: { display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden' } },
              String(pick(first, 'content', 'summary', 'body') || '').replace(/[#*`>]/g, '').slice(0, 120)),
            h('div', { class: 'li-sub', style: { marginTop: '4px' } }, U.ago(pick(first, 'created_at', 'published_at', 'updated_at'))))
        )])
      ));
    }).catch(function () {});

    // groups
    var plaza = S2.plaza;
    if (plaza && plaza.groups && plaza.groups.length) {
      var groups = plaza.groups.filter(function (g) { return g.models && g.models.length; });
      kids.push(section('模型分组', '模型广场', function () { App.go('#/plaza'); },
        h('div', { class: 'chips' }, groups.slice(0, 10).map(function (g) {
          return h('button', { class: 'chip', onclick: function () { global.S.plazaGroup = g.id; App.go('#/plaza'); } },
            g.name + ' · ' + (Number(g.rate_multiplier) || 1).toFixed(2) + 'x');
        }))
      ));

      var models = plazaModels(plaza).filter(function (m) {
        return m.input > 0 && m.output > 0 && m.mode === 'token';
      });
      var byName = {};
      models.forEach(function (m) {
        var key = m.name;
        if (!byName[key] || m.input < byName[key].input) byName[key] = m;
      });
      var uniq = Object.keys(byName).map(function (k) { return byName[k]; });
      var order = ['anthropic', 'openai', 'google', 'deepseek', 'other'];
      function platIdx(m) {
        var pl = platformKey(m.platform).k;
        var i = order.indexOf(pl.replace('plat-', ''));
        return i < 0 ? 4 : i;
      }
      var picked = [];
      order.forEach(function (plat) {
        var bucket = uniq.filter(function (m) { return platIdx(m) === order.indexOf(plat); });
        bucket.sort(function (a, b) { return a.input - b.input; });
        picked = picked.concat(bucket.slice(0, plat === 'other' ? 2 : 2));
      });
      var hot = picked.slice(0, 6);
      kids.push(section('模型速览', '全部模型', function () { App.go('#/plaza'); },
        card(hot.map(modelRow))
      ));
    } else if (!S2.plazaLoading) {
      kids.push(h('div', { class: 'section' }, emptyState('模型目录加载中', '正在连接模型广场…', 'grid')));
    }

    kids.push(h('div', { class: 'footer-note' },
      'Pp API · AI API Gateway',
      h('br'), 'OpenAI 兼容接口 · ipkey.vip'
    ));

    return h('div', { class: 'page' }, kids);
  }

  function balanceOf(user) {
    var b = pick(user, 'balance', 'credits', 'quota', 'remaining_balance');
    if (typeof b === 'string') b = Number(b);
    return isFinite(b) ? b : 0;
  }

  function loadTodayStats(host) {
    Api.usageStats({ period: 'today' }).then(function (d) {
      var st = d || {};
      var cost = Number(pick(st, 'total_actual_cost', 'total_cost', 'cost', 'credits_used', 'spend') || 0);
      var reqs = Number(pick(st, 'requests', 'request_count', 'total_requests', 'count') || 0);
      host.innerHTML = '';
      host.appendChild(h('div', { class: 'grid-2' },
        h('div', { class: 'card stat' }, h('b', null, '$' + U.credits(cost)), h('span', null, '今日消耗')),
        h('div', { class: 'card stat' }, h('b', null, U.num(reqs)), h('span', null, '今日请求'))
      ));
    }).catch(function () {
      host.innerHTML = '';
      host.appendChild(h('div', { class: 'grid-2' },
        h('div', { class: 'card stat' }, h('b', null, '—'), h('span', null, '今日消耗')),
        h('div', { class: 'card stat' }, h('b', null, '—'), h('span', null, '今日请求'))
      ));
    });
  }

  // ---------------- model helpers ----------------
  function perM(v, mult) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    return n * 1e6 * (isFinite(Number(mult)) ? Number(mult) : 1);
  }

  function platformKey(p) {
    var s = String(p || '').toLowerCase();
    if (s.indexOf('anthropic') >= 0 || s.indexOf('claude') >= 0) return { k: 'plat-anthropic', t: 'Claude' };
    if (s.indexOf('openai') >= 0 || s.indexOf('gpt') >= 0) return { k: 'plat-openai', t: 'OpenAI' };
    if (s.indexOf('google') >= 0 || s.indexOf('gemini') >= 0) return { k: 'plat-google', t: 'Gemini' };
    if (s.indexOf('deepseek') >= 0) return { k: 'plat-deepseek', t: 'DeepSeek' };
    return { k: 'plat-other', t: String(p || 'Model') };
  }

  function plazaModels(plaza) {
    var out = [];
    ((plaza && plaza.groups) || []).forEach(function (g) {
      var mult = Number(pick(g, 'user_rate_multiplier', 'rate_multiplier', 'standard_rate_multiplier'));
      if (!isFinite(mult)) mult = 1;
      (g.models || []).forEach(function (m) {
        var p = m.pricing || {};
        var official = m.official_pricing || p;
        var mode = p.billing_mode || m.billing_mode || 'token';
        out.push({
          name: m.name,
          platform: m.owned_by || m.platform || g.platform,
          groupPlatform: g.platform,
          group: g.name,
          groupId: g.id,
          subscription: g.subscription_type === 'subscription',
          exclusive: !!g.is_exclusive,
          mode: mode,
          input: perM(p.input_price, mult),
          output: perM(p.output_price, mult),
          cacheRead: perM(p.cache_read_price, mult),
          cacheWrite: perM(p.cache_write_price, mult),
          cacheWrite1h: perM(p.cache_write_1h_price, mult),
          imageInput: perM(p.image_input_price, mult),
          imageOutput: perM(p.image_output_price, mult),
          officialInput: perM(official.input_price, 1),
          officialOutput: perM(official.output_price, 1),
          officialCacheRead: perM(official.cache_read_price, 1),
          officialCacheWrite: perM(official.cache_write_price, 1),
          officialCacheWrite1h: perM(official.cache_write_1h_price, 1),
          pricePerCall: pick(p, 'price_per_call', 'per_request_price', 'image_price', 'price'),
          officialPerCall: pick(official, 'price_per_call', 'per_request_price', 'image_price', 'price'),
          unit: p.unit || m.unit || '',
          context: pick(m, 'context_length', 'max_context_tokens', 'context_window') || pick(p, 'context_length'),
          desc: m.description || '',
          groupDesc: g.description || '',
          mult: mult,
          callMult: mode === 'image' && g.image_rate_independent && g.image_rate_multiplier != null ? Number(g.image_rate_multiplier) :
            mode === 'video' && g.video_rate_independent && g.video_rate_multiplier != null ? Math.max(0, Number(g.video_rate_multiplier)) : mult,
          pricing: p,
          officialPricing: official,
          timePricing: m.time_pricing,
          groupData: g
        });
      });
    });
    return out;
  }

  function priceLabel(m) {
    if (m.mode === 'token') return priceText(m.input) + ' / ' + priceText(m.output);
    return priceText(numberOrNull(m.pricePerCall, m.callMult)) + (m.mode === 'image' ? ' / 张' : ' / 次');
  }

  function priceText(value) {
    if (value === null || value === undefined || !isFinite(Number(value))) return '—';
    var text = Number(Number(value).toPrecision(10)).toString();
    if (text.indexOf('e') < 0) {
      var decimals = text.indexOf('.') < 0 ? 0 : text.length - text.indexOf('.') - 1;
      if (decimals < 2) text += (decimals === 0 ? '.' : '') + new Array(3 - decimals).join('0');
    }
    return '$' + text;
  }

  function modelRow(m) {
    var pl = platformKey(m.platform);
    return h('div', {
      class: 'model-row',
      onclick: function () { showModelDetail(m); }
    },
      h('div', { class: 'model-avatar ' + pl.k }, (m.name || '?').slice(0, 2)),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { class: 'model-name nowrap' }, m.name),
        h('div', { class: 'model-sub nowrap' }, (m.group || pl.t) + (m.context ? ' · ' + U.tokens(m.context) + ' ctx' : ''))
      ),
      h('div', { class: 'price' },
        m.mode === 'token'
          ? [h('div', null, '入 ', h('b', null, priceText(m.input))), h('div', null, '出 ', h('b', null, priceText(m.output)))]
          : h('div', null, h('b', null, priceLabel(m)))
      )
    );
  }

  function showModelDetail(m) {
    var pl = platformKey(m.platform);
    var body = h('div', null,
      h('div', { class: 'row', style: { marginBottom: '12px' } },
        h('div', { class: 'model-avatar ' + pl.k, style: { width: '44px', height: '44px', fontSize: '14px' } }, (m.name || '?').slice(0, 2)),
        h('div', null,
          h('div', { style: { fontWeight: '700', fontSize: '15px' } }, m.name),
          h('div', { class: 'tiny muted' }, m.group + ' · 倍率 ' + m.mult.toFixed(2) + 'x')
        )
      ),
      m.mode === 'token' ? modelPricing(m) : perCallPricing(m),
      m.context ? h('div', { class: 'kv' }, h('span', null, '上下文'), h('b', null, U.tokens(m.context) + ' tokens')) : null,
      h('div', { class: 'kv' }, h('span', null, '计费方式'), h('b', null, m.mode === 'token' ? '按 Token' : m.mode)),
      m.desc ? h('div', { class: 'small', style: { marginTop: '12px', whiteSpace: 'pre-wrap' } }, m.desc) : null,
      m.groupDesc ? h('div', { style: { marginTop: '12px' } },
        h('div', { class: 'tiny muted', style: { marginBottom: '4px' } }, '分组说明'),
        h('div', { class: 'small', style: { whiteSpace: 'pre-wrap' } }, m.groupDesc)) : null,
      h('div', { style: { marginTop: '14px' } },
        h('button', {
          class: 'btn btn-primary btn-block',
          onclick: function () {
            global.S.chatModel = m.name;
            global.S.useSelectedChatModel = true;
            U.closeOverlay();
            App.go('#/chat');
          }
        }, '用它对话'))
    );
    U.sheet({ title: '模型详情', body: body, actions: [{ label: '关闭', onClick: function () {} }] });
  }

  function numberOrNull(value, mult) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n * mult : null;
  }

  function modelPricing(m) {
    var rows = [
      ['输入', m.input, m.officialInput], ['输出', m.output, m.officialOutput],
      ['缓存写入', m.cacheWrite, m.officialCacheWrite], ['缓存写入 1 小时', m.cacheWrite1h, m.officialCacheWrite1h],
      ['缓存读取', m.cacheRead, m.officialCacheRead],
      ['图片输入', m.imageInput, perM(m.officialPricing.image_input_price, 1)],
      ['图片输出', m.imageOutput, perM(m.officialPricing.image_output_price, 1)]
    ].filter(function (row, index) { return index < 2 || row[1] !== null || row[2] !== null; });
    var intervals = Array.isArray(m.pricing.intervals) ? m.pricing.intervals : [];
    var efforts = m.pricing.reasoning_effort_multipliers || {};
    var time = m.timePricing || {};
    var periods = Array.isArray(time.periods) ? time.periods : [];
    function tierPrice(tier, field) {
      if (tier[field] !== null && tier[field] !== undefined) return tier[field];
      var multiplier = tier[field.replace('_price', '_multiplier')];
      return m.pricing[field] == null ? null : Number(m.pricing[field]) * (multiplier == null ? 1 : Number(multiplier));
    }
    return h('div', { class: 'model-pricing' },
      h('div', { class: 'model-pricing-head' }, h('span', null, '美元 / 百万 tokens'), h('span', null, '实际价'), h('span', null, '官方价')),
      rows.map(function (row) {
        return h('div', { class: 'model-pricing-row' }, h('span', null, row[0]), h('b', null, priceText(row[1])), h('span', null, priceText(row[2])));
      }),
      intervals.length ? h('div', { class: 'model-tier-list' }, h('strong', null, '分段价格'), intervals.map(function (tier) {
        var label = tier.tier_label || (tier.max_tokens == null ? '>' + U.tokens(tier.min_tokens || 0) : '≤' + U.tokens(tier.max_tokens));
        return h('div', { class: 'model-tier' }, label + ' · 输入 ' + priceText(perM(tierPrice(tier, 'input_price'), m.mult)) +
          ' · 输出 ' + priceText(perM(tierPrice(tier, 'output_price'), m.mult)) +
          (tier.cache_read_price != null || tier.cache_read_multiplier != null ? ' · 缓存读 ' + priceText(perM(tierPrice(tier, 'cache_read_price'), m.mult)) : '') +
          (tier.cache_write_price != null || tier.cache_write_multiplier != null ? ' · 缓存写 ' + priceText(perM(tierPrice(tier, 'cache_write_price'), m.mult)) : ''));
      })) : null,
      periods.length ? h('div', { class: 'model-tier-list' }, h('strong', null, '时段价格'),
        h('div', null, (time.weekdays_only ? '仅工作日' : '每天') + (time.timezone ? ' · ' + time.timezone : '')),
        periods.map(function (period) {
          return h('div', { class: 'model-tier' }, (period.start_time || '') + '–' + (period.end_time || '') +
            ' · 倍率 ' + (Number(period.multiplier) * m.mult) + 'x · 输入 ' + priceText(perM(m.pricing.input_price, m.mult * Number(period.multiplier))) +
            ' · 输出 ' + priceText(perM(m.pricing.output_price, m.mult * Number(period.multiplier))));
        })) : null,
      Object.keys(efforts).length ? h('div', { class: 'model-tier-list' }, '推理倍率：' + Object.keys(efforts).map(function (key) { return key + ' ' + efforts[key] + 'x'; }).join(' · ')) : null
    );
  }

  function perCallPricing(m) {
    var intervals = Array.isArray(m.pricing.intervals) ? m.pricing.intervals : [];
    return h('div', { class: 'model-pricing' },
      h('div', { class: 'model-pricing-head' }, h('span', null, m.mode === 'image' ? '美元 / 张' : '美元 / 次'), h('span', null, '实际价'), h('span', null, '官方价')),
      h('div', { class: 'model-pricing-row' }, h('span', null, '单价'),
        h('b', null, priceText(numberOrNull(m.pricePerCall, m.callMult))), h('span', null, priceText(numberOrNull(m.officialPerCall, 1)))),
      intervals.length ? h('div', { class: 'model-tier-list' }, h('strong', null, '分段价格'), intervals.map(function (tier) {
        var label = tier.tier_label || (tier.max_tokens == null ? '>' + U.tokens(tier.min_tokens || 0) : '≤' + U.tokens(tier.max_tokens));
        return h('div', { class: 'model-tier' }, label + ' · ' + priceText(numberOrNull(tier.per_request_price, m.callMult)));
      })) : null);
  }

  // ---------------- plaza ----------------
  function renderPlaza() {
    var S2 = global.S;
    var plaza = S2.plaza;
    var search = '';
    var gid = S2.plazaGroup || 0;
    var platform = '';
    var rate = '';
    var host = h('div', { class: 'page plaza-page' });

    var searchInput = h('input', {
      class: 'input', placeholder: '搜索模型名称、分组或厂商', type: 'search', 'aria-label': '搜索模型',
      oninput: function (e) { search = e.target.value.trim().toLowerCase(); paint(); }
    });

    var platformRow = h('div', { class: 'chips' });
    var groupsRow = h('div', { class: 'chips' });
    var rateRow = h('div', { class: 'chips' });
    var listHost = h('div', { class: 'plaza-groups' });

    function groupRate(group) {
      var value = pick(group, 'user_rate_multiplier', 'rate_multiplier', 'standard_rate_multiplier');
      return value === undefined || !isFinite(Number(value)) ? 1 : Number(value);
    }

    function chip(row, label, active, action) {
      row.appendChild(h('button', { class: 'chip' + (active ? ' active' : ''), onclick: action }, label));
    }

    function paint() {
      var groups = (plaza && plaza.groups) || [];
      platformRow.innerHTML = '';
      groupsRow.innerHTML = '';
      rateRow.innerHTML = '';
      var platforms = [];
      var rates = [];
      groups.forEach(function (g) {
        if (g.platform && platforms.indexOf(g.platform) < 0) platforms.push(g.platform);
        var value = groupRate(g);
        if (rates.indexOf(value) < 0) rates.push(value);
      });
      chip(platformRow, '全部', !platform, function () { platform = ''; paint(); });
      platforms.sort().forEach(function (value) {
        chip(platformRow, value, platform === value, function () { platform = value; paint(); });
      });
      chip(groupsRow, '全部', !gid, function () { gid = 0; global.S.plazaGroup = 0; paint(); });
      groups.forEach(function (g) {
        chip(groupsRow, g.name, String(gid) === String(g.id), function () { gid = g.id; global.S.plazaGroup = g.id; paint(); });
      });
      chip(rateRow, '全部', rate === '', function () { rate = ''; paint(); });
      rates.sort(function (a, b) { return a - b; }).forEach(function (value) {
        chip(rateRow, value + 'x', rate === value, function () { rate = value; paint(); });
      });

      var all = plazaModels(plaza);
      var filtered = groups.filter(function (g) {
        return (!gid || String(gid) === String(g.id)) && (!platform || g.platform === platform) && (rate === '' || groupRate(g) === rate);
      }).map(function (g) {
        return { group: g, models: all.filter(function (m) {
          return String(m.groupId) === String(g.id) && (!search || (m.name + ' ' + m.group + ' ' + (m.platform || '')).toLowerCase().indexOf(search) >= 0);
        }) };
      }).filter(function (item) { return item.models.length > 0; });
      filtered.sort(function (a, b) { return groupRate(a.group) - groupRate(b.group) || String(a.group.name).localeCompare(String(b.group.name)); });
      listHost.innerHTML = '';
      if (!plaza) {
        listHost.appendChild(S2.plazaLoading ? h('div', { class: 'dashboard-loading' }, '正在加载模型广场…') : emptyState('模型广场加载失败', '请点击右上角刷新重试', 'alert'));
        return;
      }
      if (!filtered.length) {
        listHost.appendChild(emptyState('没有匹配的模型', '换个关键词或分组试试', 'search'));
        return;
      }
      var count = filtered.reduce(function (sum, item) { return sum + item.models.length; }, 0);
      listHost.appendChild(h('div', { class: 'plaza-count' }, '共 ' + filtered.length + ' 个分组 · ' + count + ' 个模型'));
      filtered.forEach(function (item) {
        var group = item.group;
        listHost.appendChild(h('section', { class: 'plaza-group' },
          h('div', { class: 'plaza-group-head' },
            h('div', { class: 'row between' }, h('h2', null, group.name || '未命名分组'),
              h('span', { class: 'badge teal' }, groupRate(group) + 'x')),
            h('div', { class: 'plaza-group-meta' },
              group.platform ? h('span', null, group.platform) : null,
              group.subscription_type === 'subscription' ? h('span', { class: 'badge warn' }, '订阅') : null,
              group.is_exclusive ? h('span', { class: 'badge' }, '专属') : null,
              h('span', null, item.models.length + ' 个模型')),
            group.description ? h('p', null, group.description) : null,
            group.peak_rate_enabled ? h('p', null, '高峰 ' + (group.peak_start || '') + '–' + (group.peak_end || '') + ' · ' + group.peak_rate_multiplier + 'x') : null,
            group.image_rate_independent ? h('p', null, '图片倍率 ' + group.image_rate_multiplier + 'x') : null,
            group.video_rate_independent ? h('p', null, '视频倍率 ' + group.video_rate_multiplier + 'x') : null
          ),
          item.models.map(function (m) {
            return h('div', { class: 'plaza-model' },
              h('button', { class: 'plaza-model-heading', onclick: function () { showModelDetail(m); } },
                h('span', { class: 'plaza-model-title' }, m.name),
                h('span', { class: 'plaza-model-context' }, (m.platform || '') + (m.context ? ' · ' + U.tokens(m.context) + ' 上下文' : '') + ' ›')),
              m.mode === 'token' ? modelPricing(m) : perCallPricing(m)
            );
          })
        ));
      });
    }

    if (plaza && plaza.description) host.appendChild(h('div', { class: 'plaza-description' }, plaza.description));
    host.appendChild(searchInput);
    host.appendChild(h('div', { class: 'plaza-filter' }, h('span', null, '平台'), platformRow));
    host.appendChild(h('div', { class: 'plaza-filter' }, h('span', null, '分组'), groupsRow));
    host.appendChild(h('div', { class: 'plaza-filter' }, h('span', null, '倍率'), rateRow));
    host.appendChild(listHost);
    paint();
    return host;
  }

  // ---------------- announcements ----------------
  function renderAnnouncements(id) {
    var page = h('div', { class: 'page' });
    Api.announcements().then(function (list) {
      var items = arrOf(list);
      if (id) {
        var item = items.filter(function (a) { return String(a.id) === String(id); })[0] || items[0];
        if (!item) { page.appendChild(emptyState('公告不存在', '', 'bell')); return; }
        page.appendChild(h('div', { class: 'card pad' },
          h('h2', { style: { margin: '0 0 4px', fontSize: '18px' } }, pick(item, 'title', 'name') || '公告'),
          h('div', { class: 'tiny muted', style: { marginBottom: '12px' } }, U.date(pick(item, 'created_at', 'published_at'))),
          h('div', { class: 'small', style: { whiteSpace: 'pre-wrap', lineHeight: '1.7' } }, String(pick(item, 'content', 'body', 'summary') || ''))
        ));
        return;
      }
      if (!items.length) { page.appendChild(emptyState(Api.AUTH.isLogged() ? '暂无公告' : '请先登录', Api.AUTH.isLogged() ? '平台有新动态会显示在这里' : '登录后查看平台公告', 'bell')); return; }
      items.forEach(function (a) {
        page.appendChild(h('div', { class: 'card', style: { marginBottom: '10px' } },
          h('div', { class: 'list-item', onclick: function () { App.go('#/announcements/' + (a.id || 0)); } },
            h('span', { class: 'li-icon', html: U.ic('bell', 17) }),
            h('div', { class: 'li-body' },
              h('div', { class: 'li-title' }, pick(a, 'title', 'name') || '公告'),
              h('div', { class: 'li-sub' }, U.date(pick(a, 'created_at', 'published_at')))
            ),
            h('div', { class: 'li-tail', html: U.ic('chevron', 16) })
          )));
      });
    }).catch(function (e) {
      page.appendChild(emptyState('公告加载失败', e.message, 'alert'));
    });
    return page;
  }

  // ---------------- about ----------------
  function renderAbout() {
    var s = global.S.settings || {};
    var page = h('div', { class: 'page' });
    page.appendChild(h('div', { class: 'card pad', style: { textAlign: 'center' } },
      h('img', { src: 'img/pp-logo.jpg', width: '54', height: '54', alt: 'Pp API', style: { borderRadius: '8px' } }),
      h('h2', { style: { margin: '10px 0 2px' } }, s.site_name || 'Pp API'),
      h('div', { class: 'small muted' }, s.site_subtitle || '统一模型接入，透明用量与计费'),
      h('div', { class: 'tiny muted', style: { marginTop: '8px' } }, 'App ' + (global.Updates ? global.Updates.version() : '1.0.0') + ' · API ' + (s.version || ''))
    ));
    page.appendChild(h('div', { class: 'section' }, h('div', { class: 'list' },
      listItem('refresh', '软件更新', '检查新版本', null, function () { App.go('#/updates'); }),
      listItem('external', '访问官网', Api.ORIGIN, null, function () { open(Api.ORIGIN); }),
      listItem('doc', '服务条款', 'ipkey.vip/legal/terms', null, function () { open(Api.ORIGIN + '/legal/terms'); }),
      listItem('shield', '隐私政策', 'ipkey.vip/legal/privacy', null, function () { open(Api.ORIGIN + '/legal/privacy'); }),
      listItem('mail', '联系我们', s.contact_info || '通过官网联系', null, function () {
        if (s.contact_info) open('mailto:' + s.contact_info);
        else open(Api.ORIGIN);
      })
    )));
    page.appendChild(h('div', { class: 'section' }, h('div', { class: 'list' },
      listItem('doc', '使用规范', null, null, function () { open(Api.ORIGIN + '/legal/usage-policy'); }),
      listItem('doc', '地区与服务范围', null, null, function () { open(Api.ORIGIN + '/legal/supported-regions'); }),
      listItem('doc', '服务特定条款', null, null, function () { open(Api.ORIGIN + '/legal/service-specific-terms'); })
    )));
    var health = h('div', { class: 'section' }, h('div', { class: 'list' },
      h('div', { class: 'list-item' }, h('div', { class: 'li-body' }, h('div', { class: 'li-title' }, '接口状态'), h('div', { class: 'li-sub' }, '检测中…')))
    ));
    page.appendChild(h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, '接口连通性')), health));
    checkHealth(health);
    page.appendChild(h('div', { class: 'footer-note' }, '本应用为第三方客户端，调用官方开放接口。'));
    return page;
  }

  function checkHealth(host) {
    var rows = [
      { name: '站点配置 /settings/public', fn: function () { return Api.settings(); } },
      { name: '模型广场 /model-plaza', fn: function () { return Api.plaza(); } }
    ];
    var list = host.firstChild;
    list.innerHTML = '';
    rows.forEach(function (r) {
      var value = h('span', { class: 'badge' }, '…');
      list.appendChild(h('div', { class: 'list-item' },
        h('div', { class: 'li-body' },
          h('div', { class: 'li-title', style: { fontSize: '13px' } }, r.name),
          h('div', { class: 'li-sub' }, 'ipkey.vip')),
        h('div', { class: 'li-tail' }, value)
      ));
      var t0 = Date.now();
      r.fn().then(function () {
        value.className = 'badge ok';
        value.textContent = (Date.now() - t0) + ' ms';
      }).catch(function (e) {
        value.className = 'badge danger';
        value.textContent = '异常';
        value.title = e.message;
      });
    });
  }

  function open(url) {
    if (global.Native && global.Native.open) { global.Native.open(url); return; }
    try { global.open(url, '_blank'); } catch (e) { location.href = url; }
  }

  global.PagesCore = {
    h: h, section: section, listItem: listItem, emptyState: emptyState, card: card,
    arrOf: arrOf, totalOf: totalOf, pick: pick, balanceOf: balanceOf,
    plazaModels: plazaModels, modelRow: modelRow, platformKey: platformKey,
    renderHome: renderHome, renderPlaza: renderPlaza, renderAnnouncements: renderAnnouncements,
    renderAbout: renderAbout, open: open, priceLabel: priceLabel
  };
})(window);
