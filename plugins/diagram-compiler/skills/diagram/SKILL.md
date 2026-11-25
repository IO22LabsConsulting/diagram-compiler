---
name: diagram
description: Draw and keep current publication-quality technical diagrams of a prompt, document or codebase (architecture flow, sequence of calls, mind map, tree, panel grid, comparison table) as SVG + PNG, check that what they show is really in the code, and update them after code changes by reading only what changed. Use when asked for a diagram, to update or refresh diagrams, architecture picture, sequence diagram, explainer infographic, mind map, org/tree chart, comparison table or "draw how this works".
---

# diagram

You write a **Diagram Spec** (JSON: structure and text only, never coordinates). The `diagram` CLI
does layout, rendering and lint deterministically. You never edit the SVG; you edit the spec and re-run.

CLI: `diagram <command>`. The command is on the PATH while this plugin is enabled; if it is not found, run
`node "${CLAUDE_PLUGIN_ROOT}/bin/diagram" <command>`. It needs Node 22.18 or newer. Output files take the spec file's name.

## Workflow

1. **Pick a `diagram_type`.** Ask one question only if it is genuinely ambiguous.
   - `flow`: things connected by arrows (architecture, pipeline, request path, state changes).
   - `sequence`: who calls whom, in order (a request end to end, a login, an order from click to confirmation). Use it when
     the order of events is the point; a flow shows what is connected, not what happens first.
   - `mindmap`: one topic fanning out into branches (overview, taxonomy, "parts of X"). Landscape by nature: not for portrait canvases.
   - `tree`: strict top-down hierarchy (org chart, module tree, decision breakdown). Three or more leaves hang in a column under their parent.
   - `grid`: 2-12 numbered panels, each a small flow/mindmap/tree and/or bullets ("top N", a system told in parts).
   - `table`: rows by columns, for things that answer the same questions (options compared, every X with its trigger,
     effect and undo). If you are about to write panels whose bullets all start "Trigger:", "Effect:", use a table.
2. **Read the example** for that type: `diagram schema --type <type> --example` prints a working example
   (drop `--example` to also get the full JSON Schema; the cheat sheet below is usually enough).
3. **Draft the spec** to a file. Rules that make diagrams good:
   - Labels of 5 words or fewer. Put detail in `sublabel` or `bullets`, not the label.
   - At most ~12 nodes per flow. More than that: use a `grid` with one idea per panel.
   - One story per diagram, told in spec order. Node order is a layout lever, not only reading order: list nodes in the
     order the flow runs (sources first, sinks last) and nodes that talk to each other next to each other. It is a
     preference, not a guarantee: the compiler may swap neighbours when that removes a crossing.
   - A large system is several diagrams, not one. Past ~15 edges a flow starts crossing itself; split it by question
     ("how does a request get in", "what happens after") rather than adding groups.
   - In a flow with more than ~6 nodes, put them in 2-4 `groups` (layers, owners, stages). Groups let the compiler try
     band layouts (groups stacked one way, members laid out the other way), which is how a 12-node flow fits a slide
     or a post instead of becoming a strip. With three or more groups it can also wrap them two or three to a row.
     More than 5 groups, or many edges that jump over a group, weakens this.
   - An edge that points back upstream (retry, feedback, a callback to an earlier stage) should be `kind: "loop"`.
     Unmarked back-edges are the usual cause of an edge circling the whole diagram.
   - Plain ASCII/Latin text only in everything that is drawn (no emoji, no CJK): paraphrase non-Latin interface text.
     Names of files, functions, routes and placeholders such as `<id>` are fine as labels; whole URLs, markup and
     shell commands are not (`label.suspicious`).
   - Drawing a codebase or a document set: give every element a `source` (see "Sources" below) as you write it, from
     the file you are looking at. Do not add sources afterwards from memory.
4. `diagram validate spec.json`, fix every error (each names a JSON path).
5. `diagram render spec.json -o out/` (add `--root <repo dir> --strict` when the spec has sources) writes `out/<name>.svg` and `.png` (overwriting earlier renders) and prints the lint report.
   Exit code 2 means lint errors: apply each finding's `fix` to the **spec** and re-render until `"ok": true`.
   Warnings are advice; fix them when the fix is cheap.
6. **Look at the PNG** against `rubric.md` (next to this file, `${CLAUDE_SKILL_DIR}/rubric.md`). If it fails the rubric, edit the spec and re-render.
   At most 3 re-renders after the first, per diagram; if none passes, deliver the best one and say which rubric item it misses.
7. Deliver the PNG, the SVG and the spec file.

Exit codes: 0 ok, 1 invalid spec, 2 lint errors, 3 render failure. Errors arrive as JSON on stderr.

## Spec cheat sheet

Every spec: `spec_version: "1.0"`, `diagram_type`, `title` (max 80), optional `subtitle` (140), `footer` (160),
`theme` (`clean-light` default, `clean-dark`), `canvas.aspect` (`auto` default, `4:5`, `1:1`, `16:9`, `A4`).
The compiler tries several layouts and keeps the one that best fits the aspect; it never shrinks text, so a diagram
that cannot reach the aspect is padded and lint says so (`density.canvas`), naming the aspect the content is closer to.
With `auto` it aims for a shape between square and widescreen.
Optional `scope`: a list of up to 20 folders or files, relative to the repository root, that the diagram is meant to
cover (`"scope": ["lib/billing", "config/prod.exs"]`); never drawn, used when updating (see "Keeping diagrams current").
Unknown keys are errors. Ids: start with a letter; letters, digits, `_`, `-`.

### flow

```json
{
  "spec_version": "1.0", "diagram_type": "flow", "title": "...",
  "nodes": [{ "id": "api", "kind": "box", "label": "API", "sublabel": "optional", "bullets": ["optional"], "icon": "server", "emphasis": "secondary", "color": "blue" }],
  "edges": [{ "from": "api", "to": "db", "label": "optional", "style": "solid", "arrow": "end", "kind": "flow" }],
  "groups": [{ "id": "backend", "label": "Backend", "members": ["api", "db"], "style": "dashed-box", "color": "blue" }],
  "annotations": [{ "target": "api", "text": "A short side note" }],
  "hints": { "direction": "LR" }
}
```

- node `kind`: `box` (default), `icon` (icon tile with label under it), `store` (cylinder: databases, queues, files),
  `actor` (pill: people, external systems, callers; no icon unless you set one, e.g. `user` or `external`), `model` (green sparkle icon: LLMs and ML models), `note` (dashed aside), `chip` (small pill: inputs, outputs, tags).
- node limits: `label` 40 chars, `sublabel` 60, `bullets` up to 6 of 48 chars.
- `emphasis`: `primary` (solid fill in the node's `color`, green if none; use for the one node that matters most, once per diagram),
  `secondary` (default), `muted` (greyed: planned, optional or out-of-scope things).
- `color` (nodes, groups, panels, branches): `green`, `blue`, `amber`, `pink`, `violet`, `cyan`. Use colour to mean something (one colour per layer or owner), not to decorate.
- edge `style`: `solid`, `dashed`, `dotted`. `arrow`: `end`, `both`, `none`. Edge `label` max 28 chars; one or two words place best, and a long label may be split onto two lines.
- edge `kind`: `flow` (default), `loop` (a feedback edge that points back upstream: it will not reorder the layout), `async` (open arrowhead).
- `from`/`to` may be node ids or group ids. `groups[].members` may be node ids or other group ids; a node belongs to at most one group.
- group `style`: `dashed-box` (outline), `filled` (tinted area), `lane` (plain band).
- `annotations` draw a dashed note tied to its target by a thin dotted line (`text` max 80 chars). Use at most one or two.
- `hints.direction`: `LR` or `TB` forces the flow direction (the render is unchanged if that is what it already chose). Normally omit it: the compiler then tries both, plus band
  layouts, and keeps the best. Only set it when the first render reads the wrong way.
- A decision is a node whose label is a question with labelled outgoing edges (`yes` / `no`). Keep edge labels to 1-3 words.
- A single-member group is fine when it marks a boundary (a sandbox, a third party).
- A request and its reply between the same two nodes read best as one edge with `arrow: "both"`, not two edges.
- When many nodes all talk to one thing (a database, an escalation sink, a log), connect their group to it once
  (`from` a group id) instead of drawing one edge per node.

### mindmap and tree

```json
{ "spec_version": "1.0", "diagram_type": "mindmap", "title": "...",
  "root": { "label": "Topic", "icon": "lightbulb", "children": [
    { "label": "Branch", "sublabel": "optional", "color": "blue", "children": [{ "label": "Leaf" }] } ] } }
```

A branch has `label` (40 chars), optional `sublabel` (60), `icon`, `color` and `children` (no bullets, no emphasis). Branches nest up to
4 levels below the root, 12 children each. `mindmap` places branches clockwise from the top right in spec order and colours each first-level branch
automatically (the six colours repeat after six branches, so prefer 4-6 branches); `tree` is top-down and only coloured
where you set `color` (children inherit).

### grid

```json
{ "spec_version": "1.0", "diagram_type": "grid", "title": "...", "columns": 2,
  "panels": [
    { "id": "p1", "title": "Panel title", "badge": "1", "caption": "One sentence.", "bullets": ["optional"],
      "diagram": { "diagram_type": "flow", "nodes": [], "edges": [], "hints": { "direction": "LR" } } } ] }
```

`columns` 1-4 is optional: omit it and the compiler picks the count that best fits the canvas. Up to 12 panels.
Panels are neutral with a green badge; set a panel `color` only when colour means something. A panel needs `diagram`, `bullets`, or both. The `caption` is one sentence shown under the panel title. `annotations` also work in panel flows. `diagram` is a flow, mindmap or tree body
(same fields as above, without the document fields). Keep panel flows to 2-5 nodes; ids only need to be unique inside their own panel.

### sequence

```json
{ "spec_version": "1.0", "diagram_type": "sequence", "title": "...",
  "actors": [{ "id": "web", "label": "Web app", "sublabel": "optional", "kind": "box", "icon": "server", "color": "blue" }],
  "steps": [
    { "from": "user", "to": "web", "label": "Place order", "detail": "optional second line", "kind": "call" },
    { "divider": "Money" },
    { "from": "web", "to": "web", "label": "Check the basket" } ] }
```

2-8 `actors`, drawn left to right in spec order (`kind`: `box`, `actor`, `store`, `model`; label 28 chars, sublabel 40).
Up to 40 `steps`, drawn top to bottom in spec order and numbered. A step is a message (`from`, `to`, `label` 48 chars,
optional `detail` 64) or `{ "divider": "..." }`, a titled rule that starts a new phase or an alternative ("If the
charge fails"); a divider cannot carry a source, so keep its text a heading, not a claim. Message `kind`: `call` (default,
solid), `reply` (dashed), `async` (open arrowhead: sent and not waited on). `from` equal to `to` is something an actor
does by itself. Put actors in the order they first appear so most arrows point right; past ~15 steps, split the
story at a divider into two diagrams. Say what dashed and open arrows mean in the `footer`. A step has one sender
and one receiver: draw a hop through a message bus as an `async` arrow to whoever picks it up.

### table

```json
{ "spec_version": "1.0", "diagram_type": "table", "title": "...",
  "columns": ["Mechanism", "Trigger", "Effect", "Undo"],
  "rows": [{ "cells": ["Pause", "Any engineer", "New releases only", "Press resume"], "color": "green" }] }
```

2-7 `columns` (header text, 28 chars each) and 1-24 `rows`. Every row has one cell per column; the first cell names the
row, is drawn bold and cannot be empty; the rest may be `""`. Cells are plain text: a phrase, not a paragraph. A cell
holds up to 140 chars and wraps to about 6 lines; text beyond that is cut and reported as `overflow.text`. Column
widths are chosen for you and the table stays under about 1120px wide, so with 6-7 columns keep cells short.
`canvas.aspect` does not reshape a table; leave it on `auto`. Row `color` tints the row name only: use it to mark kinds of row and say what the colours mean in the
subtitle. A table has no arrows; when relationships matter, use a flow.

## Sources

Any node, edge, branch, panel, table row, actor or step may say where it comes from (groups, annotations, titles and
footers cannot, so keep checkable claims out of them):

```json
{ "id": "billing", "label": "Billing", "source": { "file": "src/billing/charge.py", "line": 42, "text": "def charge_card(" } }
```

`file` is a path relative to the repository root. `line` and `text` are optional but make the check worth having:
always give both for a text file. `text` is a fragment copied exactly from that line (one line, 2-120 chars; runs of
whitespace count as one space; any characters are allowed here, including non-Latin ones; ordinary JSON escaping is
all it needs). The text must be on the cited line or within 10 lines of it.
`source` may also be a list of up to 8: a table row usually needs one per cell that makes a claim.
Sources are never drawn. Check them with `diagram verify spec.json --root <repo dir>`, or pass `--root` to `render`
so the findings arrive with the lint report:

- `source.missing-file`, `source.line-out-of-range`, `source.text-not-found`, `source.outside-root` are errors: the
  citation is wrong. Open the file and fix the citation, or remove the element. Never invent a path to clear it.
- `source.not-a-file` and `source.binary` are errors: a folder was cited, or a line or quote was given for a file that
  is not text (a spreadsheet, an image). Cite a binary file by path alone and claim nothing about its contents.
- `source.moved` is a warning: the quoted text is in the file but more than 10 lines from the cited line; the fix
  gives the line.
- `source.order` is info, on sequences: a step cites an earlier line of the same file than the step before it. The
  check cannot know the order code runs in, so look again; a helper defined above its caller is a false alarm.
- `source.uncited` lists elements with no source. It is a warning, or an error with `--strict`.

With `--root`, the output has `sources: { elements, cited, citations, distinct }`: how many elements could cite, how
many did, how many citations were checked, and how many different places they point to. A table row is one element
however many cells it has, so cite each cell that makes a claim.

What to cite when there is no obvious line:
- a person or outside system: the entry point they trigger (the button, the route, the command definition);
- a link that exists only in configuration or a build file: that file, and say "configured" in the label;
- a statement spread over several lines (a multi-line import): the line that carries the name, plus a second source;
- a call that crosses languages or processes: one source on each side, then compare them yourself (method, path,
  argument names): the check does not, and a mismatch there is a real bug worth reporting;
- several branches of a decorator or macro that look identical: the definition line beneath it.

Never quote a secret. If a line you would cite holds a key, token or password, cite the line number only and tell
the user the file contains one.

An absence ("nothing notifies the user") cannot be cited. Say it in the subtitle or footer, worded as what you
looked for and did not find, and cite the code path where it would have been on the nearest element.

The check proves the cited line exists and contains the words you quoted. It does not prove your label is a fair
summary of that line: rubric item 7 (Truth) is still yours to answer.

## Keeping diagrams current

A diagram with sources can be brought up to date after the code changes without reading the code again. Do the
full read once; after that, read only what the tool points at.

**First pass, once per diagram.** Draw it with a source on every element, set `"scope": ["path/to/area", ...]` at the
top of the spec (the folders this diagram is meant to cover; default: the folders of the cited files), get
`render --root <repo> --strict` clean, then:

`diagram stamp spec.json --root <repo>` writes `spec.lock.json` beside it: the commit and a fingerprint of every cited
and in-scope file. Keep specs and locks together (for example `docs/diagrams/`), under version control.

Keep `scope` narrow: every edit inside it that nothing cites comes back later as something to read. Name single files
when a cited file sits in a large folder; a scope of a few dozen files is narrow, a few hundred is not. A cited file is
tracked whether or not it is inside the scope; scope entries may overlap. The stamp describes the repository, not the
spec: changing a label or footer needs no new stamp, changing or adding a source does (render, then stamp).

**Every later pass.** `diagram stale <spec.json or folder> --root <repo> --fix` reports, per diagram:

- `status: "fresh"`: nothing it cites or covers changed. Stop; read nothing.
- `fixes`: citations whose quoted words moved to another line or a renamed file. `--fix` rewrites them in the spec
  and, if that is all there was, moves the stamp forward. Nothing to read.
- `reread`: places to read. Each names the element, a `reason`, and `read`: line ranges in the file as it is now.
  `text-gone` (the quoted words are no longer there), `text-moved-ambiguous` (the words now appear in several
  places, listed in `read`: open them and cite the one that does what the element says), `line-changed`, `file-gone`, `block-changed` (the cited line
  survives but its block was edited: the function a cited call sits in, the scope a cited route sits in, the body a
  cited definition opens) and `callee-changed` (a function that block calls, named in `via`, was edited). `no-longer-used`: the cited
  function (in `via`) is still there but nothing in the tracked files mentions it any more; find what replaced it
  (usually in the `new_in_scope` or `new_definitions` items) and re-point or remove the element. For `callee-changed`
  read the whole of that function, not only the edited line: the range says where it changed, not what it does.
- `new_in_scope`: files added or edited inside the diagram's scope that no element cites, and edits to cited prose
  or config files outside the cited lines. An added file carries a `preview` of its first lines: decide from its
  path and preview whether it could belong in this diagram, and skip it if not. Otherwise read the given ranges and
  decide whether the diagram needs a new element; most edits do not.
- `removed_in_scope`: uncited files in the scope that were deleted. If the diagram counts or lists things of that
  kind ("11 of the 27 commands"), re-check the count.
- `new_definitions`: functions added or rewritten in files the diagram cites, outside every cited block, each given
  as its own signature line. Judge each from that line; open it only if it could belong in the diagram.
- `read_plan`: all of the above ranges merged per file, with the elements each concerns. Read from this list, once.
- `elsewhere_in_cited_files`: other edits in cited files. Advice only; skim them if the diagram claims to list
  everything of a kind (every route, every command) and nothing above already covers that file.
- `unstamped`: files a source points at that the stamp does not cover, because the source was added after the last
  stamp. Nothing to read: render with `--root --strict` and stamp again.
- `lines_to_read`: the size of the job.

Then, for a diagram that needs review:

1. Read the ranges in `read_plan` (a few lines of context either side is fine), each once. Do not re-read whole
   files, and do not read files that are not listed. A range may matter to an element other than the one it is
   listed under: when you see that, update that element too.
2. For each `reread` item decide: the element is still right (re-quote a line that is there now), it changed (edit
   its label, detail or edges, and its source), or it no longer exists (remove it and anything that only it
   connected). For each `new_in_scope` item decide: nothing to draw, or add an element with a source.
3. `diagram render spec.json -o out/ --root <repo> --strict`, fix findings, and look at the PNG if you changed
   anything that is drawn (not needed when only sources changed). If the change removed the diagram's premise (its
   title or subtitle is no longer true), redraw that diagram from a first pass of its area and say so.
4. `diagram stamp spec.json --root <repo>`, including for a diagram you reviewed and left unchanged: the stamp is what
   records that it was checked against this state.

An update never re-reads lines that did not change, so it cannot repair a mistake the first pass made. Have a
second reader audit a diagram once after its first pass, and again now and then: for each element, open the cited
line and judge whether the label is a fair statement of the code; fix what is imprecise, then stamp.

Say in your reply what changed in each diagram and why, and what you left alone. If a `reread` item cannot be
settled from its ranges (the code moved somewhere not listed), say so and read the smallest extra piece that settles
it; never guess to make the check pass. A change that rewrote most of an area (`lines_to_read` in the thousands, or
most elements in `reread`) is a new first pass, not an update.

Exit code 4 from `stale` or `stamp` means a diagram needs review.

`advice` in the report says which of two things happened: most elements lost their source (redraw from a first
pass), or a lot of new code appeared that nothing cites (judge new files by path and new definitions by signature
before opening anything; if little of it belongs, narrow the `scope`). Stamp after the repository has at
least one commit; without a commit (or outside git) the tool still sees which files changed but not which lines, so
it asks for whole changed files to be read.

To run this after every commit, and only when the user asks for it: `diagram hook > .git/hooks/post-commit` and
`chmod +x .git/hooks/post-commit` in their repository. The hook applies the no-reading repairs at once and prints a
notice when something needs review. It starts nothing by itself. Only if the user asks for unattended updates,
generate it with `diagram hook --auto`: that version starts Claude Code in the background to do the update, and never
commits. `--dir <folder>` sets where the diagrams live (default `docs/diagrams`). Tell the user what the hook does
before installing it.

## Icons

`diagram icons --search <term>` lists names. Any Lucide name works, plus concept aliases such as
`db`, `llm`, `agent`, `api`, `queue`, `cache`, `worker`, `web`, `mobile`, `cli`, `auth`, `git`, `ci`, `deploy`, `test`, `chart`, `logs`.
An unknown icon is a lint warning and draws nothing.

## Lint rules

`overlap.node`, `overflow.text`, `overflow.label`, `contrast.text`, `text.missing-glyph`, `canvas.too-large` are errors.
`overlap.edge-node`, `overlap.edge-edge`, `overlap.edge-group`, `overlap.edge-title`, `overlap.label-edge`, `overlap.label-node`, `overlap.label-title`, `overflow.group-title`, `crossings.edge` (info for one or two crossings), `edge.detour`, `aspect.extreme`, `density.canvas` (error above 60% padding),
`icon.missing`, `label.suspicious` are warnings.
`spec.unreferenced` is info. Each finding carries `elements` and a `fix` phrased as a spec edit.
