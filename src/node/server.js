// HTTP API over a Gateway. JSON in, JSON out. Idempotency-Key is honoured on POST /v1/payments.
import http from "node:http";
import { Gateway } from "../gateway.js";
import { PSPS } from "../psp.js";

export function createServer(gw = new Gateway(), { maxBody = 1 << 16 } = {}) {
  const send = (res, code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const read = (req) => new Promise((ok, no) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > maxBody) { no(Object.assign(new Error("body too large"), { status: 413, code: "TOO_LARGE" })); req.destroy(); } }); req.on("end", () => ok(b)); req.on("error", no); });
  const json = async (req) => { const b = await read(req); if (!b) return {}; try { return JSON.parse(b); } catch { throw Object.assign(new Error("invalid JSON"), { status: 400, code: "BAD_REQUEST" }); } };
  return http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://x"), p = u.pathname.split("/").filter(Boolean), m = req.method, now = gw.clock();
      if (u.pathname === "/healthz") return send(res, 200, { ok: true, payments: gw.payments.size });
      if (p[0] !== "v1") return send(res, 404, { error: "NOT_FOUND" });
      if (p[1] === "psps" && m === "GET") return send(res, 200, PSPS.map((x) => ({ id: x.id, name: x.name, local: x.local, currencies: x.currencies, networks: x.networks, methods: Object.keys(x.methods) })));
      if (p[1] === "health" && m === "GET") return send(res, 200, { breakers: gw.router.breaker.snapshot(now), issuers: gw.router.issuerBreaker.snapshot(now), incidents: gw.network.active(now) });
      if (p[1] === "route" && m === "POST") return send(res, 200, gw.route(await json(req)));
      if (p[1] === "payments" && m === "POST") { const r = gw.pay(await json(req), req.headers["idempotency-key"]); const code = r.replay ? 200 : r.status === "captured" ? 201 : r.status === "requires_action" ? 202 : r.status === "blocked" ? 403 : 402; return send(res, code, r, r.replay ? { "idempotent-replayed": "true" } : {}); }
      if (p[1] === "payments" && m === "GET" && p[2]) { const x = gw.payments.get(p[2]); return x ? send(res, 200, x) : send(res, 404, { error: "NOT_FOUND" }); }
      if (p[1] === "incidents" && m === "POST") { const b = await json(req); return send(res, 201, gw.network.incident({ ...b, from: now, until: now + (b.secs || 60) })); }
      if (p[1] === "fx" && p[2] === "quote" && m === "POST") { const b = await json(req); return send(res, 201, gw.fx.quote(b.amount, b.from, b.to, b)); }
      if (p[1] === "fx" && p[2] === "execute" && m === "POST") { const b = await json(req); return send(res, 200, gw.fx.execute(b.id)); }
      if (p[1] === "fx" && p[2] === "dcc" && m === "POST") { const b = await json(req); return send(res, 200, gw.fx.dcc(b.amount, b.merchantCurrency || "INR", b.cardCurrency, b)); }
      if (p[1] === "disputes") {
        if (m === "GET" && !p[2]) return send(res, 200, { items: gw.disputes.list(), summary: gw.disputes.summary(gw.payments.size) });
        if (m === "POST" && !p[2]) { const b = await json(req); return send(res, 201, gw.dispute(b.payment, b)); }
        if (m === "POST" && p[3]) { const b = await json(req); return send(res, 200, gw.disputes.act(p[2], p[3], { at: now, evidence: b.evidence || [] })); }
      }
      return send(res, 404, { error: "NOT_FOUND" });
    } catch (e) { send(res, e.status || 500, { error: e.code || "INTERNAL", message: e.message }); }
  });
}
