#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { setStylesheetSource } from './config.js';
import { scanForSupportedApps, findApp, getAppId } from './scan.js';
import { getSession, launch, runWatcher, stopSession } from './session.js';

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
    case 'launch':
      await cmdLaunch(args[0]);
      break;
    case 'stop':
      cmdStop(args[0]);
      break;
    case 'status':
      cmdStatus(args[0]);
      break;
    case '_watch':
      await cmdWatch(args[0], args[1], args[2]);
      break;
    default:
      printUsage();
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

async function cmdWatch(configPath: string | undefined, rawPort: string | undefined, sessionPath: string | undefined) {
  const port = Number(rawPort);
  if (!configPath || !sessionPath || !Number.isInteger(port) || port <= 0 || port > 65535) {
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
  attune launch <app-name>           Launch without modifying the app bundle
  attune status <app-name>           Show an Attune session
  attune stop <app-name>             Stop applying styles to a session
`);
}
