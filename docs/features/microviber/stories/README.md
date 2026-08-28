# microviber — Story Index

Issues for these stories live on the public GitHub repo `yarivsnapir/MicroViber` — each
story's `github_issue:` frontmatter field carries its issue URL, kept in sync with this
table's Issue column.

| # | Title | Project | Complexity | Depends On | Status | Issue |
|---|-------|---------|------------|------------|--------|-------|
| 1 | Daemon — replace attach/owned write path with takeover-via-resume (+ absorbed: pairing URL over HTTPS reverse proxy) | microviber | M | — | done | — |
| 2 | Daemon — takeover/handback routes replace owned/attach stubs | microviber | S | microviber-1 | done | [#1](https://github.com/yarivsnapir/MicroViber/issues/1) |
| 3 | PWA — Take-over composer gate replaces broken attach/owned UI | microviber | M | microviber-2 | done | [#2](https://github.com/yarivsnapir/MicroViber/issues/2) |
| 4 | Docs — final reconciliation to shipped takeover behavior + close spec §13 checkpoints | microviber | S | microviber-3 | done | [#3](https://github.com/yarivsnapir/MicroViber/issues/3) |

## Dependency Graph

```
microviber-1 → microviber-2 → microviber-3 → microviber-4
```

## Scope note

These four stories cover the **delta from built code** enumerated at the end of
[plan.md](../plan.md) (§ "Delta from built code") — converting the already-built v2
(attach + owned) daemon and PWA to the v3 takeover-via-resume model. Tasks 1–5, 7–22, 25
in plan.md are already built and committed to `main` in `microviber/` and are **not**
re-carved into stories here. Task 23 (physical-phone end-to-end walkthrough) is folded
into story 3's Manual Test Checklist, since that is the story that first makes the full
write path usable. Task 24 (daemon-spike open questions) has safe defaults already coded
into stories 1–2; closing the loop on those defaults is story 4's concern (spec §13
reconciliation).
