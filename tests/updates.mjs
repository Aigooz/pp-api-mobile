import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPreviewServer } from '../preview.mjs';

const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
  window.updateCalls = { checks: [], downloads: 0, installs: 0, notifications: 0, cancels: 0, polls: 0 };
  window.updateSnapshot = { downloaded: 1572864, total: 8388608, speed: 524288, attempt: 1, state: 'running' };
  window.Native = {
    device: () => JSON.stringify({ app: '1.0.0', platform: 'android' }),
    updateCheck: manual => { window.updateCalls.checks.push(manual); },
    updateDownload: () => { window.updateCalls.downloads++; },
    updateInstall: () => { window.updateCalls.installs++; },
    updateResume: () => {},
    updateProgress: () => { window.updateCalls.polls++; return JSON.stringify(window.updateSnapshot); },
    updateCancel: () => { window.updateCalls.cancels++; },
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
  assert.equal(await page.evaluate(() => document.querySelectorAll('.updates-progress').length), 1);
  await page.waitForFunction(() => document.querySelector('.updates-progress-pct').textContent === '18.8%');
  assert.equal(await page.evaluate(() => document.querySelector('.updates-progress-size').textContent), '1.5 MB / 8.0 MB');
  assert.equal(await page.evaluate(() => document.querySelector('.updates-progress-meta').textContent.includes('512 KB/s')), true);
  await page.getByText('网络较慢时会自动重试并断点续传').waitFor();
  await page.waitForFunction(() => updateCalls.polls >= 2);
  const barWidth = await page.evaluate(() => document.querySelector('.updates-progress .progress > i').style.width);
  assert.equal(barWidth, '18.8%');
  // Progress polling must not rebuild the card, so the bar keeps its node.
  await page.evaluate(() => { window.__barNode = document.querySelector('.updates-progress .progress > i'); });
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.__barNode === document.querySelector('.updates-progress .progress > i')), true);
  await page.getByRole('button', { name: '取消下载' }).click();
  assert.equal(await page.evaluate(() => updateCalls.cancels), 1);
  await page.evaluate(() => { window.updateSnapshot = { downloaded: 8388608, total: 8388608, speed: 0, attempt: 1, state: 'ready' }; });
  await page.waitForFunction(() => document.querySelector('.updates-progress') === null);
  await page.evaluate(() => __nativeUpdate('available', JSON.stringify({ version: '1.1.0' })));
  await page.getByText('下载完成，可以安装').waitFor();
  await page.evaluate(() => __nativeUpdate('downloading', JSON.stringify({ version: '1.1.0' })));
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
  const iosNativeContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await iosNativeContext.addInitScript(() => {
      window.iosCalls = { checks: 0, downloads: 0, installs: 0, cancels: 0 };
      window.iosSnapshot = { downloaded: 0, total: 0, speed: 0, attempt: 1, state: 'idle' };
      window.Native = {
        device: () => JSON.stringify({ app: '1.22.0', platform: 'ios' }),
        open: () => {},
        updateCheck: () => { window.iosCalls.checks++; },
        updateDownload: () => { window.iosCalls.downloads++; },
        updateInstall: () => { window.iosCalls.installs++; },
        updateResume: () => {},
        updateProgress: () => JSON.stringify(window.iosSnapshot),
        updateCancel: () => { window.iosCalls.cancels++; }
      };
    });
    const iosPage = await iosNativeContext.newPage();
    await iosPage.goto(base + '/#/updates');
    await iosPage.getByText('当前版本 1.22.0').waitFor();
    // iOS now owns the updater, so boot performs an automatic check.
    await iosPage.getByText('正在检查更新…').waitFor();
    assert.equal(await iosPage.evaluate(() => iosCalls.checks), 1);
    await iosPage.evaluate(() => __nativeUpdate('available', JSON.stringify({ version: '1.23.0', notes: '下载进度条', size: 4194304 })));
    await iosPage.getByText('发现新版本 1.23.0', { exact: true }).waitFor();
    await iosPage.getByRole('button', { name: '下载更新' }).click();
    assert.equal(await iosPage.evaluate(() => iosCalls.downloads), 1);
    await iosPage.evaluate(() => {
      window.iosSnapshot = { downloaded: 1048576, total: 4194304, speed: 262144, attempt: 1, state: 'running' };
      __nativeUpdate('downloading', JSON.stringify({ version: '1.23.0' }));
    });
    await iosPage.getByText('正在下载新版本').waitFor();
    await iosPage.getByText('iOS 安装包会下载到应用内').waitFor();
    await iosPage.waitForFunction(() => document.querySelector('.updates-progress-pct').textContent === '25.0%');
    // iOS pushes throttled ticks; they must move the bar without a re-render.
    await iosPage.evaluate(() => {
      window.__tickNode = document.querySelector('.updates-progress .progress > i');
      window.iosSnapshot = { downloaded: 2097152, total: 4194304, speed: 524288, attempt: 1, state: 'running' };
      __ppUpdateTick(JSON.stringify(window.iosSnapshot));
    });
    await iosPage.waitForFunction(() => document.querySelector('.updates-progress-pct').textContent === '50.0%');
    assert.equal(await iosPage.evaluate(() => window.__tickNode === document.querySelector('.updates-progress .progress > i')), true);
    await iosPage.getByRole('button', { name: '取消下载' }).click();
    assert.equal(await iosPage.evaluate(() => iosCalls.cancels), 1);
    await iosPage.evaluate(() => __nativeUpdate('ready', JSON.stringify({ version: '1.23.0', size: 4194304 })));
    await iosPage.getByRole('button', { name: '导出安装包' }).click();
    assert.equal(await iosPage.evaluate(() => iosCalls.installs), 1);
    await iosPage.evaluate(() => __nativeUpdate('error', JSON.stringify({ message: '解压失败' })));
    await iosPage.getByText('解压失败').waitFor();
    await iosPage.getByRole('button', { name: '重新检查' }).click();
    assert.equal(await iosPage.evaluate(() => iosCalls.checks), 2);
  } finally {
    await iosNativeContext.close();
  }
  console.log('Updates: automatic check, prompt, download, install, failure and guest entry passed');
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
