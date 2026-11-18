'use strict';

const assert = require('node:assert/strict');
const { before, after, beforeEach, test } = require('node:test');
const { createHmac, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const nunjucks = require('nunjucks');
const nativeSource = require('./helpers/native-sources.cjs');
const { VerificationStore, VerificationError, EXPIRE_SECONDS, RESEND_SECONDS } = require('../store');

let mongo;
let client;
let db;
let collection;
let store;
let now;
const domainId = 'system';
const purpose = 'register';
const input = (extra = {}) => ({ purpose, domainId, mail: 'test@example.com', mailKey: 'test@example.com', ...extra });
const activate = async extra => {
  const challenge = await store.issue(input(extra));
  assert.equal(await store.activate(challenge.session, domainId, extra?.purpose || purpose), true);
  return challenge;
};
const consume = (c, code = c.code) => store.consume(c.session, domainId, purpose, c.nonce, code);

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = client.db('verification_test');
  collection = db.collection('email.verification');
  store = new VerificationStore(collection, () => now);
  await store.init();
}, { timeout: 180000 });
after(async () => {
  await client?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  now = new Date();
  await collection.deleteMany({});
});

test('a pending email cannot be verified until SMTP delivery succeeds', async () => {
  const c = await store.issue(input());
  assert.match(c.code, /^[0-9]{6}$/);
  assert.equal(await store.get(c.session, domainId, purpose), null);
  assert.equal(await consume(c), null);
  assert.equal(await store.activate(c.session, domainId, purpose), true);
  const doc = await consume(c);
  assert.equal(doc.mail, 'test@example.com');
  assert.equal(await consume(c), null);
});

test('storage contains no plaintext code and public state omits hashes', async () => {
  const c = await activate();
  const raw = await collection.findOne({ _id: c.session.id });
  assert.equal(raw.code, undefined);
  assert.notEqual(raw.digest, c.code);
  assert.notEqual(raw.binding, c.session.secret);
  const doc = await store.get(c.session, domainId, purpose);
  assert.equal(doc.digest, undefined);
  assert.equal(doc.binding, undefined);
});

test('leading zeroes survive; numeric and malformed submissions fail', async () => {
  const c = await activate();
  await collection.updateOne({ _id: c.session.id }, { $set: {
    digest: createHmac('sha256', c.session.secret).update('012345').digest('hex'),
  } });
  assert.equal(await consume(c, 12345), null);
  assert.equal(await consume(c, '１２３４５６'), null);
  assert.ok(await consume(c, '012345'));
});

test('exact expiry is enforced even before TTL deletes the record', async () => {
  const c = await activate();
  now = new Date(now.getTime() + EXPIRE_SECONDS * 1000);
  assert.equal(await store.get(c.session, domainId, purpose), null);
  assert.equal(await consume(c), null);
  assert.equal(await collection.countDocuments(), 1);
});

test('six-digit codes are required and outstanding eight-digit challenges expire after the upgrade', async () => {
  const c = await activate();
  assert.equal(await consume(c, '12345678'), null);
  assert.equal(await consume(c, '12345'), null);
  assert.equal(await consume(c, '1234567'), null);
  assert.equal(await consume(c), null);
  now = new Date(now.getTime() + RESEND_SECONDS * 1000);
  const old = await activate();
  await collection.updateOne({ _id: old.session.id }, { $unset: { codeLength: '' } });
  assert.equal(await store.get(old.session, domainId, purpose), null);
  assert.equal(await consume(old), null);
});

test('three wrong attempts exhaust the code; another IP cannot reset the budget', async () => {
  const c = await activate();
  const wrong = c.code === '999999' ? '000000' : '999999';
  await Promise.all(Array.from({ length: 20 }, () => consume(c, wrong)));
  assert.equal((await collection.findOne({ _id: c.session.id })).attempts, 3);
  assert.equal(await consume(c), null);
});

test('the third attempt may succeed', async () => {
  const c = await activate();
  for (let i = 0; i < 2; i++) assert.equal(await consume(c, ''), null);
  assert.ok(await consume(c));
});

test('parallel correct submissions produce only one successful consumption', async () => {
  const c = await activate();
  const results = await Promise.all(Array.from({ length: 12 }, () => consume(c)));
  assert.equal(results.filter(Boolean).length, 1);
});

test('purpose, domain, browser session and form nonce cannot be substituted', async () => {
  const c = await activate();
  assert.equal(await store.consume(c.session, 'other', purpose, c.nonce, c.code), null);
  assert.equal(await store.consume(c.session, domainId, 'lostpass', c.nonce, c.code), null);
  assert.equal(await store.consume({ ...c.session, secret: randomBytes(32).toString('hex') }, domainId, purpose, c.nonce, c.code), null);
  assert.equal(await store.consume(c.session, domainId, purpose, 'f'.repeat(32), c.code), null);
  assert.equal((await collection.findOne({ _id: c.session.id })).attempts, 0);
  assert.ok(await consume(c));
});

test('resend uses a strict sliding lock shared by all workers', async () => {
  const c = await activate();
  now = new Date(now.getTime() + RESEND_SECONDS * 1000 - 1);
  await assert.rejects(store.issue(input()), VerificationError);
  now = new Date(now.getTime() + 1);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => store.issue(input())));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(await consume(c), null);
});

test('a slow SMTP delivery stays reserved and starts a full 30-second cooldown only on success', async () => {
  assert.equal(RESEND_SECONDS, 30);
  const c = await store.issue(input());
  now = new Date(now.getTime() + 65000);
  await assert.rejects(store.issue(input()), VerificationError);
  assert.equal(await store.activate(c.session, domainId, purpose), true);
  assert.equal((await store.get(c.session, domainId, purpose)).resendAt.getTime(), now.getTime() + 30000);
  // Repeated activation must not restart an already active cooldown.
  now = new Date(now.getTime() + 29999);
  assert.equal(await store.activate(c.session, domainId, purpose), false);
  await assert.rejects(store.issue(input()), VerificationError);
  now = new Date(now.getTime() + 1);
  assert.ok(await store.issue(input()));
});

test('expired pending deliveries may be replaced without letting stale completion or cleanup affect the replacement', async () => {
  const old = await store.issue(input());
  now = new Date(now.getTime() + EXPIRE_SECONDS * 1000);
  const next = await store.issue(input());
  assert.equal(await store.activate(old.session, domainId, purpose), false);
  await store.cancel(old.session, domainId, purpose);
  assert.equal(await store.activate(next.session, domainId, purpose), true);
  assert.ok(await consume(next));
});

test('resend invalidates the previous session and delayed cleanup cannot remove the new code', async () => {
  const first = await activate();
  now = new Date(now.getTime() + RESEND_SECONDS * 1000);
  const second = await activate();
  await store.cancel(first.session, domainId, purpose);
  assert.equal(await consume(first), null);
  assert.equal(await store.activate(first.session, domainId, purpose), false);
  assert.ok(await consume(second));
});

test('registration and recovery for the same mailbox have independent codes', async () => {
  const reg = await activate();
  const lost = await activate({ purpose: 'lostpass', uid: 42 });
  assert.notEqual(reg.session.id, lost.session.id);
  assert.ok(await consume(reg));
  assert.equal((await store.consume(lost.session, domainId, 'lostpass', lost.nonce, lost.code)).uid, 42);
});

test('invalid session values fail closed', async () => {
  for (const session of [null, {}, { id: ['a'.repeat(64)], secret: 'b'.repeat(64) }, { id: { $ne: null } }]) {
    assert.equal(await store.get(session, domainId, purpose), null);
    assert.equal(await store.consume(session, domainId, purpose, 'a'.repeat(32), '123456'), null);
  }
});

// Run the real plugin with a minimal Hydro adapter and real MongoDB.
async function plugin(translate = s => s, clock) {
  const hooks = new Map();
  const routes = new Map();
  const users = new Map();
  const passwordChecks = [];
  const actors = new Map();
  const actor = (uid, mail) => ({ _id: uid, mail, uname: `user${uid}`, checkPassword: async password => {
    passwordChecks.push({ uid, password });
    if (password !== 'current-password') throw new Error('Wrong password');
  } });
  actors.set(42, actor(42, 'old@example.com'));
  actors.set(99, actor(99, 'other@example.com'));
  const settings = { 'smtp.verify': true, 'smtp.user': 'smtp@example.com', 'server.login': true, 'server.url': 'https://oj.example.com/', 'server.name': 'Test OJ' };
  const sent = [];
  const tokens = [];
  const logs = [];
  const blocked = new Set();
  const transport = { fail: false };
  class NamedError extends Error { msg() { return this.message; } }
  const api = {
    Handler: class {},
    UserFacingError: NamedError,
    SystemModel: { get: key => settings[key] },
    PRIV: { PRIV_REGISTER_USER: 4, PRIV_USER_PROFILE: 8 },
    Types: {
      Email: [s => s.trim(), s => /^[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(s.trim())],
      Password: [s => s, s => typeof s === 'string' && s.length >= 6 && s.length <= 255],
    },
    requireSudo: (_, __, descriptor) => {
      const method = descriptor.value;
      descriptor.value = function (...args) {
        if (this.session.sudo && Date.now() - this.session.sudo < 3600000) return method.apply(this, args);
        this.response.redirect = this.url('user_sudo');
        return 'cleanup';
      };
    },
    UserModel: {
      getByEmail: async (_, mail) => users.get(mail.toLowerCase()),
      getById: async (_, uid) => actors.get(uid),
      _handleMailLower: mail => { const [n, d] = mail.toLowerCase().split('@'); return n.split('+')[0].replace(/\./g, '') + '@' + (d === 'googlemail.com' ? 'gmail.com' : d); },
    },
    BlackListModel: { get: async key => blocked.has(key) },
    OplogModel: { log: async (_, type) => logs.push(type) },
    TokenModel: { TYPE_REGISTRATION: 2, TYPE_CHANGEMAIL: 3, TYPE_LOSTPASS: 5, add: async (type, expiry, data) => {
      const id = randomBytes(24).toString('hex'); tokens.push({ type, expiry, data, id }); return [id];
    } },
    sendMail: async (...args) => {
      if (transport.fail) throw new Error('SMTP failed');
      await transport.beforeSend?.();
      sent.push(args);
    },
  };
  for (const key of ['BlacklistedError', 'BuiltinLoginError', 'UserAlreadyExistError', 'UserNotFoundError', 'ValidationError', 'SystemError']) api[key] = class extends NamedError { constructor(...args) { super(key); this.params = args; } };
  const req = createRequire(path.resolve(__dirname, '../index.js'));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8'), {
    require: id => {
      if (id === 'hydrooj') return api;
      if (id === './store' && clock) return {
        ...req(id), VerificationStore: class extends VerificationStore {
          constructor(coll) { super(coll, clock); }
        },
      };
      return req(id);
    },
    Date: clock ? { now: () => clock().getTime() } : Date,
    module, exports: module.exports, Buffer, console,
  }, { filename: 'hydrooj-verification/index.js' });
  await module.exports.apply({
    db: { collection: name => db.collection(name) },
    i18n: { load() {} },
    on: (event, callback) => hooks.set(event, callback),
    Route: (name, route, Handler, ...checks) => routes.set(name, { route, Handler, checks }),
  });
  function handler(purpose, session = {}, body = {}) {
    const route = routes.get(`verification_${purpose}`);
    return Object.assign(new route.Handler(), {
      session, args: { domainId }, domain: { ui: { name: 'Test OJ' }, host: ['https://oj.example.com/'], registerRedirect: '/welcome' },
      user: actors.get(42),
      request: { body }, response: {}, rates: [],
      translate,
      limitRate: async function (...args) { this.rates.push(args); },
      renderHTML: async (template, data) => `${template} ${data.verificationCode}`,
      url: (name, args) => '/' + name + (args?.code ? '/' + args.code : ''),
    });
  }
  async function send(purpose, mail, session = {}, json = false) {
    const h = handler(purpose, session, { mail });
    h.request.json = json;
    hooks.get(`handler/before/${purpose === 'register' ? 'UserRegister' : 'UserLostPass'}#post`)(h);
    await h.post();
    return h;
  }
  return { api, hooks, routes, users, settings, sent, tokens, logs, blocked, transport, handler, send, actors, passwordChecks };
}

for (const purpose of ['register', 'lostpass', 'changemail']) {
  test(`${purpose}: SMTP delay does not shorten the 30-second resend cooldown`, async () => {
    const p = await plugin(undefined, () => now);
    if (purpose === 'lostpass') p.users.set('test@example.com', { _id: 42, uname: 'tester' });
    p.transport.beforeSend = async () => { now = new Date(now.getTime() + 6000); };
    const sent = purpose === 'changemail' ? await sendChange(p) : await p.send(purpose, 'test@example.com', {}, true);
    assert.equal(sent.response.body.retryAfterMs, 30000);
    assert.equal(sent.response.body.resendIntervalMs, 30000);
    assert.equal(sent.rates[0][0], 'send_mail');
    assert.equal(sent.rates[0][1], 30);
    assert.equal(sent.rates[0][2], 1);
    assert.deepEqual(Array.from(sent.rates[1]), ['send_mail', 3600, 30]);
    const doc = await collection.findOne({ purpose });
    assert.equal(doc.active, true);
    assert.equal(doc.resendAt.getTime(), now.getTime() + 30000);
    now = new Date(now.getTime() + 7000);
    const restored = p.handler(purpose, sent.session);
    await restored.get();
    assert.equal(restored.response.body.retryAfterMs, 23000);
    assert.equal(p.sent.length, 1);
  });
}

for (const purpose of ['register', 'lostpass']) {
  test(`${purpose}: combined page restores pending state, JSON sends stay inline, and mail changes need a new challenge`, async () => {
    const p = await plugin();
    if (purpose === 'lostpass') p.users.set('test@example.com', { _id: 42, uname: 'tester' });
    const initial = p.handler(purpose);
    p.hooks.get(`handler/before/${purpose === 'register' ? 'UserRegister' : 'UserLostPass'}#get`)(initial);
    await initial.get();
    assert.equal(initial.response.template, 'verification_code.html');
    assert.equal(initial.response.body.hasCode, false);
    const sent = await p.send(purpose, 'test@example.com', {}, true);
    assert.equal(sent.response.redirect, undefined);
    assert.equal(sent.response.body.hasCode, true);
    assert.equal(sent.response.body.mail, 'test@example.com');
    assert.ok(sent.response.body.retryAfterMs > 0 && sent.response.body.retryAfterMs <= RESEND_SECONDS * 1000);
    assert.equal(sent.response.body.secret, undefined);
    assert.equal(sent.response.body.digest, undefined);
    assert.equal(p.tokens.length, 0);
    const restored = p.handler(purpose, sent.session);
    p.hooks.get(`handler/before/${purpose === 'register' ? 'UserRegister' : 'UserLostPass'}#get`)(restored);
    await restored.get();
    assert.equal(restored.response.body.nonce, sent.response.body.nonce);
    const cooldown = await p.send(purpose, 'test@example.com', sent.session, true);
    assert.equal(cooldown.response.status, 400);
    assert.equal(typeof cooldown.response.body.error, 'string');
    assert.equal(cooldown.response.body.hasCode, true);
    assert.equal(p.sent.length, 1);
    const verify = p.handler(purpose, sent.session, {
      mail: 'changed@example.com', __challenge: sent.response.body.nonce,
      __verificationCode: p.sent[0][2].match(/\b[0-9]{6}\b/)[0],
    });
    verify.request.json = true;
    await verify.post();
    assert.equal(verify.response.status, 400);
    assert.equal(verify.response.body.remaining, 3);
    assert.equal(p.tokens.length, 0);
  });

  test(`${purpose}: email -> code -> native form, without issuing a token before verification`, async () => {
    const p = await plugin();
    if (purpose === 'lostpass') p.users.set('test@example.com', { _id: 42, uname: 'tester' });
    const sent = await p.send(purpose, 'test@example.com');
    assert.equal(p.tokens.length, 0);
    assert.equal(p.sent[0][1], purpose === 'register' ? 'Sign Up' : 'Lost Password');
    const code = p.sent[0][2].match(/\b[0-9]{6}\b/)[0];
    assert.ok(p.sent[0][3].includes(code));
    assert.equal(p.logs[0], purpose === 'register' ? 'user.register' : 'user.lostpass');
    assert.equal(sent.rates[0][0], 'send_mail');
    const h = p.handler(purpose, sent.session);
    await h.get();
    const nonce = h.response.body.nonce;
    h.request.body = { __challenge: nonce, __verificationCode: code };
    await h.post();
    assert.equal(p.tokens.length, 1);
    assert.equal(p.tokens[0].type, purpose === 'register' ? 2 : 5);
    assert.equal(h.response.redirect, `/${purpose === 'register' ? 'user_register_with_code' : 'user_lostpass_with_code'}/${p.tokens[0].id}`);
    if (purpose === 'register') {
      assert.equal(p.tokens[0].data.redirect, '/welcome');
      assert.equal(p.tokens[0].data.identity.platform, 'mail');
    } else assert.equal(p.tokens[0].data.uid, 42);
    const replay = p.handler(purpose, sent.session, { __challenge: nonce, __verificationCode: code });
    await replay.post();
    assert.equal(replay.response.status, 400);
    assert.equal(p.tokens.length, 1);
  });
}

test('registration disabled setting leaves native registration intact while recovery still uses codes', async () => {
  const p = await plugin();
  p.settings['smtp.verify'] = false;
  const h = p.handler('register');
  const original = h.get;
  p.hooks.get('handler/before/UserRegister#get')(h);
  assert.equal(h.get, original);
  assert.equal(await h.prepare(), 'after');
  const lost = p.handler('lostpass');
  p.hooks.get('handler/before/UserLostPass#get')(lost);
  await lost.get();
  assert.equal(lost.response.template, 'verification_code.html');
});

test('SMTP/account/blacklist checks retain native registration and recovery rules', async () => {
  const p = await plugin();
  p.users.set('exists@example.com', { _id: 42, uname: 'exists' });
  await assert.rejects(p.send('register', 'exists@example.com'), p.api.UserAlreadyExistError);
  await assert.rejects(p.send('lostpass', 'missing@example.com'), p.api.UserNotFoundError);
  p.blocked.add('mail::blocked.com');
  await assert.rejects(p.send('register', 'new@BLOCKED.com'), p.api.BlacklistedError);
  await assert.rejects(p.send('register', { $ne: null }), p.api.ValidationError);
  p.settings['smtp.user'] = '';
  await assert.rejects(p.send('register', 'test@example.com'), p.api.SystemError);
  assert.equal(p.tokens.length, 0);
  assert.equal(p.sent.length, 0);
});

test('SMTP failure removes the pending challenge and does not issue a native token', async () => {
  const p = await plugin();
  p.transport.fail = true;
  await assert.rejects(p.send('register', 'test@example.com'), /SMTP failed/);
  assert.equal(await collection.countDocuments(), 0);
  assert.equal(p.tokens.length, 0);
});

test('wrong code stays on the form, consumes attempts, and does not expose the code', async () => {
  const p = await plugin();
  const sent = await p.send('register', 'test@example.com');
  const h = p.handler('register', sent.session);
  await h.get();
  h.request.body = { __challenge: h.response.body.nonce, __verificationCode: 'bad-code' };
  await h.post();
  assert.equal(h.response.status, 400);
  assert.equal(h.response.body.remaining, 2);
  assert.equal(h.response.body.digest, undefined);
  assert.equal(h.response.body.__verificationCode, undefined);
  assert.equal(p.tokens.length, 0);
});

test('a stale form cannot consume attempts belonging to the resent challenge', async () => {
  const p = await plugin();
  const sent = await p.send('register', 'test@example.com');
  const h = p.handler('register', sent.session);
  await h.get();
  const oldNonce = h.response.body.nonce;
  await collection.updateMany({}, { $set: { resendAt: new Date(0) } });
  h.request.body = { action: 'resend', __challenge: oldNonce };
  await h.post();
  assert.equal(p.sent.length, 2);
  h.request.body = { __challenge: oldNonce, __verificationCode: '000000' };
  await h.post();
  assert.equal(h.response.status, 400);
  assert.equal(h.response.body.remaining, 3);
});

test('recovery cannot reset an account that changed email while code was outstanding', async () => {
  const p = await plugin();
  p.users.set('test@example.com', { _id: 42, uname: 'tester' });
  const sent = await p.send('lostpass', 'test@example.com');
  p.users.set('test@example.com', { _id: 99, uname: 'replacement' });
  const h = p.handler('lostpass', sent.session);
  await h.get();
  h.request.body = { __challenge: h.response.body.nonce, __verificationCode: p.sent[0][2].match(/\b[0-9]{6}\b/)[0] };
  await assert.rejects(h.post(), p.api.UserNotFoundError);
  assert.equal(p.tokens.length, 0);
});

test('verification routes match native registration privileges, and recovery needs no registration privilege', async () => {
  const p = await plugin();
  assert.deepEqual(p.routes.get('verification_register').checks, [4]);
  assert.deepEqual(p.routes.get('verification_lostpass').checks, []);
  p.settings['server.login'] = false;
  await assert.rejects(p.handler('register').prepare(), p.api.BuiltinLoginError);
  assert.equal(await p.handler('lostpass').prepare(), undefined);
});

test('mail templates inherit native titles, layout, footer, username and escaping', () => {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader([
    path.resolve(__dirname, '../templates'),
    nativeSource('ui-default/templates'),
  ]), { autoescape: true });
  const translate = s => new String(s); // Hydro normally provides String.prototype.format.
  const format = String.prototype.format;
  String.prototype.format = function (...args) { return this.replace(/\{(\d+)\}/g, (_, i) => args[i]); };
  try {
    const data = {
      _: translate, verificationCode: '012345', uname: '<script>tester</script>',
      handler: { domain: { ui: { name: 'Test OJ' } }, request: { ip: '127.0.0.1' } },
      model: { system: { get: () => 'Test OJ' } }, url_prefix: 'https://oj.example.com',
    };
    for (const flow of ['register', 'lostpass', 'changemail']) {
      const html = env.render(`verification_${flow}_mail.html`, data);
      assert.ok(html.includes('012345'));
      assert.ok(html.includes('hydro-header'));
      assert.ok(html.includes('hydro-footer'));
      assert.ok(html.includes(flow === 'register' ? 'Sign Up' : flow === 'lostpass' ? 'Lost Password' : 'Change Email'));
      assert.equal(/\/register\/|\/lostpass\/|\/home\/changeMail\//.test(html), false);
      if (flow !== 'register') {
        assert.ok(html.includes('&lt;script&gt;tester&lt;/script&gt;'));
        assert.equal(html.includes('<script>tester</script>'), false);
      }
    }
    // The full site layout needs Hydro's live context; render this form with a minimal layout.
    const layoutLoader = new nunjucks.Loader();
    layoutLoader.getSource = name => name === 'layout/immersive.html'
      ? { src: '{% block content %}{% endblock %}', path: name, noCache: true } : null;
    const forms = new nunjucks.Environment([layoutLoader, new nunjucks.FileSystemLoader(path.resolve(__dirname, '../templates'))], { autoescape: true });
    const html = forms.render('verification_code.html', {
      ...data, title: 'Lost Password', mail: '<test@example.com>', nonce: 'abc', remaining: 3, maxAttempts: 3, retryAfter: 30,
      entryRoute: 'user_lostpass', verifyRoute: 'verification_lostpass', url: name => '/' + name,
    });
    assert.ok(html.includes('inputmode="numeric"'));
    assert.ok(html.includes('autocomplete="one-time-code"'));
    assert.ok(html.includes('pattern="[0-9]{6}" minlength="6" maxlength="6"'));
    assert.ok(html.includes('&lt;test@example.com&gt;'));
  } finally {
    if (format) String.prototype.format = format;
    else delete String.prototype.format;
  }
});

async function sendChange(p, { session = { sudo: Date.now() }, mail = 'new@example.com', password = 'current-password' } = {}) {
  const h = p.handler('changemail', session, { action: 'send', mail, password });
  h.request.json = true;
  const control = await h.prepare();
  if (!control) await h.post();
  return h;
}

function confirmChange(p, sent) {
  const h = p.handler('changemail', sent.session, {
    mail: sent.response.body.mail,
    __challenge: sent.response.body.nonce,
    __verificationCode: p.sent.at(-1)[2].match(/\b[0-9]{6}\b/)[0],
  });
  h.request.json = true;
  return h;
}

test('email changes require profile permission and the native sudo guard before any mail is sent', async () => {
  const p = await plugin();
  assert.deepEqual(p.routes.get('verification_changemail').checks, [p.api.PRIV.PRIV_USER_PROFILE]);
  for (const session of [{}, { sudo: Date.now() - 3600001 }]) {
    const h = await sendChange(p, { session });
    assert.equal(h.response.redirect, '/user_sudo');
  }
  assert.equal(p.sent.length, 0);
  assert.equal(p.passwordChecks.length, 0);
  assert.equal(await collection.countDocuments(), 0);
});

test('new email requires the current password and only grants a native email-change token after OTP verification', async () => {
  const p = await plugin();
  const sent = await sendChange(p);
  assert.equal(p.passwordChecks[0].uid, 42);
  assert.equal(p.sent[0][0], 'new@example.com');
  assert.equal(p.sent[0][1], 'Change Email');
  assert.equal(sent.response.body.needsPassword, true);
  assert.equal(sent.response.body.emailLabel, 'New Email');
  assert.equal(p.tokens.length, 0);
  assert.equal(p.actors.get(42).mail, 'old@example.com');
  const verify = confirmChange(p, sent);
  await verify.post();
  assert.equal(p.tokens.length, 1);
  assert.equal(p.tokens[0].type, 3);
  assert.equal(p.tokens[0].data.uid, 42);
  assert.equal(p.tokens[0].data.email, 'new@example.com');
  assert.ok(verify.response.redirect.startsWith('/user_changemail_with_code/'));
  // The original native handler, reached by this redirect, owns the actual account mutation.
  assert.equal(p.actors.get(42).mail, 'old@example.com');
  await verify.post();
  assert.equal(verify.response.status, 400);
  assert.equal(p.tokens.length, 1);
});

test('wrong password, used new email and blacklisted domain cannot send a change-email code', async () => {
  const p = await plugin();
  await assert.rejects(sendChange(p, { password: 'wrong-password' }), /Wrong password/);
  p.users.set('new@example.com', { _id: 99 });
  const used = await sendChange(p);
  assert.equal(used.response.status, 400);
  p.users.clear();
  p.blocked.add('mail::example.com');
  const blocked = await sendChange(p);
  assert.equal(blocked.response.status, 400);
  assert.equal(p.sent.length, 0);
  assert.equal(p.tokens.length, 0);
});

test('email-change challenges cannot be used by another account, impersonation identity or source email', async () => {
  const p = await plugin();
  const sent = await sendChange(p);
  for (const mutate of [
    h => { h.user = p.actors.get(99); },
    h => { h.session = { ...h.session, sudoUid: 99 }; },
    h => { h.user = { ...h.user, mail: 'changed-before-verify@example.com' }; },
  ]) {
    const h = confirmChange(p, sent);
    mutate(h);
    await h.post();
    assert.equal(h.response.status, 400);
  }
  assert.equal(p.tokens.length, 0);
  assert.equal((await collection.findOne({ purpose: 'changemail' })).attempts, 0);
  await confirmChange(p, sent).post();
  assert.equal(p.tokens[0].data.uid, 42);
});

test('impersonation verifies the actual operator password and still targets the viewed account', async () => {
  const p = await plugin();
  const sent = await sendChange(p, { session: { sudo: Date.now(), sudoUid: 99 } });
  assert.equal(p.passwordChecks[0].uid, 99);
  assert.equal(sent.response.body.passwordLabel, "SuperUser's Password");
  await confirmChange(p, sent).post();
  assert.equal(p.tokens[0].data.uid, 42);
});

test('same-email resends reuse the password proof; a different or expired target needs password verification again', async () => {
  const p = await plugin();
  const first = await sendChange(p);
  await collection.updateMany({}, { $set: { resendAt: new Date(0) } });
  const resent = await sendChange(p, { session: first.session, password: '' });
  assert.equal(p.sent.length, 2);
  assert.equal(p.passwordChecks.length, 1);
  assert.notEqual(resent.response.body.nonce, first.response.body.nonce);
  const different = await sendChange(p, { session: first.session, mail: 'different@example.com', password: '' });
  assert.equal(different.response.status, 400);
  await collection.updateMany({}, { $set: { expireAt: new Date(0) } });
  const expired = await sendChange(p, { session: first.session, password: '' });
  assert.equal(expired.response.status, 400);
  assert.equal(p.sent.length, 2);
});

test('new email ownership and blacklist are rechecked just before granting a native change token', async () => {
  const p = await plugin();
  const first = await sendChange(p);
  p.users.set('new@example.com', { _id: 99 });
  const used = confirmChange(p, first);
  await used.post();
  assert.equal(used.response.status, 400);
  assert.equal(used.response.body.error, 'UserAlreadyExistError');
  p.users.clear();
  const second = await sendChange(p);
  p.blocked.add('mail::example.com');
  const blocked = confirmChange(p, second);
  await blocked.post();
  assert.equal(blocked.response.status, 400);
  assert.equal(blocked.response.body.error, 'BlacklistedError');
  assert.equal(p.tokens.length, 0);
  assert.equal(p.actors.get(42).mail, 'old@example.com');
});

test('legacy security-page change requests retain sudo protection and the security page retains its native page name', async () => {
  const p = await plugin();
  const h = p.handler('changemail', {}, { operation: 'change_mail', mail: 'new@example.com', password: 'current-password' });
  p.hooks.get('handler/before/HomeSecurity#post')(h);
  assert.equal(await h.postChangeMail(), 'cleanup');
  assert.equal(p.sent.length, 0);
  h.session.sudo = Date.now();
  await h.postChangeMail();
  assert.equal(p.sent.length, 1);
  assert.equal(h.response.redirect, '/verification_changemail');
  const page = p.handler('changemail', h.session);
  page.response.template = 'home_security.html';
  page.response.body = { sessions: ['native-session-list'] };
  await p.hooks.get('handler/after/HomeSecurity#get')(page);
  assert.equal(page.response.body.page_name, 'home_security');
  assert.deepEqual(page.response.body.sessions, ['native-session-list']);
  assert.equal(page.response.body.verificationPendingMail, 'new@example.com');
  assert.equal(page.response.template, 'verification_home_security.html');
  const other = p.handler('changemail', {}, { operation: 'delete_token' });
  const original = () => {};
  other.postChangeMail = original;
  p.hooks.get('handler/before/HomeSecurity#post')(other);
  assert.equal(other.postChangeMail, original);
});

test('all three purposes may coexist in one browser session and finish independently', async () => {
  const p = await plugin();
  const session = { sudo: Date.now() };
  p.users.set('recover@example.com', { _id: 77, uname: 'recovery-user' });
  const signup = await p.send('register', 'signup@example.com', session, true);
  const recovery = await p.send('lostpass', 'recover@example.com', session, true);
  const change = await sendChange(p, { session, mail: 'new@example.com' });
  const cases = [
    { purpose: 'lostpass', sent: recovery, mailIndex: 1, tokenType: 5, route: 'user_lostpass_with_code' },
    { purpose: 'changemail', sent: change, mailIndex: 2, tokenType: 3, route: 'user_changemail_with_code' },
    { purpose: 'register', sent: signup, mailIndex: 0, tokenType: 2, route: 'user_register_with_code' },
  ];
  assert.equal(p.tokens.length, 0);
  assert.equal(await collection.countDocuments(), 3);
  for (const item of cases) {
    const h = p.handler(item.purpose, session, {
      mail: item.sent.response.body.mail,
      __challenge: item.sent.response.body.nonce,
      __verificationCode: p.sent[item.mailIndex][2].match(/\b[0-9]{6}\b/)[0],
    });
    h.request.json = true;
    await h.post();
    assert.equal(p.tokens.at(-1).type, item.tokenType);
    assert.ok(h.response.redirect.startsWith('/' + item.route + '/'));
    assert.equal(session['emailVerification_' + item.purpose], null);
    for (const remaining of cases.slice(cases.indexOf(item) + 1)) {
      assert.ok(session['emailVerification_' + remaining.purpose]);
    }
  }
  assert.equal(await collection.countDocuments(), 0);
  assert.equal(p.passwordChecks.length, 1);
  assert.equal(p.actors.get(42).mail, 'old@example.com');
});

test('cross-purpose challenge substitution is rejected in all six directions without consuming attempts', async () => {
  const purposes = ['register', 'lostpass', 'changemail'];
  const challenges = {};
  for (const purpose of purposes) challenges[purpose] = await activate({ purpose, uid: purpose === 'register' ? undefined : 42 });
  for (const source of purposes) for (const target of purposes) {
    if (source === target) continue;
    const c = challenges[source];
    assert.equal(await store.consume(c.session, domainId, target, c.nonce, c.code), null);
  }
  for (const purpose of purposes) {
    const c = challenges[purpose];
    assert.equal((await store.get(c.session, domainId, purpose)).attempts, 0);
    assert.ok(await store.consume(c.session, domainId, purpose, c.nonce, c.code));
  }
});

test('disabling registration email verification leaves both recovery and change-email verification enabled', async () => {
  const p = await plugin();
  p.settings['smtp.verify'] = false;
  const registration = p.handler('register');
  const originalGet = () => 'native-register-get';
  const originalPost = () => 'native-register-post';
  registration.get = originalGet;
  registration.post = originalPost;
  p.hooks.get('handler/before/UserRegister#get')(registration);
  p.hooks.get('handler/before/UserRegister#post')(registration);
  assert.equal(registration.get, originalGet);
  assert.equal(registration.post, originalPost);
  p.users.set('recover@example.com', { _id: 77, uname: 'recovery-user' });
  const recovery = await p.send('lostpass', 'recover@example.com', {}, true);
  const change = await sendChange(p);
  assert.equal(recovery.response.body.hasCode, true);
  assert.equal(change.response.body.hasCode, true);
  assert.equal(p.sent.length, 2);
  assert.equal(p.passwordChecks.length, 1);
  assert.equal(p.tokens.length, 0);
});

test('a failed mail send in another module does not invalidate a pending registration challenge', async () => {
  const p = await plugin();
  const session = { sudo: Date.now() };
  const signup = await p.send('register', 'signup@example.com', session, true);
  const signupCode = p.sent[0][2].match(/\b[0-9]{6}\b/)[0];
  p.users.set('recover@example.com', { _id: 77, uname: 'recovery-user' });
  p.transport.fail = true;
  await assert.rejects(p.send('lostpass', 'recover@example.com', session, true), /SMTP failed/);
  await assert.rejects(sendChange(p, { session }), /SMTP failed/);
  assert.equal(await collection.countDocuments(), 1);
  const verify = p.handler('register', session, {
    mail: signup.response.body.mail, __challenge: signup.response.body.nonce, __verificationCode: signupCode,
  });
  await verify.post();
  assert.equal(p.tokens[0].type, 2);
  assert.equal(p.actors.get(42).mail, 'old@example.com');
});

for (const language of ['en', 'zh', 'zh_TW', 'ko']) {
  test(`${language}: native mail language selection, fixed subjects and JSON validation errors are preserved`, async () => {
    const native = require('./helpers/native-i18n.cjs')();
    const dictionary = require('../locales/' + language + '.json');
    const p = await plugin(key => native.translate(key, [language, 'zh']));
    p.api.ValidationError.prototype.msg = () => 'Field {0} validation failed.';
    p.api.UserAlreadyExistError.prototype.msg = () => 'User {0} already exists.';
    const invalid = await p.send('register', 'invalid-address', {}, true);
    assert.equal(invalid.response.body.error, dictionary['Field {0} validation failed.'].replace('{0}', dictionary.Email));
    assert.equal(invalid.response.body.errorField, 'mail');
    assert.equal(invalid.response.body.mail, 'invalid-address');
    p.users.set('recover@example.com', { _id: 77, uname: 'tester' });
    const session = { sudo: Date.now() };
    const registered = await p.send('register', 'signup@example.com', session, true);
    await p.send('lostpass', 'recover@example.com', session, true);
    await sendChange(p, { session });
    assert.deepEqual(p.sent.map(mail => mail[1]), ['Sign Up', 'Lost Password', 'Change Email']);
    for (const mail of p.sent) {
      assert.ok(mail[2].includes(dictionary['Your email verification code:']));
      assert.ok(mail[2].includes(dictionary['The code expires in 10 minutes. Do not share it with anyone.']));
      if (language === 'ko' || language === 'en') assert.equal(/\p{Script=Han}/u.test(mail[2]), false);
    }
    // Account state can change while the user is reading the email. This error
    // must be localized as well, while still rejecting the registration.
    p.users.set('signup@example.com', { _id: 88, uname: 'taken' });
    const verify = p.handler('register', session, {
      mail: registered.response.body.mail,
      __challenge: registered.response.body.nonce,
      __verificationCode: p.sent[0][2].match(/\b[0-9]{6}\b/)[0],
    });
    verify.request.json = true;
    await verify.post();
    assert.equal(verify.response.status, 400);
    assert.equal(verify.response.body.error, dictionary['User {0} already exists.'].replace('{0}', 'signup@example.com'));
    assert.equal(verify.response.body.errorField, 'mail');
    assert.equal(p.tokens.length, 0);
  });
}

test('all three modules identify email errors independently of their translated text', async () => {
  const p = await plugin(() => '모든 오류에 같은 번역');
  p.users.set('taken@example.com', { _id: 77, uname: 'taken' });
  const requests = [
    await p.send('register', 'taken@example.com', {}, true),
    await p.send('lostpass', 'missing@example.com', {}, true),
    await sendChange(p, { mail: 'taken@example.com' }),
  ];
  for (const h of requests) {
    assert.equal(h.response.body.errorField, 'mail');
    assert.equal(h.response.body.error, '모든 오류에 같은 번역');
    assert.equal(h.response.status, 400);
  }
  assert.equal(p.sent.length, 0);
});

test('password and send-limit failures identify their own controls without consuming verification attempts', async () => {
  const p = await plugin();
  p.actors.get(42).checkPassword = async () => {
    const error = new p.api.UserFacingError('Invalid password for user {0}.');
    error.params = ['user42'];
    throw error;
  };
  const password = await sendChange(p);
  assert.equal(password.response.body.errorField, 'password');
  const h = p.handler('register', {}, { mail: 'test@example.com' });
  h.request.json = true;
  h.limitRate = async () => {
    const error = new p.api.UserFacingError('Too frequent operations of {0} (limit: {2} operations in {1} seconds).');
    error.params = ['send_mail', 30, 1];
    throw error;
  };
  p.hooks.get('handler/before/UserRegister#post')(h);
  await h.post();
  assert.equal(h.response.body.errorField, 'send');
  assert.equal(p.sent.length, 0);
  assert.equal(await collection.countDocuments(), 0);
});
