# microviber-track-b — Story Index

| # | Title | Project | Complexity | Depends On | Status | Issue |
|---|-------|---------|------------|------------|--------|-------|
| 1 | Dev-server port resolution & devports.json config | microviber | M | — | done | [#8](https://github.com/yarivsnapir/MicroViber/issues/8) |
| 2 | Web pane backend — shared cookie auth, dev-server proxy, local file route | microviber | L | 1 | done | [#9](https://github.com/yarivsnapir/MicroViber/issues/9) |
| 3 | Web pane UI — dropdown address bar + sandboxed iframe | microviber | M | 2 | done | [#10](https://github.com/yarivsnapir/MicroViber/issues/10) |
| 4 | Transcript link handling — local vs external routing | microviber | S | 3 | done | [#11](https://github.com/yarivsnapir/MicroViber/issues/11) |
| 5 | Title bar + PWA install button | microviber | S | — | done | [#12](https://github.com/yarivsnapir/MicroViber/issues/12) |
| 6 | Session picker dropdown + folder browsing | microviber | M | 3 | done | [#13](https://github.com/yarivsnapir/MicroViber/issues/13) |
| 7 | Composer action-row alignment | microviber | S | — | done | [#14](https://github.com/yarivsnapir/MicroViber/issues/14) |
| 8 | AskUserQuestion detection: empirical spike + transcript-meta scanning | microviber | M | — | todo | [#15](https://github.com/yarivsnapir/MicroViber/issues/15) |
| 9 | AskUserQuestion: awaiting-input state, takeover fix, notify-policy readiness | microviber | M | 8 | todo | [#16](https://github.com/yarivsnapir/MicroViber/issues/16) |
| 10 | AskUserQuestion: PWA rendering + answer submission | microviber | M | 9 | todo | [#17](https://github.com/yarivsnapir/MicroViber/issues/17) |
| 11 | Web pane content-plane streaming proxy (SSE / streamed responses) | microviber | M | 3 | todo | [#22](https://github.com/yarivsnapir/MicroViber/issues/22) |

## Dependency Graph

```
story-1 → story-2 → story-3 → story-4
                        ↘ story-6

story-5   (independent)
story-7   (independent)

story-8 → story-9 → story-10

story-11  (depends on 3 — deferred follow-up)
```

## Notes

- **Rollout safety** (per spec-to-stories rule 1b): every prefix of this sequence is safe to ship in isolation. Stories 1-2 are purely additive backend work (new fields/routes nothing yet calls); story 3 is the first to actually consume them; story 4 depends on 3's `navigateWebPane`; story 6 depends on 3's `CaretButton`. Stories 5 and 7 are fully independent UI polish. Story 9 is the load-bearing bug fix (unblocks takeover during `AskUserQuestion`) and depends on story 8's detection plumbing; story 10's PWA UI depends on 9's state, and its one interactive piece (answer submission) is explicitly gated on story 8's empirical spike outcome.
- **Story 8 carries real schedule risk**: it opens with a mandatory empirical spike (verifying `tool_result`-over-stdin actually works) whose outcome isn't known yet. If it fails, story 10's answer-submission acceptance criterion is dropped, not the whole story — see story 10's Technical Notes for the fallback.
- **Icons are already delivered** (`pwa/public/icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `favicon.png`, provided 2026-08-28) — story 5 just wires them in, flat paths (not under an `icons/` subdirectory as the plan originally assumed before the art arrived).
- **Story 11 is a deferred follow-up from story 3's code review**, not part of the original spec-to-stories breakdown: story 3's content-plane reverse-proxy fully buffers each upstream response (`proxyToLoopback` → `arrayBuffer()`), so a streaming/SSE/long-poll dev-server endpoint hangs the pane. Not blocking for the common "did my change render?" use case (ordinary responses complete fine); carved for tracking so it isn't lost in story 3's footer.
- **Filed separately, not in this story set:** a real push-notification dispatch subsystem (no `web-push` dependency, no subscription endpoint, nothing sends anything today despite `MV_VAPID_*` config existing) — story 9 makes `notify-policy.ts`'s logic correct and ready, but building the actual sender is out of scope here per the plan's explicit Global Constraints decision.
