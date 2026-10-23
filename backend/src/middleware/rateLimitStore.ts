import { createHash } from "node:crypto";
import type { ClientRateLimitInfo, Options, Store } from "express-rate-limit";
import { RateLimitHitModel } from "../models/RateLimitHit";

// If MongoDB can't be reached, requests go through unlimited (fail open) instead of every limited route, sign-in
// included, answering an error. Every route these limits guard reads MongoDB itself (the account, the code, the
// session), so while MongoDB is down they fail anyway and nothing can be guessed; failing closed would only add
// an error on top. What failing open does risk is a store that breaks while the rest of MongoDB works, so the
// first failure is logged loudly, once per outage, and so is the recovery.
let failing = false;

function storeFailed(err: unknown) {
  if (failing) return;
  failing = true;
  console.error("Rate limits can't reach MongoDB: requests are NOT being limited until it's back.", err);
}

function storeWorked() {
  if (!failing) return;
  failing = false;
  console.log("Rate limits are counting again: MongoDB is back.");
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * express-rate-limit's Store on MongoDB (RateLimitHit): limits hold across restarts and deploys, and with
 * several instances they count every instance's requests together instead of each on its own.
 *
 * Fixed windows, like the default memory store: a client's first hit starts a window of `windowMs`; hits in it
 * add up; the first hit after it ends starts a new one. One store per limiter (express-rate-limit refuses a
 * shared one); `name` becomes the prefix that keeps limiters' counts apart in the one collection. Clients are
 * stored hashed, so the collection holds no addresses or emails.
 */
export class MongoRateLimitStore implements Store {
  /** Counts are shared, not per process. */
  localKeys = false;
  prefix: string;
  windowMs = 15 * 60 * 1000;

  constructor(name: string) {
    this.prefix = `${name}:`;
  }

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  private id(key: string) {
    return this.prefix + createHash("sha256").update(key).digest("base64url");
  }

  /**
   * One atomic write per hit: inside the window it adds one; for a new client, or once the window is over, it
   * starts a new window with this hit. MongoDB's clock decides ($$NOW), so instances with drifting clocks agree.
   */
  private async hit(id: string) {
    const live = { $gt: ["$resetAt", "$$NOW"] };
    const update = [
      {
        $set: {
          hits: { $cond: [live, { $add: ["$hits", 1] }, 1] },
          resetAt: { $cond: [live, "$resetAt", { $add: ["$$NOW", this.windowMs] }] },
        },
      },
    ];
    const write = () =>
      RateLimitHitModel.findOneAndUpdate({ key: id }, update, { upsert: true, returnDocument: "after", lean: true, updatePipeline: true });
    try {
      return (await write())!;
    } catch (err) {
      // Two first hits at once both tried to insert the counter, and this one lost: now it exists, so count on
      // the winner's window rather than start another.
      if ((err as { code?: number })?.code !== 11000) throw err;
      return (await write())!;
    }
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    try {
      const counter = await this.hit(this.id(key));
      storeWorked();
      return { totalHits: counter.hits, resetTime: counter.resetAt };
    } catch (err) {
      storeFailed(err);
      // Fail open (see above): count it as the first hit of a fresh window, so the request goes through.
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  /** Takes back a hit (skipSuccessfulRequests). Only in a live window, and never below zero. Never throws. */
  async decrement(key: string) {
    try {
      await RateLimitHitModel.updateOne(
        { key: this.id(key), hits: { $gt: 0 }, $expr: { $gt: ["$resetAt", "$$NOW"] } },
        { $inc: { hits: -1 } },
      );
    } catch (err) {
      // express-rate-limit doesn't catch this one (it runs after the response): an error here would go unhandled.
      storeFailed(err);
    }
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const counter = await RateLimitHitModel.findOne({ key: this.id(key) }).lean();
    if (!counter || counter.resetAt.getTime() <= Date.now()) return undefined;
    return { totalHits: counter.hits, resetTime: counter.resetAt };
  }

  async resetKey(key: string) {
    await RateLimitHitModel.deleteOne({ key: this.id(key) });
  }

  /** Every count of this limiter. Not another limiter's whose name starts with this one's ("public:checkouts"). */
  async resetAll() {
    await RateLimitHitModel.deleteMany({ key: { $regex: `^${escapeRegex(this.prefix)}[A-Za-z0-9_-]+$` } });
  }
}
