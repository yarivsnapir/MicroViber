# MicroViber

Phone PWA that mirrors and drives Claude Code sessions running on a laptop.
Two components: `daemon/` (Node 22 + TypeScript + Fastify) and `pwa/`
(Vite + React 19 + Tailwind 4). `bin/microviberd` is the start|stop|status
runner — the daemon is OFF BY DEFAULT and must be started deliberately.

## Context docs (read before designing or reviewing changes)
- `docs/architecture-spec.md` — architecture, Claude Code integration
  contract, threat model T1–T12, engineering standards.
- `docs/functional-spec.md` — product behavior and UX flows.
- `docs/features/{feature}/` — per-feature spec/plan/story files (the
  Syncounter-workspace SDLC skills read/write here for this project;
  MicroViber is a public standalone repo, so its planning docs live here,
  not in the private Harness workspace repo).

## Commands (run from repo root)
- `npm run typecheck && npm run lint && npm test` — full quality gate; all
  three must pass before any commit.
- `npm run build` — build all workspaces.

## Installing / configuring
Follow `INSTALL.md` literally — every step has a **Verify** command with its
expected output. Do not improvise network or security settings.

## Security rules (non-negotiable)
- The daemon can drive Claude Code sessions that execute commands on this
  machine. Never weaken: bearer auth, Host allowlist, Origin checks, the
  bind-address whitelist (loopback / RFC-1918 / 100.64/10 only, never
  0.0.0.0), or off-by-default startup.
- All Claude Code internals live in `daemon/src/lib/claude-adapter/` behind a
  peerProtocol version gate. Code outside that directory must not read
  `~/.claude/` or spawn `claude`.
- Never commit `.env` or `~/.microviber/token`.
