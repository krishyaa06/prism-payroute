#!/usr/bin/env node
// Prism PayRoute CLI
import { Platform, Gateway, Router, Network, PSPS, STRATEGIES, FX, Disputes, luhn, binLookup, maskPan, fmtMoney, fmtShort, toMinor, feeFor } from "../src/index.js";
import { createServer } from "../src/node/server.js";
import { c, table, header, bar, spark, num, ms, fail } from "../src/lib/cli.js";

const argv = process.argv.slice(2), cmd = argv[0] || "help";
const opt = (k, d) => { const i = argv.indexOf("--" + k); if (i < 0) return d; const v = argv[i + 1]; return v === undefined || v.startsWith("--") ? true : v; };
const pct = (x, d = 2) => (x * 100).toFixed(d) + "%";
const stateCol = (s) => (s === "closed" ? c.green(s) : s === "open" ? c.red(s) : c.yellow(s));

function compare(rep) {
  const rows = Object.entries(rep.strategies).map(([s, v]) => [s === "smart" ? c.bold(c.accent(s)) : s, pct(v.authRate), pct(v.techRate), v.feeBps.toFixed(1), num(v.p50) + "ms", num(v.p95) + "ms", num(v.recovered), v.duplicates ? c.red(num(v.duplicates)) : "0", v.silentCaptures ? c.yellow(num(v.silentCaptures)) : "0"]);
  return table(rows, { head: ["strategy", "auth rate", "excl. hard", "fee bps", "p50", "p95", "recovered", "double", "silent"], align: ["", "right", "right", "right", "right", "right", "right", "right", "right"] });
}
const cmds = {
  async demo() {
    console.log(header("Prism PayRoute", "· smart payment routing demo\n"));
    const P = new Platform({ seed: 12 });
    console.log(c.bold("1. Calm traffic, 60 s at 14 payments/s")); P.run(60); console.log(compare(P.report()) + "\n");
    console.log(c.bold("2. NeoRail goes down for 60 s (its UPI share was the largest)"));
    const evs = []; P.on((e) => { if (e.kind === "breaker") evs.push(e); }); P.outage("neorail", { secs: 60 }); P.run(75);
    for (const e of evs.slice(0, 6)) console.log("   " + c.dim(`t=${e.t.toFixed(1)}s`) + ` breaker ${e.key} ${stateCol(e.from)} → ${stateCol(e.to)} ${c.dim(e.why)}`);
    console.log(compare(P.report()) + "\n");
    console.log(c.bold("3. Ganga Bank's switch fails on every PSP for 30 s")); evs.length = 0; P.issuerDown("GANG", { secs: 30 }); P.run(45);
    for (const e of evs.filter((e) => e.scope === "issuer").slice(0, 3)) console.log("   " + c.dim(`t=${e.t.toFixed(1)}s`) + ` ${e.key} ${stateCol(e.from)} → ${stateCol(e.to)} ${c.dim(e.why)}`);
    const r = P.report(); console.log(`   smart router stopped failing over for that issuer and suggested another method ${c.bold(num(r.strategies.smart.fastFails))} times\n`);
    console.log(c.bold("4. One routing decision, explained"));
    const p = { id: "demo_card", method: "card", network: "visa", issuer: "DECN", currency: "INR", amountInr: 450000, threeDS: true };
    await cmds.explain(p, P.routers.smart, P.t);
    console.log(c.bold("\n5. Compliance gate"));
    const G = new Gateway({ clock: () => 0 });
    for (const [label, b] of [["card without 3DS", { method: "card", amount: "2499", card: { pan: "4111111111111111" } }], ["raw PAN saved for later", { method: "card", amount: "999", saveCard: true, card: { pan: "4111111111111111" } }],
      ["bad card number", { method: "card", amount: "999", card: { pan: "4111111111111112" } }], ["UPI over ₹1 lakh", { method: "upi", amount: "150000" }], ["sanctioned country", { method: "card", amount: "50", country: "KP", currency: "USD", card: { token: "t" } }]]) {
      const x = G.pay(b); console.log(`   ${label.padEnd(26)} ${x.status === "captured" ? c.green(x.status) : c.yellow(x.status)} ${c.dim(x.code || x.action || "")}`);
    }
    console.log(c.bold("\n6. FX and DCC")); const fx = new FX({ clock: () => 0 }); const q = fx.quote(toMinor("120.00", "USD"), "USD", "INR");
    console.log(`   $120.00 → ${fmtMoney(q.converted)} at ${q.rate.toFixed(4)} (mid ${q.mid.toFixed(4)}, markup ${q.markupBps} bps = ${fmtMoney(q.spread)})`);
    const d = fx.dcc(toMinor("10000", "INR"), "INR", "USD"); console.log(`   ₹10,000 in USD: DCC ${fmtMoney(d.viaDcc, "USD")} vs card network ${fmtMoney(d.viaNetwork, "USD")} → ${c.yellow(fmtMoney(d.extra, "USD") + " more with DCC")}`);
    console.log(c.bold("\n7. Disputes")); const s = r.disputes; console.log(`   ${s.total} chargebacks, ${s.won} won, ${s.lost} lost, ${s.accepted} accepted, ratio ${pct(s.ratio, 3)} ${s.monitored ? c.red("(over network monitoring threshold)") : c.green("(under 0.9% monitoring threshold)")}`);
    console.log(c.dim("\nTry: payroute simulate --scenario outage · payroute route --method card --issuer DECN · payroute serve"));
  },
  explain(p, R = new Router({ explore: false }), now = 0, o = {}) {
    const { order, rows } = R.plan(p, now, o);
    console.log(c.dim(`   ${p.method} ${p.network || ""} ${p.issuer} ${fmtMoney(p.amountInr)}`));
    console.log(table(rows.map((r) => r.excluded ? [r.name, c.dim("—"), "", "", "", "", c.dim("excluded: " + r.excluded)] : [order[0]?.psp === r.psp ? c.bold(c.accent("▸ " + r.name)) : "  " + r.name, pct(r.sr, 1), r.sample === r.sr ? c.dim("—") : pct(r.sample, 1), r.feeBps.toFixed(0), num(r.lat) + "ms", r.score.toFixed(4), stateCol(r.state)]),
      { head: ["PSP", "est. SR", "sampled", "fee bps", "latency", "score", "breaker"], align: ["", "right", "right", "right", "right", "right"] }));
  },
  async route() {
    const G = new Gateway({ router: new Router({ explore: false }), clock: () => 0 });
    const body = { method: opt("method", "card"), amount: String(opt("amount", "2500")), currency: opt("currency", "INR"), issuer: opt("issuer"), network: opt("network", opt("method", "card") === "card" ? "visa" : undefined), threeDS: !opt("no-3ds", false), country: opt("country", "IN") };
    if (opt("pan")) body.card = { pan: String(opt("pan")) };
    const r = G.route(body); console.log(header("route", "dry run"));
    if (!r.compliance.ok) return console.log(c.red(`blocked: ${r.compliance.code} — ${r.compliance.reason}`));
    if (r.compliance.require.length) console.log(c.yellow(`step-up required: ${r.compliance.require.join(", ")}`));
    if (r.compliance.domesticOnly) console.log(c.dim("domestic payment: only PSPs storing data in India are eligible"));
    await cmds.explain(G.normalise(body), G.router, 0, { domesticOnly: r.compliance.domesticOnly });
  },
  simulate() {
    const secs = +opt("seconds", 180), sc = opt("scenario", "mixed"), P = new Platform({ seed: +opt("seed", 12), rate: +opt("rate", 14) });
    console.log(header("simulate", `${secs}s · ${sc} · seed ${P.seed}`));
    const trips = []; P.on((e) => e.kind === "breaker" && e.to === "open" && trips.push(e));
    const plan = { calm: [], outage: [[0.25, () => P.outage("neorail", { secs: secs * 0.35 })]], degrade: [[0.25, () => P.degrade("kavach", { secs: secs * 0.4 })]], issuer: [[0.3, () => P.issuerDown("GANG", { secs: secs * 0.25 })]],
      mixed: [[0.2, () => P.outage("neorail", { secs: secs * 0.2 })], [0.45, () => P.degrade("kavach", { secs: secs * 0.2, method: "card" })], [0.7, () => P.issuerDown("GANG", { secs: secs * 0.12 })]] }[sc];
    if (!plan) fail(`unknown scenario ${sc} (calm, outage, degrade, issuer, mixed)`);
    const live = []; let done = 0;
    for (let s = 0; s < secs; s += 0.25) { for (const [at, f] of plan) if (s >= at * secs && s - 0.25 < at * secs) f(); P.step(0.25); if (++done % 20 === 0) live.push(P.report().strategies.smart.live); }
    const r = P.report(); console.log(c.dim(`smart live auth rate `) + spark(live) + "\n" + compare(r));
    console.log(c.dim(`\nbreaker trips: ${trips.length} · blocked by compliance: ${JSON.stringify(r.blocked)} · 3DS step-ups: ${r.stepUps} (${r.abandoned} abandoned)`));
    const S = r.strategies.smart, base = r.strategies.cheapest; console.log(`smart vs cheapest: ${c.green("+" + ((S.authRate - base.authRate) * 100).toFixed(2) + " pp")} auth rate, ${(S.feeBps - base.feeBps).toFixed(1)} bps fees, ${num(Math.round((S.authRate - base.authRate) * S.payments))} more payments captured`);
    console.log("share: " + Object.entries(S.share).map(([k, v]) => `${k} ${pct(v / S.payments, 0)}`).join(" · "));
  },
  fx() {
    const from = String(opt("from", "USD")), to = String(opt("to", "INR")), amt = toMinor(String(opt("amount", "100")), from), fx = new FX({ clock: () => 0, markupBps: +opt("markup", 250) });
    const q = fx.quote(amt, from, to); console.log(header("fx quote"));
    console.log(table([["amount", fmtMoney(amt, from)], ["mid rate", q.mid.toFixed(6)], ["customer rate", q.rate.toFixed(6)], ["converted", fmtMoney(q.converted, to)], ["at mid", fmtMoney(q.atMid, to)], ["markup", `${q.markupBps} bps = ${fmtMoney(q.spread, to)}`], ["expires", `${fx.ttl}s`]]));
    if (to !== "INR" || from === "INR") { const d = fx.dcc(from === "INR" ? amt : toMinor("1000", "INR"), "INR", from === "INR" ? to : from); console.log(`\nDCC: ${fmtMoney(d.viaDcc, d.cardCur)} vs network ${fmtMoney(d.viaNetwork, d.cardCur)} (${fmtMoney(d.extra, d.cardCur)} more)`); }
  },
  dispute() {
    let t = 0; const D = new Disputes({ day: 1, rng: () => 0.3 }); console.log(header("dispute lifecycle"));
    const pay = (id, threeDS) => ({ id, amountInr: 349900, psp: "kavach", threeDS });
    const show = (d) => console.log(`  ${d.id} ${d.reason.padEnd(14)} ${d.history.map((h) => h.to).join(c.dim(" → "))} ${c.dim(`win p ${pct(d.winProb, 0)}`)}`);
    const a = D.open(pay("p1", true), { reason: "fraud", at: t }); D.act(a.id, "represent", { at: 1 }); D.tick(12);
    const b = D.open(pay("p2", false), { reason: "fraud", at: t }); D.act(b.id, "accept", { at: 2 });
    const d3 = D.open(pay("p3", false), { reason: "not_received", at: t }); D.act(d3.id, "represent", { at: 3, evidence: ["delivery", "comms"] }); D.tick(14);
    const d4 = D.open(pay("p4", false), { reason: "not_as_described", at: t }); D.tick(8);
    for (const d of D.list()) show(d);
    try { D.act(d4.id, "represent", { at: 9 }); } catch (e) { console.log(c.yellow(`  ${e.code}: ${e.message}`)); }
    const s = D.summary(400); console.log(c.dim(`  won ${s.won} · lost ${s.lost} · accepted ${s.accepted} · lost ${fmtMoney(s.lostAmount)} incl. fees`));
  },
  card() {
    const pan = String(opt("pan", argv[1] || "4111111111111111")), b = binLookup(pan);
    console.log(header("card", maskPan(pan))); console.log(table([["luhn", luhn(pan) ? c.green("valid") : c.red("invalid")], ["network", b?.network || "?"], ["issuer", b?.issuer || "?"], ["country", b?.country || "?"]]));
  },
  psps() { console.log(table(PSPS.map((p) => [p.name, p.local ? "IN" : c.yellow("abroad"), p.currencies.join(" "), p.networks.join(" "), Object.entries(p.methods).map(([m, x]) => `${m} ${(x.fee.pct * 100).toFixed(2)}%`).join(" · ")]), { head: ["PSP", "data", "currencies", "networks", "methods · fee"] })); console.log(c.dim("fees and success rates are illustrative")); },
  strategies() { console.log(table(Object.entries(STRATEGIES).map(([k, v]) => [c.accent(k), v]))); },
  bench() {
    const n = +opt("n", 100000), R = new Router({ seed: 1 }), N = new Network({ seed: 1 }); const P = new Platform({ seed: 1, strategies: ["smart"] }); const ps = Array.from({ length: 5000 }, () => P.gen());
    let t0 = performance.now(); for (let i = 0; i < n; i++) R.plan(ps[i % ps.length], i / 1000); const tp = performance.now() - t0;
    t0 = performance.now(); for (let i = 0; i < n; i++) R.process({ ...ps[i % ps.length], id: "b" + i }, N, i / 1000); const tr = performance.now() - t0;
    console.log(header("bench", `${num(n)} payments`)); console.log(table([["plan (score + rank)", num(Math.round(n / (tp / 1000))) + "/s", ms(tp / n) + " each"], ["process (incl. failover)", num(Math.round(n / (tr / 1000))) + "/s", ms(tr / n) + " each"]], { align: ["", "right", "right"] }));
  },
  serve() { const port = +opt("port", 8790); createServer(new Gateway()).listen(port, () => console.log(header("serve", `http://localhost:${port}`) + c.dim("\n  POST /v1/payments · POST /v1/route · GET /v1/health · POST /v1/fx/quote · /v1/disputes"))); },
  help() { console.log(header("payroute", "smart payment routing") + "\n\n" + table([["demo", "guided tour"], ["simulate [--scenario calm|outage|degrade|issuer|mixed --seconds 180]", "compare routing strategies"], ["route [--method --amount --issuer --network --pan --no-3ds]", "explain one routing decision"], ["fx [--from USD --to INR --amount 100]", "quote and DCC"], ["dispute", "chargeback lifecycle"], ["card <pan>", "Luhn + BIN"], ["psps · strategies", "catalog"], ["bench [--n 100000]", "throughput"], ["serve [--port 8790]", "HTTP API"]])); },
};
if (!cmds[cmd]) fail(`unknown command ${cmd}; try payroute help`);
await cmds[cmd]();
