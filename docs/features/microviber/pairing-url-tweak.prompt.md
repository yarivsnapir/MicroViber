# Copiable prompt — Task 27a (HTTPS pairing URL)

Small, contained daemon tweak so MicroViber pairs correctly when served behind
`tailscale serve`. TDD. See spec §15.4 and plan Task 27.

---

In microviber/daemon, make the startup pairing URL work behind an HTTPS reverse proxy (tailscale serve), not just local http. Do this TDD — failing test first.

Context:
- `src/index.ts` currently prints `buildPairingUrl(config.bindAddress, config.port, config.bearerToken, 'http')` — the local http URL. When the daemon runs behind `tailscale serve` (daemon binds 127.0.0.1, Tailscale terminates HTTPS on the `*.ts.net` name), the phone must open the PUBLIC origin `https://<ts.net name>/` instead.
- `src/server/pairing.ts` `buildPairingUrl(host, port, token, scheme)` already supports an `https` scheme, and keeps the token in the URL fragment (must stay in the fragment — spec T8).
- Public host config already exists: `config.allowedHosts` (from `MV_ALLOWED_HOSTS`). `config.allowedOrigins` is also available.

Required behavior:
1. `buildPairingUrl` omits the port when it is the scheme default (443 for https, 80 for http) — e.g. `https://my-laptop.tailXXXX.ts.net/#token=…` with no `:443`. Keep the port for non-default values.
2. The daemon prints the PUBLIC pairing URL when a public host is configured: if `config.allowedHosts[0]` is set, print `https://<allowedHosts[0]>/#token=…`; otherwise fall back to the current local `http://<bindAddress>:<port>/#token=…`. (If you prefer an explicit `MV_PUBLIC_URL` env var instead of deriving from allowedHosts[0], that's fine — zod-parse it in config.ts and document it; deriving from allowedHosts[0] is the lighter option.)
3. Do not log the bearer token as a separate field; it only ever appears inside the printed pairing URL fragment (§16.4).

Tests (unit, no network):
- `buildPairingUrl` drops `:443` for https-default and `:80` for http-default; retains custom ports; token stays URL-encoded in the `#token=` fragment.
- The index/startup URL-selection helper: given a config with `allowedHosts=['x.ts.net']` returns the `https://x.ts.net/#token=…` form; given empty `allowedHosts` returns the local `http://127.0.0.1:8730/#token=…` form. Extract the selection into a small pure function so it is testable without booting Fastify.

Acceptance:
- `npm run typecheck` and `npm test` green; new tests cover both the port-omission and the https-vs-http selection.
- No `any` without a `// reason:` comment; strict TS.
