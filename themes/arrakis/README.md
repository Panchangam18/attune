# Arrakis

Arrakis is a wallpaper-derived personal desktop design system. Its core palette
is sand (`#B7A77D`), shadow (`#15140F`), blue slate (`#5E747F`), and terracotta
clay (`#AA5042`), with two darker sand shades for depth. Prussian blue remains
available as a rare cool note, not a dominant surface color.

Dark native surfaces use the sand-black shadow canvas and sand for text; light
surfaces use sand as the canvas and shadow for text. Terracotta is reserved for
decisive action, while blue slate is used only for focus and secondary status.
Adapters replace each application's known accent token families to avoid
leftover purple, green, or unrelated brand colors in the interface.

All readable interface text uses Nasalization Regular. Install the face locally
from [Typodermic](https://typodermicfonts.com/nasalization/) on each target Mac;
it is intentionally not bundled with Attune because its free desktop license
does not permit app or web embedding. The shared base leaves VS Code's `codicon`
glyphs alone so its iconography continues to render.

## Structure

- `tokens.css` defines the shared palette, typography, and rules.
- `base-layout.css` establishes common canvas, controls, selection, and focus.
- `adapters/` maps those primitives to each target application's DOM or theme
  tokens.
- `manifest.json` records runtime support and generated output paths.

## Build

```sh
npm run build:arrakis
```

The command combines the shared sources into standalone stylesheets in
`examples/`. Use those generated files with Attune; CSS `@import` is avoided so
the stylesheet works inside another application's renderer.

## Target Coverage

| App | Layout intent | Runtime |
| --- | --- | --- |
| Spotify | Dark shadow listening deck with sand typography | Attune-compatible desktop renderer |
| Slack | Dark shadow workspace with restrained slate navigation | Attune-compatible desktop renderer |
| VS Code | Dark shadow workbench and sand code contrast | Attune-compatible desktop renderer |
| Claude | Sand conversation canvas and slate navigation rail | Browser extension or compatible renderer |
| ChatGPT | Continuous sand Codex workspace and dark Arrakis navigation rail | Attune-compatible desktop renderer |

Adapters intentionally use stable tokens and semantic selectors where each app
offers them. UI classes change over time, so inspect the target renderer before
making a surface-specific refinement.
