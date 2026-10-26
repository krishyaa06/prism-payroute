import { Platform, PSPS, ISSUERS, METHODS, fmtMoney, fmtShort } from "../src/index.js";
import { $, esc, toast, Loop, bindLoop, LogView, Kpis, Chart, fit, hexA } from "./pro.js";

const OK = "#34f5c5", BAD = "#ff5c8a", WARN = "#ffb547", ACC = "#5cc8ff", ACC2 = "#7c5cff", MUTED = "#5f6884", TEXT = "#e6ebf5", mono = "JetBrains Mono, monospace";
const MCOL = { upi: "#34f5c5", card: "#5cc8ff", netbanking: "#c084fc", wallet: "#ffb547" }, MNAME = { upi: "UPI", card: "Cards", netbanking: "Netbanking", wallet: "Wallets" }, MSHORT = { upi: "UPI", card: "Card", netbanking: "NetB", wallet: "Wallet" };
const STATE_COL = { closed: OK, half: WARN, open: BAD };
const P = new Platform({ seed: 12, rate: 14, day: 6 }), R = P.routers.smart, DAY = P.disputes.day;
const clock = () => new Date(Date.UTC(2026, 9, 26, 14, 0) + P.t * 1000 + 19800e3).toISOString().slice(11, 19);
const log = new LogView($("#log"), 220), LOG = (h) => log.html(h, clock());
const pname = (id) => PSPS.find((p) => p.id === id)?.name || id, pcol = (id) => PSPS.find((p) => p.id === id)?.color || MUTED;
let warm = true, parts = [], marks = [], base = "cheapest", lastCard = null, lastFailover = null, lastIntl = null, routerFlash = 0, fx0 = { ...P.fx.rates };
const out = { captured: 0, declined: 0, failed: 0, blocked: 0 }, pstat = Object.fromEntries(PSPS.map((p) => [p.id, { ev: [], share: [] }])), mrate = Object.fromEntries(METHODS.map((m) => [m, []]));

// ---------- controls ----------
for (const p of PSPS) $("#psp").append(new Option(p.name, p.id)); $("#psp").value = "neorail";
for (const i of ISSUERS.slice(0, 5)) $("#iss").append(new Option(i.name, i.id)); $("#iss").value = "GANG";
for (const s of Object.keys(P.routers).filter((s) => s !== "smart")) $("#base").append(new Option("vs " + s, s)); $("#base").value = base;
$("#base").onchange = () => { base = $("#base").value; ch1.series[1].label = base; ch1.data[1] = []; paintAll(); };
$("#outage").onclick = () => { const id = $("#psp").value; P.outage(id, { secs: 30 }); LOG(`<span class="bad">INCIDENT</span> ${pname(id)} outage for 30 s <span class="dim">most calls fail fast or time out</span>`); toast(`${pname(id)} is down for 30 s`); };
$("#slow").onclick = () => { const id = $("#psp").value; P.degrade(id, { secs: 30 }); LOG(`<span class="warn">INCIDENT</span> ${pname(id)} degraded for 30 s <span class="dim">3× latency, 45% more failures</span>`); toast(`${pname(id)} is slow for 30 s`); };
$("#bank").onclick = () => { const id = $("#iss").value, n = ISSUERS.find((i) => i.id === id).name; P.issuerDown(id, { secs: 25 }); LOG(`<span class="bad">INCIDENT</span> ${n} switch down on every PSP for 25 s <span class="dim">failover cannot help here</span>`); toast(`${n} is down for 25 s`); };
$("#attack").onclick = () => { P.cardAttack({ secs: 5 }); LOG(`<span class="bad">ATTACK</span> card testing: one stolen card token tried repeatedly for 5 s`); toast("Card-testing attack for 5 s"); };
$("#clear").onclick = () => { P.clear(); LOG(`<span class="ok">CLEAR</span> all incidents resolved`); toast("All incidents cleared"); };

// ---------- events ----------
P.on((e) => {
  if (e.kind === "payment") {
    const { p, res } = e; mrate[p.method].push(P.t);
    for (const a of res.attempts) if (!a.skipped) pstat[a.psp].ev.push({ t: P.t, ok: a.code === "captured" || !["timeout", "gateway_error", "psp_unavailable", "rate_limited"].includes(a.code), lat: a.latency });
    const kind = res.status === "captured" ? "captured" : res.status === "declined" ? "declined" : "failed"; out[kind]++;
    if (p.method === "card") lastCard = e; if (res.attempts.filter((a) => !a.skipped).length > 1 || res.code === "captured_late") lastFailover = { ...e, at: P.t }; if (p.international) lastIntl = e;
    if (!warm) spawn(p, res, kind);
  } else if (e.kind === "blocked") {
    out.blocked++; if (warm) return; routerFlash = 1; marks.push({ at: "router", t: 1, text: e.code, col: BAD });
    parts.push({ way: [["m", e.p.method], ["r"]], seg: 0, u: 0, col: BAD, end: "block" });
    if (e.code !== "VELOCITY" || Math.random() < 0.3) LOG(`<span class="bad">BLOCKED</span> ${e.code} <span class="dim">${esc(e.reason)}</span>`);
  } else if (e.kind === "breaker" && !warm) {
    const col = STATE_COL[e.to], who = e.scope === "issuer" ? e.key.replace("issuer:", "") : pname(e.key.split("|")[0]) + " " + e.key.split("|")[1];
    LOG(`<span style="color:${col}">BREAKER</span> ${esc(who)} ${e.from} → <b style="color:${col}">${e.to}</b> <span class="dim">${esc(e.why)}${e.to === "open" ? ` · cooldown ${e.cooldown}s` : ""}</span>`);
    if (e.scope === "psp") marks.push({ at: "psp", id: e.key.split("|")[0], t: 1.4, text: `${e.key.split("|")[1]} ${e.to === "half" ? "half-open" : e.to}`, col });
  } else if (e.kind === "dispute" && !warm) {
    const d = e.dispute, col = d.state === "won" ? OK : d.state === "lost" ? BAD : d.state === "accepted" ? MUTED : WARN;
    if (e.event === "open") LOG(`<span class="warn">CHARGEBACK</span> ${d.id} ${d.code} ${esc(d.label)} ${fmtMoney(d.amount)} <span class="dim">${d.liabilityShift ? "3DS liability shift" : "respond within 7 days"}</span>`);
    else LOG(`<span style="color:${col}">DISPUTE</span> ${d.id} ${e.from} → ${d.state} <span class="dim">${e.event}</span>`);
    renderDisputes();
  } else if (e.kind === "abandoned" && !warm && Math.random() < 0.5) LOG(`<span class="dim">3DS step-up abandoned by customer · ${e.p.id}</span>`);
});
function spawn(p, res, kind) {
  const way = [["m", p.method], ["r"]], tried = res.attempts.filter((a) => !a.skipped);
  tried.forEach((a, i) => { if (i) way.push(["r"]); way.push(["p", a.psp, Math.min(2.6, Math.max(0.35, a.latency / 3000)), a.code]); });
  if (!tried.length) { routerFlash = 1; marks.push({ at: "router", t: 1, text: res.code, col: WARN }); }
  way.push(["o", kind]);
  parts.push({ way, seg: 0, u: 0, col: MCOL[p.method], kind, end: kind, retries: tried.length - 1, late: res.code === "captured_late" });
  if (tried.length > 1 && kind === "captured") marks.push({ at: "psp", id: res.psp, t: 1, text: "↺ recovered", col: OK });
  if (res.code === "captured_late") marks.push({ at: "psp", id: res.psp, t: 1.2, text: "inquiry: captured", col: ACC });
}

// ---------- layout ----------
function layout(w, h) {
  const narrow = w < 560, top = 54, bot = h - 34, H = bot - top;
  const mW = narrow ? 62 : 112, mX = narrow ? 8 : 16, oW = narrow ? 58 : 104, oX = w - oW - (narrow ? 6 : 14);
  const pW = narrow ? Math.min(140, w * 0.4) : Math.min(230, w * 0.27), pX = narrow ? oX - pW - 14 : Math.max(w * 0.5, oX - pW - 70);
  const rX = narrow ? (mX + mW + pX) / 2 : mX + mW + (pX - mX - mW) * 0.45, rY = top + H / 2, rr = narrow ? 26 : 44;
  const M = Object.fromEntries(METHODS.map((m, i) => [m, { x: mX, y: top + (H * (i + 0.5)) / 4 - 19, w: mW, h: 38 }]));
  const ph = Math.min(76, H / 5 - 10), Pp = Object.fromEntries(PSPS.map((p, i) => [p.id, { x: pX, y: top + (H * (i + 0.5)) / 5 - ph / 2, w: pW, h: ph }]));
  const O = { captured: { x: oX, y: top + H * 0.2 - 30, w: oW, h: 60 }, declined: { x: oX, y: top + H * 0.55 - 26, w: oW, h: 52 }, failed: { x: oX, y: top + H * 0.82 - 26, w: oW, h: 52 } };
  return { narrow, top, bot, M, P: Pp, O, R: { x: rX, y: rY, r: rr } };
}
function point(L, ref, side) {
  if (ref[0] === "m") { const b = L.M[ref[1]]; return [b.x + b.w, b.y + b.h / 2]; }
  if (ref[0] === "r") return [L.R.x, L.R.y];
  if (ref[0] === "p") { const b = L.P[ref[1]]; return side === "out" ? [b.x + b.w, b.y + b.h / 2] : [b.x, b.y + b.h / 2]; }
  const b = L.O[ref[1]]; return [b.x, b.y + b.h / 2];
}
const rr = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
function curve(ctx, a, b) { const mx = (a[0] + b[0]) / 2; ctx.moveTo(a[0], a[1]); ctx.bezierCurveTo(mx, a[1], mx, b[1], b[0], b[1]); }
const bez = (a, b, t) => { const mx = (a[0] + b[0]) / 2, c1 = [mx, a[1]], c2 = [mx, b[1]], u = 1 - t; return [u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0], u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1]]; };

// ---------- draw ----------
let spin = 0;
function draw(dt = 0) {
  const { ctx, w, h } = fit($("#flow")), L = layout(w, h), now = P.t; ctx.clearRect(0, 0, w, h); spin += dt * 0.8; routerFlash = Math.max(0, routerFlash - dt * 1.5);
  const inc = P.net.active(now);
  // lanes
  ctx.lineWidth = 1;
  for (const m of METHODS) { ctx.strokeStyle = hexA(MCOL[m], 0.12); ctx.beginPath(); curve(ctx, point(L, ["m", m]), point(L, ["r"])); ctx.stroke(); }
  for (const p of PSPS) { ctx.strokeStyle = hexA(p.color, 0.13); ctx.beginPath(); curve(ctx, point(L, ["r"]), point(L, ["p", p.id])); ctx.stroke();
    for (const o of ["captured", "declined", "failed"]) { ctx.strokeStyle = "rgba(255,255,255,.035)"; ctx.beginPath(); curve(ctx, point(L, ["p", p.id], "out"), point(L, ["o", o])); ctx.stroke(); } }
  // methods
  for (const m of METHODS) { const b = L.M[m], r = mrate[m].filter((t) => now - t < 5).length / 5;
    ctx.fillStyle = "rgba(14,18,32,.92)"; ctx.strokeStyle = hexA(MCOL[m], 0.45); rr(ctx, b.x, b.y, b.w, b.h, 9); ctx.fill(); ctx.stroke(); ctx.fillStyle = MCOL[m]; ctx.fillRect(b.x, b.y + 8, 3, b.h - 16);
    ctx.font = `600 ${L.narrow ? 10 : 11.5}px ${mono}`; ctx.fillStyle = TEXT; ctx.fillText(L.narrow ? MSHORT[m] : MNAME[m], b.x + 10, b.y + 16); ctx.font = `10px ${mono}`; ctx.fillStyle = MUTED; ctx.fillText(L.narrow ? r.toFixed(1) + "/s" : `${r.toFixed(1)} / s`, b.x + 10, b.y + 30); }
  // router
  const { x: rx, y: ry, r: rad } = L.R, g = ctx.createRadialGradient(rx, ry, 2, rx, ry, rad * 1.6); g.addColorStop(0, hexA(routerFlash > 0 ? BAD : ACC2, 0.35 + routerFlash * 0.3)); g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(rx, ry, rad * 1.6, 0, 7); ctx.fill();
  ctx.fillStyle = "rgba(12,15,28,.96)"; ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; ctx[i ? "lineTo" : "moveTo"](rx + rad * Math.cos(a), ry + rad * Math.sin(a)); } ctx.closePath(); ctx.fill();
  ctx.lineWidth = 2; const gr = ctx.createConicGradient ? ctx.createConicGradient(spin, rx, ry) : null; if (gr) { gr.addColorStop(0, ACC); gr.addColorStop(0.5, ACC2); gr.addColorStop(1, ACC); } ctx.strokeStyle = gr || ACC; ctx.stroke(); ctx.lineWidth = 1;
  ctx.textAlign = "center"; ctx.font = `700 ${L.narrow ? 9 : 11}px ${mono}`; ctx.fillStyle = TEXT; ctx.fillText(L.narrow ? "router" : "Smart router", rx, ry + (L.narrow ? 3 : -2));
  if (!L.narrow) { ctx.font = `9.5px ${mono}`; ctx.fillStyle = MUTED; ctx.fillText("score · sample", rx, ry + 12); ctx.fillText("breakers", rx, ry + 23); }
  ctx.font = `9.5px ${mono}`; ctx.fillStyle = MUTED; ctx.fillText(L.narrow ? "gate → rank" : "compliance gate → rank", rx, ry + rad + 16); ctx.textAlign = "left";
  // PSPs
  for (const p of PSPS) {
    const b = L.P[p.id], st = pstat[p.id]; st.ev = st.ev.filter((e) => now - e.t < 10);
    const sr = st.ev.length ? st.ev.filter((e) => e.ok).length / st.ev.length : null, lats = st.ev.map((e) => e.lat).sort((a, b) => a - b), p95 = lats.length ? lats[Math.floor(lats.length * 0.95)] : null;
    const states = Object.keys(p.methods).map((m) => R.breaker.state(`${p.id}|${m}`, now)), worst = states.includes("open") ? "open" : states.includes("half") ? "half" : "closed";
    const my = inc.filter((i) => i.psp === p.id), down = my.some((i) => i.kind === "outage"), slow = my.some((i) => i.kind === "degrade");
    ctx.fillStyle = down ? "rgba(255,92,138,.09)" : "rgba(14,18,32,.94)"; ctx.strokeStyle = down ? BAD : slow ? WARN : hexA(p.color, 0.45); ctx.lineWidth = down || slow ? 1.5 : 1; rr(ctx, b.x, b.y, b.w, b.h, 10); ctx.fill(); ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = p.color; ctx.fillRect(b.x, b.y + 10, 3, b.h - 20);
    ctx.font = `700 ${L.narrow ? 10 : 12}px ${mono}`; ctx.fillStyle = TEXT; const nm = L.narrow ? p.name.split(" ")[0] : p.name; ctx.fillText(nm, b.x + 11, b.y + 18);
    // breaker pill
    const pill = worst === "half" ? "half-open" : worst, pc = STATE_COL[worst]; ctx.font = `600 ${L.narrow ? 8.5 : 9.5}px ${mono}`; const tw = ctx.measureText(pill).width + 12, px = b.x + b.w - tw - 7;
    ctx.fillStyle = hexA(pc, worst === "closed" ? 0.1 : 0.22); rr(ctx, px, b.y + 7, tw, 15, 7); ctx.fill(); ctx.strokeStyle = hexA(pc, 0.6); ctx.stroke(); ctx.fillStyle = pc; ctx.fillText(pill, px + 6, b.y + 18);
    if (b.h > 50 || !L.narrow) { ctx.font = `${L.narrow ? 9 : 10.5}px ${mono}`; ctx.fillStyle = sr == null ? MUTED : sr > 0.9 ? OK : sr > 0.7 ? WARN : BAD;
      ctx.fillText(sr == null ? "idle" : `SR ${(sr * 100).toFixed(L.narrow ? 0 : 1)}%`, b.x + 11, b.y + 36); ctx.fillStyle = MUTED; if (p95 != null) ctx.fillText(`${L.narrow ? "" : "p95 "}${(p95 / 1000).toFixed(1)}s`, b.x + (L.narrow ? 62 : 100), b.y + 36); }
    const share = (P.T.smart.win.length ? 0 : 0), sh = st.share.at(-1) ?? 0, bw = b.w - 22;
    ctx.fillStyle = "rgba(255,255,255,.06)"; ctx.fillRect(b.x + 11, b.y + b.h - 14, bw, 4); ctx.fillStyle = p.color; ctx.fillRect(b.x + 11, b.y + b.h - 14, bw * sh, 4);
    if (!L.narrow) { ctx.font = `9px ${mono}`; ctx.fillStyle = MUTED; ctx.textAlign = "right"; ctx.fillText(`${Math.round(sh * 100)}% of traffic`, b.x + b.w - 9, b.y + b.h - 19); ctx.textAlign = "left"; }
    if (down || slow) { ctx.font = `700 9px ${mono}`; ctx.fillStyle = down ? BAD : WARN; const t = down ? "OUTAGE" : "SLOW"; ctx.fillText(t, b.x + b.w - ctx.measureText(t).width - 9, b.y + b.h + 11); }
    void share;
  }
  // outcomes
  const OC = { captured: [OK, "Captured"], declined: [WARN, "Declined"], failed: [BAD, "Failed"] };
  for (const [k, [col, label]] of Object.entries(OC)) { const b = L.O[k]; ctx.fillStyle = hexA(col, 0.07); ctx.strokeStyle = hexA(col, 0.5); rr(ctx, b.x, b.y, b.w, b.h, 10); ctx.fill(); ctx.stroke();
    ctx.font = `600 ${L.narrow ? 9 : 10.5}px ${mono}`; ctx.fillStyle = col; ctx.fillText(label, b.x + (L.narrow ? 6 : 9), b.y + 17); ctx.font = `700 ${L.narrow ? 11 : 15}px ${mono}`; ctx.fillStyle = TEXT; ctx.fillText(out[k].toLocaleString("en-IN"), b.x + 9, b.y + (L.narrow ? 34 : 38));
    if (!L.narrow && k !== "captured") { ctx.font = `9px ${mono}`; ctx.fillStyle = MUTED; ctx.fillText(k === "declined" ? "by the bank" : "technical", b.x + 9, b.y + b.h - 6); }
    if (!L.narrow && k === "captured") { ctx.font = `9px ${mono}`; ctx.fillStyle = MUTED; ctx.fillText(`${out.blocked} blocked`, b.x + 9, b.y + b.h - 6); } }
  // particles
  const keep = [];
  for (const q of parts) {
    const a = q.way[q.seg], b = q.way[q.seg + 1];
    if (!b) continue;
    const atPsp = a[0] === "p" && q.dwell !== undefined && q.dwell > 0;
    let pos;
    if (atPsp) { q.dwell -= dt; const B = L.P[a[1]]; pos = [B.x + 12 + (B.w - 24) * (1 - Math.max(0, q.dwell) / a[2]), B.y + B.h / 2 + 4]; }
    else { const from = point(L, a, "out"), to = point(L, b, "in"); q.u += dt / (b[0] === "p" ? 0.32 : 0.38); pos = bez(from, to, Math.min(1, q.u));
      if (q.u >= 1) { q.u = 0; q.seg++; if (b[0] === "p") { q.dwell = b[2]; if (b[3] !== "captured" && q.seg < q.way.length - 2) q.col = WARN; } } }
    const col = q.seg >= q.way.length - 2 && q.way[q.way.length - 1][0] === "o" && (q.way[q.seg][0] === "p" && !(q.dwell > 0)) ? (q.end === "captured" ? OK : q.end === "declined" ? WARN : BAD) : q.col;
    ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 8; ctx.beginPath(); ctx.arc(pos[0], pos[1], q.retries ? 3.2 : 2.6, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    if (q.seg < q.way.length - 1) keep.push(q); else if (q.end === "block") marks.push({ at: "xy", x: pos[0], y: pos[1], t: 0.6, text: "×", col: BAD });
  }
  parts = keep.slice(-500);
  // marks
  ctx.font = `600 10px ${mono}`; marks = marks.filter((m) => (m.t -= dt * 0.7) > 0).slice(-14);
  const stack = {};
  for (const m of marks) {
    let x, y; if (m.at === "router") { x = L.R.x; y = L.R.y - L.R.r - 10; } else if (m.at === "psp") { const B = L.P[m.id]; x = B.x + B.w / 2; y = B.y - 4; } else { x = m.x; y = m.y; }
    const k = m.at + (m.id || ""), n = (stack[k] = (stack[k] || 0) + 1) - 1; y -= n * 14 + (1 - m.t) * 10;
    const tw = ctx.measureText(m.text).width + 10, bx = Math.max(4, Math.min(w - tw - 4, x - tw / 2));
    ctx.globalAlpha = Math.min(1, m.t * 2); ctx.fillStyle = "rgba(10,13,24,.88)"; rr(ctx, bx, y - 11, tw, 15, 5); ctx.fill(); ctx.fillStyle = m.col; ctx.fillText(m.text, bx + 5, y); ctx.globalAlpha = 1;
  }
  // legend
  ctx.font = `10px ${mono}`; let lx = 14; const ly = h - 12;
  for (const [t, c] of [["captured", OK], ["after a failover", WARN], ["declined by bank", WARN], ["failed / blocked", BAD]].slice(0, L.narrow ? 2 : 4)) { if (t === "declined by bank") continue; ctx.fillStyle = c; ctx.beginPath(); ctx.arc(lx + 3, ly - 3, 3, 0, 7); ctx.fill(); ctx.fillStyle = MUTED; ctx.fillText(t, lx + 10, ly); lx += ctx.measureText(t).width + 26; }
}

// ---------- panels ----------
const kp = new Kpis($("#kpis"), [
  { key: "auth", label: "Auth rate", fmt: (v) => (v * 100).toFixed(2) + "%" }, { key: "up", label: "Uplift", fmt: (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + " pp" },
  { key: "fee", label: "Fees", fmt: (v) => v.toFixed(0) + " bps" }, { key: "p95", label: "p95 latency", fmt: (v) => (v / 1000).toFixed(1) + " s" },
  { key: "rec", label: "Recovered", fmt: (v) => Math.round(v).toLocaleString("en-IN") }, { key: "dup", label: "Dup charges" },
]);
const ch1 = new Chart($("#ch1"), { series: [{ label: "smart", color: ACC }, { label: base, color: BAD }], points: 90, min: null, max: 1, fmtY: (v) => (v * 100).toFixed(0) + "%", area: true });
const ch2 = new Chart($("#ch2"), { series: PSPS.map((p) => ({ label: p.name.split(" ")[0], color: p.color })), points: 90, min: 0, max: 1, fmtY: (v) => (v * 100).toFixed(0) + "%", area: false });
const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
function sample() {
  const rep = P.report(), S = rep.strategies;
  ch1.data[0].push(S.smart.live); ch1.data[1].push(S[base].live); for (const d of ch1.data) if (d.length > ch1.points) d.shift();
  const counts = Object.fromEntries(PSPS.map((p) => [p.id, 0])); let tot = 0;
  for (const { res } of P.recent) if (P.t - res && res.status === "captured") { /* placeholder */ }
  const recent = P.recent.filter((r) => P.t - r.p.created < 6 && r.res.status === "captured"); for (const r of recent) { counts[r.res.psp]++; tot++; }
  PSPS.forEach((p, i) => { const v = tot ? counts[p.id] / tot : 0; pstat[p.id].share.push(v); if (pstat[p.id].share.length > 90) pstat[p.id].share.shift(); ch2.data[i] = pstat[p.id].share.slice(); });
  return rep;
}
function paintAll(rep = P.report()) {
  const S = rep.strategies, me = S.smart, b = S[base];
  kp.set({ auth: me.authRate, up: me.authRate - b.authRate, fee: me.feeBps, p95: me.p95, rec: me.recovered, dup: `0 vs ${S["naive-retry"].duplicates}` });
  kp.tone("auth", me.live > 0.9 ? "ok" : me.live > 0.8 ? "warn" : "bad"); kp.tone("up", me.authRate >= b.authRate ? "ok" : "warn"); kp.tone("dup", me.duplicates ? "bad" : "ok");
  ch1.draw(); ch2.draw();
  const rows = Object.entries(S).map(([s, v]) => `<tr class="${s === "smart" ? "me" : ""}"><td>${s === "smart" ? "▸ smart" : esc(s)}</td><td class="n"><span class="meter" style="width:${Math.max(2, (v.authRate - 0.6) * 150)}px;background:${s === "smart" ? ACC : s === base ? BAD : MUTED}"></span>${pct(v.authRate, 2)}</td><td class="n">${v.feeBps.toFixed(0)}</td><td class="n">${(v.p95 / 1000).toFixed(1)}s</td><td class="n">${v.recovered.toLocaleString("en-IN")}</td><td class="n" style="color:${v.duplicates ? BAD : MUTED}">${v.duplicates}</td><td class="n" style="color:${v.silentCaptures ? WARN : MUTED}">${v.silentCaptures}</td></tr>`).join("");
  $("#cmp").innerHTML = `<table><thead><tr><th>router</th><th class="n">auth rate</th><th class="n">bps</th><th class="n">p95</th><th class="n">rescued</th><th class="n">double</th><th class="n">silent</th></tr></thead><tbody>${rows}</tbody></table><div style="font:10.5px var(--mono);color:var(--muted);margin-top:8px">Every payment goes through all five routers against the same simulated network. <b style="color:var(--text)">double</b> = customer charged twice after a blind retry; <b style="color:var(--text)">silent</b> = money captured after a timeout that the merchant was never told about.</div>`;
  renderBreakers(); renderFx(); $("#clock").textContent = `${clock()} IST · ${me.payments.toLocaleString("en-IN")} payments · ${P.net.active(P.t).length} incidents`;
}
function inspect() {
  const e = lastFailover && P.t - lastFailover.at < 4 ? lastFailover : lastCard; if (!e) return; const { p, res } = e;
  $("#insw").textContent = e === lastFailover ? "latest failover" : "latest card";
  const col = res.status === "captured" ? OK : res.status === "declined" ? WARN : BAD, order = res.attempts.filter((a) => !a.skipped).map((a) => a.psp);
  const rows = res.rows.map((r) => r.excluded ? `<tr class="ex"><td>${esc(r.name)}</td><td colspan="4">excluded · ${esc(r.excluded)}</td></tr>` : `<tr class="${order[0] === r.psp ? "win" : ""}"><td style="color:${pcol(r.psp)}">${order[0] === r.psp ? "▸ " : ""}${esc(r.name.split(" ")[0])}</td><td class="n">${pct(r.sr)}</td><td class="n">${pct(r.sample)}</td><td class="n">${r.feeBps.toFixed(0)}</td><td class="n" style="color:${STATE_COL[r.state]}">${r.score.toFixed(3)}</td></tr>`).join("");
  const att = res.attempts.map((a, i) => a.skipped ? `<div><i>·</i><span style="color:${MUTED}">${esc(pname(a.psp))} skipped: ${a.skipped}</span></div>` : `<div><i>${a.n}</i><span style="color:${pcol(a.psp)}">${esc(pname(a.psp))}</span><span style="color:${a.ok ? OK : ["insufficient_funds", "do_not_honor", "expired_card", "suspected_fraud", "incorrect_pin", "debit_limit_exceeded", "user_cancelled", "insufficient_balance"].includes(a.code) ? WARN : BAD}">${a.code}</span><span class="dim" style="color:${MUTED}">${(a.latency / 1000).toFixed(2)}s${a.inquiry ? " · inquiry " + a.inquiry : ""}</span></div>`).join("");
  const c = p.compliance || {};
  $("#insp").innerHTML = `<div class="hd"><span class="k" style="background:${hexA(col, 0.15)};color:${col}">${res.status}</span><b>${p.id}</b><span style="color:${MUTED}">${fmtMoney(p.amountInr)}${p.currency !== "INR" ? ` · ${fmtMoney(p.amount, p.currency)}` : ""}</span></div>
  <div class="sub">${MNAME[p.method]}${p.network ? " · " + p.network : ""} · ${esc(ISSUERS.find((i) => i.id === p.issuer)?.name || p.issuer)}${p.threeDS ? " · 3DS" : ""}${c.domesticOnly ? " · India-only PSPs" : ""}${p.stepUp ? " · step-up" : ""}</div>
  <table><thead><tr><th>PSP</th><th class="n">est. SR</th><th class="n">sampled</th><th class="n">bps</th><th class="n">score</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="att">${att}</div><div style="color:${MUTED};margin-top:6px">${res.latency ? (res.latency / 1000).toFixed(2) + " s total" : ""}${res.fee ? " · fee " + fmtMoney(res.fee) : ""}${res.suggest ? ` · suggest ${res.suggest.toUpperCase()} to customer` : ""}</div>`;
}
function renderBreakers() {
  const now = P.t; let html = `<span></span>${METHODS.map((m) => `<span class="h">${MSHORT[m]}</span>`).join("")}`, open = 0;
  for (const p of PSPS) { html += `<span class="r" style="color:${p.color}">${esc(p.name.split(" ")[0])}</span>`;
    for (const m of METHODS) { if (!p.methods[m]) { html += `<span class="c">—</span>`; continue; } const k = `${p.id}|${m}`, st = R.breaker.state(k, now), fr = R.breaker.failureRate(k, now); if (st !== "closed") open++;
      html += `<span class="c ${st}" title="${k}: ${st}, ${Math.round(fr.rate * 100)}% of ${fr.n} failed">${st === "open" ? "OPEN" : st === "half" ? "half" : fr.n ? Math.round(fr.rate * 100) + "%" : "ok"}</span>`; } }
  const iss = R.issuerBreaker.snapshot(now).filter((s) => s.state !== "closed");
  html += `<div class="iss">${iss.length ? iss.map((s) => `<span class="st" style="color:${STATE_COL[s.state]}">${esc(s.key.replace("issuer:", ""))} ${s.state}</span>`).join("") : `<span style="color:var(--muted)">issuer breakers: all closed</span>`}</div>`;
  $("#brk").innerHTML = html; $("#brp").textContent = open ? `${open} not closed` : "all closed";
}
function renderDisputes() {
  const all = P.disputes.list(), live = all.filter((d) => !["won", "lost", "accepted"].includes(d.state)).reverse(), done = all.filter((d) => ["won", "lost", "accepted"].includes(d.state)).reverse();
  const S = P.disputes.summary(P.T.smart.ok), col = { needs_response: WARN, under_review: ACC, pre_arbitration: WARN, arbitration: ACC2, won: OK, lost: BAD, accepted: MUTED };
  const card = (d) => { const due = Math.max(0, (d.due - P.t) / DAY);
    return `<div class="d"><b>${d.id} · ${fmtMoney(d.amount)}</b><span class="st" style="color:${col[d.state]}">${d.state.replace("_", " ")}</span><span class="m">${d.code} ${esc(d.label)}${["won", "lost", "accepted"].includes(d.state) ? "" : ` · due in ${due.toFixed(1)} d`} · win ${Math.round(d.winProb * 100)}%${d.liabilityShift ? " · 3DS shift" : ""}</span>${d.state === "needs_response" ? `<div class="acts"><button class="btn sm primary" data-rep="${d.id}">Represent</button><button class="btn sm" data-acc="${d.id}">Accept</button></div>` : ""}</div>`; };
  $("#dsl").innerHTML = [...live.slice(0, 3), ...done.slice(0, Math.max(1, 4 - live.length))].map(card).join("") + `<div class="sum">ratio ${(S.ratio * 100).toFixed(3)}% of captured · won ${S.won}/${S.won + S.lost + S.accepted} · at risk ${fmtShort(S.atRisk)}</div>`;
  $("#dsp").textContent = `${S.open} open`;
}
$("#dsl").addEventListener("click", (e) => {
  const rep = e.target.dataset.rep, acc = e.target.dataset.acc;
  try { if (rep) { const d = P.disputes.items.get(rep); P.disputes.act(rep, "represent", { at: P.t, evidence: d.reason === "fraud" ? ["device", "history"] : d.reason === "duplicate" || d.reason === "credit_not_processed" ? ["refund", "distinct"] : ["delivery", "comms", "terms"] }); toast(`${rep} represented with evidence`); }
    if (acc) { P.disputes.act(acc, "accept", { at: P.t }); toast(`${acc} accepted`); } } catch (err) { toast(err.message); }
  renderDisputes();
});
function renderFx() {
  const rows = ["USD", "EUR", "GBP", "AED", "SGD"].map((c) => { const v = P.fx.rates[c], ch = (v / fx0[c] - 1) * 100; return `<tr><td>${c}/INR</td><td class="n">${v.toFixed(c === "AED" ? 3 : 2)}</td><td class="n" style="color:${ch >= 0 ? OK : BAD}">${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%</td></tr>`; }).join("");
  let note = "";
  if (lastIntl) { const p = lastIntl.p, q = P.fx.dcc(p.amountInr, "INR", p.currency); note = `<div class="note">last foreign card: ${fmtMoney(p.amount, p.currency)} → ${fmtMoney(p.amountInr)} via ${esc(pname(lastIntl.res.psp || "sagar"))}. DCC would bill ${fmtMoney(q.viaDcc, p.currency)} vs ${fmtMoney(q.viaNetwork, p.currency)} by the network.</div>`; }
  $("#fxd").innerHTML = `<table>${rows}</table>${note}`;
}

// ---------- loop ----------
let acc = 0, ui = 0;
function tick(dt) { P.step(dt); acc += dt; ui += dt; if (acc >= 1) { acc = 0; paintAll(sample()); } if (ui >= 0.8) { ui = 0; inspect(); } }
for (let i = 0; i < 180; i++) { P.step(0.25); if (i % 4 === 3) sample(); } // prewarm 45 s
warm = false; paintAll(sample()); inspect(); renderDisputes(); log.clear();
LOG(`<span class="acc">LIVE</span> 14 payments/s across UPI, cards, netbanking and wallets <span class="dim">5 PSPs · every payment also replayed through 4 baseline routers</span>`);
const loop = new Loop((dt) => { tick(dt); draw(dt); });
bindLoop(loop, $("#sim")); draw(); loop.start();
setTimeout(() => { $("#psp").value = "neorail"; $("#outage").click(); }, 200);
setTimeout(() => { $("#bank").click(); }, 16000);
setTimeout(() => { $("#attack").click(); }, 26000);
addEventListener("resize", () => { draw(); paintAll(); });
