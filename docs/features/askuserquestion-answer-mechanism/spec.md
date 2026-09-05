# AskUserQuestion Answer Mechanism — Design Spec

> Status: design approved 2026-09-03 (plain-English walkthrough reviewed and accepted by the user) · Branch: `feature/askuserquestion-answer-mechanism` (cut from `story/microviber-track-b-8`, whose code this builds on)
> Scope: the one piece story [microviber-track-b-8](../microviber-track-b/stories/story-8.md) shipped without — a working way to **answer** a pending `AskUserQuestion` from the phone (its AC15). Seeded by [askuserquestion-answer-mechanism-brief.md](../microviber-track-b/askuserquestion-answer-mechanism-brief.md); amends `docs/architecture-spec.md` §2/§4/§5 and `docs/functional-spec.md` §3 as listed in §11.
> Everything story-8 already ships — detection, the `awaiting-input` state, takeover unblocking, question rendering — is **not** redesigned here. This spec only adds the submission path and the bookkeeping rule that makes it honest.

---

## 1. Problem

A laptop session blocked on `AskUserQuestion` shows up on the phone as `awaiting-input`, can be taken over, and renders the question with its options — but the options are inert. Two submission mechanisms were tried and empirically ruled out (architecture-spec.md §2, F16/F17):

| Attempt | Conversation | MicroViber bookkeeping |
|---|---|---|
| Plain-text prompt with the tapped label | Coherent — the model acts on it | **Never resolves**: no `tool_result` for the pending `tool_use_id` ever appears, so `pendingQuestion` stays set forever |
| A real `tool_result` frame on stdin | **Incoherent** — by the time it lands, `claude -p --resume`'s synthetic "Continue from where you left off." handshake has already made the tool_use stale; the model re-asks in plain text | Resolves correctly |

Neither alone satisfies AC15 ("tap an option, the session continues normally").

## 2. Findings that shape this design (F18)

Controlled experiments run for this spec against Claude Code CLI `2.1.259`, observing only the child process's stream-json stdout (never the transcript files). To be recorded as row **F18** in architecture-spec.md §2:

1. **The handshake is conditional, not intrinsic to `-p --resume`.** Resuming a session whose transcript ended normally (`stop_reason: end_turn`), with stdin held open but idle for 12–20 s, produced **no** synthetic turn and no `system/init` line until the first real stdin frame arrived (consistent with the older F14 observation "the CLI stays silent until the first user turn"). The "Continue from where you left off." turn fires only when the resumed transcript ends on a dangling `tool_use` — matching the SDK's documented synthetic-turn origin `"auto-continuation"` ("injected when the session continues without fresh user input").
2. **`AskUserQuestion` is hard-disabled in `-p` mode.** Even with `--tools default,AskUserQuestion`, the model's call is answered by the CLI with `<tool_use_error>… AskUserQuestion is disabled for this session, in subagents as well as here.</tool_use_error>`. There is therefore no headless invocation variant under which the F16 `tool_result` path can be made coherent, and a daemon-owned process can never itself produce a pending question. Every pending question MicroViber will ever see originates in the laptop's interactive session.
3. **A headless CLI killed mid-tool writes its own synthetic `tool_result` before exiting** (`Exit code 137`), so a dangling `tool_use` cannot be manufactured headlessly for a reproduction rig; F17's live-session evidence remains the reference.

**Corollary of finding 2, stated so nobody files it as a bug:** a daemon-owned process's model can still *attempt* `AskUserQuestion`; the CLI immediately answers it with a `<tool_use_error>` `tool_result`. Clause (a) of §4.1 resolves that occurrence at once — the card renders resolved with no highlighted option (§4.1 strips error content from `selectedLabels`), and the session never enters `awaiting-input`.

**Not yet verified at transcript level — gating spike for the implementing story (F18 addendum):** these experiments observed only stdout, so the transcript fields the §4.1 rule keys on are known only from F17's earlier live-transcript evidence (`isMeta: true` on the handshake turn) and the codebase's existing knowledge of `origin.kind: 'task-notification'`. The story must first confirm, on a real transcript, that ordinary human turns — one typed on the laptop, one injected by the phone over `-p --resume` stdin — have `isMeta !== true` (absent or `false` both pass, matching rule (b)) **and** no `origin` field, and record that as the F18 addendum before building on §4.1. If either assumption fails, §4.1's exclusion is narrowed as described there.

**Consequence.** In the real flow the handshake fires exactly once, at takeover, and the model parks with "No response requested." (F17). After that, a plain-text user turn is processed normally (also F17). The only unsolved part is MicroViber's own "is this question still open?" rule — and that can stay transcript-derived.

## 3. Design in one paragraph

Answers are sent as **plain user turns** through the existing `send()` path — no `tool_result` frame, ever. MicroViber gains a **second, transcript-derived resolution rule**: a pending question is resolved not only by a matching `tool_result` (the laptop's answer stub, kept as-is) but also by **any later real user turn** — the phone's composed answer, a free-text composer reply, or a laptop interruption. The synthetic handshake is excluded because Claude Code marks it `isMeta: true`. Because both rules read only the transcript, a daemon restart, page reload, or cold rescan re-derives the same result; the daemon keeps no resolution state of its own. The daemon composes the answer text in one fixed format so it can parse the chosen labels back for display, and validates every answer against the actually-pending question before sending. The unused F16 `tool_result` plumbing is deleted.

## 4. Adapter layer (`daemon/src/lib/claude-adapter/`)

### 4.1 Resolution rule

Given a pending `AskUserQuestion` tool_use at transcript line *i*, the question is **resolved** by the first later `user` entry *j > i* that satisfies either clause:

- **(a) tool_result clause** — unchanged from story-8: `message.content` contains a `tool_result` block whose `tool_use_id` equals the tool_use's `id`. `resolvedBy: 'tool_result'`; `selectedLabels` = the block's string content split on `,` (as today), **except** that `isResolvingUserEntry` normalises to `selectedLabels: undefined` when the content is not a string, is empty, or begins with `<tool_use_error>` (the CLI's own rejection, §2 corollary) — so the card sees exactly one "no labels" shape, never an empty array.
- **(b) human-turn clause** — new: the entry has at least one `text` block (or a string `content`), **and** `isMeta` is not `true`, **and** the entry's `origin.kind` (if any) is not one of a known-synthetic denylist. `resolvedBy: 'text'`; `selectedLabels` = the labels parsed back from the entry's text when it matches the daemon's own answer format (§5.3), else `undefined`.

Exclusions and why:

| Excluded entry | Why |
|---|---|
| `isMeta: true` user turns | This is the "Continue from where you left off." handshake (F17). Counting it would mark every question answered the moment takeover happens. |
| Entries whose `origin.kind` is in the synthetic denylist (`task-notification`, `auto-continuation`) | Synthetic lines the CLI injects itself — not a person. `origin.kind: 'human'` (and no `origin` at all) both count as human — see the addendum below. |
| `tool_result`-only entries for a **different** tool_use_id | Not a human turn; not this question's answer. |

Included on purpose: the laptop's `[Request interrupted by user]` marker. An interruption after a question means the person moved on; the question is no longer open. (`transcript-meta.ts` already treats that marker as turn-closing.)

**Direction of the `origin` exclusion — updated after the spike (F18 addendum, 2026-09-04).** This section originally planned "no `origin` field at all" as the fail-closed choice, with a documented fallback to "never 'any kind we haven't seen is human'" if the spike found `origin` on human turns. The spike FAILed exactly that way: a real laptop-typed turn carries `origin: {kind: "human"}`. The shipped rule is a denylist, not the narrower fallback originally planned — a decision made after the fact, not the one pre-committed to, so it's recorded here explicitly rather than left implicit. Reasoning: the denylist is fail-closed in the direction that matters — the *write* path (`domain/answer.ts`'s `validateAnswer`, called separately, re-derives `pendingQuestion` from the live transcript on every answer attempt; an incorrectly-cleared `pendingQuestion` only ever makes a later genuine answer attempt fail visibly with "question is no longer pending," never lets a stale one through). The residual risk is cosmetic: an unrecognised future synthetic `origin.kind` would make the *display* show a question as answered when it isn't, until the denylist is extended. `SYNTHETIC_ORIGIN_KINDS` in `ask-user-question.ts` is the single place to extend it.

### 4.2 One shared helper, two consumers

Story-8 implemented detection twice — `tail.ts`'s `extractAskUserQuestion` + `resolveAskUserQuestions` (per-occurrence events) and `transcript-meta.ts`'s rolling `pendingQuestion` slot — with a `SYNC:` comment listing two known divergences. The rule now has two clauses; duplicating it doubles the drift surface. This spec extracts a shared module, **`lib/claude-adapter/ask-user-question.ts`**, owning:

- `detectAskUserQuestion(assistantContent): { toolUseId, questions } | null` — the zod-validated tool_use scan both modules currently repeat.
- `isResolvingUserEntry(entry, toolUseId): { by: 'tool_result'; selectedLabels: string[] | undefined } | { by: 'text'; text: string } | null` — the rule in §4.1.
- `composeAnswerText(questions, selections): string` and `parseAnswerText(questions, text): string[] | undefined` — §5.3.

`tail.ts` and `transcript-meta.ts` both call these; the `SYNC:` comments are deleted. Behaviour of the two consumers stays as before in every other respect (per-occurrence events with independent resolution in `tail.ts`; a single last-write-wins slot in `transcript-meta.ts`). The two latent divergences the `SYNC:` comment describes (multiple simultaneously pending questions; two question blocks in one assistant message) are **out of scope** — they cannot occur in practice because the interactive CLI blocks until a question is answered, and this spec does not change them.

### 4.3 Schema

`schemas.ts`'s `user` transcript line gains `isMeta: z.boolean().optional()`. Nothing else in the modelled transcript vocabulary changes; `isMeta` is consumed only inside the adapter (quarantine, §6 of the architecture spec).

### 4.4 Event shape

`TranscriptEvent`'s `askUserQuestion` variant gains `resolvedBy?: 'tool_result' | 'text'` (present iff `resolved: true`; fine under `exactOptionalPropertyTypes`). `selectedLabels` keeps its current meaning. For a **text**-resolved question the resolving user turn is **kept** in the event stream as a normal `user` event (it is a real conversational turn); only the tool_result path keeps dropping its blank bubble, as today. The PWA's hand-maintained mirror of this type in `pwa/src/lib/types.ts` (`TranscriptEvent`) gains the same field — it is a SYNC point, not derived.

## 5. Daemon flow

### 5.1 API

`POST /api/sessions/:id/prompt` — same route, same bearer auth, same `Idempotency-Key` requirement, same 403 on a not-taken-over session, same audit record. The body becomes a discriminated union (`schemas/api.ts`):

```ts
// unchanged plain prompt
{ text: string }
// new: an answer to the currently pending AskUserQuestion
{ answer: { toolUseId: string; selections: string[][] } }
```

`selections[i]` is the list of option labels chosen for question *i* of the pending call. The old optional `toolUseId` field on the plain body is removed (it belonged to the deleted tool_result path). Response is the existing `PromptStatus` envelope in both cases.

### 5.2 Validation (fail closed) — and its order relative to idempotent replay

The PWA learns a prompt's `queued → accepted` transition by **re-POSTing the identical body under the same `Idempotency-Key`** every few seconds (App.tsx's `pendingPrompt` effect); after the answer turn lands, `pendingQuestion` is `null` by rule (b), so a re-validation on every call would 400 exactly when the answer succeeded. The order is therefore fixed:

1. **Ownership check** (403 `FORBIDDEN`, audited, no record) — as today, always first.
2. **Same-key lookup in `PromptLifecycle`.** If a record exists for the key: return it when the request's **canonical answer body** (`JSON.stringify({ toolUseId, selections })`, selections in submitted order) equals the one stored on the record (`PromptRecord.answerBody`); otherwise 400 `INVALID_INPUT` "Idempotency-Key reused with a different answer". No transcript access, no recomposition — a replay never needs the (possibly gone) pending question. A plain-text replay against an answer record, or vice versa, is a mismatch and is rejected, mirroring story-8's existing guard.
3. **Only for a new key:** the pending-question re-derivation and checks below, then composition (§5.3) and `submit()` (§5.4).

For a new key, `services.sendPrompt` re-derives the session's current `pendingQuestion` via the adapter (`scanTranscriptMeta` on the live transcript) and rejects with **400 `INVALID_INPUT`** (no `PromptRecord`, still audited as `outcome: 'rejected'`) when any of these fail:

| Check | Message |
|---|---|
| No pending question, or `toolUseId` ≠ the pending one | `question is no longer pending` |
| `selections.length` ≠ number of questions | `answer must cover every question` |
| Any `selections[i]` empty | same |
| `selections[i].length > 1` for a question without `multiSelect: true` | `question <header> accepts one option` |
| Any label not among that question's `options[].label` (exact match) | `unknown option for <header>` |

Labels are model-authored transcript content being echoed back into the session as a user prompt; validating them against the pending question's own option list is what keeps this from becoming an arbitrary-text write path distinct from the (already allowed) composer. See §9, T11 note.

**Audit `prompt` field for an `answer` body.** The audit log hashes a `prompt` string. For an answer that reaches composition it is the composed text (§5.3), identical to any phone prompt. For an answer rejected *before* composition (the 403 path and every 400 case above) it is the canonical answer body from step 2 — deterministic, so the implementer does not invent a serialization.

### 5.3 Composition and parse-back (adapter-owned)

The **daemon** composes the text — one place decides the wording, and the same module can read it back:

```
Answering your question:            ← "questions:" when more than one
- <header>: <label>[, <label>…]     ← one line per question, in question order
```

`parseAnswerText(questions, text)` recognises exactly this shape (either heading; each expected header present once as `- <header>: `; the remainder matched against that question's option labels, longest-label-first so labels containing `, ` still match). On a full match it returns the flat list of matched labels (used as `selectedLabels`); on anything else it returns `undefined` — a free-text reply from the composer simply yields no highlighted option. The composed text is capped at 4 000 characters (a validated answer can never approach this; the cap is a backstop).

**Known, accepted degrade:** a model-authored header that itself contains `: ` or a newline defeats the parser, so that question resolves with no highlight. The model still received the answer correctly; only the display loses the highlight. This is intended — the parser must stay simple and exact rather than grow heuristics.

### 5.4 Lifecycle and audit

The composed text goes through the **existing** `lifecycle.submit({ text })` → `sender.send()` → `userFrame()` path unchanged: `sending` → `queued` on write, `accepted` only when the tailer observes that exact text as a user turn, `expired` after 10 min, `failed` on write error. The audit entry records the composed text exactly like any phone prompt. `PromptRecord` loses its `toolUseId` field and gains an optional `answerBody?: string` (the canonical body from §5.2 step 2, set only for answer records) — the one answer-specific thing stored, and only for replay matching. `submit()` takes it as an optional argument so the record is created **with** it atomically; `services.sendPrompt` never sets it after the fact (that would open a window in which a replay sees a record without `answerBody` and is mis-rejected as a kind mismatch).

### 5.5 Session state

No change to `deriveState`. Once the answer turn lands: `pendingQuestion` → `null` (rule b) and `turnOpen` → `true`, so the session reads `working` until the model's reply parks with `end_turn`, then `idle` — the same lifecycle as any prompt. `NotifyPolicy`'s `awaiting-input` handling is untouched.

## 6. Removed

Dead write path from story-8 Task 7, deleted rather than kept "for later" (F18 shows it can never be made coherent in `-p` mode):

- `prompt-sender.ts`: `toolResultFrame()`, `PromptSender.sendAnswer`
- `session-manager.ts`: `OwnedSessionHandle.sendAnswer` and its re-export
- `prompt-lifecycle.ts`: `submitAnswer()`, `observeAnswer()`, `PromptRecord.toolUseId`, the `toolUseId !== undefined` idempotency guard — replaced by the `answerBody` comparison of §5.2 step 2 (a text replay against a record that has `answerBody`, or an answer replay against one that lacks it, is the kind mismatch)
- `services.ts`: the `observeAnswer` call in `getTranscript`, the `toolUseId` branch in `sendPrompt`
- `schemas/api.ts`: `SendPromptBody.toolUseId`
- `api/app.ts`: the `toolUseId` parameter of `AppDeps.sendPrompt` and its pass-through in the `/prompt` handler
- PWA: the `onAnswerQuestion(toolUseId, label)` prop, the `send(text, toolUseId?)` signature, and `PromptRecord.toolUseId` in `pwa/src/lib/types.ts`
- Their tests, replaced by §8's.

Kept: story-8's `tool_result` **resolution** matcher (rule a) and all detection/rendering.

## 7. PWA

### 7.1 Card states (`AskUserQuestionCard.tsx`, extracted from `Transcript.tsx`)

| State | Rendering | Interaction |
|---|---|---|
| Pending, session not taken over | As today: expanded, options inert | None — the existing bottom bar's **Take over** is the only action (story-8 AC14 "no shortcut" stands) |
| Pending, taken over (`mode === 'owned'`) | **Amended 2026-09-04** (supersedes the original "chips with `aria-pressed`" design): options render as radio buttons (single-select per question) or checkboxes (`multiSelect: true`), matching the VS Code chat extension's own `AskUserQuestion` rendering — each option shows its label AND its `description` text. A **Send answers** button sits at the card's bottom-right, enabled only once every question has ≥ 1 selection. Beside it, one quiet line: *or type a reply below*. | Pick radio/checkbox options; tap **Send answers** once |
| Sending | Options lock (read-only); the button area shows the prompt state — `sending…`, `queued` ("waiting for the session to finish"), `failed` with **Retry** (selections preserved) or `expired` with **Retry**. Never shows "answered" on a network success alone. | Retry re-sends the same selections under a **fresh** `Idempotency-Key` (replaying a `failed` record's key would return the failed record forever) |
| Resolved with labels (`resolvedBy: 'tool_result'`, or `'text'` whose answer parsed) | As today: dimmed, selected labels highlighted (amber). **Known limitation:** `selectedLabels` is a flat list matched per-question by membership, so two questions sharing an option label both highlight it — fixing this requires the daemon to return per-question label arrays (a wire-shape change, deferred). | None |
| Resolved without labels (`'text'` from free text or a laptop interruption; `'tool_result'` carrying a `<tool_use_error>`) | Dimmed, no highlight, a small neutral *no longer pending* caption — neutral because the card cannot tell a free-text answer from an interruption | None |

The one in-flight prompt slot App.tsx already tracks (`status` + `pendingPrompt`) is shared: it gains `kind: 'text' | 'answer'` and, for answers, the `toolUseId`, so a card displays the in-flight state only when the in-flight prompt is *its* answer and the composer displays it otherwise. `api.ts` gets `postAnswer(sessionId, toolUseId, selections, idemKey)` alongside `postPrompt`; the status poll re-POSTs the same answer body under the same key exactly as `postPrompt` does today (§5.2 step 2 is what makes that safe after the answer lands).

### 7.2 Composer while a question is pending

Unchanged and available (it already renders whenever `mode === 'owned'`). Anything typed there is a real user turn and resolves the question by rule (b). This is the "Other" path; no extra chip.

### 7.3 Visible side effect, deliberately not hidden

Right after takeover, the transcript shows the model's short *"No response requested."* reply to the synthetic handshake, above the user's answer. It is real transcript content and stays visible.

## 8. Testing

**Adapter (`daemon/test`)** — `ask-user-question.test.ts` (new) plus updated `tail.test.ts` / `transcript-meta.test.ts`:
- rule (b) resolves on a plain text turn, on the interruption marker, and on a composed answer; does **not** resolve on an `isMeta: true` turn, on an `origin.kind: 'task-notification'` entry, or on a `tool_result` for another id; rule (a) still resolves and still drops the blank bubble.
- both consumers agree on the same fixture set (a shared-fixture test asserting `tail.ts`'s `resolved` matches `transcript-meta.ts`'s `pendingQuestion === null`).
- compose ↔ parse round-trip: one question, several, `multiSelect`, labels containing `, `; parse returns `undefined` for free text and for a partial match.
- schema: `isMeta` parses; absent `isMeta` is fine.

**Domain / services**: each §5.2 rejection (with audit `rejected`, the canonical body as the audited prompt, and no `PromptRecord`); a valid answer submits the composed text through `submit()` and is `accepted` only when observed; 403 when not owned; **idempotent replay of the same answer returns the original record even after `pendingQuestion` has become `null`** (the regression the review caught); a replay with a different body, or a text/answer kind mismatch under the same key, is rejected; clause (a) with `<tool_use_error>` content resolves without labels.

**Story-gating spike (first task of the implementing story, mirrors story-8 AC1):** confirm on a real transcript that laptop-typed and phone-injected human turns carry neither `isMeta` nor `origin`; record as the F18 addendum (§2). If it fails, apply §4.1's narrowing before any other code.

**API**: body union validation; missing `Idempotency-Key` still 400.

**PWA (`pwa/test`)**: every §7.1 state; `Send answers` disabled until complete; single vs multi-select; failed keeps selections and offers Retry; text-resolved card with and without labels; card is inert when `mode !== 'owned'`.

**Manual (real session, recorded in the story's checklist)**: laptop session → `AskUserQuestion` → phone shows `awaiting-input` → Take over → see "No response requested." → pick → Send answers → model continues coherently on the laptop's transcript → card resolved with highlight → **restart the daemon and reload the page** → card still resolved, state not `awaiting-input` → repeat once via the composer (free text) → repeat once answering on the laptop after phone takeover (rule a still highlights).

## 9. Architecture & Spec Alignment

- **Threat model T1–T12 (architecture-spec.md §5): no transport, auth, or adapter-invocation change.** The answer rides the existing `POST /api/sessions/:id/prompt` route — same bearer, same Host/Origin checks, same takeover gate (403 before any record), same `Idempotency-Key` (T10), same audit-every-attempt rule. The daemon still drives sessions only via `claude -p --resume … --input-format stream-json` (session-manager.ts). No new endpoint, header, cookie, or process mode. Extensions required: **none to T1–T12's mitigations**; one **narrowing note under T11** (prompt injection via transcript content): the daemon now echoes model-authored option labels back into the session as a user prompt — bounded by requiring an explicit user tap, validating every label against the pending question's own option list (§5.2), composing in a fixed format, and capping length; the composer already allows arbitrary user text on the same route, so no new capability is granted.
- **Adapter quarantine (§6):** `isMeta`, the resolution rule, and the answer format live only in `lib/claude-adapter/`; `domain/`/`services/`/`api/` see `TranscriptEvent.resolvedBy`, `TranscriptMeta.pendingQuestion`, and two adapter functions. FENCE 1/2 unaffected.
- **Layering fence, one `config.ts`, TS strictness, testing gate:** unchanged; no new env vars.
- **Fail closed:** every malformed or stale answer is rejected before a write (§5.2).
- **Integration contract (§2):** new row **F18** (§2 of this spec) with its re-verify-on-version-change obligation; the `isMeta` exclusion is an explicit dependency on Claude Code internals and is called out as such.
- **API surface (§4):** the `/prompt` body union replaces the story-8 `toolUseId` field.

## 10. UI/UX Guidelines Alignment (functional-spec.md §3)

- **Minimalism:** one new contextual control (**Send answers**), shown only while a question is pending on a taken-over session; no new persistent control.
- **Honest feedback:** `accepted` only when observed in the transcript (spec §3 "Composer gating on idle"); nothing typed or picked is silently lost — `failed`/`expired` keep the selections with Retry.
- **Match the VS Code extension:** pick-per-question then a single submit mirrors the laptop's own AskUserQuestion behaviour. (The functional spec's "phone-injected prompts stay visually distinct" rule is a **pre-existing gap** — `tail.ts` hardcodes `injected: false` and the daemon-side correlation architecture-spec §4 describes was never wired — so the answer turn renders like any other user turn today. Not widened or fixed by this feature; noted so the plan does not assume it.)
- **Deliberate deviation:** none. (The visible "No response requested." turn, §7.3, is transcript content, not a UI choice.)

## 11. Documentation updates carried by the implementing story

- `docs/architecture-spec.md`: §2 add row **F18** (with the spike's addendum on `isMeta`/`origin`); F17's "Practical effect" text gets a forward pointer; §4 API table `/prompt` body; §5 T11 narrowing note; §3 `lib/claude-adapter/` list gains `ask-user-question.ts`.
- `docs/functional-spec.md` §3: **Transcript view** and **Composer gating on idle** gain a dated `**Changed**` entry describing §7.
- `docs/features/microviber-track-b/stories/story-8.md`: the AC15 resolution note gets a pointer to this feature.
- `docs/features/microviber-track-b/askuserquestion-answer-mechanism-brief.md`: a one-line "Outcome" pointer to this spec.

## 12. Out of scope

- Implementing the phone-injected visual distinction (`injected` correlation) — a pre-existing gap, §10.

- Answering questions in sessions the daemon itself owns from scratch (impossible: §2 finding 2).
- Push notifications for `awaiting-input` (story-8's explicit boundary — `NotifyPolicy` still has no dispatcher).
- The two latent multi-question divergences noted in §4.2.
- Any change to takeover gating ("no shortcut" for `awaiting-input`, story-8 AC14).
- Hiding or rewriting the "No response requested." handshake turn.
