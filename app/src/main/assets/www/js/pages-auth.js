/* 登录 / 注册 / 找回密码 */
(function (global) {
  'use strict';
  var U = global.U;
  var C = global.PagesCore;
  var h = C.h, card = C.card;

  function authShell(title, subtitle, body, footer) {
    return h('div', { class: 'page', style: { paddingTop: '18px' } },
      h('div', { style: { textAlign: 'center', marginBottom: '22px' } },
        h('img', { src: 'img/pp-logo.jpg', width: '56', height: '56', alt: 'Pp API', style: { borderRadius: '8px' } }),
        h('h1', { style: { fontSize: '22px', margin: '12px 0 4px' } }, title),
        h('p', { class: 'small muted', style: { margin: '0' } }, subtitle)
      ),
      card([h('div', { style: { padding: '18px 16px' } }, body)]),
      footer || null
    );
  }

  function field(label, input) {
    return h('div', { class: 'field' }, h('label', null, label), input);
  }

  // Password input with a show/hide switch, so the value is always readable.
  function pwField(label, input) {
    input.classList.add('with-eye');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    var btn = h('button', {
      class: 'eye-btn', type: 'button', html: U.ic('eye', 19), 'aria-label': '显示密码'
    });
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('on', show);
      btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      try { input.focus(); } catch (e) {}
    });
    return h('div', { class: 'field' },
      h('label', null, label),
      h('div', { class: 'field-pw' }, input, btn)
    );
  }

  function renderLogin() {
    var email = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com', autocomplete: 'username', inputmode: 'email', value: App.loginEmail || '' });
    App.loginEmail = '';
    var pass = h('input', { class: 'input', type: 'password', placeholder: '输入密码', autocomplete: 'current-password' });
    var btn = h('button', { class: 'btn btn-primary btn-block', style: { marginTop: '6px', height: '48px' } }, '登录');

    function completeLogin(result, message) {
      pass.value = '';
      U.closeOverlay();
      if (result.saved) U.toast(message, 'ok');
      else U.toast(Api.AUTH.storageWarning() || '安全保存失败，关闭应用后账号无法保留。', 'err');
      App.refreshPublic();
      App.refreshUser();
      var next = App.nextRoute || '#/home';
      App.nextRoute = null;
      App.go(next, true);
    }

    function submit() {
      if (!email.value.trim() || !pass.value) { U.toast('请填写邮箱和密码', 'err'); return; }
      btn.disabled = true;
      btn.textContent = '登录中…';
      Api.login(email.value.trim(), pass.value).then(function (result) {
        completeLogin(result, '登录成功');
      }).catch(function (e) {
        var msg = e.message || '登录失败';
        if (/2fa|two.factor|两步|验证码/i.test(msg)) {
          open2fa();
        } else {
          U.toast(msg, 'err');
        }
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '登录';
      });
    }

    function open2fa() {
      var code = h('input', { class: 'input', placeholder: '6 位动态验证码', inputmode: 'numeric' });
      var verifying = false;
      U.sheet({
        title: '两步验证',
        body: h('div', null, h('p', { class: 'small muted' }, '该账号开启了两步验证，请输入验证器中的 6 位验证码。'), code),
        actions: [
          { label: '取消' },
          {
            label: '验证', kind: 'primary', onClick: function () {
              if (verifying) return false;
              if (!code.value.trim()) { U.toast('请输入动态验证码', 'err'); return false; }
              verifying = true;
              Api.login2fa({ email: email.value.trim(), password: pass.value, code: code.value.trim(), totp_code: code.value.trim() })
                .then(function (result) { completeLogin(result, '登录成功'); })
                .catch(function (e) { U.toast(e.message, 'err'); })
                .then(function () { verifying = false; });
              return false;
            }
          }
        ]
      });
    }

    btn.addEventListener('click', submit);
    pass.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

    var body = h('div', null,
      field('邮箱', email),
      pwField('密码', pass),
      btn,
      h('div', { class: 'row between', style: { marginTop: '12px' } },
        h('a', { href: '#/forgot', class: 'small' }, '忘记密码？'),
        h('a', { href: '#/register', class: 'small' }, '注册新账号')
      ),
      Api.AUTH.accounts().length ? h('button', {
        class: 'btn btn-ghost btn-block', style: { marginTop: '8px' },
        onclick: function () { App.go('#/accounts', true); }
      }, '返回账号管理') : null
    );

    return authShell('欢迎回来', '登录后管理令牌、用量与余额', body,
      h('div', { class: 'footer-note' }, '登录即表示同意《服务条款》与《隐私政策》'));
  }

  function renderRegister() {
    var settings = global.S.settings || {};
    var email = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com', inputmode: 'email' });
    var code = h('input', { class: 'input', placeholder: '邮箱验证码', inputmode: 'numeric' });
    var pass = h('input', { class: 'input', type: 'password', placeholder: '至少 8 位，建议混合字母数字' });
    var pass2 = h('input', { class: 'input', type: 'password', placeholder: '再次输入密码' });
    var agree = h('input', { type: 'checkbox', checked: true, style: { width: '16px', height: '16px', accentColor: 'var(--teal)' } });
    var sendBtn = h('button', { class: 'btn', style: { height: '46px', minWidth: '104px' } }, '发送验证码');
    var countdown = 0;
    var timer = null;

    function tick() {
      countdown--;
      if (countdown <= 0) {
        clearInterval(timer);
        sendBtn.disabled = false;
        sendBtn.textContent = '重新发送';
        return;
      }
      sendBtn.textContent = countdown + 's';
    }

    sendBtn.addEventListener('click', function () {
      var e = email.value.trim();
      if (!e) { U.toast('请先填写邮箱', 'err'); return; }
      sendBtn.disabled = true;
      sendBtn.textContent = '发送中…';
      Api.sendCode({ email: e }).then(function () {
        U.toast('验证码已发送，请查收邮箱', 'ok');
        countdown = 60;
        sendBtn.disabled = true;
        timer = setInterval(tick, 1000);
      }).catch(function (err) {
        sendBtn.disabled = false;
        sendBtn.textContent = '发送验证码';
        U.toast(err.message, 'err');
      });
    });

    var btn = h('button', { class: 'btn btn-primary btn-block', style: { marginTop: '8px', height: '48px' } }, '创建账号');
    btn.addEventListener('click', function () {
      var e = email.value.trim();
      if (!e || e.indexOf('@') < 0) { U.toast('请输入有效邮箱', 'err'); return; }
      if (!code.value.trim()) { U.toast('请输入邮箱验证码', 'err'); return; }
      if (pass.value.length < 8) { U.toast('密码至少 8 位', 'err'); return; }
      if (pass.value !== pass2.value) { U.toast('两次密码不一致', 'err'); return; }
      if (!agree.checked) { U.toast('请先同意服务条款', 'err'); return; }
      btn.disabled = true;
      btn.textContent = '创建中…';
      Api.register({
        email: e,
        password: pass.value,
        verify_code: code.value.trim(),
        agreement_accepted: true,
        agreement_revision: settings.login_agreement_revision
      }).then(function (result) {
        pass.value = '';
        pass2.value = '';
        if (result.saved) U.toast('注册成功', 'ok');
        else U.toast(Api.AUTH.storageWarning() || '安全保存失败，关闭应用后账号无法保留。', 'err');
        App.refreshPublic();
        return App.refreshUser().catch(function () {});
      }).then(function () {
        App.go('#/home', true);
      }).catch(function (err) {
        U.toast(err.message, 'err');
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '创建账号';
      });
    });

    var body = h('div', null,
      field('邮箱', email),
      h('div', { class: 'field' },
        h('label', null, '邮箱验证码'),
        h('div', { class: 'input-group' }, code, sendBtn)
      ),
      pwField('设置密码', pass),
      pwField('确认密码', pass2),
      h('label', { class: 'row', style: { fontSize: '12.5px', color: 'var(--muted)', margin: '4px 0 10px' } },
        agree,
        h('span', null, '我已阅读并同意 ', h('a', { href: Api.ORIGIN + '/legal/terms', onclick: function (ev) { ev.preventDefault(); C.open(Api.ORIGIN + '/legal/terms'); } }, '服务条款'), ' 与 ',
          h('a', { href: Api.ORIGIN + '/legal/privacy', onclick: function (ev) { ev.preventDefault(); C.open(Api.ORIGIN + '/legal/privacy'); } }, '隐私政策'))
      ),
      btn
    );

    return authShell('创建账号', '注册后即可使用统一 API 接入', body,
      h('div', { class: 'footer-note' }, '已有账号？', h('a', { href: '#/login' }, '直接登录')));
  }

  function renderForgot() {
    var email = h('input', { class: 'input', type: 'email', placeholder: '注册邮箱', inputmode: 'email' });
    var code = h('input', { class: 'input', placeholder: '邮箱验证码', inputmode: 'numeric' });
    var pass = h('input', { class: 'input', type: 'password', placeholder: '新密码（至少 8 位）' });
    var sendBtn = h('button', { class: 'btn', style: { height: '46px', minWidth: '104px' } }, '发送验证码');
    var countdown = 0, timer = null;

    sendBtn.addEventListener('click', function () {
      if (!email.value.trim()) { U.toast('请填写邮箱', 'err'); return; }
      sendBtn.disabled = true;
      Api.sendCode({ email: email.value.trim(), type: 'reset_password' }).then(function () {
        U.toast('验证码已发送', 'ok');
        countdown = 60;
        timer = setInterval(function () {
          countdown--;
          if (countdown <= 0) { clearInterval(timer); sendBtn.disabled = false; sendBtn.textContent = '重新发送'; }
          else sendBtn.textContent = countdown + 's';
        }, 1000);
      }).catch(function (e) {
        sendBtn.disabled = false;
        U.toast(e.message, 'err');
      });
    });

    var btn = h('button', { class: 'btn btn-primary btn-block', style: { marginTop: '8px', height: '48px' } }, '重置密码');
    btn.addEventListener('click', function () {
      if (!email.value.trim() || !code.value.trim() || pass.value.length < 8) {
        U.toast('请填写邮箱、验证码与至少 8 位的新密码', 'err');
        return;
      }
      btn.disabled = true;
      Api.reset({ email: email.value.trim(), verify_code: code.value.trim(), new_password: pass.value })
        .then(function () {
          U.toast('密码已重置，请登录', 'ok');
          App.go('#/login', true);
        }).catch(function (e) {
          U.toast(e.message + '（也可在官网网页完成重置）', 'err');
        }).then(function () { btn.disabled = false; });
    });

    return authShell('找回密码', '通过邮箱验证码重置登录密码', h('div', null,
      field('注册邮箱', email),
      h('div', { class: 'field' }, h('label', null, '验证码'), h('div', { class: 'input-group' }, code, sendBtn)),
      pwField('新密码', pass),
      btn,
      h('div', { style: { textAlign: 'center', marginTop: '12px' } }, h('a', { href: '#/login', class: 'small' }, '返回登录'))
    ));
  }

  global.PagesAuth = { renderLogin: renderLogin, renderRegister: renderRegister, renderForgot: renderForgot };
})(window);
