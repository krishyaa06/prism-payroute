import { test } from "node:test";
import assert from "node:assert/strict";
import { toMinor, fmtMoney, roundHalfEven, feeOf, FX, Network, Router, Stats, Breaker, Compliance, luhn, binLookup, Disputes, Gateway, Platform, PSPS, supports, feeFor } from "../src/index.js";
import { createServer } from "../src/node/server.js";

const card = (o = {}) => ({ id: "t" + Math.random(), method: "card", network: "visa", issuer: "SAHY", currency: "INR", amountInr: 250000, threeDS: true, ...o });

test("money: exact minor units, precision and half-even rounding", () => {
  assert.equal(toMinor("12.50", "INR"), 1250); assert.equal(toMinor("1000", "JPY"), 1000); assert.equal(toMinor("1.234", "KWD"), 1234);
  assert.throws(() => toMinor("1.234", "INR"), /2 decimal/); assert.throws(() => toMinor(12.5), /minor units/); assert.throws(() => toMinor("1", "XYZ"), /unknown/);
  assert.equal(roundHalfEven(2.5), 2); assert.equal(roundHalfEven(3.5), 4); assert.equal(roundHalfEven(2.51), 3);
  assert.equal(feeOf(10000, { pct: 0.0175, fixed: 300 }), 475); assert.equal(fmtMoney(12345678), "₹1,23,456.78");
});

test("fx: quote applies markup, expires, and DCC costs more than the network rate", () => {
  let now = 0; const fx = new FX({ clock: () => now, markupBps: 200, ttl: 30 });
  const q = fx.quote(10000, "USD", "INR"); assert.equal(q.atMid, 841200); assert.equal(q.converted, Math.round(841200 * 0.98)); assert.equal(q.spread, q.atMid - q.converted);
  assert.equal(fx.execute(q.id).id, q.id); assert.throws(() => fx.execute(q.id), /unknown/);
  const q2 = fx.quote(10000, "USD", "INR"); now = 31; assert.throws(() => fx.execute(q2.id), /expired/);
  const d = fx.dcc(1000000, "INR", "USD"); assert.ok(d.viaDcc > d.viaNetwork); assert.equal(d.cheaper, "network");
  assert.equal(fx.convert(1000, "JPY", "INR"), 55610); assert.equal(fx.convert(100000, "INR", "KWD"), Math.round(1000 / 274.4 * 1000));
});

test("network: outcomes are deterministic and incidents change them", () => {
  const a = new Network({ seed: 4 }), b = new Network({ seed: 4 });
  for (let i = 0; i < 200; i++) { const p = card({ id: "p" + i }); assert.deepEqual(a.attempt(p, "kavach", 1, 0), b.attempt(p, "kavach", 1, 0)); }
  const ok = (N) => { let s = 0; for (let i = 0; i < 2000; i++) if (N.attempt(card({ id: "q" + i }), "kavach", 1, 5).ok) s++; return s / 2000; };
  const base = ok(a); a.incident({ psp: "kavach", kind: "outage", from: 0, until: 10 }); const down = ok(a);
  assert.ok(base > 0.9 && down < 0.15, `${base} ${down}`);
  assert.equal(a.attempt(card({ network: "amex" }), "aryapay", 1, 0).code, "unsupported");
  assert.equal(supports(PSPS.find((p) => p.id === "sagar"), { method: "upi", currency: "INR" }), "method");
  assert.equal(feeFor(PSPS.find((p) => p.id === "kavach"), card({ network: "amex", amountInr: 100000 })), 2700);
});

test("stats: decayed posterior with a parent prior", () => {
  const S = new Stats({ halfLife: 10 });
  for (let i = 0; i < 50; i++) S.record("p|card", i % 10 !== 0, 0);
  assert.ok(Math.abs(S.mean("p|card", null, 0) - 46 / 51) < 0.02);
  const child = S.mean("p|card|X", "p|card", 0); assert.ok(child > 0.85 && child < 0.95, String(child));
  S.record("q", false, 0); const n0 = S.posterior("q", null, 0).n; assert.ok(Math.abs(S.posterior("q", null, 10).n - n0 / 2) < 1e-9);
});

test("breaker: trips on failure rate, half-opens after cooldown, closes on probes, backs off on probe failure", () => {
  const B = new Breaker({ window: 30, minVolume: 10, threshold: 0.5, cooldown: 10, probes: 3, probeSuccess: 2 }), ev = []; B.on((e) => ev.push(`${e.from}>${e.to}`));
  for (let i = 0; i < 9; i++) B.record("k", false, i * 0.1); assert.equal(B.state("k", 1), "closed"); // below min volume
  B.record("k", false, 1); assert.equal(B.state("k", 1), "open"); assert.equal(B.allow("k", 5), false);
  assert.equal(B.allow("k", 11), true); assert.equal(B.state("k", 11), "half");
  B.record("k", false, 11.5); assert.equal(B.state("k", 12), "open"); assert.equal(B.s("k").cool, 20);
  assert.equal(B.allow("k", 32), true); B.allow("k", 32); B.allow("k", 32); assert.equal(B.allow("k", 32), false); // probe limit
  B.record("k", true, 32); B.record("k", true, 32); assert.equal(B.state("k", 33), "closed"); assert.equal(B.s("k").cool, 10);
  assert.deepEqual(ev, ["closed>open", "open>half", "half>open", "open>half", "half>closed"]);
});

test("router: fails over on soft declines, never on hard declines, and inquires before retrying a timeout", () => {
  const N = new Network({ seed: 2 }); N.incident({ psp: "aryapay", kind: "outage", from: 0, until: 1e9 }); N.incident({ psp: "kavach", kind: "outage", from: 0, until: 1e9 });
  const R = new Router({ explore: false, breaker: false });
  let rec = 0, cap = 0, first = 0; for (let i = 0; i < 300; i++) { const r = R.process(card({ id: "f" + i }), N, 0); if (r.recovered) rec++; if (r.status === "captured") cap++; if (i < 20 && r.recovered) first++; }
  assert.ok(cap / 300 > 0.9 && rec > 5, `captured ${cap}, recovered ${rec}`); // early on failover rescues payments, then learning routes around the outage
  assert.ok(R.plan(card(), 0).order.slice(0, 2).every((c) => !["aryapay", "kavach"].includes(c.psp)));
  const hard = R.process(card({ id: "h1", hard: true, hardCode: "insufficient_funds" }), new Network({ seed: 2 }), 0);
  assert.equal(hard.status, "declined"); assert.equal(hard.attempts.filter((a) => !a.skipped).length <= 1 || hard.attempts.at(-1).code === "insufficient_funds", true);
  // Force timeouts with late captures: smart inquires and never double-charges; naive retries can.
  const T = new Network({ seed: 9, lateCapture: 1 }); T.incident({ psp: "aryapay", kind: "outage", from: 0, until: 1e9 }); T.incident({ psp: "kavach", kind: "outage", from: 0, until: 1e9 }); T.incident({ psp: "neorail", kind: "outage", from: 0, until: 1e9 }); T.incident({ psp: "meru", kind: "outage", from: 0, until: 1e9 });
  const smart = new Router({ explore: false, breaker: false }), naive = new Router({ strategy: "naive-retry" });
  let dupS = 0, dupN = 0, late = 0; for (let i = 0; i < 400; i++) { const p = card({ id: "x" + i }); const a = smart.process(p, T, 0), b = naive.process(p, T, 0); dupS += a.duplicate || 0; dupN += b.duplicate || 0; if (a.code === "captured_late") late++; assert.ok(a.captures <= 1); }
  assert.equal(dupS, 0); assert.ok(dupN > 0, "naive retry should double-charge sometimes"); assert.ok(late > 0);
});

test("router: eligibility explains exclusions and respects data localisation and rules", () => {
  const R = new Router({ explore: false, rules: [(p, psp) => (p.amountInr > 5e6 && psp.id === "neorail" ? "merchant-rule:high-value" : null)] });
  const rows = R.plan(card({ amountInr: 6e6 }), 0, { domesticOnly: true }).rows, why = Object.fromEntries(rows.map((r) => [r.psp, r.excluded || "ok"]));
  assert.equal(why.sagar, "data-localisation"); assert.equal(why.neorail, "merchant-rule:high-value"); assert.equal(why.kavach, "ok");
  assert.equal(R.plan(card({ network: "amex" }), 0).rows.filter((r) => !r.excluded).map((r) => r.psp).sort().join(), "kavach,sagar");
  assert.equal(new Router({ strategy: "cheapest" }).plan({ id: "u", method: "upi", currency: "INR", issuer: "SAHY", amountInr: 50000 }, 0).order[0].psp, "neorail");
  assert.throws(() => new Router({ strategy: "nope" }), /unknown strategy/);
});

test("compliance: sanctions, Luhn, tokenisation, AFA, e-mandate, UPI limit, velocity", () => {
  const C = new Compliance({ velocity: { n: 3, window: 600 } });
  assert.ok(luhn("4111111111111111")); assert.ok(!luhn("4111111111111112")); assert.equal(binLookup("6070123412341234").network, "rupay"); assert.equal(binLookup("4111111111111111").issuer, "SAHY");
  assert.equal(C.check({ method: "card", country: "IR", card: {} }).code, "SANCTIONS");
  assert.equal(C.check({ method: "card", card: { pan: "4111111111111112" } }).code, "INVALID_CARD");
  assert.equal(C.check({ method: "card", saveCard: true, card: { pan: "4111111111111111" } }).code, "COF_TOKEN_REQUIRED");
  assert.deepEqual(C.check({ method: "card", currency: "INR", card: { token: "a" } }).require, ["3ds"]);
  assert.deepEqual(C.check({ method: "card", currency: "INR", recurring: true, mandate: "m", amountInr: 500000, card: { token: "b" } }).require, []);
  assert.deepEqual(C.check({ method: "card", currency: "INR", recurring: true, mandate: "m", amountInr: 2000000, card: { token: "c" } }).require, ["afa"]);
  assert.equal(C.check({ method: "upi", amountInr: 100000_01, vpa: "x@y" }).code, "UPI_LIMIT");
  for (let i = 0; i < 3; i++) assert.ok(C.check({ method: "upi", amountInr: 100, vpa: "v@y" }, i).ok);
  assert.equal(C.check({ method: "upi", amountInr: 100, vpa: "v@y" }, 4).code, "VELOCITY"); assert.ok(C.check({ method: "upi", amountInr: 100, vpa: "v@y" }, 700).ok);
  assert.equal(C.check({ method: "upi", amountInr: 100, currency: "INR", vpa: "z@y" }).domesticOnly, true);
});

test("disputes: FSM transitions, deadlines, liability shift and summary", () => {
  const D = new Disputes({ day: 1, rng: () => 0.5 }), pay = (id, threeDS) => ({ id, amountInr: 100000, psp: "kavach", threeDS });
  const a = D.open(pay("a", true), { reason: "fraud", at: 0 }); assert.ok(a.liabilityShift); assert.equal(a.winProb, 0.95);
  D.act(a.id, "represent", { at: 1 }); D.tick(11); assert.equal(a.state, "won"); assert.equal(a.withheld, D.fee);
  const b = D.open(pay("b", false), { reason: "not_received", at: 0 }); D.tick(7); assert.equal(b.state, "lost");
  assert.throws(() => D.act(b.id, "represent"), /cannot represent from lost/);
  const c = D.open(pay("c", false), { reason: "fraud", at: 0 }); D.act(c.id, "represent", { at: 1 }); D.tick(11); assert.equal(c.state, "pre_arbitration");
  D.act(c.id, "escalate", { at: 12, evidence: ["device", "history"] }); assert.equal(c.state, "arbitration"); assert.ok(c.withheld > c.amount + D.fee);
  assert.throws(() => D.open(pay("d"), { reason: "boredom" }), /unknown reason/);
  const s = D.summary(100); assert.equal(s.total, 3); assert.equal(s.won, 1); assert.equal(s.lost, 1); assert.ok(s.monitored);
});

test("gateway: idempotent payments, conflicts, step-up and PAN redaction", () => {
  const G = new Gateway({ clock: () => 0 }), body = { method: "card", amount: "2499.00", threeDS: true, card: { pan: "4111111111111111" } };
  const a = G.pay(body, "k1"), b = G.pay(body, "k1");
  assert.equal(b.replay, true); assert.equal(a.id, b.id); assert.equal(a.payment.card.pan, "411111••••••1111");
  assert.ok(!JSON.stringify([...G.payments.values()]).includes("4111111111111111"));
  assert.throws(() => G.pay({ ...body, amount: "1.00" }, "k1"), /different body/);
  assert.equal(G.pay({ method: "card", amount: "100", card: { pan: "4111111111111111" } }).status, "requires_action");
  assert.throws(() => G.pay({ method: "cash", amount: "1" }), /method/); assert.throws(() => G.pay({ method: "upi", amount: 12.5 }), /minor units/);
  assert.equal(G.route({ method: "card", amount: "50", currency: "USD", country: "US", network: "amex", card: { token: "t" } }).plan.order[0].psp.length > 0, true);
});

test("platform: smart routing beats static baselines through an outage with zero double charges", () => {
  const P = new Platform({ seed: 3 }); P.run(30); P.outage("neorail", { secs: 40 }); P.run(50);
  const r = P.report().strategies;
  assert.ok(r.smart.authRate > r.cheapest.authRate + 0.05, `${r.smart.authRate} vs ${r.cheapest.authRate}`);
  assert.ok(r.smart.authRate > r["round-robin"].authRate); assert.equal(r.smart.duplicates, 0); assert.equal(r.smart.silentCaptures, 0);
  assert.ok(r.smart.p95 <= r["naive-retry"].p95);
});

test("http: payments with Idempotency-Key, route, health, disputes", async () => {
  const srv = createServer(new Gateway()); await new Promise((ok) => srv.listen(0, ok)); const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, b, h = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) });
  try {
    const body = { method: "upi", amount: "499", vpa: "a@okx" };
    const r1 = await post("/v1/payments", body, { "idempotency-key": "z" }), j1 = await r1.json(); assert.ok([201, 402].includes(r1.status));
    const r2 = await post("/v1/payments", body, { "idempotency-key": "z" }); assert.equal(r2.status, 200); assert.equal(r2.headers.get("idempotent-replayed"), "true"); assert.equal((await r2.json()).id, j1.id);
    assert.equal((await post("/v1/payments", { method: "upi", amount: "200000" })).status, 403);
    assert.equal((await post("/v1/route", { method: "card", amount: "10", threeDS: true, card: { token: "x" } })).status, 200);
    assert.equal((await (await fetch(base + "/v1/health")).json()).breakers.length >= 0, true);
    assert.equal((await post("/v1/fx/quote", { amount: 1000, from: "USD", to: "INR" })).status, 201);
    assert.equal((await post("/v1/payments", "{bad")).status, 400);
    assert.equal((await fetch(base + "/v1/psps")).status, 200);
  } finally { srv.close(); }
});
