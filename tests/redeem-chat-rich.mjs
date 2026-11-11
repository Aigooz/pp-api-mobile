import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createPreviewServer } from '../preview.mjs';

const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
const reply = [
  '# 矩阵与公式',
  '',
  String.raw`行内公式 \(A^T\) 和 $x^2$。`,
  String.raw`同段公式 \[a+b=c\] 与未闭合 \(x`,
  String.raw`长公式 \(` + 'x+'.repeat(80) + String.raw`x\)`,
  '',
  String.raw`\[A^TA=I\]`,
  '',
  '$$E=mc^2$$',
  '',
  '```tex',
  '$not_math$ <script>bad()</script>',
  '```',
  '',
  '<img src=x onerror="window.pwned=1">',
  '[危险链接](javascript:alert(1)) [安全链接](https://example.test/path)',
  '![远程图片](https://example.test/secret.png)'
].join('\n');
const records = [
  { code: 'LONG-SUBSCRIPTION-CODE-1234567890', type: 'subscription', value: 1, validity_days: 1,
    group: { name: '日卡', description: '24 小时 DeepSeek 使用权', subscription_type: 'subscription' } },
  { code: 'BALANCE-OLD', type: 'balance', value: 4.5 },
  { code: 'UNKNOWN-OLD', value: 1 }
];
let releaseRedeem;
let redeemStarted;
let redeemCalls = 0;
let capturedPayload;

async function setup(engine) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    localStorage.setItem('pp_api_token', JSON.stringify('fake-access'));
    localStorage.setItem('pp_api_user', JSON.stringify({ id: 1, email: 'test@example.test' }));
  });
  const page = await context.newPage();
  const errors = [];
  const remoteRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith('https://example.test/')) remoteRequests.push(request.url()); });
  await page.route('**/__proxy/**', async route => {
    const p = new URL(route.request().url()).pathname.replace(/^\/__proxy\/(site|model)/, '');
    if (p === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
    if (p === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [{ name: '测试', models: [
      { name: 'demo-model', context_length: 8192 }, { name: 'no-limit-model' }
    ] }] }));
    if (p === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'test@example.test', balance: 3 }));
    if (p === '/api/v1/keys') return route.fulfill(ok({ items: [{ id: 1, name: '测试令牌', key: 'fake-key', status: 'active' }] }));
    if (p === '/v1/models') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [
      { id: 'demo-model', context_length: 16384 }, { id: 'no-limit-model' }
    ] }) });
    if (p === '/v1/chat/completions') {
      capturedPayload = route.request().postDataJSON();
      const event = JSON.stringify({ choices: [{ delta: { content: reply } }] });
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${event}\n\ndata: [DONE]\n\n` });
    }
    if (p === '/api/v1/redeem/history') return route.fulfill(ok(records));
    if (p === '/api/v1/redeem') {
      redeemCalls++;
      const code = route.request().postDataJSON().code;
      if (code === 'WAIT') {
        redeemStarted?.();
        await new Promise(resolve => { releaseRedeem = resolve; });
        return route.fulfill(ok({ type: 'balance', value: 99 }));
      }
      if (code === 'FAIL') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'ERROR', message: '兑换码无效' }) });
      if (code === 'SUB-NEW') {
        records.unshift({ code, type: 'subscription', value: 1, validity_days: 1,
          group: { name: 'DeepSeek 日卡', description: '24 小时有效', subscription_type: 'subscription' } });
        return route.fulfill(ok({ value: 1 }));
      }
      if (code === 'BAL-NEW') return route.fulfill(ok({ type: 'balance', value: 2 }));
      return route.fulfill(ok({ value: 5 }));
    }
    return route.fulfill(ok([]));
  });
  return { browser, context, page, errors, remoteRequests };
}

async function tokenRows(page) {
  await page.getByRole('button', { name: '查看 Token 使用量估算' }).click();
  const rows = await page.locator('.token-row').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.firstElementChild.textContent, node.lastElementChild.textContent])));
  await page.locator('.sheet').getByRole('button', { name: '关闭' }).click();
  return rows;
}

try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const { browser, context, page, errors, remoteRequests } = await setup(engine);
    try {
      await page.goto(base + '/#/chat');
      await page.locator('.chat-toolbar .chip').first().getByText('demo-model').waitFor();
      await page.locator('.composer-meta').getByText('令牌 测试令牌').waitFor();
      await page.waitForFunction(() => document.querySelector('.token-estimate-btn'));
      let values = await tokenRows(page);
      assert.equal(values['上下文消息数'], '0');
      assert.equal(values['模型限制'], '16,384');
      await page.getByRole('button', { name: '对话设置' }).click();
      await page.locator('.sheet textarea').fill('system prompt');
      await page.locator('.sheet').getByRole('button', { name: '保存' }).click();
      await page.locator('.composer textarea').fill('你好');
      values = await tokenRows(page);
      assert.equal(values['当前输入'], '约 7');
      assert.equal(values['上下文'], '约 8');
      assert.equal(values['上下文消息数'], '1');
      assert.equal(values['总计'], '约 15');
      await page.getByRole('button', { name: '发送消息' }).click();
      await page.locator('.markdown-body h1').waitFor();
      assert.deepEqual(capturedPayload.messages, [{ role: 'system', content: 'system prompt' }, { role: 'user', content: '你好' }]);
      assert.equal(await page.locator('.markdown-body .katex').count(), 6);
      assert.match(await page.locator('.markdown-body').innerText(), /未闭合 \\\u0028x/);
      assert.equal(await page.locator('.chat-code pre code').innerText(), '$not_math$ <script>bad()</script>\n');
      assert.equal(await page.locator('.chat-code .katex').count(), 0);
      assert.equal(await page.locator('.markdown-body img').count(), 0);
      assert.equal(await page.locator('.markdown-body script').count(), 0);
      assert.equal(await page.locator('.markdown-body a').count(), 1);
      assert.equal(await page.evaluate(() => window.pwned), undefined);
      assert.deepEqual(remoteRequests, []);
      values = await tokenRows(page);
      assert.equal(values['当前输入'], '约 0');
      assert.equal(values['上下文消息数'], '3');
      await page.locator('.chat-toolbar .chip').first().click();
      await page.locator('.sheet .list-item').filter({ hasText: 'no-limit-model' }).click();
      values = await tokenRows(page);
      assert.equal(values['模型限制'], '未知');
      await page.reload();
      await page.locator('.markdown-body h1').waitFor();
      assert.equal(await page.locator('.markdown-body .katex').count(), 6);
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        for (const theme of ['light', 'dark']) {
          await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
          assert.equal(await page.evaluate(() => document.querySelector('#view').scrollWidth), await page.evaluate(() => document.querySelector('#view').clientWidth));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
          const geometry = await page.locator('.composer-footer').evaluate(el => {
            const footer = el.getBoundingClientRect(), info = el.querySelector('.composer-meta').getBoundingClientRect(), button = el.querySelector('button').getBoundingClientRect();
            return { footer: footer.right, info: info.right, button: button.left, buttonRight: button.right };
          });
          assert.ok(geometry.info <= geometry.button && geometry.buttonRight <= geometry.footer + 1);
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      if (process.env.PP_TEST_SCREENSHOTS) await page.screenshot({ path: `${process.env.PP_TEST_SCREENSHOTS}/chat-${name}.png`, animations: 'disabled' });
      await page.evaluate(() => {
        window.testStreams = [];
        Api.chatStream = (payload, key, handlers) => {
          window.testStreams.push(handlers);
          return { abort() {} };
        };
      });
      await page.locator('.composer textarea').fill('first request');
      await page.getByRole('button', { name: '发送消息' }).click();
      await page.waitForFunction(() => window.testStreams.length === 1);
      await page.evaluate(() => window.testStreams[0].onEvent({ choices: [{ delta: { content: '部分回答' } }] }));
      await page.getByRole('button', { name: '停止生成' }).click();
      await page.getByRole('button', { name: '发送消息' }).waitFor();
      await page.locator('.composer textarea').fill('second request');
      await page.getByRole('button', { name: '发送消息' }).click();
      await page.waitForFunction(() => window.testStreams.length === 2);
      await page.evaluate(() => {
        window.testStreams[0].onEvent({ choices: [{ delta: { content: '旧请求污染' } }] });
        window.testStreams[0].onDone();
        window.testStreams[1].onEvent({ choices: [{ delta: { content: '新请求完成' } }] });
        window.testStreams[1].onDone();
      });
      await page.getByText('新请求完成').waitFor();
      assert.equal(await page.getByText('旧请求污染').count(), 0);
      await page.getByRole('button', { name: '发送消息' }).waitFor();
      assert.deepEqual(errors, []);
      console.log(`Rich chat (${name}): Markdown, math, safety, history, estimates and layout passed`);
    } finally { await context.close(); await browser.close(); }
  }

  const { browser, context, page, errors } = await setup(chromium);
  try {
    await page.goto(base + '/#/redeem');
    await page.getByText('24 小时 DeepSeek 使用权').waitFor();
    const history = page.locator('.redeem-history-item');
    assert.match(await history.nth(0).innerText(), /日卡[\s\S]*有效期 1 天/);
    assert.doesNotMatch(await history.nth(0).innerText(), /\$1/);
    assert.match(await history.nth(1).innerText(), /余额[\s\S]*\+\$4\.50/);
    assert.doesNotMatch(await history.nth(2).innerText(), /\$/);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.querySelector('#view').scrollWidth), await page.evaluate(() => document.querySelector('#view').clientWidth));
    }
    const input = page.locator('input[placeholder^="输入兑换码"]');
    const button = page.getByRole('button', { name: '立即兑换' });
    await input.fill('SUB-NEW');
    await button.click();
    await page.locator('.redeem-result').getByText('兑换成功 · DeepSeek 日卡').waitFor();
    assert.match(await page.locator('.redeem-result').innerText(), /有效期 1 天/);
    assert.doesNotMatch(await page.locator('.redeem-result').innerText(), /\$/);
    await input.fill('BAL-NEW');
    await button.click();
    await page.locator('.redeem-result').getByText('+$2').waitFor();
    await input.fill('UNKNOWN');
    await button.click();
    await page.locator('.redeem-result').getByText('兑换成功', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('.redeem-result').innerText(), /\$/);
    await input.fill('FAIL');
    await button.click();
    await page.getByText('兑换码无效').waitFor();
    assert.equal(await input.inputValue(), 'FAIL');
    const started = new Promise(resolve => { redeemStarted = resolve; });
    await input.fill('WAIT');
    await button.click();
    await started;
    assert.equal(await page.getByRole('button', { name: '兑换中…' }).isDisabled(), true);
    const before = redeemCalls;
    await page.evaluate(() => document.querySelector('.page .btn-primary').click());
    assert.equal(redeemCalls, before);
    await page.evaluate(() => Api.AUTH.commit({ access_token: 'other', user: { id: 2, email: 'other@example.test' } }, 'other@example.test'));
    releaseRedeem();
    await page.waitForTimeout(100);
    assert.equal(await page.getByText('+$99').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Redeem: subscription, balance, unknown type, failure, duplicate and account race passed');
  } finally { if (releaseRedeem) releaseRedeem(); await context.close(); await browser.close(); }
} finally {
  await new Promise(resolve => server.close(resolve));
}
