---
id: microviber-track-c-6
title: Style code blocks with syntax highlighting and render GFM tables
status: todo
project: microviber
depends_on: []
complexity: M
github_issue: https://github.com/yarivsnapir/MicroViber/issues/42
---

## User Story
As a **developer reading agent output on my phone**, I want **code to look like code and tables to render as tables**, so that **the transcript reads the way it does in the VS Code extension instead of as undifferentiated prose**.

## Acceptance Criteria
1. A fenced code block renders in its own container with a background, padding, border and rounding, visually distinct from prose. Today Tailwind's Preflight resets it to monospace at the same font size with no other styling, so code is nearly indistinguishable from surrounding text.
2. A fenced block has its **own** horizontal scroll container. A long code line must never make the whole transcript scroll sideways.
3. A known language is syntax highlighted. An unknown language tag renders as plain text inside the same styled block rather than throwing.
4. Inline code is visually distinct from prose.
5. GitHub-flavored markdown renders: tables, task lists, strikethrough and bare autolinks. None of these render today, because `remark-gfm` is not installed and the renderer is strict CommonMark.
6. A table gets its own horizontal scroll container.
7. **The content security policy is unchanged.** No `unsafe-eval` and no `wasm-unsafe-eval` may be added.
8. **No HTML string is ever injected.** No `innerHTML` and no `dangerouslySetInnerHTML` anywhere in the change.
9. Raw HTML in transcript content stays inert. The existing cases in `pwa/test/markdown-safety.test.tsx` still pass, and a new case proves the added plugins did not open a hole.
10. The unused `clsx` dependency is removed. It is declared in `pwa/package.json` and referenced nowhere in `pwa/src` or `pwa/test`.
11. `npm run typecheck && npm run lint && npm test` is green from the repo root.

## Affected Files
- `pwa/package.json` — add `remark-gfm`, `rehype-highlight`, `highlight.js`; remove `clsx`.
- `pwa/src/components/transcript/CodeBlock.tsx` — **new.** The `code` component override, handling both inline and fenced code.
- `pwa/src/lib/markdown.tsx` — register the plugins and the `code`, `pre` and table overrides. **The anchor logic and `urlTransform` are not touched.**
- `pwa/src/index.css` — import the highlight theme.
- `pwa/test/transcript-code.test.tsx` — **new.**
- `pwa/test/markdown-safety.test.tsx` — extend.

## Technical Notes
Implements **plan task 10**. PWA only; the daemon is untouched.

**Rollout assumption: none.** This story shares no file with any other story in the track — it was the only one with zero overlap — so it can ship in any order.

**Use `rehype-highlight`, not `highlight.js` directly — this is a correction to the design spec's wording and it is load bearing.** Called directly, `highlight.js` returns an HTML **string**, which could only be injected with `dangerouslySetInnerHTML`. That is the exact API threat row **T7** forbids, and T7 is the highest-consequence entry in this project's threat model because rendering arbitrary model output *is* the product. `rehype-highlight` wraps `lowlight`, which **is** highlight.js, and emits a syntax tree that react-markdown renders as ordinary React elements. Same grammars, same language coverage, same bundle story, same "no WebAssembly, no eval" posture, and no HTML string anywhere. Record this correction in the feature spec at close-out.

**Why Shiki was rejected.** It would give exact parity with the extension, since it uses the same TextMate grammars and themes, but it needs WebAssembly, which would mean adding `wasm-unsafe-eval` to `script-src`. That weakens the directive T7 rests on. The tradeoff was put to the user explicitly and this is the chosen side.

**Do not touch `urlTransform` or the anchor component.** They carry accumulated security-review and link-classification findings from an earlier story.

## Manual Test Checklist
- [ ] Start the daemon and open the PWA on a session containing fenced code in the assistant's output.
- [ ] Confirm code blocks now have a distinct background and border, and are obviously not prose.
- [ ] Confirm a known language such as TypeScript is coloured.
- [ ] Confirm a fenced block with a nonsense language tag still renders its text rather than breaking the view.
- [ ] Confirm a long code line scrolls inside its own box and the page does not scroll sideways.
- [ ] Confirm inline code is visually distinct.
- [ ] Find or prompt for a markdown table and confirm it renders as a table with borders.
- [ ] Tap a link in the transcript and confirm link routing still behaves exactly as before, both for an external link and for a local file or dev server link.
