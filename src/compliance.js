// Pre-route compliance gate. Rules are modelled on common Indian and card-network requirements
// (illustrative, not legal advice): sanctions screening, Luhn and BIN checks, card-on-file tokenisation,
// additional factor of authentication for domestic cards, e-mandate limits, UPI limits,
// data localisation for domestic payments, and per-card velocity limits.
export const SANCTIONED = ["KP", "IR", "SY", "CU"];
export function luhn(pan) {
  const s = String(pan).replace(/\D/g, ""); if (s.length < 12 || s.length > 19) return false;
  let sum = 0; for (let i = 0; i < s.length; i++) { let d = +s[s.length - 1 - i]; if (i % 2) { d *= 2; if (d > 9) d -= 9; } sum += d; } return sum % 10 === 0;
}
/** Fictional BIN table: prefix -> network, issuer, country. Longest prefix wins. */
export const BINS = [
  { bin: "4", network: "visa", issuer: "INTL", country: "US" }, { bin: "5", network: "mastercard", issuer: "INTL", country: "GB" },
  { bin: "34", network: "amex", issuer: "INTL", country: "US" }, { bin: "37", network: "amex", issuer: "INTL", country: "US" },
  { bin: "411111", network: "visa", issuer: "SAHY", country: "IN" }, { bin: "422222", network: "visa", issuer: "GANG", country: "IN" },
  { bin: "433333", network: "visa", issuer: "DECN", country: "IN" }, { bin: "512345", network: "mastercard", issuer: "NARM", country: "IN" },
  { bin: "523456", network: "mastercard", issuer: "CSTL", country: "IN" }, { bin: "6070", network: "rupay", issuer: "SAHY", country: "IN" },
  { bin: "6080", network: "rupay", issuer: "DECN", country: "IN" }, { bin: "6521", network: "rupay", issuer: "GANG", country: "IN" },
  { bin: "376000", network: "amex", issuer: "CSTL", country: "IN" }, { bin: "4400", network: "visa", issuer: "INTL", country: "AE" },
];
export function binLookup(pan, table = BINS) { const s = String(pan).replace(/\D/g, ""); let best = null; for (const b of table) if (s.startsWith(b.bin) && (!best || b.bin.length > best.bin.length)) best = b; return best; }
export const maskPan = (pan) => { const s = String(pan).replace(/\D/g, ""); return s.slice(0, 6) + "•".repeat(Math.max(0, s.length - 10)) + s.slice(-4); };

export class Compliance {
  constructor({ sanctioned = SANCTIONED, upiLimit = 100000_00, emandateLimit = 15000_00, velocity = { n: 5, window: 600 }, localisation = true } = {}) {
    Object.assign(this, { sanctioned, upiLimit, emandateLimit, velocity, localisation }); this.seen = new Map(); this.stats = {};
  }
  /** Returns { ok, code, reason, require: ["3ds"|"afa"], domesticOnly, card } and never mutates the payment. */
  check(p, now = 0) {
    const out = { ok: true, require: [], domesticOnly: false, notes: [] }, block = (code, reason) => { this.stats[code] = (this.stats[code] || 0) + 1; return { ...out, ok: false, code, reason }; };
    const country = p.country || "IN";
    if (this.sanctioned.includes(country) || this.sanctioned.includes(p.card?.country)) return block("SANCTIONS", `country ${country} is on the sanctions list`);
    if (p.method === "card") {
      const c = p.card || {};
      if (c.pan) {
        if (!luhn(c.pan)) return block("INVALID_CARD", "card number fails the Luhn check");
        if (p.saveCard || p.recurring) return block("COF_TOKEN_REQUIRED", "saved and recurring cards must use a network token, not a raw card number");
        const b = binLookup(c.pan); if (b) out.card = { network: b.network, issuer: b.issuer, country: b.country, masked: maskPan(c.pan) };
      }
      const cardCountry = out.card?.country || c.country || (p.international ? "XX" : "IN");
      if (cardCountry === "IN" && p.currency === "INR") {
        if (p.recurring && p.mandate) { if (p.amountInr > this.emandateLimit && !p.threeDS) out.require.push("afa"); out.notes.push("e-mandate"); }
        else if (!p.threeDS) out.require.push("3ds");
      }
    }
    if (p.method === "upi" && p.amountInr > this.upiLimit) return block("UPI_LIMIT", `UPI payments are limited to ₹${(this.upiLimit / 100).toLocaleString("en-IN")}`);
    const fp = p.card?.token || p.card?.pan || p.vpa; if (fp) {
      const h = (this.seen.get(fp) || []).filter((t) => now - t < this.velocity.window); h.push(now); this.seen.set(fp, h);
      if (h.length > this.velocity.n) return block("VELOCITY", `${h.length} attempts in ${this.velocity.window / 60} min on one instrument`);
    }
    if (this.localisation && country === "IN" && p.currency === "INR" && !p.international) out.domesticOnly = true;
    return out;
  }
}
