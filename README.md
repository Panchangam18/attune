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

For agent-driven UI changes, prefer the semantic two-command workflow:

```sh
attune elements "Slack"
attune style "Slack" --css '[data-attune-host-roles~="slack.composer"] { border-radius: 12px; }'
```

`elements` returns a bounded live map of stable host roles, geometry, and key
styles. Add `--visual` only when a screenshot is necessary. `style` extracts the referenced roles, persists their
bindings with the CSS, and verifies the result in the attached renderer. Use
`inspect` separately for raw selector diagnostics and `roles` for the static
semantic catalog.

In Codex and other hosts with an inline visualization renderer, an agent can
present one resolved component beside its explanation:

```sh
attune present "Slack" --role slack.composer --output "/absolute/task-visualization-directory/slack-composer.html" --live
```

The command writes a private, responsive destination slot and asks the running
Attune App to attach its existing component-smuggling bridge to the Codex
visualization webview. Pointer, keyboard, editing, and scrolling events relay to
the source component while its live visual state streams back. The JSON result
includes the exact `contentReference` the agent should emit. Omit `--live` for a
point-in-time, networkless screenshot fallback.

Safari page components use the same bridge through the front tab's bounded
Apple Events client:

```sh
attune present "Safari" --selector '.graph-before-activity-overview' --description "GitHub contribution graph" --output "/absolute/task-visualization-directory/github-graph.html" --live
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

## Claude GPT Bridge Authentication

The `claude-gpt-models` attunement keeps Claude Desktop as the UI, history
owner, and tool harness. Native Claude model requests continue to Anthropic.
Only Attune's exact GPT aliases are routed through the local bridge:

```text
Claude Desktop
  -> Attune's authenticated local router
  -> codex app-server (stdio)
  -> the account already managed by the installed Codex runtime
```

Attune does not read, copy, or refresh `~/.codex/auth.json`. It launches the
official `codex app-server`, checks `account/read` and `model/list`, and lets
Codex own token storage and refresh. The Codex UI does not need to be open. GPT
turns are ephemeral so they do not create duplicate Codex history, while any
model-selected tools are returned to Claude Code for execution by its existing
harness.

The original prototype used a separate CLIProxyAPI process on loopback port
8317. Attune authenticated that local hop with
`~/.cli-proxy-api/client.key`; the key was not an OpenAI credential. The gateway
then maintained its own Codex OAuth state and translated Anthropic-shaped
requests. That extra process and second auth lifecycle are now legacy-only and
are selected only when a caller explicitly supplies `gptUpstream` or
`credentialPath` to the router.

The local certificate remains part of the bridge, but it is routing trust—not
OpenAI authentication. It lets the launched Claude process securely reach
Attune's private local router without modifying Claude's signed application
bundle.

## Semantic Host Roles

Manifest-v2 attunements should bind to semantic host roles and style the stable
`data-attune-host-roles` attribute instead of depending on generated classes or
exact DOM paths. The agent-readable role catalog and the per-app resolver
registries are maintained in [`src/host-roles.ts`](src/host-roles.ts).

When a deterministic resolver succeeds, Attune records a multi-signal element
fingerprint under `~/.attune/host-fingerprints/`. If a later app version breaks
the resolver, Attune compares candidate elements using accessibility metadata,
stable attributes, text, ancestry, class tokens, and geometry. A fallback is
accepted only when it clears both the confidence threshold and the runner-up by
a safe margin. Ambiguous matches remain unavailable and are exposed through the
attunement compatibility report rather than being applied silently.

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

Spotify, Slack, VS Code, ChatGPT, and supported Claude Desktop builds are
intended for Attune-compatible desktop renderers. Claude's GPT model bridge is
enabled only by its dedicated attunement and Attune-managed launch.

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
