/* In-app checkout and server-backed payment status. */
(function (global) {
  'use strict';
  var U = global.U, C = global.PagesCore, h = C.h, section = C.section, pick = C.pick;
  var labels = { alipay: '支付宝', wxpay: '微信支付', daycard_balance: '余额支付' };
  var statuses = { PENDING: '待支付', PAID: '已支付，处理中', RECHARGING: '到账处理中', COMPLETED: '已完成',
    FAILED: '支付失败', EXPIRED: '已过期', CANCELLED: '已取消', REFUNDED: '已退款' };
  var accountOrders = Object.create(null);

  function externalUrl(value) {
    try {
      var url = new URL(String(value || ''), Api.ORIGIN);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return '';
      return url.href;
    } catch (e) { return ''; }
  }
  function money(value) { return Number(value).toFixed(2); }
  function subscriptionExpiry(subscription) {
    var value = pick(subscription, 'expires_at', 'expired_at', 'end_at');
    var instant = value ? new Date(value).getTime() : NaN;
    return isFinite(instant) ? instant : null;
  }
  function validityDays(plan) {
    var days = Number(plan && plan.validity_days);
    return Number.isSafeInteger(days) && days > 0 ? days : null;
  }
  function orderRequestMessage(error, fallback) {
    var message = String(error && (error.message || error) || '');
    return /access control checks|aborterror|request was cancelled|request canceled|load failed/i.test(message)
      ? '请求异常中断' : message || fallback;
  }
  function renderPurchase(initialView) {
    if (!Api.AUTH.isLogged()) return global.PagesUser.needLogin();
    var page = h('div', { class: 'page payment-page' });
    var balance = h('strong', null, '$' + U.usd(C.balanceOf(global.S.user || Api.AUTH.user() || {})));
    var formHost = h('div'), orderHost = h('div'), subscriptionHost = h('div');
    var info, config, selectedPlan = null, method = '', checking = false, ordersReady = false, formDirty = false;
    var requestedView = ['products', 'orders', 'subscriptions'].indexOf(initialView) >= 0 ? initialView : 'products';
    var view = requestedView;
    var productHost = h('div'), activeHost = h('div'), historyHost = h('div'), subscriptionsHost = h('div');
    // Balance-paid subscriptions are per model group, so everything is keyed by group id and
    // driven by what the site currently sells. Nothing about a specific plan is hardcoded.
    var cards = Object.create(null), cardRevisions = Object.create(null), uncertainGroups = Object.create(null);
    var amount = h('input', { class: 'input payment-amount', type: 'number', inputmode: 'decimal', min: '0.01', step: '0.01', placeholder: '输入充值金额', 'aria-label': '充值金额（元）' });
    var payMethods = h('div', { class: 'payment-methods' });
    var totalHint = h('div', { class: 'payment-total' });
    var submit = h('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: true, onclick: confirmOrder }, '正在检查订单…');
    var account = Api.AUTH.context();
    function storageKey(groupId) {
      return 'payment_daycard_uncertain:' + encodeURIComponent(account.id) + ':' + encodeURIComponent(groupId);
    }
    var shared = accountOrders[account.id] || (accountOrders[account.id] = { submitting: false, uncertain: false, order: null,
      daycardUncertain: false });
    var activeOrder = shared.order;

    var viewTabs = h('div', { class: 'payment-view-tabs', role: 'tablist', 'aria-label': '充值中心视图' });
    page.appendChild(h('div', { class: 'card payment-account-strip' },
      h('div', { class: 'payment-balance' }, h('span', null, '账户余额'), balance),
      h('div', { class: 'payment-account-note' }, '余额支付与在线充值都会同步到当前账号，充值前可先核对余额和当前订单。')));
    page.appendChild(viewTabs);
    page.appendChild(h('div', { class: 'payment-view-body' },
      h('section', { class: 'payment-view-panel', 'data-view': 'products' }, productHost, formHost),
      h('section', { class: 'payment-view-panel', 'data-view': 'orders', hidden: true }, activeHost, historyHost),
      h('section', { class: 'payment-view-panel', 'data-view': 'subscriptions', hidden: true }, subscriptionsHost)));

    function current() { return Api.AUTH.matches(account); }
    function routeView() {
      var match = String(global.location.hash || '').match(/^#\/(purchase|orders|subscriptions)(?:\/|$)/);
      return !match || match[1] === 'purchase' ? 'products' : match[1];
    }
    function syncRouteView() {
      if (!page.isConnected) return;
      var next = routeView();
      if (next === view) return;
      view = next;
      paintViews();
      if (view === 'orders') loadOrders(true);
      if (view === 'subscriptions') loadSubscriptions();
    }
    function activate() {
      syncRouteView();
      paintViews();
      if (view === 'orders') loadOrders(true);
      if (view === 'subscriptions') loadSubscriptions();
    }
    function paintViews() {
      var defs = [
        { key: 'products', label: '商品' },
        { key: 'orders', label: '订单' },
        { key: 'subscriptions', label: '订阅' }
      ];
      viewTabs.innerHTML = '';
      defs.forEach(function (def) {
        viewTabs.appendChild(h('button', {
          type: 'button', role: 'tab', 'aria-selected': view === def.key ? 'true' : 'false',
          class: view === def.key ? 'active' : '', onclick: function () {
            view = def.key;
            var nextPath = view === 'products' ? '#/purchase' : view === 'orders' ? '#/orders' : '#/subscriptions';
            if (global.location.hash !== nextPath) {
              global.history.replaceState(null, '', nextPath);
            }
            paintViews();
            if (view === 'orders') loadOrders(true);
            if (view === 'subscriptions') loadSubscriptions();
          }
        }, def.label));
      });
      Array.prototype.forEach.call(page.querySelectorAll('.payment-view-panel'), function (panel) {
        panel.hidden = panel.getAttribute('data-view') !== view;
      });
    }
    function syncSubmitAfterOrders() {
      if (!info || !config) return;
      updateSubmit();
    }
    function groupOf(plan) {
      var gid = Number(plan && plan.group_id);
      return Number.isSafeInteger(gid) && gid > 0 ? gid : null;
    }
    function currentGroup() { return groupOf(selectedPlan); }
    function cardFor(groupId) { return groupId ? cards[groupId] || null : null; }
    function cardState() { var card = cardFor(currentGroup()); return card ? card.state : 'idle'; }
    function cardError() { var card = cardFor(currentGroup()); return card ? card.error : ''; }
    // Keep showing the last known card while a refresh is in flight, so the balance option
    // does not flicker away and the chosen payment method is not silently reset.
    function currentCard() { var card = cardFor(currentGroup()); return card && card.data ? card.data : null; }
    function isDaycardPlan() {
      var card = currentCard(), gid = currentGroup();
      return !!card && !!selectedPlan && gid !== null && String(selectedPlan.id) === String(card.plan.id) &&
        String(card.plan.group_id) === String(gid);
    }
    function daycardUncertain() { var gid = currentGroup(); return !!(gid && uncertainGroups[gid]); }
    function setDaycardUncertain(value, groupId) {
      var gid = groupId || currentGroup();
      if (!gid) return;
      uncertainGroups[gid] = !!value;
      if (value) U.store.set(storageKey(gid), true); else U.store.del(storageKey(gid));
    }
    function daycardOrderBlocked() {
      return !!selectedPlan && daycardUncertain();
    }
    function showOrders() {
      if (view === 'orders') {
        paintViews();
        return;
      }
      view = 'orders'; paintViews();
    }
    function updateSubmit() {
      var balancePayment = method === 'daycard_balance';
      if (!info || !config) {
        submit.disabled = true;
        submit.textContent = ordersReady ? '正在加载充值信息…' : '正在检查订单…';
        return;
      }
      var card = currentCard();
      submit.disabled = !ordersReady || shared.submitting || !!activeOrder || shared.uncertain ||
        daycardOrderBlocked() ||
        (balancePayment && (cardState() !== 'ready' || !card || !isDaycardPlan() || Number(card.user.balance) < Number(card.plan.price)));
      submit.textContent = shared.submitting ? (balancePayment ? '正在处理订阅…' : '正在创建订单…') : !ordersReady ? '正在检查订单…' :
        activeOrder ? '请先处理当前订单' : shared.uncertain ? '请先检查订单记录' :
        daycardOrderBlocked() ? '请先核对订阅状态' :
        balancePayment && cardState() === 'loading' ? '正在核对订阅…' :
        balancePayment && card && !isDaycardPlan() ? '订阅信息不可用' :
        balancePayment && card && Number(card.user.balance) < Number(card.plan.price) ? '账户余额不足' :
        balancePayment ? (card && card.subscription ? '叠加续费' : '确认余额支付') : '确认订单';
    }
    function notifyOrder() { global.dispatchEvent(new CustomEvent('pp:payment-changed', { detail: account.id })); }
    function methods() {
      return Object.keys(info.methods || {}).filter(function (key) {
        var item = info.methods[key];
        return (key === 'alipay' || key === 'wxpay') && item && item.available !== false &&
          (!item.currency || item.currency === 'CNY') &&
          (!Array.isArray(config.enabled_payment_types) || config.enabled_payment_types.indexOf(key) >= 0);
      });
    }
    function orderAmount() { return selectedPlan ? Number(selectedPlan.price) : Number(amount.value); }
    function readDaycard(groupId) {
      return Api.daycardInfo(groupId).then(function (data) {
        var plan = data && data.plan, user = data && data.user;
        var knownUser = Api.AUTH.user();
        if (!plan || !Number.isSafeInteger(Number(plan.id)) || Number(plan.id) <= 0 || !plan.name ||
            !isFinite(Number(plan.price)) || Number(plan.price) <= 0 || Math.abs(Number(plan.price) * 100 - Math.round(Number(plan.price) * 100)) > 0.000001 ||
            plan.currency !== 'CNY' || !user || user.balance === null || user.balance === '' || !isFinite(Number(user.balance)) || Number(user.balance) < 0 ||
            !Object.prototype.hasOwnProperty.call(data, 'subscription') ||
            (data.subscription !== null && (typeof data.subscription !== 'object' || Array.isArray(data.subscription))) ||
            String(plan.group_id) !== String(groupId) ||
            (knownUser && knownUser.id != null && (user.id == null || String(user.id) !== String(knownUser.id)))) {
          throw new Error('订阅信息不完整，请刷新后重试');
        }
        return data;
      });
    }
    function applyDaycard(groupId, data) {
      cards[groupId] = { state: 'ready', data: data, error: '' };
      if (info && config) paintForm();
    }
    function loadDaycard(groupId) {
      var gid = Number(groupId);
      if (!Number.isSafeInteger(gid) || gid <= 0) return Promise.resolve();
      var revision = cardRevisions[gid] = (cardRevisions[gid] || 0) + 1;
      var previous = cards[gid];
      cards[gid] = { state: 'loading', data: previous && previous.data, error: '' };
      if (info && config) paintForm();
      return readDaycard(gid).then(function (data) {
        if (revision !== cardRevisions[gid] || !current() || !page.isConnected) return;
        applyDaycard(gid, data);
      }).catch(function (error) {
        if (revision !== cardRevisions[gid] || !current() || !page.isConnected) return;
        // A rejection that names the group itself means the site simply has no plan there.
        cards[gid] = { state: 'error', data: null, error: error.message || '订阅信息加载失败' };
        if (method === 'daycard_balance' && String(currentGroup()) === String(gid)) method = methods()[0] || '';
        if (info && config) paintForm();
      });
    }
    function loadAllCards() {
      var seen = Object.create(null);
      plans().forEach(function (plan) {
        var gid = groupOf(plan);
        if (!gid || seen[gid]) return;
        seen[gid] = true;
        loadDaycard(gid);
      });
    }
    function plans() { return info && Array.isArray(info.plans) ? info.plans : []; }
    function planSignature() {
      return plans().map(function (plan) {
        return [plan.id, plan.group_id, plan.name, plan.price, plan.validity_days, plan.description].join(':');
      }).join('|');
    }
    function mergeLivePlans(nextPlans) {
      if (!Array.isArray(nextPlans)) return;
      var selectedId = selectedPlan && String(selectedPlan.id);
      var previousSignature = planSignature();
      info.plans = nextPlans;
      var selectedNow = selectedId && nextPlans.filter(function (plan) { return String(plan.id) === selectedId; })[0];
      if (selectedPlan && selectedNow && !formDirty) {
        selectedPlan = selectedNow;
      } else if (selectedPlan && !selectedNow && formDirty) {
        selectedPlan = null;
        method = methods()[0] || '';
        formDirty = false;
        U.toast('当前商品已下架，商品列表已同步', 'err');
      }
      if (previousSignature !== planSignature()) {
        paintForm();
        loadAllCards();
      }
    }
    function paymentFee(value) {
      var rate = Number(info.recharge_fee_rate || config.recharge_fee_rate || 0);
      return isFinite(rate) && rate > 0 ? Math.ceil(value * rate - 0.0000001) / 100 : 0;
    }
    function updateTotal() {
      var card = currentCard();
      if (method === 'daycard_balance' && isDaycardPlan()) {
        totalHint.textContent = '余额支付 ¥' + money(card.plan.price) + ' · 免支付通道费';
        return;
      }
      var value = orderAmount();
      totalHint.textContent = isFinite(value) && value > 0
        ? '订单金额 ¥' + money(value) + ((!selectedPlan && Array.isArray(info.recharge_bonus_tiers) && info.recharge_bonus_tiers.length) || Number((info.methods[method] || {}).fee_rate) > 0
          ? ' · 优惠与手续费以收银台为准' : (paymentFee(value) ? ' · 预计通道费 ¥' + money(paymentFee(value)) + ' · 预计支付 ¥' + money(value + paymentFee(value)) : ''))
        : '请输入金额';
    }
    function paintMethods() {
      payMethods.innerHTML = '';
      if (isDaycardPlan()) {
        var card = currentCard();
        payMethods.appendChild(h('label', { class: 'payment-choice' },
          h('input', { type: 'radio', name: 'payment-method', value: 'daycard_balance', checked: method === 'daycard_balance',
            onchange: function () { method = 'daycard_balance'; paintForm(); } }),
          h('span', null, h('strong', null, '余额支付'), h('small', null, '余额 ¥' + money(card.user.balance) + ' · 免通道费'))));
      }
      methods().forEach(function (key) {
        payMethods.appendChild(h('label', { class: 'payment-choice' },
          h('input', { type: 'radio', name: 'payment-method', value: key, checked: key === method,
            onchange: function () { method = key; paintForm(); } }), h('span', null, labels[key])));
      });
    }
    function paintForm() {
      if (!info || !config) {
        formHost.innerHTML = '';
        formHost.appendChild(h('div', { class: 'dashboard-loading' }, '正在加载充值信息…'));
        return;
      }
      formHost.innerHTML = '';
      var canBalance = !info.balance_disabled && !config.balance_disabled;
      var list = plans();
      if (!canBalance && !list.length) { formHost.appendChild(h('div', { class: 'notice warn section' }, '当前没有可购买的商品')); return; }
      if (!selectedPlan && !canBalance && list.length) selectedPlan = list[0];
      if (method === 'daycard_balance' && cardState() !== 'loading' && !isDaycardPlan()) method = methods()[0] || '';
      var choices = h('div', { class: 'payment-products' });
      if (list.length) {
        choices.appendChild(h('div', { class: 'payment-product-group' },
          h('div', { class: 'payment-product-group-head' },
            h('strong', null, '订阅商品'),
            h('span', null, '价格与上架状态跟随站内实时同步')),
          h('div', { class: 'payment-product-grid' }, list.map(function (plan) {
            var gid = groupOf(plan), card = cardFor(gid);
            var payable = card && card.state === 'ready' && String(card.data.plan.group_id) === String(gid);
            return h('label', { class: 'payment-choice payment-plan-choice' + (selectedPlan && String(selectedPlan.id) === String(plan.id) ? ' selected' : '') },
              h('input', { type: 'radio', name: 'payment-product', checked: selectedPlan && String(selectedPlan.id) === String(plan.id),
                onchange: function () {
                  if (selectedPlan && String(selectedPlan.id) === String(plan.id)) return;
                  selectedPlan = plan;
                  formDirty = true;
                  if (gid && !cards[gid]) loadDaycard(gid);
                  paintForm();
                } }),
              h('span', { class: 'payment-plan-copy' },
                h('strong', null, plan.name || '订阅套餐'),
                plan.group_name ? h('em', null, plan.group_name) : null,
                h('span', { class: 'payment-plan-price-row' },
                  h('small', null, '¥' + money(plan.price) + (plan.validity_days ? ' · ' + plan.validity_days + ' 天' : '')),
                  payable ? h('span', { class: 'badge ok payment-plan-payable' }, '可余额支付') : null)));
          }))));
      }
      formHost.appendChild(section('选择商品', null, null, choices));
      productHost.innerHTML = '';
      productHost.appendChild(h('div', { class: 'payment-service-strip' },
        h('span', { class: 'payment-service-icon', html: U.ic('refresh', 17) }),
        h('div', null, h('strong', null, '站内商品实时同步'),
          h('span', null, list.length ? '余额充值与 ' + list.length + ' 个订阅商品可用' : '余额充值可用，订阅商品暂未上架')),
        h('span', { class: 'badge ok' }, '实时')));
      if (selectedPlan) {
        formHost.appendChild(h('div', { class: 'payment-plan-detail' },
          selectedPlan.description ? h('div', null, selectedPlan.description) : null,
          Array.isArray(selectedPlan.features) ? selectedPlan.features.map(function (feature) { return h('div', null, '· ' + feature); }) : null));
      } else {
        formHost.appendChild(section('充值金额（元）', null, null, h('div', null, amount,
          h('div', { class: 'payment-amount-presets' }, amountPresets().map(function (value) {
            return h('button', {
              type: 'button', class: amountPresetClass(value),
              onclick: function () {
                amount.value = String(value);
                updateTotal();
                paintAmountPresets();
              }
            }, '¥' + value);
          })),
          h('div', { class: 'tiny muted payment-limit' }, (Number(config.min_amount) > 0 ? '单笔最低 ¥' + money(config.min_amount) : '') +
            (Number(config.max_amount) > 0 ? ' · 最高 ¥' + money(config.max_amount) : '') +
            (Number(config.daily_limit) > 0 ? ' · 每日上限 ¥' + money(config.daily_limit) : '')))));
      }
      formHost.appendChild(section('支付方式', null, null, payMethods));
      var gid = currentGroup(), state = cardState(), card = currentCard();
      if (selectedPlan && gid && state === 'loading' && !card) {
        formHost.appendChild(h('div', { class: 'payment-balance-note' }, '正在查询该分组的余额支付信息…'));
      }
      if (selectedPlan && gid && state === 'error') formHost.appendChild(h('div', { class: 'notice warn payment-balance-note' },
        cardError() + (daycardUncertain() ? ' 上次余额支付结果未确认，请先重试并核对状态。' : '') +
        ' ', h('button', { type: 'button', onclick: function () { loadDaycard(gid); } }, '重试')));
      if (isDaycardPlan()) {
        formHost.appendChild(h('div', { class: 'payment-balance-note' }, '账户余额 ¥' + money(card.user.balance) + ' · 订阅价格 ¥' + money(card.plan.price) +
          (card.subscription ? ' · 已生效' + (card.subscription.expires_at ? '，有效至 ' + U.datetimeSeconds(card.subscription.expires_at) + '，可叠加续费' : '，可叠加续费') : '')));
        if (daycardUncertain()) formHost.appendChild(h('div', { class: 'notice warn payment-balance-note' },
          '上次余额支付结果未确认，请先刷新并核对订阅状态及余额，避免重复扣款。 ',
          h('button', { type: 'button', onclick: function () { loadDaycard(gid); } }, '刷新状态'), ' ',
          h('button', { type: 'button', disabled: state !== 'ready', onclick: clearDaycardUncertain }, '已核对，允许重试')));
      }
      formHost.appendChild(totalHint);
      formHost.appendChild(submit);
      if (info.help_text || config.help_text) formHost.appendChild(h('div', { class: 'payment-help' }, info.help_text || config.help_text));
      paintMethods(); updateTotal(); updateSubmit();
    }
    function amountPresets() {
      var min = Math.max(0.01, Number(config && config.min_amount) || 0.01);
      var max = Number(config && config.max_amount);
      var values = [];
      var tiers = info && Array.isArray(info.recharge_bonus_tiers) ? info.recharge_bonus_tiers : [];
      tiers.forEach(function (tier) {
        var value = Number(pick(tier, 'amount', 'threshold', 'min_amount', 'min_recharge', 'recharge_amount'));
        if (isFinite(value) && value > 0 && values.indexOf(value) < 0) values.push(value);
      });
      [20, 50, 100, 200].forEach(function (value) {
        if (values.length < 4 && values.indexOf(value) < 0) values.push(value);
      });
      return values.filter(function (value) {
        return value >= min && (!isFinite(max) || max <= 0 || value <= max);
      }).sort(function (a, b) { return a - b; }).slice(0, 4);
    }
    function amountPresetClass(value) {
      return Number(amount.value) === value ? 'active' : '';
    }
    function paintAmountPresets() {
      Array.prototype.forEach.call(formHost.querySelectorAll('.payment-amount-presets button'), function (button) {
        button.classList.toggle('active', Number(amount.value) === Number(String(button.textContent).replace(/[^\d.]/g, '')));
      });
    }
    amount.addEventListener('input', updateTotal);
    amount.addEventListener('input', paintAmountPresets);

    function validation() {
      var value = orderAmount(), selectedMethod = info.methods && info.methods[method] || {};
      if (!config.enabled) return '充值服务当前未启用';
      if (methods().indexOf(method) < 0) return '请选择可用的支付方式';
      if (!isFinite(value) || value <= 0 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) return '请输入有效金额，最多保留两位小数';
      if (selectedPlan && (!Number.isInteger(Number(selectedPlan.id)) || Number(selectedPlan.id) <= 0)) return '套餐信息无效，请重新加载';
      if (selectedPlan && selectedPlan.currency && selectedPlan.currency !== 'CNY') return '暂不支持此套餐的货币，请在官网购买';
      if (!selectedPlan && (info.balance_disabled || config.balance_disabled)) return '余额充值暂不可用';
      var min = Math.max(selectedPlan ? 0 : Number(config.min_amount) || 0, Number(info.global_min) || 0, Number(selectedMethod.single_min) || 0);
      var limits = [selectedPlan ? 0 : config.max_amount, info.global_max, selectedMethod.single_max].map(Number).filter(function (n) { return isFinite(n) && n > 0; });
      var max = limits.length ? Math.min.apply(null, limits) : Infinity;
      if (value < min || value > max) return '金额超出当前支付方式的单笔限额';
      return '';
    }
    function confirmOrder() {
      if (!ordersReady || shared.submitting || activeOrder || shared.uncertain || daycardOrderBlocked() || !current()) return;
      if (method === 'daycard_balance') { confirmDaycard(); return; }
      var error = validation();
      if (error) { U.toast(error, 'err'); return; }
      var value = orderAmount(), chosenMethod = method, plan = selectedPlan;
      var description = (plan ? '订阅：' + (plan.name || '套餐') : '充值余额') + '\n订单金额：¥' + money(value) +
        '\n支付方式：' + labels[chosenMethod] +
        ((!plan && Array.isArray(info.recharge_bonus_tiers) && info.recharge_bonus_tiers.length) || Number((info.methods[chosenMethod] || {}).fee_rate) > 0 ? '\n优惠与手续费以收银台为准。' :
          '\n预计通道费：¥' + money(paymentFee(value)) + '\n预计支付：¥' + money(value + paymentFee(value)) + '\n实际支付金额以收银台为准。');
      U.confirm('确认创建订单', description, '创建订单').then(function (ok) {
        if (!ok || shared.submitting || shared.order || shared.uncertain || daycardOrderBlocked() || !current()) return;
        if (validation() || orderAmount() !== value || method !== chosenMethod || selectedPlan !== plan) {
          U.toast('订单内容已变化，请重新确认', 'err'); return;
        }
        shared.submitting = true; updateSubmit(); notifyOrder();
        var payload = { amount: value, payment_type: chosenMethod, order_type: plan ? 'subscription' : 'balance',
          is_mobile: !(chosenMethod === 'alipay' && info.alipay_force_qrcode && !info.alipay_mobile_precreate_deep_link),
          payment_source: 'hosted_redirect', return_url: Api.ORIGIN + '/payment/result' };
        if (plan) payload.plan_id = Number(plan.id);
        Api.createOrder(payload).then(function (order) {
          if (!order || !Number.isSafeInteger(Number(order.order_id)) || Number(order.order_id) <= 0) throw new Error('订单结果不完整，请先查看订单记录，避免重复下单');
          shared.order = { id: order.order_id, amount: value, payment_type: chosenMethod, order_type: payload.order_type,
            out_trade_no: order.out_trade_no || '', pay_url: order.pay_url || order.url || order.cashier_url || '',
            qr_code: order.qr_code || '', expires_at: order.expires_at || '', status: 'PENDING', pay_amount: order.pay_amount };
          if (current()) {
            activeOrder = shared.order;
            showOrders();
            paintActiveOrder();
            loadOrders(true);
          }
        }).catch(function (e) {
          shared.uncertain = true;
          if (current()) {
            U.toast(orderRequestMessage(e, '创建订单失败') + '。请先检查订单记录。', 'err');
            showOrders();
            loadOrders(true);
          }
        }).finally(function () { shared.submitting = false; updateSubmit(); notifyOrder(); });
      });
    }

    function clearDaycardUncertain() {
      if (!current() || shared.submitting || cardState() !== 'ready' || !isDaycardPlan()) return;
      U.confirm('确认已核对', '请确认已刷新并核对订阅状态、账户余额及平台记录。若上次扣款仍在处理中，再次支付可能重复扣款。', '允许重试').then(function (ok) {
        if (!ok || !current() || shared.submitting || cardState() !== 'ready' || !isDaycardPlan()) return;
        setDaycardUncertain(false); paintForm(); notifyOrder();
      });
    }

    function confirmDaycard() {
      var card = currentCard(), gid = currentGroup();
      if (!card || !gid || cardState() !== 'ready' || !isDaycardPlan() || daycardUncertain() ||
          Number(card.user.balance) < Number(card.plan.price)) return;
      var chosenPlan = selectedPlan, displayedPrice = Number(card.plan.price);
      var revision = cardRevisions[gid] = (cardRevisions[gid] || 0) + 1;
      shared.submitting = true; updateSubmit(); notifyOrder();
      readDaycard(gid).then(function (fresh) {
        if (!current() || !page.isConnected || revision !== cardRevisions[gid]) return;
        applyDaycard(gid, fresh);
        if (method !== 'daycard_balance' || selectedPlan !== chosenPlan || !isDaycardPlan() || Number(fresh.plan.price) !== displayedPrice) {
          U.toast('订阅信息已变化，请重新确认', 'err'); return;
        }
        if (daycardUncertain()) { U.toast('上次支付结果未确认，请先核对', 'err'); return; }
        shared.submitting = false; updateSubmit(); notifyOrder();
        var price = Number(fresh.plan.price), available = Number(fresh.user.balance);
        var expiry = subscriptionExpiry(fresh.subscription), checkedAt = Date.now();
        var renewing = expiry !== null && expiry > checkedAt;
        var days = validityDays(fresh.plan) || validityDays(chosenPlan);
        var estimate = days && (!fresh.subscription || expiry !== null) ? new Date((renewing ? expiry : checkedAt) + days * 86400000) : null;
        function line(label, value, tone) {
          return h('div', null, h('dt', null, label), h('dd', tone ? { class: tone } : null, value));
        }
        var summary = h('div', { class: 'payment-confirm-summary' }, h('strong', null, fresh.plan.name),
          h('dl', null, line('应付金额', '¥' + money(price)), line('账户余额', '¥' + U.usd(available)),
            line('余额状态', available >= price ? '余额足够' : '余额不足', available >= price ? 'latency-good' : 'latency-bad'),
            line('增加时长', days ? days + ' 天' : '以平台为准'),
            expiry !== null ? line('当前到期', U.datetimeSeconds(expiry)) : null,
            line('预计到期', estimate && isFinite(estimate.getTime()) ? U.datetimeSeconds(estimate) : '以平台为准')),
          h('p', { class: 'small muted' }, available >= price ? '确认后立即扣款，实际有效期以平台到账结果为准。' : '余额不足，本次不会扣款。'));
        if (available < price) {
          U.sheet({ title: '确认余额支付', body: summary, actions: [{ label: '关闭' }] });
          return;
        }
        U.confirm('确认余额支付', summary, fresh.subscription && (renewing || expiry === null) ? '确认续费' : '确认支付').then(function (ok) {
          if (!ok || !current() || !page.isConnected || shared.submitting || daycardUncertain() || shared.uncertain || shared.order ||
              method !== 'daycard_balance' || selectedPlan !== chosenPlan) return;
          shared.submitting = true;
          var confirmedRevision = cardRevisions[gid] = (cardRevisions[gid] || 0) + 1;
          updateSubmit(); notifyOrder();
          readDaycard(gid).then(function (latest) {
            if (!current() || !page.isConnected || confirmedRevision !== cardRevisions[gid]) return null;
            applyDaycard(gid, latest);
            if (method !== 'daycard_balance' || selectedPlan !== chosenPlan || !isDaycardPlan() ||
                latest.plan.name !== fresh.plan.name || Number(latest.plan.price) !== displayedPrice || Number(latest.user.balance) !== available ||
                (validityDays(latest.plan) || validityDays(chosenPlan)) !== days ||
                !!latest.subscription !== !!fresh.subscription || subscriptionExpiry(latest.subscription) !== expiry ||
                (expiry !== null && (expiry > Date.now()) !== renewing)) {
              U.toast('订阅价格、余额或状态已变化，请重新确认', 'err'); return null;
            }
            setDaycardUncertain(true, gid);
            return Api.daycardBuy(gid);
          }).then(function (result) {
            if (result === null) return;
            var paid = result.paid !== undefined ? result.paid : result.amount;
            if (paid === null || paid === undefined || paid === '' || !isFinite(Number(paid)) || Number(paid) < 0) {
              throw new Error('支付结果不完整');
            }
            setDaycardUncertain(false, gid);
            if (current()) U.toast((fresh.subscription && (renewing || expiry === null) ? '续费成功' : '订阅开通成功') + '，已扣 ¥' + money(paid), 'ok');
            if (current()) {
              loadDaycard(gid); loadSubscriptions(); loadOrders();
              App.refreshUser().then(function (user) {
                if (!current() || !user) return;
                balance.textContent = '$' + U.usd(C.balanceOf(user || {}));
              }).catch(function () {});
            }
          }).catch(function (error) {
            var definite = error.final === true ||
              (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429);
            if (definite) { setDaycardUncertain(false, gid); }
            if (current()) {
              U.toast(orderRequestMessage(error, '余额支付失败') + (daycardUncertain() ? '。请先核对订阅状态和余额。' : ''), 'err');
              loadDaycard(gid); loadSubscriptions();
            }
          }).finally(function () {
            shared.submitting = false;
            if (current() && info && config) paintForm();
            notifyOrder();
          });
        });
      }).catch(function (error) {
        if (current()) { U.toast(error.message || '订阅信息加载失败', 'err'); if (error.status) loadDaycard(gid); }
      }).finally(function () {
        shared.submitting = false;
        if (current() && info && config) paintForm();
        notifyOrder();
      });
    }

    function paintActiveOrder() {
      var host = activeHost.querySelector('.payment-active');
      if (host) host.remove();
      if (!activeOrder) return;
      var order = activeOrder, state = String(order.status || '').toUpperCase();
      var panel = h('div', { class: 'payment-active section' }, h('div', { class: 'section-head' }, h('h2', null, '当前订单')),
        h('div', { class: 'payment-order-panel' },
          h('div', { class: 'row between' }, h('strong', null, statuses[state] || '状态未知'), h('strong', null, '¥' + money(order.pay_amount || order.amount || 0))),
          h('div', { class: 'tiny muted' }, '订单 #' + order.id + (order.out_trade_no ? ' · ' + order.out_trade_no : '')),
          order.expires_at ? h('div', { class: 'tiny muted' }, '有效至 ' + U.datetime(order.expires_at)) : null));
      var box = panel.lastChild;
      if (state === 'PENDING' && order.qr_code) {
        try {
          var qr = global.qrcode(0, 'M'); qr.addData(String(order.qr_code)); qr.make();
          var img = h('img', { class: 'payment-qr', src: qr.createDataURL(5, 4), alt: '支付二维码' });
          box.appendChild(img);
          box.appendChild(h('div', { class: 'tiny muted' }, '使用' + (labels[order.payment_type] || '支付应用') + '扫描二维码'));
        } catch (e) { box.appendChild(h('div', { class: 'notice warn' }, '二维码无法显示，请尝试打开收银台')); }
      }
      var safeUrl = externalUrl(order.pay_url);
      if (state === 'PENDING' && safeUrl) box.appendChild(h('button', { class: 'btn btn-primary btn-block', onclick: function () {
        U.confirm('打开支付页面', '即将打开支付服务商页面：\n' + new URL(safeUrl).hostname + '\n实际金额以收银台为准。', '继续').then(function (ok) { if (ok && current()) C.open(safeUrl); });
      } }, '打开支付页面'));
      if (state === 'PENDING' && order.pay_url && !safeUrl) box.appendChild(h('div', { class: 'notice warn' }, '支付链接不安全，已阻止打开。请联系平台客服。'));
      if (state === 'PENDING' && !order.qr_code && !safeUrl) box.appendChild(h('div', { class: 'notice warn' }, '此订单的支付方式无法在应用内展示，请先到官网订单页查看，避免重复下单。'));
      box.appendChild(h('div', { class: 'payment-order-actions' },
        h('button', { class: 'btn btn-sm', disabled: checking, onclick: function () { refreshOrder(order); } }, checking ? '查询中…' : '刷新支付状态'),
        state === 'PENDING' ? h('button', { class: 'btn btn-sm', onclick: function () { cancel(order); } }, '取消订单') :
          h('button', { class: 'btn btn-sm', onclick: function () { activeOrder = null; shared.order = null; updateSubmit(); paintActiveOrder(); notifyOrder(); } }, '关闭')));
      activeHost.insertAdjacentElement('beforeend', panel);
      if (panel.isConnected && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ block: 'nearest' });
    }
    function refreshOrder(order) {
      if (checking || !current()) return;
      checking = true; paintActiveOrder();
      Api.paymentOrder(order.id).then(function (updated) {
        if (!current() || !updated || String(updated.id) !== String(order.id)) throw new Error('订单状态返回不完整');
        if (String(updated.status || '').toUpperCase() === 'PENDING' && updated.out_trade_no) {
          return Api.verifyOrder(updated.out_trade_no).then(function (verified) {
            return verified && String(verified.id) === String(order.id) && verified.status ? verified : updated;
          }).catch(function () { return updated; });
        }
        return updated;
      }).then(function (updated) {
        if (!current() || !activeOrder || String(activeOrder.id) !== String(order.id)) return;
        if (!updated || String(updated.id) !== String(order.id) || !updated.status) throw new Error('订单状态返回不完整');
        activeOrder = Object.assign({}, order, updated);
        if (!updated.pay_url) activeOrder.pay_url = order.pay_url;
        if (!updated.qr_code) activeOrder.qr_code = order.qr_code;
        shared.order = activeOrder;
        if (String(updated.status).toUpperCase() === 'COMPLETED') {
          App.refreshUser().then(function (user) {
            if (!current() || !user) return;
            balance.textContent = '$' + U.usd(C.balanceOf(user || {}));
          }).catch(function () {});
          loadSubscriptions();
        }
        loadOrders();
      }).catch(function (e) { if (current()) U.toast(e.message || '订单状态查询失败', 'err'); })
        .finally(function () { checking = false; if (current()) paintActiveOrder(); });
    }
    function cancel(order) {
      U.confirm('取消订单', '确认取消该待支付订单？', '取消订单', true).then(function (ok) {
        if (!ok || !current()) return;
        Api.cancelOrder(order.id).then(function () { if (activeOrder && String(activeOrder.id) === String(order.id)) refreshOrder(order); loadOrders(); })
          .catch(function (e) { U.toast(e.message, 'err'); });
      });
    }
    function loadOrders(revealOrder, silent) {
      silent = silent === true && !!historyHost.firstElementChild;
      if (!silent) historyHost.innerHTML = '';
      return Promise.all([Api.myOrders({ page: 1, page_size: 20 }), Api.myOrders({ page: 1, page_size: 1, status: 'PENDING' })]).then(function (results) {
        if (!current()) return;
        var data = results[0], pendingData = results[1];
        var items = C.arrOf(data);
        if (!data || !Array.isArray(data.items) || !pendingData || !Array.isArray(pendingData.items) ||
            !Number.isInteger(Number(pendingData.total)) || Number(pendingData.total) < pendingData.items.length ||
            (Number(pendingData.total) > 0 && !pendingData.items.length)) throw new Error('订单记录返回不完整');
        ordersReady = true;
        if (activeOrder) {
          var listed = items.filter(function (item) { return String(item.id) === String(activeOrder.id); })[0];
          if (listed) { activeOrder = Object.assign({}, activeOrder, listed); shared.order = activeOrder; paintActiveOrder(); }
        }
        if (!activeOrder && !shared.submitting) {
          var pending = pendingData.items.filter(function (order) { return String(order.status || '').toUpperCase() === 'PENDING'; })[0];
          if (Number(pendingData.total) > 0 && !pending) throw new Error('待支付订单状态返回不完整');
          if (pending) {
            activeOrder = pending;
            shared.order = pending;
            paintActiveOrder();
            revealOrder = true;
          }
        }
        if (!activeOrder && !activeHost.querySelector('.payment-empty')) {
          activeHost.insertAdjacentElement('afterbegin', h('div', { class: 'payment-empty card' },
            h('div', { class: 'dashboard-empty' }, '当前没有待支付订单')));
        } else if (activeOrder) {
          var empty = activeHost.querySelector('.payment-empty');
          if (empty) empty.remove();
        }
        syncSubmitAfterOrders();
        if (revealOrder && activeOrder) showOrders();
        historyHost.innerHTML = '';
        historyHost.appendChild(section('历史订单', '刷新', function () { loadOrders(true); }, items.length ? h('div', { class: 'payment-orders' }, items.map(function (order) {
          var status = String(order.status || '').toUpperCase();
          return h('div', { class: 'payment-order-row' }, h('div', null, h('strong', null, (order.order_type === 'subscription' ? '订阅' : '充值') + ' · ¥' + money(order.amount || 0)),
            h('div', { class: 'tiny muted' }, '#' + order.id + ' · ' + U.datetime(order.created_at))),
            h('button', { class: 'btn btn-sm', onclick: function () {
              if (activeOrder && String(activeOrder.id) !== String(order.id)) { U.toast('请先处理当前订单', 'err'); return; }
              activeOrder = order; shared.order = order; updateSubmit(); paintActiveOrder(); refreshOrder(order);
            } }, statuses[status] || '查看状态'));
        })) : h('div', { class: 'dashboard-empty' }, '暂无订单')));
        if (shared.uncertain && !activeOrder) historyHost.appendChild(h('button', { class: 'btn btn-sm', onclick: function () {
          U.confirm('确认检查订单', '请确认已检查最近订单，避免重复支付。', '已检查').then(function (ok) {
            if (!ok || !current() || activeOrder) return;
            shared.uncertain = false; updateSubmit(); loadOrders(); notifyOrder();
          });
        } }, '已检查订单，继续下单'));
      }).catch(function (e) {
        if (!current()) return;
        if (silent) return;
        ordersReady = false; syncSubmitAfterOrders();
        historyHost.innerHTML = '';
        historyHost.appendChild(h('div', { class: 'notice warn section' }, '订单加载失败：' + e.message, ' ', h('button', { onclick: loadOrders }, '重试')));
        paintForm();
        showOrders();
      });
    }
    function loadSubscriptions(silent) {
      silent = silent === true && !!subscriptionsHost.firstElementChild;
      return Api.subscriptions().then(function (data) {
        if (!current()) return;
        var list = C.arrOf(data); subscriptionsHost.innerHTML = '';
        subscriptionsHost.appendChild(section('我的订阅', null, null, list.length ? C.card(list.map(function (item) {
          var until = pick(item, 'expires_at', 'expired_at', 'end_at');
          return h('div', { class: 'list-item' }, h('div', { class: 'li-body' }, h('div', { class: 'li-title' }, pick(item, 'group_name', 'name') || (item.group && item.group.name) || '模型订阅'),
            h('div', { class: 'li-sub' }, until ? '有效至 ' + U.datetimeSeconds(until) : '有效订阅')), h('span', { class: 'badge ok' }, '生效中'));
        })) : h('div', { class: 'dashboard-empty' }, '暂无生效订阅')));
      }).catch(function () { if (current() && !silent) subscriptionsHost.textContent = '订阅状态暂不可用'; });
    }
    formHost.appendChild(h('div', { class: 'dashboard-loading' }, '正在加载充值信息…'));
    function loadConfig() {
      return Promise.all([Api.paymentInfo(), Api.paymentConfig()]).then(function (result) {
        if (!current()) return;
        var nextInfo = result[0], nextConfig = result[1];
        if (!nextInfo || typeof nextInfo !== 'object' || !nextConfig || typeof nextConfig !== 'object') {
          throw new Error('充值配置返回不完整');
        }
        info = Object.assign({}, info || {}, nextInfo);
        config = Object.assign({}, config || {}, nextConfig);
        if (methods().indexOf(method) < 0) method = methods()[0] || '';
        var list = plans();
        var stillListed = selectedPlan && list.filter(function (plan) {
          return String(plan.id) === String(selectedPlan.id);
        })[0];
        if (stillListed) {
          selectedPlan = stillListed;
        } else if (selectedPlan) {
          selectedPlan = null;
          formDirty = false;
          if (!document.hidden) U.toast('当前商品已下架，商品列表已同步', 'err');
        }
        plans().forEach(function (plan) {
          var gid = groupOf(plan);
          if (gid) uncertainGroups[gid] = !!U.store.get(storageKey(gid), false);
        });
        paintForm();
        loadAllCards();
        updateSubmit();
      }).catch(function (e) {
        if (!current() || (info && config)) return;
        formHost.innerHTML = '';
        formHost.appendChild(h('div', { class: 'notice warn section' }, '充值信息加载失败：' + e.message, ' ', h('button', { onclick: loadConfig }, '重试')));
      });
    }
    var paymentTimer = null, paymentPending = false;
    function refreshVisible() {
      clearTimeout(paymentTimer);
      if (!page.isConnected || !current() || document.hidden || paymentPending) {
        schedulePaymentRefresh();
        return;
      }
      paymentPending = true;
      var tasks = [loadOrders(true, true), loadSubscriptions(true)];
      if (info && config) {
        tasks.push(Api.paymentInfo().then(function (latest) {
          if (!current() || !page.isConnected) return;
          if (!latest || typeof latest !== 'object') throw new Error('充值配置返回不完整');
          info = Object.assign({}, info, latest);
          mergeLivePlans(latest.plans);
          paintForm();
        }).catch(function () {}));
      }
      Promise.all(tasks).finally(function () {
        paymentPending = false;
        schedulePaymentRefresh();
      });
    }
    function schedulePaymentRefresh() {
      clearTimeout(paymentTimer);
      if (page.isConnected && current() && !document.hidden) paymentTimer = setTimeout(refreshVisible, 5000);
    }
    function onVisible() {
      if (!page.isConnected || !current()) { document.removeEventListener('visibilitychange', onVisible); return; }
      if (document.hidden) return;
      if (activeOrder) refreshOrder(activeOrder);
      if (info && config) {
        Api.paymentInfo().then(function (latest) {
          if (!current() || !page.isConnected || !latest) return;
          info = Object.assign({}, info, latest);
          mergeLivePlans(latest.plans);
          paintForm();
        }).catch(function () {});
      } else {
        loadConfig();
      }
      loadOrders();
      loadSubscriptions();
      schedulePaymentRefresh();
    }
    function onOrderChange(event) {
      if (!page.isConnected || !current()) { global.removeEventListener('pp:payment-changed', onOrderChange); return; }
      if (event.detail !== account.id) return;
      activeOrder = shared.order; updateSubmit(); paintActiveOrder();
      if (info && config) paintForm();
      if (!shared.submitting) loadOrders();
    }
    document.addEventListener('visibilitychange', onVisible);
    global.addEventListener('pp:payment-changed', onOrderChange);
    global.addEventListener('hashchange', syncRouteView);
    if (activeOrder) setTimeout(function () { if (page.isConnected && current()) paintActiveOrder(); }, 0);
    activate();
    page.addEventListener('pp:page-activate', function () {
      activate();
      schedulePaymentRefresh();
    });
    page.addEventListener('pp:page-deactivate', function () { clearTimeout(paymentTimer); });
    page.addEventListener('pp:page-refresh', function () {
      if (!current() || shared.submitting) return;
      loadConfig(); loadOrders(); loadSubscriptions();
    });
    page.addEventListener('pp:page-dispose', function () {
      clearTimeout(paymentTimer);
      document.removeEventListener('visibilitychange', onVisible);
      global.removeEventListener('hashchange', syncRouteView);
    });
    loadConfig(); loadOrders(true); loadSubscriptions();
    return page;
  }
  global.PagesPayment = { renderPurchase: renderPurchase };
})(window);
