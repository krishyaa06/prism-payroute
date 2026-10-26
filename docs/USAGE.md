# Prism PayRoute — Usage

## Install

```bash
npm install github:krishyaa06/prism-payroute
# or run the CLI directly
npx github:krishyaa06/prism-payroute --help
```

## JavaScript API

```js
import { Gateway, Router, Network, Platform } from "prism-payroute";

const gw = new Gateway({ router: new Router({ strategy: "smart", costWeight: 1, latencyWeight: 0.3 }) });

// Dry run: compliance + every PSP's score, or why it was excluded
gw.route({ method: "card", amount: "2499.00", threeDS: true, card: { pan: "4111111111111111" } });

// Real attempt with idempotency: same key + same body replays, a different body is a 409
const r = gw.pay({ method: "upi", amount: "499", vpa: "asha@oksahy" }, "order-1042");
r.status;     // "captured" | "declined" | "failed" | "blocked" | "requires_action"
r.attempts;   // [{ psp, n, code, latency, inquiry? }]

// Compare routers on identical traffic and incidents
const P = new Platform({ seed: 12 });
P.run(60); P.outage("neorail", { secs: 60 }); P.run(60);
P.report().strategies.smart.authRate;  // vs .cheapest, .static, .round-robin, .naive-retry

gw.fx.quote(12000, "USD", "INR");      // firm quote with markup and expiry
gw.disputes.act(id, "represent", { evidence: ["delivery", "comms"] });
```

| Export | What it does |
|---|---|
| `new Router({ strategy, costWeight, latencyWeight, explore, failover, breaker, inquiry, maxAttempts, budgetMs, rules })` | Routing engine; strategies `smart`, `static`, `round-robin`, `cheapest`, `naive-retry` |
| `.plan(payment, now, { domesticOnly })` | Ordered candidates plus a row per PSP with `sr`, `sample`, `fee`, `lat`, `score`, `state` or `excluded` |
| `.process(payment, network, now, opts)` | Attempts with failover and inquiry → `{ status, psp, code, attempts, latency, fee, recovered, duplicate? }` |
| `Stats` · `Breaker` · `betaSample` | Decayed Beta posteriors, rolling-window circuit breaker, Beta sampler |
| `new Network({ seed, timeoutMs, lateCapture })` · `.incident({ psp, issuer, method, kind, from, until })` | Deterministic ground-truth PSP model with outages, degradation and issuer failures |
| `new Compliance(opts).check(payment, now)` · `luhn` · `binLookup` · `maskPan` | Pre-route gate → `{ ok, code, reason, require, domesticOnly }` |
| `new FX({ markupBps, ttl }).quote / execute / dcc / convert` | FX desk |
| `new Disputes({ day, respondDays }).open / act / tick / summary` | Chargeback state machine |
| `new Gateway(opts).route / pay / dispute` | Facade with validation and idempotency |
| `new Platform({ seed, rate })` | Synthetic traffic + shadow routers used by the simulator and CLI |
| `createServer(gateway)` from `src/node/server.js` | HTTP API |

## CLI

```bash
$ npx github:krishyaa06/prism-payroute demo
$ npx github:krishyaa06/prism-payroute simulate --scenario mixed --seconds 180
$ npx github:krishyaa06/prism-payroute route --method card --issuer DECN --amount 4500
$ npx github:krishyaa06/prism-payroute fx --from USD --to INR --amount 120
$ npx github:krishyaa06/prism-payroute dispute
$ npx github:krishyaa06/prism-payroute serve --port 8790
```

| Command | Description |
|---|---|
| `payroute demo` | Calm traffic, a PSP outage, a bank outage, one decision explained, compliance, FX and disputes |
| `payroute simulate [--scenario calm\|outage\|degrade\|issuer\|mixed --seconds 180 --seed 12]` | All five routers on identical traffic |
| `payroute route [--method --amount --currency --issuer --network --pan --no-3ds]` | Explain one routing decision |
| `payroute fx [--from USD --to INR --amount 100 --markup 250]` | Quote and DCC comparison |
| `payroute dispute` | Walk the chargeback state machine |
| `payroute card <pan>` · `payroute psps` · `payroute strategies` | Luhn/BIN, catalog |
| `payroute bench [--n 100000]` | Planning and processing throughput |
| `payroute serve [--port 8790]` | HTTP API |

## Live simulator

Open [https://krishyaa06.github.io/prism-payroute/](https://krishyaa06.github.io/prism-payroute/) or serve the repo root locally (`npx serve .`). The simulator imports the same modules from `src/`.
