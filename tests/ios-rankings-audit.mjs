import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { webkit } from 'playwright';
import { createPreviewServer, listenPreview } from '../preview.mjs';
import { mockIOSLayout, user } from './fixtures/ios-layout.mjs';

const server = createPreviewServer();
await listenPreview(server);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await webkit.launch({ headless: true });
const screenshotDir = 'ios-check/rankings-1.40.1';
await mkdir(screenshotDir, { recursive: true });

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'reduce',
  timezoneId: 'Asia/Shanghai',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
});
try {
  await context.addInitScript(({ user }) => {
    localStorage.setItem('pp_api_token', JSON.stringify('mock-layout-access'));
    localStorage.setItem('pp_api_user', JSON.stringify(user));
    window.Native = {
      device: () => JSON.stringify({ platform: 'ios', app: 'audit' }),
      secureMode: () => 'sync',
      secureGet: () => sessionStorage.getItem('audit-vault') || '',
      secureSet: value => { sessionStorage.setItem('audit-vault', value); return true; },
      copy() {}, statusBar() {}, vibrate() {}, keepAwake() {}, updateCheck() {}, updateProgress: () => '{}'
    };
  }, { user });

  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().includes('/api/rankings')) requests.push(new URL(request.url()).search);
  });
  await page.route(base + '/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!/^\/(?:index\.html|(?:css|js|img|vendor)\/[\w./-]+)?$/.test(path) || path.includes('..')) return route.abort();
    const file = new URL('../app/src/main/assets/www' + (path === '/' ? '/index.html' : path), import.meta.url);
    const extension = path.split('.').pop();
    const contentType = ({ js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', jpg: 'image/jpeg', png: 'image/png', woff2: 'font/woff2' })[extension] || 'text/html';
    await route.fulfill({ contentType, body: await readFile(file) });
  });
  await mockIOSLayout(page);
  await page.goto(base + '/#/rankings', { waitUntil: 'domcontentloaded' });
  await page.locator('.rankings-trend-svg').waitFor();

  for (const size of [
    { width: 320, height: 700, top: 47, bottom: 34, left: 0, right: 0 },
    { width: 375, height: 812, top: 47, bottom: 34, left: 0, right: 0 },
    { width: 390, height: 844, top: 47, bottom: 34, left: 0, right: 0 },
    { width: 430, height: 932, top: 59, bottom: 34, left: 0, right: 0 },
    { width: 768, height: 1024, top: 24, bottom: 20, left: 0, right: 0 }
  ]) {
    await page.setViewportSize(size);
    await page.evaluate(insets => __applyInsets(insets.top, insets.bottom, insets.left, insets.right), size);
    for (const theme of ['ocean', 'dark']) {
      await page.evaluate(theme => AppTheme.set(theme, true), theme);
      await page.locator('main').evaluate(node => { node.scrollTop = 0; });
      const id = `${size.width}x${size.height}-${theme}`;
      await page.screenshot({ path: `${screenshotDir}/${id}-top.png`, animations: 'disabled' });

      const trigger = page.locator('.rankings-refresh-trigger');
      assert.equal(await trigger.evaluate(node => node.scrollWidth <= node.clientWidth), true, `${id} refresh trigger clips`);
      await trigger.click();
      await page.getByRole('dialog', { name: '自动刷新' }).waitFor();
      const picker = await page.getByRole('dialog', { name: '自动刷新' }).evaluate(node => {
        const box = node.getBoundingClientRect();
        return {
          box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
          overflow: node.scrollWidth - node.clientWidth,
          options: [...node.querySelectorAll('[role=option]')].map(option => ({
            text: option.textContent, width: option.clientWidth, scroll: option.scrollWidth
          }))
        };
      });
      assert.ok(picker.box.left >= size.left, `${id} picker overlaps left safe area`);
      assert.ok(picker.box.right <= size.width - size.right + .5, `${id} picker overlaps right safe area`);
      assert.ok(picker.box.bottom <= size.height - size.bottom + .5, `${id} picker overlaps bottom safe area`);
      assert.equal(picker.overflow <= 1, true, `${id} picker overflows horizontally`);
      assert.equal(picker.options.every(option => option.scroll <= option.width + 1), true, `${id} picker option clips`);
      await page.screenshot({ path: `${screenshotDir}/${id}-picker.png`, animations: 'disabled' });
      await page.getByRole('option', { name: theme === 'ocean' ? '10 秒' : '30 秒', exact: true }).click();
      assert.match(await trigger.innerText(), theme === 'ocean' ? /10 秒/ : /30 秒/);
      assert.ok(requests.at(-1)?.includes('period=today'), `${id} selecting refresh did not trigger a request`);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => __applyInsets(47, 34, 0, 0));
  await page.evaluate(() => AppTheme.set('ocean', true));
  await page.evaluate(() => { App.go('#/rankings', true); });
  await page.locator('.rankings-trend-svg').waitFor();
  await page.locator('.rankings-trend-panel').scrollIntoViewIfNeeded();
  const chart = page.locator('.rankings-trend-svg');
  const hitBox = await page.locator('.rankings-trend-hit').boundingBox();
  await page.touchscreen.tap(hitBox.x + hitBox.width * .58, hitBox.y + hitBox.height * .46);
  const readout = await page.locator('.rankings-chart-readout').evaluate(node => {
    const box = node.querySelector('rect');
    return {
      text: node.textContent,
      display: getComputedStyle(node).display,
      x: Number(box.getAttribute('x')),
      width: Number(box.getAttribute('width'))
    };
  });
  const chartWidth = await chart.evaluate(node => Number(node.getAttribute('width')));
  assert.equal(readout.display !== 'none', true);
  assert.match(readout.text, /\d{2}:\d{2}/);
  assert.match(readout.text, /次请求/);
  assert.ok(readout.x >= 5 && readout.x + readout.width <= chartWidth);
  assert.equal(await page.locator('.rankings-trend-guide').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).display !== 'none')), true);
  await page.screenshot({ path: `${screenshotDir}/390x844-ocean-chart-touch.png`, animations: 'disabled' });

  assert.deepEqual(errors, []);
  console.log('iOS rankings audit: picker, selection refresh, chart readout and responsive screenshots passed');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
