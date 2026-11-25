# Third-party notices

diagram-compiler is MIT licensed (see `LICENSE`). It uses the following third-party work.

## Bundled in this repository

| Work | Where | Licence |
| --- | --- | --- |
| IBM Plex Sans and IBM Plex Mono (font files) | `plugins/diagram-compiler/fonts/` | SIL Open Font License 1.1, full text in `plugins/diagram-compiler/fonts/OFL.txt` |

## Installed from npm, not bundled

These are declared in `plugins/diagram-compiler/package.json` and fetched from the npm registry when the plugin is
installed. They are used unmodified.

| Package | Used for | Licence |
| --- | --- | --- |
| `elkjs` | placing boxes in flow diagrams | EPL-2.0 OR GPL-3.0-or-later |
| `@resvg/resvg-js` | turning SVG into PNG | MPL-2.0 |
| `opentype.js` | measuring text and drawing glyph outlines | MIT |
| `@iconify-json/lucide` | icon shapes (Lucide) | ISC |
| `zod` | validating the diagram description | MIT |
