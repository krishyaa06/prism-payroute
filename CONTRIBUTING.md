# Contributing to prism-payroute

Thanks for taking the time to contribute! prism-payroute is a command-line tool by [Prism Protocol](https://github.com/krishyaa06) — Prism PayRoute decides which payment service provider should process each payment, and what to do when it fails. Each PSP × method × issuer has a success estimate that decays over time and borrows strength from its parent, and the router samples from it (Thompson sampling), so it keeps exploring without wasting much traffic. The score subtracts fees and latency. Circuit breakers stop sending traffic to a failing PSP and probe it before reopening. Bank-wide failures are recognised as issuer outages, so healthy PSPs are not punished and pointless retries stop. Hard declines (insufficient funds, wrong PIN) are never retried. Timeouts are ambiguous, so the router asks the PSP whether the money was captured before trying elsewhere, which is how it avoids double charges. A pre-route compliance gate covers sanctions, Luhn and BIN checks, card-on-file tokenisation, 3DS/AFA, e-mandate and UPI limits, data localisation and velocity. There is also an FX desk with expiring quotes and DCC comparison, plus a chargeback lifecycle with deadlines, evidence scoring and 3DS liability shift.

## Getting started

```bash
git clone https://github.com/krishyaa06/prism-payroute.git
cd prism-payroute
npm start
```

## Before you open a pull request

Make sure everything passes locally:

```bash
npm test
```

## Guidelines

- **Zero dependencies.** Please don't add runtime dependencies — use Node.js built-ins (`node:fs`, `node:path`, `node:test`, …).
- **No build step, no frameworks.** Keep it plain HTML, CSS and JavaScript so it runs straight from GitHub Pages.
- **Everything stays in the browser.** Don't send user data to any server.
- Keep pull requests small and focused — one feature or fix per PR.
- Update the README when you change behaviour, flags or options.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add --json output
fix: handle empty input
docs: clarify install steps
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`. Add a short entry under **[Unreleased]** in [CHANGELOG.md](CHANGELOG.md) for user-facing changes.

## Reporting bugs & ideas

Open an [issue](https://github.com/krishyaa06/prism-payroute/issues) with:

- what you expected vs. what happened
- steps to reproduce
- your OS, browser or Node.js version

**Security issues:** please don't open a public issue — contact the maintainer privately via [GitHub](https://github.com/krishyaa06).

## License

By contributing, you agree that your contributions will be licensed under the project's [license](LICENSE).
