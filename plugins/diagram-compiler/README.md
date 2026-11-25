# diagram-compiler

Draws technical diagrams with Claude Code, checks every box and arrow against the code it cites, and keeps the
diagrams current by reading only what changed.

Claude writes a short description of what to draw (boxes, arrows and words, never positions); this plugin lays it out,
draws it as SVG and PNG, and checks it. Six diagram types: flow, sequence, table, grid, tree and mind map.

## Setup

```
/plugin install diagram-compiler --marketplace ayodm/diagram-compiler
```

Needs Node 22.18 or newer. Claude Code installs the plugin's five npm dependencies when the plugin is installed.

## Use

Ask Claude for a diagram ("draw the architecture of this repo", "draw the login flow in order, with sources",
"update the diagrams in docs/diagrams"), or run `/diagram-compiler:diagram`. The `diagram` command is on the PATH
while the plugin is enabled: `diagram render spec.json -o out/`, `diagram verify spec.json --root .`,
`diagram stamp`, `diagram stale`.

Full documentation, measured results and limits: https://github.com/ayodm/diagram-compiler
