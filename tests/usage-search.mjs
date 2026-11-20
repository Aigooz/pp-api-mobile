import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createPreviewServer, listenPreview } from '../preview.mjs';

const server = createPreviewServer();
await listenPreview(server);
const base = `http://127.0.0.1:${server.address().port}`;
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
const raw = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
const rows = Array.from({ length: 505 }, (_, index) => ({
  id: index + 1,
  created_at: `2026-01-01T12:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}+08:00`,
  model: index === 504 ? 'deep-search-model' : `model-${index}`,
  api_key_name: `key-${index}`,
  request_id: `request-${index}`,
  input_tokens: 10,
  output_tokens: 2,
  cache_creation_tokens: 1,
  cache_read_tokens: 3,
  actual_cost: 0.01,
  total_cost: 0.02,
  ...(index === 504 ? { status_code: 429 } : index === 503 ? {} : { status_code: 200 })
}));
const errorRow = { id: 9000, created_at: '2026-01-01T12:00:00+08:00', model: 'error-model', request_id: 'error-request',
  status_code: 502, category: 'upstream_error', message: '上游暂时不可用', key_name: 'error-key', input_tokens: 0, output_tokens: 0,
  cache_creation_tokens: 0, cache_read_tokens: 0, actual_cost: 0, total_cost: 0 };
let allowErrorRecords = true;
const usageQueries = [], errorQueries = [];

async function run(engine, name) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__proxy/**', async route => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace('/__proxy/site', '');
      if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API', allow_user_view_error_requests: allowErrorRecords }));
      if (path === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [] }));
      if (path === '/api/v1/auth/login') return route.fulfill(ok({ access_token: 'usage-search-test', user: { id: 1, email: 'usage@example.test' } }));
      if (path === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'usage@example.test' }));
      if (path === '/api/v1/usage/stats') return route.fulfill(ok({ total_requests: rows.length, total_actual_cost: 5,
        total_input_tokens: 5050, total_output_tokens: 1010, total_cache_creation_tokens: 505, total_cache_read_tokens: 1515 }));
      if (path === '/api/v1/usage/dashboard/trend') return route.fulfill(ok({ trend: [] }));
      if (path === '/api/v1/usage/dashboard/models') return route.fulfill(ok({ models: [] }));
      if (path === '/api/v1/usage/errors') {
        errorQueries.push(url.searchParams);
        const pageNo = Number(url.searchParams.get('page') || 1);
        const size = Number(url.searchParams.get('page_size') || 20);
        return route.fulfill(ok({ items: errorRow ? [errorRow].slice((pageNo - 1) * size, pageNo * size) : [], total: errorRow ? 1 : 0,
          page: pageNo, page_size: size }));
      }
      if (path === '/api/v1/usage/errors/9000') return route.fulfill(ok({ ...errorRow, error_body: 'PRIVATE UPSTREAM BODY' }));
      if (path === '/api/v1/usage') {
        usageQueries.push(url.searchParams);
        const pageNo = Number(url.searchParams.get('page') || 1);
        const size = Number(url.searchParams.get('page_size') || 20);
        return route.fulfill(ok({ items: rows.slice((pageNo - 1) * size, pageNo * size), total: rows.length, page: pageNo, page_size: size }));
      }
      return route.fulfill(raw({ code: 0, data: [] }));
    });

    await page.goto(base + '/#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input[type=email]').fill('usage@example.test');
    await page.locator('input[type=password]').fill('test-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => Api.AUTH.isLogged());
    await page.goto(base + '/#/usage', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('.usage-toolbar').waitFor().catch(async error => {
      throw new Error(`Usage did not render: hash=${await page.evaluate(() => location.hash)}\\n${await page.locator('#view').innerText()}\\n${errors.join('\\n')}`, { cause: error });
    });
    await page.getByRole('button', { name: '自定义时间', exact: true }).click();
    await page.getByLabel('开始日期', { exact: true }).fill('2026-01-01');
    await page.getByLabel('结束日期', { exact: true }).fill('2026-01-01');
    await page.getByLabel('开始时间', { exact: true }).fill('00:00');
    await page.getByLabel('结束时间', { exact: true }).fill('23:59');
    await page.getByRole('button', { name: '应用时间' }).click();
    await page.locator('.usage-log-item').first().waitFor();
    assert.equal(await page.locator('.usage-log-item').count(), 20);
    assert.match(await page.locator('.usage-log-pager').innerText(), /第 1 \/ 26 页 · 共 505 条/);
    await page.getByRole('button', { name: '下一页' }).click();
    await page.getByText('model-20', { exact: true }).waitFor();
    assert.match(await page.locator('.usage-log-pager').innerText(), /第 2 \/ 26 页/);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    }

    const search = page.getByRole('searchbox', { name: '搜索调用记录' });
    await search.fill('request-504');
    await page.getByRole('button', { name: '搜索' }).click();
    await page.getByText('deep-search-model', { exact: true }).waitFor().catch(async error => {
      throw new Error(`Search did not render deep result: ${await page.locator('.usage-log-note').innerText()}\n${await page.locator('.usage-log-list').innerText()}\nqueries=${usageQueries.map(query => query.toString()).join(' | ')}\n${errors.join('\n')}`, { cause: error });
    });
    assert.equal(await page.locator('.usage-log-item').count(), 1);
    assert.ok(usageQueries.some(query => query.get('page_size') === '500' && query.get('page') === '2'), 'search must scan beyond the first server page');

    await search.fill('key-503');
    await page.getByRole('button', { name: '搜索' }).click();
    await page.getByRole('button', { name: '查看 model-503 调用详情' }).waitFor();
    assert.equal(await page.locator('.usage-log-state.unknown').count(), 1, 'missing status must remain unknown');

    await search.fill('key-504');
    await page.getByRole('button', { name: '搜索' }).click();
    await page.getByText('deep-search-model', { exact: true }).waitFor();
    await search.fill('deep-search-model');
    await page.getByRole('button', { name: '搜索' }).click();
    await page.getByText('deep-search-model', { exact: true }).waitFor();

    await search.fill('');
    await page.getByRole('button', { name: '搜索' }).click();
    const errorQueriesBeforeDisabled = errorQueries.length;
    await page.evaluate(() => { S.settings.allow_user_view_error_requests = false; });
    await page.locator('.usage-status-seg').getByRole('button', { name: '异常' }).click();
    await page.getByText('站端未开放异常请求记录').waitFor();
    assert.equal(errorQueries.length, errorQueriesBeforeDisabled, 'must not call privileged error endpoint when site setting is off');

    await page.evaluate(() => { S.settings.allow_user_view_error_requests = true; });
    await page.locator('.usage-status-seg').getByRole('button', { name: '异常' }).click();
    await page.getByRole('button', { name: '查看 error-model 调用详情' }).waitFor();
    await page.getByRole('button', { name: '查看 error-model 调用详情' }).click();
    await page.getByRole('heading', { name: '调用详情' }).waitFor();
    const details = await page.locator('.usage-detail').innerText();
    assert.match(details, /上游暂时不可用/);
    assert.match(details, /upstream_error/);
    assert.doesNotMatch(details, /PRIVATE UPSTREAM BODY/);
    assert.ok(errorQueries.length > 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${name}: full-period search, paging, status permission and safe request details passed`);
  } finally { await browser.close(); }
}

try {
  await run(chromium, 'Chromium');
  await run(webkit, 'WebKit');
} finally { await new Promise(resolve => server.close(resolve)); }
