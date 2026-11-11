import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPreviewServer } from '../preview.mjs';

const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
  localStorage.setItem('pp_api_token', JSON.stringify('fake-access'));
  localStorage.setItem('pp_api_user', JSON.stringify({ id: 1, email: 'test@example.test' }));
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
let mode = 'stream';
await page.route('**/__proxy/**', async route => {
  const p = new URL(route.request().url()).pathname.replace(/^\/__proxy\/(site|model)/, '');
  if (p === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API' }));
  if (p === '/api/v1/model-plaza') return route.fulfill(ok({ groups: [] }));
  if (p === '/api/v1/auth/me') return route.fulfill(ok({ id: 1, email: 'test@example.test', balance: 3 }));
  if (p === '/api/v1/keys') return route.fulfill(ok({ items: [{ id: 1, name: '测试令牌', key: 'fake-key', status: 'active' }] }));
  if (p === '/v1/models') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'demo-model' }, { id: 'gpt-image-2' }] }) });
  if (p === '/v1/images/generations') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ url: base + '/img/pp-logo.jpg' }] }) });
  if (p === '/v1/chat/completions') {
    const body = route.request().postDataJSON();
    if (body.stream === false) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '非流式回复' } }] }) });
    if (mode === 'error') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'model not allowed' } }) });
    if (mode === 'fallback') return route.fulfill({ status: 502, contentType: 'text/plain', body: 'gateway error' });
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"流式回复"}}]}\n\ndata: [DONE]\n\n' });
  }
  return route.fulfill(ok([]));
});
try {
  await page.goto(base + '/#/chat');
  await page.getByText('demo-model').first().waitFor();
  await page.locator('.composer textarea').fill('你好');
  await page.locator('.send-btn').click();
  await page.getByText('流式回复').waitFor();
  mode = 'error';
  await page.locator('.composer textarea').fill('错误测试');
  await page.locator('.send-btn').click();
  await page.locator('.err-box').waitFor();
  assert.match(await page.locator('.err-box').innerText(), /model not allowed/);
  mode = 'fallback';
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByText('非流式回复').waitFor();
  await page.locator('.chat-toolbar .chip').first().click();
  await page.locator('.sheet .list-item').filter({ hasText: 'gpt-image-2' }).click();
  await page.locator('.composer textarea').fill('一张图');
  await page.locator('.send-btn').click();
  const generated = page.locator('.bubble img.gen');
  await generated.waitFor();
  assert.match(await generated.getAttribute('src'), /\/img\/pp-logo\.jpg$/);
  const chunkTest = await page.evaluate(async () => {
    const savedFetch = window.fetch;
    const encoder = new TextEncoder();
    window.fetch = async () => new Response(new ReadableStream({ start(controller) {
      for (const chunk of ['data: {"choices":[{"delta":', '{"content":"分段"}}]}\n', '\ndata: [DO', 'NE]\n\n']) controller.enqueue(encoder.encode(chunk));
      controller.close();
    } }), { status: 200 });
    try {
      return await new Promise((resolve, reject) => {
        let result = '', doneCount = 0;
        Api.chatStream({ stream: true }, 'fake-key', {
          onEvent: event => { result += event.choices[0].delta.content; },
          onDone: () => { doneCount++; setTimeout(() => resolve({ result, doneCount }), 50); },
          onError: reject
        });
      });
    } finally { window.fetch = savedFetch; }
  });
  assert.deepEqual(chunkTest, { result: '分段', doneCount: 1 });
  assert.deepEqual(errors, []);
  console.log('Chat flows: stream, error, fallback, image and split SSE passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
