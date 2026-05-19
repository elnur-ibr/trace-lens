# trace-lens

A Claude Code [skill](https://agentskills.io/specification) that produces interactive HTML stack-trace visualisations for debugging code paths that span many files. Drop a JSON-ish data file next to the renderer; open `index.html`; get a tree-indented, collapsible, copy-button-equipped view of who called what, what changed where, and where the bug lives.

Built for the case where a prose explanation isn't enough: branching flows with guards and early-returns, "why did this value end up zero", deposit/webhook/event pipelines that traverse listener layers, etc.

## What you get

Every trace renders as a self-contained page with:

- **Tree-indented frames** — one row per significant step, with `│ ├ └` connector lines drawn by CSS
- **Two-level collapse** — chevron toggles a frame's subtree; clicking a row opens its detail pane with code + `$params` snapshots
- **Copy buttons per row** — `↩` call site, `⎘` definition. Both paste as `path/to/file.ext:NNN` into VS Code Quick Open / JetBrains "Recent Files"
- **WATCH panel** — pin one or more variables, see every mutation across the trace as a clickable timeline
- **Filters and views** — chip-bar filter by `kind`, Full vs Short view (with a curated `shortPath`), Jump-to-N target button
- **Versioned renderer** — `renderer/v1/` is immutable once published; breaking schema changes ship as `v2/` alongside, so old traces keep working

## Layout

```
trace-lens/
├── SKILL.md                    ← agent instructions (what to do, schema, anti-patterns)
├── README.md
├── renderer/
│   └── v1/
│       ├── debug-trace.css     ← theme & layout
│       ├── debug-trace.js      ← renderer logic + schema-version check
│       ├── shell.html          ← per-trace HTML template (with placeholders)
│       └── VERSION             ← "1"
└── template.html               ← legacy single-file renderer (back-compat)
```

Per-trace output (in the consuming project, not in this repo):

```
TraceLens/
├── _renderer/v1/               ← copied from this repo, shared by every trace
└── YYYY-MM-DD-<short-slug>/
    ├── index.html              ← shell with placeholders filled in
    └── trace.data.js           ← window.STACK_TRACE = { schemaVersion: 1, … }
```

## Installation (Claude Code)

```sh
git clone git@github.com:elnur-ibr/trace-lens.git "$HOME/.claude/skills/debug-stack-trace"
```

The skill will then appear under its declared `name` to Claude Code's `Skill` tool and the description triggers it automatically when you ask to "trace this bug", "visualize a flow", "walk through how this gets called", etc.

## Manual use (no Claude needed)

You can also write `trace.data.js` files by hand and ship them with the renderer. The data shape is documented in [`SKILL.md`](./SKILL.md#trace-data-file); the minimal example is:

```js
window.STACK_TRACE = {
  "schemaVersion": 1,
  "title":         "My flow",
  "subtitle":      "Optional one-liner; HTML allowed",
  "jumpTarget":    null,
  "watch":         [],
  "shortPath":     [],
  "frames": [
    { "n": 0, "fn": "entry()", "kind": "endpoint", "tag": "ENTRY",
      "file": "src/foo.ts:1",
      "href": "src/foo.ts#L1",
      "callers": [],
      "desc": "Where it all starts.",
      "code": "// ...",
      "pLabel": "input",
      "p": "{}"
    }
  ]
};
```

Open `index.html` (from `renderer/v1/shell.html` with placeholders filled in) directly in a browser. Works on `file://` — no server required.

## Schema versioning

The renderer reads `TRACE.schemaVersion` and:

- accepts versions listed in `SUPPORTED_SCHEMAS` (currently `[1]`)
- shows a yellow banner above the trace title when the schema is unknown, then renders best-effort

Breaking changes ship as a new `renderer/vN/` folder alongside `v1`. Old traces continue to work because they link to their original renderer version.

## License

MIT — see [LICENSE](./LICENSE) if present.
