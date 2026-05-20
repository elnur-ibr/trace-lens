/* ============================================================
   debug-stack-trace · renderer v1
   ------------------------------------------------------------
   Renders a Stack Trace visualization from trace data. Data is
   read from one of:

     1. window.STACK_TRACE       (preferred — set by trace.data.js)
     2. <script type="application/json" id="trace-data">…</script>
        (legacy / single-file mode)

   Schema versioning:
     - RENDERER_VERSION   = capability of this renderer
     - SUPPORTED_SCHEMAS  = list of schema versions this renderer understands
     - If TRACE.schemaVersion is missing → assumed v1 (back-compat)
     - If TRACE.schemaVersion is in SUPPORTED_SCHEMAS → ok
     - If TRACE.schemaVersion is higher → warning banner, best-effort render
   ============================================================ */

const RENDERER_VERSION  = 1;
const SUPPORTED_SCHEMAS = [1];

// glyph map for special-tag modifiers (extend here)
const SPECIAL_GLYPHS = {
  "duplicate":      "↻",
  "root-cause":     "★",
  "early-return":   "↗",
  "async":          "⚡",
  "mutates-shared": "Δ",
  "throws":         "☓",
  "hypothetical":   "?",
  "external-io":    "☁",
  "config-gated":   "⚙",
  "tx-boundary":    "🔒",
  "unexplored":     "⋯",
  "conditional":    "⎇"
};

// Kinds that have a built-in color + filter chip. Custom kinds beyond
// these can be declared in TRACE.kinds (see "Custom kinds" in SKILL.md);
// anything else renders neutral grey and gets no chip.
const BUILTIN_COLORED_KINDS = new Set(["entry", "bug", "branch", "data", "override"]);

// ── load trace data ───────────────────────────────────────────
function showError(msg) {
  document.querySelector(".wrap").insertAdjacentHTML(
    "beforeend",
    `<div class="err">${msg}</div>`
  );
}
function showWarning(msg) {
  const header = document.querySelector("header");
  if (header) {
    header.insertAdjacentHTML("afterend", `<div class="warn-banner">${msg}</div>`);
  } else {
    document.querySelector(".wrap").insertAdjacentHTML(
      "afterbegin",
      `<div class="warn-banner">${msg}</div>`
    );
  }
}

let TRACE;
if (typeof window !== "undefined" && window.STACK_TRACE) {
  TRACE = window.STACK_TRACE;
} else {
  const inlineEl = document.getElementById("trace-data");
  if (inlineEl) {
    try {
      TRACE = JSON.parse(inlineEl.textContent.trim());
    } catch (e) {
      showError(`Failed to parse inline trace JSON: ${e.message}`);
      throw e;
    }
  }
}

if (!TRACE) {
  showError(
    "No trace data found. Expected <code>window.STACK_TRACE</code> " +
    "(set by trace.data.js) or an inline " +
    "&lt;script type=&quot;application/json&quot; id=&quot;trace-data&quot;&gt; block."
  );
  throw new Error("debug-stack-trace: no TRACE data");
}

// ── schema version check ──────────────────────────────────────
const schemaVersion = TRACE.schemaVersion || 1;
if (!SUPPORTED_SCHEMAS.includes(schemaVersion)) {
  if (schemaVersion > RENDERER_VERSION) {
    showWarning(
      `This trace declares <code>schemaVersion=${schemaVersion}</code>, but the renderer at ` +
      `<code>v${RENDERER_VERSION}</code> only supports schemas: ` +
      `[${SUPPORTED_SCHEMAS.join(", ")}]. Rendering best-effort — newer fields may be ignored.`
    );
  } else {
    showWarning(
      `This trace declares <code>schemaVersion=${schemaVersion}</code>, which is older than this ` +
      `renderer expects. Most things should still work.`
    );
  }
}

// ── extract collections ──────────────────────────────────────
const FRAMES     = Array.isArray(TRACE.frames)    ? TRACE.frames    : [];
const WATCH      = Array.isArray(TRACE.watch)     ? TRACE.watch     : [];
const SHORT_PATH = Array.isArray(TRACE.shortPath) ? TRACE.shortPath : [];

// Direction mode: "top-down" (default, entry-to-target) or
// "bottom-up" (caller-tree, target-to-entry). In bottom-up mode the
// renderer builds an inverted tree rooted at TRACE.callerTreeRoot
// (or jumpTarget.n) and walks it via DFS — each frame's caller-tree
// children are its execution-callers, plus any frame that declares
// `convergesTo: <thisN>` (used to model fan-in like multiple dispatch
// sites funnelling into one event-manager handler).
const DIRECTION = TRACE.direction === "bottom-up" ? "bottom-up" : "top-down";

// Lookup by frame.n so frame numbers can be inserted out-of-sequence
// (e.g. children added later get higher n than their visual neighbours).
const FRAMES_BY_N = {};
FRAMES.forEach(f => { FRAMES_BY_N[f.n] = f; });

function hasSpecial(f, name) {
  return Array.isArray(f && f.special) && f.special.some(s => s.name === name);
}

// Custom kind declarations from the trace (see "Custom kinds" in SKILL.md).
// Inject CSS rules so declared kinds get their color on the dot, tag, and chip.
const CUSTOM_KINDS = (TRACE.kinds && typeof TRACE.kinds === "object") ? TRACE.kinds : {};
const COLORED_KINDS = new Set([...BUILTIN_COLORED_KINDS, ...Object.keys(CUSTOM_KINDS)]);
(function injectCustomKindStyles() {
  const css = [];
  Object.keys(CUSTOM_KINDS).forEach(k => {
    const c = (CUSTOM_KINDS[k] && CUSTOM_KINDS[k].color) || null;
    if (!c) return;
    // Use [data-kind="x"] / class selectors specific enough to override defaults.
    css.push(`.dot.${k}, .row[data-kind="${k}"] .dot { background: ${c}; }`);
    css.push(`.tag.${k} { color: ${c}; }`);
    css.push(`.chip.${k} { color: ${c}; }`);
  });
  if (!css.length) return;
  const style = document.createElement("style");
  style.textContent = css.join("\n");
  document.head.appendChild(style);
})();

// Path-divergence config (see "Path divergence" in SKILL.md). Lets a
// trace model TWO or more execution paths over the same code (test vs
// prod, happy vs bug, cached vs cold). Frames not on the selected path
// are hidden; frames carrying `pathOutcomes[pathId]` render a per-path
// callout in the detail pane describing what happened on each path.
const PATHS = Array.isArray(TRACE.paths) ? TRACE.paths.filter(p => p && p.id) : [];
const PATH_BY_ID = {};
PATHS.forEach(p => { PATH_BY_ID[p.id] = p; });
const ALL_PATH_IDS = PATHS.map(p => p.id);
function framePathIds(f) {
  return (Array.isArray(f.pathIds) && f.pathIds.length) ? f.pathIds : ALL_PATH_IDS;
}
(function injectPathStyles() {
  if (!PATHS.length) return;
  const css = [];
  PATHS.forEach(p => {
    if (!p.color) return;
    const safeId = String(p.id).replace(/"/g, "");
    css.push(`.path-toggle button[data-path="${safeId}"] { color: ${p.color}; border-color: ${p.color}; }`);
    css.push(`.path-toggle button[data-path="${safeId}"].active { background: ${p.color}22; color: ${p.color}; }`);
    css.push(`.path-outcome-row[data-path="${safeId}"] .path-pill { color: ${p.color}; border-color: ${p.color}; }`);
    css.push(`.row[data-paths~="${safeId}"]::before { background: ${p.color}; }`);
  });
  if (css.length) {
    const style = document.createElement("style");
    style.textContent = css.join("\n");
    document.head.appendChild(style);
  }
})();

// header
document.getElementById("title").textContent = TRACE.title || "Stack Trace";
document.getElementById("subtitle").innerHTML = TRACE.subtitle || "";

// jump button
if (TRACE.jumpTarget && typeof TRACE.jumpTarget.n === "number") {
  const btn = document.getElementById("jump-btn");
  btn.textContent = `Jump to #${String(TRACE.jumpTarget.n).padStart(2,"0")} (${TRACE.jumpTarget.label || "target"})`;
  btn.style.display = "";
}

// ── execution tree maps (top-down) ────────────────────────────
const parentOf = {};
const childrenOf = {};
FRAMES.forEach(f => {
  parentOf[f.n]   = (f.callers && f.callers.length) ? f.callers[f.callers.length - 1] : -1;
  childrenOf[f.n] = [];
});
FRAMES.forEach(f => {
  if (parentOf[f.n] !== -1) childrenOf[parentOf[f.n]].push(f.n);
});

// ── caller tree maps (bottom-up) ──────────────────────────────
// In bottom-up the rendering tree is inverted: every frame becomes
// the caller-tree child of its execution-caller. `convergesTo`
// adds an extra caller-tree edge for fan-in scenarios.
const ctChildrenOf  = {};   // n → [n,n,...]   children in caller-tree
const ctParentChain = {};   // n → [n,n,...]   path from caller-tree root to this n
let   ctRoot        = null;
const ctReachable   = new Set();

if (DIRECTION === "bottom-up") {
  FRAMES.forEach(f => { ctChildrenOf[f.n] = []; });
  // Pass 1 — execution-direct callers. For each frame f, f.callers[last]
  // is the frame that CALLED f in execution; in caller-tree it becomes
  // f's CHILD. These render FIRST under each parent (canonical path).
  FRAMES.forEach(f => {
    const directCaller = (f.callers && f.callers.length) ? f.callers[f.callers.length - 1] : -1;
    if (directCaller !== -1 && ctChildrenOf[f.n] && FRAMES_BY_N[directCaller]) {
      ctChildrenOf[f.n].push(directCaller);
    }
  });
  // Pass 2 — convergesTo callers (fan-in). Appended AFTER direct callers
  // so the canonical execution path renders first under each parent and
  // alternative entry points (retry job, sibling controller, etc.) follow.
  FRAMES.forEach(f => {
    if (typeof f.convergesTo === "number" && ctChildrenOf[f.convergesTo]) {
      ctChildrenOf[f.convergesTo].push(f.n);
    }
  });

  // pick a root: TRACE.callerTreeRoot > jumpTarget.n > last frame
  if (typeof TRACE.callerTreeRoot === "number" && FRAMES_BY_N[TRACE.callerTreeRoot]) {
    ctRoot = TRACE.callerTreeRoot;
  } else if (TRACE.jumpTarget && typeof TRACE.jumpTarget.n === "number" && FRAMES_BY_N[TRACE.jumpTarget.n]) {
    ctRoot = TRACE.jumpTarget.n;
  } else if (FRAMES.length) {
    ctRoot = FRAMES[FRAMES.length - 1].n;
  }

  // BFS to build parent chains + reachability set
  if (ctRoot !== null) {
    ctParentChain[ctRoot] = [];
    ctReachable.add(ctRoot);
    const queue = [ctRoot];
    while (queue.length) {
      const n = queue.shift();
      const chain = ctParentChain[n];
      (ctChildrenOf[n] || []).forEach(c => {
        if (ctReachable.has(c)) return;
        ctParentChain[c] = chain.concat([n]);
        ctReachable.add(c);
        queue.push(c);
      });
    }
  }
}

// ── render order (DFS for caller-tree, sequential for top-down) ─
function buildRenderOrder() {
  if (DIRECTION !== "bottom-up" || ctRoot === null) {
    return FRAMES.slice();
  }
  const out = [];
  const seen = new Set();
  function dfs(n) {
    if (seen.has(n) || !FRAMES_BY_N[n]) return;
    seen.add(n);
    out.push(FRAMES_BY_N[n]);
    (ctChildrenOf[n] || []).forEach(dfs);
  }
  dfs(ctRoot);
  return out;
}
const RENDER_ORDER = buildRenderOrder();

function laneClassesFor(f) {
  // pick the chain + sibling map for the active direction
  const chain  = (DIRECTION === "bottom-up")
    ? (ctParentChain[f.n] || [])
    : (f.callers || []);
  const sibsAt = (DIRECTION === "bottom-up") ? ctChildrenOf : childrenOf;
  const D = chain.length;
  const out = [];
  for (let i = 0; i < D; i++) {
    const ancestorIdx = chain[i];
    const branchIdx   = (i < D - 1) ? chain[i + 1] : f.n;
    const siblings    = sibsAt[ancestorIdx] || [];
    const isLast      = siblings[siblings.length - 1] === branchIdx;
    if (i === D - 1) out.push(isLast ? "l" : "t");
    else              out.push(isLast ? "e" : "v");
  }
  return out;
}

function specialsHtml(f) {
  if (!Array.isArray(f.special) || !f.special.length) return "";
  return `<span class="specials">${f.special.map(s => {
    const glyph = SPECIAL_GLYPHS[s.name] || "•";
    const title = s.title ? ` title="${s.title.replace(/"/g, "&quot;")}"` : "";
    const val   = s.value ? `<span>${s.value}</span>` : "";
    return `<span class="special-badge ${s.name}"${title}>${glyph}${val}</span>`;
  }).join("")}</span>`;
}

// ── render rows + detail panes ────────────────────────────────
const root = document.getElementById("frames");
root.dataset.direction = DIRECTION;

// Sticky column header — gives the reader a drag handle to resize
// the function-name column. The 6px slot it lives in is mirrored as
// .col-spacer in every row so the grid stays aligned.
const colHead = document.createElement("div");
colHead.className = "col-head";
colHead.innerHTML = `
  <span></span>
  <span class="col-h">#</span>
  <span class="col-h">function</span>
  <span class="col-resize" title="Drag to resize the function-name column"></span>
  <span class="col-h">location</span>
  <span class="col-h">tag</span>
`;
root.appendChild(colHead);

RENDER_ORDER.forEach(f => {
  const lanes = laneClassesFor(f);
  const hasChildren = (DIRECTION === "bottom-up")
    ? (ctChildrenOf[f.n] || []).length > 0
    : (childrenOf[f.n] || []).length > 0;
  const hasChange   = Array.isArray(f.changes) && f.changes.length > 0;

  const row = document.createElement("div");
  row.className = "row" + (hasChange ? " has-change" : "");
  row.dataset.n    = f.n;
  row.dataset.kind = f.kind || "";
  if (hasSpecial(f, "conditional")) row.dataset.conditional = "true";
  if (PATHS.length) row.dataset.paths = framePathIds(f).join(" ");
  const ideRefDef = (f.href || "").replace(/#L(\d+)/, ":$1");
  // call-site: explicit calledFromHref if given; else fall back to immediate parent's href
  let callHref = f.calledFromHref || "";
  if (!callHref && Array.isArray(f.callers) && f.callers.length) {
    const parent = FRAMES_BY_N[f.callers[f.callers.length - 1]];
    if (parent) callHref = parent.href || "";
  }
  const ideRefCall = callHref ? callHref.replace(/#L(\d+)/, ":$1") : "";
  const callBtnHtml = ideRefCall
    ? `<button class="copy-btn call-site" title="Copy call site: ${ideRefCall}" data-copy="${ideRefCall}"></button>`
    : "";
  // hide ⎘ definition button when the frame is an unexplored stub —
  // its file/href is conceptually a call-site placeholder, so the two
  // buttons would copy the same thing.
  const showDefBtn = !hasSpecial(f, "unexplored");
  const defBtnHtml = showDefBtn
    ? `<button class="copy-btn" title="Copy definition: ${ideRefDef}" data-copy="${ideRefDef}"></button>`
    : "";
  const fnNameAttr = (f.fn || "").replace(/"/g, "&quot;");
  row.innerHTML = `
    <button class="chev ${hasChildren ? "" : "empty"}" data-n="${f.n}" title="${hasChildren ? "collapse / expand children" : ""}"></button>
    <span class="num">#${String(f.n).padStart(2,"0")}</span>
    <span class="fn-wrap">
      <span class="lanes">${lanes.map(c => `<span class="lane-cell ${c}"></span>`).join("")}</span>
      <span class="dot ${f.kind}"></span>
      <span class="fn-name" title="${fnNameAttr}">${f.fn}</span>
      ${specialsHtml(f)}
    </span>
    <span class="col-spacer"></span>
    <span class="file">
      ${callBtnHtml}
      ${defBtnHtml}
      <a href="${f.href || "#"}" onclick="event.stopPropagation()">${f.file || ""}</a>
    </span>
    <span class="tag ${f.kind}">${f.tag || ""}</span>
  `;
  root.appendChild(row);

  const trail = [...(f.callers || []), f.n]
    .map(i => i === f.n
      ? `<span class="me">#${String(i).padStart(2,"0")} ${FRAMES_BY_N[i].fn}</span>`
      : `#${String(i).padStart(2,"0")} ${FRAMES_BY_N[i].fn}`
    ).join(" → ");

  const convergeNote = (typeof f.convergesTo === "number" && FRAMES_BY_N[f.convergesTo])
    ? `<div class="called-by">converges into: #${String(f.convergesTo).padStart(2,"0")} ${FRAMES_BY_N[f.convergesTo].fn}</div>`
    : "";

  const changesHtml = hasChange
    ? `<div class="changes-block">
         <div class="changes-title">Changes at this frame</div>
         ${f.changes.map(c => `
           <div class="change-row">
             <span class="var">${c.var}</span>
             <span class="arrow">→</span>
             <span class="val ${c.kind || ""}">${c.value}</span>
             ${c.note ? `<span class="note">${c.note}</span>` : ""}
           </div>`).join("")}
       </div>`
    : "";

  // Per-path outcomes block — shows what happened on each path for
  // this same frame (test vs prod, happy vs bug, etc.). Only renders
  // when the trace declares paths AND this frame has pathOutcomes.
  let pathOutcomesHtml = "";
  if (PATHS.length && f.pathOutcomes && typeof f.pathOutcomes === "object") {
    const rows = PATHS.map(p => {
      const outcome = f.pathOutcomes[p.id];
      if (outcome === undefined || outcome === null || outcome === "") return "";
      return `<div class="path-outcome-row" data-path="${p.id}">
        <span class="path-pill">${p.label || p.id}</span>
        <span class="path-outcome-text">${outcome}</span>
      </div>`;
    }).filter(Boolean).join("");
    if (rows) {
      pathOutcomesHtml = `<div class="path-outcomes-block">
        <div class="path-outcomes-title">Per-path outcomes</div>
        ${rows}
      </div>`;
    }
  }

  const detail = document.createElement("div");
  detail.className = "detail hidden";
  detail.dataset.n = f.n;
  detail.innerHTML = `
    <div class="detail-inner">
      <div class="called-by">called by: ${trail}</div>
      ${convergeNote}
      ${changesHtml}
      ${pathOutcomesHtml}
      <p>${f.desc || ""}</p>
      ${f.extra || ""}
      <div class="grid">
        <div class="panel"><div class="panel-head">code</div><pre>${f.code || ""}</pre></div>
        <div class="panel"><div class="panel-head">${f.pLabel || "$params"}</div><pre>${f.p || ""}</pre></div>
      </div>
    </div>
  `;
  root.appendChild(detail);
});

// ── WATCH panel render ────────────────────────────────────────
function renderWatchPanel() {
  if (!WATCH.length) return;
  const panel = document.getElementById("watch-panel");
  const body  = document.getElementById("watch-body");
  panel.classList.remove("hidden");
  body.innerHTML = "";
  WATCH.forEach(w => {
    const steps = [];
    FRAMES.forEach(f => {
      if (!Array.isArray(f.changes)) return;
      f.changes.forEach(c => { if (c.var === w.name) steps.push({ n: f.n, ...c }); });
    });
    const stepsHtml = steps.map(s => `
      <span class="watch-step ${s.kind || ""}" onclick="jumpTo(${s.n})">
        <span class="stepn">#${String(s.n).padStart(2,"0")}</span>
        <span class="arrow">→</span>
        <span class="stepv">${s.value}</span>
        ${s.note ? `<span class="note">${s.note}</span>` : ""}
      </span>
    `).join("");
    const row = document.createElement("div");
    row.className = "watch-var";
    row.innerHTML = `
      <div class="watch-var-label">
        ${w.label || w.name}
        <span class="initial">initial: ${w.initial || "(unset)"}</span>
      </div>
      <div class="watch-timeline">${stepsHtml || `<span class="watch-step" style="cursor:default"><span class="stepv">${w.initial || "(no changes)"}</span></span>`}</div>
    `;
    body.appendChild(row);
  });
}

// ── filter chips ──────────────────────────────────────────────
// Only show chips for kinds with a defined color — built-ins or
// trace-declared custom kinds (TRACE.kinds). Undeclared custom kinds
// don't get chips (they render neutral grey in the rows).
function renderFilterChips() {
  const wrap = document.getElementById("filter-chips");
  const counts = {};
  FRAMES.forEach(f => {
    if (!COLORED_KINDS.has(f.kind)) return;
    counts[f.kind] = (counts[f.kind] || 0) + 1;
  });
  const kinds = Object.keys(counts).sort();
  if (!kinds.length) { document.getElementById("filters").classList.add("hidden"); return; }
  wrap.innerHTML = kinds.map(k => {
    const label = (CUSTOM_KINDS[k] && CUSTOM_KINDS[k].label) || k;
    return `
      <button class="chip ${k}" data-kind="${k}" onclick="toggleKind('${k}')">
        <span class="chip-dot"></span><span>${label}</span><span class="chip-count">${counts[k]}</span>
      </button>`;
  }).join("");
}

// ── state ─────────────────────────────────────────────────────
const collapsed   = new Set();
const open        = new Set();
const hiddenKinds = new Set();
let currentView   = "full";
// Path filter: "__all__" shows every path's frames (default).
// Selecting a path id hides frames whose pathIds don't include it.
let currentPath   = "__all__";

function inCurrentView(n) {
  if (currentView === "short" && !SHORT_PATH.includes(n)) return false;
  // In bottom-up, only frames reachable from the caller-tree root render.
  if (DIRECTION === "bottom-up" && !ctReachable.has(n))   return false;
  return true;
}
function inCurrentPath(n) {
  if (!PATHS.length || currentPath === "__all__") return true;
  const f = FRAMES_BY_N[n];
  if (!f) return false;
  return framePathIds(f).includes(currentPath);
}
function isHiddenByAncestor(n) {
  const chain = (DIRECTION === "bottom-up")
    ? (ctParentChain[n] || [])
    : (FRAMES_BY_N[n].callers || []);
  return chain.some(c => collapsed.has(c));
}

function applyState() {
  document.querySelectorAll(".row").forEach(row => {
    const n    = +row.dataset.n;
    const kind = row.dataset.kind;
    let hidden = false;
    if (!inCurrentView(n))                                 hidden = true;
    if (!inCurrentPath(n))                                 hidden = true;
    if (isHiddenByAncestor(n))                             hidden = true;
    if (currentView === "full" && hiddenKinds.has(kind))   hidden = true;
    row.classList.toggle("hidden", hidden);
    row.classList.toggle("subtree-collapsed", collapsed.has(n));
    row.classList.toggle("detail-open", open.has(n) && !hidden);
  });
  document.querySelectorAll(".detail").forEach(d => {
    const n     = +d.dataset.n;
    const kind  = FRAMES_BY_N[n].kind;
    let hidden  = !open.has(n);
    if (!inCurrentView(n))                                 hidden = true;
    if (!inCurrentPath(n))                                 hidden = true;
    if (isHiddenByAncestor(n))                             hidden = true;
    if (currentView === "full" && hiddenKinds.has(kind))   hidden = true;
    d.classList.toggle("hidden", hidden);
  });
  document.getElementById("filters").classList.toggle("hidden", currentView === "short");
  document.querySelectorAll("#view-toggle button").forEach(b => {
    b.classList.toggle("active", b.dataset.view === currentView);
  });
  document.querySelectorAll("#path-toggle button").forEach(b => {
    b.classList.toggle("active", b.dataset.path === currentPath);
  });
  document.querySelectorAll(".chip").forEach(c => {
    c.classList.toggle("off", hiddenKinds.has(c.dataset.kind));
  });
}

function setPath(id) { currentPath = id; applyState(); }

// Build the path-toggle control inside the ctrl bar
(function renderPathToggle() {
  if (!PATHS.length) return;
  const ctrl = document.querySelector(".ctrl");
  if (!ctrl) return;
  const divider = document.createElement("span");
  divider.className = "divider";
  const label = document.createElement("strong");
  label.textContent = "Path";
  const toggle = document.createElement("div");
  toggle.className = "path-toggle";
  toggle.id = "path-toggle";
  toggle.innerHTML = [
    `<button data-path="__all__" class="active" onclick="setPath('__all__')">All</button>`,
    ...PATHS.map(p => {
      const lbl = (p.label || p.id).replace(/"/g, "&quot;");
      return `<button data-path="${p.id}" onclick="setPath('${p.id}')"><span class="path-dot"></span>${lbl}</button>`;
    })
  ].join("");
  ctrl.appendChild(divider);
  ctrl.appendChild(label);
  ctrl.appendChild(toggle);
})();

// ── events ────────────────────────────────────────────────────
document.querySelectorAll(".chev").forEach(c => {
  c.addEventListener("click", e => {
    e.stopPropagation();
    const n = +c.dataset.n;
    if (collapsed.has(n)) collapsed.delete(n); else collapsed.add(n);
    applyState();
  });
});
document.addEventListener("click", e => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  e.stopPropagation();
  navigator.clipboard.writeText(btn.dataset.copy || "");
  btn.classList.add("copied");
  setTimeout(() => btn.classList.remove("copied"), 900);
});
document.querySelectorAll(".row").forEach(row => {
  row.addEventListener("click", e => {
    if (e.target.closest(".chev") || e.target.closest("a") || e.target.closest(".copy-btn")) return;
    const n = +row.dataset.n;
    if (open.has(n)) open.delete(n); else open.add(n);
    applyState();
  });
});

// ── control actions (also referenced from inline onclicks) ────
function setSubtree(collapseAll) {
  collapsed.clear();
  if (collapseAll) {
    const kidsMap = (DIRECTION === "bottom-up") ? ctChildrenOf : childrenOf;
    FRAMES.forEach(f => { if ((kidsMap[f.n] || []).length) collapsed.add(f.n); });
  }
  applyState();
}
function setDetails(openAll) {
  open.clear();
  if (openAll) FRAMES.forEach(f => open.add(f.n));
  applyState();
}
function setView(mode) { currentView = mode; applyState(); }
function toggleKind(k) {
  if (hiddenKinds.has(k)) hiddenKinds.delete(k); else hiddenKinds.add(k);
  applyState();
}
function jumpTo(n) {
  const chain = (DIRECTION === "bottom-up")
    ? (ctParentChain[n] || [])
    : (FRAMES_BY_N[n].callers || []);
  chain.forEach(c => collapsed.delete(c));
  if (currentView === "short" && !SHORT_PATH.includes(n)) currentView = "full";
  if (hiddenKinds.has(FRAMES_BY_N[n].kind)) hiddenKinds.delete(FRAMES_BY_N[n].kind);
  open.clear();
  open.add(n);
  applyState();
  const row = document.querySelector(`.row[data-n="${n}"]`);
  if (row) row.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── column resize drag ────────────────────────────────────────
// Drag the handle in .col-head to resize the function-name column.
// We rewrite a CSS variable (--fn-col) on the frames container; both
// the header and every row reference it via grid-template-columns,
// so all stay in sync. Min 200px, max 70vw.
(function wireColResize() {
  const handle = colHead.querySelector(".col-resize");
  if (!handle) return;
  let resizing = null;
  handle.addEventListener("mousedown", e => {
    e.preventDefault();
    const fnWrap = document.querySelector(".frames .row .fn-wrap");
    const startWidth = fnWrap ? fnWrap.getBoundingClientRect().width : 400;
    resizing = { startX: e.clientX, startWidth };
    handle.classList.add("dragging");
    document.body.classList.add("col-resizing");
  });
  document.addEventListener("mousemove", e => {
    if (!resizing) return;
    const dx = e.clientX - resizing.startX;
    const max = window.innerWidth * 0.7;
    const next = Math.max(200, Math.min(max, resizing.startWidth + dx));
    root.style.setProperty("--fn-col", next + "px");
  });
  document.addEventListener("mouseup", () => {
    if (!resizing) return;
    handle.classList.remove("dragging");
    document.body.classList.remove("col-resizing");
    resizing = null;
  });
})();

// ── jump button binding ───────────────────────────────────────
if (TRACE.jumpTarget && typeof TRACE.jumpTarget.n === "number") {
  document.getElementById("jump-btn").addEventListener("click", () => jumpTo(TRACE.jumpTarget.n));
}

// ── bootstrap ─────────────────────────────────────────────────
renderWatchPanel();
renderFilterChips();
if (SHORT_PATH.length) document.getElementById("view-toggle").classList.remove("hidden");
applyState();
