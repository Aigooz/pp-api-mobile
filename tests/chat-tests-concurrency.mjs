import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../app/src/main/assets/www/js/chat-tests.js', import.meta.url), 'utf8');

function fixture(transport) {
  const key = { id: 7, key: 'mock-key', status: 'active', group_id: 4, name: 'Test key' };
  const listeners = new Map();
  const timers = new Set();
  const sandbox = {
    Api: {
      AUTH: { currentId: () => 'account', context: () => 'auth', isLogged: () => true, matches: value => value === 'auth' },
      chatStream: transport
    },
    U: { maskKey: () => 'mock' }, S: { keys: [key] },
    setTimeout(callback) { timers.add(callback); return callback; }, clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { timers.add(callback); return callback; }, clearInterval(id) { timers.delete(id); },
    CustomEvent: class { constructor(type) { this.type = type; } },
    addEventListener(type, listener) { listeners.set(type, listener); }, dispatchEvent() {},
    performance: { now: () => performance.now() }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  return { tests: sandbox.PagesChatTests, key, timers };
}

// Immediate transport failures must not recursively dispatch the remaining batch.
let attempts = 0;
const failing = fixture(() => { attempts++; throw new Error('Transport unavailable'); });
const names = Array.from({ length: 1000 }, (_, index) => 'model-' + index);
const failed = failing.tests.start({ key: failing.key, models: names, groupName: 'Test' });
assert.equal(attempts, names.length);
assert.equal(failed.completed, names.length);
assert.equal(failed.running, false);
assert.ok(failed.items.every(item => item.state === 'error' && item.total >= 0));
failing.tests.stop();

let aborts = 0;
const pending = [];
const held = fixture((payload, key, handlers) => {
  pending.push({ payload, handlers });
  return { abort() { aborts++; handlers.onDone(); } };
});
const batch = held.tests.start({ key: held.key, models: names.slice(0, 24).concat(names[0]), groupName: 'Test' });
assert.equal(pending.length, 24, 'every unique model must start without waiting for a response');
assert.equal(batch.parallel, 24);
assert.equal(batch.completed, 0);
assert.ok(batch.items.every(item => item.state === 'running'));
assert.equal(held.tests.start({ key: held.key, models: ['duplicate'] }), null);
held.tests.stop();
assert.equal(aborts, 24);
assert.equal(batch.completed, 24);
assert.equal(batch.running, false);
assert.ok(batch.items.every(item => item.state === 'cancelled'), 'synchronous abort callbacks must preserve cancellation');
for (const request of pending) request.handlers.onError('late callback', 429);
assert.equal(batch.completed, 24, 'late transport callbacks must not settle a request twice');
console.log('All-selected dispatch, synchronous errors, deduplication and cancellation passed');
