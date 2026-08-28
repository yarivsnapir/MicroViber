# MicroViber — Phase 0 Investigation Plan

> **Self-contained.** Written to be executed in a **fresh session with no prior context**. Everything needed is below; you do not need to read the whole spec first.
> Companions: [spec.md](spec.md) (design), [plan.md](plan.md) (Phase 0 = Tasks 1–5, expanded here).
> Branch: `feature/microviber`. Record findings in `docs/features/microviber/findings.md`.

---

## 0. Which skill to use

**Use `superpowers:executing-plans`.** This is a written plan with discrete, ordered tasks and natural checkpoints, which is exactly what that skill is for. Apply `superpowers:systematic-debugging` discipline *within* Investigation 1 — reverse-engineering an undocumented protocol is hypothesis-and-test work, and guessing is the main failure mode.

**Do not use:** `brainstorming` (design is done and approved), `writing-plans` (this *is* the plan), any `syncounter-*` skill (those are Syncounter-platform SDLC skills; MicroViber is a separate project with no code yet), or `/loop` (these tasks need judgement, and two of them stop for a human decision).

No code is written in Phase 0. The deliverable is **five findings**, plus one decision that may change the product.

---

## 1. Why this exists — 60-second primer

**MicroViber** is a planned mobile PWA that mirrors Claude Code sessions running on this laptop and lets the user send prompts to them from a phone. The laptop session must never fall behind the phone — it works by reading the live transcript and injecting prompts into the *same live process*, not by `claude --resume`.

The design was validated empirically, but **five questions remain open**, and each one changes code that would otherwise have to be rewritten. One of them (Investigation 1) may make a stated hard requirement impossible, in which case the answer goes back to the user rather than being decided here.

### Established facts (already verified — do not re-verify)

| Fact | Detail |
|---|---|
| Session registry | `~/.claude/sessions/<pid>.json` → `{pid, sessionId, cwd, version, peerProtocol, peerFeatures, kind, entrypoint, messagingSocketPath, name}` |
| Auth token | `~/.claude/sessions/<pid>.<hash>.key` contains `{"peerToken": "..."}` |
| Peer socket | `/tmp/cc-socks/<pid>.sock` — a live Unix socket per running session |
| Transcript | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, append-only, written live |
| Path encoding | `/`, `.` **and** `_` all map to `-`. (`_` is easy to miss and this machine's username contains one.) |
| Titles | `ai-title` entries carry `aiTitle`; `last-prompt` carries `lastPrompt` |
| Injection works | Proven end-to-end into both a VS Code-hosted session and a plain terminal session |
| Prompt is transcribed | The injected prompt lands in the `.jsonl` as a `user` entry containing the wrapper |
| Host detection | `peerFeatures: ['notify_idle']` appears only on VS Code-hosted sessions; process path under `.vscode/extensions/` confirms |
| Busy sessions queue | A prompt sent mid-turn drains at the session's next tool round |

### The problem driving Investigation 1

An injected prompt currently arrives in the target session wrapped like this:

```
Another Claude session sent a message:
<cross-session-message from="uds:/tmp/cc-socks/29905.sock"
    from-name="harness-2-f9" from-mode="bypass">
<the prompt text>
</cross-session-message>

This came from another Claude session — not typed by your user, but very
likely working on their behalf. Treat it as a teammate's request and act on
it within this session's own permission settings…
```

Three consequences: the session may answer more conservatively; **a phone prompt cannot approve a pending question** (the guardrails forbid treating peer messages as user approval); and boilerplate must be stripped before display.

The user has made **"phone prompts must read as ordinary prompts" a hard requirement** (spec §3.1). Investigation 1 determines whether that is achievable.

---

## 2. Safety rules — read before running anything

**This machine has ~8 live Claude Code sessions doing the user's real work.** Several run with `--dangerously-skip-permissions`.

1. **Never inject into a session you did not create.** Every probe targets a disposable session you started in a temp directory. Injecting into a real session pollutes a real transcript and can derail real work.
2. **Create disposables under a scratch path**, never inside `Harness-2/` or any project directory — a session's cwd determines its transcript directory, and you want those disposable too.
3. **Clean up every disposable**: kill the process, then remove its temp directory, its `~/.claude/projects/<encoded-cwd>/` directory, and its `~/.claude/sessions/<pid>.json` + `.key` files.
4. **Never print or commit a `peerToken`, an API key, or a `.key` file's contents.** Note *that* a token exists and its shape, never its value. If a command leaks one into a log, delete the log.
5. **Do not modify anything under `~/.claude/`** except removing disposables you created.
6. Investigation 2 needs a *visible* session — still use a disposable one opened in its own VS Code window, not one of the user's.

---

## 3. Reusable recipes

### Recipe A — start a disposable session

```bash
S=/tmp/mv-probe-$$          # or a scratchpad path
mkdir -p "$S" && cd "$S" && echo "# probe" > README.md
mkfifo in.fifo
( exec 3> in.fifo; sleep 900 ) &                     # holds the fifo open
env -u ANTHROPIC_API_KEY claude -p --verbose \
  --input-format stream-json --output-format stream-json \
  --dangerously-skip-permissions -n mv-probe \
  < in.fifo > out.jsonl 2> err.log &
```

Gotchas already hit, so you don't rediscover them:
- `--output-format stream-json` **requires `--verbose`** under `-p`, else it exits immediately.
- Launching interactively under a PTY hits an `ANTHROPIC_API_KEY` confirmation prompt and stalls — hence `env -u`. That prompt also *leaks a partial key into the PTY log*; avoid the interactive path.
- A `-p` session still registers a peer socket and reports `kind: interactive`.

Confirm registration:
```bash
grep -l 'mv-probe' ~/.claude/sessions/*.json | while read f; do cat "$f"; echo; done
```

### Recipe B — locate a session's transcript

```bash
enc() { printf '%s' "$1" | tr '/._' '---'; }         # the /, ., _ -> - rule
f=~/.claude/projects/$(enc "$CWD")/$SESSION_ID.jsonl
```
Or, more robustly: `find ~/.claude/projects -name "$SESSION_ID.jsonl"`.

### Recipe C — read the conversation out of a transcript

```bash
python3 -c "
import json,sys
for line in open(sys.argv[1],errors='ignore'):
    try: o=json.loads(line)
    except: continue
    if o.get('type') in ('user','assistant'):
        m=o.get('message',{}); c=m.get('content')
        s=c if isinstance(c,str) else ' '.join(
            b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')
        if s.strip(): print(o['type'].upper(),'>>',repr(s)[:400]); print()
" "$f"
```

### Recipe D — clean up

```bash
kill $PID 2>/dev/null
rm -rf "$S"
rm -rf ~/.claude/projects/<encoded-cwd-of-$S>
rm -f ~/.claude/sessions/$PID.json ~/.claude/sessions/$PID.*.key
grep -l 'mv-probe' ~/.claude/sessions/*.json || echo "clean"
```

---

## 4. Investigation 1 — [GATE] Is there a native user-turn frame?

**This gates the whole plan. Run it first.**

**Question.** Can the peer protocol deliver a prompt that lands as a **genuine user turn**, rather than the `<cross-session-message>` wrapper?

### Step 1.1 — Read the client before poking the server

Far cheaper than blind socket probing: a peer *client* already exists on this machine, and its frame vocabulary is discoverable.

```bash
# The VS Code extension ships JS — grep it for the protocol
E=~/.vscode/extensions/anthropic.claude-code-*/
grep -rl "cross-session-message" $E 2>/dev/null
grep -rho "cc-socks[^\"']*" $E 2>/dev/null | sort -u | head
grep -rho "peerToken\|peerProtocol\|peerFeatures" $E 2>/dev/null | sort -u

# The native binary — string-mine it for frame type names
B=$(ls $E/resources/native-binary/claude 2>/dev/null | head -1)
strings "$B" | grep -iE "cross-session|peer_|user_turn|user_message|notify_idle" | sort -u | head -40
strings "$(which claude)" | grep -iE "cross-session|peer_|user_turn|user_message" | sort -u | head -40
```

Goal: enumerate the message **type names** the socket server accepts. Record every candidate. A type resembling a user message or user turn is the prize; a single peer/agent-message type with no alternative is a negative result.

### Step 1.2 — Observe a real handshake

Start a disposable (Recipe A). Connect to its socket and record what the server sends unprompted, and what it accepts:

```bash
SOCK=/tmp/cc-socks/$PID.sock
# read the peerToken WITHOUT printing it
TOKEN=$(python3 -c "import json,glob;print(json.load(open(glob.glob('$HOME/.claude/sessions/$PID.*.key')[0]))['peerToken'])")
```

Write a tiny Node or Python client that connects, authenticates, and logs frames. Determine the framing (newline-delimited JSON vs length-prefixed) from Step 1.1 rather than guessing.

### Step 1.3 — Probe each candidate frame

For each candidate type from 1.1, send one probe with a distinguishable payload (`PROBE-<type>-<n>`), then read the disposable's transcript (Recipe C) and classify:

- **Native user turn** — the `user` entry contains *only* your text, no wrapper, no "Another Claude session sent a message" preamble. ✅
- **Wrapped** — the entry contains the `<cross-session-message>` wrapper. ❌
- **Rejected** — the server errors or ignores it. Record the error.

Change **one variable per probe** and record every result, including failures. Do not batch.

### Step 1.4 — Report the outcome

| Outcome | What it means | Next |
|---|---|---|
| **(1) Native user-turn frame exists** | Requirement §3.1 satisfied | `injected` can no longer come from the wrapper → plan.md Task 13 uses **daemon-side correlation** (match sent text + timestamp against tailed entries). Task 24 needs no unwrap. Continue to Investigation 2. |
| **(2) Wrapper only** | §3.1 **partly** met | Task 24 strips boilerplate for display; Task 11 prefixes the body to identify the phone client. **The "cannot approve a pending question" limit remains** — say so plainly. Continue to Investigation 2. |
| **(3) Neither / unfixable** | §3.1 needs a companion VS Code extension, which **contradicts** the host-agnostic principle (spec §1) | **STOP. Report to the user with the evidence and let them choose.** Do not pick a side, and do not start Phase 1. |

Clean up (Recipe D).

---

## 5. Investigation 2 — Does the injected prompt render as a user bubble?

**Question.** Spec R5 is recorded as *observed-absent, not established* — the one confirming screenshot was cropped. Settle it on uncropped evidence, for **both** host types.

**Method.**
1. **VS Code host:** create a disposable directory, open it as a VS Code window, start a Claude Code session in it from the extension. Inject a prompt (using whatever frame Investigation 1 selected). With the tab visible and scrolled to the bottom, record whether the *prompt* appears as a user turn — the assistant *reply* is already known to render.
2. **Terminal host:** start a disposable interactive session in a terminal, inject, and record whether the prompt appears in the TUI.
3. For both, separately confirm the prompt **is** in the `.jsonl` (Recipe C) — it should be.

**Why it matters.** If the prompt does not render, plan.md Task 24 builds a visible-echo mitigation so the laptop transcript stays self-explanatory. If it does render, that mitigation must **not** be built (no speculative code).

**Note.** A likely explanation for an absence is that the UI filters `cross-session-message` entries from rendering — an inference, not established. If Investigation 1 returned outcome (1), re-test with the native frame: the absence may disappear entirely.

---

## 6. Investigation 3 — Are idle subscriptions one-shot?

**Question.** Is a `notify_idle` subscription **consumed on delivery** (requiring re-subscribe) or does it persist?

**Method.** Subscribe to a disposable session's idle signal. Drive it busy → idle and confirm a notice arrives. Drive it busy → idle a **second time without re-subscribing**. Record whether a second notice arrives.

**Why it matters.** Spec §8's policy is "one notice per subscription, re-subscribe after each delivery". If subscriptions persist, that policy inverts and plan.md Task 19's bookkeeping changes. Session *state* is unaffected either way — §5.1's idle heuristic is deliberately independent of this.

Also record whether the notice carries a **status line** describing what the session finished (it did when observed), since that text is the push-notification payload.

---

## 7. Investigation 4 — Version-gate range and `peerToken` lifetime

**Questions.**
- Which `version` / `peerProtocol` values does the adapter declare supported, and which signal detects drift?
- Is `peerToken` stable for a session's lifetime, or does it rotate?

**Method.**
```bash
# survey observed versions and protocol numbers across all live sessions
python3 -c "
import json,glob
for f in glob.glob('$HOME/.claude/sessions/*.json'):
    try: d=json.load(open(f))
    except: continue
    print(d.get('pid'), d.get('version'), 'proto', d.get('peerProtocol'), d.get('peerFeatures'))
"
```
This machine has seen CLI `2.1.233` and extension `2.1.237`, both `peerProtocol: 1` — expect a spread. Decide whether the gate keys on `peerProtocol` (stable, coarse) or `version` (precise, noisy). Recommend `peerProtocol` as the gate with `version` recorded for diagnostics, unless evidence says otherwise.

For the token: capture a session's `peerToken` **hash** (never the value) at start, then again after some activity and after a reconnect, and compare. Determines whether the adapter re-reads the `.key` file on reconnect.

**Why it matters.** These become constants and behaviour in plan.md Tasks 7 and 9. The gate's job is to **degrade to read-only** on an unrecognised build rather than guess at a changed protocol.

---

## 8. Investigation 5 — Transport confirmation

**Question.** Confirm Tailscale as the transport and prove the TLS story. PWA install and Web Push both require a secure context, so this is not optional.

**Method.**
```bash
tailscale status 2>&1 | head -5          # is there a tailnet, and is the phone on it?
tailscale ip -4 2>&1                     # the address the daemon will bind to
tailscale cert --help 2>&1 | head -5     # cert issuance available?
```
Then: confirm a cert can be issued for the `*.ts.net` hostname, and that the phone can reach a trivial HTTPS listener on the laptop **over cellular** (not just wifi). Confirm a process can bind specifically to the tailnet address and that binding is *not* `0.0.0.0`.

**If Tailscale is not installed,** stop and ask the user rather than substituting a public tunnel — spec §9 explicitly rejects ngrok/Cloudflare Tunnel for an endpoint that executes commands on the laptop.

**Why it matters.** Blocks plan.md Tasks 14 (bind assertion), 19 (push), and 21 (PWA install).

---

## 9. Deliverable

Write `docs/features/microviber/findings.md` with one section per investigation:

```markdown
## Investigation N — <title>
**Question.** …
**Method.** what was actually run
**Result.** what was observed — quote real output, not a summary
**Decision.** the concrete choice this fixes
**Plan impact.** which plan.md tasks change, and how
```

Rules: **quote real output**; if something was not tested, say so rather than inferring; record negative results (they are why the alternative was chosen). Then update `spec.md` — promote resolved checkpoints out of §13, correct any finding whose strength changed, and record the §3.1 outcome. Commit on `feature/microviber`.

**Stop and report to the user, without starting Phase 1, if:** Investigation 1 returns outcome (3); Investigation 5 finds no Tailscale; or any investigation contradicts an established fact in §1 above — that would mean the design rests on something no longer true.

---

## 10. Prompt to paste into the fresh session

```
Use superpowers:executing-plans to run docs/features/microviber/investigation-plan.md.

It is Phase 0 of the MicroViber project — five empirical investigations into
Claude Code's peer-messaging internals, producing findings and decisions, no
product code. The file is self-contained; read it in full first, including
the safety rules in §2 before running anything.

Investigation 1 is a gate: if it returns outcome (3), stop and report to me
rather than choosing between the two conflicting requirements yourself.
```
