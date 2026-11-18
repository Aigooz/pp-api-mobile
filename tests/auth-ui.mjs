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
      return route.fulfill(ok([]));
    });
    await page.goto(base + '/#/login');
    const remember = page.getByRole('checkbox', { name: '记住密码，失效后自动登录' });
    assert.equal(await remember.isChecked(), false);
    await page.locator('input[type=email]').fill(email);
    await page.locator('input[type=password]').fill(password);
    await remember.check();
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.locator('#view').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      if (screenshotDir && width === 390) await page.screenshot({ path: `${screenshotDir}/${name}-login.png` });
    }
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
    await page.locator('.plaza-model-copy').first().waitFor();
    for (const theme of ['ocean', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.locator('.plaza-model-copy svg').count(), 3);
        for (const copy of await page.locator('.plaza-model-copy').all()) {
          assert.equal(await copy.textContent(), '');
          const bounds = await copy.boundingBox();
          assert.equal(Math.round(bounds.width), 32);
          assert.equal(Math.round(bounds.height), 32);
        }
        assert.equal(await page.locator('#view').evaluate(node => node.scrollWidth <= node.clientWidth), true);
        if (screenshotDir && width === 390) await page.screenshot({ path: `${screenshotDir}/${name}-plaza-${theme}.png` });
      }
    }
    await page.getByRole('button', { name: '复制模型名称 gpt-5.6-sol', exact: true }).click();
    assert.equal(await page.evaluate(() => window.copied), 'gpt-5.6-sol');
    assert.equal(await page.locator('.sheet').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${name}: remember-password controls, account autofill, copy icons and responsive layouts passed`);
  } finally { await browser.close(); }
}
try {
  await run(chromium, 'Chromium');
  await run(webkit, 'WebKit');
} finally { await new Promise(resolve => server.close(resolve)); }
