// Exact money in integer minor units, plus an FX desk with markup, quote expiry and DCC.
export const CURRENCIES = {
  INR: { d: 2, sym: "₹" }, USD: { d: 2, sym: "$" }, EUR: { d: 2, sym: "€" }, GBP: { d: 2, sym: "£" },
  AED: { d: 2, sym: "AED " }, SGD: { d: 2, sym: "S$" }, JPY: { d: 0, sym: "¥" }, KWD: { d: 3, sym: "KWD " },
};
export class MoneyError extends Error { constructor(code, message) { super(message); this.code = code; this.status = 400; } }
const cur = (c) => { const x = CURRENCIES[c]; if (!x) throw new MoneyError("CURRENCY", `unknown currency ${c}`); return x; };
export const decimals = (c) => cur(c).d;

/** "12.50" (exact decimal string) or an integer of minor units -> integer minor units. */
export function toMinor(v, c = "INR") {
  const { d } = cur(c);
  if (typeof v === "number") { if (!Number.isSafeInteger(v)) throw new MoneyError("AMOUNT", "numbers are minor units; pass decimals as strings like \"12.50\""); return v; }
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(String(v).trim());
  if (!m) throw new MoneyError("AMOUNT", `not an amount: ${v}`);
  const frac = m[3] || ""; if (frac.length > d) throw new MoneyError("PRECISION", `${c} has ${d} decimal places`);
  const n = Number(m[2]) * 10 ** d + Number(frac.padEnd(d, "0") || 0);
  if (!Number.isSafeInteger(n)) throw new MoneyError("AMOUNT", "amount too large");
  return m[1] ? -n : n;
}
export function fmtMoney(minor, c = "INR") {
  const { d, sym } = cur(c), v = minor / 10 ** d;
  return (minor < 0 ? "-" : "") + sym + Math.abs(v).toLocaleString(c === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtShort(minor, c = "INR") {
  const { d, sym } = cur(c), v = Math.abs(minor / 10 ** d), s = minor < 0 ? "-" : "";
  if (c === "INR") return s + sym + (v >= 1e7 ? (v / 1e7).toFixed(2) + " Cr" : v >= 1e5 ? (v / 1e5).toFixed(2) + " L" : v >= 1e3 ? (v / 1e3).toFixed(1) + "k" : v.toFixed(0));
  return s + sym + (v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "k" : v.toFixed(d ? 2 : 0));
}
/** Banker's rounding (half to even) of a real number to an integer. */
export function roundHalfEven(x) { const f = Math.floor(x), r = x - f; if (Math.abs(r - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1; return Math.round(x); }
/** Fee in minor units: pct is a fraction, fixed is minor units. Rounded half-even. */
export const feeOf = (amount, { pct = 0, fixed = 0 } = {}) => roundHalfEven(amount * pct) + fixed;

/** Illustrative mid rates: INR per one unit of currency. Not live market data. */
export const MID = { INR: 1, USD: 84.12, EUR: 91.35, GBP: 109.6, AED: 22.9, SGD: 63.25, JPY: 0.5561, KWD: 274.4 };

export class FX {
  constructor({ rates = MID, markupBps = 250, ttl = 30, clock = () => Date.now() / 1000 } = {}) {
    this.rates = { ...rates }; this.markupBps = markupBps; this.ttl = ttl; this.clock = clock; this.quotes = new Map(); this.seq = 0;
  }
  mid(from, to) { cur(from); cur(to); if (!this.rates[from] || !this.rates[to]) throw new MoneyError("FX_RATE", `no rate ${from}/${to}`); return this.rates[from] / this.rates[to]; }
  /** Convert minor units of `from` into minor units of `to` at a rate (to per from). */
  convert(amount, from, to, rate = this.mid(from, to)) { return roundHalfEven((amount / 10 ** decimals(from)) * rate * 10 ** decimals(to)); }
  /** A firm quote. The customer rate is worse than mid by markupBps; the quote expires after ttl seconds. */
  quote(amount, from, to, { markupBps = this.markupBps } = {}) {
    const mid = this.mid(from, to), rate = from === to ? 1 : mid * (1 - markupBps / 1e4);
    const q = { id: "fxq_" + (++this.seq).toString(36), from, to, amount, mid, rate, markupBps: from === to ? 0 : markupBps,
      converted: this.convert(amount, from, to, rate), atMid: this.convert(amount, from, to, mid), expiresAt: this.clock() + this.ttl };
    q.spread = q.atMid - q.converted; this.quotes.set(q.id, q); return q;
  }
  /** Execute a quote. Expired or unknown quotes are refused so the customer never gets a stale rate. */
  execute(id) {
    const q = this.quotes.get(id); if (!q) throw new MoneyError("FX_QUOTE", "unknown quote");
    if (this.clock() > q.expiresAt) { this.quotes.delete(id); throw new MoneyError("FX_EXPIRED", "quote expired; request a new one"); }
    this.quotes.delete(id); return q;
  }
  /** Dynamic currency conversion: what the cardholder pays if billed in their own currency vs letting the card network convert. */
  dcc(amount, merchantCur, cardCur, { dccMarkupBps = 350, networkBps = 100 } = {}) {
    const mid = this.mid(merchantCur, cardCur);
    const viaDcc = this.convert(amount, merchantCur, cardCur, mid * (1 + dccMarkupBps / 1e4)), viaNetwork = this.convert(amount, merchantCur, cardCur, mid * (1 + networkBps / 1e4));
    return { merchantCur, cardCur, amount, viaDcc, viaNetwork, extra: viaDcc - viaNetwork, cheaper: viaDcc <= viaNetwork ? "dcc" : "network" };
  }
  /** Random-walk the rates (simulator only). */
  drift(r, vol = 0.0004) { for (const k of Object.keys(this.rates)) if (k !== "INR") this.rates[k] *= Math.exp(r.normal(0, vol)); }
}
