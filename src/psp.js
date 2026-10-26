// Payment service providers (fictional) and a ground-truth network model used by tests and the simulator.
// Every outcome is a pure function of (seed, payment id, PSP, attempt number, incidents), so different
// routers see exactly the same world and can be compared fairly.
import { bucket } from "./lib/hash.js";

export const METHODS = ["upi", "card", "netbanking", "wallet"];
export const ISSUERS = [
  { id: "SAHY", name: "Sahyadri Bank" }, { id: "GANG", name: "Ganga Bank" }, { id: "DECN", name: "Deccan Bank" },
  { id: "NARM", name: "Narmada Bank" }, { id: "CSTL", name: "Coastal Bank" }, { id: "INTL", name: "Foreign issuer" },
];
// Fees and success rates are illustrative, not anyone's real pricing.
export const PSPS = [
  { id: "aryapay", name: "AryaPay", color: "#5cc8ff", local: true, currencies: ["INR"], networks: ["visa", "mastercard", "rupay"],
    methods: { upi: { sr: 0.962, p50: 1800, fee: { pct: 0.002, fixed: 0 } }, card: { sr: 0.955, p50: 1400, fee: { pct: 0.02, fixed: 0 } },
      netbanking: { sr: 0.93, p50: 4200, fee: { pct: 0.019, fixed: 0 } }, wallet: { sr: 0.97, p50: 900, fee: { pct: 0.019, fixed: 0 } } },
    affinity: { GANG: 1.01, NARM: 0.985 } },
  { id: "kavach", name: "Kavach PG", color: "#7c5cff", local: true, currencies: ["INR", "USD"], networks: ["visa", "mastercard", "rupay", "amex"],
    methods: { upi: { sr: 0.94, p50: 2100, fee: { pct: 0.0025, fixed: 0 } }, card: { sr: 0.968, p50: 1250, fee: { pct: 0.018, fixed: 0 } },
      netbanking: { sr: 0.91, p50: 4500, fee: { pct: 0.02, fixed: 0 } } },
    affinity: { DECN: 0.965, SAHY: 1.012 }, amexBps: 90 },
  { id: "neorail", name: "NeoRail", color: "#34f5c5", local: true, currencies: ["INR"], networks: ["visa", "mastercard", "rupay"],
    methods: { upi: { sr: 0.975, p50: 1500, fee: { pct: 0.001, fixed: 0 } }, card: { sr: 0.92, p50: 1700, fee: { pct: 0.0195, fixed: 0 } },
      wallet: { sr: 0.96, p50: 1000, fee: { pct: 0.017, fixed: 0 } } },
    affinity: { SAHY: 1.015, CSTL: 0.97 } },
  { id: "meru", name: "Meru Bank PG", color: "#ffb547", local: true, currencies: ["INR"], networks: ["visa", "mastercard", "rupay"],
    methods: { upi: { sr: 0.95, p50: 2000, fee: { pct: 0.0015, fixed: 0 } }, card: { sr: 0.94, p50: 1900, fee: { pct: 0.0175, fixed: 300 } },
      netbanking: { sr: 0.965, p50: 3600, fee: { pct: 0.015, fixed: 500 } } },
    affinity: { DECN: 1.02, GANG: 0.98 } },
  { id: "sagar", name: "Sagar Global", color: "#ff5c8a", local: false, currencies: ["INR", "USD", "EUR", "GBP", "AED", "SGD"], networks: ["visa", "mastercard", "amex"],
    methods: { card: { sr: 0.952, p50: 1600, fee: { pct: 0.029, fixed: 0 } } }, affinity: { INTL: 1.03 }, crossBorderBps: 100, amexBps: 60 },
];
export const pspById = (id, list = PSPS) => list.find((p) => p.id === id);

/** Hard declines come from the customer's bank account or card, so no other PSP can fix them. */
export const HARD = { card: ["insufficient_funds", "do_not_honor", "expired_card", "suspected_fraud"], upi: ["insufficient_funds", "incorrect_pin", "debit_limit_exceeded"],
  netbanking: ["user_cancelled", "insufficient_funds"], wallet: ["insufficient_balance"] };
/** Soft declines are technical, so trying again elsewhere may succeed. */
export const SOFT = ["timeout", "gateway_error", "psp_unavailable", "issuer_unavailable", "rate_limited"];
export const isSoft = (code) => SOFT.includes(code);

/** Can this PSP take this payment at all (method, network, currency)? Returns null or a reason. */
export function supports(psp, p) {
  const m = psp.methods[p.method]; if (!m) return "method";
  if (p.method === "card" && p.network && !psp.networks.includes(p.network)) return "network";
  if (!psp.currencies.includes(p.currency)) return "currency";
  return null;
}
/** Fee for this payment on this PSP, in INR minor units, using amountInr. */
export function feeFor(psp, p) {
  const m = psp.methods[p.method]; if (!m) return Infinity;
  let pct = m.fee.pct; if (p.network === "amex") pct += (psp.amexBps || 0) / 1e4;
  if (p.international) pct += (psp.crossBorderBps || 0) / 1e4;
  return Math.round(p.amountInr * pct) + (m.fee.fixed || 0);
}

const z = (u) => Math.SQRT2 * erfinv(2 * Math.max(1e-9, Math.min(1 - 1e-9, u)) - 1); // standard normal from a uniform
function erfinv(x) { const w = -Math.log((1 - x) * (1 + x)); let p;
  if (w < 5) { const v = w - 2.5; p = 2.81022636e-08; for (const c of [3.43273939e-07, -3.5233877e-06, -4.39150654e-06, 0.00021858087, -0.00125372503, -0.00417768164, 0.246640727, 1.50140941]) p = c + p * v; }
  else { const v = Math.sqrt(w) - 3; p = -0.000200214257; for (const c of [0.000100950558, 0.00134934322, -0.00367342844, 0.00573950773, -0.0076224613, 0.00943887047, 1.00167406, 2.83297682]) p = c + p * v; }
  return p * x; }

export class Network {
  constructor({ seed = 1, psps = PSPS, timeoutMs = 8000, lateCapture = 0.4 } = {}) {
    this.seed = seed; this.psps = psps; this.timeoutMs = timeoutMs; this.lateCapture = lateCapture; this.incidents = [];
  }
  u(...k) { return bucket(this.seed, k.join("|")); }
  /** kind: outage (most calls fail fast), degrade (more failures, 3x latency), issuer (issuer down on every PSP). */
  incident({ psp = null, method = null, issuer = null, kind = "outage", from = 0, until = Infinity }) { const i = { psp, method, issuer, kind, from, until }; this.incidents.push(i); return i; }
  clear(now = Infinity) { this.incidents = this.incidents.filter((i) => i.until > now && now !== Infinity); }
  active(now) { return this.incidents.filter((i) => now >= i.from && now < i.until); }
  /** True technical success probability (before customer-level hard declines). */
  truth(pspId, p, now = 0) {
    const psp = pspById(pspId, this.psps), m = psp?.methods[p.method]; if (!m || supports(psp, p)) return 0;
    let sr = Math.min(0.995, m.sr * (psp.affinity?.[p.issuer] ?? 1));
    for (const i of this.active(now)) {
      if (i.kind === "issuer" && i.issuer === p.issuer && (!i.method || i.method === p.method)) sr *= 0.08;
      else if (i.psp === pspId && (!i.method || i.method === p.method)) sr *= i.kind === "outage" ? 0.05 : 0.55;
    }
    return sr;
  }
  attempt(p, pspId, n, now = 0) {
    const psp = pspById(pspId, this.psps), m = psp?.methods[p.method];
    if (!m || supports(psp, p)) return { ok: false, code: "unsupported", latency: 50, tech: false, hard: false };
    const act = this.active(now), issuerDown = act.some((i) => i.kind === "issuer" && i.issuer === p.issuer && (!i.method || i.method === p.method));
    const mine = act.filter((i) => i.psp === pspId && (!i.method || i.method === p.method)), outage = mine.some((i) => i.kind === "outage"), slow = mine.some((i) => i.kind === "degrade");
    let latency = m.p50 * Math.exp(0.42 * z(this.u(p.id, pspId, n, "lat"))) * (slow ? 3 : 1);
    if (this.u(p.id, pspId, n, "sr") < this.truth(pspId, p, now)) {
      latency = Math.min(latency, this.timeoutMs - 1);
      if (p.hard) return { ok: false, code: p.hardCode, latency, tech: true, hard: true };
      return { ok: true, code: "captured", latency, tech: true, hard: false };
    }
    const v = this.u(p.id, pspId, n, "code");
    let code = issuerDown && v < 0.9 ? "issuer_unavailable" : outage ? (v < 0.8 ? "psp_unavailable" : "timeout") : v < 0.36 ? "timeout" : v < 0.9 ? "gateway_error" : "rate_limited";
    if (code === "psp_unavailable" || code === "rate_limited") latency = 150 + 250 * this.u(p.id, pspId, n, "fast");
    if (code === "issuer_unavailable") latency = Math.min(latency, 2500);
    // A timeout is ambiguous: the PSP may still have captured the money after we stopped waiting.
    const late = code === "timeout" && !p.hard && this.u(p.id, pspId, n, "late") < this.lateCapture;
    if (code === "timeout") latency = this.timeoutMs;
    return { ok: false, code, latency, tech: false, hard: false, late };
  }
  /** Status inquiry after a timeout: did that attempt actually capture? */
  inquire(p, pspId, n, attempt) { return { captured: !!attempt?.late, latency: 300 + 300 * this.u(p.id, pspId, n, "inq") }; }
}
