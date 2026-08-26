# MicroViber

Phone PWA that mirrors Claude Code sessions on your laptop and lets you drive them from your phone — see a session's live transcript, send the next instruction, and get notified when it goes idle. The laptop is never behind the phone.

![CI](https://github.com/yarivsnapir/MicroViber/actions/workflows/ci.yml/badge.svg)

> **⚠️ Security disclaimer.** MicroViber's daemon can start and drive Claude Code sessions — which can execute commands on the machine it runs on. Only expose it over a private tunnel (Tailscale) to devices you own, keep the bearer token secret, and read the [threat model](docs/architecture-spec.md) before changing any network setting. The daemon is **off by default**, binds only to an explicitly configured private address, and refuses `0.0.0.0`. Provided as-is, without warranty, under the [MIT license](LICENSE).

## How it works

- **Reading is always on.** Mirror any active or idle session's transcript tail in real time.
- **Writing is a deliberate takeover.** Use `claude --resume <session-id>` to take over an idle session from the phone; you type prompts into that session's stdin, they append to the shared history file.
- **Back on the laptop, use `/resume <session-id>`.** Reload the full history including the phone's prompts into a fresh in-memory view. One history file, two writers taking turns.

## Install

Follow [INSTALL.md](INSTALL.md) — it is written so you can paste it to a Claude Code session and let it drive.

## Docs

- [Architecture spec](docs/architecture-spec.md) — system design, Claude Code integration contract, threat model (T1–T12), engineering standards.
- [Functional spec](docs/functional-spec.md) — product behavior and UX flows.

## Development

| Component | Stack | Purpose |
|---|---|---|
| `daemon/` | Node 22 + TypeScript + Fastify | Discover & tail Claude Code sessions; orchestrate resume takeovers |
| `pwa/` | Vite + React 19 + Tailwind 4 | Phone UI; paired PWA |
| `bin/microviberd` | Bash + Node | off-by-default start/stop/status runner |

```bash
npm run typecheck && npm run lint && npm test
```

All three must pass before any commit. Build everything with `npm run build`.

## Status

Pre-release. Daemon + PWA build and test green; takeover write path in active development (stories 2–4). Not yet verified on a physical phone.
