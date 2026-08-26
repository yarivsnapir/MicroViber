# Installing MicroViber

This runbook is written to be executed by a person **or by a Claude Code
session** ("install MicroViber by following INSTALL.md"). Rules for agents:
execute stages in order; after every step run its **Verify** command and
compare against the expected output; if a Verify fails, stop and report the
step number and actual output — do not improvise, especially around network
and security settings.

MicroViber is a **personal, single-user tool**: one laptop (runs the daemon +
your live Claude Code sessions) and one phone (runs the installed PWA). It is
never exposed to the public internet. The transport is **Tailscale**, which
is not optional for the full experience — see "Why Tailscale" at the bottom.

Runs on **macOS and Linux only**.

---

## Stage 0 — Prerequisites

### Step 0.1 — Node.js 22+

```bash
node --version
```

**Verify:** prints `v22.x` or higher.

### Step 0.2 — Claude Code CLI

```bash
claude --version
```

**Verify:** prints a version string. Record it — the daemon's version gate
degrades to read-only against untested `claude` versions (spec §3.2, R1). If
`claude` is not found on PATH, `MV_CLAUDE_BIN` must later point at its
absolute path (Stage 3).

### Step 0.3 — git

```bash
git --version
```

**Verify:** prints a version string.

---

## Stage 1 — Clone & build

### Step 1.1 — Clone, install, build

This is an npm workspace — `npm ci`/`npm run build` must run from the
**workspace root**, not from inside `daemon/`/`pwa/`. Running it inside a
workspace member does not reliably hoist that member's own dependencies
(confirmed: `daemon/`'s `fastify`/`zod` were silently absent from
`node_modules` afterward, and the daemon failed at startup with
`ERR_MODULE_NOT_FOUND`). The command below already runs from the cloned
root, so this is satisfied by construction.

```bash
git clone https://github.com/yarivsnapir/MicroViber.git && cd MicroViber && npm ci && npm run build
```

**Verify:**

```bash
test -f pwa/dist/index.html && test -f daemon/dist/index.js && echo OK
```

Expected: `OK`. The daemon serves `pwa/dist` as the app shell same-origin, so
the PWA build must exist before the daemon starts.

All commands from here on assume your working directory is this cloned
`MicroViber/` root.

### Step 1.2 — Quality gate

```bash
npm run typecheck && npm run lint && npm test
```

**Verify:** all three commands exit 0 (no type errors, no lint errors, all
tests pass).

---

## Stage 2 — Tailscale (stable HTTPS name for the laptop)

The phone needs a **stable HTTPS origin** to install the PWA and receive
push. A LAN IP fails on both counts (it changes between networks, and plain
HTTP is not a secure context, so the browser refuses to install a service
worker). Tailscale gives a permanent name + a real TLS cert.

**Already have Tailscale set up and logged in?** Skip to Step 2.3 — it
captures `TS_NAME` (required by every later stage) and, for this skip path,
also checks the MagicDNS/HTTPS-certificates precondition that Step 2.2
would otherwise have covered.

### Step 2.1 — Install Tailscale

```bash
# macOS
brew install tailscale 2>/dev/null || echo "install Tailscale from https://tailscale.com/download"
```

**Linux:** no brew-based path is verified for this repo — use the official
installer at https://tailscale.com/download (the same URL the macOS fallback
above points to).

**Verify:**

```bash
tailscale version
```

Expected: prints a version string.

### Step 2.2 — Log in

```bash
sudo tailscale up
```

**Verify:**

```bash
tailscale status
```

Expected: shows your account as logged in (not "Logged out" / "NeedsLogin").

Then enable **MagicDNS** and **HTTPS Certificates** in the tailnet admin
console (https://login.tailscale.com/admin/dns) — both are required for
`tailscale cert`/`serve` to issue a certificate. These are account settings,
not CLI flags; a human must toggle them if they are off.

### Step 2.3 — Get the laptop's stable name

```bash
tailscale status --json | python3 -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
```

Call the result `TS_NAME` (e.g. `my-laptop.tailXXXX.ts.net`). You will
substitute it into every `TS_NAME` placeholder below.

**Verify:** the printed value ends in `.ts.net`, and:

```bash
tailscale ip -4
```

returns a `100.x.y.z` address.

**If you skipped Steps 2.1–2.2** (Tailscale was already installed and
logged in), MagicDNS and HTTPS Certificates may not yet be enabled for this
tailnet — both are required for `tailscale serve` to issue a certificate in
Stage 4. Check now (substitute your real `TS_NAME`):

```bash
tailscale cert TS_NAME
```

**Verify:** it writes/confirms a certificate for `TS_NAME` with no error. If
it instead prints something like `HTTPS is not enabled for your tailnet`,
enable **MagicDNS** and **HTTPS Certificates** in the tailnet admin console
(https://login.tailscale.com/admin/dns) — both are account settings, not CLI
flags — then re-run this command.

### Step 2.4 — Join the phone to the same tailnet

Install the Tailscale app on the phone and log into the **same account**.
The phone will reach the laptop over cellular too — not just shared WiFi.

**Verify:**

```bash
tailscale status
```

Expected: the phone's device name appears in the peer list.

---

## Stage 3 — Configure the daemon (`.env`)

Recommended shape: **daemon binds loopback, `tailscale serve` fronts
HTTPS.** This is the only shape that yields PWA install + push. Do **not**
set `MV_BIND_ADDRESS` to `0.0.0.0` or a public IP — the daemon refuses to
start (it whitelists loopback, RFC-1918, and the `100.64/10` Tailscale range
only). The same-WiFi-only fallback (bind the `100.x` tailnet IP, open over
`http://`) works in a browser but **cannot install as a PWA and cannot
push** — use it only for a quick look, never as the install path.

### Step 3.1 — Copy the template

```bash
cp .env.example .env
```

**Verify:**

```bash
test -f .env && echo OK
```

Expected: `OK`.

### Step 3.2 — Generate VAPID keys for Web Push

```bash
cd daemon && npx web-push generate-vapid-keys && cd ..
```

**Verify:** prints a `Public Key` and a `Private Key` line.

### Step 3.3 — Fill in `.env`

Each variable is its own decision:

| Variable | Value | Why |
|---|---|---|
| `MV_BIND_ADDRESS` | `127.0.0.1` | loopback; `tailscale serve` fronts it with HTTPS (Stage 4). Never `0.0.0.0` or a public IP. |
| `MV_PORT` | `8730` | default port the rest of this runbook assumes. |
| `MV_BEARER_TOKEN` | leave empty | auto-generated and persisted to `~/.microviber/token` on first run. |
| `MV_ALLOWED_HOSTS` | `TS_NAME` | the `.ts.net` name **only** — no scheme, no port. `tailscale serve` forwards the original Host header; the daemon rejects any Host not on this list with 421 (DNS-rebinding guard, T3). |
| `MV_ALLOWED_ORIGINS` | `https://TS_NAME` | the PWA is served same-origin from there. |
| `MV_VAPID_PUBLIC_KEY` / `MV_VAPID_PRIVATE_KEY` | from Step 3.2 | Web Push credentials. |
| `MV_CLAUDE_BIN` | `claude` (default) | only change if Step 0.2 needed an absolute path. |

Write `.env` (substitute your real `TS_NAME` from Step 2.3, and the keys
from Step 3.2):

```env
MV_BIND_ADDRESS=127.0.0.1
MV_PORT=8730
MV_BEARER_TOKEN=
MV_ALLOWED_HOSTS=TS_NAME
MV_ALLOWED_ORIGINS=https://TS_NAME
MV_VAPID_PUBLIC_KEY=<public key from Step 3.2>
MV_VAPID_PRIVATE_KEY=<private key from Step 3.2>
MV_CLAUDE_BIN=claude
```

**Verify:**

```bash
grep -q '^MV_BIND_ADDRESS=127' .env && grep -q '^MV_ALLOWED_HOSTS=..*' .env && grep -q '^MV_ALLOWED_ORIGINS=..*' .env && echo OK || echo MISSING
```

Expected: `OK` (bind address is loopback, hosts/origins are filled in, not
left blank).

---

## Stage 4 — HTTPS + start

### Step 4.1 — Start the daemon

The daemon is **off by default** and must be started deliberately — it is
not a launch agent and must not run at boot (spec §9.4).

```bash
./bin/microviberd start
```

**Verify:** prints `● MicroViber LISTENING (pid ...)` and, among the
grepped log lines, both `MicroViber daemon listening on 127.0.0.1:8730` and
`Pair (open on your phone): https://TS_NAME/#token=...`. Then:

```bash
./bin/microviberd status
```

Expected: `● LISTENING (pid ...)`.

### Step 4.2 — Loopback health check (before Tailscale fronting)

```bash
curl -sS -H "Host: TS_NAME" http://127.0.0.1:8730/api/health
```

**Verify:** a 200/JSON response, not 421.

### Step 4.3 — Put HTTPS in front with `tailscale serve`

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8730
tailscale serve status
```

(If this Tailscale version rejects the flags, use its equivalent — e.g.
`tailscale serve https / http://127.0.0.1:8730`.)

**Verify:** `tailscale serve status` shows `443 → 127.0.0.1:8730`.

### Step 4.4 — HTTPS health check on the stable name

```bash
curl -sS https://TS_NAME/api/health
```

**Verify:** 200 over TLS, valid cert.

---

## Stage 5 — Pair + install on the phone

**Manual, phone-in-hand step.**

There is no QR code generation in the daemon (checked: no `qrcode`
dependency, no QR rendering in `index.ts`) — get the printed pairing URL
(Step 4.1) onto the phone by any channel you already trust for short-lived
secrets (e.g. Notes-to-self, Signal/iMessage to yourself, AirDrop a text
snippet). Do not email or Slack it to a channel others can read — the token
in the URL fragment grants full access until rotated (Stage 6).

1. On the phone (on the tailnet, via the Tailscale app), open the exact
   pairing URL the daemon printed at startup — `https://TS_NAME/#token=...`,
   no manual rewriting needed.
2. Confirm the app loads the session list over the tailnet.
3. Install: browser menu → **Add to Home Screen** / **Install app**. This
   only appears because the origin is HTTPS (Stage 4).
4. Grant notifications when prompted (needed for the idle push).

**Verify:** the installed icon launches full-screen, the session list
renders, and toggling a laptop session between working/idle updates the
phone within a couple of seconds.

---

## Stage 6 — Uninstall / stop

### Step 6.1 — Stop remote access

```bash
./bin/microviberd stop
sudo tailscale serve --https=443 off
```

**Verify:**

```bash
./bin/microviberd status
```

Expected: `○ not running (off by default)`. The exposure window closes
immediately once both commands complete.

### Step 6.2 — Revoke all paired clients (rotate the token)

```bash
rm ~/.microviber/token
./bin/microviberd restart
```

**Verify:** the restart log prints a new `Pair (open on your phone): ...`
URL with a different token than before; every previously-paired phone must
re-pair with the new URL.

### Step 6.3 — Full uninstall

```bash
./bin/microviberd stop
rm -rf ~/.microviber/
```

**Verify:**

```bash
./bin/microviberd status; test -d ~/.microviber && echo STILL_PRESENT || echo REMOVED
```

Expected: `○ not running (off by default)` followed by `REMOVED`.

---

## Why Tailscale (don't substitute a public tunnel)

Two hard requirements collide: the PWA needs a **stable HTTPS origin**, and
the daemon **must never be publicly reachable** (it can inject prompts into
a `bypassPermissions` Claude session = arbitrary code execution on the
laptop). Tailscale satisfies both — private WireGuard network + real cert on
a permanent name. **ngrok / Cloudflare Tunnel / port-forwarding are
explicitly rejected** (spec §9.1): a public HTTPS endpoint that runs
commands on a laptop is a standing target, with zero convenience gain over
Tailscale.
