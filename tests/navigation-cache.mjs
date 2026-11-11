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
const calls = { settings: 0, plaza: 0, dashboard: 0, trend: 0, keys: 0, models: 0, status: 0 };
const trendQueries = [];

await page.route('**/__proxy/**', async route => {
  const url = new URL(route.request().url());
  const path = url.pathname.replace(/^\/__proxy\/(site|model)/, '');
  if (path === '/api/v1/settings/public') { calls.settings++; return route.fulfill(ok({ site_name: 'Pp API' })); }
  if (path === '/api/v1/model-plaza') {
    calls.plaza++;
    return route.fulfill(ok({ groups: [{ id: 1, name: '测试分组', platform: 'openai',
      models: Array.from({ length: 20 }, (_, index) => ({ name: '预加载模型' + index, mode: 'token' })) }] }));
  }
  if (path === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'test@example.test', balance: 3 }));
  if (path === '/api/v1/usage/dashboard/stats') { calls.dashboard++; return route.fulfill(ok({ total_api_keys: 1, active_api_keys: 1, today_requests: 1 })); }
  if (path === '/api/v1/usage/dashboard/trend') {
    calls.trend++;
    trendQueries.push(url.search);
    return route.fulfill(ok({ trend: [] }));
  }
  if (path === '/api/v1/usage/dashboard/models') return route.fulfill(ok({ models: [] }));
  if (path === '/api/v1/usage') return route.fulfill(ok({ items: [], total: 0 }));
  if (path === '/api/v1/user/platform-quotas') return route.fulfill(ok({ platform_quotas: [] }));
  if (path === '/api/v1/keys') { calls.keys++; return route.fulfill(ok({ items: [{ id: 1, name: '测试令牌', key: 'fake-key', status: 'active' }] })); }
  if (path === '/v1/models') { calls.models++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: '预加载模型0' }] }) }); }
  if (path === '/api/public/channel-status') {
    calls.status++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updatedAt: new Date().toISOString(),
      items: [{ model: '预加载模型0', group: '测试分组', status: 'operational', availability: 99 }] }) });
  }
  return route.fulfill(ok([]));
});

try {
  await page.goto(base + '/#/home');
  await page.getByText('用量分析').waitFor();
  for (let i = 0; i < 40 && (calls.status < 2 || !calls.models); i++) await page.waitForTimeout(100);
  assert.ok(calls.status >= 2 && calls.models > 0, 'background pages should finish their initial requests');
  const initialCalls = { ...calls };
  const initialDashboard = await page.evaluate(() => {
    window.__cachedDashboard = document.querySelector('.dashboard');
    return { node: !!window.__cachedDashboard, top: document.querySelector('main').scrollTop };
  });
  assert.equal(initialDashboard.node, true);

  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByText('预加载模型0', { exact: true }).waitFor();
  assert.equal(await page.getByText('正在加载模型广场…').count(), 0);
  const plazaCalls = calls.plaza;
  const plazaScroll = await page.evaluate(() => {
    document.querySelector('main').scrollTop = 180;
    return document.querySelector('main').scrollTop;
  });
  assert.ok(plazaScroll > 0);

  await page.getByRole('button', { name: '首页', exact: true }).click();
  await page.getByText('用量分析').waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('.dashboard') === window.__cachedDashboard), true);
  assert.equal(await page.evaluate(() => document.querySelector('main').scrollTop), initialDashboard.top);
  assert.equal(calls.plaza, plazaCalls);
  assert.equal(calls.dashboard, initialCalls.dashboard);

  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByText('预加载模型0', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('main').scrollTop), plazaScroll);
  await page.getByRole('button', { name: '渠道状态', exact: true }).click();
  await page.getByText('监控模型').waitFor();
  assert.equal(await page.getByText('正在加载渠道状态…').count(), 0);
  await page.getByRole('searchbox', { name: '搜索渠道' }).fill('预加载模型');
  await page.evaluate(() => { window.__cachedChannel = document.querySelector('.channel-page'); });
  await page.getByRole('button', { name: '模型广场', exact: true }).click();
  await page.getByRole('button', { name: '渠道状态', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索渠道' }).waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('.channel-page') === window.__cachedChannel), true);
  assert.equal(await page.getByRole('searchbox', { name: '搜索渠道' }).inputValue(), '预加载模型');
  assert.equal(calls.status, initialCalls.status);

  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.locator('.composer textarea').fill('保留的对话草稿');
  await page.getByRole('button', { name: '首页', exact: true }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  assert.equal(await page.locator('.composer textarea').inputValue(), '保留的对话草稿');
  await page.getByRole('button', { name: '首页', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: '令牌', exact: true }).click();
  await page.getByText('测试令牌', { exact: false }).waitFor();
  await page.getByRole('button', { name: '首页', exact: true }).click();
  await page.getByText('用量分析').waitFor();
  assert.equal(calls.keys, initialCalls.keys, 'cached navigation must not refetch keys');
  assert.equal(calls.models, initialCalls.models, 'cached navigation must not refetch models');

  const initialTrend = calls.trend;
  const appliedTrendQuery = trendQueries.at(-1);
  await page.getByLabel('开始时间', { exact: true }).fill('10:15');
  await page.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 61000;
    document.querySelector('.dashboard').dispatchEvent(new CustomEvent('pp:page-activate'));
    Date.now = now;
  });
  for (let i = 0; i < 20 && calls.trend === initialTrend; i++) await page.waitForTimeout(50);
  assert.equal(calls.trend, initialTrend + 1);
  assert.equal(trendQueries.at(-1), appliedTrendQuery, 'background refresh must use the applied range');
  assert.equal(await page.getByLabel('开始时间', { exact: true }).inputValue(), '10:15');

  const buttons = await page.locator('.appbar-actions .icon-btn').evaluateAll(items => items.filter(item => getComputedStyle(item).display !== 'none').map(item => {
    const rect = item.getBoundingClientRect();
    const icon = item.querySelector('svg').getBoundingClientRect();
    return { width: rect.width, height: rect.height, iconWidth: icon.width, iconHeight: icon.height };
  }));
  assert.ok(buttons.length >= 2);
  assert.ok(buttons.every(item => item.width >= 44 && item.height >= 44 && item.iconWidth >= 22 && item.iconHeight >= 22));
  assert.deepEqual(errors, []);
  console.log('Navigation cache: preload, DOM reuse, scroll and draft retention, request reuse and header hit targets passed');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
