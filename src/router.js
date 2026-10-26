// Smart routing: decayed Beta success estimates with hierarchical priors, Thompson sampling,
// cost/latency-aware scoring, per PSP×method circuit breakers, issuer-wide outage detection,
// failover on soft declines only, and status inquiry before retrying an ambiguous timeout.
import { rng as mkRng } from "./lib/rng.js";
import { PSPS, supports, feeFor, isSoft } from "./psp.js";

export class RouteError extends Error { constructor(code, message, status = 422) { super(message); this.code = code; this.status = status; } }

function gamma(r, k) { // Marsaglia–Tsang
  if (k < 1) return gamma(r, k + 1) * Math.pow(r(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = r.normal(); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = r(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
}
export const betaSample = (r, a, b) => { const x = gamma(r, a), y = gamma(r, b); return x / (x + y); };

/** Exponentially decayed success/failure counts per key, with a prior borrowed from a parent key. */
export class Stats {
  constructor({ halfLife = 120, prior = [19, 1], strength = 8 } = {}) { this.halfLife = halfLife; this.prior = prior; this.strength = strength; this.m = new Map(); }
  get(key, now) { let s = this.m.get(key); if (!s) { s = { s: 0, f: 0, t: now, lat: 0, latN: 0 }; this.m.set(key, s); } const k = Math.pow(0.5, (now - s.t) / this.halfLife); if (k < 1) { s.s *= k; s.f *= k; s.latN *= k; s.t = now; } return s; }
  record(key, ok, now, latency) { const s = this.get(key, now); if (ok) s.s++; else s.f++; if (latency != null) { s.lat = (s.lat * s.latN + latency) / (s.latN + 1); s.latN++; } }
  /** Posterior Beta(a, b) for key, shrunk towards the parent's mean. */
  posterior(key, parent, now) {
    const [a0, b0] = this.prior; let pa = a0, pb = b0;
    if (parent) { const P = this.get(parent, now); const mean = (P.s + a0) / (P.s + P.f + a0 + b0); pa = mean * this.strength; pb = (1 - mean) * this.strength; }
    const S = this.get(key, now); return { a: S.s + pa, b: S.f + pb, n: S.s + S.f };
  }
  mean(key, parent, now) { const { a, b } = this.posterior(key, parent, now); return a / (a + b); }
  latency(key, now, fallback) { const s = this.get(key, now); return s.latN > 0.5 ? s.lat : fallback; }
}

/** Rolling-window circuit breaker: closed -> open (failure rate over threshold) -> half-open probes -> closed. */
export class Breaker {
  constructor({ window = 12, minVolume = 10, threshold = 0.5, cooldown = 10, maxCooldown = 80, probes = 5, probeSuccess = 3 } = {}) {
    Object.assign(this, { window, minVolume, threshold, cooldown, maxCooldown, probes, probeSuccess }); this.m = new Map(); this.listeners = [];
  }
  on(fn) { this.listeners.push(fn); return this; }
  s(key) { let s = this.m.get(key); if (!s) { s = { state: "closed", ev: [], openedAt: 0, cool: this.cooldown, trips: 0, sent: 0, good: 0 }; this.m.set(key, s); } return s; }
  set(key, s, to, now, why) { const from = s.state; s.state = to; for (const f of this.listeners) f({ key, from, to, at: now, why, trips: s.trips, cooldown: s.cool }); }
  state(key, now) { const s = this.s(key); if (s.state === "open" && now - s.openedAt >= s.cool) { s.sent = 0; s.good = 0; this.set(key, s, "half", now, "cooldown elapsed"); } return s.state; }
  failureRate(key, now) { const s = this.s(key); s.ev = s.ev.filter((e) => now - e.t <= this.window); const f = s.ev.filter((e) => !e.ok).length; return { rate: s.ev.length ? f / s.ev.length : 0, n: s.ev.length }; }
  /** Can a request go to this key now? Half-open admits a limited number of probes. */
  allow(key, now) { const st = this.state(key, now), s = this.s(key); if (st === "closed") return true; if (st === "open") return false; if (s.sent < this.probes) { s.sent++; return true; } return false; }
  record(key, ok, now) {
    const s = this.s(key), st = this.state(key, now);
    if (st === "half") {
      if (!ok) { s.trips++; s.cool = Math.min(this.maxCooldown, s.cool * 2); s.openedAt = now; s.ev = []; this.set(key, s, "open", now, "probe failed"); }
      else if (++s.good >= this.probeSuccess) { s.cool = this.cooldown; s.ev = []; this.set(key, s, "closed", now, `${s.good} probes ok`); }
      return;
    }
    if (st === "open") return;
    s.ev.push({ t: now, ok }); const { rate, n } = this.failureRate(key, now);
    if (n >= this.minVolume && rate >= this.threshold) { s.trips++; s.openedAt = now; s.ev = []; this.set(key, s, "open", now, `${Math.round(rate * 100)}% failures over ${n} calls`); }
  }
  snapshot(now) { return [...this.m.keys()].map((k) => ({ key: k, state: this.state(k, now), ...this.failureRate(k, now), trips: this.s(k).trips, cooldown: this.s(k).cool })); }
}

export const STRATEGIES = {
  smart: "Scored routing with Thompson sampling, breakers, failover and timeout inquiry",
  static: "One primary PSP per method, no retries",
  "round-robin": "Rotate across eligible PSPs, no retries",
  cheapest: "Lowest fee PSP, no retries",
  "naive-retry": "Round-robin with blind retries, including after timeouts (can double-charge)",
};
const STATIC_PRIMARY = { upi: "aryapay", card: "aryapay", netbanking: "aryapay", wallet: "aryapay" };

export class Router {
  constructor({ psps = PSPS, strategy = "smart", seed = 7, costWeight = 1, latencyWeight = 0.3, explore = true, failover = true, breaker = true,
    inquiry = true, maxAttempts = 3, budgetMs = 15000, rules = [], primary = STATIC_PRIMARY, breakerOpts, statsOpts } = {}) {
    if (!STRATEGIES[strategy]) throw new RouteError("STRATEGY", `unknown strategy ${strategy}`, 400);
    Object.assign(this, { psps, strategy, costWeight, latencyWeight, explore, failover, useBreaker: breaker, inquiry, maxAttempts, budgetMs, rules, primary });
    this.r = mkRng(seed); this.stats = new Stats(statsOpts); this.breaker = new Breaker(breakerOpts); this.issuerBreaker = new Breaker({ window: 30, minVolume: 10, threshold: 0.6, cooldown: 15, probes: 4, probeSuccess: 3 });
    this.rr = 0; this.listeners = [];
    this.breaker.on((e) => this.emit({ kind: "breaker", scope: "psp", ...e })); this.issuerBreaker.on((e) => this.emit({ kind: "breaker", scope: "issuer", ...e }));
  }
  on(fn) { this.listeners.push(fn); return this; }
  emit(e) { for (const f of this.listeners) f(e); }
  key(psp, p) { return `${psp}|${p.method}`; }
  /** Eligible PSPs after capability, compliance and merchant rules. Returns [{psp, excluded}] for explainability. */
  eligible(p, { domesticOnly = false } = {}) {
    return this.psps.map((psp) => {
      let excluded = supports(psp, p); if (!excluded && domesticOnly && !psp.local) excluded = "data-localisation";
      if (!excluded) for (const r of this.rules) { const v = r(p, psp); if (v) { excluded = v; break; } }
      return { psp, excluded };
    });
  }
  /** Score and order candidates. Each row explains the decision. */
  plan(p, now = 0, opts = {}) {
    const rows = this.eligible(p, opts).map(({ psp, excluded }) => {
      const k = this.key(psp.id, p), m = psp.methods[p.method];
      if (excluded) return { psp: psp.id, name: psp.name, excluded };
      const fine = `${k}|${p.issuer}`, post = this.stats.posterior(fine, k, now), mean = post.a / (post.a + post.b);
      const sample = this.strategy === "smart" && this.explore ? betaSample(this.r, post.a, post.b) : mean;
      const fee = feeFor(psp, p), feeRatio = fee / Math.max(1, p.amountInr), lat = this.stats.latency(k, now, m.p50);
      const state = this.useBreaker ? this.breaker.state(k, now) : "closed";
      const score = sample - this.costWeight * feeRatio - this.latencyWeight * (lat / 10000);
      return { psp: psp.id, name: psp.name, sr: mean, sample, n: post.n, fee, feeBps: feeRatio * 1e4, lat, score, state };
    });
    const ok = rows.filter((r) => !r.excluded);
    if (!ok.length) return { order: [], rows };
    let order;
    if (this.strategy === "smart") order = ok.slice().sort((a, b) => (a.state === "open") - (b.state === "open") || b.score - a.score);
    else if (this.strategy === "static") { const pri = ok.find((r) => r.psp === this.primary[p.method]) || ok[0]; order = [pri]; }
    else if (this.strategy === "cheapest") order = [ok.slice().sort((a, b) => a.fee - b.fee)[0]];
    else { const i = this.rr++ % ok.length; order = [...ok.slice(i), ...ok.slice(0, i)]; if (this.strategy === "round-robin") order = order.slice(0, 1); }
    return { order, rows };
  }
  /** Run the payment against a network. Never captures twice in smart mode. */
  process(p, network, now = 0, opts = {}) {
    const { order, rows } = this.plan(p, now, opts), attempts = []; let elapsed = 0, captures = 0, result = null;
    if (!order.length) return { id: p.id, status: "failed", code: "no_route", attempts, rows, latency: 0, fee: 0, captures: 0 };
    const smart = this.strategy === "smart", naive = this.strategy === "naive-retry", max = smart ? (this.failover ? this.maxAttempts : 1) : naive ? this.maxAttempts : 1;
    const iKey = `issuer:${p.issuer}|${p.method}`;
    // Issuer-wide outage: one attempt only (no failover can help) and suggest another method to the customer.
    const issuerOpen = smart && this.useBreaker && this.issuerBreaker.state(iKey, now) === "open";
    const limit = issuerOpen ? 1 : max;
    const allOpen = smart && this.useBreaker && order.every((c) => this.breaker.state(this.key(c.psp, p), now) === "open");
    let n = 0;
    for (let i = 0; n < limit && i < order.length * (naive ? 2 : 1); i++) {
      const c = order[i % order.length], k = this.key(c.psp, p);
      // If every candidate's breaker is open, still try the best one rather than refuse the payment outright.
      const lastResort = allOpen && i === 0;
      if (smart && this.useBreaker && !lastResort && !this.breaker.allow(k, now)) { attempts.push({ psp: c.psp, skipped: "breaker-open" }); continue; }
      if (smart && elapsed + c.lat > this.budgetMs) { attempts.push({ psp: c.psp, skipped: "budget" }); break; }
      n++; const a = network.attempt(p, c.psp, n, now); elapsed += a.latency;
      const rec = { psp: c.psp, n, code: a.code, latency: Math.round(a.latency), ok: a.ok };
      attempts.push(rec);
      // Learning: technical outcome only. Hard declines say nothing about the PSP. Issuer-wide failures go to the issuer breaker.
      if (a.code === "issuer_unavailable") { if (!issuerOpen) this.issuerBreaker.record(iKey, false, now); }
      else { this.stats.record(`${k}|${p.issuer}`, a.tech, now, a.latency); this.stats.record(k, a.tech, now, a.latency); if (this.useBreaker) this.breaker.record(k, a.tech, now); if (a.tech && this.issuerBreaker.state(iKey, now) !== "open") this.issuerBreaker.record(iKey, true, now); }
      if (a.ok) { captures++; result = { status: "captured", psp: c.psp, code: "captured" }; break; }
      if (a.hard) { result = { status: "declined", psp: c.psp, code: a.code }; break; }
      if (a.code === "timeout") {
        if (smart && this.inquiry) { const q = network.inquire(p, c.psp, n, a); elapsed += q.latency; rec.inquiry = q.captured ? "captured" : "not-found";
          if (q.captured) { captures++; result = { status: "captured", psp: c.psp, code: "captured_late", late: true }; break; } }
        else if (a.late) { captures++; rec.lateCapture = true; } // money taken silently; a naive retry may take it again
      }
      result = { status: "failed", psp: c.psp, code: a.code };
    }
    if (!result) result = { status: "failed", code: "breaker_open" };
    if (result.status === "captured" && !result.late && captures > 1) result.duplicate = captures - 1;
    if (result.status !== "captured" && captures > 0) { result.status = "captured"; result.code = "captured_late"; result.unknownToMerchant = true; }
    if (issuerOpen) { result.issuerDown = true; if (result.status !== "captured") { result.fastFail = true; result.suggest = p.method === "card" ? "upi" : "card"; } }
    const psp = this.psps.find((x) => x.id === result.psp);
    return { id: p.id, ...result, attempts, rows, latency: Math.round(elapsed), captures, recovered: result.status === "captured" && attempts.filter((x) => !x.skipped).length > 1,
      fee: result.status === "captured" && psp ? feeFor(psp, p) * captures : 0 };
  }
}
