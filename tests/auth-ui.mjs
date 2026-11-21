import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { createPreviewServer, listenPreview } from '../preview.mjs';

const server = createPreviewServer();
await listenPreview(server);
const base = `http://127.0.0.1:${server.address().port}`;
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
const email = 'saved@example.test';
const password = 'test-only-saved-password';
const screenshotDir = process.env.PP_TEST_SCREENSHOTS;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });

async function run(engine, name) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      window.Native = {
        secureMode: () => 'sync',
        secureGet: () => sessionStorage.getItem('test-vault') || '',
        secureSet: value => { sessionStorage.setItem('test-vault', value); return true; },
        copy: value => { window.copied = value; }
      };
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      let expanded = false;
      if (location.hash === '#/plaza' || location.hash.startsWith('#/plaza/')) {
        new MutationObserver(() => {
          if (expanded) return;
          const toggle = document.querySelector('.plaza-group-toggle');
          if (!toggle) return;
          expanded = true;
          if (toggle.getAttribute('aria-expanded') === 'false') toggle.click();
        }).observe(document, { childList: true, subtree: true });
      }
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__proxy/**', route => {
      const path = new URL(route.request().url()).pathname.replace('/__proxy/site', '');
      if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
      if (path === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [{
        id: 1, name: 'Codex Pro【不降智】', platform: 'openai', rate_multiplier: 0.12, description: 'GPT 系列模型',
        models: ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6'].map(name => ({ name, pricing: { billing_mode: 'token', input_price: 0.000001, output_price: 0.000004 } }))
      }] }));
      if (path === '/api/v1/auth/login') return route.fulfill(ok({ access_token: 'access-ui', refresh_token: 'refresh-ui', user: { email } }));
      if (path === '/api/v1/auth/me') return route.fulfill(ok({ email }));
      if (path === '/api/v1/keys') return route.fulfill(ok({ items: [{ id: 1, name: '测试令牌', key: 'sk-test', status: 'active' }] }));
      return route.fulfill(ok([]));
    });
    await page.goto(base + '/#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const remember = page.getByRole('checkbox', { name: '记住密码，失效后自动登录' });
    assert.equal(await remember.isChecked(), false);
    await page.locator('input[type=email]').fill(email);
    await page.locator('input[type=password]').fill(password);
    await remember.evaluate(node => {
      node.checked = true;
      node.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.locator('#view').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      if (screenshotDir && width === 390) await page.screenshot({ path: `${screenshotDir}/${name}-login.png` });
    }
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => Api.AUTH.isLogged());
    await page.waitForLoadState('networkidle');
    await page.reload();
    await page.waitForFunction(() => Api.AUTH.isLogged());
    await page.waitForLoadState('networkidle');
    await page.evaluate(async () => {
      const id = Api.AUTH.currentId();
      await Api.AUTH.expire(id);
      App.loginEmail = 'saved@example.test';
      App.go('#/login', true);
    });
    await remember.waitFor();
    assert.equal(await remember.isChecked(), true);
    assert.equal(await page.locator('input[type=password]').inputValue(), password);
    await page.locator('input[type=email]').fill('other@example.test');
    await page.locator('input[type=email]').blur();
    assert.equal(await remember.isChecked(), false);
    assert.equal(await page.locator('input[type=password]').inputValue(), '');
    await page.locator('input[type=email]').fill(email);
    await page.locator('input[type=email]').blur();
    assert.equal(await page.locator('input[type=password]').inputValue(), password);
    await remember.uncheck();
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => Api.AUTH.isLogged());
    assert.equal(await page.evaluate(() => Api.AUTH.remembered('saved@example.test').enabled), false);
    assert.equal(await page.evaluate(secret => JSON.stringify(localStorage).includes(secret), password), false);

    await page.evaluate(() => App.go('#/plaza'));
    await page.locator('.plaza-group').first().waitFor();
    await page.waitForFunction(() => document.querySelector('.plaza-group-toggle')?.getAttribute('aria-expanded') === 'true', null, { timeout: 15000 });
    await page.locator('.plaza-model-copy').first().waitFor({ state: 'visible' });
    assert.equal(await page.locator('.plaza-model-copy').count(), 3);
    for (const theme of ['ocean', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.locator('.plaza-model-copy svg').count(), 3);
        await page.locator('.plaza-model-copy').first().waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
          const nodes = Array.from(document.querySelectorAll('.plaza-model-copy'));
          return nodes.length === 3 && nodes.every(node => {
            const box = node.getBoundingClientRect();
            return Math.round(box.width) === 32 && Math.round(box.height) === 32;
          });
        });
        const copies = await page.locator('.plaza-model-copy').evaluateAll(nodes => nodes.map(node => {
          const box = node.getBoundingClientRect();
          return { text: node.textContent, width: box.width, height: box.height };
        }));
        for (const copy of copies) {
          assert.equal(copy.text, '');
          assert.equal(Math.round(copy.width), 32);
          assert.equal(Math.round(copy.height), 32);
        }
        assert.equal(await page.locator('#view').evaluate(node => node.scrollWidth <= node.clientWidth), true);
        if (screenshotDir && width === 390) await page.screenshot({ path: `${screenshotDir}/${name}-plaza-${theme}.png` });
      }
    }
    await page.getByRole('button', { name: '复制模型名称 gpt-5.6-sol', exact: true }).click();
    assert.equal(await page.evaluate(() => window.copied), 'gpt-5.6-sol');
    assert.equal(await page.locator('.sheet').count(), 0);

    await page.getByRole('button', { name: '首页', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.appbar-actions .icon-btn').length === 3);
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const centers = await page.locator('.appbar-actions .icon-btn').evaluateAll(items => items.filter(item => getComputedStyle(item).display !== 'none').map(item => {
        const box = item.getBoundingClientRect();
        const icon = item.querySelector('svg').getBoundingClientRect();
        return {
          label: item.getAttribute('aria-label'),
          width: box.width,
          height: box.height,
          offsetX: Math.abs((box.left + box.right - icon.left - icon.right) / 2),
          offsetY: Math.abs((box.top + box.bottom - icon.top - icon.bottom) / 2)
        };
      }));
      assert.equal(centers.length, 3, JSON.stringify(centers));
      assert.ok(centers.every(item => item.width >= 44 && item.height >= 44 && item.offsetX < .5 && item.offsetY < .5), JSON.stringify(centers));
    }
    await page.evaluate(() => App.go('#/keys'));
    await page.locator('.key-card-more').first().waitFor();
    const keyIcon = await page.locator('.key-card-more').first().evaluate(item => {
      const box = item.getBoundingClientRect();
      const icon = item.querySelector('svg').getBoundingClientRect();
      return { width: box.width, height: box.height, offsetX: Math.abs((box.left + box.right - icon.left - icon.right) / 2), offsetY: Math.abs((box.top + box.bottom - icon.top - icon.bottom) / 2) };
    });
    assert.ok(keyIcon.offsetX < .5 && keyIcon.offsetY < .5, JSON.stringify(keyIcon));
    await page.evaluate(() => App.go('#/chat'));
    await page.locator('.chat-toolbar .tool-btn').first().waitFor();
    const chatCenters = await page.locator('.chat-toolbar .tool-btn').evaluateAll(items => items.map(item => {
      const box = item.getBoundingClientRect();
      const icon = item.querySelector('svg').getBoundingClientRect();
      return { offsetX: Math.abs((box.left + box.right - icon.left - icon.right) / 2), offsetY: Math.abs((box.top + box.bottom - icon.top - icon.bottom) / 2) };
    }));
    assert.equal(chatCenters.length, 2);
    assert.ok(chatCenters.every(item => item.offsetX < .5 && item.offsetY < .5), JSON.stringify(chatCenters));
    assert.deepEqual(errors.filter(message => !/due to access control checks/i.test(message)), []);
    await context.close();
    console.log(`${name}: remember-password controls, account autofill, copy icons and responsive layouts passed`);
  } finally { await browser.close(); }
}
try {
  await run(chromium, 'Chromium');
  await run(webkit, 'WebKit');
} finally { await new Promise(resolve => server.close(resolve)); }
