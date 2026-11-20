import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../app/src/main/assets/www/js/api.js', import.meta.url), 'utf8');
const passwords = { a: 'private-password-a', b: 'private-password-b' };
const response = (status, data, message) => ({
  status, text: async () => JSON.stringify(message ? { code: 'ERROR', message } : { code: 0, data })
});

function fixture({ mode = 'sync', initial = '' } = {}) {
  const state = { stored: initial, login: 'ok', refresh: 'ok', logins: 0, refreshes: 0, serial: 0, events: [], headers: [], tokens: new Set(), holdLogin: null, holdRefresh: null, holdPassword: null };
  const sandbox = {
    Promise, setTimeout, clearTimeout, Uint8Array, TextDecoder,
    location: { hostname: 'app.test' },
    U: { store: { get: (_, fallback) => fallback, set() {}, del() {} } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    dispatchEvent: event => state.events.push(event.detail.reason),
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const body = options.body && JSON.parse(options.body);
      const token = (options.headers.Authorization || '').replace('Bearer ', '');
      if (path === '/api/v1/settings/public') return response(200, state.settings || {});
      if (path === '/api/v1/auth/login') {
        state.logins++;
        if (state.holdLogin) await state.holdLogin;
        if (state.login === 'network') throw new TypeError('Failed to fetch');
        if (state.login === 'busy') return response(429, null, 'too many requests');
        if (state.login === 'server') return response(503, null, 'temporary failure');
        if (state.login === '2fa') return response(400, null, 'two factor required');
        if (state.login === 'challenge') return response(200, { requires_2fa: true });
        const name = body.email.split('@')[0];
        if (state.login === 'invalid' || body.password !== passwords[name]) return response(401, null, 'invalid email or password');
        const access = 'access-' + name + '-' + (++state.serial);
        state.tokens.add(access);
        return response(200, { access_token: access, refresh_token: 'refresh-' + name, user: { email: body.email, password: 'never-save-server-password' } });
      }
      if (path === '/api/v1/auth/refresh') {
        state.refreshes++;
        if (state.holdRefresh) await state.holdRefresh;
        if (state.refresh === 'server') return response(503, null, 'temporary failure');
        if (state.refresh === 'expired') return response(401, null, 'expired');
        const name = body.refresh_token.replace('refresh-', '');
        const access = 'refreshed-' + name + '-' + (++state.serial);
        if (state.refresh !== 'rejected-token') state.tokens.add(access);
        return response(200, { access_token: access, refresh_token: body.refresh_token });
      }
      if (path === '/api/v1/auth/logout') return response(200, {});
      if (path === '/api/v1/user/password') {
        if (state.holdPassword) await state.holdPassword;
        return response(200, {});
      }
      state.headers.push(token);
      if (path === '/api/v1/always-reject' || !state.tokens.has(token)) return response(401, null, 'expired');
      return response(200, { token });
    }
  };
  if (mode !== 'none') sandbox.Native = {
    secureMode: () => mode,
    secureGet: () => state.stored,
    secureSet: mode === 'async' ? (id, value) => {
      setTimeout(() => { state.stored = value; sandbox.__nativeSecure(id, true); }, 2);
    } : value => { state.stored = value; return true; }
  };
  sandbox.window = sandbox;
  vm.runInContext(source, vm.createContext(sandbox));
  return { api: sandbox.Api, state };
}
const signIn = (api, name = 'a', remember = true) => api.login(name + '@example.test', passwords[name], null, remember);
const code = promise => promise.then(() => 'SUCCESS', error => error.code);
const gate = () => { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; };
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('Expected request did not start');
};

for (const mode of ['sync', 'async']) {
  const { api, state } = fixture({ mode });
  await signIn(api, 'a', false);
  assert.equal(state.stored.includes(passwords.a), false);
  assert.equal(state.stored.includes('never-save-server-password'), false);
  await signIn(api);
  await signIn(api, 'b');
  assert.equal(api.AUTH.remembered(' A@EXAMPLE.TEST ').password, passwords.a);
  assert.equal(api.AUTH.remembered('b@example.test').password, passwords.b);
  assert.equal(JSON.stringify(api.AUTH.accounts()).includes('password'), false);
  const reloaded = fixture({ mode, initial: state.stored }).api;
  assert.equal(reloaded.AUTH.currentId(), 'email:b@example.test');
  assert.equal(reloaded.AUTH.remembered('a@example.test').password, passwords.a);
  await signIn(api, 'a', false);
  assert.equal(api.AUTH.remembered('a@example.test').enabled, false);
  assert.equal(state.stored.includes(passwords.a), false);
  await api.AUTH.remove('email:b@example.test');
  assert.equal(state.stored.includes(passwords.b), false);
}

// Every expired request shares one refresh/recovery; the current route/identity stays intact.
{
  const { api, state } = fixture();
  await signIn(api);
  const context = api.AUTH.context();
  state.events = []; state.tokens.clear(); state.refresh = 'expired';
  const results = await Promise.all(Array.from({ length: 12 }, () => api.base('/protected')));
  assert.equal(state.refreshes, 1); assert.equal(state.logins, 2);
  assert.ok(results.every(result => result.token === api.AUTH.token()));
  assert.equal(api.AUTH.matches(context), true); assert.deepEqual(state.events, []);
  assert.equal(fixture({ initial: state.stored }).api.AUTH.token(), api.AUTH.token());
}

// A token rejected even after refresh uses saved credentials once, never an endless loop.
for (const path of ['/protected', '/always-reject']) {
  const { api, state } = fixture();
  await signIn(api); state.tokens.clear(); state.refresh = 'rejected-token';
  assert.equal(await code(api.base(path)), path === '/protected' ? 'SUCCESS' : 'UNAUTHORIZED');
  assert.equal(state.logins, 2); assert.equal(state.refreshes, 1);
}

for (const failure of ['network', 'busy', 'server']) {
  const { api, state } = fixture();
  await signIn(api); state.tokens.clear(); state.refresh = 'expired'; state.login = failure;
  await assert.rejects(api.base('/protected'));
  assert.equal(api.AUTH.currentId(), 'email:a@example.test');
  assert.equal(api.AUTH.remembered('a@example.test').enabled, true);
  state.login = 'ok';
  assert.equal(await code(api.base('/protected')), 'SUCCESS');
}
{
  const { api, state } = fixture();
  await signIn(api); state.tokens.clear(); state.refresh = 'server';
  assert.equal(await code(api.base('/protected')), 'SERVER');
  assert.equal(state.logins, 1); assert.equal(api.AUTH.isLogged(), true);
}

for (const failure of ['2fa', 'challenge', 'invalid']) {
  const { api, state } = fixture();
  await signIn(api); state.tokens.clear(); state.refresh = 'expired'; state.login = failure;
  assert.equal(await code(api.base('/protected')), 'UNAUTHORIZED');
  assert.equal(api.AUTH.isLogged(), false);
  assert.equal(api.AUTH.remembered('a@example.test').enabled, failure !== 'invalid');
  await api.base('/protected').catch(() => {});
  assert.equal(state.logins, 2);
}

// Switching A -> B -> A invalidates an old password recovery, even for the same email.
{
  const { api, state } = fixture();
  await signIn(api, 'b'); await signIn(api);
  const oldToken = api.AUTH.token();
  state.tokens.clear(); state.refresh = 'expired';
  const held = gate(); state.holdLogin = held.wait;
  const pending = code(api.base('/protected'));
  await until(() => state.logins === 3);
  await api.AUTH.switchTo('email:b@example.test'); await api.AUTH.switchTo('email:a@example.test');
  held.release();
  assert.equal(await pending, 'ACCOUNT_CHANGED');
  assert.equal(api.AUTH.token(), oldToken);
}
{
  const { api, state } = fixture();
  await signIn(api, 'b'); await signIn(api);
  const held = gate(); state.holdPassword = held.wait;
  const pending = code(api.changePassword(passwords.a, 'new-password-a'));
  await api.AUTH.switchTo('email:b@example.test'); held.release();
  assert.equal(await pending, 'ACCOUNT_CHANGED');
  assert.equal(api.AUTH.remembered('b@example.test').password, passwords.b);
  await api.changePassword(passwords.b, 'new-password-b');
  assert.equal(api.AUTH.remembered('b@example.test').password, 'new-password-b');
}
{
  const { api, state } = fixture();
  await signIn(api); await api.logout();
  assert.equal(api.AUTH.remembered('a@example.test').enabled, false);
  assert.equal(state.stored.includes(passwords.a), false);
  await api.base('/protected').catch(() => {}); assert.equal(state.logins, 1);
}
{
  const { api } = fixture({ mode: 'none' });
  await signIn(api);
  assert.equal(api.AUTH.remembered('a@example.test').enabled, false);
}
{
  const { api, state } = fixture();
  state.settings = { login_agreement_enabled: true, login_agreement_revision: 'r1', login_agreement_documents: [{ id: 'terms', title: 'Terms' }] };
  assert.equal(await code(signIn(api)), 'LOGIN_AGREEMENT_REQUIRED');
  assert.equal(state.logins, 0);
  api.acceptLoginAgreement(await api.loginAgreement());
  await signIn(api);
  state.settings.login_agreement_revision = 'r2';
  state.tokens.clear(); state.refresh = 'expired';
  assert.equal(await code(api.base('/protected')), 'LOGIN_AGREEMENT_REQUIRED');
  assert.equal(state.logins, 1);
  assert.equal(api.AUTH.isLogged(), false);
  assert.equal(api.AUTH.remembered('a@example.test').enabled, true);
  assert.equal(state.events.at(-1), 'agreement');
}
console.log('Remember password: secure persistence, account isolation, deduplicated recovery, failures, 2FA and logout passed');
