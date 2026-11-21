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
    let requestGate = null;
    let releaseRequests = null;
    let noKeys = false;
    let expandedGroup = false;
    const expandedModels = Array.from({ length: 12 }, (_, index) => 'parallel-model-' + (index + 1));
    const holdRequests = () => { requestGate = new Promise(resolve => { releaseRequests = resolve; }); };
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__proxy/**', async route => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^\/__proxy\/(site|model)/, '');
      if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
      if (path === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [{
        id: 4, name: '测试分组', models: expandedGroup ? expandedModels.map(name => ({
          name, pricing: { billing_mode: 'token', input_price: 1, output_price: 2 }
        })) : [
          { name: 'test-alpha', pricing: { billing_mode: 'token', input_price: 1, output_price: 2 } },
          { name: 'test-beta', pricing: { billing_mode: 'token', input_price: 1, output_price: 2 } },
          { name: 'image-model', pricing: { billing_mode: 'image', image_price: 1 } }
        ]
      }] }));
      if (path === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'test@example.test', balance: 10 }));
      if (path === '/api/v1/keys') return route.fulfill(ok({ items: noKeys ? [] : [{ id: 7, name: '测试令牌', key: 'test-key', status: 'active', group_id: 4, group_name: '测试分组' }] }));
      if (path === '/v1/models') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: (expandedGroup ? expandedModels : ['test-alpha', 'test-beta']).map(id => ({ id })) }) });
      if (path === '/v1/chat/completions') {
        const payload = route.request().postDataJSON();
        calls.push(payload);
        if (requestGate) await requestGate;
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

    holdRequests();
    await page.getByRole('button', { name: '开始测试 2 个模型' }).click();
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.waitForFunction(() => PagesChatTests.current()?.items.filter(item => item.state === 'running').length === 2);
    await page.waitForTimeout(100);
    assert.equal(calls.length, 3, 'both models must start before either response finishes');
    assert.equal(await page.locator('.chat-test-trigger').getAttribute('data-test-state'), 'running');
    const redDot = await page.locator('.chat-test-trigger').evaluate(node => ({
      dot: getComputedStyle(node, '::after').backgroundColor,
      red: getComputedStyle(node).getPropertyValue('--danger').trim(),
      top: getComputedStyle(node, '::after').top,
      right: getComputedStyle(node, '::after').right
    }));
    assert.notEqual(redDot.dot, 'rgba(0, 0, 0, 0)');
    assert.equal(redDot.top, '-3px'); assert.equal(redDot.right, '-3px');
    await page.getByRole('button', { name: '停止测试', exact: true }).click();
    await page.getByText(/测试已停止 · 2\/2/).waitFor();
    assert.equal(calls.length, 3, 'stop must not retry any model');
    releaseRequests(); requestGate = null;
    await page.getByRole('button', { name: '单个模型', exact: true }).click();
    await page.locator('.chat-test-model').filter({ hasText: 'test-alpha' }).click();
    omitUsage = true;
    omitContent = true;
    await page.getByRole('button', { name: '开始测试 1 个模型' }).click();
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.getByText('测试完成 · 1/1 个模型').waitFor();
    assert.equal(calls.length, 4);
    assert.equal(await page.locator('.chat-test-result').last().locator('.chat-test-metrics > div').nth(0).innerText(), '输入 Token\n—');
    assert.equal(await page.locator('.chat-test-result').last().locator('.chat-test-metrics > div').nth(5).innerText(), '首次输出 · 客户端\n—');
    assert.equal(await page.locator('.chat-test-result').last().locator('.badge').innerText(), '无文本输出');

    omitUsage = false; omitContent = false; anthropicUsage = true; delayGroup = false;
    await page.getByRole('button', { name: '开始测试 1 个模型' }).click();
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.getByText('测试完成 · 1/1 个模型').waitFor();
    assert.equal(calls.length, 5);
    assert.equal(await page.locator('.chat-test-result .chat-test-metrics > div').nth(3).innerText(), '缓存写入\n3');
    assert.equal(await page.locator('.chat-test-result .chat-test-metrics > div').nth(4).innerText(), 'Token 合计\n18');

    failRequest = true;
    await page.getByRole('button', { name: '开始测试 1 个模型' }).click();
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.getByText('测试完成 · 1/1 个模型').waitFor();
    assert.equal(calls.length, 6, 'a failed paid request must not retry');
    assert.equal(await page.locator('.chat-test-result .badge').innerText(), '失败');

    failRequest = false; holdRequests();
    await page.getByRole('button', { name: '整个分组', exact: true }).click();
    await page.getByRole('button', { name: '开始测试 2 个模型' }).click();
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.getByText(/正在并行测试 · 0\/2/).waitFor();
    await page.waitForTimeout(100);
    assert.equal(calls.length, 8);
    await page.locator('.sheet').getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await page.evaluate(() => PagesChatTests.current().running), true, 'closing the sheet must not stop tests');
    await page.getByRole('button', { name: '一键测试', exact: true }).click();
    assert.equal(await page.locator('.chat-test-result').count(), 2);
    await page.evaluate(() => App.go('#/me'));
    await page.waitForFunction(() => location.hash === '#/me' && !document.querySelector('.chat-test-panel'));
    assert.equal(await page.evaluate(() => PagesChatTests.current().running), true, 'navigation must not stop tests');
    await page.evaluate(() => { App.invalidatePages(); App.go('#/chat'); });
    await page.waitForFunction(() => document.querySelector('.chat-test-trigger')?.getAttribute('data-test-state') === 'running');
    await page.getByRole('button', { name: '一键测试' }).click();
    assert.equal(await page.locator('.chat-test-result').count(), 2, 'a rebuilt chat page must recover the same task');
    releaseRequests(); requestGate = null;
    await page.getByText('测试完成 · 2/2 个模型').waitFor();
    await page.waitForFunction(() => document.querySelector('.chat-test-trigger').getAttribute('data-test-state') === 'complete');
    assert.equal(calls.length, 8, 'returning must not duplicate charged requests');
    for (const article of await page.locator('.chat-test-result').all()) {
      assert.doesNotMatch(await article.locator('.chat-test-metrics > div').nth(5).innerText(), /—/);
      assert.doesNotMatch(await article.locator('.chat-test-metrics > div').nth(6).innerText(), /—/);
    }
    await page.locator('.sheet').getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => App.go('#/home'));
    await page.waitForFunction(() => location.hash === '#/home');
    await page.evaluate(() => App.go('#/chat'));
    await page.getByRole('button', { name: '一键测试' }).click();
    await page.getByText('测试完成 · 2/2 个模型').waitFor();
    await page.locator('.sheet').getByRole('button', { name: '关闭', exact: true }).click();

    expandedGroup = true;
    await page.evaluate(names => {
      S.plaza = { groups: [{ id: 4, name: '测试分组', models: names.map(name => ({
        name, pricing: { billing_mode: 'token', input_price: 1, output_price: 2 }
      })) }] };
    }, expandedModels);
    await page.getByRole('button', { name: '一键测试' }).click();
    await page.getByRole('button', { name: '开始测试 12 个模型' }).waitFor();
    const beforeFullGroup = calls.length;
    holdRequests();
    await page.getByRole('button', { name: '开始测试 12 个模型' }).click();
    assert.match(await page.locator('.sheet').last().innerText(), /12 次真实调用，全部同时发起，不分批排队/);
    assert.equal(calls.length, beforeFullGroup, 'all-model testing still requires cost consent');
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.waitForFunction(() => {
      const batch = PagesChatTests.current();
      return batch?.items.length === 12 && batch.items.every(item => item.state === 'running');
    });
    await page.waitForFunction(() => document.querySelectorAll('.chat-test-result').length === 12);
    const dispatchDeadline = Date.now() + 15000;
    while (calls.length < beforeFullGroup + 12 && Date.now() < dispatchDeadline) await page.waitForTimeout(50);
    assert.equal(calls.length, beforeFullGroup + 12, 'all 12 requests must reach the transport before ANY response is released');
    assert.deepEqual(calls.slice(beforeFullGroup).map(call => call.model).sort(), expandedModels.slice().sort());
    assert.equal(await page.evaluate(() => PagesChatTests.current().completed), 0);
    assert.equal(await page.evaluate(() => PagesChatTests.current().parallel), 12);
    assert.match(await page.locator('.chat-test-progress').innerText(), /全部同时发起/);
    assert.equal(await page.evaluate(() => PagesChatTests.start({ key: S.keys[0], models: ['duplicate'] })), null, 'a running batch must not be submitted twice');
    await page.locator('.sheet').getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => App.go('#/me'));
    await page.waitForFunction(() => location.hash === '#/me');
    assert.equal(await page.evaluate(() => PagesChatTests.current().running), true);
    await page.evaluate(() => { App.invalidatePages(); App.go('#/chat'); });
    await page.waitForFunction(() => document.querySelector('.chat-test-trigger')?.getAttribute('data-test-state') === 'running');
    await page.getByRole('button', { name: '一键测试' }).click();
    assert.equal(await page.locator('.chat-test-result').count(), 12);
    releaseRequests(); requestGate = null;
    await page.getByText('测试完成 · 12/12 个模型').waitFor();
    for (const article of await page.locator('.chat-test-result').all()) {
      assert.equal(await article.locator('.badge').innerText(), '完成');
      assert.doesNotMatch(await article.locator('.chat-test-metrics > div').nth(5).innerText(), /—/);
      assert.doesNotMatch(await article.locator('.chat-test-metrics > div').nth(6).innerText(), /—/);
    }
    assert.equal(calls.length, beforeFullGroup + 12, 'navigation must not duplicate any of the 12 calls');
    assert.equal(await page.locator('.chat-test-trigger').getAttribute('data-test-state'), 'complete');
    holdRequests();
    await page.getByRole('button', { name: '开始测试 12 个模型' }).click();
    await page.locator('.sheet').last().getByRole('button', { name: '确认并测试' }).click();
    await page.waitForFunction(() => PagesChatTests.current()?.items.every(item => item.state === 'running'));
    await page.getByRole('button', { name: '停止测试', exact: true }).click();
    await page.getByText('测试已停止 · 12/12 个模型').waitFor();
    assert.equal(await page.evaluate(() => PagesChatTests.current().items.every(item => item.cancelled)), true);
    releaseRequests(); requestGate = null;
    await page.locator('.sheet').getByRole('button', { name: '关闭', exact: true }).click();
    noKeys = true;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('pp:keys-updated', {
      detail: { account: Api.AUTH.currentId(), items: [] }
    })));
    await page.getByRole('button', { name: '创建我的第一个令牌' }).waitFor();
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const layout = await page.evaluate(() => {
        const welcome = document.querySelector('.chat-welcome');
        const action = document.querySelector('.chat-welcome-actions');
        const children = Array.from(welcome.children).map(node => {
          const rect = node.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width };
        });
        const toolbar = document.querySelector('.chat-toolbar');
        const toolbarRect = toolbar.getBoundingClientRect();
        const controls = Array.from(toolbar.children).map(node => {
          const rect = node.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width };
        });
        return {
          viewportWidth: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          textAdjust: getComputedStyle(document.documentElement).getPropertyValue('-webkit-text-size-adjust') ||
            getComputedStyle(document.documentElement).getPropertyValue('text-size-adjust'),
          actionInsideWelcome: welcome.contains(action),
          children,
          controls,
          toolbar: { left: toolbarRect.left, right: toolbarRect.right }
        };
      });
      assert.equal(layout.documentWidth, width, JSON.stringify(layout));
      assert.ok(layout.textAdjust === '' || layout.textAdjust === '100%', JSON.stringify(layout));
      assert.equal(layout.actionInsideWelcome, true);
      for (let index = 1; index < layout.children.length; index++) {
        assert.ok(layout.children[index - 1].bottom <= layout.children[index].top + 1, `welcome copy overlaps at ${width}px: ${JSON.stringify(layout)}`);
      }
      assert.ok(layout.controls.every(control => control.left >= layout.toolbar.left - 1 && control.right <= layout.toolbar.right + 1), `chat toolbar overflows at ${width}px: ${JSON.stringify(layout)}`);
      for (let index = 1; index < layout.controls.length; index++) {
        assert.ok(layout.controls[index - 1].right <= layout.controls[index].left + 1, `chat controls overlap at ${width}px: ${JSON.stringify(layout)}`);
      }
      if (process.env.PP_TEST_SCREENSHOTS && width === 390) {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(process.env.PP_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/empty-chat-' + name + '.png', animations: 'disabled' });
      }
    }
    if (process.env.PP_TEST_SCREENSHOTS) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(process.env.PP_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: process.env.PP_TEST_SCREENSHOTS + '/one-click-' + name + '.png', animations: 'disabled' });
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${name}: keyboard, consent, all 12 concurrent requests, cross-page task recovery, timing, usage and stop passed`);
  } finally { await browser.close(); }
}

try {
  await run(chromium, 'Chromium');
  await run(webkit, 'WebKit');
} finally { await new Promise(resolve => server.close(resolve)); }
