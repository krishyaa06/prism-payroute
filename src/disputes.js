// Chargeback lifecycle as an explicit state machine with deadlines, evidence scoring and liability shift.
export const REASONS = {
  fraud: { code: "10.4", label: "Card-absent fraud" }, not_received: { code: "13.1", label: "Goods not received" },
  duplicate: { code: "12.6", label: "Duplicate processing" }, not_as_described: { code: "13.3", label: "Not as described" },
  credit_not_processed: { code: "13.6", label: "Refund not processed" },
};
export const STATES = ["needs_response", "under_review", "pre_arbitration", "arbitration", "won", "lost", "accepted"];
export const TERMINAL = ["won", "lost", "accepted"];
export const TRANSITIONS = {
  needs_response: { accept: "accepted", represent: "under_review", expire: "lost" },
  under_review: { issuer_accepts: "won", issuer_rejects: "pre_arbitration" },
  pre_arbitration: { accept: "lost", escalate: "arbitration", expire: "lost" },
  arbitration: { ruled_won: "won", ruled_lost: "lost" },
};
/** Evidence that helps per reason; weights are illustrative. */
const HELPS = { fraud: { "3ds": 0.55, avs: 0.1, device: 0.15, history: 0.15 }, not_received: { delivery: 0.6, comms: 0.15, terms: 0.1 },
  duplicate: { distinct: 0.7, refund: 0.6 }, not_as_described: { description: 0.3, comms: 0.25, terms: 0.15 }, credit_not_processed: { refund: 0.8, terms: 0.2 } };
export class FSMError extends Error { constructor(code, message) { super(message); this.code = code; this.status = 409; } }

export class Disputes {
  constructor({ day = 86400, respondDays = 7, reviewDays = 10, preArbDays = 5, fee = 500_00, arbitrationFee = 25000_00, monitorRatio = 0.009, rng = Math.random } = {}) {
    Object.assign(this, { day, respondDays, reviewDays, preArbDays, fee, arbitrationFee, monitorRatio, rng }); this.items = new Map(); this.seq = 0; this.listeners = [];
  }
  on(fn) { this.listeners.push(fn); return this; }
  emit(d, ev, from) { for (const f of this.listeners) f({ dispute: d, event: ev, from, to: d.state }); }
  /** Open a chargeback against a captured payment. The amount and a fee are withheld immediately. */
  open(payment, { reason = "fraud", at = 0 } = {}) {
    if (!REASONS[reason]) throw new FSMError("REASON", `unknown reason ${reason}`);
    const d = { id: "dp_" + (++this.seq).toString(36).padStart(4, "0"), payment: payment.id, amount: payment.amountInr, psp: payment.psp, reason, ...REASONS[reason],
      threeDS: !!payment.threeDS, state: "needs_response", openedAt: at, due: at + this.respondDays * this.day, evidence: [], history: [{ at, to: "needs_response" }],
      liabilityShift: reason === "fraud" && !!payment.threeDS, withheld: payment.amountInr + this.fee, winProb: 0 };
    d.winProb = this.score(d, d.threeDS ? ["3ds"] : []);
    this.items.set(d.id, d); this.emit(d, "open", null); return d;
  }
  score(d, evidence) { if (d.liabilityShift && evidence.includes("3ds")) return 0.95; const h = HELPS[d.reason] || {}; let p = 0.12; for (const e of new Set(evidence)) p += h[e] || 0; return Math.min(0.92, p); }
  act(id, event, { at = 0, evidence = [] } = {}) {
    const d = this.items.get(id); if (!d) throw new FSMError("NOT_FOUND", `no dispute ${id}`);
    const to = TRANSITIONS[d.state]?.[event]; if (!to) throw new FSMError("INVALID_TRANSITION", `cannot ${event} from ${d.state}`);
    if (event === "represent" || event === "escalate") { d.evidence = [...new Set([...d.evidence, ...evidence, ...(d.threeDS ? ["3ds"] : [])])]; d.winProb = this.score(d, d.evidence); }
    const from = d.state; d.state = to; d.history.push({ at, event, from, to });
    if (to === "under_review") d.due = at + this.reviewDays * this.day;
    if (to === "pre_arbitration") d.due = at + this.preArbDays * this.day;
    if (to === "arbitration") { d.due = at + this.reviewDays * this.day; d.withheld += this.arbitrationFee; }
    if (to === "won") d.withheld = this.fee; // amount returned, the fee is usually not
    this.emit(d, event, from); return d;
  }
  /** Advance time: expire missed deadlines and let issuers / the network decide. */
  tick(now, { autoRespond = null } = {}) {
    for (const d of this.items.values()) {
      if (TERMINAL.includes(d.state) || now < d.due) { if (autoRespond && d.state === "needs_response" && now >= d.openedAt + (this.respondDays * this.day) / 2) autoRespond(d); continue; }
      if (d.state === "needs_response" || d.state === "pre_arbitration") { if (d.state === "pre_arbitration" && d.winProb >= 0.6) this.act(d.id, "escalate", { at: now }); else this.act(d.id, "expire", { at: now }); }
      else if (d.state === "under_review") this.act(d.id, this.rng() < d.winProb ? "issuer_accepts" : "issuer_rejects", { at: now });
      else if (d.state === "arbitration") this.act(d.id, this.rng() < d.winProb ? "ruled_won" : "ruled_lost", { at: now });
    }
  }
  list() { return [...this.items.values()]; }
  summary(captured = 0) {
    const all = this.list(), done = all.filter((d) => TERMINAL.includes(d.state)), won = done.filter((d) => d.state === "won").length;
    const ratio = captured ? all.length / captured : 0;
    return { total: all.length, open: all.length - done.length, won, lost: done.filter((d) => d.state === "lost").length, accepted: done.filter((d) => d.state === "accepted").length,
      winRate: done.length ? won / done.length : 0, atRisk: all.filter((d) => !TERMINAL.includes(d.state)).reduce((s, d) => s + d.withheld, 0),
      lostAmount: done.filter((d) => d.state !== "won").reduce((s, d) => s + d.withheld, 0), ratio, monitored: ratio >= this.monitorRatio };
  }
}
