// A synthetic Indian payments platform: traffic, compliance, step-up, the smart router plus shadow
// baselines that see the same payments and the same network, disputes and an FX desk.
import { rng as mkRng } from "./lib/rng.js";
import { bucket } from "./lib/hash.js";
import { Network, PSPS, ISSUERS, HARD } from "./psp.js";
import { Router, STRATEGIES } from "./router.js";
import { Compliance } from "./compliance.js";
import { Disputes } from "./disputes.js";
import { FX } from "./money.js";

const MIX = [["upi", 0.5], ["card", 0.3], ["netbanking", 0.11], ["wallet", 0.09]];
const HARD_RATE = { upi: 0.045, card: 0.065, netbanking: 0.06, wallet: 0.03 };
const MEDIAN = { upi: 650, card: 2400, netbanking: 3800, wallet: 420 };
const INTL = [["USD", "US"], ["AED", "AE"], ["GBP", "GB"], ["SGD", "SG"], ["EUR", "DE"]];
const tally = () => ({ n: 0, ok: 0, hard: 0, vol: 0, fee: 0, latSum: 0, lat: [], recovered: 0, dup: 0, silent: 0, fast: 0, byPsp: {}, win: [] });

export class Platform {
  constructor({ seed = 12, rate = 14, day = 6, strategies = Object.keys(STRATEGIES), routerOpts = {}, intl = 0.07 } = {}) {
    this.seed = seed; this.r = mkRng(seed); this.rate = rate; this.intl = intl; this.t = 0; this.seq = 0; this.listeners = [];
    this.net = new Network({ seed }); this.fx = new FX({ clock: () => this.t }); this.compliance = new Compliance();
    this.routers = Object.fromEntries(strategies.map((s, i) => [s, new Router({ strategy: s, seed: seed * 31 + i, ...routerOpts })]));
    this.T = Object.fromEntries(strategies.map((s) => [s, tally()])); this.main = strategies[0];
    this.routers[this.main].on((e) => this.emit({ ...e, t: this.t }));
    this.disputes = new Disputes({ day, rng: mkRng(seed + 5) }); this.disputes.on((e) => this.emit({ kind: "dispute", ...e, t: this.t }));
    this.blocked = {}; this.stepUps = 0; this.abandoned = 0; this.recent = []; this.captured = new Map(); this.attack = null;
  }
  on(fn) { this.listeners.push(fn); return this; }
  emit(e) { for (const f of this.listeners) f(e); }
  gen() {
    const r = this.r, id = "pay_" + (++this.seq).toString(36).padStart(5, "0"), method = r.weighted(MIX, (x) => x[1])[0];
    const p = { id, method, currency: "INR", country: "IN", created: this.t };
    const international = method === "card" && r.chance(this.intl);
    let rupees = Math.max(10, Math.round(MEDIAN[method] * Math.exp(r.normal(0, 0.9))));
    if (method === "card") {
      if (international) { const [c, cc] = r.pick(INTL); p.currency = c; p.country = cc; p.international = true; p.issuer = "INTL"; p.network = r.weighted([["visa", 0.55], ["mastercard", 0.35], ["amex", 0.1]], (x) => x[1])[0]; p.threeDS = r.chance(0.7); }
      else { p.issuer = r.pick(ISSUERS.slice(0, 5)).id; p.network = r.weighted([["visa", 0.4], ["mastercard", 0.3], ["rupay", 0.25], ["amex", 0.05]], (x) => x[1])[0]; p.threeDS = r.chance(0.96); }
      p.card = { token: "tok_" + r.int(1, 40000), country: international ? p.country : "IN" };
      if (!international && r.chance(0.04)) { p.recurring = true; p.mandate = "mdt_" + r.int(1, 999); }
    } else { p.issuer = r.pick(ISSUERS.slice(0, 5)).id; if (method === "upi") p.vpa = `u${r.int(1, 90000)}@ok${p.issuer.toLowerCase()}`; }
    if (p.currency !== "INR") { const minor = Math.round((rupees / this.fx.rates[p.currency]) * 100); p.amount = minor; p.amountInr = this.fx.convert(minor, p.currency, "INR"); }
    else { p.amount = p.amountInr = rupees * 100; }
    p.hard = r.chance(HARD_RATE[method]); if (p.hard) p.hardCode = r.pick(HARD[method]);
    return p;
  }
  /** Compliance, step-up, then every router processes the same payment. */
  pay(p) {
    const c = this.compliance.check(p, this.t);
    if (!c.ok) { this.blocked[c.code] = (this.blocked[c.code] || 0) + 1; this.emit({ kind: "blocked", p, code: c.code, reason: c.reason, t: this.t }); return null; }
    if (c.require.length) { this.stepUps++; p.stepUp = c.require[0]; p.threeDS = true; if (bucket(this.seed, p.id + "|abandon") < 0.06) { this.abandoned++; this.emit({ kind: "abandoned", p, t: this.t }); return null; } }
    let main = null;
    for (const [s, R] of Object.entries(this.routers)) {
      const res = R.process(p, this.net, this.t, { domesticOnly: c.domesticOnly }), T = this.T[s];
      if (p.stepUp) res.latency += 2500;
      T.n++; T.latSum += res.latency; T.lat.push(res.latency); if (T.lat.length > 600) T.lat.shift();
      const ok = res.status === "captured"; if (ok) { T.ok++; T.vol += p.amountInr; T.fee += res.fee; T.byPsp[res.psp] = (T.byPsp[res.psp] || 0) + 1; } else if (res.status === "declined") T.hard++;
      if (res.recovered) T.recovered++; if (res.duplicate) T.dup += res.duplicate; if (res.unknownToMerchant) T.silent++; if (res.fastFail) T.fast++;
      T.win.push({ t: this.t, ok }); if (s === this.main) main = res;
    }
    for (const T of Object.values(this.T)) { const cut = this.t - 10; while (T.win.length && T.win[0].t < cut) T.win.shift(); }
    p.compliance = c; this.recent.push({ p, res: main }); if (this.recent.length > 300) this.recent.shift();
    if (main.status === "captured") { this.captured.set(p.id, { ...p, psp: main.psp }); if (this.captured.size > 5000) this.captured.delete(this.captured.keys().next().value); this.maybeDispute(p, main); }
    this.emit({ kind: "payment", p, res: main, t: this.t }); return main;
  }
  maybeDispute(p, res) {
    const rate = p.method === "card" ? (p.threeDS ? 0.004 : 0.03) : p.method === "upi" ? 0.0008 : 0.002;
    if (bucket(this.seed, p.id + "|cb") >= rate) return;
    const reason = !p.threeDS || this.r.chance(0.35) ? "fraud" : this.r.pick(["not_received", "duplicate", "not_as_described", "credit_not_processed"]);
    this.disputes.open({ ...p, psp: res.psp }, { reason, at: this.t });
  }
  step(dt) {
    this.t += dt; let k = 0; const lam = this.rate * dt; let L = Math.exp(-lam), q = 1; do { k++; q *= this.r(); } while (q > L); k--;
    for (let i = 0; i < k; i++) { const p = this.gen(); if (this.attack && this.t < this.attack.until && p.method === "card") { p.card.token = this.attack.token; p.threeDS = false; p.international = false; p.issuer = "SAHY"; } this.pay(p); }
    if (this.attack && this.t >= this.attack.until) this.attack = null;
    this.fx.drift(this.r, 0.0002 * Math.sqrt(dt));
    this.disputes.tick(this.t, { autoRespond: (d) => { if (d.liabilityShift) this.disputes.act(d.id, "represent", { at: this.t, evidence: ["3ds", "device"] }); else if (d.reason === "duplicate" || d.reason === "credit_not_processed") this.disputes.act(d.id, "represent", { at: this.t, evidence: ["refund", "distinct"] }); else if (this.r.chance(0.5)) this.disputes.act(d.id, "represent", { at: this.t, evidence: ["delivery", "comms"] }); else this.disputes.act(d.id, "accept", { at: this.t }); } });
    return k;
  }
  run(seconds, dt = 0.25) { for (let s = 0; s < seconds; s += dt) this.step(dt); return this.report(); }
  // ---- scenarios ----
  outage(psp, { secs = 40, method = null } = {}) { return this.net.incident({ psp, method, kind: "outage", from: this.t, until: this.t + secs }); }
  degrade(psp, { secs = 40, method = null } = {}) { return this.net.incident({ psp, method, kind: "degrade", from: this.t, until: this.t + secs }); }
  issuerDown(issuer, { secs = 30, method = null } = {}) { return this.net.incident({ issuer, method, kind: "issuer", from: this.t, until: this.t + secs }); }
  cardAttack({ secs = 6 } = {}) { this.attack = { token: "tok_attack_" + this.seq, until: this.t + secs }; return this.attack; }
  clear() { this.net.incidents = []; this.attack = null; }
  report() {
    const out = {};
    for (const [s, T] of Object.entries(this.T)) { const l = T.lat.slice().sort((a, b) => a - b);
      out[s] = { payments: T.n, authRate: T.n ? T.ok / T.n : 0, techRate: T.n - T.hard ? T.ok / (T.n - T.hard) : 0, volume: T.vol, fees: T.fee, feeBps: T.vol ? (T.fee / T.vol) * 1e4 : 0,
        p50: l[Math.floor(l.length * 0.5)] || 0, p95: l[Math.floor(l.length * 0.95)] || 0, recovered: T.recovered, duplicates: T.dup, silentCaptures: T.silent, fastFails: T.fast, share: T.byPsp,
        live: T.win.length ? T.win.filter((x) => x.ok).length / T.win.length : 0 }; }
    return { t: this.t, strategies: out, blocked: this.blocked, stepUps: this.stepUps, abandoned: this.abandoned, disputes: this.disputes.summary(this.T[this.main].ok) };
  }
}
export { PSPS };
