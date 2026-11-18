'use strict';

const {
  BlackListModel, BlacklistedError, BuiltinLoginError, Handler, OplogModel, PRIV, SystemError,
  SystemModel, TokenModel, Types, UserAlreadyExistError, UserFacingError, UserModel, UserNotFoundError, ValidationError, requireSudo, sendMail,
} = require('hydrooj');
const { VerificationStore, VerificationError, EXPIRE_SECONDS, RESEND_SECONDS, MAX_ATTEMPTS } = require('./store');

const FLOWS = {
  register: { handler: 'UserRegister', title: 'Sign Up', entry: 'user_register', next: 'user_register_with_code', log: 'user.register' },
  lostpass: { handler: 'UserLostPass', title: 'Lost Password', entry: 'user_lostpass', next: 'user_lostpass_with_code', log: 'user.lostpass' },
  changemail: { title: 'Change Email', entry: 'verification_changemail', next: 'user_changemail_with_code', log: 'user.changemail' },
};
const sessionKey = purpose => `emailVerification_${purpose}`;
const resetKey = purpose => `emailVerificationReset_${purpose}`;
const EXHAUSTED_MESSAGE = 'All verification attempts have been used. Please request a new code.';
const enabled = purpose => purpose !== 'register' || !!SystemModel.get('smtp.verify');

function withSudo(method) {
  const descriptor = { value: method, configurable: true, writable: true };
  requireSudo({}, 'verification', descriptor);
  return descriptor.value;
}

exports.apply = async (ctx) => {
  const store = new VerificationStore(ctx.db.collection('email.verification'));
  await store.init();
  require('./locales')(ctx);

  function ownsChange(handler, doc) {
    return !!doc && doc.uid === handler.user._id
      && doc.authorizerUid === (handler.session.sudoUid || null)
      && doc.sourceMail === handler.user.mail;
  }

  async function pending(handler, purpose) {
    const doc = await store.get(handler.session[sessionKey(purpose)], handler.args.domainId, purpose);
    return purpose !== 'changemail' || ownsChange(handler, doc) ? doc : null;
  }

  function resetNotice(handler, purpose) {
    const notice = handler.session[resetKey(purpose)];
    if (!notice || notice.expireAt <= Date.now() || (purpose === 'changemail' && !ownsChange(handler, notice))) return null;
    return notice;
  }

  async function redirectExhausted(handler, purpose, session, nonce) {
    const doc = await store.getRevoked(session, handler.args.domainId, purpose);
    if (!doc || (nonce !== undefined && doc.nonce !== nonce) || (purpose === 'changemail' && !ownsChange(handler, doc))) return false;
    const currentSession = handler.session[sessionKey(purpose)];
    if (currentSession?.id !== session.id || currentSession?.secret !== session.secret) return false;
    handler.session[resetKey(purpose)] = {
      mail: doc.mail, resendAt: doc.resendAt.getTime(), expireAt: doc.expireAt.getTime(),
      uid: doc.uid, sourceMail: doc.sourceMail, authorizerUid: doc.authorizerUid,
    };
    handler.session[sessionKey(purpose)] = null;
    const url = handler.url(FLOWS[purpose].entry);
    handler.response.body = {
      url, resetVerification: true, hasCode: false, mail: doc.mail, nonce: '', remaining: 0,
      retryAfterMs: Math.max(0, doc.resendAt.getTime() - Date.now()),
    };
    handler.response.status = handler.request.json ? 200 : 303;
    handler.response.redirect = url;
    return true;
  }

  function show(handler, purpose, doc, error, errorField = 'code') {
    const notice = doc ? null : resetNotice(handler, purpose);
    const retryAfterMs = Math.max(0, (doc?.resendAt.getTime() || notice?.resendAt || 0) - Date.now());
    if (!error && notice) { error = EXHAUSTED_MESSAGE; errorField = 'send'; }
    handler.response.template = 'verification_code.html';
    handler.response.body = {
      title: FLOWS[purpose].title,
      entryRoute: FLOWS[purpose].entry,
      verifyRoute: `verification_${purpose}`,
      useCaptcha: purpose === 'register',
      hasCode: !!doc,
      maxAttempts: MAX_ATTEMPTS,
      needsPassword: purpose === 'changemail',
      emailLabel: purpose === 'changemail' ? 'New Email' : 'Email',
      passwordLabel: handler.session.sudoUid ? "SuperUser's Password" : 'Current Password',
      backRoute: purpose === 'changemail' ? 'home_security' : null,
      mail: doc?.mail || notice?.mail,
      nonce: doc?.nonce,
      remaining: doc ? Math.max(0, MAX_ATTEMPTS - doc.attempts) : 0,
      retryAfter: Math.ceil(retryAfterMs / 1000),
      retryAfterMs,
      resendIntervalMs: RESEND_SECONDS * 1000,
      error: error ? handler.translate(error) : undefined,
      errorField: error ? errorField : undefined,
    };
  }

  async function showSendError(handler, purpose, error) {
    if (!handler.request.json || !(error instanceof VerificationError || error instanceof UserFacingError)) throw error;
    const key = error instanceof VerificationError ? error.message : error.msg();
    // Classify the untranslated error, never the localized display message.
    let errorField = 'form';
    if (key.startsWith('Field ')) {
      const fields = { mail: 'mail', password: 'password', __verificationCode: 'code' };
      if (Object.hasOwn(fields, error.params?.[0])) errorField = fields[error.params[0]];
    } else if (error instanceof UserAlreadyExistError || error instanceof BlacklistedError
      || (error instanceof UserNotFoundError && typeof error.params?.[0] === 'string')) {
      errorField = 'mail';
    } else if (key === 'Invalid password for user {0}.' || key === "Current password doesn't match.") {
      errorField = 'password';
    } else if (key.startsWith('Too frequent operations of ') || key === 'Please wait 30 seconds before requesting another code.') {
      errorField = 'send';
    } else if (error instanceof VerificationError) errorField = 'code';
    const labels = key.startsWith('Field ') ? {
      mail: 'Email', password: handler.session.sudoUid ? "SuperUser's Password" : 'Current Password',
      __verificationCode: 'Email verification code',
    } : key.startsWith('Too frequent operations of ') ? {
      send_mail: 'Verification email', email_verification: 'Email verification code',
    } : {};
    const translated = handler.translate(key).replace(/\{(\d+)\}/g, (match, index) => {
      const value = error.params?.[index];
      return String(Object.hasOwn(labels, value) ? handler.translate(labels[value]) : value ?? match);
    });
    const doc = await pending(handler, purpose);
    show(handler, purpose, doc, translated, errorField);
    if (!doc && typeof handler.request.body.mail === 'string') {
      const mail = handler.request.body.mail.trim().slice(0, 254);
      if (handler.response.body.mail?.toLowerCase() !== mail.toLowerCase()) {
        handler.response.body.retryAfter = 0;
        handler.response.body.retryAfterMs = 0;
      }
      handler.response.body.mail = mail;
    }
    handler.response.status = error.code || 400;
  }

  async function send(handler, purpose, rawMail) {
    if (typeof rawMail !== 'string' || rawMail.length > 254 || !Types.Email[1](rawMail)) throw new ValidationError('mail');
    const mail = Types.Email[0](rawMail);
    // Match Hydro's SMTP transport and account lookup rules for each flow.
    if (!SystemModel.get('smtp.user')) throw new SystemError('Cannot send mail');
    const udoc = await UserModel.getByEmail('system', mail);
    if (purpose === 'register' || purpose === 'changemail') {
      if (purpose === 'register' && udoc) throw new UserAlreadyExistError(mail);
      const mailDomain = mail.split('@')[1].toLowerCase();
      if (await BlackListModel.get(`mail::${mailDomain}`)) throw new BlacklistedError(mailDomain);
    } else if (!udoc) throw new UserNotFoundError(mail);
    if (purpose === 'changemail') {
      const previous = await pending(handler, purpose);
      if (!previous || previous.mail.toLowerCase() !== mail.toLowerCase()) {
        const password = handler.request.body.password;
        if (typeof password !== 'string' || !Types.Password[1](password)) throw new ValidationError('password');
        const owner = handler.session.sudoUid
          ? await UserModel.getById(handler.args.domainId, handler.session.sudoUid) : handler.user;
        if (!owner) throw new UserNotFoundError(handler.session.sudoUid);
        await owner.checkPassword(Types.Password[0](password));
      }
      if (udoc) throw new UserAlreadyExistError(mail);
    }
    const mailKey = UserModel._handleMailLower(mail);
    await handler.limitRate('send_mail', RESEND_SECONDS, 1, mailKey);
    await handler.limitRate('send_mail', 3600, 30);
    await OplogModel.log(handler, FLOWS[purpose].log, {});
    const challenge = await store.issue({
      purpose, mail, mailKey, domainId: handler.args.domainId,
      redirect: handler.domain.registerRedirect,
      uid: purpose === 'changemail' ? handler.user._id : udoc?._id,
      uname: purpose === 'changemail' ? handler.user.uname : udoc?.uname,
      sourceMail: purpose === 'changemail' ? handler.user.mail : undefined,
      authorizerUid: purpose === 'changemail' ? (handler.session.sudoUid || null) : undefined,
    });
    try {
      const prefix = handler.domain.host
        ? (Array.isArray(handler.domain.host) ? handler.domain.host[0] : handler.domain.host)
        : SystemModel.get('server.url');
      // Extend Hydro's original mail templates, retaining their title and layout.
      const html = await handler.renderHTML(`verification_${purpose}_mail.html`, {
        verificationCode: challenge.code,
        url_prefix: prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
        uname: purpose === 'changemail' ? handler.user.uname : udoc?.uname,
      });
      const text = `${handler.translate(FLOWS[purpose].title)}\n`
        + (purpose === 'changemail' ? `${handler.user.uname}\n` : udoc ? `${udoc.uname}\n` : '')
        + `${handler.translate('Your email verification code:')} ${challenge.code}\n`
        + handler.translate('The code expires in 10 minutes. Do not share it with anyone.');
      await sendMail(mail, FLOWS[purpose].title, text, html.toString());
      if (!await store.activate(challenge.session, handler.args.domainId, purpose)) {
        throw new VerificationError('This verification request has expired. Please request a new code.');
      }
      handler.session[sessionKey(purpose)] = challenge.session;
      handler.session[resetKey(purpose)] = null;
    } catch (error) {
      await store.cancel(challenge.session, handler.args.domainId, purpose);
      throw error;
    }
    const current = await store.get(challenge.session, handler.args.domainId, purpose);
    show(handler, purpose, current);
    if (!handler.request.json) handler.response.redirect = handler.url(FLOWS[purpose].entry);
  }

  for (const [purpose, flow] of Object.entries(FLOWS)) {
    if (flow.handler) {
      // Only replace per-request methods; Hydro's permission, init, prepare and CSRF checks remain.
      ctx.on(`handler/before/${flow.handler}#get`, (handler) => {
        if (!enabled(purpose) || (purpose === 'lostpass' && !SystemModel.get('smtp.user'))) return;
        handler.get = async function () {
          if (await redirectExhausted(this, purpose, this.session[sessionKey(purpose)])) return;
          const doc = await pending(this, purpose);
          show(this, purpose, doc);
        };
      });
      ctx.on(`handler/before/${flow.handler}#post`, (handler) => {
        if (!enabled(purpose)) return;
        handler.post = async function () {
          try {
            await send(this, purpose, this.request.body.mail);
          } catch (error) {
            if (this.request.json) return showSendError(this, purpose, error);
            if (!(error instanceof VerificationError)) throw error;
            throw new ValidationError('mail', '', this.translate(error.message));
          }
        };
      });
    }

    class EmailVerificationHandler extends Handler {
      noCheckPermView = true;

      async prepare() {
        if (purpose === 'register' && !SystemModel.get('server.login')) throw new BuiltinLoginError();
        if (!enabled(purpose)) {
          this.response.redirect = this.url(flow.entry);
          return 'after';
        }
      }

      async get() {
        if (await redirectExhausted(this, purpose, this.session[sessionKey(purpose)])) return;
        const doc = await pending(this, purpose);
        show(this, purpose, doc, doc || resetNotice(this, purpose) || purpose === 'changemail' ? undefined : 'This verification request has expired. Please request a new code.');
      }

      async post() {
        if (purpose === 'changemail' && (this.request.body.action === 'send' || this.request.body.verificationAction === 'send')) {
          try {
            await send(this, purpose, this.request.body.mail);
          } catch (error) {
            if (this.request.json) return showSendError(this, purpose, error);
            throw error;
          }
          return;
        }
        const session = this.session[sessionKey(purpose)];
        const doc = await pending(this, purpose);
        if (!doc && await redirectExhausted(this, purpose, session, this.request.body.__challenge)) return;
        if (!doc || this.request.body.__challenge !== doc.nonce) {
          show(this, purpose, doc, 'This verification request has expired. Please request a new code.');
          this.response.status = 400;
          return;
        }
        if (this.request.body.mail !== undefined && (typeof this.request.body.mail !== 'string'
          || this.request.body.mail.trim().toLowerCase() !== doc.mail.toLowerCase())) {
          show(this, purpose, doc, 'Get a verification code for this email first.');
          this.response.status = 400;
          return;
        }
        if (this.request.body.action === 'resend') {
          try {
            await send(this, purpose, doc.mail);
          } catch (error) {
            if (this.request.json) return showSendError(this, purpose, error);
            if (!(error instanceof VerificationError)) throw error;
            show(this, purpose, doc, error.message, 'send');
            this.response.status = 400;
          }
          return;
        }
        await this.limitRate('email_verification', 60, 30);
        const verified = await store.consume(session, this.args.domainId, purpose, doc.nonce, this.request.body.__verificationCode);
        if (!verified) {
          if (await redirectExhausted(this, purpose, session, doc.nonce)) return;
          const current = await pending(this, purpose);
          show(this, purpose, current, 'The verification code is incorrect, expired, or has reached the attempt limit.');
          this.response.status = 400;
          return;
        }
        // Create native high-entropy tokens only AFTER mailbox ownership is proved.
        let token;
        if (purpose === 'register') {
          if (await UserModel.getByEmail('system', verified.mail)) throw new UserAlreadyExistError(verified.mail);
          [token] = await TokenModel.add(TokenModel.TYPE_REGISTRATION, EXPIRE_SECONDS, {
            mail: verified.mail,
            redirect: verified.redirect,
            identity: { provider: 'mail', platform: 'mail', id: verified.mail },
          });
        } else if (purpose === 'lostpass') {
          const currentUser = await UserModel.getByEmail('system', verified.mail);
          if (!currentUser || currentUser._id !== verified.uid) throw new UserNotFoundError(verified.mail);
          [token] = await TokenModel.add(TokenModel.TYPE_LOSTPASS, EXPIRE_SECONDS, { uid: verified.uid });
        } else {
          if (!ownsChange(this, verified)) throw new ValidationError('mail');
          if (await UserModel.getByEmail(this.args.domainId, verified.mail)) throw new UserAlreadyExistError(verified.mail);
          const mailDomain = verified.mail.split('@')[1].toLowerCase();
          if (await BlackListModel.get(`mail::${mailDomain}`)) throw new BlacklistedError(mailDomain);
          [token] = await TokenModel.add(TokenModel.TYPE_CHANGEMAIL, EXPIRE_SECONDS, { uid: verified.uid, email: verified.mail });
        }
        this.session[sessionKey(purpose)] = null;
        this.response.redirect = this.url(flow.next, { code: token });
      }
    }

    // Native account errors after code verification also need localized JSON,
    // just like errors while sending. Keep non-JSON native error handling intact.
    const originalPost = EmailVerificationHandler.prototype.post;
    EmailVerificationHandler.prototype.post = async function (...args) {
      try {
        return await originalPost.apply(this, args);
      } catch (error) {
        if (this.request.json) return showSendError(this, purpose, error);
        throw error;
      }
    };
    if (purpose === 'changemail') EmailVerificationHandler.prototype.prepare = withSudo(EmailVerificationHandler.prototype.prepare);
    Object.defineProperty(EmailVerificationHandler, Symbol.for('hydro.handler'), { value: `EmailVerification_${purpose}` });
    const checks = purpose === 'register' ? [PRIV.PRIV_REGISTER_USER] : purpose === 'changemail' ? [PRIV.PRIV_USER_PROFILE] : [];
    ctx.Route(`verification_${purpose}`, `/verification/${purpose}`, EmailVerificationHandler, ...checks);
  }

  ctx.on('handler/before/HomeSecurity#post', (handler) => {
    if (handler.request.body.operation !== 'change_mail') return;
    // Preserve the public sudo decorator, plus the original password/impersonation checks above.
    handler.postChangeMail = withSudo(async function () {
      await send(this, 'changemail', this.request.body.mail);
      this.response.redirect = this.url('verification_changemail');
    });
  });
  ctx.on('handler/after/HomeSecurity#get', async (handler) => {
    if (handler.response.template !== 'home_security.html') return;
    const doc = await pending(handler, 'changemail');
    handler.response.template = 'verification_home_security.html';
    handler.response.body.page_name = 'home_security';
    handler.response.body.verificationChangeUrl = handler.url('verification_changemail');
    handler.response.body.verificationPendingMail = doc?.mail;
  });
};
