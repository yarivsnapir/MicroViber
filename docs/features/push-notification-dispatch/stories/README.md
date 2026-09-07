# push-notification-dispatch — Story Index

| # | Title | Project | Complexity | Depends On | Status | Issue |
|---|-------|---------|------------|------------|--------|-------|
| 1 | Daemon + PWA: wire NotifyPolicy into a real Web Push sender | microviber | L | — | done | [#35](https://github.com/yarivsnapir/MicroViber/issues/35) |

## Notes
`NotifyPolicy` (`daemon/src/domain/notify-policy.ts`) and its `MV_VAPID_*` config were built in `microviber-track-b-8` (2026-09-02), which explicitly scoped out wiring it into a real sender: "That's a separate, larger pre-existing gap — file it as its own follow-up story rather than absorbing it here." That filing never happened until now (2026-09-06). Single-story feature — no spec.md/plan.md yet; the story itself gates on a prerequisite spike (criterion 1) whose outcome may warrant returning to brainstorming before deep implementation, same pattern as `microviber-track-b-8`'s own gated spike.
