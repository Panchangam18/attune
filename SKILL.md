---
name: attune
description: Safely restyle installed Chromium desktop apps with live CSS while preserving code signatures. Use when an agent needs to change the appearance of an Electron or compatible CEF app such as Slack, Visual Studio Code, Spotify, or Discord; create or refine app-specific CSS; launch an app with a local DevTools session; or verify a desktop UI restyle with a screenshot.
---

# Attune

Use Attune to apply CSS to Chromium renderers without modifying the target app's bundle. Work from the Attune repository or an installed `attune` command.

## Operating Rules

- Support Electron and compatible Chromium Embedded Framework (CEF) apps discovered by `attune scan` on macOS. Do not treat native macOS apps or browser tabs as Attune targets.
- Keep the target app bundle untouched. Never edit `app.asar`, alter an app's code signature, or use DevTools to run user-supplied JavaScript.
- Ask for explicit consent before closing a running app. A normal quit may surface an unsaved-work prompt; never force-quit to make styling work.
- Bind only to Attune's loopback workflow. Do not expose the DevTools port to the network.
- Preserve usability: maintain readable contrast, keyboard focus, and essential controls. Prefer scoped visual changes over hiding or disabling UI.

## Workflow

1. Confirm the desired app, visual intent, and whether the user wants the existing running instance restarted. Inspect the app with `attune scan`.
2. Build Attune if necessary:

   ```sh
   npm install
   npm run build
   ```

3. If the app is running, obtain consent and quit it normally. Do not bypass save prompts.
4. Launch the app, wait for `status` to report `attached`, then inspect the live renderer:

   ```sh
   attune launch "App Name"
   attune status "App Name"
   attune inspect "App Name"
   ```

   `inspect` returns compact JSON containing the primary screenshot, viewport,
   and a small selector sample. Complete context is saved at the returned
   temporary JSON path and expires after 24 hours. Read only the targeted
   details needed for the edit. Use `--full` only when compact context is
   insufficient, or `--output <directory>` when artifacts must be retained.
   Inspection may include text visible in the app; treat it as private user data.
5. Create or update a named CSS file from the inspection. Prefer high-stability
   semantic selectors; use structural selectors only when necessary.
6. Register the stylesheet:

   ```sh
   attune set-css "App Name" /absolute/path/to/style.css
   ```

   When running from this repository, use `node dist/cli.js` in place of `attune`.
7. Run `inspect` again after each significant edit and compare the new
   screenshot with the intended result. Attune polls the source CSS and
   reinjects it without restarting the app.

## Styling Guidance

- Prefer CSS variables and class or data selectors owned by the target app.
- Use `!important` sparingly but deliberately for application theme tokens that override inline or high-specificity rules.
- Give every style a clear name and keep it in a durable user-controlled location rather than a temporary file.
- Inspect the UI before styling and after each significant change. Chromium app
  DOM structures change across releases, so treat selectors as app-version-specific.

## Verify and Undo

- Use `attune status "App Name"` to confirm a live session and its renderer target count.
- To remove styling from an open app, first clear the CSS file and wait for the session to report `attached`; Attune then removes its managed style element. Run `attune stop "App Name"` afterward to end the watcher.
- `stop` alone only ends future updates. The currently injected style remains until the renderer reloads or the app closes.

## Boundaries

- **Electron and compatible CEF desktop apps:** supported through launch-time localhost DevTools.
- **Safari and other websites:** require a browser extension workflow, not this runtime.
- **Native apps such as Notes:** do not have an HTML/CSS renderer for Attune to target. Do not attempt bundle patching or native code injection.
