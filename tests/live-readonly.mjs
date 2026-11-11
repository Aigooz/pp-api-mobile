import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPreviewServer } from '../preview.mjs';

const email = process.env.PP_TEST_EMAIL;
const password = process.env.PP_TEST_PASSWORD;
if (!email || !password) throw new Error('Set PP_TEST_EMAIL and PP_TEST_PASSWORD before running.');
const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(base);
  await page.locator('.model-row').first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('账户余额').waitFor({ timeout: 30000 });
  await page.getByText('API 令牌', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByText('今日请求').waitFor({ timeout: 30000 });
  await page.getByText('今日 Tokens').waitFor({ timeout: 30000 });
  await page.getByText('平均响应').waitFor({ timeout: 30000 });
  await page.getByText('Token 使用趋势').waitFor({ timeout: 30000 });
  await page.getByText('模型分布').waitFor({ timeout: 30000 });
  await page.getByText('最近调用').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.locator('.plaza-group').first().waitFor({ timeout: 30000 });
  await page.getByText('官方价').first().waitFor();
  await page.getByText('缓存读取').first().waitFor();
  await page.getByRole('button', { name: '渠道状态' }).click();
  await page.locator('.channel-item').first().waitFor({ timeout: 30000 });
  await page.getByText('平均可用率').waitFor();
  await page.getByRole('button', { name: '刷新渠道状态' }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="刷新渠道状态"]').disabled);
  assert.ok(await page.locator('.channel-timeline').count());
  await page.getByRole('navigation').getByRole('button', { name: '令牌', exact: true }).click();
  await page.getByRole('button', { name: '新建' }).waitFor({ timeout: 30000 });
  await page.waitForFunction(() => {
    const text = document.querySelector('#view').textContent;
    return text.includes('还没有令牌') || text.includes('Base URL') || text.includes('加载失败');
  }, null, { timeout: 30000 });
  assert.equal(await page.getByText('加载失败', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByText('用量明细').click();
  await page.getByText('输入 tokens').waitFor({ timeout: 30000 });
  await page.goto(base + '/#/announcements');
  await page.locator('#view .list-item').first().waitFor({ timeout: 30000 });
  assert.deepEqual(errors, []);
  console.log('Live account: dashboard, plaza pricing, login, keys, usage and announcements passed');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
