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

let currentVisibleTokenTotal = 0;
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
    const result = dataFor(period, step);
    result.summary.tokens = currentVisibleTokenTotal || result.summary.tokens;
    result.total = result.summary.tokens;
    const count = result.labels.length;
    const weightTotal = count * (count + 1) / 2;
    result.series.forEach((item, modelIndex) => {
      const modelShare = modelIndex === 0 ? .71 : .29;
      item.values = result.labels.map((_, index) => 9876543210 * modelShare * (index + 1) / weightTotal);
    });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  }
  return route.fulfill(ok({ items: [], total: 0 }));
});

try {
  await page.goto(base + '/#/plaza');
  await page.evaluate(() => {
    localStorage.removeItem('rankings_period');
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
  assert.match(await page.locator('.rankings-summary').innerText(), /98\.77亿/);
  assert.match(await page.locator('.rankings-summary').innerText(), /平台原始值 9,876,543,210/);
  assert.match(await page.locator('.rankings-summary').innerText(), /均 80,001 \/ 次/);
  assert.equal(await page.locator('.rankings-rank-row').count(), 4);
  assert.match(await page.locator('.rankings-ranks-panel').innerText(), /模型排行[\s\S]*alpha-model/);
  assert.match(await page.locator('.rankings-ranks-panel').innerText(), /70\.00亿/);
  assert.match(await page.locator('.rankings-vendor-panel').innerText(), /厂商排行[\s\S]*Alpha/);
  assert.equal(await page.locator('.rankings-donut-segment').count(), 2);
  assert.equal(await page.locator('.rankings-trend-line').count(), 2);
  assert.equal(await page.locator('[data-chart=combined]').count(), 1);
  assert.equal(await page.locator('.rankings-state').innerText(), '实时');
  assert.match(await page.locator('.rankings-updated-at').innerText(), /^更新于 2026年11月28日 12:00:00$/);
  assert.equal(await page.locator('.rankings-steps, .rankings-refresh-trigger, .rankings-view-switch').count(), 0);
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

  assert.match(await page.locator('.rankings-chart-sub').innerText(), /请求与 Token/);
  assert.equal(await page.getByRole('button', { name: 'Token', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '请求', exact: true }).count(), 0);

  const chart = page.locator('.rankings-trend-svg:visible').first();
  await chart.waitFor();
  await chart.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await page.waitForTimeout(150);
  const chartBox = await chart.boundingBox();
  const viewportWidth = await page.evaluate(() => innerWidth);
  const visibleLeft = Math.max(0, chartBox.x), visibleRight = Math.min(viewportWidth, chartBox.x + chartBox.width);
  const tapX = visibleLeft + (visibleRight - visibleLeft) * .58, tapY = chartBox.y + chartBox.height * .46;
  await page.touchscreen.tap(tapX, tapY);
  await page.locator('.rankings-chart-readout').waitFor();
  const readout = await page.locator('.rankings-chart-readout').textContent();
  assert.match(readout, /\d{2}:\d{2}/);
  assert.match(readout, /次请求/);
  assert.match(readout, /Token/);
  const tokenReadout = Number((readout.match(/(\d+(?:\.\d+)?)([亿万]?) Token/) || [])[1]) *
    ({ '': 1, 万: 1e4, 亿: 1e8 })[(readout.match(/(\d+(?:\.\d+)?)([亿万]?) Token/) || [])[2]];
  assert.ok(tokenReadout >= 1e8 && tokenReadout <= 2e10, 'chart must show source tokens only once: ' + readout);
  assert.equal(await page.locator('.rankings-trend-guide').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).display !== 'none')), true);
  assert.equal(await page.locator('.rankings-trend-active').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).display !== 'none')), true);
  assert.match(await page.locator('.rankings-refresh-value').innerText(), /5 秒/);
  const beforeRefresh = requests.length;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pp:live-refreshed', { detail: { reason: 'test' } })));
  for (let i = 0; i < 20 && requests.length <= beforeRefresh; i++) await page.waitForTimeout(50);
  assert.ok(requests.length > beforeRefresh, 'rankings should refresh on the app five-second live tick');

  await page.evaluate(() => App.go('#/plaza'));
  await page.locator('.plaza-group').first().waitFor();
  const afterLeave = requests.length;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pp:live-refreshed', { detail: { reason: 'test' } })));
  await page.waitForTimeout(150);
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

  currentVisibleTokenTotal = 296216240;
  await page.locator('.rankings-page').evaluate(node => node.dispatchEvent(new CustomEvent('pp:page-refresh', { bubbles: true })));
  await page.locator('.rankings-source-warning').waitFor();
  await page.locator('.rankings-summary').waitFor();
  assert.match(await page.locator('.rankings-summary').innerText(), /2\.96亿/);
  assert.equal(await page.locator('.rankings-source-warning').isVisible(), true);
  assert.match(await page.locator('.rankings-source-warning').innerText(), /平台汇总与模型明细暂不一致/);
  currentVisibleTokenTotal = 0;
  await page.locator('.rankings-page').evaluate(node => node.dispatchEvent(new CustomEvent('pp:page-refresh', { bubbles: true })));
  await page.waitForFunction(() => document.querySelector('.rankings-summary').textContent.includes('98.77亿'));
  await page.locator('.rankings-source-warning').waitFor({ state: 'hidden' });

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
    assert.equal(await page.locator('.rankings-refresh-control').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await page.locator('[data-chart=combined]').count(), 1);
    assert.match(await page.locator('[data-chart=combined]').textContent(), /请求.*Token/);
  }

  empty = true;
  await page.getByRole('button', { name: '刷新平台数据' }).click();
  await page.getByText('暂无趋势数据', { exact: true }).waitFor();
  assert.match(await page.locator('.rankings-ranks-panel').innerText(), /暂无模型调用/);
  assert.match(await page.locator('.rankings-vendor-panel').innerText(), /暂无厂商调用/);
  empty = false;

  assert.deepEqual(errors, []);
  console.log('Rankings: API periods, TUI refresh picker, chart touch readout, empty/error states, rankings and responsive layouts passed');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
