'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');
const { JSDOM } = require('jsdom');
const nativeI18n = require('./helpers/native-i18n.cjs');
const nativeSource = require('./helpers/native-sources.cjs');
const root = path.resolve(__dirname, '..');
const languages = ['en', 'zh', 'zh_TW', 'ko'];
const dictionaries = Object.fromEntries(languages.map(lang => [lang, require('../locales/' + lang + '.json')]));
const native = nativeI18n();
const placeholders = value => (value.match(/\{[0-9]+\}/g) || []).sort();

function translate(lang) {
  return key => {
    const value = native.translate(key, [lang, 'zh']);
    const result = new String(value);
    result.format = (...args) => value.replace(/\{(\d+)\}/g, (_, index) => String(args[index]));
    return result;
  };
}
function readText(html) {
  const dom = new JSDOM(html);
  try {
    dom.window.document.querySelectorAll('style, script, [hidden]').forEach(element => element.remove());
    return dom.window.document.body.textContent;
  } finally { dom.window.close(); }
}

const baseLayout = new nunjucks.Loader();
baseLayout.getSource = name => name === 'layout/immersive.html'
  ? { src: '{% block content %}{% endblock %}{% block script %}{% endblock %}', path: name, noCache: true } : null;
const pageEnv = new nunjucks.Environment([baseLayout, new nunjucks.FileSystemLoader(path.join(root, 'templates'))], { autoescape: true });
const mailEnv = new nunjucks.Environment(new nunjucks.FileSystemLoader([
  path.join(root, 'templates'), nativeSource('ui-default/templates'),
]), { autoescape: true });

test('the four complete catalogs have identical keys and preserve every format placeholder', () => {
  const calls = [];
  require('../locales')({ i18n: { load: (language, dictionary) => calls.push({ language, dictionary }) } });
  assert.deepEqual(calls.map(call => call.language), languages);
  const keys = Object.keys(dictionaries.en).sort();
  for (const lang of languages) {
    assert.deepEqual(Object.keys(dictionaries[lang]).sort(), keys, lang);
    for (const key of keys) {
      const value = dictionaries[lang][key];
      assert.equal(typeof value, 'string', lang + ': ' + key);
      assert.ok(value.trim(), lang + ': ' + key);
      assert.deepEqual(placeholders(value), placeholders(dictionaries.en[key]), lang + ': ' + key);
    }
  }
});

test('every literal plugin translation key has entries in all four languages', () => {
  const files = ['index.js', 'store.js', ...fs.readdirSync(path.join(root, 'templates')).map(file => 'templates/' + file)];
  const keys = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/(?:_\(|\.translate\(|new VerificationError\()\s*(['"])(.*?)\1/g)) keys.add(match[2]);
  }
  for (const lang of languages) for (const key of keys) {
    assert.ok(Object.hasOwn(dictionaries[lang], key), lang + ': ' + key);
  }
});

test('Hydro resolves regional codes and does not fall back to Chinese for Korean plugin keys', () => {
  for (const [variant, locale] of [['en-US', 'en'], ['zh-CN', 'zh'], ['zh-TW', 'zh_TW'], ['ko-KR', 'ko']]) {
    for (const key of Object.keys(dictionaries.en)) {
      assert.equal(native.translate(key, [variant, 'zh']), dictionaries[locale][key], variant + ': ' + key);
    }
  }
});

for (const lang of languages) {
  test(`${lang}: all three verification pages use the chosen native language`, () => {
    for (const purpose of ['register', 'lostpass', 'changemail']) {
      const html = pageEnv.render('verification_code.html', {
        _: translate(lang), title: { register: 'Sign Up', lostpass: 'Lost Password', changemail: 'Change Email' }[purpose],
        mail: 'test@example.com', nonce: 'testnonce', remaining: 2, maxAttempts: 3, hasCode: true,
        needsPassword: purpose === 'changemail', passwordLabel: "SuperUser's Password",
        emailLabel: purpose === 'changemail' ? 'New Email' : 'Email', backRoute: purpose === 'changemail' ? 'home_security' : null,
        retryAfter: 37, retryAfterMs: 37000, entryRoute: purpose, verifyRoute: purpose,
        error: 'The verification code is incorrect, expired, or has reached the attempt limit.', url: name => '/' + name,
      });
      const text = readText(html);
      assert.ok(text.includes(dictionaries[lang]['Email verification code']));
      assert.ok(text.includes(dictionaries[lang]['Please check your inbox. If you cannot find the email, check your spam folder.']));
      assert.ok(text.includes(dictionaries[lang]['Resend in {0}s'].replace('{0}', '37')));
      assert.ok(text.includes(dictionaries[lang]['The verification code is incorrect, expired, or has reached the attempt limit.']));
      if (lang === 'ko' || lang === 'en') assert.equal(/\p{Script=Han}/u.test(text), false, purpose + ': ' + text);
      if (lang === 'zh_TW') assert.equal(/验证|发送|密码|邮箱|剩余|请/.test(text), false, text);
    }
  });

  test(`${lang}: inherited mail body, title and footer follow Hydro's native translator`, () => {
    for (const purpose of ['register', 'lostpass', 'changemail']) {
      const html = mailEnv.render(`verification_${purpose}_mail.html`, {
        _: translate(lang), verificationCode: '012345', uname: 'tester',
        handler: { domain: { ui: { name: 'Test OJ' } }, request: { ip: '127.0.0.1' } },
        model: { system: { get: () => 'Test OJ' } }, url_prefix: 'https://oj.example.com',
      });
      const text = readText(html);
      assert.ok(text.includes('012345'));
      assert.ok(text.includes(dictionaries[lang]['Your email verification code:']));
      assert.ok(text.includes(dictionaries[lang]['This email was requested from {0}'].replace('{0}', '127.0.0.1')));
      if (lang === 'ko' || lang === 'en') assert.equal(/\p{Script=Han}/u.test(text), false, purpose + ': ' + text);
      if (lang === 'zh_TW') assert.equal(/验证|发送|密码|邮箱|请/.test(text), false, text);
    }
  });
}
