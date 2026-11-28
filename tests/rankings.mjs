import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPreviewServer, listenPreview } from '../preview.mjs';

const server = createPreviewServer();
await listenPreview(server);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
const errors = [];
const requests = [];
let empty = false;
let fail = false;
let delay = 0;
page.on('pageerror', error => errors.push(error.message));
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });

function dataFor(period, step) {
  if (empty) return { period, step: period === 'rt' ? step : null, generated_at: '2026-11-28T04:00:00Z', labels: [],
    total: 0, summary: { requests: 0, tokens: 0, latency_ms: null, deltas: {} }, series: [], models: [], vendors: [],
    requests_series: [], latency: {}, stream: { stream: 0, plain: 0 }, users: { top1: 0, total: 0 } };
  const labels = period === 'week' ? ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    : period === 'rt' ? Array.from({ length: 30 }, (_, index) => '01:' + String(index).padStart(2, '0'))
    : Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0') + ':00');
  return {
    period, step: period === 'rt' ? step : null, generated_at: '2026-11-28T04:00:00Z', labels,
    total: 9876543210,
    summary: { requests: 123456, tokens: 9876543210, latency_ms: 12340, success_rate: null, deltas: { requests: 2.5, tokens: 3.1 } },
    series: [
      { name: 'alpha-model-with-a-name-that-is-deliberately-long', vendor: 'Alpha', total: 7000000000, values: labels.map((_, index) => (index + 1) * 1000000) },
      { name: 'beta-model', vendor: 'Beta', total: 2876543210, values: labels.map((_, index) => (index + 1) * 500000) }
    ],
    models: [
      { name: 'alpha-model-with-a-name-that-is-deliberately-long', vendor: 'Alpha', total: 7000000000 },
      { name: 'beta-model', vendor: 'Beta', total: 2876543210 }
    ],
    vendors: [
      { name: 'Alpha Platform With Long Name', total: 7000000000, share: 0.71 },
      { name: 'Beta', total: 2876543210, share: 0.29 }
    ],
    requests_series: labels.map((_, index) => (index + 1) * 100),
    latency: { p50: 6420, p90: 18640, p99: 52340, min: 1220, max: 148000, avg: 12340 },
    stream: { stream: 120000, plain: 3456 },
    users: { top1: 45678, total: 19 }
  };
}

await page.route('**/__proxy/**', async route => {
  const url = new URL(route.request().url());
  const path = url.pathname.replace(/^\/__proxy\/(site|model)/, '');
  if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
  if (path === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'test@example.test' }));
  if (path === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [{ id: 1, name: 'Test', models: [{ name: 'demo', pricing: { billing_mode: 'token' } }] }] }));
  if (path === '/api/public/channel-status') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updatedAt: new Date().toISOString(), items: [] }) });
  if (path === '/api/rankings') {
    const period = url.searchParams.get('period') || 'today';
    const step = url.searchParams.get('step') || '';
    requests.push({ period, step });
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (fail) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dataFor(period, step)) });
  }
  return route.fulfill(ok({ items: [], total: 0 }));
});

try {
  await page.goto(base + '/#/plaza');
  await page.evaluate(() => {
    localStorage.removeItem('rankings_refresh_ms');
    localStorage.removeItem('rankings_period');
    localStorage.removeItem('rankings_view');
  });
  await page.evaluate(() => App.go('#/rankings', true));
  await page.locator('.rankings-page').waitFor();
  await page.getByRole('button', { name: '平台数据', exact: true }).click();
  await page.locator('.rankings-page').waitFor();
  await page.getByText('请求数', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/rankings');
  assert.equal(await page.locator('.tab.active').getAttribute('data-tab'), 'plaza');
  assert.equal(await page.locator('.model-tabs button').count(), 3);
  assert.equal(await page.locator('.model-tabs button.active').innerText(), '平台数据');
  assert.ok(requests.at(-1).period === 'today');

  assert.equal(await page.locator('.rankings-metric').count(), 4);
  assert.match(await page.locator('.rankings-summary').innerText(), /123,456/);
  assert.match(await page.locator('.rankings-summary').innerText(), /12\.3 s/);
  assert.match(await page.locator('.rankings-summary').innerText(), /98\.77 亿/);
  assert.equal(await page.locator('.rankings-rank-row').count(), 4);
  assert.match(await page.locator('.rankings-ranks-panel').innerText(), /模型排行[\s\S]*alpha-model/);
  assert.match(await page.locator('.rankings-vendor-panel').innerText(), /厂商排行[\s\S]*Alpha/);
  assert.equal(await page.locator('.rankings-donut-segment').count(), 2);
  assert.equal(await page.locator('.rankings-trend-line').count(), 1);
  assert.match(await page.locator('.rankings-state').innerText(), /更新于 11月28日 12:00/);
  assert.equal(await page.locator('.rankings-steps').count(), 0);
  assert.equal(await page.locator('.rankings-refresh-select, select').count(), 0);
  assert.match(await page.locator('.rankings-quality-panel').innerText(), /P90[\s\S]*P99[\s\S]*最快[\s\S]*最慢/);
  assert.match(await page.locator('.rankings-quality-panel').innerText(), /调用形态[\s\S]*用户集中度/);

  delay = 400;
  await page.getByRole('button', { name: '本周', exact: true }).click();
  await page.getByRole('button', { name: '本月', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.rankings-chart-sub').textContent.includes('过去 30 天'));
  await page.getByRole('button', { name: '本周', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/rankings' &&
    document.querySelector('.rankings-chart-sub').textContent.includes('过去 7 天'));
  delay = 0;
  assert.equal(requests.at(-1).period, 'week');
  assert.equal(requests.at(-1).step, '');

  await page.getByRole('button', { name: '实时', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/rankings' &&
    document.querySelector('.rankings-chart-sub').textContent.includes('最近 30 分钟'));
  assert.equal(requests.at(-1).period, 'rt');
  assert.equal(requests.at(-1).step, '1m');
  assert.match(await page.locator('.rankings-chart-sub').innerText(), /最近 30 分钟 · 每分钟/);

  await page.getByRole('button', { name: 'Token', exact: true }).click();
  assert.match(await page.locator('.rankings-chart-sub').innerText(), /Token 用量/);
  assert.equal(await page.getByRole('button', { name: 'Token', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '请求', exact: true }).click();
  assert.match(await page.locator('.rankings-panel').first().innerText(), /请求量/);

  const chart = page.locator('.rankings-trend-svg');
  await chart.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await page.waitForTimeout(100);
  const chartBox = await chart.boundingBox();
  const viewportWidth = await page.evaluate(() => innerWidth);
  const visibleLeft = Math.max(0, chartBox.x), visibleRight = Math.min(viewportWidth, chartBox.x + chartBox.width);
  const tapX = visibleLeft + (visibleRight - visibleLeft) * .58, tapY = chartBox.y + chartBox.height * .46;
  await page.touchscreen.tap(tapX, tapY);
  await page.locator('.rankings-chart-readout').waitFor();
  const readout = await page.locator('.rankings-chart-readout').textContent();
  assert.match(readout, /\d{2}:\d{2}/);
  assert.match(readout, /次请求/);
  assert.equal(await page.locator('.rankings-trend-guide').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).display !== 'none')), true);
  assert.equal(await page.locator('.rankings-trend-active').evaluate(node => getComputedStyle(node).display !== 'none'), true);

  await page.locator('.rankings-refresh-trigger').click();
  await page.getByRole('dialog', { name: '自动刷新' }).waitFor();
  assert.equal(await page.getByRole('option').count(), 5);
  assert.equal(await page.getByRole('option', { name: '1 分钟', exact: true }).getAttribute('aria-selected'), 'true');
  assert.ok(await page.getByRole('dialog').evaluate(node => node.scrollWidth <= node.clientWidth));
  await page.getByRole('option', { name: '10 秒', exact: true }).click();
  assert.match(await page.locator('.rankings-refresh-trigger').innerText(), /10 秒/);
  assert.equal(await page.getByRole('dialog').count(), 0);
  const beforeRefresh = requests.length;
  await page.waitForTimeout(10200);
  assert.ok(requests.length > beforeRefresh, 'automatic refresh should request fresh rankings');

  await page.evaluate(() => App.go('#/plaza'));
  await page.locator('.plaza-group').first().waitFor();
  const afterLeave = requests.length;
  await page.waitForTimeout(10200);
  assert.equal(requests.length, afterLeave, 'inactive cached rankings must not poll');
  await page.getByRole('button', { name: '平台数据', exact: true }).click();
  await page.locator('.rankings-page').waitFor();

  fail = true;
  await page.evaluate(() => App.go('#/home', true));
  await page.evaluate(() => App.go('#/rankings', true));
  await page.locator('.rankings-page').waitFor();
  await page.getByText('平台数据加载失败').waitFor();
  const failedRequests = requests.length;
  await page.waitForTimeout(1500);
  assert.ok(requests.length - failedRequests <= 1, 'first-load failures must not create a request loop');
  fail = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByText('请求数', { exact: true }).waitFor();

  fail = true;
  await page.getByRole('button', { name: '刷新平台数据' }).click();
  await page.getByText('更新失败，显示上次数据').waitFor();
  assert.match(await page.locator('.rankings-summary').innerText(), /123,456/);
  fail = false;

  empty = true;
  await page.getByRole('button', { name: '刷新平台数据' }).click();
  await page.getByText('暂无趋势数据', { exact: true }).waitFor();
  assert.match(await page.locator('.rankings-ranks-panel').innerText(), /暂无模型调用/);
  assert.match(await page.locator('.rankings-vendor-panel').innerText(), /暂无厂商调用/);
  empty = false;

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    assert.equal(await page.evaluate(() => document.querySelector('#view').scrollWidth), await page.evaluate(() => document.querySelector('#view').clientWidth));
    const tabs = await page.locator('.model-tabs button').evaluateAll(nodes => nodes.map(node => ({
      width: node.getBoundingClientRect().width,
      overflow: node.scrollWidth > node.clientWidth
    })));
    assert.ok(tabs.every(item => item.width >= 60 && !item.overflow), JSON.stringify(tabs));
    assert.equal(await page.locator('.rankings-periods button').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)), true);
    assert.equal(await page.locator('.rankings-refresh-trigger').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.locator('.rankings-refresh-trigger').click();
    assert.ok(await page.getByRole('dialog').evaluate(node => node.scrollWidth <= node.clientWidth));
    await page.getByRole('button', { name: '取消' }).click();
  }
  assert.deepEqual(errors, []);
  console.log('Rankings: API periods, TUI refresh picker, chart touch readout, empty/error states, rankings and responsive layouts passed');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
