import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { webkit } from 'playwright';
import { createPreviewServer, listenPreview } from '../preview.mjs';
import { mockIOSLayout, user } from './fixtures/ios-layout.mjs';

const server = createPreviewServer();
await listenPreview(server);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await webkit.launch({ headless: true });
const screenshotDir = process.env.PP_TEST_SCREENSHOTS;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const report = [];
const issues = [];
const inspectOnly = process.env.PP_LAYOUT_INSPECT === '1';
// This suite measures layout, not gesture handling. Other suites cover real clicks.
const activate = locator => locator.evaluate(node => node.click());

async function inspect(page, name) {
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const visible = node => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && !node.closest('[hidden]') && getComputedStyle(node).visibility !== 'hidden';
    };
    const rect = node => {
      const b = node.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
    };
    const label = node => node.getAttribute('aria-label') || node.className?.baseVal || node.className || node.tagName;
    const clipping = [];
    const overlap = [];
    const icons = [];
    const iconSelectors = '.icon-btn,.tool-btn,.send-btn,.chat-test-trigger,.plaza-model-copy,.plaza-model-favorite,.key-card-more,.picker-trigger,.eye-btn,.chat-code-copy,.payment-service-icon,.me-action-icon,.li-icon,.chat-avatar,.chat-welcome-icon';
    for (const node of document.querySelectorAll(iconSelectors)) {
      const svg = node.querySelector('svg');
      if (!svg || !visible(node)) continue;
      const b = rect(node), i = rect(svg);
      const x = Math.abs((b.left + b.right - i.left - i.right) / 2);
      const y = Math.abs((b.top + b.bottom - i.top - i.bottom) / 2);
      if (x > 1 || y > 1 || i.width < 8 || i.height < 8) icons.push({ label: label(node), x, y, box: b, icon: i });
      const bbox = svg.getBBox(), vb = svg.viewBox.baseVal;
      if (bbox.x < vb.x - .5 || bbox.y < vb.y - .5 || bbox.x + bbox.width > vb.x + vb.width + .5 || bbox.y + bbox.height > vb.y + vb.height + .5) {
        clipping.push({ label: label(node), reason: 'icon path outside viewBox' });
      }
    }
    const groups = '.appbar,.chat-toolbar,.chat-toolbar .chips,.chat-key-picker .list-item,.chat-model-picker .list-item,.chat-history-list .list-item,.chat-test-result-head,.chat-test-metrics,.account-select,.account-card,.me-wallet-row,.profile-hero,.payment-service-strip,.plaza-model-top,.plaza-group-head-main,.usage-log-title,.sheet-actions,.picker-heading,.composer-box';
    for (const parent of document.querySelectorAll(groups)) {
      if (!visible(parent)) continue;
      const children = [...parent.children].filter(child => visible(child) && getComputedStyle(child).position !== 'absolute');
      for (let i = 0; i < children.length; i++) {
        const a = rect(children[i]);
        for (let j = i + 1; j < children.length; j++) {
          const b = rect(children[j]);
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1.5) overlap.push({ parent: label(parent), a: label(children[i]), b: label(children[j]) });
        }
      }
    }
    const wrapSelectors = '.li-title,.li-sub,.account-name,.account-email,.chat-test-result-head strong,.chat-welcome h2,.chat-welcome p,.sheet h3,.plaza-group-head h2,.payment-service-strip strong,.profile-identity,.keycard-name,.keycard .meta-grid,.me-wallet-main,.theme-choice-name';
    for (const node of document.querySelectorAll(wrapSelectors)) {
      if (!visible(node)) continue;
      const style = getComputedStyle(node);
      if (style.overflowX === 'hidden' || style.overflowX === 'auto') continue;
      if (node.scrollWidth > node.clientWidth + 2 && node.clientWidth) clipping.push({ label: label(node), reason: 'text overflows horizontally', width: node.clientWidth, scroll: node.scrollWidth });
    }
    for (const node of document.querySelectorAll('.route-slot *, .sheet *, .picker-panel *')) {
      if (!visible(node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || node.matches('input,textarea,select')) continue;
      const style = getComputedStyle(node);
      if (style.display === 'inline' || style.overflowX !== 'visible' || style.overflowY !== 'visible' || node.clientWidth < 2) continue;
      // The test-state dot deliberately extends 3px beyond its button.
      const allowance = node.matches('.chat-test-trigger[data-test-state="running"],.chat-test-trigger[data-test-state="complete"]') ? 4 : 2;
      if (node.scrollWidth > node.clientWidth + allowance) clipping.push({ label: label(node), reason: 'content exceeds container', width: node.clientWidth, scroll: node.scrollWidth });
      if (node.scrollHeight > node.clientHeight + 2 && !node.matches('.input,.textarea,textarea')) clipping.push({ label: label(node), reason: 'content exceeds height', height: node.clientHeight, scroll: node.scrollHeight });
    }
    const header = document.querySelector('.appbar').getBoundingClientRect();
    const firstAction = document.querySelector('.appbar-actions .icon-btn').getBoundingClientRect();
    const title = document.querySelector('.appbar-title').getBoundingClientRect();
    if (title.width < 60 || title.right > firstAction.left) clipping.push({ label: 'appbar title', reason: 'title crowded by actions' });
    const left = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-left')) || 0;
    const right = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-right')) || 0;
    const bottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom')) || 0;
    for (const node of document.querySelectorAll('.tabbar,.composer,.appbar-leading,.appbar-actions,.sheet,.picker-panel')) {
      if (!visible(node)) continue;
      const box = rect(node);
      if (node.matches('.sheet')) {
        const content = node.querySelector('.sheet-handle');
        const contentBox = content ? rect(content) : box;
        if (contentBox.left < left - 1 || contentBox.right > innerWidth - right + 1) {
          clipping.push({ label: label(node), reason: 'sheet content outside horizontal safe area' });
        }
      } else if (box.left < left - 1 || box.right > innerWidth - right + 1) {
        clipping.push({ label: label(node), reason: 'control outside horizontal safe area' });
      }
      if (node.matches('.tabbar') && box.bottom > innerHeight - bottom - 9) {
        clipping.push({ label: label(node), reason: 'tabbar intrudes into home indicator safe area', bottom: box.bottom, limit: innerHeight - bottom - 10 });
      }
      if (node.matches('.sheet,.picker-panel') && box.top < -1) {
        clipping.push({ label: label(node), reason: 'overlay exceeds top safe area', top: box.top });
      }
    }
    if (header.bottom > innerHeight - 100) clipping.push({ label: 'appbar', reason: 'header exceeds available height' });
    if (location.hash === '#/home') {
      for (const node of document.querySelectorAll('.dashboard-quality-item')) {
        if (visible(node) && node.getBoundingClientRect().width < 110) clipping.push({ label: 'dashboard quality metric', reason: 'metric too narrow', width: node.getBoundingClientRect().width });
      }
    }
    for (const node of document.querySelectorAll('.theme-choice')) {
      if (!visible(node)) continue;
      if (!getComputedStyle(node).getPropertyValue('--swatch').trim()) clipping.push({ label: label(node), reason: 'theme swatch missing' });
    }
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, viewWidth: document.querySelector('main').clientWidth,
      viewScrollWidth: document.querySelector('main').scrollWidth, icons, overlap, clipping };
  });
  report.push({ name, ...result });
  if (result.documentWidth > result.width || result.viewScrollWidth > result.viewWidth + 1 || result.icons.length || result.overlap.length || result.clipping.length) issues.push({ name, ...result });
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${name}.png`, animations: 'disabled' });
}

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' });
  await context.addInitScript(({ user }) => {
    localStorage.setItem('pp_api_token', JSON.stringify('mock-layout-access'));
    localStorage.setItem('pp_api_user', JSON.stringify(user));
    window.Native = {
      device: () => JSON.stringify({ platform: 'ios', app: 'layout-test' }),
      secureMode: () => 'sync', secureGet: () => sessionStorage.getItem('layout-vault') || '',
      secureSet: value => { sessionStorage.setItem('layout-vault', value); return true; },
      copy() {}, statusBar() {}, vibrate() {}, keepAwake() {}, updateCheck() {}, updateProgress: () => '{}'
    };
    const now = Date.now();
    localStorage.setItem('pp_api_chat_store_v2:' + encodeURIComponent('email:' + user.email), JSON.stringify({
      activeId: 'layout-conversation', sessions: [{ id: 'layout-conversation', title: '这是一条需要在窄屏中检查排版的很长很长的历史对话标题',
        model: '', keyId: 7, createdAt: now, updatedAt: now, messages: [] }]
    }));
  }, { user });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Fulfill bundled assets directly: WebKit's Windows network process may not
  // reach loopback even though its renderer and the preview server are healthy.
  await page.route(base + '/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!/^\/(?:index\.html|(?:css|js|img|vendor)\/[\w./-]+)?$/.test(path) || path.includes('..')) return route.abort();
    const file = new URL('../app/src/main/assets/www' + (path === '/' ? '/index.html' : path), import.meta.url);
    const contentType = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.jpg') ? 'image/jpeg' : path.endsWith('.png') ? 'image/png' : path.endsWith('.woff2') ? 'font/woff2' : 'text/html';
    await route.fulfill({ contentType, body: await readFile(file) });
  });
  await mockIOSLayout(page);
  await page.goto(base + '/#/home', { waitUntil: 'domcontentloaded' });
  await page.locator('.dashboard-quality-grid').waitFor();
  await page.evaluate(async user => {
    await Api.AUTH.commit({ access_token: 'mock-second', user: { ...user, id: 20, email: 'second-long-account@example.test' } }, 'second-long-account@example.test');
    await Api.AUTH.commit({ access_token: 'mock-layout-access', user }, user.email);
    App.go('#/home', true);
  }, user);
  const sizes = process.env.PP_LAYOUT_QUICK === '1' ? [{ width: 320, height: 700 }, { width: 390, height: 844 }] : [
    { width: 320, height: 700 }, { width: 375, height: 812 }, { width: 390, height: 844 }, { width: 430, height: 932 },
    { width: 844, height: 390 }, { width: 768, height: 1024 }
  ];
  const themes = process.env.PP_LAYOUT_QUICK === '1' ? ['ocean'] : ['ocean', 'dark'];
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.evaluate(({ landscape }) => __applyInsets(landscape ? 0 : 47, landscape ? 21 : 34, landscape ? 47 : 0, landscape ? 47 : 0), { landscape: size.width > size.height });
    for (const theme of themes) {
      await page.evaluate(theme => AppTheme.set(theme, true), theme);
      const id = `${size.width}x${size.height}-${theme}`;
      for (const route of ['home', 'plaza', 'rankings', 'channel-status', 'keys', 'usage', 'purchase', 'subscriptions', 'orders', 'me', 'accounts', 'profile', 'redeem', 'affiliate', 'announcements', 'announcements/7', 'updates', 'about']) {
        await page.evaluate(route => { U.closeOverlay(); App.go('#/' + route); }, route);
        await page.waitForFunction(route => location.hash === '#/' + route, route);
        await page.waitForTimeout(250);
        await page.locator('main').evaluate(node => { node.scrollTop = 0; });
        if (route === 'purchase') await page.locator('.payment-plan-choice').first().waitFor();
        if (route === 'plaza') await page.locator('.plaza-group').first().waitFor();
        await inspect(page, `${id}-${route.replace('/', '-')}`);
        if (route === 'plaza') {
          const group = page.locator('.plaza-group').first();
          const toggle = group.locator('.plaza-group-toggle');
          if (await toggle.getAttribute('aria-expanded') === 'false') await activate(toggle);
          await group.locator('.plaza-model-title').first().evaluate(node => node.click());
          await inspect(page, `${id}-model-detail`);
          await page.evaluate(() => U.closeOverlay());
          await page.getByRole('button', { name: /^筛选模型/ }).evaluate(node => node.click());
          await inspect(page, `${id}-model-filters`);
          await page.evaluate(() => U.closeOverlay());
        }
        if (route === 'channel-status') {
          await activate(page.locator('.channel-timeline').first());
          await inspect(page, `${id}-channel-detail`);
          await page.evaluate(() => U.closeOverlay());
        }
        if (route === 'keys') {
          await activate(page.locator('.keycard-name').first());
          await inspect(page, `${id}-key-detail`);
          await page.evaluate(() => U.closeOverlay());
        }
        if (['home', 'plaza', 'rankings', 'channel-status', 'usage', 'purchase', 'profile', 'me', 'redeem'].includes(route)) {
          await page.locator('main').evaluate(node => { node.scrollTop = node.scrollHeight; });
          await page.waitForTimeout(100);
          const endClearance = await page.evaluate(() => {
            const view = document.querySelector('main');
            const slots = [...document.querySelectorAll('.route-slot .page > *:last-child, .route-slot .page:last-child > *:last-child')];
            const last = slots.filter(node => {
              const box = node.getBoundingClientRect();
              return box.width > 0 && box.height > 0 && box.bottom <= innerHeight + 1;
            }).sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
            const bar = document.querySelector('.tabbar').getBoundingClientRect();
            return { scrollTop: view.scrollTop, scrollHeight: view.scrollHeight, clientHeight: view.clientHeight,
              tabTop: bar.top, bottom: last ? last.getBoundingClientRect().bottom : 0, tag: last ? last.className : '' };
          });
          if (endClearance.scrollTop + endClearance.clientHeight >= endClearance.scrollHeight - 2 && endClearance.bottom > endClearance.tabTop + 1) {
            issues.push({ name: `${id}-${route}-bottom`, bottom: endClearance });
          }
          await inspect(page, `${id}-${route}-bottom`);
        }
      }
      await page.evaluate(() => { App.go('#/chat'); });
      await page.locator('.chat-toolbar').waitFor();
      await inspect(page, `${id}-chat`);
      const keyboardHeight = Math.min(300, Math.round(size.height * .48));
      await page.locator('.composer textarea').focus();
      await page.evaluate(overlap => __applyKeyboard({ visible: true, overlap }), keyboardHeight);
      assert.equal(await page.locator('.tabbar').isVisible(), false);
      assert.ok(await page.locator('.composer').evaluate((node, height) => {
        const box = node.getBoundingClientRect();
        return box.top >= 0 && Math.abs(innerHeight - height - box.bottom - 8) < 1;
      }, keyboardHeight), id + ' composer must clear the keyboard');
      await inspect(page, id + '-chat-keyboard');
      await page.evaluate(() => { document.activeElement.blur(); __applyKeyboard(null); });
      await activate(page.locator('.chat-toolbar .chip').nth(1));
      await page.getByRole('heading', { name: '选择令牌', exact: true }).waitFor();
      await inspect(page, `${id}-chat-keys`);
      await page.evaluate(() => U.closeOverlay());
      await activate(page.locator('.chat-toolbar .chip').first());
      await page.getByRole('heading', { name: /选择模型/ }).waitFor();
      await inspect(page, `${id}-chat-models`);
      await page.evaluate(() => U.closeOverlay());
      await activate(page.getByRole('button', { name: '对话设置', exact: true }));
      await inspect(page, `${id}-chat-settings`);
      await page.locator('.sheet textarea').first().focus();
      await page.evaluate(() => window.__applyKeyboard({ visible: true, overlap: 300 }));
      await page.waitForFunction(() => document.body.classList.contains('kb-open'));
      const keyboardSheet = await page.locator('.sheet').last().evaluate(node => {
        const box = node.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, keyboardTop: innerHeight - 300, height: box.height, scrollHeight: node.scrollHeight };
      });
      assert.ok(keyboardSheet.top >= -1 && keyboardSheet.bottom <= keyboardSheet.keyboardTop + 1, `${id} settings sheet overlaps keyboard: ${JSON.stringify(keyboardSheet)}`);
      await page.evaluate(() => window.__applyKeyboard({ visible: false, overlap: 0 }));
      await page.evaluate(() => U.closeOverlay());
      await activate(page.getByRole('button', { name: '历史对话', exact: true }));
      await inspect(page, `${id}-chat-history`);
      await page.evaluate(() => U.closeOverlay());
      await activate(page.getByRole('button', { name: '一键测试', exact: true }));
      await page.getByRole('button', { name: '开始测试 3 个模型' }).waitFor();
      await inspect(page, `${id}-chat-tests`);
      await activate(page.getByRole('button', { name: '开始测试 3 个模型' }));
      await inspect(page, `${id}-chat-test-confirm`);
      await activate(page.getByRole('button', { name: '确认并测试', exact: true }));
      await page.getByText('测试完成 · 3/3 个模型', { exact: true }).waitFor();
      assert.equal(await page.getByText('模拟回答：一加一等于二。', { exact: true }).count(), 3);
      await inspect(page, id + '-chat-test-results');
      await page.evaluate(() => U.closeOverlay());
      await page.evaluate(() => { App.go('#/me'); AppTheme.open(); });
      await inspect(page, `${id}-themes`);
      await page.evaluate(() => U.closeOverlay());
      await page.evaluate(() => App.go('#/keys'));
      await page.locator('.key-card-more').first().evaluate(node => {
        // Keep both operations on the same card if the background refresh replaces the list.
        node.click();
        node.closest('.keycard').querySelector('.key-card-menu button').click();
      });
      await page.getByRole('button', { name: '选择分组', exact: true }).waitFor();
      await inspect(page, `${id}-key-editor`);
      await activate(page.getByRole('button', { name: '选择分组', exact: true }));
      await page.getByRole('listbox').waitFor();
      await inspect(page, `${id}-group-picker`);
      await page.evaluate(() => U.closeOverlay());
      await page.evaluate(() => App.go('#/usage'));
      const charts = page.locator('.usage-trend-svg');
      await charts.nth(1).waitFor();
      for (const chart of await charts.all()) {
        await chart.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
        await page.waitForTimeout(100);
        const hit = chart.locator('.usage-trend-hit');
        const hitBox = await hit.boundingBox();
        const tapX = hitBox.x + hitBox.width * .6, tapY = hitBox.y + hitBox.height * .45;
        await page.touchscreen.tap(tapX, tapY);
        await page.waitForTimeout(100);
        const tooltip = await chart.locator('.usage-trend-tip').filter({ visible: true }).evaluate(node => {
          const rect = node.querySelector('rect');
          const texts = [...node.querySelectorAll('text')];
          return { x: Number(rect.getAttribute('x')), width: Number(rect.getAttribute('width')), fill: getComputedStyle(rect).fill,
            textFill: texts.map(text => getComputedStyle(text).fill), text: node.textContent,
            guides: [...node.ownerSVGElement.querySelectorAll('.usage-trend-guide')].map(guide => ({
              display: getComputedStyle(guide).display,
              x: Number(guide.getAttribute('x1')),
              y: Number(guide.getAttribute('y1'))
            })) };
        });
        assert.ok(tooltip.x >= 44 && tooltip.x + tooltip.width <= 311, `${id} chart tooltip escapes plot bounds: ${JSON.stringify(tooltip)}`);
        assert.ok(tooltip.textFill.every(fill => fill !== tooltip.fill), `${id} chart tooltip text contrast is missing`);
        assert.ok(tooltip.text.trim(), `${id} chart tooltip has no data`);
        assert.ok(tooltip.guides.length >= 2, `${id} chart must render horizontal and vertical guides: ${JSON.stringify(tooltip.guides)}`);
        assert.ok(tooltip.guides.every(guide => guide.display !== 'none'), `${id} chart guides disappear after a touch tap: ${JSON.stringify(tooltip.guides)}`);
      }
      await activate(page.getByRole('button', { name: '自定义时间', exact: true }));
      await inspect(page, `${id}-date-fields`);
      await activate(page.getByRole('button', { name: '选择开始日期', exact: true }));
      await inspect(page, `${id}-calendar`);
      await page.evaluate(() => U.closeOverlay());
      await activate(page.getByRole('button', { name: '选择开始时间', exact: true }));
      await inspect(page, `${id}-time-picker`);
      await page.evaluate(() => U.closeOverlay());
      await activate(page.locator('.usage-log-item').first());
      await inspect(page, `${id}-usage-detail`);
      await page.evaluate(() => U.closeOverlay());
    }
  }
  for (const route of ['login', 'register', 'forgot']) {
    await page.evaluate(route => App.go('#/' + route), route);
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => __applyInsets(47, 34, 0, 0));
      await inspect(page, `${width}-auth-${route}`);
    }
  }
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (screenshotDir) await writeFile(`${screenshotDir}/report.json`, JSON.stringify({ pages: report.length, issues, report }, null, 2));
  console.log(JSON.stringify({ pages: report.length, issues }, null, 2));
}
if (!inspectOnly) assert.deepEqual(issues, [], 'iOS layouts must have centered icons, readable text and no overlapping controls');
