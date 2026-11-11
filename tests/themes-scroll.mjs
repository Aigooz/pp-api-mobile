import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createPreviewServer } from '../preview.mjs';

const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });

async function run(engine, name) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    localStorage.setItem('pp_api_token', JSON.stringify('fake-access'));
    localStorage.setItem('pp_api_user', JSON.stringify({ id: 1, email: 'test@example.test' }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__proxy/**', route => {
    const p = new URL(route.request().url()).pathname.replace(/^\/__proxy\/(site|model)/, '');
    if (p === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
    if (p === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [] }));
    if (p === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'test@example.test', balance: 3 }));
    if (p === '/api/v1/keys') return route.fulfill(ok({ items: [] }));
    if (p === '/api/v1/usage/dashboard/stats') return route.fulfill(ok({ total_api_keys: 1, active_api_keys: 1, today_requests: 1, total_requests: 2, total_tokens: 100 }));
    if (p === '/api/v1/user/platform-quotas') return route.fulfill(ok({ platform_quotas: [] }));
    if (p === '/api/v1/usage/dashboard/trend') return route.fulfill(ok({ trend: [] }));
    if (p === '/api/v1/usage/dashboard/models') return route.fulfill(ok({ models: [] }));
    if (p === '/api/v1/usage') return route.fulfill(ok({ items: [], total: 0 }));
    if (p === '/api/v1/announcements') return route.fulfill(ok([]));
    return route.fulfill(ok([]));
  });
  try {
    await page.goto(base + '/#/home');
    await page.getByText('快捷操作').waitFor();
    await page.getByRole('button', { name: '主题外观' }).click();
    await page.getByText('主题外观', { exact: true }).waitFor();
    assert.equal(await page.locator('.theme-choice').count(), 11);
    await page.getByRole('button', { name: /薄荷/ }).click();
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'mint');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pp_api_theme'))), 'mint');
    await page.getByRole('button', { name: /夜幕/ }).click();
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'violet-dark');
    const darkBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    assert.equal(darkBg, '#0e1113');
    await page.getByRole('button', { name: '完成' }).click();
    await page.reload();
    await page.getByText('快捷操作').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'violet-dark');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);

    const metrics = await page.evaluate(() => {
      const main = document.querySelector('main');
      const pageNode = document.querySelector('.page');
      main.scrollTop = 99999;
      return {
        max: main.scrollHeight - main.clientHeight,
        top: main.scrollTop,
        overscroll: getComputedStyle(main).overscrollBehaviorY || getComputedStyle(main).webkitOverscrollBehaviorY,
        pageBottom: pageNode.getBoundingClientRect().bottom,
        viewportBottom: main.getBoundingClientRect().bottom,
        nestedScroll: Array.from(pageNode.querySelectorAll('*')).filter(node => {
          const style = getComputedStyle(node);
          return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2;
        }).length
      };
    });
    assert.equal(metrics.top, metrics.max);
    if (metrics.overscroll !== undefined) assert.equal(metrics.overscroll, 'contain');
    assert.ok(metrics.pageBottom <= metrics.viewportBottom + 2);
    assert.equal(metrics.nestedScroll, 0);
    assert.deepEqual(errors, []);
    console.log(`Themes and scroll (${name}): palette persistence, dark contrast and bottom containment passed`);
  } finally {
    await context.close();
    await browser.close();
  }
}

try {
  await run(chromium, 'chromium');
  await run(webkit, 'webkit');
} finally {
  await new Promise(resolve => server.close(resolve));
}
