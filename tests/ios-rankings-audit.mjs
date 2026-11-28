import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { webkit } from 'playwright';
import { createPreviewServer, listenPreview } from '../preview.mjs';
import { mockIOSLayout, user } from './fixtures/ios-layout.mjs';

const server = createPreviewServer();
await listenPreview(server);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await webkit.launch({ headless: true });
const screenshotDir = 'ios-check/rankings-1.40.2';
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
  await mockIOSLayout(page);
  await page.waitForFunction(() => window.__ppLiveRefresh && document.querySelector('.rankings-trend-svg'));
  await page.evaluate(async () => __ppLiveRefresh('ios-audit'));
  await page.waitForTimeout(500);
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

      assert.match(await page.locator('.rankings-refresh-value').innerText(), /5 秒/);
      assert.equal(await page.locator('.rankings-refresh-trigger, .rankings-view-switch').count(), 0);
      assert.equal(await page.locator('[data-chart=combined]').count(), 1);
      assert.match(await page.locator('[data-chart=combined]').textContent(), /请求.*Token/);
      await page.locator('.rankings-trend-svg').evaluate(node => node.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(200);
      const chart = page.locator('.rankings-trend-svg');
      const hitBox = await page.locator('.rankings-trend-hit').boundingBox();
      const tapX = Math.max(48, hitBox.x) + (Math.min(size.width - 12, hitBox.x + hitBox.width) - Math.max(48, hitBox.x)) * .58;
      await page.touchscreen.tap(tapX, hitBox.y + hitBox.height * .46);
      await page.waitForTimeout(100);
      const readout = await chart.locator('.rankings-chart-readout').evaluate(node => {
        const box = node.querySelector('rect');
        return { text: node.textContent, display: getComputedStyle(node).display,
          x: Number(box.getAttribute('x')), width: Number(box.getAttribute('width')) };
      });
      const chartWidth = await chart.evaluate(node => Number(node.getAttribute('width')));
      assert.equal(readout.display !== 'none', true, `${id} combined chart readout hidden`);
      assert.match(readout.text, /\d{2}:\d{2}/);
      assert.match(readout.text, /次请求/);
      assert.match(readout.text, /Token/);
      assert.match(readout.text, /\d+(?:\.\d+)?(?:[亿万])? Token/);
      assert.equal(await page.locator('.rankings-summary').innerText().then(text =>
        /均 80,001 \/ 次/.test(text)), true, `${id} token average must use source units`);
      const readoutFill = await chart.locator('.rankings-chart-readout rect').evaluate(node => getComputedStyle(node).fill);
      const [readoutR, readoutG, readoutB] = readoutFill.match(/\d+/g).map(Number);
      const luminance = channel => {
        const value = channel / 255;
        return value <= .03928 ? value / 12.92 : Math.pow((value + .055) / 1.055, 2.4);
      };
      const readoutLuminance = .2126 * luminance(readoutR) + .7152 * luminance(readoutG) + .0722 * luminance(readoutB);
      const readoutTextFills = await chart.locator('.rankings-chart-readout text').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fill));
      const textContrast = readoutTextFills.map(fill => {
        const [r, g, b] = fill.match(/\d+/g).map(Number);
        const textLuminance = .2126 * luminance(r) + .7152 * luminance(g) + .0722 * luminance(b);
        return (Math.max(textLuminance, readoutLuminance) + .05) / (Math.min(textLuminance, readoutLuminance) + .05);
      });
      assert.ok(textContrast.every(ratio => ratio >= 4.5), `${id} chart readout text contrast is insufficient: ${JSON.stringify(textContrast)}`);
      const guideState = await page.locator('.rankings-trend-guide').evaluateAll(nodes => nodes.map(node => ({
        display: getComputedStyle(node).display, x1: node.getAttribute('x1'), y1: node.getAttribute('y1')
      })));
      assert.ok(readout.x >= 5 && readout.x + readout.width <= chartWidth, `${id} chart readout escapes plot`);
      assert.equal(await page.locator('.rankings-trend-guide').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).display !== 'none')), true,
        `${id} chart guides hidden: ${JSON.stringify(guideState)}`);
      await page.locator('main').evaluate(node => { node.scrollTop = 0; });
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => __applyInsets(47, 34, 0, 0));
  await page.evaluate(() => AppTheme.set('ocean', true));
  await page.evaluate(() => { App.go('#/rankings', true); });
  await page.locator('.rankings-trend-svg').waitFor();
  await page.locator('.rankings-trend-svg').evaluate(node => node.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
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
  assert.match(readout.text, /Token/);
  assert.ok(readout.x >= 5 && readout.x + readout.width <= chartWidth);
  assert.equal(await page.locator('.rankings-trend-guide').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).display !== 'none')), true);
  await page.screenshot({ path: `${screenshotDir}/390x844-ocean-chart-touch.png`, animations: 'disabled' });

  assert.deepEqual(errors, []);
  console.log('iOS rankings audit: five-second refresh, combined chart readout and responsive screenshots passed');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
