import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createPreviewServer, listenPreview } from '../preview.mjs';

const server = createPreviewServer();
await listenPreview(server);
const base = `http://127.0.0.1:${server.address().port}`;
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
let completionCalls = 0;
let requestGate = null;

async function setup(engine) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  await context.addInitScript(() => {
    localStorage.setItem('pp_api_token', JSON.stringify('fake-access'));
    localStorage.setItem('pp_api_user', JSON.stringify({ id: 1, email: 'test@example.test' }));
    if (!sessionStorage.getItem('workspace_seeded')) {
      sessionStorage.setItem('workspace_seeded', '1');
      const now = Date.now() - 1000;
      localStorage.setItem('pp_api_chat_store_v2:' + encodeURIComponent('email:test@example.test'), JSON.stringify({
        activeId: 'legacy-session',
        sessions: [{
          id: 'legacy-session',
          title: '旧格式对话',
          model: 'demo-model',
          keyId: 1,
          pinned: false,
          settings: { systemPrompt: '', temperature: null, maxTokens: null },
          createdAt: now,
          updatedAt: now,
          messages: [
            { role: 'user', content: '旧格式问题' },
            { role: 'assistant', content: '旧格式回答' }
          ]
        }]
      }));
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__proxy/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/__proxy\/(site|model)/, '');
    if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
    if (path === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [{
      name: '测试',
      models: [{ name: 'demo-model', context_length: 8192 }]
    }] }));
    if (path === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'test@example.test', balance: 3 }));
    if (path === '/api/v1/keys') return route.fulfill(ok({ items: [{
      id: 1, name: '测试令牌', key: 'fake-key', status: 'active'
    }] }));
    if (path === '/v1/models') return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'demo-model', context_length: 16384 }] })
    });
    if (path === '/v1/chat/completions') {
      completionCalls++;
      const payload = route.request().postDataJSON();
      if (payload.stream === false) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            choices: [{ message: { content: '非流式版本' } }],
            usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
          })
        });
      }
      if (requestGate) await requestGate;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先分析问题。' } }] })}`,
          '',
          `data: ${JSON.stringify({ choices: [{ delta: { content: '回答版本 ' + completionCalls } }] })}`,
          '',
          'data: [DONE]',
          ''
        ].join('\n')
      });
    }
    return route.fulfill(ok([]));
  });
  return { browser, context, page, errors };
}

async function openMessageMenu(page, text) {
  const row = page.locator('.bubble-row').filter({ hasText: text }).first();
  await page.locator('.msg-actions[data-message-id="' + await row.getAttribute('data-message-id') + '"]')
    .getByRole('button', { name: '更多消息操作' }).click();
  await page.locator('.sheet').waitFor();
}

try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    completionCalls = 0;
    requestGate = null;
    let releaseStream = null;
    const { browser, context, page, errors } = await setup(engine);
    try {
      await page.goto(base + '/#/chat', { waitUntil: 'domcontentloaded' });
      await page.getByText('旧格式回答').waitFor();

      // Existing messages migrate without losing their order or visible text.
      await page.locator('.composer textarea').fill('第一次提问');
      await page.locator('.send-btn').click();
      await page.getByText('回答版本 1').waitFor();

      // Regenerate keeps the previous answer as a selectable candidate.
      const firstAnswer = page.locator('.bubble-row').filter({ hasText: '回答版本 1' }).first();
      const firstAnswerId = await firstAnswer.getAttribute('data-message-id');
      await page.locator('.msg-actions[data-message-id="' + firstAnswerId + '"]')
        .getByRole('button', { name: '重新生成' }).click();
      await page.getByText('回答版本 2').waitFor();
      assert.match(await page.locator('.message-branches').last().innerText(), /2 \/ 2/);
      await page.locator('.message-branches').last().getByRole('button', { name: '上一个回答' }).click();
      await page.getByText('回答版本 1').waitFor();
      await page.locator('.message-branches').last().getByRole('button', { name: '下一个回答' }).click();
      await page.getByText('回答版本 2').waitFor();

      // Editing a user turn creates a branch without destroying the old one.
      const oldPrompt = page.locator('.bubble-row').filter({ hasText: '第一次提问' }).first();
      const oldPromptId = await oldPrompt.getAttribute('data-message-id');
      await page.locator('.msg-actions[data-message-id="' + oldPromptId + '"]')
        .getByRole('button', { name: '编辑并创建新版本' }).click();
      await page.locator('.sheet textarea').fill('修改后的问题');
      await page.locator('.sheet').getByRole('button', { name: '保存并重新生成' }).click();
      await page.getByText('回答版本 3').waitFor();
      await page.locator('.bubble-row').filter({ hasText: '修改后的问题' }).first()
        .locator('.message-branches').getByRole('button', { name: '上一个回答' }).click();
      await page.getByText('第一次提问').waitFor();

      // Favorites, deletion and non-stream retry are independent of the visual branch switcher.
      await openMessageMenu(page, '第一次提问');
      await page.locator('.sheet').getByText('收藏这条消息').click();
      await page.locator('.bubble.is-favorite').filter({ hasText: '第一次提问' }).waitFor();
      await openMessageMenu(page, '第一次提问');
      await page.locator('.sheet').getByText('取消收藏').click();
      await openMessageMenu(page, '旧格式回答');
      await page.locator('.sheet').getByText('非流式重试').click();
      await page.getByText('非流式版本').waitFor();
      assert.match(await page.locator('.chat-message-meta').last().innerText(), /Tokens 5 \+ 6 = 11/);

      // A draft survives a full reload, not just DOM page caching.
      await page.locator('.composer textarea').fill('重新打开仍保留的草稿');
      await page.waitForTimeout(350);
      await page.reload();
      await page.locator('.composer textarea').waitFor();
      assert.equal(await page.locator('.composer textarea').inputValue(), '重新打开仍保留的草稿');

      // Stop preserves the partial answer and ignores any stale stream callback.
      requestGate = new Promise(resolve => { releaseStream = resolve; });
      await page.locator('.composer textarea').fill('停止测试');
      await page.locator('.send-btn').click();
      await page.getByRole('button', { name: '停止生成' }).waitFor();
      await page.getByRole('button', { name: '停止生成' }).click();
      await page.getByRole('button', { name: '发送消息' }).waitFor();
      releaseStream();
      await page.waitForTimeout(120);
      assert.equal(await page.getByText('回答版本 4').count(), 0);

      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.equal(
          await page.evaluate(() => document.querySelector('#view').scrollWidth),
          await page.evaluate(() => document.querySelector('#view').clientWidth)
        );
        const icons = await page.locator('.chat-toolbar .tool-btn').evaluateAll(nodes => nodes.map(node => {
          const box = node.getBoundingClientRect();
          const icon = node.querySelector('svg').getBoundingClientRect();
          return {
            width: box.width,
            offsetX: Math.abs((icon.left + icon.right) / 2 - (box.left + box.right) / 2),
            offsetY: Math.abs((icon.top + icon.bottom) / 2 - (box.top + box.bottom) / 2)
          };
        }));
        assert.equal(icons.length, 2);
        icons.forEach(icon => {
          assert.ok(icon.width >= 38);
          assert.ok(icon.offsetX < 1.1);
          assert.ok(icon.offsetY < 1.1);
        });
      }
      assert.deepEqual(errors, []);
      console.log(`Chat workspace (${name}): migration, branches, edit, metadata, drafts, stop and layout passed`);
    } finally {
      if (releaseStream) releaseStream();
      await context.close();
      await browser.close();
    }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
