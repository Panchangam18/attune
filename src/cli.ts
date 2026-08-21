#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { setStylesheetSource } from './config.js';
import { buildAgentStyleSource, getRoleCatalogForApp } from './agent-ui.js';
import {
  assertLiveComponentBrokerAvailable,
  createLiveComponentPresentation,
  writeComponentPresentation,
} from './component-presentation.js';
import { HOST_ROLE_CATALOG } from './host-roles.js';
import { scanForSupportedApps, findApp, getAppId } from './scan.js';
import {
  attach,
  compactInspection,
  compactSemanticElements,
  captureSemanticComponent,
  elements,
  getSession,
  inspect,
  launch,
  prepareSafariComponentSmuggleSource,
  prepareSemanticComponentSmuggleSource,
  runWatcher,
  stopSession,
  waitForSemanticStyle,
} from './session.js';

const [, , command, ...args] = process.argv;
void main(command, args);

async function main(command: string | undefined, args: string[]) {
  switch (command) {
    case 'scan':
      cmdScan();
      break;
    case 'set-css':
      cmdSetCSS(args[0], args[1]);
      break;
    case 'style':
      await cmdStyle(args);
      break;
    case 'launch':
      await cmdLaunch(args[0]);
      break;
    case 'attach':
      cmdAttach(args[0], args[1]);
      break;
    case 'stop':
      cmdStop(args[0]);
      break;
    case 'status':
      cmdStatus(args[0]);
      break;
    case 'inspect':
      await cmdInspect(args);
      break;
    case 'elements':
      await cmdElements(args);
      break;
    case 'roles':
      cmdRoles(args[0]);
      break;
    case 'present':
      await cmdPresent(args);
      break;
    case '_watch':
      await cmdWatch(args[0], args[1], args[2], args[3]);
      break;
    default:
      printUsage();
  }
}

async function cmdStyle(args: string[]) {
  const query = args[0];
  const cssIndex = args.indexOf('--css');
  const fileIndex = args.indexOf('--file');
  const clear = args.includes('--clear');
  const modeCount = Number(cssIndex >= 0) + Number(fileIndex >= 0) + Number(clear);
  if (!query || modeCount !== 1) {
    console.error('Usage: attune style <app-name> (--css <css> | --file <path> | --clear)');
    process.exit(1);
  }

  const app = findApp(scanForSupportedApps(), query);
  if (!app) {
    console.error(`No supported Chromium app found matching "${query}".`);
    process.exit(1);
  }

  let css = '';
  if (cssIndex >= 0) {
    if (args[cssIndex + 1] === undefined) {
      console.error('Usage: attune style <app-name> --css <css>');
      process.exit(1);
    }
    css = args[cssIndex + 1];
  } else if (fileIndex >= 0) {
    const filePath = args[fileIndex + 1];
    if (!filePath) {
      console.error('Usage: attune style <app-name> --file <path>');
      process.exit(1);
    }
    const resolvedPath = resolve(filePath);
    if (!existsSync(resolvedPath)) {
      console.error(`CSS file not found: ${resolvedPath}`);
      process.exit(1);
    }
    css = readFileSync(resolvedPath, 'utf8');
  }

  try {
    const session = getSession(getAppId(app));
    if (!session || session.status !== 'attached') {
      throw new Error(`No attached Attune session is available. Open "${app.name}" through Attune App first.`);
    }
    const style = buildAgentStyleSource(getAppId(app), app.name, css);
    setStylesheetSource(getAppId(app), '', style.source);
    const verification = await waitForSemanticStyle(app, style.css, style.roles);
    console.log(JSON.stringify({
      appId: getAppId(app),
      appName: app.name,
      cssLength: style.css.length,
      semanticRoles: style.roles,
      ...verification,
      message: clear ? 'Attune-managed CSS removed.' : 'CSS saved and verified in the live renderer.',
    }, null, 2));
    if (!verification.applied || verification.unavailableRoles.length) process.exitCode = 1;
  } catch (error: unknown) {
    console.error(`Failed to style "${app.name}":`, (error as Error).message);
    process.exit(1);
  }
}

function cmdScan() {
  const apps = scanForSupportedApps();
  if (apps.length === 0) {
    console.log('No supported Chromium desktop apps found.');
    return;
  }

  console.log(`Found ${apps.length} supported Chromium app(s):\n`);
  for (const app of apps) {
    const id = getAppId(app);
    console.log(`  ${app.name}`);
    console.log(`    Runtime: ${app.runtime === 'electron' ? 'Electron' : 'Chromium Embedded Framework'}`);
    console.log(`    ID: ${id}`);
    console.log(`    Path: ${app.path}`);
    console.log('');
  }
}

function cmdSetCSS(query: string | undefined, cssFilePath: string | undefined) {
  if (!query || !cssFilePath) {
    console.error('Usage: attune set-css <app-name> <path-to-css-file>');
    process.exit(1);
  }

  const apps = scanForSupportedApps();
  const app = findApp(apps, query);

  if (!app) {
    console.error(`No supported Chromium app found matching "${query}".`);
    process.exit(1);
  }

  const resolvedPath = resolve(cssFilePath);
  if (!existsSync(resolvedPath)) {
    console.error(`CSS file not found: ${resolvedPath}`);
    process.exit(1);
  }

  const css = readFileSync(resolvedPath, 'utf-8');
  const appId = getAppId(app);

  setStylesheetSource(appId, resolvedPath, css);

  console.log(`CSS saved for "${app.name}" (${css.length} chars).`);

  console.log(`\nLaunch it with Attune to apply this stylesheet:`);
  console.log(`  attune launch "${app.name}"`);
}

async function cmdLaunch(query: string | undefined) {
  if (!query) {
    console.error('Usage: attune launch <app-name>');
    process.exit(1);
  }

  const app = findApp(scanForSupportedApps(), query);
  if (!app) {
    console.error(`No supported Chromium app found matching "${query}".`);
    process.exit(1);
  }

  try {
    const { port } = await launch(app, process.argv[1]);
    console.log(`Launched "${app.name}" with Attune on localhost:${port}.`);
    console.log('Stylesheet edits will apply automatically while this session is open.');
  } catch (e: unknown) {
    console.error(`Failed to launch "${app.name}":`, (e as Error).message);
    process.exit(1);
  }
}

function cmdAttach(query: string | undefined, rawPort: string | undefined) {
  const port = Number(rawPort);
  if (!query || !Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error('Usage: attune attach <app-name> <remote-debugging-port>');
    process.exit(1);
  }

  const app = findApp(scanForSupportedApps(), query);
  if (!app) {
    console.error(`No supported Chromium app found matching "${query}".`);
    process.exit(1);
  }

  attach(app, process.argv[1], port);
  console.log(`Attached Attune to "${app.name}" on localhost:${port}.`);
}

function cmdStop(query: string | undefined) {
  if (!query) {
    console.error('Usage: attune stop <app-name>');
    process.exit(1);
  }

  const app = findApp(scanForSupportedApps(), query);
  if (!app) {
    console.error(`No supported Chromium app found matching "${query}".`);
    process.exit(1);
  }

  const stopped = stopSession(getAppId(app));
  console.log(stopped ? `Stopped Attune for "${app.name}".` : `No Attune session is running for "${app.name}".`);
}

function cmdStatus(query: string | undefined) {
  if (!query) {
    console.error('Usage: attune status <app-name>');
    process.exit(1);
  }

  const app = findApp(scanForSupportedApps(), query);
  if (!app) {
    console.error(`No supported Chromium app found matching "${query}".`);
    process.exit(1);
  }

  const session = getSession(getAppId(app));
  if (!session) {
    console.log(`No Attune session is running for "${app.name}".`);
    return;
  }

  const targetLabel = session.targetCount === 1 ? 'target' : 'targets';
  console.log(`Attune for "${app.name}": ${session.status} (${session.targetCount} page ${targetLabel})`);
}

async function cmdInspect(args: string[]) {
  const query = args[0];
  if (!query) {
    console.error('Usage: attune inspect <app-name> [--full] [--output <directory>]');
    process.exit(1);
  }

  const outputIndex = args.indexOf('--output');
  const outputDirectory = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && !outputDirectory) {
    console.error('Usage: attune inspect <app-name> [--full] [--output <directory>]');
    process.exit(1);
  }

  const app = findApp(scanForSupportedApps(), query);
  if (!app) {
    console.error(`No supported Chromium app found matching "${query}".`);
    process.exit(1);
  }

  try {
    const result = await inspect(app, outputDirectory ? resolve(outputDirectory) : undefined);
    console.log(JSON.stringify(args.includes('--full') ? result : compactInspection(result), null, 2));
  } catch (error: unknown) {
    console.error(`Failed to inspect "${app.name}":`, (error as Error).message);
    process.exit(1);
  }
}

async function cmdElements(args: string[]) {
  const query = args[0];
  if (!query) {
    console.error('Usage: attune elements <app-name> [--visual [--output <directory>]]');
    process.exit(1);
  }
  const outputIndex = args.indexOf('--output');
  const outputDirectory = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const visual = args.includes('--visual');
  if (outputIndex >= 0 && (!outputDirectory || !visual)) {
    console.error('Usage: attune elements <app-name> [--visual [--output <directory>]]');
    process.exit(1);
  }
  const app = findApp(scanForSupportedApps(), query);
  if (!app) {
    console.error(`No supported Chromium app found matching "${query}".`);
    process.exit(1);
  }
  try {
    const result = await elements(app, {
      visual,
      outputDirectory: outputDirectory ? resolve(outputDirectory) : undefined,
    });
    console.log(JSON.stringify(compactSemanticElements(result), null, 2));
  } catch (error: unknown) {
    console.error(`Failed to get elements for "${app.name}":`, (error as Error).message);
    process.exit(1);
  }
}

async function cmdPresent(args: string[]) {
  const query = args[0];
  const roleIndex = args.indexOf('--role');
  const selectorIndex = args.indexOf('--selector');
  const outputIndex = args.indexOf('--output');
  const descriptionIndex = args.indexOf('--description');
  const safariWindowIndex = args.indexOf('--safari-window');
  const safariTabIndex = args.indexOf('--safari-tab');
  const role = roleIndex >= 0 ? args[roleIndex + 1] : undefined;
  const selector = selectorIndex >= 0 ? args[selectorIndex + 1] : undefined;
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const description = descriptionIndex >= 0 ? args[descriptionIndex + 1] : undefined;
  const safariWindowId = safariWindowIndex >= 0 ? Number(args[safariWindowIndex + 1]) : undefined;
  const safariTabId = safariTabIndex >= 0 ? Number(args[safariTabIndex + 1]) : undefined;
  const isSafari = query?.trim().toLowerCase() === 'safari';
  if (!query || !outputPath || (isSafari ? !selector : !role)) {
    console.error('Usage: attune present <app-name> (--role <semantic-role> | --selector <safari-css-selector>) --output <html-file> [--live]');
    process.exit(1);
  }
  if (isSafari) {
    if (!args.includes('--live')) {
      console.error('Safari component presentation currently requires --live.');
      process.exit(1);
    }
    try {
      assertLiveComponentBrokerAvailable();
      const result = createLiveComponentPresentation(
        resolve(outputPath),
        await prepareSafariComponentSmuggleSource(
          selector!,
          description || 'Safari page component',
          { windowId: safariWindowId, tabIndex: safariTabId },
        ),
      );
      console.log(JSON.stringify(result, null, 2));
    } catch (error: unknown) {
      console.error('Failed to present "Safari":', (error as Error).message);
      process.exit(1);
    }
    return;
  }
  const app = findApp(scanForSupportedApps(), query);
  if (!app) {
    console.error(`No supported Chromium app found matching "${query}".`);
    process.exit(1);
  }
  try {
    let result;
    if (args.includes('--live')) {
      assertLiveComponentBrokerAvailable();
      result = createLiveComponentPresentation(
        resolve(outputPath),
        await prepareSemanticComponentSmuggleSource(app, role!),
      );
    } else {
      result = writeComponentPresentation(
        resolve(outputPath),
        await captureSemanticComponent(app, role!),
      );
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error: unknown) {
    console.error(`Failed to present "${app.name}":`, (error as Error).message);
    process.exit(1);
  }
}

function cmdRoles(query: string | undefined) {
  let catalog = HOST_ROLE_CATALOG;
  if (query) {
    const app = findApp(scanForSupportedApps(), query);
    catalog = app
      ? getRoleCatalogForApp(app.name, app.bundleId)
      : Object.fromEntries(Object.entries(HOST_ROLE_CATALOG).filter(([, entry]) => (
        entry.app.toLowerCase().includes(query.toLowerCase())
      )));
  }
  console.log(JSON.stringify(catalog, null, 2));
}

async function cmdWatch(
  configPath: string | undefined,
  rawPort: string | undefined,
  sessionPath: string | undefined,
  watcherToken: string | undefined,
) {
  const port = Number(rawPort);
  const expectedToken = process.env.ATTUNE_WATCHER_TOKEN;
  if (
    !configPath
    || !sessionPath
    || !Number.isInteger(port)
    || port <= 0
    || port > 65535
    || (expectedToken !== undefined && watcherToken !== expectedToken)
  ) {
    process.exit(1);
  }

  await runWatcher(configPath, port, sessionPath);
}

function printUsage() {
  console.log(`
attune — Dynamic UI customization for Chromium desktop apps

Usage:
  attune scan                        Scan supported Chromium desktop apps
  attune set-css <app-name> <file>   Set custom CSS for an app
  attune elements <app-name>         Return the bounded semantic editing surface
    --visual                         Include a temporary screenshot
    --output <directory>             Keep the --visual screenshot in a chosen directory
  attune style <app-name> --css CSS  Save and verify CSS against semantic roles
    --file <path>                    Read CSS from a durable file instead
    --clear                          Remove Attune-managed CSS
  attune roles [app-name]            List the static semantic role catalog
  attune present <app-name>          Capture one semantic component for inline conversation display
    --role <semantic-role>           Use an exact role returned by attune elements
    --selector <css-selector>        Resolve one component in Safari's front tab
    --description <text>             Label a Safari page component
    --safari-window <id>             Target a validated non-front Safari window
    --safari-tab <index>             Target a validated tab in that window
    --output <html-file>             Write a self-contained visualization fragment under 1 MB
    --live                           Connect the fragment to Attune App's interactive smuggling bridge
  attune launch <app-name>           Launch without modifying the app bundle
  attune attach <app-name> <port>    Attach to an app already running with DevTools
  attune status <app-name>           Show an Attune session
  attune inspect <app-name>          Return raw selector diagnostics; artifacts expire after 24 hours
    --full                           Print the complete inspection JSON
    --output <directory>             Keep inspection artifacts in a chosen directory
  attune stop <app-name>             Stop applying styles to a session
`);
}
