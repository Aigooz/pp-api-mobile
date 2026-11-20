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
    await context.addInitScript(() => {
      localStorage.setItem('pp_api_token', JSON.stringify('test-access'));
      localStorage.setItem('pp_api_user', JSON.stringify({ id: 1, email: 'test@example.test' }));
      const handlers = Object.create(null);
      const viewport = {
        height: window.innerHeight,
        offsetTop: 0,
        addEventListener(name, handler) { (handlers[name] || (handlers[name] = [])).push(handler); },
        removeEventListener(name, handler) { handlers[name] = (handlers[name] || []).filter(item => item !== handler); }
      };
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      window.__setTestVisualHeight = height => {
        viewport.height = height;
        (handlers.resize || []).forEach(handler => handler());
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const errors = [];
    const calls = [];
    let delayGroup = false;
    let omitUsage = false;
    let omitContent = false;
    let failRequest = false;
    let anthropicUsage = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__proxy/**', async route => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^\/__proxy\/(site|model)/, '');
      if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
      if (path === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [{
        id: 4, name: '测试分组', models: [
          { name: 'test-alpha', pricing: { billing_mode: 'token', input_price: 1, output_price: 2 } },
          { name: 'test-beta', pricing: { billing_mode: 'token', input_price: 1, output_price: 2 } },
          { name: 'image-model', pricing: { billing_mode: 'image', image_price: 1 } }
        ]
      }] }));
      if (path === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'test@example.test', balance: 10 }));
      if (path === '/api/v1/keys') return route.fulfill(ok({ items: [{ id: 7, name: '测试令牌', key: 'test-key', status: 'active', group_id: 4, group_name: '测试分组' }] }));
      if (path === '/v1/models') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'test-alpha' }, { id: 'test-beta' }] }) });
      if (path === '/v1/chat/completions') {
        const payload = route.request().postDataJSON();
        calls.push(payload);
        if (delayGroup && payload.model === 'test-alpha') await new Promise(resolve => setTimeout(resolve, 450));
        if (failRequest) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'unsupported model for chat' } }) });
        const usage = anthropicUsage ? { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3,
          cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 } } :
          { prompt_tokens: 11, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 }, cache_creation_input_tokens: 1 };
        const events = [
          ...(omitContent ? [] : ['data: {"choices":[{"delta":{"content":"回答 "}}]}\n\n', 'data: {"choices":[{"delta":{"content":"42"}}]}\n\n']),
          ...(omitUsage ? [] : ['data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n']),
          'data: [DONE]\n\n'
        ];
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.join('') });
      }
      return route.fulfill(ok([]));
    });

    await page.goto(base + '/#/chat', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('.chat-toolbar').waitFor();
    await page.getByRole('button', { name: '一键测试' }).click();
    await page.getByText('测试会产生实际费用').waitFor();
    assert.equal(await page.locator('.chat-test-stop').isVisible(), false);
    assert.match(await page.locator('.chat-test-scope-label').innerText(), /整个分组.*2 个请求/);
    assert.equal(await page.locator('.chat-test-model-name').count(), 2);
    assert.equal(calls.length, 0, 'opening the dialog must not make a billable request');

    await page.getByRole('button', { name: '单个模型', exact: true }).click();
    await page.getByRole('button', { name: 'test-beta', exact: true }).click();
    assert.match(await page.locator('.chat-test-scope-label').innerText(), /单个模型.*1 个请求/);
    await page.getByRole('button', { name: '开始测试 1 个模型' }).click();
    assert.equal(calls.length, 0, 'the charge confirmation is required');
    assert.match(await page.locator('.sheet').last().innerText(), /1 次真实调用/);
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.getByText('测试完成 · 1/1 个模型').waitFor();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'test-beta');
    assert.equal(calls[0].max_tokens, 64);
    assert.equal(calls[0].stream_options.include_usage, true);
    const result = page.locator('.chat-test-result');
    await result.waitFor();
    assert.equal(await result.locator('.chat-test-metrics > div').nth(0).innerText(), '输入 Token\n11');
    assert.equal(await result.locator('.chat-test-metrics > div').nth(1).innerText(), '输出 Token\n2');
    assert.equal(await result.locator('.chat-test-metrics > div').nth(2).innerText(), '缓存读取\n3');
    assert.equal(await result.locator('.chat-test-metrics > div').nth(3).innerText(), '缓存写入\n1');
    assert.match(await result.innerText(), /首次输出 · 客户端[\s\S]*总耗时 · 客户端/);
    assert.match(await result.innerText(), /回答 42/);
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      const overflow = await result.evaluate(node => node.scrollWidth > node.clientWidth + 1);
      assert.equal(overflow, false, `result must fit ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    if (process.env.PP_TEST_SCREENSHOTS) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(process.env.PP_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/one-click-result-' + name + '.png', animations: 'disabled' });
    }

    await page.locator('.sheet').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByLabel('输入消息').focus();
    await page.setViewportSize({ width: 390, height: 520 });
    await page.waitForFunction(() => document.body.classList.contains('kb-open'));
    assert.equal(await page.locator('.tabbar').evaluate(node => getComputedStyle(node).display), 'none');
    const composer = await page.locator('.composer').evaluate(node => {
      const box = node.getBoundingClientRect();
      return { bottom: box.bottom, gap: innerHeight - box.bottom };
    });
    assert.ok(composer.gap >= 0 && composer.gap < 20, `${name} composer gap ${JSON.stringify(composer)}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.body.classList.contains('kb-open'));
    assert.notEqual(await page.locator('.tabbar').evaluate(node => getComputedStyle(node).display), 'none');
    await page.evaluate(() => window.__applyKeyboard({ visible: true, overlap: 0 }));
    assert.equal(await page.locator('.tabbar').evaluate(node => getComputedStyle(node).display), 'none', 'native resized IME must hide navigation');
    assert.ok(await page.locator('.composer').evaluate(node => innerHeight - node.getBoundingClientRect().bottom < 20));
    await page.evaluate(() => window.__applyKeyboard({ visible: true, overlap: 300 }));
    assert.equal(await page.locator('.composer').evaluate(node => Math.round(innerHeight - node.getBoundingClientRect().bottom)), 308);
    await page.evaluate(() => { window.__applyKeyboard({ visible: false, overlap: 0 }); window.__applyKeyboard(null); });
    await page.evaluate(() => window.__setTestVisualHeight(520));
    await page.waitForFunction(() => document.body.classList.contains('kb-open'));
    const overlayComposer = await page.locator('.composer').evaluate(node => {
      const box = node.getBoundingClientRect();
      return { bottom: box.bottom, gap: visualViewport.height - box.bottom };
    });
    assert.ok(overlayComposer.gap >= 0 && overlayComposer.gap < 20, `${name} overlay composer gap ${JSON.stringify(overlayComposer)}`);
    assert.equal(await page.locator('.tabbar').evaluate(node => getComputedStyle(node).display), 'none');
    await page.evaluate(() => { window.__setTestVisualHeight(844); document.activeElement.blur(); });
    await page.waitForFunction(() => !document.body.classList.contains('kb-open'));
    assert.notEqual(await page.locator('.tabbar').evaluate(node => getComputedStyle(node).display), 'none');

    await page.locator('.chat-test-trigger').click();
    await page.getByText('测试会产生实际费用').waitFor();
    await page.getByRole('button', { name: '开始测试 2 个模型' }).click();
    await page.locator('.sheet').last().getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(calls.length, 1, 'declining confirmation must leave request count unchanged');

    delayGroup = true;
    await page.getByRole('button', { name: '开始测试 2 个模型' }).click();
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.getByText('正在测试 1/2 · test-alpha').waitFor();
    await page.getByRole('button', { name: '停止当前及后续测试' }).click();
    await page.getByText(/测试已停止，未开始的模型不会发送请求/).waitFor();
    assert.equal(calls.length, 2, 'stop must not send the remaining group model');
    await page.getByRole('button', { name: '单个模型', exact: true }).click();
    await page.locator('.chat-test-model').filter({ hasText: 'test-alpha' }).click();
    omitUsage = true;
    omitContent = true;
    await page.getByRole('button', { name: '开始测试 1 个模型' }).click();
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.getByText('测试完成 · 1/1 个模型').waitFor();
    assert.equal(calls.length, 3);
    assert.equal(await page.locator('.chat-test-result').last().locator('.chat-test-metrics > div').nth(0).innerText(), '输入 Token\n—');
    assert.equal(await page.locator('.chat-test-result').last().locator('.chat-test-metrics > div').nth(5).innerText(), '首次输出 · 客户端\n—');
    assert.equal(await page.locator('.chat-test-result').last().locator('.badge').innerText(), '无文本输出');

    omitUsage = false; omitContent = false; anthropicUsage = true; delayGroup = false;
    await page.getByRole('button', { name: '开始测试 1 个模型' }).click();
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.getByText('测试完成 · 1/1 个模型').waitFor();
    assert.equal(calls.length, 4);
    assert.equal(await page.locator('.chat-test-result .chat-test-metrics > div').nth(3).innerText(), '缓存写入\n3');
    assert.equal(await page.locator('.chat-test-result .chat-test-metrics > div').nth(4).innerText(), 'Token 合计\n18');

    failRequest = true;
    await page.getByRole('button', { name: '开始测试 1 个模型' }).click();
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.getByText('测试完成 · 1/1 个模型').waitFor();
    assert.equal(calls.length, 5, 'a failed paid request must not retry');
    assert.equal(await page.locator('.chat-test-result .badge').innerText(), '失败');

    failRequest = false; delayGroup = true;
    await page.getByRole('button', { name: '整个分组', exact: true }).click();
    await page.getByRole('button', { name: '开始测试 2 个模型' }).click();
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.getByText('正在测试 1/2 · test-alpha').waitFor();
    await page.evaluate(() => App.go('#/me'));
    await page.waitForFunction(() => location.hash === '#/me' && !document.querySelector('.chat-test-panel'));
    await page.evaluate(() => App.go('#/chat'));
    await page.getByRole('button', { name: '一键测试' }).click();
    await page.waitForTimeout(650);
    assert.equal(calls.length, 6, 'navigating away must abort the batch without more calls');
    assert.equal(await page.locator('.chat-test-result').count(), 0, 'old results must not leak into a reopened dialog');
    if (process.env.PP_TEST_SCREENSHOTS) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(process.env.PP_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/one-click-' + name + '.png', animations: 'disabled' });
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${name}: keyboard layout, charge consent, model scope, live usage and stop behavior passed`);
  } finally { await browser.close(); }
}

try {
  await run(chromium, 'Chromium');
  await run(webkit, 'WebKit');
} finally { await new Promise(resolve => server.close(resolve)); }
