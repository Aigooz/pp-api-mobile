import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPreviewServer } from '../preview.mjs';

const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
const trendQueries = [];
const modelQueries = [];
let manyPoints = false;
let zeroModels = false;
let singlePoint = false;
let failStatus = true;
let statusRequests = 0;
await page.route('**/__proxy/**', async route => {
  const p = new URL(route.request().url()).pathname.replace('/__proxy/site', '');
  if (p === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
  if (p === '/api/v1/model-plaza') return route.fulfill(ok({ description: '测试价格目录', groups: [
    { id: 1, name: '测试分组', description: '主力模型', platform: 'openai', rate_multiplier: 0.1, models: [
      { name: 'demo-model', platform: 'openai', pricing: { billing_mode: 'token', input_price: 0.000001, output_price: 0.000004, cache_read_price: 0.0000001 }, official_pricing: { input_price: 0.000001, output_price: 0.000004, cache_read_price: 0.0000001 } }
    ] },
    { id: 2, name: '图片分组', platform: 'image-platform', rate_multiplier: 0.5, image_rate_independent: true, image_rate_multiplier: 0.25, subscription_type: 'subscription', models: [
      { name: 'demo-image', pricing: { billing_mode: 'image', per_request_price: 2 }, official_pricing: { per_request_price: 2 } }
    ] }
  ] }));
  if (p === '/api/public/channel-status') {
    statusRequests++;
    if (failStatus) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    const now = Date.now();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updatedAt: new Date(now).toISOString(), items: [
      { model: 'demo-model', group: '测试分组', vendor: 'openai', vendorLabel: 'OpenAI', status: 'operational', latency: 1000, ping: 80, availability: 99.2,
        timeline: [{ status: 'operational', latency_ms: 1000, ping_ms: 80, at: new Date(now - 1800000).toISOString() },
          { status: 'degraded', latency_ms: 6000, ping_ms: 100, at: new Date(now).toISOString() }] },
      { model: 'demo-image', group: '图片分组', vendor: 'image-platform', status: 'error', latency: 30000, ping: 20, availability: 90,
        timeline: [{ status: 'error', latency_ms: 30000, ping_ms: 20, at: new Date(now).toISOString() }] },
      { model: 'unknown-model', group: '测试分组', status: 'unknown', latency: null, ping: null, availability: null, timeline: [] }
    ] }) });
  }
  if (p === '/api/v1/auth/login') return route.fulfill(ok({ access_token: 'fake-access', refresh_token: 'fake-refresh', user: { id: 1, email: 'test@example.test', balance: 3 } }));
  if (p === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'test@example.test', balance: 3 }));
  if (p === '/api/v1/keys') return route.fulfill(ok({ items: [] }));
  if (p === '/api/v1/groups/available') return route.fulfill(ok([{ id: 1, name: '测试分组' }]));
  if (p === '/api/v1/usage/stats') return route.fulfill(ok({ total_actual_cost: 0.5, total_requests: 2, total_input_tokens: 20, total_output_tokens: 30 }));
  if (p === '/api/v1/usage/dashboard/stats') return route.fulfill(ok({ total_api_keys: 2, active_api_keys: 1, total_requests: 18, today_requests: 3, today_cost: 0.8, today_actual_cost: 0.4, total_cost: 2, total_actual_cost: 1, today_tokens: 50, today_input_tokens: 20, today_output_tokens: 30, total_tokens: 500, rpm: 2, tpm: 30, average_duration_ms: 1250, by_platform: [{ platform: 'openai', today_actual_cost: 0.4, total_actual_cost: 1, total_requests: 18, total_tokens: 500 }] }));
  if (p === '/api/v1/usage/dashboard/trend') {
    trendQueries.push(new URL(route.request().url()).searchParams);
    return route.fulfill(ok({ trend: manyPoints ? Array.from({ length: 80 }, (_, i) => ({ date: `point-${i}`, input_tokens: i + 1, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 })) : singlePoint ? [
      { date: 'only-point', input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 }
    ] : [
      { date: '2026-01-01', input_tokens: 20, output_tokens: 30, cache_creation_tokens: 5, cache_read_tokens: 10, actual_cost: 0.4, cost: 0.8 },
      { date: '2026-01-02', input_tokens: 40, output_tokens: 10, cache_creation_tokens: 10, cache_read_tokens: 50, actual_cost: 0.8, cost: 1.2 },
      { date: '2026-01-03', input_tokens: 10, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 30 }
    ] }));
  }
  if (p === '/api/v1/usage/dashboard/models') {
    modelQueries.push(new URL(route.request().url()).searchParams);
    return route.fulfill(ok({ models: zeroModels ? [{ model: 'zero-model', requests: 1, total_tokens: 0, actual_cost: 0, cost: 0 }] : [
      { model: 'demo-model', actual_cost: 0.4, cost: 0.8, total_tokens: 60, requests: 3 },
      { model: 'demo-model-2', actual_cost: 0.2, cost: 0.5, total_tokens: 40, requests: 2 }
    ] }));
  }
  if (p === '/api/v1/user/platform-quotas') return route.fulfill(ok({ platform_quotas: [{ platform: 'openai', daily_limit_usd: 10, daily_usage_usd: 2 }] }));
  if (p === '/api/v1/usage') return route.fulfill(ok({ items: [{ model: 'demo-model', created_at: '2026-01-01T10:00:00Z', input_tokens: 20, output_tokens: 30, actual_cost: 0.4, total_cost: 0.8 }] }));
  if (p === '/api/v1/subscriptions/active' || p === '/api/v1/announcements' || p === '/api/v1/redeem/history') return route.fulfill(ok([]));
  return route.fulfill(ok({}));
});
try {
  const denied = await fetch(base + '/__proxy/site/api/v1/settings/public');
  assert.equal(denied.status, 403);
  const wrapped = await fetch(base + '/__proxy/site/https://attacker.example/', { headers: { 'X-Pp-Preview': '1' } });
  assert.equal(wrapped.status, 403);
  const statusPost = await fetch(base + '/__proxy/site/api/public/channel-status', { method: 'POST', headers: { 'X-Pp-Preview': '1' } });
  assert.equal(statusPost.status, 403);
  await page.goto(base);
  await page.getByText('demo-model').first().waitFor();
  assert.equal(await page.locator('.tab').count(), 5);
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByText('测试价格目录').waitFor();
  assert.equal(await page.locator('.tab.active').getAttribute('data-tab'), 'plaza');
  const plaza = page.locator('.plaza-page');
  assert.equal(await plaza.locator('.plaza-group').count(), 2);
  assert.match(await plaza.innerText(), /缓存读取/);
  assert.match(await plaza.innerText(), /\$0\.01/);
  assert.match(await plaza.innerText(), /\$0\.50/);
  assert.match(await plaza.innerText(), /订阅/);
  await plaza.locator('.plaza-filter').filter({ hasText: '倍率' }).getByRole('button', { name: '0.5x' }).click();
  assert.equal(await plaza.locator('.plaza-group').count(), 1);
  assert.match(await plaza.innerText(), /demo-image/);
  await plaza.locator('.plaza-filter').filter({ hasText: '倍率' }).getByRole('button', { name: '全部' }).click();
  await plaza.getByRole('searchbox', { name: '搜索模型' }).fill('demo-model');
  assert.equal(await plaza.locator('.plaza-group').count(), 1);
  await plaza.getByRole('button', { name: /demo-model/ }).click();
  assert.match(await page.locator('.sheet').innerText(), /官方价/);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await plaza.getByRole('button', { name: '渠道状态' }).click();
  await page.getByText('渠道状态加载失败').waitFor();
  failStatus = false;
  await page.getByRole('button', { name: '重试' }).click();
  await page.locator('.channel-item').first().waitFor();
  assert.equal(statusRequests, 2);
  assert.equal(await page.locator('.tab.active').getAttribute('data-tab'), 'plaza');
  assert.equal(await page.locator('.channel-item').count(), 3);
  assert.match(await page.locator('.channel-summary').innerText(), /1 个故障/);
  assert.equal(await page.locator('.channel-latency-chart').count(), 1);
  assert.equal(await page.locator('.channel-item').last().locator('.channel-state').innerText(), '未知');
  assert.match(await page.locator('.channel-item').last().innerText(), /可用率\s+—/);
  await page.getByRole('button', { name: /测试分组 2/ }).click();
  assert.equal(await page.locator('.channel-item').count(), 2);
  await page.getByRole('searchbox', { name: '搜索渠道' }).fill('demo-model');
  assert.equal(await page.locator('.channel-item').count(), 1);
  await page.getByRole('button', { name: '查看 demo-model 的探测记录' }).click();
  assert.match(await page.locator('.sheet').innerText(), /偏慢[\s\S]*6\.00 s/);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.querySelector('#view').scrollWidth), await page.evaluate(() => document.querySelector('#view').clientWidth));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.PP_TEST_SCREENSHOTS) await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-channel-390.png', animations: 'disabled' });
  await page.getByRole('button', { name: '刷新渠道状态' }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="刷新渠道状态"]').disabled);
  assert.equal(statusRequests, 3);
  await page.getByRole('button', { name: '模型广场' }).click();
  await page.locator('.plaza-group').first().waitFor();
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '去登录' }).click();
  await page.locator('input[type=email]').fill('test@example.test');
  await page.locator('input[type=password]').fill('fake-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('账户余额').waitFor();
  await page.getByText('平均响应').waitFor();
  await page.getByText('平台用量').waitFor();
  await page.getByText('每日额度').waitFor();
  await page.getByText('Token 使用趋势').waitFor();
  await page.getByText('模型分布').waitFor();
  await page.getByText('最近调用').waitFor();
  await page.getByRole('button', { name: '批量生图（官网）' }).waitFor();
  assert.equal(await page.locator('.tab.active').getAttribute('data-tab'), 'home');
  assert.match(await page.locator('.dashboard').innerText(), /1\.25 s/);
  assert.match(await page.locator('.dashboard').innerText(), /累计实际/);
  assert.equal(await page.locator('.dashboard-donut-segment').count(), 2);
  const segment = await page.locator('.dashboard-donut-segment').first().getAttribute('stroke-dasharray');
  assert.equal(Number(segment.split(' ')[0]), 60);
  assert.match(await page.locator('.dashboard-model-table').innerText(), /请求[\s\S]*Token[\s\S]*实际[\s\S]*标准/);
  assert.match(await page.locator('.dashboard-model-table').innerText(), /demo-model-2/);
  assert.equal(await page.locator('.dashboard-trend-line').count(), 5);
  assert.equal(await page.locator('.dashboard-trend-point').count(), 3);
  const chartGeometry = await page.locator('.dashboard-trend-svg').evaluate(el => ({
    ratio: Math.abs(el.querySelector('.dashboard-chart-grid').getBoundingClientRect().width) / el.getBoundingClientRect().width,
    chartWidth: el.getBoundingClientRect().width,
    containerWidth: el.parentElement.clientWidth
  }));
  assert.ok(chartGeometry.ratio > 0.75, 'trend plot should use most of the chart width');
  assert.equal(Math.round(chartGeometry.chartWidth), chartGeometry.containerWidth);
  await page.getByRole('button', { name: '按小时' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.dashboard-trend-point').length === 3);
  assert.equal(trendQueries.at(-1).get('granularity'), 'hour');
  await page.getByLabel('开始日期').fill('2026-01-01');
  await page.getByLabel('结束日期').fill('2026-01-03');
  await page.getByRole('button', { name: '应用日期' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.dashboard-trend-point').length === 3);
  assert.equal(modelQueries.at(-1).get('start_date'), '2026-01-01');
  assert.equal(modelQueries.at(-1).get('end_date'), '2026-01-03');
  await page.locator('.dashboard-trend-point').first().click();
  assert.match(await page.locator('.dashboard-chart-detail').innerText(), /缓存命中率\s+28\.6%/);
  await page.locator('.dashboard-trend-point').last().focus();
  await page.locator('.dashboard-trend-point').last().press('Enter');
  assert.match(await page.locator('.dashboard-chart-detail').innerText(), /缓存命中率\s+75\.0%/);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    assert.equal(await page.evaluate(() => document.querySelector('#view').scrollWidth), await page.evaluate(() => document.querySelector('#view').clientWidth));
    assert.equal(await page.evaluate(() => document.querySelector('.dashboard-model-table-scroll').scrollWidth), await page.evaluate(() => document.querySelector('.dashboard-model-table-scroll').clientWidth));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.PP_TEST_SCREENSHOTS) {
    await page.waitForTimeout(3600);
    await page.locator('.tabbar').evaluate(el => { el.style.visibility = 'hidden'; });
    await page.locator('.dashboard-models').screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-dashboard-models-390.png', animations: 'disabled' });
    await page.locator('.dashboard-chart').screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-dashboard-trend-390.png', animations: 'disabled' });
    await page.locator('.tabbar').evaluate(el => { el.style.visibility = ''; });
  }
  await page.setViewportSize({ width: 768, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 768);
  assert.equal(await page.evaluate(() => document.querySelector('#view').scrollWidth), await page.evaluate(() => document.querySelector('#view').clientWidth));
  if (process.env.PP_TEST_SCREENSHOTS) {
    await page.locator('.tabbar').evaluate(el => { el.style.visibility = 'hidden'; });
    await page.locator('.bottom-fade').evaluate(el => { el.style.visibility = 'hidden'; });
    await page.locator('.dashboard-charts').screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-dashboard-charts-768.png', animations: 'disabled' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.locator('.dashboard-charts').screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-dashboard-charts-dark-768.png', animations: 'disabled' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.locator('.bottom-fade').evaluate(el => { el.style.visibility = ''; });
    await page.locator('.tabbar').evaluate(el => { el.style.visibility = ''; });
  }
  singlePoint = true;
  await page.getByRole('button', { name: '应用日期' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.dashboard-trend-point').length === 1);
  assert.match(await page.locator('.dashboard-chart-detail').innerText(), /only-point[\s\S]*缓存命中率\s+0\.0%/);
  assert.equal(await page.locator('.dashboard-trend-svg').evaluate(el => /NaN|Infinity/.test(el.outerHTML)), false);
  singlePoint = false;
  manyPoints = true;
  zeroModels = true;
  await page.getByRole('button', { name: '应用日期' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.dashboard-trend-point').length === 80);
  assert.ok(await page.locator('.dashboard-chart-scroll').evaluate(el => el.scrollWidth > el.clientWidth));
  assert.equal(await page.locator('.dashboard-donut-segment').count(), 0);
  await page.locator('.dashboard-trend-point').first().dispatchEvent('click');
  assert.match(await page.locator('.dashboard-chart-detail').innerText(), /point-0/);
  await page.locator('.dashboard-trend-point').last().dispatchEvent('click');
  assert.match(await page.locator('.dashboard-chart-detail').innerText(), /point-79/);
  assert.equal(await page.evaluate(() => document.querySelector('#view').scrollWidth), await page.evaluate(() => document.querySelector('#view').clientWidth));
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.locator('.plaza-group').first().waitFor();
  assert.equal(await page.locator('.tab.active').getAttribute('data-tab'), 'plaza');
  assert.equal(await page.locator('.tab.active').count(), 1);
  assert.equal(await page.evaluate(() => document.querySelector('#view').scrollWidth), await page.evaluate(() => document.querySelector('#view').clientWidth));
  if (process.env.PP_TEST_SCREENSHOTS) await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-plaza-mock-768.png', animations: 'disabled' });
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByText('test@example.test').waitFor();
  await page.getByText('用量明细').click();
  await page.getByText('20', { exact: true }).waitFor();
  await page.getByText('demo-model').first().waitFor();
  await page.getByRole('button', { name: '令牌', exact: true }).click();
  await page.getByText('还没有令牌').waitFor();
  await page.getByRole('button', { name: '新建' }).click();
  await page.locator('.sheet select').selectOption('1');
  assert.equal(await page.locator('.sheet select').inputValue(), '1');
  assert.deepEqual(errors, []);
  console.log('UI smoke: plaza pricing and filters, dashboard, login, usage and key form passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
