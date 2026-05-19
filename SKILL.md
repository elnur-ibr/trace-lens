---
name: debug-stack-trace
description: Use when debugging a bug whose root cause spans a long call chain across multiple files, explaining a branching flow with guards / overrides / early-returns, comparing why one execution path produced a different value or output than another, or when the user asks to "visualize a flow", "trace this bug", "make a stack trace", "draw out the call chain", "walk through the code", or "show how this gets called".
---

# Debug Stack Trace Visualization

## When to use

Use this skill when the user wants to inspect or share **how code executes across many steps** — especially when:

- Debugging a bug that spans multiple files / classes / layers (e.g., HTTP entry → service → DB → external publish)
- Explaining why a specific output appeared (e.g., `balance=0` in one log line vs `balance=1000` in another)
- Walking through a branching flow with guards and early-returns (override layers, fallback paths, etc.)
- Documenting an existing flow for onboarding or for forwarding to teammates

**Do NOT use this skill** when:
- A short prose explanation will do (don't over-engineer trivial flows)
- The user wants a sequence diagram (use mermaid/PlantUML instead)
- The user wants a real-time runtime trace (this is static analysis only)

## What this skill produces

For each debug session, a **trace folder** under the project root containing a thin `index.html` shell plus a `trace.data.js` data file, sharing a versioned renderer kept in `TraceLens/_renderer/vN/`.

```
<project root>/
└── TraceLens/                       ← all traces live here
    ├── _renderer/
    │   └── v1/
    │       ├── debug-trace.css      ← copied from the skill, shared by all traces
    │       ├── debug-trace.js       ← versioned renderer
    │       └── VERSION              ← "1"
    └── <short-description>/         ← one folder per trace
        ├── index.html               ← shell, references ../_renderer/vN/* + ./trace.data.js
        └── trace.data.js            ← window.STACK_TRACE = { schemaVersion: 1, … }
```

What the rendered page shows:

- Every frame in execution order, indented by call depth, with tree connector lines (`│ ├ └`) drawn via CSS pseudo-elements
- Each frame row: `#NN` · status dot · function name · `↩` call-site copy · `⎘` definition copy · file:line · tag
- Two IDE-pasteable copy buttons next to each row's file path:
  - `↩` **call site** — where this frame was invoked. Copies `calledFromHref` if set on the frame; otherwise falls back to the immediate parent's `href`. Hidden on the entry frame (no caller).
  - `⎘` **definition** — the frame's own location, from `href`. Hidden when the frame has the `unexplored` modifier — for stubs we never walked into, the `href` is effectively a call-site placeholder, so showing both buttons would duplicate the same path and confuse readers.
  - Both paths are converted to `path/to/file.ext:NNN` form (replacing `#L` with `:`) so they paste cleanly into VS Code's Quick Open, JetBrains "Recent Files", etc. Successful copy flashes the button to `✓` for ~900ms.
- **Two-level collapse:**
  - **Level 1 — stack tree:** a `▾/▸` chevron on parent frames toggles whether their children are visible
  - **Level 2 — detail pane:** clicking any row reveals a panel beneath it with description, code snippet, and `$params` snapshot
- **Action buttons:** Stack tree expand/collapse all, Details open/close all, Jump to `<target frame>`
- Dark theme, Tahoma stack, monospace for code — no external font dependencies

Open `index.html` directly in a browser (works on `file://` because `trace.data.js` is loaded as a script, not fetched as JSON — no CORS issue). Or serve the project root over http via Laragon/php-server. No build step either way.

### Skill folder layout

```
~/.claude/skills/debug-stack-trace/
├── SKILL.md                         ← this file
└── renderer/
    └── v1/
        ├── debug-trace.css          ← canonical stylesheet (source of truth)
        ├── debug-trace.js           ← canonical renderer
        ├── shell.html               ← HTML template with {{TITLE}}, {{RENDERER_REL}}, {{DATA_REL}} placeholders
        └── VERSION                  ← "1"
```

When invoked, copy the renderer folder into the project's `TraceLens/_renderer/v1/` (only if it isn't already there; safe to overwrite if older), then fill the shell into `TraceLens/<feature>/index.html`.

## Versioning

Two version numbers are tracked, and both are visible to the renderer at runtime so old traces keep working when newer renderers ship.

| Concept | Where it lives | Example |
|---------|----------------|---------|
| **Renderer version** | `renderer/vN/` folder name + `RENDERER_VERSION` const in `debug-trace.js` + `VERSION` file | `1` |
| **Schema version** | `schemaVersion` field at the top of each trace's `window.STACK_TRACE` object | `1` |

### Rules

1. **New optional fields are backward compatible — same major schema version.** Adding a new field on a frame (e.g. a new `special` modifier) does NOT bump the schema. Older renderers just ignore the field.
2. **Breaking changes bump both numbers.** If the schema changes shape so that an old renderer would render wrong output (e.g. renamed required field, changed callers semantics), publish `renderer/v2/` and have new traces declare `"schemaVersion": 2`.
3. **Both versions ship side-by-side.** `renderer/v1/` stays in place forever; v2 lives next to it. Old `index.html` files continue to reference `_renderer/v1/`; only newly generated traces link to `_renderer/v2/`.
4. **Renderer announces what schemas it supports.** Each `debug-trace.js` defines `SUPPORTED_SCHEMAS = [1]`. If a trace's `schemaVersion` is not in that list, the renderer shows a yellow banner above the title but renders best-effort — so opening a v2 trace with a v1 renderer doesn't fail silently.
5. **`schemaVersion` is optional.** Missing → assumed `1` (legacy traces predating this field continue working).

### Bumping the schema (checklist)

When you need a breaking schema change:

1. Copy `renderer/v1/` → `renderer/v2/`
2. In the new `debug-trace.js`: bump `RENDERER_VERSION = 2`, set `SUPPORTED_SCHEMAS = [2]` (or `[1, 2]` if you can render both)
3. Update the JSON schema section of SKILL.md, marking the breaking change
4. For new traces: set `"schemaVersion": 2` and reference `../_renderer/v2/*` in the shell
5. Existing `TraceLens/*/index.html` files keep working because they already reference `../_renderer/v1/`

## Trace data file

The renderer is fixed across all traces; the **only file you author per trace** is `trace.data.js`. It defines a single global:

```js
window.STACK_TRACE = {
  "schemaVersion": 1,
  "title":         "<short title shown in the H1>",
  "subtitle":      "<one-line lede; HTML allowed>",
  "jumpTarget":    { "n": 15, "label": "root cause" },  // null = hide the button
  "watch":         [ /* WATCH entries — see "Tracking variables" */ ],
  "shortPath":     [0, 4, 5, 11, 15, 16, 17, 19],       // [] = hide Full/Short toggle
  "frames":        [ /* FRAME entries — see below */ ]
};
```

The wrapper is JavaScript so the data file can be loaded via `<script src>` on `file://` (avoids the `fetch('*.json')` CORS restriction). Inside the object literal it's strict JSON — no trailing commas, double quotes, escaped `\"` and `\n` inside strings.

> **Legacy single-file mode.** The renderer also still parses inline `<script type="application/json" id="trace-data">…</script>` blocks (the pre-split layout). Useful for sharing a self-contained HTML file without the renderer alongside.

### FRAME entry

```jsonc
{
  "n":       0,                          // unique frame id. Conventionally 0-based and sequential, but the renderer indexes frames by `n` via a lookup map, so you can insert new frames later with any unused value (e.g. expanding an existing trace and using n=26+ instead of renumbering the whole array).
  "fn":      "function_name()",          // label shown in the row
  "kind":    "endpoint",                 // see Tag taxonomy
  "tag":     "ENTRY",                    // UPPERCASE pill (~2-3 words)
  "file":    "path/to/file.ext:NNN",     // human-readable location (definition site of this frame)
  "href":    "path/to/file.ext#LNNN",    // clickable link (VS Code/GitHub style) — copied by ⎘ button
  "calledFromHref": "path/to/parent.ext#LNNN", // OPTIONAL: the exact line in the caller where this frame is invoked — copied by ↩ button. If omitted, the ↩ button falls back to the immediate parent frame's href.
  "callers": [0, 3, 6, 7, 11],           // FULL ancestor chain root → parent (empty array = root)
  "desc":    "1-3 sentence description; HTML allowed.",
  "code":    "<span class=\"key\">…</span>",      // syntax-highlighted code
  "pLabel":  "$params",                  // header for the right detail panel
  "p":       "<span class=\"com\">…</span>",      // $params / local state snapshot
  "extra":   "<table class=\"join\">…</table>",   // OPTIONAL: tables/callouts before the code/params grid
  "changes": [                           // OPTIONAL: WATCH variable mutations at this frame
    { "var": "balance", "value": "0", "note": "Write #1 default", "kind": "bad" }
  ],
  "special": [                           // OPTIONAL: modifier badges (see Special tag modifiers)
    { "name": "duplicate", "value": "2", "title": "called twice in this trace" },
    { "name": "root-cause", "title": "the canonical failure site" }
  ]
}
```

### `callers` — the most important field

`callers` is the *full ancestor chain* from root, NOT just the immediate parent. The renderer uses it for:
- Indentation depth (`callers.length`)
- The "called by:" breadcrumb in the detail pane
- Tree connector line computation (which lanes get `│` vs blank)

Example: frame #15 is called from `load_payment_details` (#11), called from listener `handle` (#07), called from `dispatch` (#06), called from `log_manual_transfer` (#03), called from the BO endpoint (#00). So `callers: [0, 3, 6, 7, 11]`.

### JSON authoring rules

- **Newlines inside string values must be `\n`.** JSON doesn't allow raw newlines in strings. Multi-line code/desc/p strings need explicit `\n`.
- **Double quotes inside string values must be escaped `\"`.** Single quotes are fine bare.
- **Highlighting spans for code/p:**
  - `<span class=\"com\">// comment</span>`
  - `<span class=\"key\">if / else / function / return / etc</span>`
  - `<span class=\"str\">'string literal'</span>`
  - `<span class=\"num-c\">123</span>`
  - `<span class=\"fn-c\">function_name</span>`
  - `<span class=\"bad-val\">0</span>` — red highlight (bug value)
  - `<span class=\"good-val\">125.50</span>` — green highlight (correct value)
- **No trailing commas.** Strict JSON.
- **`desc` accepts inline HTML** — `<code>`, `<strong>`, etc., useful for emphasis.

### Why JSON instead of inline JS

- The renderer's CSS + JS is stable across traces — bugs fixed once benefit every trace.
- The data block is clearly demarcated and machine-readable — easy to validate, generate, or diff.
- No risk of accidentally breaking the renderer when editing per-trace content.
- Future-proof: the same JSON can drive an alternate renderer (e.g. a CLI text view) without changes.

## Tag taxonomy

Every frame has a `kind` (visual category, drives the color) and a `tag` (the pill text). The kind also colors the dot and the row's highlight state.

| kind       | Color     | Use for                                            | Example tags                                        |
|------------|-----------|----------------------------------------------------|-----------------------------------------------------|
| `endpoint` | amber     | Entry/exit of the system                            | `ENTRY`, `EXIT`, `PUBLISH`, `RETURN`                |
| `good`     | teal      | Behavior is correct / expected                      | `WALLET UPDATE`, `WRITE #2`, `OK`, `MATCH`          |
| `normal`   | grey      | Routine pass-through; nothing notable               | `DISPATCH`, `LISTENER`, `PROFILE`, `DTO BUILD`, `ENTER HANDLER`, `ROW INSERTED`, `FTD FLAG` |
| `bug`      | red       | Identified bug origin                               | `BUG`, `BUG · WRONG TABLE`, `WRITE #1` (bad write)  |
| `override` | blue      | Guard / override layer / wrapper logic              | `OVERRIDE LAYER`, `GUARD A`, `GUARD B`, `CALL A`    |
| `data`     | purple    | Data-dependent step (DB/query/external state)       | `5-JOIN SQL`, `ROOT CAUSE`, `LOOKUP`, `CACHE`       |
| `branch`   | yellow    | Branching / decision point                          | `DECISION`, `BRANCH`, `IF/ELSE`                     |
| `publish`  | cyan      | External I/O — send/produce/emit                    | `PUBLISH`, `EMIT`, `WEBHOOK`, `HTTP POST`           |

Rules of thumb:
- Pick `bug` or `data` for at most 2-3 frames — they should stand out, not blanket the trace.
- Mark the canonical "root cause" frame with `★ ROOT CAUSE` and pair it with an `extra` block (tables, callouts) explaining the failure modes.
- Use `branch` for the explicit decision point (the `if ... return false`-style split). Use `override` for the wrapper logic around it.

## Special tag modifiers

Beyond `kind` (which sets the row's color), a frame can carry one or more **special modifiers** that flag orthogonal properties — "is this a duplicate call?", "does this throw?", etc. They render as small icon badges next to the function name and are independent of `kind`.

### Schema

```js
{
  ...
  special: [
    { name: "duplicate",   value: "2", title: "called twice in this trace" },
    { name: "root-cause",              title: "the canonical failure site" }
  ]
}
```

Per modifier:
- `name` — must be one of the recognized modifier names below
- `value` — optional small text shown next to the glyph (e.g. `"2"` for a duplicate count)
- `title` — optional hover tooltip explaining the flag

### Recognized modifiers

| Glyph | name              | When to use                                                                 |
|-------|-------------------|------------------------------------------------------------------------------|
| `↻`   | `duplicate`       | Same function called more than once in the trace. Set `value` to the count. |
| `★`   | `root-cause`      | The canonical failure / bug origin. Use on exactly one frame per trace.      |
| `↗`   | `early-return`    | Function exits before reaching its main body (guard / short-circuit).        |
| `⚡`   | `async`           | Async / concurrent call (worker thread, callback, future, queue consumer).   |
| `Δ`   | `mutates-shared`  | Writes to shared state — DB row, cache key, global, file, session.           |
| `☓`   | `throws`          | This frame throws/raises an error.                                           |
| `?`   | `hypothetical`    | Not 100% sure this fires; included on inference rather than evidence.        |
| `☁`   | `external-io`     | External service call — HTTP, RPC, message queue, third-party API.           |
| `⚙`   | `config-gated`    | Behavior depends on a config flag / module setting / feature toggle.         |
| `🔒`   | `tx-boundary`     | Inside a DB transaction or lock scope.                                       |
| `⋯`   | `unexplored`      | Frame is a *stub*: we know it gets called but did NOT walk into its body. Set `value` to an approx count of inner calls if known (e.g. `"~12"`). |

### Authoring guidance

- **Don't over-modify.** Most frames have no specials. A row with 4 badges is noisy.
- **`root-cause` is singular.** One per trace, on the frame `jumpTo` points at.
- **`duplicate` is detectable.** Apply it to every occurrence of the repeated function (e.g. both `#09` and `#15` if `get_users_data` is called twice). Put the same count in `value` on each.
- **`mutates-shared` and `throws` are the two most useful** beyond `duplicate`/`root-cause` — they let a reader scan the trace for side effects and failure paths at a glance.

### Future modifiers (reserved)

When adding new modifiers, append rows to the table above and update `renderer/v1/debug-trace.js`'s `SPECIAL_GLYPHS` map (also CSS rules under `.special-badge.<name>` if a distinct color is wanted):

- `⤴` `recursion` — frame calls itself or its ancestor
- `⏱` `slow` — known performance hotspot
- `🧪` `test-only` — code path only reachable under test fixtures
- `📌` `pinned` — user bookmark / "come back to this"

## Tracking variables across frames

For debugging where the focus is "how does this one value evolve" (e.g., a single struct field, a counter, a flag), the template supports a **WATCH** panel that pins one or more variables and shows their full lifecycle as a clickable timeline above the frame list.

### Top-level WATCH config

Declare the watched variables in a constant near the `FRAMES` definition:

```js
const WATCH = [
  { name: "balance",         label: "$params['payment_details']['balance']",         initial: "(unset)" },
  { name: "player_timezone", label: "$params['payment_details']['player_timezone']", initial: "(unset)" },
];
```

- `name` — short key referenced by each frame's `changes` (see below)
- `label` — full human-readable expression shown in the WATCH panel
- `initial` — value shown before the first frame that changes it (optional, defaults to `"(unset)"`)

If `WATCH` is empty `[]`, the panel is hidden entirely.

### Per-frame `changes` field

Add a `changes` array to any frame where a watched variable's value flips:

```js
{
  n: 5, fn: "Write #1 — explicit defaults", ...
  changes: [
    { var: "balance",         value: "0",          note: "isset() fell through to ternary default", kind: "bad" },
    { var: "player_timezone", value: "'UTC'",      note: "ternary default — fe_users has no timezone column", kind: "bad" }
  ]
}
```

Per-change fields:
- `var` — must match a `name` from the WATCH config
- `value` — string to display (wrap in quotes if it's a string literal)
- `note` — short reason for the change (optional but recommended)
- `kind` — `"bad"` (red), `"good"` (green), or omit for neutral (the variable color)

Frames that don't touch the variable simply omit `changes` (or leave it `[]`).

### What the user sees

1. A **WATCH panel** above the frame list, one row per tracked variable. Each row shows the variable name on the left and a chronological strip of `#NN → value` chips. Clicking a chip calls `jumpTo(NN)` to scroll to and open that frame's detail.

2. Inside each frame's detail pane, if that frame has `changes`, a **"Changes at this frame"** block appears between the description and the code/params grid, listing each `var = value  // note`.

3. A small marker on rows whose frame has `changes` so you can spot change points in the tree without expanding.

### When to use it

- **Yes** — single value that mutates across many frames and you want to spot where it goes wrong (e.g., a price, a balance, a flag, a session token).
- **Yes** — comparing intended write site vs actual emitted value (e.g., Write #1 writes 0 → override should overwrite at Write #2 → final published value).
- **No** — when nothing actually changes; the WATCH panel adds noise to a flat trace.
- **Cap at 3-4 variables**. Beyond that the panel becomes a wall.

## Views: short path vs full path

Some flows are noisy — most frames are scaffolding (dispatch, listener entry, FTD flag, etc.) and only 4-6 frames matter for the actual bug. The template supports two views, switchable from a segmented control in the control bar:

- **Full path** (default) — every frame in `FRAMES`. The complete picture, with all tree connector lines.
- **Short path** — only the curated essentials. Use it for "the elevator pitch" of the bug.

### `SHORT_PATH` config

A top-level array of frame indices that should appear in the short view. Order doesn't matter — frames are always rendered in their `n` order. Indentation and tree connectors are computed against the FULL parent chain, so skipped frames leave a visual gap (which is intentional — it signals omitted plumbing).

```js
const SHORT_PATH = [0, 4, 5, 11, 15, 16, 17, 19];   // entry, bug, write #1, override entry,
                                                    // root cause, decision, write #2, publish
```

If `SHORT_PATH` is empty `[]`, the toggle is hidden and only the Full view is shown.

### Picking frames for SHORT_PATH

**User asks > heuristics.** If the user names a frame to include in or drop from the short view, edit `shortPath` directly. Do NOT re-derive from the rules below or push back. The rules are the *default* pick when the user hasn't expressed a preference.

Include:
- The entry point
- The bug origin (any `kind: "bug"` frame)
- The decision point that determines the outcome (`kind: "branch"`)
- The root cause (`kind: "data"` with `★`)
- Any frame whose `changes` mutates a tracked variable
- The publish/exit point

Skip:
- Pure pass-through routing (dispatch, listener entry without logic)
- Guards that always pass for the case being explained
- Unrelated downstream side-effects (postbacks, SMS, optimove, etc.)
- Sibling success branches that don't lead to the bug emission path (keep short = failure lineage only; success counterparts belong in Full view for contrast)

## Trace depth — partial expansion (full vs full-er)

Even the **Full view** is a *curated* trace by default — we list only the frames that matter for the bug. But the reader can lose context if a wide fan-out (e.g. an HTTP endpoint that calls 8 things and we only show 2) is silently hidden. The `unexplored` modifier (`⋯`) is the bridge.

### Default depth budget

**When the user has NOT specified how deep to go, walk at most 3 levels from the entry frame.**

- Level 1 = the entry's direct method calls
- Level 2 = direct calls inside any Level-1 frame you walked into
- Level 3 = direct calls inside any Level-2 frame you walked into
- Anything deeper → leave as `⋯ unexplored` stubs at level 3

This caps the trace at a readable size for "trace this whole flow" requests where the user doesn't yet know which branch matters.

**Override the budget when:**

- The user names a specific value/symptom to chase ("trace the balance field", "why does this return false", "follow the call chain to the publish") — then keep walking down the path that touches that thing, regardless of depth.
- The user explicitly asks to go deeper on a particular frame ("go into get_users_data", "expand load_payment_details") — walk that branch fully.
- The bug origin is provably below level 3 — walk to it plus one level past so the failure is visible in context.

When you override the budget, walk down ONLY the relevant path; siblings off the path stay as `⋯` stubs even if they're shallower than the depth you reached.

If you're unsure whether to override, ask the user before exploding the trace size.

### The rule (BFS, one level at a time)

At the **entry point** and at every frame we **walk into**, list ALL of that frame's direct method calls as child frames. For each direct child:

- **On-path** (leads to the bug / behavior being explained) → recurse: walk into its body, its children become frames too.
- **Off-path** (not part of the failure lineage) → still emit a frame for it, but:
  - add `{"name": "unexplored"}` to its `special` array
  - keep `desc` to one sentence ("what this branch does and why we're not entering it")
  - leave `code` minimal or omit
  - do NOT create any child frames under it

This gives the reader the **full fan-out at every walked-into layer** without dragging in the rest of the codebase. The `⋯` badge is the visual signal: "more inside, didn't go in."

### Example

Entry point calls `handle_transfer()`, `insert_direct_payment_record()`, `log_manual_transfer()`, and a few audit helpers. Bug lives down `log_manual_transfer()`. Frames:

```
#00 POST submit                              (entry — walked into)
#01 handle_transfer()           ⋯            (unexplored — success branch)
#02 insert_direct_payment_record() ⋯         (unexplored — bookkeeping)
#03 log_manual_transfer()                    (walked into — on the bug path)
   #04 …                                     (children of #03 follow)
```

### When the user asks for "the full pass"

If the user says "give me the full trace" / "real full" / "list every method call from the entry":

1. Treat the entry frame as the root.
2. List **every** direct method call from it as a frame.
3. On-path → recurse one more level. Off-path → mark `⋯` and stop.
4. Repeat at each layer the user asks to dig into. Do NOT auto-expand more than the user requests.

This is iterative, not a one-shot full xdebug-style trace. The skill renders curated frames; for a true runtime flame trace (hundreds-to-thousands of calls), recommend xdebug capture instead.

### Annotation niceties

- Put an approximate inner call count on the `⋯` badge: `{"name": "unexplored", "value": "~12"}` (helps the reader gauge what they're skipping).
- For off-path siblings, prefer `kind: "normal"` so the row doesn't visually compete with the bug path.
- If multiple stub frames share a theme (e.g. all are audit log writes), one line in their `desc` referencing the others is enough — don't repeat the rationale on each.

## Filters (Full view only)

In Full view, a filter chip bar lets the reader hide categories of frames by `kind`. Default: all kinds visible.

Implementation:
- Renders one chip per `kind` actually present in `FRAMES`
- Click chip → toggle that kind on/off → `applyState()` hides all frames of that kind
- A small badge on each chip shows the count of frames matching that kind
- Chips have the same color coding as tags so the visual link is obvious

Hiding is **visual only** — `FRAMES` and tree lane computations are untouched. When the user re-enables a kind, the rows reappear without losing collapse/detail state.

### Future filter ideas (reserved)

- Filter by author/owner of the file (group by repo path prefix)
- Filter by frames that match a search term (function name or tag substring)
- Pin/unpin individual frames irrespective of kind

## Actions (control bar)

The skill renders a control bar above the frame list with these buttons:

### Always present
- **`Stack tree: Expand all` / `Collapse all`** — toggles subtree visibility for every parent frame.
- **`Details: Open all` / `Close all`** — toggles every detail pane.
- **`Jump to #N (label)`** — uncollapses ancestors of frame `#N`, opens its detail pane, scrolls into view. Use for the canonical root-cause frame.
- **`View: Full | Short`** — segmented control switching between the full path and `SHORT_PATH`-curated view (hidden if `SHORT_PATH` is empty).
- **`Kind filter chips`** — one chip per `kind` present in `FRAMES`, with a count badge. Click to hide/show that category in Full view.

### Reserved for future extension
The template's JS exposes `collapsed: Set`, `open: Set`, `hiddenKinds: Set`, `currentView: string`, and `applyState()` so more actions can be added without touching markup:

- **`Bookmark frame`** — persist favourited frames in `localStorage`; render a star icon on the row.
- **`Diff $params(A, B)`** — open two detail panes side by side and highlight key diffs in the params snapshots.
- **`Linkable frame URLs`** — write open-frame state into `location.hash` for shareable deep links.
- **`Search`** — text filter on function name or tag substring.
- **`Watch any expression`** — let the user paste any JS expression to evaluate against each frame's $params, beyond the predeclared WATCH.

When adding actions, declare them in this section and update both `renderer/v1/shell.html` (control bar markup) and `renderer/v1/debug-trace.js` (handler logic).

## Workflow when invoked

1. **Clarify scope.** Ask which entry point, which symptom, and where the flow ends. Cap at ~25 frames — beyond that, recommend splitting into multiple traces.
2. **Walk the code.** Read the relevant files yourself (don't make the user enumerate every step). For each function call, guard, and write site that's relevant to the symptom, create a frame.
3. **Assign `kind` thoughtfully.** Use the taxonomy table above. Most frames should be `normal` — the colors are signal, not decoration.
4. **Capture two snapshots per detail pane:**
   - LEFT panel = the code AT this frame (the line(s) that run)
   - RIGHT panel = the `$params` / local state AT this frame (with diffs from the previous frame highlighted)
5. **Pick a root cause frame.** Set `jumpTarget` to it. Add an `extra` block on that frame with the deeper analysis (risk tables, "why prod ≠ test" callouts, etc.). Add `"special": [{"name": "root-cause"}]` to it.
6. **Tag duplicates.** If a function is called more than once in the trace, add `"special": [{"name": "duplicate", "value": "<count>"}]` to every occurrence.
7. **Define WATCH variables** if there's one or two values worth tracking across frames (e.g., the bugged field).
8. **Curate `shortPath`** — the 5-10 frames a reader needs to understand the bug.
9. **Decide trace folder name.** Convention: `TraceLens/YYYY-MM-DD-<short-description>/` — today's date plus a kebab-case description, e.g. `TraceLens/2026-05-19-manual_bo_deposit/`. The date prefix keeps traces sorted chronologically and makes it obvious when one is stale.
10. **Ensure the renderer is present.** If `<project>/TraceLens/_renderer/v1/` doesn't exist (or is older than the skill's), copy `<skill>/renderer/v1/{debug-trace.css, debug-trace.js, VERSION}` into it.
11. **Write `trace.data.js`** in the trace folder. Set `schemaVersion: 1` and the rest of the schema fields. The data block is what you author per trace.
12. **Write `index.html`** in the trace folder by filling the skill's `renderer/v1/shell.html` placeholders:
    - `{{TITLE}}` → trace title (e.g. "Manual BO Deposit → RabbitMQ")
    - `{{RENDERER_REL}}` → `../_renderer/v1` (assumes the default folder layout)
    - `{{DATA_REL}}` → `./trace.data.js`
13. **Open `index.html` in a browser.** Confirm tree connectors line up (each parent's `└` lands on its last child), `Jump to #N` works, and the WATCH panel chips jump correctly. If `window.STACK_TRACE` is missing or malformed, a red error banner appears.

## Template

The skill ships three files under `renderer/v1/`. Per-trace work touches only `trace.data.js` in the output folder — the renderer files are stable.

- `renderer/v1/debug-trace.css` — theme & layout. Edit only for cross-trace appearance changes; bump to `v2` if it would break older `index.html` files that link to `v1`.
- `renderer/v1/debug-trace.js` — rendering logic + state. Same versioning rule.
- `renderer/v1/shell.html` — HTML skeleton with three placeholders. Copy into the output folder per trace and replace `{{TITLE}}`, `{{RENDERER_REL}}`, `{{DATA_REL}}`.

Per-trace authoring template (the `trace.data.js` body):

```js
window.STACK_TRACE = {
  "schemaVersion": 1,
  "title":         "…",
  "subtitle":      "…",
  "jumpTarget":    { "n": 0, "label": "…" },
  "watch":         [ … ],
  "shortPath":     [ … ],
  "frames":        [ … ]
};
```

Do not modify the CSS or JS per-trace — fixes there belong in the skill's `renderer/vN/` so every future trace benefits.

## Anti-patterns

- **Don't over-frame.** Every `if`, every line is not a frame. Frames are *interesting steps* — entry, write site, guard, decision, publish. Pass-through plumbing can be summarized in one frame's description.
- **Don't use `bug` kind decoratively.** Reserve it for the actual bug site(s). Otherwise the visual signal collapses.
- **Don't omit `callers`.** Indentation and tree lines depend entirely on it. Always provide the full ancestor chain, even if it looks redundant.
- **Don't inline secrets or production data.** Use placeholder values like `<encrypted_id>`, `***`, or sanitized IDs in the snippets.
- **Don't make `extra` blocks long-form.** They appear inside the detail pane, not as separate sections. Cap at one table + one callout.
