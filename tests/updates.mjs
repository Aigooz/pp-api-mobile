import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPreviewServer } from '../preview.mjs';

const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
  window.updateCalls = { checks: [], downloads: 0, installs: 0, notifications: 0 };
  window.Native = {
    device: () => JSON.stringify({ app: '1.0.0', platform: 'android' }),
    updateCheck: manual => { window.updateCalls.checks.push(manual); },
    updateDownload: () => { window.updateCalls.downloads++; },
    updateInstall: () => { window.updateCalls.installs++; },
    updateResume: () => {},
    updateNotificationState: () => 'disabled',
    updateEnableNotifications: () => { window.updateCalls.notifications++; }
  };
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/__proxy/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { groups: [] } }) }));
try {
  await page.goto(base);
  await page.waitForFunction(() => window.updateCalls.checks.length === 1);
  assert.deepEqual(await page.evaluate(() => updateCalls.checks), [false]);
  await page.evaluate(() => __nativeUpdate('available', JSON.stringify({ version: '1.1.0', notes: '恢复仪表盘\n新增更新通知' })));
  await page.getByRole('button', { name: '查看软件更新' }).click();
  await page.getByText('发现新版本 1.1.0', { exact: true }).waitFor();
  await page.getByText('恢复仪表盘').waitFor();
  await page.getByRole('button', { name: '开启通知' }).click();
  assert.equal(await page.evaluate(() => updateCalls.notifications), 1);
  await page.getByRole('button', { name: '下载更新' }).click();
  assert.equal(await page.evaluate(() => updateCalls.downloads), 1);
  await page.evaluate(() => __nativeUpdate('downloading', JSON.stringify({ version: '1.1.0' })));
  await page.getByText('正在下载新版本').waitFor();
  await page.evaluate(() => __nativeUpdate('available', JSON.stringify({ version: '1.1.0' })));
  await page.getByText('正在下载新版本').waitFor();
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/me');
  await page.getByText('请先登录').first().waitFor();
  await page.getByText('软件更新', { exact: true }).click();
  await page.getByText('正在下载新版本').waitFor();
  await page.evaluate(() => __nativeUpdate('ready', JSON.stringify({ version: '1.1.0' })));
  await page.getByRole('button', { name: '安装更新' }).click();
  assert.equal(await page.evaluate(() => updateCalls.installs), 1);
  await page.evaluate(() => __nativeUpdate('error', JSON.stringify({ message: '安装包校验失败，请重新下载' })));
  await page.getByText('安装包校验失败，请重新下载').waitFor();
  await page.getByRole('button', { name: '重新检查' }).click();
  assert.deepEqual(await page.evaluate(() => updateCalls.checks), [false, true]);
  await page.evaluate(() => __nativeUpdate('current', '{}'));
  await page.getByText('当前已是最新版本').waitFor();
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/me');
  await page.getByText('请先登录').first().waitFor();
  await page.getByText('软件更新', { exact: true }).click();
  await page.getByText('当前版本 1.0.0').waitFor();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.querySelector('#view').scrollWidth), await page.evaluate(() => document.querySelector('#view').clientWidth));
  }
  if (process.env.PP_TEST_SCREENSHOTS) await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/pp-updates.png', animations: 'disabled' });
  assert.deepEqual(errors, []);
  const iosContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await iosContext.addInitScript(() => {
      window.openedUpdateUrl = '';
      window.Native = {
        device: () => JSON.stringify({ app: '1.1.0', platform: 'ios' }),
        open: url => { window.openedUpdateUrl = url; }
      };
    });
    const iosPage = await iosContext.newPage();
    await iosPage.goto(base + '/#/updates');
    await iosPage.getByText('当前版本 1.1.0').waitFor();
    await iosPage.getByText('iOS 安装包需要使用自己的 Apple ID 签名后安装；更新时也需要重新签名。').waitFor();
    await iosPage.getByRole('button', { name: '打开 GitHub 下载页面' }).click();
    assert.equal(await iosPage.evaluate(() => window.openedUpdateUrl), 'https://github.com/Aigooz/pp-api-mobile/releases/latest');
  } finally {
    await iosContext.close();
  }
  console.log('Updates: automatic check, prompt, download, install, failure and guest entry passed');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
