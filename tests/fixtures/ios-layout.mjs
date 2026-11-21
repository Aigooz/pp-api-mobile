export const longModel = 'claude-sonnet-4-6-thinking-20261118-long-context';
export const longGroup = 'Codex Pro【不降智】与 Claude 全系长名称测试分组';
export const user = { id: 19, email: 'long-account-name-for-layout@example.test', username: '小屏幕与长名称排版检查账号', balance: 123456.7891,
  role: 'user', concurrency: 999, created_at: '2026-01-01T08:09:10+08:00' };
export const groups = [
  { id: 4, name: longGroup, description: 'GPT / Claude 全系列，长分组名称和说明在小屏中也应完整分行。', rate_multiplier: 0.12,
    models: [longModel, 'gpt-6-astra', 'deepseek-v4.1-flash'].map(name => ({ name, context_length: 200000,
      pricing: { billing_mode: 'token', input_price: 0.000003, output_price: 0.000015, cache_read_price: 0.0000003, cache_write_price: 0.00000375 } })) },
  { id: 5, name: 'DeepSeek 无限制日卡', subscription_type: 'subscription', models: [{ name: 'deepseek-v4.1', pricing: { billing_mode: 'token', input_price: 0.000001, output_price: 0.000002 } }] }
];
export const keys = [
  { id: 7, name: '这是用于检查对话选择器的非常长的令牌名称', key: 'sk-layout-test-not-a-real-key-12345678', status: 'active', group_id: 4, group_name: longGroup,
    current_concurrency: 12, used_quota: 1234.5678, quota: 10000, expires_at: '2026-12-31T23:59:59+08:00' },
  { id: 8, name: '另一个已经停用但名称也很长的令牌', key: 'sk-layout-disabled-not-a-real-key', status: 'inactive', group_id: 5, group_name: 'DeepSeek 无限制日卡' }
];
export const plans = [
  { id: 11, group_id: 5, name: 'DeepSeek 无限制日卡', currency: 'CNY', price: 3.66, validity_days: 1, description: '每日额度 · 可叠加续费' },
  { id: 12, group_id: 4, name: 'Claude 全系列超长名称周卡订阅', currency: 'CNY', price: 99.99, validity_days: 7, description: '标准订阅权益与缓存能力' }
];

export async function mockIOSLayout(page) {
  const now = new Date();
  now.setHours(10, 15, 30, 0);
  const rows = [longModel, 'gpt-6-astra', 'deepseek-v4.1-flash'].map((model, index) => ({
    id: index + 1, model, group_name: longGroup, api_key_name: keys[0].name, created_at: now.toISOString(), request_id: 'request-layout-' + index + '-a-very-long-request-id',
    input_tokens: 1234567, output_tokens: 12345, cache_creation_tokens: 123, cache_read_tokens: 56789, total_tokens: 1303824,
    actual_cost: 12.3456, total_cost: 24.6912, first_token_ms: 4240, duration_ms: 6110, output_tps: 240.1, status_code: 200
  }));
  const trend = Array.from({ length: 12 }, (_, index) => ({ date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(index + 1).padStart(2, '0')}:00:00+08:00`,
    input_tokens: 12345 * (index + 1), output_tokens: 3456, cache_read_tokens: 3000, cache_creation_tokens: 1000, actual_cost: index * 0.3456, total_tokens: 23000 * (index + 1) }));
  const ok = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
  await page.route('**/__proxy/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/__proxy\/(site|model)/, '');
    if (path === '/v1/chat/completions' && route.request().method() === 'POST') {
      const events = [
        { choices: [{ delta: { content: '模拟回答：一加一等于二。' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12345, completion_tokens: 6789, prompt_tokens_details: { cached_tokens: 1024 }, cache_creation_input_tokens: 256 } }
      ];
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n' });
    }
    if (route.request().method() !== 'GET') {
      await route.abort();
      throw new Error('Layout audit must not mutate account data: ' + path);
    }
    if (path === '/api/v1/settings/public') return route.fulfill(ok({ site_name: 'Pp API', allow_user_view_error_requests: true, contact_info: 'support@example.test' }));
    if (path === '/api/v1/model-plaza') return route.fulfill(ok({ groups }));
    if (path === '/api/v1/auth/me') return route.fulfill(ok(user));
    if (path === '/api/v1/keys') return route.fulfill(ok({ items: keys, total: keys.length }));
    if (path === '/api/v1/groups/available') return route.fulfill(ok(groups));
    if (path === '/api/v1/usage/stats' || path === '/api/v1/usage/dashboard/stats') return route.fulfill(ok({
      total_api_keys: 2, active_api_keys: 1, total_requests: 123456, today_requests: 12345,
      today_tokens: 1234567890, today_input_tokens: 234567890, today_output_tokens: 123456789,
      total_tokens: 12345678901, total_input_tokens: 567890, total_output_tokens: 123456,
      today_actual_cost: 1234.5678, total_actual_cost: 12345.6789, total_cache_read_tokens: 123456,
      today_cache_read_tokens: 12345, rpm: 123, tpm: 1234567, average_duration_ms: 11234,
      success_rate: 0.999, today_success_rate: 0.998, today_errors: 2, total_errors: 15
    }));
    if (path === '/api/v1/usage/dashboard/trend') return route.fulfill(ok({ trend }));
    if (path === '/api/v1/usage/dashboard/models') return route.fulfill(ok({ models: rows.map((row, index) => ({
      model: row.model, actual_cost: (3 - index) * 2.5, cost: 5, total_tokens: (3 - index) * 1234567, requests: 123
    })) }));
    if (path === '/api/v1/usage' || path === '/api/v1/usage/errors') {
      const size = Number(url.searchParams.get('page_size')) || 20;
      const number = Number(url.searchParams.get('page')) || 1;
      return route.fulfill(ok({ items: rows.slice((number - 1) * size, number * size), total: rows.length, page: number, page_size: size }));
    }
    if (/^\/api\/v1\/usage\/\d+$/.test(path)) return route.fulfill(ok(rows[Number(path.split('/').pop()) - 1]));
    if (path === '/api/v1/user/platform-quotas') return route.fulfill(ok({ platform_quotas: [] }));
    if (path === '/api/public/channel-status') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      updatedAt: new Date().toISOString(), items: rows.map(row => ({ model: row.model, group: longGroup, status: 'operational', latency: 4240, ping: 88, availability: 99.98,
        timeline: [0, 1, 2].map(index => ({ at: new Date(Date.now() - index * 60000).toISOString(), status: 'operational', latency_ms: 4240, ping_ms: 88 })) }))
    }) });
    if (path === '/api/v1/payment/config') return route.fulfill(ok({ enabled: true, min_amount: 1, max_amount: 500, enabled_payment_types: ['alipay', 'wxpay'], recharge_fee_rate: 1 }));
    if (path === '/api/v1/payment/checkout-info') return route.fulfill(ok({ methods: { alipay: { available: true }, wxpay: { available: true } }, plans }));
    if (path === '/api/daycard/info') {
      const plan = plans.find(item => item.group_id === Number(url.searchParams.get('group_id'))) || plans[0];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plan, user: { id: user.id, balance: user.balance }, subscription: null }) });
    }
    if (path === '/api/v1/payment/orders/my') {
      const items = url.searchParams.get('status') === 'PENDING' ? [] : [{ id: 123456789, amount: 99.99, order_type: 'subscription', status: 'COMPLETED', created_at: new Date().toISOString() }];
      return route.fulfill(ok({ items, total: items.length, page: 1, page_size: Number(url.searchParams.get('page_size')) }));
    }
    if (path === '/api/v1/subscriptions/active') return route.fulfill(ok([{ id: 1, group_name: longGroup, expires_at: '2026-12-31T23:59:59+08:00' }]));
    if (path === '/api/v1/announcements') return route.fulfill(ok([{ id: 7, title: '模型恢复完毕与调用补偿发放通知', created_at: '2026-11-18T12:00:00+08:00',
      content: '<p style="color:#e83e8c;font-size:15px;line-height:1.9">各分组模型已<strong>逐步恢复</strong>，全部正常服务。</p><h3>当前状态与补偿</h3><p>平台公告中的粗体、颜色和长段落应保持正常显示。</p>' }]));
    if (path === '/api/v1/redeem/history') return route.fulfill(ok([{ id: 1, type: 'subscription', code: 'MOCK-LAYOUT-TEST-NOT-REDEEMABLE', group_name: longGroup, created_at: new Date().toISOString(), validity_days: 1 }]));
    if (path === '/api/v1/user/aff') return route.fulfill(ok({ invite_code: 'MOCK-LAYOUT', aff_count: 12345, aff_quota: 1234.5678 }));
    if (path === '/v1/models') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: groups[0].models.map(item => ({ id: item.name })) }) });
    return route.fulfill(ok([]));
  });
}
