import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPreviewServer } from '../preview.mjs';

const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
const fail = { status: 503, contentType: 'application/json', body: '{}' };
const models = names => names.map(name => ({ name, pricing: { billing_mode: 'token', input_price: 0.000001, output_price: 0.000002 } }));
const groupData = [{ id: 1, name: '第一分组' }, { id: 2, name: 'Codex 测试分组' }];
let statusFail = true, groupFail = false, secondStatFail = true, updates = [], statsQueries = [], keyGets = 0, concurrencyValue = 2;
let holdFirstStat = false, statStarted, releaseStat;

await page.route('**/__proxy/**', async route => {
  const url = new URL(route.request().url());
  const path = url.pathname.replace('/__proxy/site', '');
  const auth = route.request().headers().authorization || '';
  const accountB = auth.includes('access-b');
  if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
  if (path === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [
    { id: 1, name: '第一分组', platform: 'test', models: models(['green', 'yellow', 'red', 'unmonitored', 'shared', 'duplicate']) },
    { id: 2, name: 'Codex 测试分组', platform: 'test', models: models(['shared']) }
  ] }));
  if (path === '/api/public/channel-status') {
    if (statusFail) return route.fulfill(fail);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updatedAt: new Date().toISOString(), items: [
      { model: 'green', group: '第一分组', status: 'operational', availability: 99 },
      { model: 'yellow', group: '第一分组', status: 'operational', availability: 94 },
      { model: 'red', group: '第一分组', status: 'failed' },
      { model: 'shared', group: 'Codex 测试分组', status: 'operational', availability: 99 },
      ...Array.from({ length: 3 }, () => ({ model: 'duplicate', group: '第一分组', status: 'operational', availability: 99 }))
    ] }) });
  }
  if (path === '/api/v1/auth/login') return route.fulfill(ok({ access_token: 'access-a', user: { id: 1, email: 'a@example.test', balance: 3 } }));
  if (path === '/api/v1/auth/me') return route.fulfill(ok({ id: accountB ? 2 : 1, email: accountB ? 'b@example.test' : 'a@example.test', balance: 3 }));
  if (path === '/api/v1/groups/available') return route.fulfill(groupFail ? fail : ok(groupData));
  if (path === '/api/v1/keys' && route.request().method() === 'GET') {
    keyGets++;
    return route.fulfill(ok({ items: accountB ? [
    { id: 3, name: 'B 令牌', status: 'active', group_id: 2, quota_used: 0, current_concurrency: 0 }
  ] : [
    { id: 1, name: 'A 令牌', status: 'active', group_id: 1, quota: 0, quota_used: 0.25, current_concurrency: concurrencyValue, expires_at: '2028-02-29T23:59:59+08:00' },
    { id: 2, name: '第二令牌', status: 'active', group_id: 2, quota: 10, quota_used: 2 }
  ] }));
  }
  if (path === '/api/v1/keys/1' && route.request().method() === 'PUT') {
    updates.push(route.request().postDataJSON());
    return route.fulfill(ok({}));
  }
  if (path === '/api/v1/usage/stats') {
    const id = url.searchParams.get('api_key_id');
    if (!id) return route.fulfill(ok({ total_requests: 0, total_tokens: 0, total_actual_cost: 0 }));
    statsQueries.push({ id, start: url.searchParams.get('start_date'), end: url.searchParams.get('end_date'), timezone: url.searchParams.get('timezone'), accountB });
    if (id === '1' && holdFirstStat) {
      holdFirstStat = false;
      statStarted();
      await new Promise(resolve => { releaseStat = resolve; });
    }
    if (id === '2' && secondStatFail) return route.fulfill(fail);
    return route.fulfill(ok({ total_requests: Number(id) * 10, total_tokens: Number(id) * 1000, total_actual_cost: Number(id) / 10 }));
  }
  if (path === '/api/v1/usage/dashboard/stats') return route.fulfill(ok({}));
  if (path === '/api/v1/usage/dashboard/trend') return route.fulfill(ok({ trend: [] }));
  if (path === '/api/v1/usage/dashboard/models') return route.fulfill(ok({ models: [] }));
  if (path === '/api/v1/user/platform-quotas') return route.fulfill(ok({ platform_quotas: [] }));
  return route.fulfill(ok({ items: [] }));
});

try {
  await page.goto(base + '/#/plaza');
  await page.locator('.plaza-status').first().waitFor();
  assert.equal(await page.locator('.plaza-status.unknown').count(), 7);
  statusFail = false;
  await page.reload();
  await page.locator('.plaza-status.ok').first().waitFor();
  const state = async (group, model) => page.locator('.plaza-group').filter({ has: page.getByRole('heading', { name: group }) })
    .locator('.plaza-model').filter({ has: page.locator('.plaza-model-title', { hasText: new RegExp(`^${model}$`) }) }).locator('.plaza-status').getAttribute('class');
  assert.match(await state('第一分组', 'green'), /\bok\b/);
  assert.match(await state('第一分组', 'yellow'), /\bwarning\b/);
  assert.match(await state('第一分组', 'red'), /\berror\b/);
  assert.match(await state('第一分组', 'unmonitored'), /\bunknown\b/);
  assert.match(await state('第一分组', 'shared'), /\bunknown\b/);
  assert.match(await state('第一分组', 'duplicate'), /\bunknown\b/);
  assert.match(await state('Codex 测试分组', 'shared'), /\bok\b/);
  await page.getByRole('searchbox', { name: '搜索模型' }).fill('yellow');
  assert.equal(await page.locator('.plaza-model').count(), 1);
  assert.match(await page.locator('.plaza-status').getAttribute('aria-label'), /波动/);

  await page.goto(base + '/#/login');
  await page.locator('input[type=email]').fill('a@example.test');
  await page.locator('input[type=password]').fill('password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('用量分析').waitFor();
  await page.getByLabel('开始日期', { exact: true }).fill('2028-02-28');
  await page.getByRole('button', { name: '选择开始日期' }).click();
  await page.getByRole('button', { name: '2028-02-29' }).click();
  assert.equal(await page.getByLabel('开始日期', { exact: true }).inputValue(), '2028-02-29');
  await page.getByRole('button', { name: '选择开始日期' }).click();
  await page.getByRole('button', { name: '下个月' }).click();
  await page.getByRole('button', { name: '2028-03-01' }).click();
  assert.equal(await page.getByLabel('开始日期', { exact: true }).inputValue(), '2028-03-01');
  await page.getByRole('button', { name: '选择开始时间' }).click();
  await page.getByRole('listbox', { name: '小时' }).getByRole('option', { name: '10', exact: true }).click();
  await page.getByRole('listbox', { name: '分钟' }).getByRole('option', { name: '15', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确定' }).click();
  assert.equal(await page.getByLabel('开始时间', { exact: true }).inputValue(), '10:15');
  await page.getByRole('button', { name: '选择开始时间' }).click();
  await page.getByRole('listbox', { name: '小时' }).getByRole('option', { name: '12', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  assert.equal(await page.getByLabel('开始时间', { exact: true }).inputValue(), '10:15');

  await page.getByRole('navigation').getByRole('button', { name: '令牌', exact: true }).click();
  const first = page.locator('.keycard').filter({ hasText: 'A 令牌' });
  const second = page.locator('.keycard').filter({ hasText: '第二令牌' });
  await first.getByText('今日请求').waitFor();
  assert.match(await first.innerText(), /额度不限 · 额度已用 \$0\.25/);
  assert.match(await first.innerText(), /当前并发\s*2/);
  assert.match(await first.innerText(), /今日请求\s*10[\s\S]*今日 Tokens\s*1\.0K[\s\S]*今日花费\s*\$0\.1/);
  await second.getByText('今日用量暂不可用').waitFor();
  assert.match(await second.innerText(), /当前并发\s*—/);
  secondStatFail = false;
  await second.getByRole('button', { name: '重试' }).click();
  await second.getByText('今日请求').waitFor();
  assert.match(await second.innerText(), /今日请求\s*20/);
  assert.deepEqual(statsQueries.slice(0, 2).map(q => q.id).sort(), ['1', '2']);
  assert.ok(statsQueries.every(q => q.start && q.start === q.end && q.timezone === 'Asia/Shanghai'));
  const beforeRefresh = keyGets;
  concurrencyValue = 7;
  await page.clock.install();
  await page.clock.fastForward(30001);
  await page.waitForFunction(() => document.querySelector('.key-concurrency strong')?.textContent === '7');
  assert.equal(keyGets, beforeRefresh + 1);

  groupFail = true;
  await first.getByRole('button', { name: '编辑' }).click();
  await page.getByText('加载失败，点击重试').waitFor();
  groupFail = false;
  await page.getByRole('button', { name: '选择分组' }).click();
  await page.getByRole('button', { name: '选择分组' }).getByText('第一分组', { exact: true }).waitFor();
  await page.getByRole('button', { name: '选择分组' }).click();
  assert.equal(await page.getByRole('option', { name: '第一分组' }).getAttribute('aria-selected'), 'true');
  await page.getByRole('searchbox', { name: '搜索分组' }).fill('不存在');
  await page.getByText('没有找到分组').waitFor();
  await page.getByRole('searchbox', { name: '搜索分组' }).fill('Codex');
  assert.equal(await page.getByRole('option').count(), 1);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    if (process.env.PP_TEST_SCREENSHOTS) {
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
        await page.screenshot({ path: `${process.env.PP_TEST_SCREENSHOTS}/pp-group-${theme}-${width}.png`, animations: 'disabled' });
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  assert.match(await page.getByRole('button', { name: '选择分组' }).innerText(), /第一分组/);
  await page.getByRole('button', { name: '选择分组' }).click();
  await page.getByRole('option', { name: 'Codex 测试分组' }).click();
  assert.match(await page.getByRole('button', { name: '选择分组' }).innerText(), /Codex 测试分组/);
  await page.getByRole('button', { name: '选择到期时间' }).click();
  assert.equal(await page.getByRole('button', { name: '2028-02-29' }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('dialog').getByRole('button', { name: '清除' }).click();
  assert.equal(await page.getByLabel('到期时间', { exact: true }).inputValue(), '');
  await page.locator('.sheet').getByRole('button', { name: '保存' }).click();
  await page.waitForFunction(() => !document.querySelector('.sheet'));
  assert.equal(updates[0].group_id, 2);
  assert.equal(updates[0].expires_at, '');
  assert.equal(await page.locator('select, input[type=date], input[type=time]').count(), 0);

  let started = new Promise(resolve => { statStarted = resolve; });
  holdFirstStat = true;
  await page.evaluate(() => App.go('#/keys', true));
  await started;
  await page.evaluate(() => {
    Api.AUTH.commit({ access_token: 'access-b', user: { id: 2, email: 'b@example.test' } }, 'b@example.test');
    App.go('#/keys', true);
  });
  releaseStat();
  await page.getByText('B 令牌').waitFor();
  await page.locator('.keycard').getByText('今日请求').waitFor();
  assert.match(await page.locator('.keycard').innerText(), /今日请求\s*30/);
  assert.equal(await page.getByText('A 令牌').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Selectors, keys and model status: groups, dates, time, per-key stats, account races and status mapping passed');
} finally {
  await context.close(); await browser.close();
  await new Promise(resolve => server.close(resolve));
}
