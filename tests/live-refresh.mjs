import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPreviewServer } from '../preview.mjs';

const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
  localStorage.setItem('pp_api_token', JSON.stringify('fake-access'));
  localStorage.setItem('pp_api_user', JSON.stringify({ id: 1, email: 'test@example.test' }));
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
const calls = { plaza: 0, status: 0, dashboard: 0, trend: 0, me: 0 };
let balance = 3;
let plazaGeneration = 1;
let channelGeneration = 1;

function plaza() {
  const groups = [
    { id: 1, name: '基础分组', platform: 'openai', rate_multiplier: 1, models: [{ name: 'base-model', mode: 'token', pricing: { billing_mode: 'token', input_price: 0.000001, output_price: 0.000002 }, official_pricing: { input_price: 0.000001, output_price: 0.000002 } }] }
  ];
  if (plazaGeneration > 1) groups.push({
    id: 2, name: '实时新增分组', platform: 'deepseek', rate_multiplier: 1,
    models: [{ name: 'live-model', mode: 'token', pricing: { billing_mode: 'token', input_price: 0.000001, output_price: 0.000002 }, official_pricing: { input_price: 0.000001, output_price: 0.000002 } }]
  });
  return { description: '实时模型目录', groups: groups };
}
function channels() {
  const items = [{ model: 'base-model', group: '基础分组', status: 'operational', availability: 99 }];
  if (channelGeneration > 1) items.push({ model: 'live-model', group: '实时新增分组', status: 'operational', availability: 100 });
  return { updatedAt: new Date().toISOString(), items: items };
}

await page.route('**/__proxy/**', async route => {
  const path = new URL(route.request().url()).pathname.replace(/^\/__proxy\/(site|model)/, '');
  if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
  if (path === '/api/v1/model-plaza') { calls.plaza++; return route.fulfill(ok(plaza())); }
  if (path === '/api/public/channel-status') { calls.status++; return route.fulfill(ok(channels())); }
  if (path === '/api/v1/auth/me') { calls.me++; return route.fulfill(ok({ id: 1, email: 'test@example.test', balance: balance })); }
  if (path === '/api/v1/keys') return route.fulfill(ok({ items: [] }));
  if (path === '/api/v1/usage/dashboard/stats') { calls.dashboard++; return route.fulfill(ok({ total_api_keys: 1, active_api_keys: 1, today_requests: calls.dashboard, total_requests: 10, total_tokens: 100 })); }
  if (path === '/api/v1/user/platform-quotas') return route.fulfill(ok({ platform_quotas: [] }));
  if (path === '/api/v1/usage/dashboard/trend') { calls.trend++; return route.fulfill(ok({ trend: [] })); }
  if (path === '/api/v1/usage/dashboard/models') return route.fulfill(ok({ models: [] }));
  if (path === '/api/v1/usage') return route.fulfill(ok({ items: [], total: 0 }));
  if (path === '/api/v1/announcements') return route.fulfill(ok([]));
  return route.fulfill(ok([]));
});

try {
  await page.goto(base + '/#/home');
  await page.getByText('快捷操作').waitFor();
  await page.waitForFunction(() => !!window.__ppLiveRefresh);
  await page.waitForFunction(() => !!window.__ppBalanceRefresh);
  const initialMe = calls.me;
  balance = 7.25;
  const refreshed = await page.evaluate(() => window.__ppBalanceRefresh());
  assert.equal(Number(refreshed.balance), 7.25);
  assert.ok(calls.me > initialMe, 'balance refresh should request the account endpoint');
  assert.equal(await page.getByText('$7.25').count() > 0, true);
  await page.waitForTimeout(10000);
  assert.ok(calls.me >= initialMe + 2, 'balance refresh should run on the ten-second interval');
  const initial = { ...calls };
  plazaGeneration = 2;
  channelGeneration = 2;
  const result = await page.evaluate(() => window.__ppLiveRefresh('test'));
  assert.ok(result && result.plaza && result.plaza.groups.some(group => group.name === '实时新增分组'));
  assert.ok(calls.plaza > initial.plaza && calls.status > initial.status);
  const snapshot = await page.evaluate(() => JSON.parse(localStorage.getItem('pp_api_plaza_channel_snapshot')));
  assert.ok(snapshot.groups.some(group => group.name === '实时新增分组'));
  assert.ok(snapshot.summary.some(item => item.model === 'live-model') || channelGeneration === 2);

  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByRole('heading', { name: '实时新增分组' }).waitFor();
  const beforeVisible = { ...calls };
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  for (let i = 0; i < 20 && calls.plaza <= beforeVisible.plaza; i++) await page.waitForTimeout(50);
  assert.ok(calls.plaza > beforeVisible.plaza, 'returning to the foreground should request fresh data');
  assert.deepEqual(errors, []);
  console.log('Live refresh: automatic data refresh, new group/channel discovery and foreground refresh passed');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
