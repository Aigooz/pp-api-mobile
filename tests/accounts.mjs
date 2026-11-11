import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPreviewServer } from '../preview.mjs';

const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
const error = (status, message) => ({ status, contentType: 'application/json', body: JSON.stringify({ code: 'ERROR', message }) });
const accounts = {
  'a@example.test': { id: 1, name: 'a', email: 'a@example.test' },
  'b@example.test': { id: 2, name: 'b', email: 'b@example.test' },
  'c@example.test': { id: 3, name: 'c', email: 'c@example.test' }
};
let refreshMode = 'ok';
let holdKeys = false;
let releaseKeys;
let keysStarted;
let holdRefresh = false;
let releaseRefresh;
let refreshStarted;

async function mockNetwork(page) {
  await page.route('**/__proxy/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/__proxy\/(site|model)/, '');
    const authorization = route.request().headers().authorization || '';
    const account = Object.values(accounts).find(a => authorization.startsWith('Bearer access-' + a.name));
    if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
    if (path === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [] }));
    if (path === '/api/v1/auth/login') {
      const body = route.request().postDataJSON();
      const user = accounts[body.email];
      if (!user || body.password !== 'correct-test-password') return route.fulfill(error(401, 'invalid email or password'));
      if (body.email === 'c@example.test') return route.fulfill(error(400, 'two factor required'));
      return route.fulfill(ok({ access_token: 'access-' + user.name, refresh_token: 'refresh-' + user.name, user: { ...user, password: 'must-not-persist' } }));
    }
    if (path === '/api/v1/auth/login/2fa') {
      const body = route.request().postDataJSON();
      const user = accounts[body.email];
      if (!user || body.password !== 'correct-test-password' || body.code !== '123456') return route.fulfill(error(401, 'invalid verification code'));
      return route.fulfill(ok({ access_token: 'access-' + user.name, refresh_token: 'refresh-' + user.name, user }));
    }
    if (path === '/api/v1/auth/register') {
      const body = route.request().postDataJSON();
      const user = accounts[body.email];
      if (!user || body.verify_code !== '123456') return route.fulfill(error(400, 'invalid verification code'));
      return route.fulfill(ok({ access_token: 'access-' + user.name, refresh_token: 'refresh-' + user.name, user }));
    }
    if (path === '/api/v1/auth/me') return route.fulfill(account ? ok(account) : error(401, 'unauthorized'));
    if (path === '/api/v1/auth/logout') return route.fulfill(ok({}));
    if (path === '/api/v1/auth/refresh') {
      if (holdRefresh) {
        holdRefresh = false;
        refreshStarted();
        await new Promise(resolve => { releaseRefresh = resolve; });
      }
      if (refreshMode === 'network') return route.fulfill(error(503, 'temporary failure'));
      if (refreshMode === 'expired') return route.fulfill(error(401, 'expired'));
      const name = route.request().postDataJSON().refresh_token.replace('refresh-', '');
      return route.fulfill(ok({ access_token: 'access-' + name + '-refreshed', refresh_token: 'refresh-' + name }));
    }
    if (path === '/api/v1/protected-test') {
      return route.fulfill(authorization.endsWith('-refreshed') ? ok({ name: account?.name }) : error(401, 'expired'));
    }
    if (path === '/api/v1/keys') {
      const name = account?.name || 'none';
      if (holdKeys && name === 'a') {
        holdKeys = false;
        keysStarted();
        await new Promise(resolve => { releaseKeys = resolve; });
      }
      return route.fulfill(ok({ items: [{ id: account?.id, name: 'key-' + name, key: 'secret-' + name, status: 'active' }] }));
    }
    if (path === '/v1/models') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'model-test' }] }) });
    if (path === '/v1/chat/completions') {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n' });
    }
    return route.fulfill(ok([]));
  });
}

async function makeContext(mode = 'sync', legacy = false) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ mode, legacy }) => {
    if (legacy && !sessionStorage.getItem('test_seeded')) {
      sessionStorage.setItem('test_seeded', '1');
      localStorage.setItem('pp_api_token', JSON.stringify('access-a'));
      localStorage.setItem('pp_api_refresh', JSON.stringify('refresh-a'));
      localStorage.setItem('pp_api_user', JSON.stringify({ id: 1, email: 'a@example.test' }));
      localStorage.setItem('pp_api_chat_messages', JSON.stringify([{ role: 'user', content: 'legacy-only-a' }]));
    }
    if (mode === 'none') return;
    window.Native = {
      secureMode: () => mode,
      secureGet: () => sessionStorage.getItem('test_native_vault') || '',
      secureSet: mode === 'sync' ? value => {
        if (sessionStorage.getItem('test_fail_write')) return false;
        sessionStorage.setItem('test_native_vault', value);
        return true;
      } : (id, value) => {
        setTimeout(() => {
          const success = !sessionStorage.getItem('test_fail_write');
          if (success) sessionStorage.setItem('test_native_vault', value);
          window.__nativeSecure(id, success);
        }, 15);
      }
    };
  }, { mode, legacy });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await mockNetwork(page);
  return { context, page, errors };
}

async function login(page, email, password = 'correct-test-password') {
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

async function openAccounts(page) {
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByText('账号管理', { exact: true }).click();
}

async function sendChat(page, message) {
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.getByText('model-test').first().waitFor();
  await page.locator('.composer textarea').fill(message);
  await page.locator('.send-btn').click();
  await page.getByText('reply', { exact: true }).last().waitFor();
}

try {
  const { context, page, errors } = await makeContext();
  await page.goto(base + '/#/login');
  await login(page, 'a@example.test');
  await page.waitForFunction(() => Api.AUTH.currentId() === 'email:a@example.test');
  await sendChat(page, 'private-message-a');
  await openAccounts(page);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.querySelector('#view').scrollWidth), await page.evaluate(() => document.querySelector('#view').clientWidth));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.PP_TEST_SCREENSHOTS) await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-accounts.png', animations: 'disabled' });
  await page.getByRole('button', { name: '添加账号' }).click();
  await login(page, 'b@example.test', 'wrong');
  await page.getByText('邮箱或密码错误').waitFor();
  assert.equal(await page.evaluate(() => Api.AUTH.currentId()), 'email:a@example.test');
  await login(page, 'b@example.test');
  await page.waitForFunction(() => Api.AUTH.currentId() === 'email:b@example.test');
  await sendChat(page, 'private-message-b');
  assert.equal(await page.getByText('private-message-a').count(), 0);
  await openAccounts(page);
  await page.getByRole('button', { name: '切换到 a@example.test' }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.getByText('private-message-a').waitFor();
  assert.equal(await page.getByText('private-message-b').count(), 0);

  // A delayed response from the previous account must not alter B's shared keys.
  let started = new Promise(resolve => { keysStarted = resolve; });
  holdKeys = true;
  await page.evaluate(() => App.go('#/chat'));
  await started;
  await openAccounts(page);
  await page.getByRole('button', { name: '切换到 b@example.test' }).click();
  releaseKeys();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.getByText('private-message-b').waitFor();
  await page.waitForFunction(() => S.keys.length && S.keys[0].name === 'key-b');
  await page.reload();
  await page.waitForFunction(() => Api.AUTH.currentId() === 'email:b@example.test');
  assert.equal(await page.evaluate(() => Api.AUTH.accounts().length), 2);
  assert.equal(await page.getByText('private-message-a').count(), 0);

  // A rejected old refresh must not expire a newer session for the same account.
  started = new Promise(resolve => { refreshStarted = resolve; });
  refreshMode = 'expired';
  holdRefresh = true;
  await page.evaluate(() => { window.testOldRefresh = Api.base('/protected-test').then(() => 'unexpected', e => e.code); });
  await started;
  await page.evaluate(async () => {
    await App.switchAccount('email:a@example.test');
    await App.switchAccount('email:b@example.test');
  });
  releaseRefresh();
  assert.equal(await page.evaluate(() => window.testOldRefresh), 'ACCOUNT_CHANGED');
  assert.equal(await page.evaluate(() => Api.AUTH.currentId()), 'email:b@example.test');

  // Temporary refresh failures do not erase a session; rejected refresh does.
  refreshMode = 'network';
  assert.equal(await page.evaluate(() => Api.base('/protected-test').then(() => 'unexpected', e => e.code)), 'SERVER');
  assert.equal(await page.evaluate(() => Api.AUTH.currentId()), 'email:b@example.test');
  refreshMode = 'ok';
  assert.equal(await page.evaluate(() => Api.base('/protected-test').then(d => d.name)), 'b');
  refreshMode = 'expired';
  assert.equal(await page.evaluate(() => Api.base('/protected-test', { headers: { Authorization: 'Bearer access-b' } }).then(() => 'unexpected', e => e.code)), 'UNAUTHORIZED');
  await page.getByRole('button', { name: '重新登录 b@example.test' }).waitFor();
  await page.getByRole('button', { name: '重新登录 b@example.test' }).click();
  assert.equal(await page.locator('input[type=email]').inputValue(), 'b@example.test');
  await page.locator('input[type=password]').fill('correct-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForFunction(() => Api.AUTH.currentId() === 'email:b@example.test');
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.getByRole('button', { name: '切换到 a@example.test' }).waitFor();
  await page.getByRole('button', { name: '重新登录 b@example.test' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '切换到 a@example.test' }).waitFor();
  await page.getByRole('button', { name: '重新登录 b@example.test' }).click();
  await page.locator('input[type=password]').fill('correct-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForFunction(() => Api.AUTH.currentId() === 'email:b@example.test');
  await openAccounts(page);
  await page.getByRole('button', { name: '移除账号 a@example.test' }).click();
  await page.getByRole('button', { name: '移除', exact: true }).click();
  await page.waitForFunction(() => Api.AUTH.accounts().length === 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('pp_api_chat_store_v2:' + encodeURIComponent('email:a@example.test'))), null);
  await page.reload();
  await page.waitForFunction(() => Api.AUTH.accounts().length === 1);
  assert.equal(await page.evaluate(() => Api.AUTH.accounts()[0].email), 'b@example.test');

  await page.evaluate(() => sessionStorage.setItem('test_fail_write', '1'));
  await page.getByRole('button', { name: '添加账号' }).click();
  await login(page, 'c@example.test');
  await page.getByText('两步验证', { exact: true }).waitFor();
  await page.locator('.sheet input').fill('123456');
  await page.getByRole('button', { name: '验证', exact: true }).click();
  await page.getByText(/安全存储写入失败/).first().waitFor();
  assert.equal(await page.evaluate(() => Api.AUTH.currentId()), 'email:c@example.test');
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('correct-test-password')), false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('test_native_vault').includes('password')), false);
  await page.reload();
  await page.waitForFunction(() => Api.AUTH.currentId() === 'email:b@example.test');
  assert.deepEqual(errors, []);
  await context.close();

  // The legacy chat is assigned to the old account before another user signs in.
  const legacy = await makeContext('sync', true);
  await legacy.page.goto(base + '/#/accounts');
  await legacy.page.getByRole('button', { name: '添加账号' }).click();
  await login(legacy.page, 'b@example.test');
  await legacy.page.waitForFunction(() => Api.AUTH.currentId() === 'email:b@example.test');
  await legacy.page.getByRole('button', { name: '对话', exact: true }).click();
  await legacy.page.getByText('model-test').first().waitFor();
  assert.equal(await legacy.page.getByText('legacy-only-a').count(), 0);
  await openAccounts(legacy.page);
  await legacy.page.getByRole('button', { name: '切换到 a@example.test' }).click();
  await legacy.page.getByRole('button', { name: '对话', exact: true }).click();
  await legacy.page.getByText('legacy-only-a').waitFor();
  assert.equal(await legacy.page.evaluate(() => localStorage.getItem('pp_api_token')), null);
  assert.deepEqual(legacy.errors, []);
  await legacy.context.close();

  // Exercise the asynchronous iOS-style bridge and its serialized writes.
  const asyncNative = await makeContext('async');
  await asyncNative.page.goto(base + '/#/login');
  await login(asyncNative.page, 'a@example.test');
  await asyncNative.page.waitForFunction(() => Api.AUTH.currentId() === 'email:a@example.test');
  await openAccounts(asyncNative.page);
  await asyncNative.page.getByRole('button', { name: '添加账号' }).click();
  await login(asyncNative.page, 'b@example.test');
  await asyncNative.page.waitForFunction(() => Api.AUTH.currentId() === 'email:b@example.test');
  await asyncNative.page.waitForFunction(() => JSON.parse(sessionStorage.getItem('test_native_vault') || '{}').accounts?.length === 2);
  await asyncNative.page.reload();
  await asyncNative.page.waitForFunction(() => Api.AUTH.currentId() === 'email:b@example.test');
  assert.deepEqual(asyncNative.errors, []);
  await asyncNative.context.close();

  const preview = await makeContext('none');
  await preview.page.goto(base + '/#/login');
  await login(preview.page, 'a@example.test');
  await preview.page.getByText(/安全存储不可用/).waitFor();
  assert.equal(await preview.page.evaluate(() => Object.keys(localStorage).some(k => /token|refresh/.test(k))), false);
  await preview.page.reload();
  assert.equal(await preview.page.evaluate(() => Api.AUTH.isLogged()), false);
  assert.deepEqual(preview.errors, []);
  await preview.context.close();

  const registration = await makeContext('sync');
  await registration.page.goto(base + '/#/register');
  await registration.page.locator('input[type=email]').fill('a@example.test');
  await registration.page.locator('input[inputmode=numeric]').fill('123456');
  await registration.page.locator('input[type=password]').nth(0).fill('correct-test-password');
  await registration.page.locator('input[type=password]').nth(1).fill('correct-test-password');
  await registration.page.getByRole('button', { name: '创建账号', exact: true }).click();
  await registration.page.waitForFunction(() => Api.AUTH.currentId() === 'email:a@example.test');
  await registration.page.reload();
  await registration.page.waitForFunction(() => Api.AUTH.currentId() === 'email:a@example.test');
  assert.deepEqual(registration.errors, []);
  await registration.context.close();
  console.log('Accounts: switching, recovery, expiry, isolation, migration and secure storage passed');
} finally {
  if (releaseKeys) releaseKeys();
  if (releaseRefresh) releaseRefresh();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
