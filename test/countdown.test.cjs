'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const nunjucks = require('nunjucks');

const layout = new nunjucks.Loader();
layout.getSource = name => name === 'layout/immersive.html'
  ? { src: '{% block content %}{% endblock %}{% block script %}{% endblock %}', path: name, noCache: true } : null;
const env = new nunjucks.Environment([layout, new nunjucks.FileSystemLoader(path.resolve(__dirname, '../templates'))], { autoescape: true });
const translations = {};
const catalogs = {};
require('../locales')({ i18n: { load: (locale, dictionary) => {
  catalogs[locale] = dictionary;
  if (locale === 'zh') Object.assign(translations, dictionary);
} } });

function render(remainingMs, extra = {}) {
  return env.render('verification_code.html', {
    title: 'Sign Up', mail: 'test@example.com', nonce: 'abc', remaining: 3, maxAttempts: 3, hasCode: true,
    retryAfter: Math.ceil(remainingMs / 1000), retryAfterMs: remainingMs,
    entryRoute: 'user_register', verifyRoute: 'verification_register', url: name => '/' + name,
    _: key => {
      const value = catalogs[extra.language || 'zh'][key] || key;
      const result = new String(value);
      result.format = number => value.replace('{0}', number.toString());
      return result;
    },
    ...extra,
  });
}

function browser(remainingMs, extra = {}) {
  let now = 100000;
  let nextTimer = 0;
  const timers = new Map();
  const requests = [];
  const replies = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => { if (!error.message.includes('navigation')) throw error; });
  const dom = new JSDOM(render(remainingMs, extra), {
    runScripts: 'dangerously', url: 'https://oj.example.com/register', virtualConsole: console,
    beforeParse(window) {
      window.LOCALES = catalogs[extra.language || 'zh'];
      window.Date.now = () => now;
      window.setInterval = callback => { const id = ++nextTimer; timers.set(id, callback); return id; };
      window.clearInterval = id => timers.delete(id);
      window.fetch = async (url, options) => {
        requests.push({ url, options });
        const reply = replies.shift();
        if (!reply) throw new Error('Missing mock response');
        return reply();
      };
    },
  });
  const doc = dom.window.document;
  const form = doc.querySelector('[data-verification-form]');
  const page = {
    dom, form, requests, replies,
    button: doc.querySelector('[data-send-code]'),
    verify: doc.querySelector('[data-verify-code]'),
    email: doc.getElementById('verification-email'),
    code: doc.getElementById('verification-code'),
    hint: doc.querySelector('[data-mail-hint]'),
    error: doc.querySelector('[data-verification-error]'),
    tick(ms) { now += ms; for (const callback of [...timers.values()]) callback(); },
    advance(ms) { now += ms; },
    activeTimers: () => timers.size,
    submit(button) { form.dispatchEvent(new dom.window.SubmitEvent('submit', { cancelable: true, submitter: button })); },
    edit(mail) { page.email.value = mail; page.email.dispatchEvent(new dom.window.Event('input')); },
    reply(data, ok = true) { replies.push(async () => ({ ok, json: async () => data })); },
  };
  return page;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const sent = (extra = {}) => ({ hasCode: true, mail: 'test@example.com', nonce: 'fresh', remaining: 3, maxAttempts: 3, retryAfterMs: 30000, resendIntervalMs: 30000, ...extra });

test('the initial page has email, adjacent code/send controls, and no inbox hint before sending', () => {
  const page = browser(0, { hasCode: false, mail: '', nonce: '', remaining: 0 });
  try {
    assert.equal(page.button.textContent, '获取验证码');
    assert.equal(page.button.disabled, false);
    assert.equal(page.code.disabled, false);
    assert.equal(page.verify.disabled, true);
    assert.equal(page.hint.hidden, true);
    page.code.value = '012345';
    page.submit(page.verify);
    assert.equal(page.requests.length, 0);
    assert.equal(page.verify.disabled, true);
    page.code.value = '';
    assert.equal(page.code.closest('.verification-code-row'), page.button.parentElement);
    assert.ok(page.code.closest('label.inverse.material.textbox'));
    assert.ok(page.email.closest('label.inverse.material.textbox'));
    assert.equal(page.error.hidden, false);
  } finally { page.dom.window.close(); }
});

test('remaining seconds appear on the button and enable resend at the actual deadline', () => {
  const page = browser(5000);
  try {
    assert.equal(page.button.textContent, '5 秒后重发');
    assert.equal(page.button.disabled, true);
    page.tick(1000);
    assert.equal(page.button.textContent, '4 秒后重发');
    page.tick(3001);
    assert.equal(page.button.textContent, '1 秒后重发');
    page.tick(999);
    assert.equal(page.button.textContent, '重新发送验证码');
    assert.equal(page.button.disabled, false);
    assert.equal(page.activeTimers(), 0);
  } finally { page.dom.window.close(); }
});

test('refresh and back-cache resume use the remaining duration instead of restarting 30 seconds', () => {
  const page = browser(12500);
  try {
    assert.equal(page.button.textContent, '13 秒后重发');
    page.tick(500);
    assert.equal(page.button.textContent, '12 秒后重发');
    page.dom.window.dispatchEvent(new page.dom.window.Event('pagehide'));
    page.advance(13000);
    page.dom.window.dispatchEvent(new page.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    assert.equal(page.button.disabled, false);
    assert.equal(page.button.textContent, '重新发送验证码');
  } finally { page.dom.window.close(); }
});

test('sending stays on the same page, starts the button countdown and reveals the inbox/spam hint', async () => {
  const page = browser(0, { hasCode: false, mail: '', nonce: '', remaining: 0 });
  try {
    page.edit('test@example.com');
    page.reply(sent());
    page.submit(page.button);
    assert.equal(page.button.disabled, true);
    assert.equal(page.button.textContent, '发送中…');
    await flush();
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].url, 'https://oj.example.com/user_register');
    assert.equal(page.requests[0].options.body.get('mail'), 'test@example.com');
    assert.equal(page.requests[0].options.body.get('action'), 'send');
    assert.equal(page.requests[0].options.headers.Accept, 'application/json');
    assert.equal(page.dom.window.location.pathname, '/register');
    assert.equal(page.button.textContent, '30 秒后重发');
    assert.equal(page.verify.disabled, false);
    assert.equal(page.code.disabled, false);
    assert.equal(page.hint.hidden, false);
    assert.ok(page.hint.textContent.includes('垃圾邮件箱'));
    assert.equal(page.form.elements.namedItem('__challenge').value, 'fresh');
    assert.equal(page.dom.window.document.activeElement, page.code);
  } finally { page.dom.window.close(); }
});

test('a delayed send confirmation starts at 30 seconds and does not discard code typed while waiting', async () => {
  const page = browser(0, { hasCode: false, mail: '', nonce: '', remaining: 0 });
  try {
    page.edit('test@example.com');
    let finish;
    page.replies.push(() => new Promise(resolve => { finish = resolve; }));
    page.submit(page.button);
    page.tick(6500);
    assert.equal(page.button.textContent, '发送中…');
    assert.equal(page.button.disabled, true);
    assert.equal(page.code.disabled, false);
    page.code.value = '012345';
    finish({ ok: true, json: async () => sent({ retryAfterMs: 29500 }) });
    await flush();
    assert.equal(page.button.textContent, '30 秒后重发');
    assert.equal(page.code.value, '012345');
    page.tick(1000);
    assert.equal(page.button.textContent, '29 秒后重发');
    page.tick(28999);
    assert.equal(page.button.textContent, '1 秒后重发');
    assert.equal(page.button.disabled, true);
    page.tick(1);
    assert.equal(page.button.disabled, false);
    assert.equal(page.button.textContent, '重新发送验证码');
  } finally { page.dom.window.close(); }
});

test('waiting and in-flight requests block repeated sends', async () => {
  const page = browser(1000);
  try {
    page.submit(page.button);
    assert.equal(page.requests.length, 0);
    page.tick(1000);
    let finish;
    page.replies.push(() => new Promise(resolve => { finish = resolve; }));
    page.submit(page.button);
    page.submit(page.button);
    assert.equal(page.requests.length, 1);
    assert.equal(page.email.readOnly, true);
    assert.equal(page.code.disabled, false);
    page.code.value = '012345';
    finish({ ok: true, json: async () => sent() });
    await flush();
    assert.equal(page.code.value, '012345');
    assert.equal(page.email.readOnly, false);
    assert.equal(page.button.disabled, true);
  } finally { page.dom.window.close(); }
});

test('editing email clears the typed code and prevents using the old mailbox challenge', () => {
  const page = browser(30000);
  try {
    page.code.value = '012345';
    page.edit('different@example.com');
    assert.equal(page.code.value, '');
    assert.equal(page.code.disabled, false);
    assert.equal(page.verify.disabled, true);
    assert.equal(page.form.elements.namedItem('__challenge').value, '');
    assert.equal(page.hint.hidden, true);
    assert.equal(page.button.textContent, '获取验证码');
    page.edit('test@example.com');
    assert.equal(page.button.textContent, '30 秒后重发');
    assert.equal(page.form.elements.namedItem('__challenge').value, 'abc');
  } finally { page.dom.window.close(); }
});

test('network and server failures are inline and leave the form usable for retry', async () => {
  const page = browser(0);
  try {
    page.replies.push(async () => { throw new Error('offline'); });
    page.submit(page.button);
    await flush();
    assert.equal(page.error.textContent, '请求失败，请稍后重试。');
    assert.equal(page.button.disabled, false);
    assert.equal(page.email.readOnly, false);
    page.reply({ ...sent({ retryAfterMs: 0 }), error: '发送频率过高，请稍后再试。' }, false);
    page.submit(page.button);
    await flush();
    assert.equal(page.error.textContent, '发送频率过高，请稍后再试。');
    assert.equal(page.verify.disabled, false);
  } finally { page.dom.window.close(); }
});

test('wrong verification stays inline and updates remaining attempts', async () => {
  const page = browser(15000);
  try {
    page.code.value = '000000';
    page.reply({ ...sent({ remaining: 2, retryAfterMs: 10000 }), error: '验证码错误。' }, false);
    page.submit(page.verify);
    await flush();
    assert.equal(page.requests[0].url, 'https://oj.example.com/verification_register');
    assert.equal(page.requests[0].options.body.get('__verificationCode'), '000000');
    assert.equal(page.requests[0].options.body.get('__challenge'), 'abc');
    assert.equal(page.error.textContent, '验证码错误。');
    assert.equal(page.dom.window.document.querySelector('[data-attempts]').textContent, '剩余尝试次数：2');
    assert.equal(page.button.textContent, '10 秒后重发');
    assert.equal(page.verify.disabled, false);
  } finally { page.dom.window.close(); }
});

test('a control named action cannot replace the verification request URL in real browsers', async () => {
  const page = browser(15000);
  try {
    // Real browsers expose named form controls before built-in form properties.
    // jsdom does not implement this collision, so reproduce it explicitly.
    Object.defineProperty(page.form, 'action', { value: page.button, configurable: true });
    page.code.value = '012345';
    page.reply({ ...sent({ remaining: 2 }), error: '验证码错误。' }, false);
    page.submit(page.verify);
    await flush();
    assert.equal(page.requests[0].url, 'https://oj.example.com/verification_register');
    assert.equal(page.requests[0].options.body.get('__verificationCode'), '012345');
    assert.equal(page.error.textContent, '验证码错误。');
  } finally { page.dom.window.close(); }
});

test('the server-rendered form works without JavaScript and contains no removed notice', () => {
  const dom = new JSDOM(render(30000));
  try {
    const doc = dom.window.document;
    assert.equal(doc.querySelector('[data-send-code]').getAttribute('formaction'), '/user_register');
    assert.equal(doc.querySelector('[data-send-code]').hasAttribute('formnovalidate'), true);
    assert.equal(doc.querySelector('form').getAttribute('action'), '/verification_register');
    assert.equal(doc.body.textContent.includes('重新发送后，旧验证码立即失效。'), false);
    assert.equal(dom.window.getComputedStyle(doc.querySelector('.verification-hint')).fontSize, '13px');
    assert.ok(doc.querySelector('noscript').textContent.includes('刷新页面'));
  } finally { dom.window.close(); }
});

test('exhausting three attempts locks verification while the code input stays editable', async () => {
  const page = browser(1000);
  try {
    page.code.value = '000000';
    page.reply({ ...sent({ remaining: 0, retryAfterMs: 1000 }), error: '验证码已达到尝试次数上限。' }, false);
    page.submit(page.verify);
    await flush();
    assert.equal(page.verify.disabled, true);
    assert.equal(page.code.disabled, false);
    assert.equal(page.dom.window.document.querySelector('[data-attempts]').textContent, '剩余尝试次数：0');
    page.tick(1000);
    page.reply(sent());
    page.submit(page.button);
    await flush();
    assert.equal(page.verify.disabled, false);
    assert.equal(page.code.disabled, false);
    assert.equal(page.dom.window.document.querySelector('[data-attempts]').hidden, true);
  } finally { page.dom.window.close(); }
});

test('changing email asks for a password before the first send and clears it after authorization', async () => {
  const page = browser(0, { hasCode: false, mail: '', nonce: '', remaining: 0, needsPassword: true, passwordLabel: 'Current Password', entryRoute: 'verification_changemail', verifyRoute: 'verification_changemail' });
  try {
    page.edit('new@example.com');
    const password = page.form.elements.namedItem('password');
    page.submit(page.button);
    assert.equal(page.requests.length, 0);
    assert.equal(page.error.textContent, '请输入当前密码。');
    password.value = 'current-password';
    page.reply(sent({ mail: 'new@example.com' }));
    page.submit(page.button);
    await flush();
    assert.equal(page.requests[0].options.body.get('password'), 'current-password');
    assert.equal(page.requests[0].url, 'https://oj.example.com/verification_changemail');
    assert.equal(password.value, '');
    assert.equal(page.form.querySelector('[data-password-field]').hidden, true);
    page.edit('different@example.com');
    assert.equal(page.form.querySelector('[data-password-field]').hidden, false);
    page.submit(page.button);
    assert.equal(page.requests.length, 1);
    assert.equal(page.error.textContent, '请输入当前密码。');
  } finally { page.dom.window.close(); }
});

test('security-page integration preserves the native email-change button and redirects only its action', async () => {
  const parent = new nunjucks.Loader();
  parent.getSource = name => name === 'home_security.html' ? {
    src: '<html class="page--home_security"><body>{% block home_content %}<div class="media__right medium"><button type="button" class="rounded button" data-operation="change_mail">修 改</button></div><button data-operation="enable_tfa">TFA</button>{% endblock %}{% block script %}<script>window.nativeChangeButton = document.querySelector(\'[data-operation="change_mail"]\');</script>{% endblock %}</body></html>',
    path: name, noCache: true,
  } : null;
  const security = new nunjucks.Environment([parent, new nunjucks.FileSystemLoader(path.resolve(__dirname, '../templates'))], { autoescape: true });
  const dom = new JSDOM(security.render('verification_home_security.html', {
    verificationChangeUrl: '/verification/changemail', verificationPendingMail: 'new@example.com',
    _: key => { const value = catalogs.zh[key] || key; const text = new String(value); text.format = param => value.replace('{0}', param); return text; },
  }), { runScripts: 'dangerously', url: 'https://oj.example.com/home/security' });
  try {
    const link = dom.window.document.querySelector('[data-verification-change-mail]');
    assert.equal(link.hidden, true);
    assert.equal(link.getAttribute('href'), '/verification/changemail');
    const button = dom.window.nativeChangeButton;
    assert.equal(button.isConnected, true);
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.type, 'button');
    assert.equal(button.className, 'rounded button');
    assert.equal(button.textContent, '修改');
    assert.equal(button.hasAttribute('data-verification-change-button'), true);
    assert.equal(dom.window.getComputedStyle(button).whiteSpace, 'nowrap');
    assert.equal(button.parentElement.className, 'media__right medium');
    assert.equal(dom.window.document.querySelector('[data-operation="change_mail"]'), null);
    assert.ok(dom.window.document.querySelector('[data-operation="enable_tfa"]'));
    assert.ok(dom.window.document.body.textContent.includes('new@example.com'));
    // A same-document destination exercises real navigation without JSDOM's
    // unsupported full-page navigation; the production route is asserted above.
    link.href = '#verification-changemail';
    let nativeDialogCalls = 0;
    dom.window.document.addEventListener('click', event => {
      if (event.target.closest('[data-operation="change_mail"]')) nativeDialogCalls++;
    });
    button.click();
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    assert.equal(dom.window.location.hash, '#verification-changemail');
    assert.equal(nativeDialogCalls, 0);
  } finally { dom.window.close(); }
});

for (const language of ['en', 'zh', 'zh_TW', 'ko']) {
  test(`${language}: AJAX button states, countdown and native JSON errors stay in the selected language`, async () => {
    const page = browser(0, { language, hasCode: false, mail: '', nonce: '', remaining: 0 });
    const dictionary = catalogs[language];
    try {
      assert.equal(page.button.textContent, dictionary['Get code']);
      page.edit('test@example.com');
      page.reply(sent());
      page.submit(page.button);
      assert.equal(page.button.textContent, dictionary['Sending...']);
      await flush();
      assert.equal(page.button.textContent, dictionary['Resend in {0}s'].replace('{0}', '30'));
      assert.ok(page.hint.textContent.includes(dictionary['Please check your inbox. If you cannot find the email, check your spam folder.']));
      page.tick(30000);
      assert.equal(page.button.textContent, dictionary['Resend code']);
      page.reply({ error: { message: 'Field {0} validation failed.', params: ['mail'] } }, false);
      page.submit(page.button);
      await flush();
      assert.equal(page.error.textContent, dictionary['Field {0} validation failed.'].replace('{0}', dictionary.Email));
      page.reply({ error: { message: 'Untranslated internal provider message' } }, false);
      page.submit(page.button);
      await flush();
      assert.equal(page.error.textContent, dictionary['The request failed. Please try again.']);
    } finally { page.dom.window.close(); }
  });
}
