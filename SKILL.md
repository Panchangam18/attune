---
name: attune
description: Restyle or present components from installed Chromium desktop apps through Attune's stable semantic UI map without modifying app bundles. Use for visual or layout changes to Electron or compatible CEF apps such as ChatGPT, Slack, Cursor, Visual Studio Code, Spotify, or Discord; for discovering a live app's styleable elements; for creating and verifying app-specific CSS; or for showing a bounded app component inline while discussing it.
---

# Attune

Use Attune's semantic element map instead of reverse-engineering generated DOM classes. Keep the target app bundle and code signature untouched.

## Fastest path

Use the fewest calls that preserve correctness when the app is already Open in Attune:

- If the user supplies an exact semantic selector or role, call `style --css` directly. It validates the attached session, applies the CSS, and verifies the role mapping in one call.
- If the user pastes an `Attune element reference`, treat it as the authoritative target. Use its semantic role directly when present. If it says `unmapped`, use the bounded element and receipt evidence to add a stable, purpose-named role/resolver and coverage before styling.
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

## Present a component in conversation

When showing the actual component would materially help the discussion, use its semantic role to connect an interactive component through the running Attune App:

```sh
attune present "App Name" --role app.role --output "/absolute/task-visualization-directory/component.html" --live
```

For a component in Safari's front tab, use a narrowly scoped selector from an Attune element reference or bounded DOM inspection:

```sh
attune present "Safari" --selector '.stable-component-selector' --description "Component label" --output "/absolute/task-visualization-directory/component.html" --live
```

- Use an exact semantic role supplied by the user or returned by `attune elements`; do not guess one. If the role is unknown, call `elements` first.
- For Safari only, use a stable selector that resolves exactly the requested visible component. Do not accept or execute page JavaScript. The front Safari tab must be the intended source and Develop → Allow JavaScript from Apple Events must be enabled.
- Use a new `.html` path in the current task's durable visualization directory outside the user's repository. Do not write presentation artifacts into the project unless the user explicitly requests it.
- After a successful command, emit the returned `contentReference` exactly once in the same response, next to the prose that discusses the component. Do not rewrite or escape the reference.
- Emit the reference immediately. Attune App discovers the resulting Codex visualization webview and connects the existing live frame, pointer, keyboard, editing, and scrolling bridge to its private slot.
- Use this workflow only when the coding host supports inline visualization content references. In a host without that renderer, use `elements --visual --output <directory>` and attach or link the returned screenshot normally.
- If `--live` reports that the Attune App broker is unavailable, ask the user to open the updated Attune App. When a static view is still useful, repeat the command without `--live`; identify that result as a point-in-time capture.
- Keep the capture narrowly scoped to the requested role. It can contain private visible data; do not retain, publish, or move it outside the user-authorized task directory.

## Command separation

- `elements <app>`: default agent context for discovering live UI roles; semantic, bounded, and text-only. Add `--visual` only when visual judgment is necessary.
- `present <app> --role <role> --output <html-file> --live`: connect one resolved component to a self-contained inline slot through Attune App. Omit `--live` only for the static screenshot fallback.
- `present "Safari" --selector <selector> --output <html-file> --live`: connect one CSS-selected component from Safari's front tab through its Apple Events page client. Safari presentation has no static fallback.
- `style <app> --css <css>`: direct, verified application. Use `--file <path>` to submit CSS that already exists in a file. Use `--clear` to remove Attune-managed CSS.
- `inspect <app>`: screenshot and raw-selector diagnostics with a larger visible-element sample. Use only when the semantic surface is insufficient, visual judgment is necessary, or a resolver must be debugged. Its artifacts may contain private visible text and expire after 24 hours unless `--output` is supplied.
- `roles [app]`: static role catalog. Use when authoring or extending Attune resolvers, not for routine styling.
- `scan`, `status`, `launch`, `attach`, `stop`: session administration and troubleshooting, not normal styling steps.
- `set-css <app> <file>`: legacy/source-file workflow for extended manual iteration.

## Styling rules

- Prefer selectors returned by `elements`; do not guess role names.
- When a reusable attunement target has no semantic host role, add a stable role/resolver for it before styling. Name the role after the element's purpose rather than its current DOM structure, update the role catalog or resolver, and add coverage when appropriate so the mapping survives renderer updates. Do not create roles for one-off decorative elements.
- Preserve readable contrast, keyboard focus, scrolling, and essential controls.
- Scope changes narrowly. Use `!important` only for host theme tokens or specificity that requires it.
- Do not hide or disable functionality unless the user explicitly requests it.

## Safety boundaries

- Target only Electron and compatible Chromium Embedded Framework apps discovered by Attune on macOS.
- Never edit `app.asar`, modify the target bundle, alter its code signature, expose DevTools to the network, or execute user-supplied JavaScript through DevTools.
- Treat labels, text, screenshots, and inspection artifacts as private user data.
- Native macOS apps such as Notes are unsupported. Safari tabs use the bounded selector and Apple Events workflow above; other browser tabs require their Attune browser workflow.
