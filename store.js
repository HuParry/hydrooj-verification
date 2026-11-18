'use strict';

const { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } = require('node:crypto');

const EXPIRE_SECONDS = 600;
const RESEND_SECONDS = 30;
const MAX_ATTEMPTS = 3;
const CODE_LENGTH = 6;
const CODE_PATTERN = new RegExp(`^[0-9]{${CODE_LENGTH}}$`);
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = (secret, code) => createHmac('sha256', secret).update(code).digest('hex');

class VerificationError extends Error {}

// All state and counters live in MongoDB, including the cross-worker resend lock.
class VerificationStore {
  constructor(collection, now = () => new Date()) {
    this.collection = collection;
    this.now = now;
  }

  async init() {
    await this.collection.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'expire' });
  }

  async issue({ purpose, mail, mailKey, domainId, redirect, uid, uname, sourceMail, authorizerUid }) {
    const now = this.now();
    const id = hash(`${purpose}\0${mailKey}`);
    const secret = randomBytes(32).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    // Keep this a string: leading zeroes are valid and must survive form submission.
    const code = randomInt(10 ** CODE_LENGTH).toString().padStart(CODE_LENGTH, '0');
    const doc = {
      purpose, mail, domainId, redirect, uid, uname, sourceMail, authorizerUid, nonce,
      codeLength: CODE_LENGTH,
      binding: hash(secret),
      digest: digest(secret, code),
      attempts: 0,
      active: false,
      revoked: false,
      expireAt: new Date(now.getTime() + EXPIRE_SECONDS * 1000),
      resendAt: new Date(now.getTime() + RESEND_SECONDS * 1000),
    };
    try {
      await this.collection.updateOne(
        { _id: id, $or: [
          { active: true, resendAt: { $lte: now } },
          { expireAt: { $lte: now } },
        ] },
        { $set: doc },
        { upsert: true },
      );
    } catch (error) {
      if (error.code === 11000) throw new VerificationError('Please wait 30 seconds before requesting another code.');
      throw error;
    }
    return { session: { id, secret }, code, nonce };
  }

  filter(session, domainId, purpose) {
    if (!session || typeof session.id !== 'string' || typeof session.secret !== 'string'
      || !/^[a-f0-9]{64}$/.test(session.id) || !/^[a-f0-9]{64}$/.test(session.secret)) return null;
    return { _id: session.id, binding: hash(session.secret), domainId, purpose, codeLength: CODE_LENGTH };
  }

  async activate(session, domainId, purpose) {
    const filter = this.filter(session, domainId, purpose);
    if (!filter) return false;
    const now = this.now();
    const res = await this.collection.updateOne(
      { ...filter, active: false, expireAt: { $gt: now } },
      // SMTP latency must not consume the user's resend cooldown. Pending
      // deliveries remain reserved until activation, cancellation or expiry.
      { $set: { active: true, resendAt: new Date(now.getTime() + RESEND_SECONDS * 1000) } },
    );
    return !!res.modifiedCount;
  }

  async cancel(session, domainId, purpose) {
    const filter = this.filter(session, domainId, purpose);
    if (filter) await this.collection.deleteOne(filter);
  }

  async get(session, domainId, purpose) {
    const filter = this.filter(session, domainId, purpose);
    if (!filter) return null;
    return this.collection.findOne(
      { ...filter, active: true, revoked: { $ne: true }, expireAt: { $gt: this.now() } },
      { projection: { digest: 0, binding: 0 } },
    );
  }

  async getRevoked(session, domainId, purpose) {
    const filter = this.filter(session, domainId, purpose);
    if (!filter) return null;
    return this.collection.findOne(
      { ...filter, revoked: true, expireAt: { $gt: this.now() } },
      { projection: { digest: 0, binding: 0 } },
    );
  }

  async revoke(session, domainId, purpose, nonce) {
    const filter = this.filter(session, domainId, purpose);
    if (!filter) return;
    // Keep only the cooldown/ownership record. The old code has no digest left
    // to verify, and cleanup from an old form cannot revoke a replacement.
    await this.collection.updateOne(
      { ...filter, nonce, active: true, attempts: { $gte: MAX_ATTEMPTS } },
      { $set: { revoked: true }, $unset: { digest: '' } },
    );
  }

  async consume(session, domainId, purpose, nonce, code) {
    const filter = this.filter(session, domainId, purpose);
    if (!filter || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) return null;
    // Reserve an attempt before checking. Parallel requests cannot exceed the budget.
    const live = { ...filter, nonce, active: true, revoked: { $ne: true }, expireAt: { $gt: this.now() }, attempts: { $lt: MAX_ATTEMPTS } };
    const doc = await this.collection.findOneAndUpdate(live, { $inc: { attempts: 1 } }, { returnDocument: 'before' });
    if (!doc) return null;
    const reject = async () => {
      if (doc.attempts + 1 >= MAX_ATTEMPTS) await this.revoke(session, domainId, purpose, nonce);
      return null;
    };
    if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return reject();
    const expected = Buffer.from(doc.digest, 'hex');
    const actual = Buffer.from(digest(session.secret, code), 'hex');
    if (!timingSafeEqual(expected, actual)) return reject();
    // One successful request wins, even across multiple Hydro processes.
    return this.collection.findOneAndDelete({
      ...filter, nonce, active: true, revoked: { $ne: true }, expireAt: { $gt: this.now() }, attempts: { $lte: MAX_ATTEMPTS },
    });
  }
}

module.exports = { VerificationStore, VerificationError, EXPIRE_SECONDS, RESEND_SECONDS, MAX_ATTEMPTS };
