import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPreviewServer } from '../preview.mjs';

const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
const raw = (data, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(data) });
let daycardBalance = 2, daycardPrice = 3.66, subscription = null, infoError = false, buyMode = 'success';
let buys = [];

await page.route('**/__proxy/**', async route => {
  const url = new URL(route.request().url());
  const path = url.pathname.replace('/__proxy/site', '');
  if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
  if (path === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [] }));
  if (path === '/api/v1/auth/login') return route.fulfill(ok({ access_token: 'daycard-token', user: { id: 1, email: 'test@example.test', balance: 10 } }));
  if (path === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'test@example.test', balance: 10 }));
  if (path === '/api/v1/payment/config') return route.fulfill(ok({ enabled: true, enabled_payment_types: ['alipay'] }));
  if (path === '/api/v1/payment/checkout-info') return route.fulfill(ok({ methods: { alipay: { available: true } },
    plans: [{ id: 1, name: '日卡', price: 3.66, currency: 'CNY' }, { id: 2, name: '其他套餐', price: 5, currency: 'CNY' }] }));
  if (path === '/api/v1/payment/orders/my') return route.fulfill(ok({ items: [], total: 0 }));
  if (path === '/api/v1/subscriptions/active') return route.fulfill(ok([]));
  if (path === '/api/daycard/info') {
    assert.equal(route.request().headers().authorization, 'Bearer daycard-token');
    if (infoError) return route.fulfill(raw({ error: '日卡服务故障' }, 503));
    return route.fulfill(raw({ plan: { id: 1, name: '日卡', price: daycardPrice, currency: 'CNY' },
      user: { id: 1, balance: daycardBalance }, subscription }));
  }
  if (path === '/api/daycard/buy') {
    buys.push({ body: JSON.parse(route.request().postData()), authorization: route.request().headers().authorization });
    await new Promise(resolve => setTimeout(resolve, 100));
    if (buyMode === 'bad-request') return route.fulfill(raw({ error: '余额不足' }, 400));
    if (buyMode === 'uncertain') return route.fulfill(raw({ error: '服务异常' }, 503));
    daycardBalance -= daycardPrice;
    subscription = { expires_at: '2026-12-01T10:00:00+08:00' };
    return route.fulfill(raw({ paid: daycardPrice }));
  }
  return route.fulfill(ok({ items: [] }));
});

async function purchasePage() {
  await page.goto(base + '/#/me');
  await page.goto(base + '/#/purchase');
  await page.getByText('日卡', { exact: true }).click();
  await page.getByText('余额支付', { exact: true }).waitFor();
}
async function chooseBalance() {
  await page.getByText('余额支付', { exact: true }).click();
}
async function confirmBalance() {
  await page.getByRole('button', { name: '确认余额支付' }).click();
  await page.getByRole('heading', { name: '确认余额支付' }).waitFor();
}

try {
  await page.goto(base);
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await page.locator('input[type=email]').fill('test@example.test');
  await page.locator('input[type=password]').fill('test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('用量分析').waitFor();

  await purchasePage();
  await chooseBalance();
  assert.equal(await page.getByRole('button', { name: '账户余额不足' }).isDisabled(), true);
  assert.match(await page.locator('.payment-balance-note').innerText(), /日卡余额 ¥2\.00/);
  await page.getByText('其他套餐', { exact: true }).click();
  assert.equal(await page.getByText('余额支付', { exact: true }).count(), 0);
  assert.equal(await page.getByText('支付宝', { exact: true }).count(), 1);

  daycardBalance = 10;
  subscription = { expires_at: '2026-12-01T10:00:00+08:00' };
  await purchasePage();
  await chooseBalance();
  assert.equal(await page.getByRole('button', { name: '已持有日卡' }).isDisabled(), true);
  assert.match(await page.locator('.payment-balance-note').innerText(), /已生效/);

  subscription = null;
  infoError = true;
  await page.goto(base + '/#/me');
  await page.goto(base + '/#/purchase');
  await page.getByText('日卡', { exact: true }).click();
  await page.getByText(/日卡余额支付信息加载失败/).waitFor();
  assert.equal(await page.getByText('余额支付', { exact: true }).count(), 0);
  infoError = false;
  await page.getByRole('button', { name: '重试' }).click();
  await page.getByText('余额支付', { exact: true }).waitFor();
  await chooseBalance();
  if (process.env.PP_TEST_SCREENSHOTS) await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-daycard-balance-390.png', animations: 'disabled', fullPage: true });

  await confirmBalance();
  assert.match(await page.locator('.sheet').innerText(), /¥3\.66/);
  assert.match(await page.locator('.sheet').innerText(), /立即扣款/);
  daycardPrice = 4;
  await page.getByRole('button', { name: '确认支付', exact: true }).click();
  await page.getByText('日卡价格、余额或状态已变化，请重新确认').waitFor();
  assert.equal(buys.length, 0);
  assert.match(await page.locator('.payment-total').innerText(), /¥4\.00/);

  daycardPrice = 3.66;
  await purchasePage();
  await chooseBalance();
  buyMode = 'bad-request';
  await confirmBalance();
  await page.getByRole('button', { name: '确认支付', exact: true }).click();
  await page.getByText('余额不足', { exact: true }).waitFor();
  await page.getByRole('button', { name: '确认余额支付' }).waitFor();
  assert.equal(buys.length, 1);

  buyMode = 'uncertain';
  await confirmBalance();
  await page.getByRole('button', { name: '确认支付', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.getByText(/上次余额支付结果未确认/).waitFor();
  assert.equal(buys.length, 2);
  await purchasePage();
  await chooseBalance();
  assert.equal(await page.getByRole('button', { name: '请先核对日卡状态' }).isDisabled(), true);
  await page.getByText('支付宝', { exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '请先核对日卡状态' }).isDisabled(), true);
  await chooseBalance();
  await page.getByRole('button', { name: '刷新状态' }).click();
  await page.getByRole('button', { name: '已核对，允许重试' }).click();
  await page.getByRole('button', { name: '允许重试', exact: true }).click();
  await page.getByRole('button', { name: '确认余额支付' }).waitFor();

  buyMode = 'success';
  await confirmBalance();
  await page.getByRole('button', { name: '确认支付', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.getByText('日卡开通成功，已扣 ¥3.66').waitFor();
  await page.getByRole('button', { name: '已持有日卡' }).waitFor();
  if (process.env.PP_TEST_SCREENSHOTS) await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-daycard-active-390.png', animations: 'disabled', fullPage: true });
  assert.equal(buys.length, 3);
  assert.deepEqual(buys, Array(3).fill({ body: {}, authorization: 'Bearer daycard-token' }));
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    if (width === 320 && process.env.PP_TEST_SCREENSHOTS) await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-daycard-active-320.png', animations: 'disabled', fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('Daycard balance: pricing, eligibility, failures, recovery and duplicate protection passed');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
