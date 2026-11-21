import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { createPreviewServer, listenPreview } from '../preview.mjs';

const server = createPreviewServer();
await listenPreview(server);
const base = `http://127.0.0.1:${server.address().port}`;
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
let completionCalls = 0;
let requestGate = null;
const screenshotDir = process.env.PP_TEST_SCREENSHOTS;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const longModel = 'gpt-image-' + 'long-model-name-'.repeat(8);

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
        }, {
          id: 'long-title-session',
          title: '这是一条用于检查窄屏和操作按钮布局的很长很长的历史对话标题',
          model: 'demo-model', keyId: 1,
          createdAt: now - 1000, updatedAt: now - 1000, messages: []
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
    if (path === '/api/v1/keys') return route.fulfill(ok({ items: [
      { id: 1, name: '测试令牌', key: 'fake-key', status: 'active' },
      { id: 2, name: '这是一个非常长的令牌名称用于测试布局', key: 'sk-012345678901234567890123456789', status: 'active' },
      { id: 3, name: 'long-disabled-token-name-'.repeat(6), key: 'sk-disabled', status: 'disabled' },
      ...Array.from({ length: 12 }, (_, i) => ({ id: i + 4, name: '其他令牌 ' + (i + 1), key: 'sk-other-' + i, status: 'active' }))
    ] }));
    if (path === '/v1/models') return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'demo-model', context_length: 16384 }, { id: longModel }] })
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

async function checkPickerLayout(page, selector, label) {
  const layout = await page.locator(selector).evaluate(host => {
    const rect = node => node && node.getBoundingClientRect();
    return {
      horizontalOverflow: host.scrollWidth > host.clientWidth,
      rows: Array.from(host.querySelectorAll('.list-item')).map(row => {
        const box = rect(row);
        const body = rect(row.querySelector('.li-body'));
        const icon = row.querySelector('.li-icon');
        const iconBox = rect(icon);
        const svg = rect(icon.querySelector('svg'));
        const tail = row.querySelector('.badge, .li-tail');
        const tailBox = rect(tail);
        const badge = rect(row.querySelector('.badge'));
        const columns = Array.from(row.children).map(rect);
        return {
          left: box.left, right: box.right, width: box.width, height: box.height,
          hostWidth: host.clientWidth,
          bodyRight: body.right,
          tailLeft: tailBox && tailBox.left,
          tailRight: tailBox && tailBox.right,
          titleOverflow: row.querySelector('.li-title').scrollWidth > row.querySelector('.li-title').clientWidth,
          titleEllipsis: getComputedStyle(row.querySelector('.li-title')).textOverflow === 'ellipsis',
          columnsOverlap: columns.some((column, index) => columns.slice(0, index).some(other =>
            Math.min(column.right, other.right) - Math.max(column.left, other.left) > 1 &&
            Math.min(column.bottom, other.bottom) - Math.max(column.top, other.top) > 1)),
          columnsOutside: columns.some(column => column.left < box.left || column.right > box.right + 1),
          stacked: getComputedStyle(row).display === 'grid',
          badgeOffsetY: badge && Math.abs((badge.top + badge.bottom - iconBox.top - iconBox.bottom) / 2),
          iconOffsetX: Math.abs((iconBox.left + iconBox.right - svg.left - svg.right) / 2),
          iconOffsetY: Math.abs((iconBox.top + iconBox.bottom - svg.top - svg.bottom) / 2)
        };
      })
    };
  });
  assert.equal(layout.horizontalOverflow, false, label + ' overflows horizontally');
  assert.ok(layout.rows.length > 0, label + ' has no rows');
  for (const row of layout.rows) {
    const detail = JSON.stringify({ label, ...row });
    assert.ok(Math.abs(row.width - row.hostWidth) < 2, detail);
    assert.ok(row.stacked || row.tailLeft === null || row.bodyRight <= row.tailLeft + 1, detail);
    assert.ok(row.tailRight === null || row.tailRight <= row.right + 1, detail);
    assert.ok(!row.titleOverflow || row.titleEllipsis, detail);
    assert.equal(row.columnsOverlap, false, detail);
    assert.equal(row.columnsOutside, false, detail);
    assert.ok(row.height >= 56 && row.height <= (row.stacked ? 112 : 76), detail);
    assert.ok(row.badgeOffsetY === null || row.badgeOffsetY < 1.1, detail);
    assert.ok(row.iconOffsetX < 1.1 && row.iconOffsetY < 1.1, detail);
  }
  assert.equal(await page.locator('.sheet').evaluate(sheet => sheet.scrollWidth > sheet.clientWidth), false, label);
}

async function closeSheet(page) {
  await page.evaluate(() => U.closeOverlay());
  await page.locator('.sheet').waitFor({ state: 'detached' });
}

try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    completionCalls = 0;
    requestGate = null;
    let releaseStream = null;
    const { browser, context, page, errors } = await setup(engine);
    try {
      await page.goto(base + '/#/chat', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.getByText('旧格式回答').waitFor();

      // The gear path stays inside its 24x24 viewBox and renders with the same
      // visible margin as the history icon on both engines.
      const toolbarPaths = await page.evaluate(() => {
        const svgs = Array.from(document.querySelectorAll('.chat-toolbar .tool-btn svg'));
        return svgs.map(svg => {
          const values = Array.from(svg.querySelectorAll('path, circle')).map(node => {
            const box = node.getBBox();
            return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
          });
          return {
            viewBox: svg.getAttribute('viewBox'),
            left: Math.min(...values.map(box => box.left)),
            top: Math.min(...values.map(box => box.top)),
            right: Math.max(...values.map(box => box.right)),
            bottom: Math.max(...values.map(box => box.bottom))
          };
        });
      });
      assert.equal(toolbarPaths.length, 2);
      assert.ok(toolbarPaths[1].left >= 2.5 && toolbarPaths[1].top >= 2.5, JSON.stringify(toolbarPaths));
      assert.ok(toolbarPaths[1].right <= 21.5 && toolbarPaths[1].bottom <= 21.5, JSON.stringify(toolbarPaths));
      toolbarPaths.forEach(path => {
        assert.equal(path.viewBox, '0 0 24 24');
        assert.ok(Math.abs((path.left + path.right) / 2 - 12) < .75, JSON.stringify(path));
        assert.ok(Math.abs((path.top + path.bottom) / 2 - 12) < .75, JSON.stringify(path));
      });

      // Cover long names, disabled tokens and scrolling on Android/iOS engines.
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        for (const theme of ['light', 'dark']) {
          await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
          await page.locator('.chat-toolbar .chip').nth(1).click();
          await page.locator('.chat-key-picker').waitFor();
          await checkPickerLayout(page, '.chat-key-picker', `${name} tokens ${width} ${theme}`);
          assert.equal(await page.locator('.chat-key-picker').evaluate(host => host.scrollHeight > host.clientHeight), true);
          await page.locator('.chat-key-picker .list-item').last().scrollIntoViewIfNeeded();
          assert.ok(await page.locator('.chat-key-picker').evaluate(host => host.scrollTop > 0));
          await page.locator('.chat-key-picker .list-item').first().scrollIntoViewIfNeeded();
          if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${name}-tokens-${width}-${theme}.png`, animations: 'disabled' });
          await closeSheet(page);

          await page.locator('.chat-toolbar .chip').first().click();
          await page.locator('.chat-model-picker .list-item').nth(1).waitFor();
          await checkPickerLayout(page, '.chat-model-picker', `${name} models ${width} ${theme}`);
          if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${name}-models-${width}-${theme}.png`, animations: 'disabled' });
          await closeSheet(page);

          await page.getByRole('button', { name: '历史对话', exact: true }).click();
          await page.locator('.chat-history-list').waitFor();
          await checkPickerLayout(page, '.chat-history-list', `${name} history ${width} ${theme}`);
          if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${name}-history-${width}-${theme}.png`, animations: 'disabled' });
          await closeSheet(page);
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.chat-toolbar .chip').nth(1).click();
      await page.locator('.chat-key-picker .list-item').nth(1).click();
      await page.locator('.chat-toolbar .chip').nth(1).getByText('令牌 · 这是一个非常长的令牌名称用于测试布局').waitFor();
      await page.reload();
      await page.locator('.chat-toolbar .chip').nth(1).getByText('令牌 · 这是一个非常长的令牌名称用于测试布局').waitFor();
      await page.locator('.chat-toolbar .chip').nth(1).click();
      await page.locator('.chat-key-picker .list-item').first().click();

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
        const composerAlignment = await page.locator('.composer-box').evaluate(box => {
          const textarea = box.querySelector('textarea');
          const send = box.querySelector('.send-btn');
          const text = textarea.getBoundingClientRect();
          const button = send.getBoundingClientRect();
          const style = getComputedStyle(textarea);
          const line = parseFloat(style.lineHeight);
          const textCenter = text.top + parseFloat(style.paddingTop) + line / 2;
          return {
            textHeight: text.height,
            textCenter,
            buttonCenter: (button.top + button.bottom) / 2
          };
        });
        assert.ok(Math.abs(composerAlignment.textCenter - composerAlignment.buttonCenter) < 1.1,
          JSON.stringify({ width, ...composerAlignment }));
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
