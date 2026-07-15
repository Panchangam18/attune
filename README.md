# Attune

Attune is an agent-ready skill and runtime for restyling installed Electron apps
with live CSS, without modifying their code-signed bundles. Give the repository's
[`SKILL.md`](SKILL.md) to a desktop-capable agent and it can safely style apps
such as Slack and Visual Studio Code, verify the visual result, and keep the CSS
editable after launch.

## What An Agent Needs

- Terminal access to run the Attune CLI.
- Permission to close and relaunch the target app after asking the user.
- Optional desktop or screenshot access to verify the rendered result.

The skill is intentionally tool-agnostic: any agent that can read `SKILL.md`,
run shell commands, and interact with the desktop can follow the workflow.

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
node dist/cli.js set-css "Slack" ./examples/slack-midnight-jade.css
# Quit Slack normally, after confirming the user is ready.
node dist/cli.js launch "Slack"
node dist/cli.js status "Slack"
```

`launch` starts the ordinary app executable with a localhost-only DevTools port.
The Attune sidecar discovers its renderer windows and manages one stylesheet in
each. Saving the source CSS file applies edits live; the app bundle, ASAR files,
and code signature remain unchanged.

## Included Styles

- [Slack midnight jade](examples/slack-midnight-jade.css)
- [VS Code neon](examples/vscode-neon.css)

## Scope And Safety

Attune supports scanned Electron desktop apps. It does not style native macOS
apps such as Notes, and Safari websites need a separate browser-extension mode.
Attune has no bundle-patching mode. Ask before closing a running app, use the
loopback-only launch path, and verify the result in the actual interface.

To remove an active style, clear the stylesheet while the app is attached, then
run `attune stop "App Name"`. Stopping alone leaves the already injected style
until the app reloads or closes.

## Development

```sh
npm test
```
