// A payment gateway facade: input validation, idempotency, compliance, routing, FX and disputes.
import { Router, RouteError } from "./router.js";
import { Network, METHODS, ISSUERS } from "./psp.js";
import { Compliance, binLookup, maskPan } from "./compliance.js";
import { Disputes } from "./disputes.js";
import { FX, toMinor, CURRENCIES } from "./money.js";

export class Gateway {
  constructor({ router = new Router(), network = new Network(), compliance = new Compliance(), fx, disputes, clock = () => Date.now() / 1000, idempotencyTTL = 86400 } = {}) {
    Object.assign(this, { router, network, compliance, clock, idempotencyTTL });
    this.fx = fx || new FX({ clock }); this.disputes = disputes || new Disputes(); this.keys = new Map(); this.payments = new Map(); this.seq = 0;
  }
  /** Validate and normalise a request body into a payment. Never keeps a raw card number. */
  normalise(b) {
    const method = b.method; if (!METHODS.includes(method)) throw new RouteError("BAD_REQUEST", `method must be one of ${METHODS.join(", ")}`, 400);
    const currency = (b.currency || "INR").toUpperCase(); if (!CURRENCIES[currency]) throw new RouteError("BAD_REQUEST", `unknown currency ${currency}`, 400);
    if (b.amount == null) throw new RouteError("BAD_REQUEST", "amount is required", 400);
    const amount = toMinor(b.amount, currency); if (amount <= 0) throw new RouteError("BAD_REQUEST", "amount must be positive", 400);
    const p = { id: b.id || "pay_" + (++this.seq).toString(36).padStart(6, "0"), method, currency, amount, country: (b.country || "IN").toUpperCase(), threeDS: !!b.threeDS,
      recurring: !!b.recurring, mandate: b.mandate, saveCard: !!b.saveCard, vpa: b.vpa, issuer: b.issuer, network: b.network };
    p.amountInr = currency === "INR" ? amount : this.fx.convert(amount, currency, "INR");
    if (method === "card") {
      const c = b.card || {}; p.card = { token: c.token, pan: c.pan, country: c.country };
      const bin = c.pan ? binLookup(c.pan) : null; if (bin) { p.network ||= bin.network; p.issuer ||= bin.issuer; p.card.country ||= bin.country; }
      p.international = (p.card.country || "IN") !== "IN" || currency !== "INR"; if (p.international && !p.issuer) p.issuer = "INTL";
    }
    if (!p.issuer) p.issuer = ISSUERS[0].id;
    return p;
  }
  /** Dry run: compliance + scored plan, no network calls. */
  route(body) { const p = this.normalise(body), c = this.compliance.check(p, this.clock()); return { payment: this.redact(p), compliance: c, plan: c.ok ? this.router.plan(p, this.clock(), { domesticOnly: c.domesticOnly }) : null }; }
  /** Create a payment. Same key + same body replays; same key + different body is a conflict. */
  pay(body, key) {
    const now = this.clock(), fp = JSON.stringify(body);
    if (key) { const k = this.keys.get(key); if (k && now - k.at < this.idempotencyTTL) { if (k.fp !== fp) throw new RouteError("IDEMPOTENCY_CONFLICT", "key reused with a different body", 409); return { ...k.res, replay: true }; } }
    const p = this.normalise(body), c = this.compliance.check(p, now);
    let res;
    if (!c.ok) res = { id: p.id, status: "blocked", code: c.code, reason: c.reason };
    else if (c.require.length && !p.threeDS) res = { id: p.id, status: "requires_action", action: c.require[0], next: `redirect the customer to ${c.require[0].toUpperCase()} and retry with threeDS: true` };
    else { const r = this.router.process(p, this.network, now, { domesticOnly: c.domesticOnly }); res = { ...r, rows: undefined, plan: r.rows }; }
    res.payment = this.redact(p); this.payments.set(p.id, { ...p, card: p.card ? { ...p.card, pan: undefined } : undefined, ...res, pan: undefined });
    if (key) this.keys.set(key, { fp, res, at: now });
    return { ...res, replay: false };
  }
  redact(p) { const q = { ...p }; if (q.card) q.card = { ...q.card, pan: q.card.pan ? maskPan(q.card.pan) : undefined }; delete q.hard; delete q.hardCode; return q; }
  dispute(paymentId, { reason, at = this.clock() } = {}) { const p = this.payments.get(paymentId); if (!p || p.status !== "captured") throw new RouteError("NOT_FOUND", "no captured payment with that id", 404); return this.disputes.open(p, { reason, at }); }
}
