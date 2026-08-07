# Attune

Attune is an agent-ready skill and runtime for restyling installed Chromium desktop
apps with live CSS, without modifying their code-signed bundles. Give the
repository's [`SKILL.md`](SKILL.md) to a desktop-capable agent and it can safely
style apps such as Slack, Visual Studio Code, and compatible Spotify builds,
verify the visual result, and keep the CSS editable after launch.

## What An Agent Needs

- Terminal access to run the Attune CLI.
- Permission to close and relaunch the target app after asking the user.
- Access to the local Attune session; `attune inspect` supplies screenshots and
  selector context directly to the agent.

## Install The Runtime

```sh
npm install
npm run build
node dist/cli.js scan
```

For a global command, run `npm install --global .` from this repository, then
use `attune` instead of `node dist/cli.js`.

## Agent Workflow

```sh
node dist/cli.js set-css "Spotify" ./examples/spotify-vinyl-archive.css
# Quit Spotify normally, after confirming the user is ready.
node dist/cli.js launch "Spotify"
node dist/cli.js status "Spotify"
node dist/cli.js inspect "Spotify"
```

`launch` starts the ordinary app executable with a localhost-only DevTools port.
The Attune sidecar discovers its renderer windows and manages one stylesheet in
each. Saving the source CSS file applies edits live; the app bundle, ASAR files,
and code signature remain unchanged.

`inspect` prints a compact machine-readable summary and saves screenshots plus
complete selector details in a temporary inspection directory. Temporary
artifacts expire after 24 hours and are removed by a later inspection. Pass
`--full` to print the complete JSON, or `--output <directory>` to retain the
artifacts explicitly. The context includes viewport data, visible controls and
landmarks, selector stability, bounds, and computed-style samples. Because
visible labels and text may appear in the JSON and screenshots, inspection
output should be treated as private user data.

## Included Styles

- [Spotify Vinyl Archive](examples/spotify-vinyl-archive.css)
- [VS Code neon](examples/vscode-neon.css)

## Design Systems

### Theme Systems

Official theme systems, including Arrakis, live in the separate
[`attunements`](https://github.com/Panchangam18/attunements) catalog alongside
app-specific attunements. Attune App consumes that catalog directly and can
compose its tokens, base layout, and adapters at runtime.

Arrakis uses Nasalization Regular for readable UI text. The catalog package
includes the font asset so Attune can compile a self-contained stylesheet.

Spotify, Slack, VS Code, and ChatGPT are intended for Attune-compatible desktop
renderers. The Claude adapter is a reusable CSS surface for a browser extension
or another compatible renderer; Attune does not currently launch Claude
directly.

## Scope And Safety

Attune supports scanned Electron and compatible Chromium Embedded Framework (CEF)
desktop apps. It does not style native macOS apps such as Notes, and Safari
websites need a separate browser-extension mode. Attune has no bundle-patching
mode. Ask before closing a running app, use the loopback-only launch path, and
verify the result in the actual interface.

To remove an active style, clear the stylesheet while the app is attached, then
run `attune stop "App Name"`. Stopping alone leaves the already injected style
until the app reloads or closes.

## Development

```sh
npm test
```
