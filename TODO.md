# TraceLens — future components

Backlog of visual components / schema additions that would make debugging traces easier. Each item has a problem it solves, a sketch of the schema change, and a rough render-side plan. Each lands as a new optional schema field with sensible defaults so existing traces don't break.

**Implementation order**: top → bottom within each tier. Tier 1 first.

---

## Tier 1 — highest payoff, small lift

- [x] **1. `path-divergence` — side-by-side execution paths.** Render two (or more) parallel columns of frames, each labelled (e.g. `"test"` vs `"prod"`, `"happy"` vs `"bug"`), aligned where they share frames and visually split at the divergence point. Schema: add `pathId: "prod"` (or list of ids) on frames. Top-level `paths: [{id, label, color}]` config. _Implemented on branch `feat/path-divergence`. Schema: top-level `paths`, per-frame `pathIds` + `pathOutcomes`. Renderer: Path toggle in control bar, coloured stripe at left edge of each row, "Per-path outcomes" callout in detail pane. Worked example: `TraceLens/2026-05-19-deposit_override_layer/` (test vs prod paths through `load_payment_details()`)._
- [ ] **2. `db-row` — inline DB result table.** First-class `<table>` view inside the detail pane instead of `<pre>` dumps. Column highlights for null / zero / mismatch. Schema: `rows: { columns: [...], rows: [[...]], highlights: [{col, rule}] }`.
- [ ] **3. `value-diff` — git-style before/after diff for `changes`.** When a watched variable is a complex object, show a collapsible tree-diff with red/green highlight. Schema: `changes: [{ var, before: {...}, after: {...}, kind }]`.
- [ ] **4. `pinned` bar.** User marks frames; they render as compact chips under the title, always visible, clickable to jump. Already reserved in SKILL.md "Future modifiers". Schema: `special: [{ name: "pinned" }]`.

## Tier 2 — solid use-cases, moderate lift

- [ ] **5. `timing` ribbon.** `durationMs` / `selfMs` per frame → thin horizontal bar next to the function name proportional to total trace time, heatmap-coloured. Already reserved as `slow` modifier; full timing unlocks more.
- [ ] **6. `loop-counter`.** `{ iterations: N }` field → `× N` badge with hover showing min/max/avg per-iteration time. Better than today's choice between hiding the loop or duplicating the frame.
- [ ] **7. `error-flow` overlay.** SVG arrows from the `throws` frame up through every re-raise / wrap site to the catch. Schema: `throws: { catchAt: "#N" }` on the throwing frame.
- [ ] **8. `state-machine` inset.** Small SVG state diagram inside the detail pane showing the transition this frame drives. Schema: `stateMachine: { states: [...], transition: ["from", "to"] }`.

## Tier 3 — speculative but interesting

- [ ] **9. `mermaid-export` button.** Generates a Mermaid sequence diagram from the current view; one-click copy for Confluence / Jira / Slack.
- [ ] **10. `source-popover`.** Hover the file link → inline preview of ~10 lines around the `href` line, syntax-highlighted. Needs HTTP serving; falls back to copy buttons on `file://`.
- [ ] **11. `annotation` notes.** Right-click any frame → type a note → saved to `localStorage` under the trace's title hash. `📌` badge on annotated frames; reviewers can share notes without editing `trace.data.js`.
- [ ] **12. `scenario` tabs.** Trace-level scenarios (e.g. happy / bug, test / prod). Each frame's WATCH / changes / extra can be scenario-scoped. Top bar segmented tabs switch the view. Polished, multi-tab version of #1.

---

## Cross-cutting principles

- **Schema-first, renderer-second.** Every component starts as a new optional schema field with a sensible default when absent.
- **Backward compatibility.** Same `schemaVersion: 1`; renderer ignores fields it doesn't know.
- **One feature per branch.** Branch name `feat/<short-slug>`; merge to `main` when the component is documented + has at least one worked example in `SKILL.md`.
- **Examples drawn from real traces.** Each new component must demonstrate itself on an existing trace folder under the `TraceLens/` directory (e.g. `manual_bo_deposit`, `deposit_override_layer`, `deposit_confirmed_listener_callers`).
