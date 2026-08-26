# MicroViber — Functional Spec

> Every capability described here matches the **v3 takeover-via-resume** write model
> (revised 2026-08-24). See `docs/architecture-spec.md` for the technical contract behind
> it and its "Superseded approaches" note.

---

## 1. Problem & thesis

The developer works in the Claude Code VS Code extension, typically with several VS Code
windows (one per folder) and several session tabs per window. Long-running commands are
started, then the laptop is left behind. The dead time is the problem: from a phone there
is currently no way to see whether a session finished its task, or to hand it the next
prompt.

**MicroViber** is a phone-sized PWA for those micro-moments. Open it, glance at a
session, see whether the last task landed, type the next prompt, put the phone away.

The load-bearing requirement, in the user's own words:

> "I DO NOT WANT to have to resume the session every time I open the app… if I run a
> command from my phone and later come back to my laptop, I DO NOT WANT the laptop
> session to be 'behind' the phone session… think of it as a WhatsApp conversation you
> start on WhatsApp Web, continue from the phone and go back to the web. Both chats are
> mirrored in realtime."

The ideal implementation — one live process that phone and laptop both write into,
WhatsApp-Web style — proved impossible: the mechanism that would enable it (the peer
messaging socket) accepts writes only from other registered Claude sessions, so a
standalone daemon's prompt is silently dropped. There is no un-wrapped external write
path into an already-running session.

What *is* possible, and what MicroViber does instead, is a **baton pass over one shared
history file**: reading is always on (the phone tails the laptop's transcript file
live); writing is a deliberate takeover of an idle session via `claude --resume`, which
appends to that *same* file rather than forking it. The history file is the single
source of truth; phone and laptop take turns appending to it.

### Non-goals

- Not a Claude Code replacement or a general mobile IDE. No file tree, no diff review, no
  git UI.
- Not multi-user or multi-machine. One developer, one laptop.
- Not a hosted service. The daemon runs on the laptop and is reachable only over a
  private tunnel.
- Not a session *creator* for existing-session takeover in the MVP sense of attaching to
  arbitrary running work — MicroViber's takeover targets sessions already running on the
  laptop that have gone idle.

### Design principle: host-agnostic

MicroViber works with **any** Claude Code session, not only VS Code ones. Discovery,
mirroring, and takeover all go through mechanisms common to every session — none of them
is VS Code-specific. No VS Code extension is written and no VS Code API is called.
Terminal-hosted sessions get the full feature set: mirror, takeover, and idle
notification.

---

## 2. Modes — mirror & takeover

Every session is in exactly one of two phone-facing modes:

### Mirror (read-only, always available)

The phone tails the session's transcript file. This spawns no process on the laptop and
cannot conflict with anything — it works for a session that is currently working, idle,
or even stale (its process has exited; the history is still readable).

### Takeover (write, deliberate and gated)

A one-tap **Take over** action, enabled **only when the session is idle**. Tapping it
causes the laptop's daemon to run `claude --resume <id>`, spawning its own process on
that same session id. From that point, the phone's composer sends genuine user turns —
indistinguishable from turns typed directly into Claude Code — into that process's
stdin, and they append to the session's shared history file.

**Why takeover is gated on idle.** Two reasons: it enforces "one writer at a time" (the
phone never begins writing under a laptop that is mid-task), and it avoids a false-idle
race — idle detection is a heuristic, so the control only arms off the strongest
available signal and still requires an explicit tap, so a momentary lull mid-tool-call
cannot silently enable a write.

**Handback.** MicroViber does not automatically return control to the laptop. "Handback"
means: the phone stops driving (releasing ownership, which tears down the daemon-owned
process), and the laptop user runs `/resume <session-id>` in their own Claude Code tab.
That reloads the full history — including everything typed from the phone — into a fresh
view. The tab that was open on the laptop before takeover is now stale and is abandoned;
MicroViber takes no action on it and does not warn if someone keeps typing into it
(conflict rule: do nothing — this is a deliberate, stated trade-off, not an oversight).

**Changed (2026-08-26, [microviber-2](https://github.com/yarivsnapir/MicroViber/issues/1)):**
handback is now a first-class daemon action, not only a convention: releasing ownership
tears down the daemon-owned process via `POST /api/sessions/:id/handback` (idempotent),
and the session immediately shows as read-only again in the session list. Sending a
prompt to a session that has **not** been taken over is now rejected explicitly with
HTTP 403 `FORBIDDEN` (previously it reported a failed prompt state) — and every rejected
attempt is still recorded in the local audit log. The earlier "fresh-start a
phone-owned session" capability was removed; the only write path is takeover.

**One risk carried forward, deliberately.** Because takeover creates a second real
writer, if the user ignores the idle gate's intent and types in the stale laptop tab
anyway, both processes append from divergent points in the shared file. The file itself
still serializes correctly at the append level — nothing is corrupted — but the
*conversation* becomes incoherent. This is accepted as a consequence of user behavior the
product does not police.

---

## 3. UX flows

Minimalism is a hard requirement: as few buttons and controls as possible. The UI has
three persistent controls — session picker, composer, and a pane switch reserved for a
future browser panel — plus one contextual control, **Take over**, which is the
composer's own state rather than a separate widget.

### Session list

A sheet (not a tab strip — seven-plus live sessions do not fit a phone's width). Rows
show the session's real title (its `ai-title`, or a truncated last prompt as fallback),
then folder, relative time, and state. Non-writable (stale, or on an unrecognised Claude
Code build) sessions are visibly read-only.

**Sort order:** descending by the timestamp of the session's most recent **user** turn —
"the one I last talked to" — not by last assistant output, which can churn for a long
time after the last prompt and would sort the wrong session to the top.

### Transcript view

Matches the Claude Code VS Code extension's own rendering, deliberately: the user reads
the same conversation on both surfaces, so a different visual language on the phone would
make the two feel like different conversations.

- Flowing document, not a chat — no opposing-side bubbles. Blocks stack in one column
  with a small left-gutter marker, mirroring how the extension renders assistant turns,
  thinking, and tool activity.
- User prompts render as bordered, full-width, visually quiet blocks — the extension's
  input-echo treatment.
- Full markdown rendering (bold, lists, inline code, links), from sanitized markdown,
  never raw HTML.
- Tool calls collapse to one line each, expandable on tap.
- Thinking renders as a marker, not a wall of text.
- Phone-injected prompts stay visually distinct from laptop-typed ones — the one
  deliberate departure from matching the extension's look, so the user always knows which
  turns they sent from where.

### Composer gating on idle

Before takeover, the composer's real estate is **not** an empty text box — it is a single
full-width status/action bar whose state mirrors the session's derived state:

| Session state | Bar shows | Action available |
|---|---|---|
| **working** | "laptop is working…" (disabled, grey) | None — takeover is refused while working. |
| **idle** | An enabled **"Take over"** button | Tapping it calls the takeover action; on success the bar becomes the live composer. |
| **stale** | "this session has ended" (disabled) | None — resuming a dead session is out of scope for phone-initiated takeover in this spec. |

**Changed (2026-08-26, [microviber-3](https://github.com/yarivsnapir/MicroViber/issues/2)):**
once taken over, the composer carries a **Hand back** control alongside the send action.
Tapping it releases ownership (tears down the daemon-owned process) and returns the
session to read-only in the picker. Handback is **not** automatic — collapsing, closing,
or navigating away from the app does not release ownership; only the explicit Hand-back
tap does, matching the "one writer at a time, by discipline" principle above. This is the
only way, besides the laptop resuming the session, that a taken-over session returns to
read-only.

Once taken over, the composer is a textarea resting at ~7 lines, growing to ~10 before it
scrolls internally — deliberately not a single-line chat input, because prompts to a
coding agent are paragraphs, not chat messages. Sending shows the prompt as `accepted`
once the transcript tailer actually observes it appear (never merely because the network
write succeeded); a prompt sent to a session that immediately goes back to work shows as
`queued`, greyed, with a "waiting for the session to finish" note; `expired` (10 minutes
unobserved) and `failed` both keep the typed text in the composer with a Resend
affordance, so nothing typed is ever silently lost. A **"hand back"** affordance appears
only while a session is taken over, releasing it to read-only mirror.

---

## 4. Permissions & notifications

**No permission-approval UI.** Takeover resumes the session as a daemon-owned process,
and MicroViber runs that process with `--dangerously-skip-permissions` — the same
permission mode the user already runs their own Claude Code sessions under. This grants
no privilege the user did not already grant themselves on their own laptop; the actual
exposure is the *reachability* of that privilege from a phone, which is why the whole
transport is private-tunnel-only and the daemon is off by default (see
`docs/architecture-spec.md` §5). Read-only mirroring spawns and executes nothing, so it
needs no permission story at all.

**Idle push notification.** "Session X is waiting for you" — doubles as the "you can now
take over" signal. Uses a host-agnostic idle heuristic as the trigger (no transcript
growth for a short window, with the process still alive), so it works for both
VS Code-hosted and terminal-hosted sessions; a faster VS Code-specific idle event is used
as an accelerant where available, never as the sole signal. The notification carries a
short status line about what the session was doing, and deep-links straight to that
session.

**Notification cancellation is required, not optional.** A notification that has been
overtaken by events must disappear on its own — the case: a session goes idle, the phone
is notified, but the user is actually sitting at the laptop and continues there. Each
notification is tagged per-session so a later one replaces rather than stacks; when the
session leaves idle (work resumes, or the process exits) the daemon actively dismisses
its notification. Because mobile push delivery of silent/dismiss messages is unreliable
on some platforms, every notification also carries a TTL and is cleared the moment the
session is opened in the app — belt-and-braces, not redundant.

---

## 5. Install & distribution summary

MicroViber is a **personal, single-user tool** — one laptop (daemon + live Claude Code
sessions) and one phone (installed PWA), not a hosted product. That narrower scope is
what the security model depends on (`docs/architecture-spec.md` §5).

Two requirements fix the transport choice:

1. **A stable HTTPS origin.** A PWA's identity, cache, service worker, and stored pairing
   token are all keyed to its origin. A LAN IP changes between networks and, served over
   plain HTTP, is not a secure context — no service worker registers, so no install and no
   push notifications. The install path needs a stable hostname on real HTTPS.
2. **Never publicly reachable.** Takeover can execute arbitrary commands on the laptop
   under the user's own permission mode. A publicly reachable endpoint is unacceptable
   regardless of how strong the application-layer auth is.

**Tailscale** is the recommended way to satisfy both: it gives the laptop a permanent
private hostname that follows it across networks, a real certificate via `tailscale
cert`, and tailnet-only reachability — no port-forwarding, no public tunnel service. A
same-network fallback (binding the tunnel's local IP directly, over plain HTTP) works
for a quick look in a browser but cannot install as a PWA or receive push notifications,
because it isn't a secure context.

The full step-by-step install runbook — preconditions, build, Tailscale setup, `.env`,
starting the daemon, exposing it over `tailscale serve`, pairing/installing the PWA, and
stopping/rotating the token — lives in **`INSTALL.md`** at the repo root and is written to
be executed by an installing Claude session, with a `verify` command at every step. This
document states the *why*; `INSTALL.md` states the *how*.
