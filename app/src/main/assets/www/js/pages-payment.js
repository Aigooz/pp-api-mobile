/* In-app checkout and server-backed payment status. */
(function (global) {
  'use strict';
  var U = global.U, C = global.PagesCore, h = C.h, section = C.section, pick = C.pick;
  var labels = { alipay: '支付宝', wxpay: '微信支付' };
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
  function renderPurchase() {
    if (!Api.AUTH.isLogged()) return global.PagesUser.needLogin();
    var page = h('div', { class: 'page payment-page' });
    var balance = h('strong', null, '$' + U.credits(C.balanceOf(global.S.user || Api.AUTH.user() || {})));
    var formHost = h('div'), orderHost = h('div'), subscriptionHost = h('div');
    var info, config, selectedPlan = null, method = '', checking = false, ordersReady = false;
    var amount = h('input', { class: 'input payment-amount', type: 'number', inputmode: 'decimal', min: '0.01', step: '0.01', placeholder: '输入充值金额', 'aria-label': '充值金额（元）' });
    var payMethods = h('div', { class: 'payment-methods' });
    var totalHint = h('div', { class: 'payment-total' });
    var submit = h('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: true, onclick: confirmOrder }, '正在检查订单…');
    var account = Api.AUTH.context();
    var shared = accountOrders[account.id] || (accountOrders[account.id] = { submitting: false, uncertain: false, order: null });
    var activeOrder = shared.order;

    page.appendChild(h('div', { class: 'payment-balance' }, h('span', null, '账户余额'), balance));
    page.appendChild(formHost); page.appendChild(orderHost); page.appendChild(subscriptionHost);

    function current() { return Api.AUTH.matches(account); }
    function updateSubmit() {
      submit.disabled = !ordersReady || shared.submitting || !!activeOrder || shared.uncertain;
      submit.textContent = shared.submitting ? '正在创建订单…' : !ordersReady ? '正在检查订单…' : activeOrder ? '请先处理当前订单' : shared.uncertain ? '请先检查订单记录' : '确认订单';
    }
    function notifyOrder() { global.dispatchEvent(new CustomEvent('pp:payment-changed', { detail: account.id })); }
    function methods() {
      return Object.keys(info.methods || {}).filter(function (key) {
        var item = info.methods[key];
        return !!labels[key] && item && item.available !== false &&
          (!item.currency || item.currency === 'CNY') &&
          (!Array.isArray(config.enabled_payment_types) || config.enabled_payment_types.indexOf(key) >= 0);
      });
    }
    function orderAmount() { return selectedPlan ? Number(selectedPlan.price) : Number(amount.value); }
    function paymentFee(value) {
      var rate = Number(info.recharge_fee_rate || config.recharge_fee_rate || 0);
      return isFinite(rate) && rate > 0 ? Math.ceil(value * rate - 0.0000001) / 100 : 0;
    }
    function updateTotal() {
      var value = orderAmount();
      totalHint.textContent = isFinite(value) && value > 0
        ? '订单金额 ¥' + money(value) + ((!selectedPlan && Array.isArray(info.recharge_bonus_tiers) && info.recharge_bonus_tiers.length) || Number((info.methods[method] || {}).fee_rate) > 0
          ? ' · 优惠与手续费以收银台为准' : (paymentFee(value) ? ' · 预计通道费 ¥' + money(paymentFee(value)) + ' · 预计支付 ¥' + money(value + paymentFee(value)) : ''))
        : '请输入金额';
    }
    function paintMethods() {
      payMethods.innerHTML = '';
      methods().forEach(function (key) {
        payMethods.appendChild(h('label', { class: 'payment-choice' },
          h('input', { type: 'radio', name: 'payment-method', value: key, checked: key === method,
            onchange: function () { method = key; updateTotal(); } }), h('span', null, labels[key])));
      });
    }
    function paintForm() {
      formHost.innerHTML = '';
      var canBalance = !info.balance_disabled && !config.balance_disabled;
      var plans = Array.isArray(info.plans) ? info.plans : [];
      if (!canBalance && !plans.length) { formHost.appendChild(h('div', { class: 'notice warn section' }, '当前没有可购买的商品')); return; }
      if (!selectedPlan && !canBalance && plans.length) selectedPlan = plans[0];
      var choices = h('div', { class: 'payment-products' });
      if (canBalance) choices.appendChild(h('label', { class: 'payment-choice' },
        h('input', { type: 'radio', name: 'payment-product', checked: !selectedPlan, onchange: function () { selectedPlan = null; paintForm(); } }),
        h('span', null, h('strong', null, '充值余额'), h('small', null, '自定义金额'))));
      plans.forEach(function (plan) {
        choices.appendChild(h('label', { class: 'payment-choice' },
          h('input', { type: 'radio', name: 'payment-product', checked: selectedPlan && String(selectedPlan.id) === String(plan.id),
            onchange: function () { selectedPlan = plan; paintForm(); } }),
          h('span', null, h('strong', null, plan.name || '订阅套餐'), h('small', null, '¥' + money(plan.price) + (plan.validity_days ? ' · ' + plan.validity_days + ' 天' : '')))));
      });
      formHost.appendChild(section('选择商品', null, null, choices));
      if (selectedPlan) {
        formHost.appendChild(h('div', { class: 'payment-plan-detail' },
          selectedPlan.description ? h('div', null, selectedPlan.description) : null,
          Array.isArray(selectedPlan.features) ? selectedPlan.features.map(function (feature) { return h('div', null, '· ' + feature); }) : null));
      } else {
        formHost.appendChild(section('充值金额（元）', null, null, h('div', null, amount,
          h('div', { class: 'tiny muted payment-limit' }, (Number(config.min_amount) > 0 ? '单笔最低 ¥' + money(config.min_amount) : '') +
            (Number(config.max_amount) > 0 ? ' · 最高 ¥' + money(config.max_amount) : '') +
            (Number(config.daily_limit) > 0 ? ' · 每日上限 ¥' + money(config.daily_limit) : '')))));
      }
      formHost.appendChild(section('支付方式', null, null, payMethods));
      if (selectedPlan) formHost.appendChild(h('div', { class: 'payment-balance-note' }, '余额支付暂不可用，平台尚未提供余额购买套餐的接口。'));
      formHost.appendChild(totalHint);
      formHost.appendChild(submit);
      if (info.help_text || config.help_text) formHost.appendChild(h('div', { class: 'payment-help' }, info.help_text || config.help_text));
      paintMethods(); updateTotal();
    }
    amount.addEventListener('input', updateTotal);

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
      if (!ordersReady || shared.submitting || activeOrder || shared.uncertain || !current()) return;
      var error = validation();
      if (error) { U.toast(error, 'err'); return; }
      var value = orderAmount(), chosenMethod = method, plan = selectedPlan;
      var description = (plan ? '订阅：' + (plan.name || '套餐') : '充值余额') + '\n订单金额：¥' + money(value) +
        '\n支付方式：' + labels[chosenMethod] +
        ((!plan && Array.isArray(info.recharge_bonus_tiers) && info.recharge_bonus_tiers.length) || Number((info.methods[chosenMethod] || {}).fee_rate) > 0 ? '\n优惠与手续费以收银台为准。' :
          '\n预计通道费：¥' + money(paymentFee(value)) + '\n预计支付：¥' + money(value + paymentFee(value)) + '\n实际支付金额以收银台为准。');
      U.confirm('确认创建订单', description, '创建订单').then(function (ok) {
        if (!ok || shared.submitting || shared.order || shared.uncertain || !current()) return;
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
          if (current()) { activeOrder = shared.order; paintActiveOrder(); loadOrders(); }
        }).catch(function (e) {
          shared.uncertain = true;
          if (current()) {
            U.toast((e.message || '创建订单失败') + '。请先检查订单记录。', 'err');
            loadOrders();
          }
        }).finally(function () { shared.submitting = false; updateSubmit(); notifyOrder(); });
      });
    }

    function paintActiveOrder() {
      var host = page.querySelector('.payment-active');
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
      formHost.insertAdjacentElement('beforebegin', panel);
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
          Api.me().then(function (user) {
            if (!current()) return;
            global.S.user = user;
            balance.textContent = '$' + U.credits(C.balanceOf(user || {}));
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
    function loadOrders() {
      orderHost.innerHTML = '';
      Promise.all([Api.myOrders({ page: 1, page_size: 20 }), Api.myOrders({ page: 1, page_size: 1, status: 'PENDING' })]).then(function (results) {
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
          if (pending) { activeOrder = pending; shared.order = pending; paintActiveOrder(); }
        }
        updateSubmit();
        orderHost.innerHTML = '';
        orderHost.appendChild(section('最近订单', '刷新', loadOrders, items.length ? h('div', { class: 'payment-orders' }, items.map(function (order) {
          var status = String(order.status || '').toUpperCase();
          return h('div', { class: 'payment-order-row' }, h('div', null, h('strong', null, (order.order_type === 'subscription' ? '订阅' : '充值') + ' · ¥' + money(order.amount || 0)),
            h('div', { class: 'tiny muted' }, '#' + order.id + ' · ' + U.datetime(order.created_at))),
            h('button', { class: 'btn btn-sm', onclick: function () {
              if (activeOrder && String(activeOrder.id) !== String(order.id)) { U.toast('请先处理当前订单', 'err'); return; }
              activeOrder = order; shared.order = order; updateSubmit(); paintActiveOrder(); refreshOrder(order);
            } }, statuses[status] || '查看状态'));
        })) : h('div', { class: 'dashboard-empty' }, '暂无订单')));
        if (shared.uncertain && !activeOrder) orderHost.appendChild(h('button', { class: 'btn btn-sm', onclick: function () {
          U.confirm('确认检查订单', '请确认已检查最近订单，避免重复支付。', '已检查').then(function (ok) {
            if (!ok || !current() || activeOrder) return;
            shared.uncertain = false; updateSubmit(); loadOrders(); notifyOrder();
          });
        } }, '已检查订单，继续下单'));
      }).catch(function (e) { if (current()) { ordersReady = false; updateSubmit(); orderHost.innerHTML = ''; orderHost.appendChild(h('div', { class: 'notice warn section' }, '订单加载失败：' + e.message, ' ', h('button', { onclick: loadOrders }, '重试'))); } });
    }
    function loadSubscriptions() {
      Api.subscriptions().then(function (data) {
        if (!current()) return;
        var list = C.arrOf(data); subscriptionHost.innerHTML = '';
        subscriptionHost.appendChild(section('我的订阅', null, null, list.length ? C.card(list.map(function (item) {
          var until = pick(item, 'expires_at', 'expired_at', 'end_at');
          return h('div', { class: 'list-item' }, h('div', { class: 'li-body' }, h('div', { class: 'li-title' }, pick(item, 'group_name', 'name') || (item.group && item.group.name) || '模型订阅'),
            h('div', { class: 'li-sub' }, until ? '有效至 ' + U.date(until) : '有效订阅')), h('span', { class: 'badge ok' }, '生效中'));
        })) : h('div', { class: 'dashboard-empty' }, '暂无生效订阅')));
      }).catch(function () { if (current()) subscriptionHost.textContent = '订阅状态暂不可用'; });
    }
    formHost.appendChild(h('div', { class: 'dashboard-loading' }, '正在加载充值信息…'));
    function loadConfig() {
      Promise.all([Api.paymentInfo(), Api.paymentConfig()]).then(function (result) {
        if (!current()) return;
        info = result[0] || {}; config = result[1] || {};
        method = methods()[0] || '';
        paintForm();
      }).catch(function (e) { if (current()) { formHost.innerHTML = ''; formHost.appendChild(h('div', { class: 'notice warn section' }, '充值信息加载失败：' + e.message, ' ', h('button', { onclick: loadConfig }, '重试'))); } });
    }
    function onVisible() {
      if (!page.isConnected || !current()) { document.removeEventListener('visibilitychange', onVisible); return; }
      if (!document.hidden && activeOrder) refreshOrder(activeOrder);
    }
    function onOrderChange(event) {
      if (!page.isConnected || !current()) { global.removeEventListener('pp:payment-changed', onOrderChange); return; }
      if (event.detail !== account.id) return;
      activeOrder = shared.order; updateSubmit(); paintActiveOrder();
      if (!shared.submitting) loadOrders();
    }
    document.addEventListener('visibilitychange', onVisible);
    global.addEventListener('pp:payment-changed', onOrderChange);
    if (activeOrder) setTimeout(function () { if (page.isConnected && current()) paintActiveOrder(); }, 0);
    loadConfig(); loadOrders(); loadSubscriptions();
    return page;
  }
  global.PagesPayment = { renderPurchase: renderPurchase };
})(window);
