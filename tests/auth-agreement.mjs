import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createPreviewServer, listenPreview } from '../preview.mjs';

const server = createPreviewServer();
await listenPreview(server);
const base = `http://127.0.0.1:${server.address().port}`;
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });

async function run(engine, name) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    let revision = 'terms-v1';
    let loginCalls = 0;
    let registerCalls = [];
    await page.route('**/__proxy/**', async route => {
      const path = new URL(route.request().url()).pathname.replace('/__proxy/site', '');
      if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API', login_agreement_enabled: true,
        login_agreement_mode: 'modal', login_agreement_revision: revision, login_agreement_updated_at: '2026-11-20',
        login_agreement_documents: [{ id: 'terms', title: '服务条款', content_md: '**请阅读**\n\n本版本条款内容。' }] }));
      if (path === '/api/v1/auth/login') {
        loginCalls++;
        return route.fulfill(ok({ access_token: `agreement-${loginCalls}`, user: { id: 1, email: 'agreement@example.test' } }));
      }
      if (path === '/api/v1/auth/send-verify-code') return route.fulfill(ok({ sent: true }));
      if (path === '/api/v1/auth/register') {
        registerCalls.push(JSON.parse(route.request().postData()));
        return route.fulfill(ok({ access_token: 'registration-agreement', user: { id: 2, email: 'new@example.test' } }));
      }
      if (path === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'agreement@example.test' }));
      return route.fulfill(ok([]));
    });

    await page.goto(base + '/#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('heading', { name: '服务条款确认' }).waitFor();
    await page.locator('.auth-agreement-doc summary').click();
    await page.getByText('请阅读').waitFor();
    await page.getByRole('button', { name: '暂不同意' }).click();
    assert.equal(await page.getByRole('button', { name: '登录', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '查看条款' }).click();
    await page.getByRole('button', { name: '同意并继续' }).click();
    assert.equal(await page.getByRole('button', { name: '登录', exact: true }).isDisabled(), false);

    await page.locator('input[type=email]').fill('agreement@example.test');
    await page.locator('input[type=password]').fill('test-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => Api.AUTH.isLogged());
    assert.equal(loginCalls, 1);

    await page.evaluate(() => Api.AUTH.expire(Api.AUTH.currentId(), 'expired'));
    revision = 'terms-v2';
    await page.goto(base + '/#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('heading', { name: '服务条款确认' }).waitFor();
    await page.getByRole('button', { name: '同意并继续' }).click();
    assert.equal(await page.getByRole('button', { name: '登录', exact: true }).isDisabled(), false);
    assert.equal(await page.evaluate(() => Api.hasLoginAgreement({ revision: 'terms-v2' })), true);
    assert.equal(await page.evaluate(() => Api.hasLoginAgreement({ revision: 'terms-v1' })), false);

    revision = 'terms-v3';
    await page.goto(base + '/#/register', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input[type=email]').fill('new@example.test');
    await page.locator('input[inputmode=numeric]').fill('123456');
    await page.locator('input[type=password]').nth(0).fill('valid-test-password');
    await page.locator('input[type=password]').nth(1).fill('valid-test-password');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await page.getByRole('heading', { name: '服务条款确认' }).waitFor();
    assert.equal(registerCalls.length, 0, 'registration must wait for current terms consent');
    await page.locator('.auth-agreement-doc summary').click();
    await page.getByRole('button', { name: '同意并继续' }).click();
    await page.waitForFunction(() => Api.AUTH.currentId() === 'email:new@example.test');
    assert.equal(registerCalls.length, 1, 'registration continues after consent without repeating form entry');
    assert.deepEqual(registerCalls[0], { email: 'new@example.test', password: 'valid-test-password', verify_code: '123456' });
    await context.close();
    console.log(`${name}: current-version agreement gate, refusal and re-consent passed`);
  } finally { await browser.close(); }
}

try {
  await run(chromium, 'Chromium');
  await run(webkit, 'WebKit');
} finally { await new Promise(resolve => server.close(resolve)); }
