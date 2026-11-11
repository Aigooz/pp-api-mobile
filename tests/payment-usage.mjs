import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPreviewServer } from '../preview.mjs';

const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
const raw = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
const fail = message => ({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 500, message }) });
const makeRecord = (id, time, model, tokens, cost) => ({ id, created_at: time, model, input_tokens: tokens, output_tokens: 1,
  cache_creation_tokens: 2, cache_read_tokens: 3, actual_cost: cost, total_cost: cost * 2 });
const records = [
  makeRecord(4, '2026-01-01T11:00:00+08:00', 'outside', 40, 4),
  makeRecord(3, '2026-01-01T10:15:59+08:00', 'inside-b', 30, 3),
  makeRecord(2, '2026-01-01T10:15:00+08:00', 'inside-a', 20, 2),
  makeRecord(1, '2026-01-01T10:14:59+08:00', 'outside', 10, 1)
];
let usageMode = 'normal', ordersFail = false, createMode = 'success', orderStatus = 'PENDING', order = null;
let createCalls = [], usageQueries = [], lastTrend = null;
await page.route('**/__proxy/**', async route => {
  const url = new URL(route.request().url());
  const path = url.pathname.replace('/__proxy/site', '');
  if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
  if (path === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [] }));
  if (path === '/api/v1/auth/login') return route.fulfill(ok({ access_token: 'fake', user: { id: 1, email: 'test@example.test', balance: 3 } }));
  if (path === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'test@example.test', balance: 3 }));
  if (path === '/api/v1/usage/dashboard/stats') return route.fulfill(ok({}));
  if (path === '/api/v1/user/platform-quotas') return route.fulfill(ok({ platform_quotas: [] }));
  if (path === '/api/v1/usage/stats') return route.fulfill(ok({ total_requests: 2, total_actual_cost: 5, total_input_tokens: 50, total_output_tokens: 2 }));
  if (path === '/api/v1/usage/dashboard/trend') {
    lastTrend = url.searchParams;
    return route.fulfill(ok({ trend: [] }));
  }
  if (path === '/api/v1/usage/dashboard/models') return route.fulfill(ok({ models: [] }));
  if (path === '/api/v1/usage') {
    usageQueries.push(url.searchParams);
    const pn = Number(url.searchParams.get('page'));
    if (url.searchParams.get('page_size') !== '500') return route.fulfill(ok({ items: [] }));
    if (usageMode === 'delayed') await new Promise(resolve => setTimeout(resolve, 450));
    if (usageMode === 'too-many') return route.fulfill(ok({ items: [], page: pn, page_size: 2, total: 20001 }));
    if (usageMode === 'duplicate') return route.fulfill(ok({ items: pn === 1 ? records.slice(0, 2) : [records[1], records[3]], page: pn, page_size: 2, total: 4 }));
    return route.fulfill(ok({ items: records.slice((pn - 1) * 2, pn * 2), page: pn, page_size: 2, total: records.length }));
  }
  if (path === '/api/v1/payment/config') return route.fulfill(ok({ enabled: true, min_amount: 1, max_amount: 500, daily_limit: 2000, enabled_payment_types: ['alipay', 'wxpay'], recharge_fee_rate: 1 }));
  if (path === '/api/v1/payment/checkout-info') return route.fulfill(ok({ methods: { alipay: { available: true }, wxpay: { available: true } }, recharge_fee_rate: 1,
    plans: [{ id: 8, name: '测试日卡', price: 3.66, validity_days: 1, description: '套餐说明', features: ['测试额度'] }], help_text: '支付说明' }));
  if (path === '/api/daycard/info') return route.fulfill(raw({ plan: { id: 8, name: '测试日卡', price: 3.66, currency: 'CNY' }, user: { id: 1, balance: 10 }, subscription: null }));
  if (path === '/api/v1/subscriptions/active') return route.fulfill(ok([]));
  if (path === '/api/v1/payment/orders/my') {
    if (ordersFail) return route.fulfill(fail('暂不可用'));
    const include = order && (!url.searchParams.get('status') || orderStatus === url.searchParams.get('status'));
    return route.fulfill(ok({ items: include ? [{ ...order, status: orderStatus }] : [], total: include ? 1 : 0, page: 1, page_size: Number(url.searchParams.get('page_size')) }));
  }
  if (path === '/api/v1/payment/orders' && route.request().method() === 'POST') {
    createCalls.push(JSON.parse(route.request().postData()));
    await new Promise(resolve => setTimeout(resolve, 150));
    if (createMode === 'fail') return route.fulfill(fail('网络失败'));
    order = { id: 12, amount: createCalls.at(-1).amount, order_type: createCalls.at(-1).order_type, payment_type: createCalls.at(-1).payment_type,
      out_trade_no: 'test-order', pay_url: 'https://pay.example.test/checkout', qr_code: 'https://pay.example.test/qr' };
    return route.fulfill(ok({ order_id: order.id, ...order, pay_amount: order.amount * 1.01 }));
  }
  if (path === '/api/v1/payment/orders/12') return route.fulfill(ok({ ...order, status: orderStatus }));
  if (path === '/api/v1/payment/orders/verify') return route.fulfill(ok({ ...order, status: orderStatus }));
  if (path === '/api/v1/payment/orders/12/cancel') { orderStatus = 'CANCELLED'; return route.fulfill(ok({})); }
  return route.fulfill(ok({ items: [] }));
});

try {
  await page.goto(base);
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await page.locator('input[type=email]').fill('test@example.test');
  await page.locator('input[type=password]').fill('password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('用量分析').waitFor();
  await page.getByLabel('开始日期', { exact: true }).fill('2026-01-01');
  await page.getByLabel('结束日期', { exact: true }).fill('2026-01-01');
  await page.getByLabel('开始时间', { exact: true }).fill('10:15');
  await page.getByLabel('结束时间', { exact: true }).fill('10:15');
  await page.getByRole('button', { name: '应用日期' }).click();
  await page.getByText('inside-a', { exact: true }).first().waitFor();
  assert.match(await page.locator('.dashboard-model-table').innerText(), /inside-b/);
  assert.doesNotMatch(await page.locator('.dashboard-model-table').innerText(), /outside/);
  assert.equal(await page.locator('.dashboard-recent-row').count(), 2);
  assert.equal(usageQueries.filter(q => q.get('page_size') === '500').length, 2);
  assert.equal(usageQueries.at(-1).get('page'), '2');
  usageMode = 'too-many';
  await page.getByRole('button', { name: '应用日期' }).click();
  await page.getByText(/超过 20000 条记录/).first().waitFor();
  usageMode = 'duplicate';
  await page.getByRole('button', { name: '应用日期' }).click();
  await page.getByText(/调用记录不完整或重复/).first().waitFor();
  usageMode = 'delayed';
  await page.getByRole('button', { name: '应用日期' }).click();
  await page.getByLabel('开始时间', { exact: true }).fill('00:00');
  await page.getByLabel('结束时间', { exact: true }).fill('23:59');
  await page.getByRole('button', { name: '应用日期' }).click();
  await page.waitForTimeout(1100);
  assert.equal(await page.getByText('inside-a', { exact: true }).count(), 0, 'old response must not overwrite new range');
  await page.goto(base + '/#/usage');
  await page.getByText('输入 tokens').waitFor();
  assert.ok(lastTrend.get('start_date') && lastTrend.get('end_date'));
  assert.equal(lastTrend.has('period'), false);
  await page.getByLabel('开始日期', { exact: true }).fill('2026-01-01');
  await page.getByLabel('结束日期', { exact: true }).fill('2026-01-01');
  await page.getByLabel('开始时间', { exact: true }).fill('10:15');
  await page.getByLabel('结束时间', { exact: true }).fill('10:15');
  usageMode = 'normal';
  await page.getByRole('button', { name: '应用时间' }).click();
  await page.getByText('inside-a', { exact: true }).first().waitFor();
  assert.match(await page.locator('#view').innerText(), /\$5/);
  assert.doesNotMatch(await page.locator('#view').innerText(), /outside/);

  ordersFail = true;
  await page.goto(base + '/#/purchase');
  await page.getByText('充值金额（元）').waitFor();
  await page.getByText('订单加载失败').waitFor();
  assert.equal(await page.getByRole('button', { name: '正在检查订单…' }).isDisabled(), true);
  ordersFail = false;
  await page.getByRole('button', { name: '重试' }).click();
  await page.getByRole('button', { name: '确认订单' }).waitFor();
  await page.getByLabel('充值金额（元）').fill('10');
  if (process.env.PP_TEST_SCREENSHOTS) await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-payment-form-390.png', animations: 'disabled' });
  assert.match(await page.locator('.payment-total').innerText(), /10\.10/);
  await page.getByRole('button', { name: '确认订单' }).click();
  assert.match(await page.locator('.sheet').innerText(), /预计通道费：¥0\.10/);
  await page.getByRole('button', { name: '创建订单' }).evaluate(button => { button.click(); button.click(); });
  await page.getByRole('heading', { name: '当前订单' }).waitFor();
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0], { amount: 10, payment_type: 'alipay', order_type: 'balance', is_mobile: true, payment_source: 'hosted_redirect', return_url: 'https://ipkey.vip/payment/result' });
  assert.equal(await page.locator('.payment-qr').count(), 1);
  if (process.env.PP_TEST_SCREENSHOTS) await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-payment-order-390.png', animations: 'disabled' });
  assert.equal(await page.getByRole('button', { name: '请先处理当前订单' }).isDisabled(), true);
  await page.getByRole('button', { name: '打开支付页面' }).click();
  assert.match(await page.locator('.sheet').innerText(), /pay\.example\.test/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  orderStatus = 'COMPLETED';
  await page.getByRole('button', { name: '刷新支付状态' }).click();
  await page.locator('.payment-active').getByText('已完成', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByText('测试日卡', { exact: true }).click();
  await page.getByText('余额支付', { exact: true }).waitFor();
  await page.getByText('微信支付', { exact: true }).click();
  await page.getByRole('button', { name: '确认订单' }).click();
  await page.getByRole('button', { name: '创建订单' }).click();
  await page.getByRole('heading', { name: '当前订单' }).waitFor();
  assert.equal(createCalls.length, 2);
  assert.equal(createCalls[1].plan_id, 8);
  assert.equal(createCalls[1].amount, 3.66);
  assert.equal(createCalls[1].order_type, 'subscription');
  assert.equal(createCalls[1].payment_type, 'wxpay');
  orderStatus = 'COMPLETED';
  await page.getByRole('button', { name: '刷新支付状态' }).click();
  await page.locator('.payment-active').getByText('已完成', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  order = null;
  createMode = 'fail';
  await page.getByRole('button', { name: '确认订单' }).click();
  await page.getByRole('button', { name: '创建订单' }).click();
  await page.getByRole('button', { name: '已检查订单，继续下单' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '请先检查订单记录' }).isDisabled(), true);
  assert.equal(createCalls.length, 3);
  await page.getByRole('button', { name: '已检查订单，继续下单' }).click();
  await page.getByRole('button', { name: '已检查', exact: true }).click();
  await page.getByRole('button', { name: '确认订单' }).waitFor();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  }
  assert.deepEqual(errors, []);
  console.log('Payment and usage: precise range, paging, races, checkout, recovery and status passed');
} finally {
  await context.close(); await browser.close();
  await new Promise(resolve => server.close(resolve));
}
