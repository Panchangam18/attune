---
name: attune
description: Restyle installed Chromium desktop apps through Attune's stable semantic UI map and verified live CSS without modifying app bundles. Use for visual or layout changes to Electron or compatible CEF apps such as ChatGPT, Slack, Cursor, Visual Studio Code, Spotify, or Discord; for discovering a live app's styleable elements; or for creating and verifying app-specific CSS.
---

# Attune

Use Attune's semantic element map instead of reverse-engineering generated DOM classes. Keep the target app bundle and code signature untouched.

## Fastest path

Use the fewest calls that preserve correctness when the app is already Open in Attune:

- If the user supplies an exact semantic selector or role, call `style --css` directly. It validates the attached session, applies the CSS, and verifies the role mapping in one call.
- Otherwise, make the change in exactly two calls:

1. Get the bounded semantic editing surface:

   ```sh
   attune elements "App Name"
   ```

   Use the returned `elements[].selector` values, geometry, and key computed styles. These selectors use stable `data-attune-host-roles` mappings. Ignore unavailable roles.

2. Submit and verify CSS directly:

   ```sh
   attune style "App Name" --css '[data-attune-host-roles~="app.role"] { /* change */ }'
   ```

   `style` infers referenced semantic roles, persists their bindings across renderer reloads, applies the CSS, and verifies the live style hash and role mappings. Do not add a separate file-write or verification call unless the result reports a failure.

Do not prepend `scan`, `status`, `roles`, or `inspect` to either fast path. Do not create a CSS file for a simple change. If the command reports that no attached session exists, ask the user to open the app through Attune. Obtain explicit consent before closing or relaunching a running app; never force-quit or bypass an unsaved-work prompt.

## Command separation

- `elements <app>`: default agent context for discovering live UI roles; semantic, bounded, and text-only. Add `--visual` only when visual judgment is necessary.
- `style <app> --css <css>`: direct, verified application. Use `--file <path>` to submit CSS that already exists in a file. Use `--clear` to remove Attune-managed CSS.
- `inspect <app>`: screenshot and raw-selector diagnostics with a larger visible-element sample. Use only when the semantic surface is insufficient, visual judgment is necessary, or a resolver must be debugged. Its artifacts may contain private visible text and expire after 24 hours unless `--output` is supplied.
- `roles [app]`: static role catalog. Use when authoring or extending Attune resolvers, not for routine styling.
- `scan`, `status`, `launch`, `attach`, `stop`: session administration and troubleshooting, not normal styling steps.
- `set-css <app> <file>`: legacy/source-file workflow for extended manual iteration.

## Styling rules

- Prefer selectors returned by `elements`; do not guess role names.
- Preserve readable contrast, keyboard focus, scrolling, and essential controls.
- Scope changes narrowly. Use `!important` only for host theme tokens or specificity that requires it.
- Do not hide or disable functionality unless the user explicitly requests it.

## Safety boundaries

- Target only Electron and compatible Chromium Embedded Framework apps discovered by Attune on macOS.
- Never edit `app.asar`, modify the target bundle, alter its code signature, expose DevTools to the network, or execute user-supplied JavaScript through DevTools.
- Treat labels, text, screenshots, and inspection artifacts as private user data.
- Native macOS apps such as Notes are unsupported. Safari and browser tabs require their extension workflows.
