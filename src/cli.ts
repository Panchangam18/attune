#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { scanForElectronApps, findApp, getAppId } from './scan.js';
import { patch, unpatch } from './patch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ATTUNE_DIR = join(homedir(), '.attune');
const CONFIG_DIR = join(ATTUNE_DIR, 'config');

// The preload script lives alongside the compiled CLI (or in src/injection during dev)
function getPreloadPath(): string {
  // Check for the source file first (dev mode with tsx)
  const devPath = join(__dirname, 'injection', 'attune-preload.js');
  if (existsSync(devPath)) return devPath;

  // Built mode: injection/ is excluded from tsc, so it stays in src/
  const srcPath = join(__dirname, '..', 'src', 'injection', 'attune-preload.js');
  if (existsSync(srcPath)) return srcPath;

  throw new Error('Could not find attune-preload.js');
}

const [, , command, ...args] = process.argv;

switch (command) {
  case 'scan':
    cmdScan();
    break;
  case 'patch':
    cmdPatch(args[0]);
    break;
  case 'unpatch':
    cmdUnpatch(args[0]);
    break;
  case 'set-css':
    cmdSetCSS(args[0], args[1]);
    break;
  default:
    printUsage();
}

function cmdScan() {
  const apps = scanForElectronApps();
  if (apps.length === 0) {
    console.log('No Electron apps found.');
    return;
  }

  console.log(`Found ${apps.length} Electron app(s):\n`);
  for (const app of apps) {
    const status = app.isPatched ? '[PATCHED]' : '[       ]';
    const id = getAppId(app);
    console.log(`  ${status}  ${app.name}`);
    console.log(`           ID: ${id}`);
    console.log(`           Path: ${app.path}`);
    console.log('');
  }
}

function cmdPatch(query: string | undefined) {
  if (!query) {
    console.error('Usage: attune patch <app-name>');
    process.exit(1);
  }

  const apps = scanForElectronApps();
  const app = findApp(apps, query);

  if (!app) {
    console.error(`No Electron app found matching "${query}".`);
    console.error('Run "attune scan" to see available apps.');
    process.exit(1);
  }

  const appId = getAppId(app);

  try {
    patch(app.resourcesPath, appId, getPreloadPath());
    console.log(`Patched "${app.name}" successfully.`);
    console.log(`App ID: ${appId}`);
    console.log(`\nNext: set custom CSS with:`);
    console.log(`  attune set-css "${app.name}" <path-to-css-file>`);
  } catch (e: unknown) {
    console.error(`Failed to patch "${app.name}":`, (e as Error).message);
    process.exit(1);
  }
}

function cmdUnpatch(query: string | undefined) {
  if (!query) {
    console.error('Usage: attune unpatch <app-name>');
    process.exit(1);
  }

  const apps = scanForElectronApps();
  const app = findApp(apps, query);

  if (!app) {
    console.error(`No Electron app found matching "${query}".`);
    process.exit(1);
  }

  try {
    unpatch(app.resourcesPath);
    console.log(`Unpatched "${app.name}" successfully. Original app restored.`);
  } catch (e: unknown) {
    console.error(`Failed to unpatch "${app.name}":`, (e as Error).message);
    process.exit(1);
  }
}

function cmdSetCSS(query: string | undefined, cssFilePath: string | undefined) {
  if (!query || !cssFilePath) {
    console.error('Usage: attune set-css <app-name> <path-to-css-file>');
    process.exit(1);
  }

  const apps = scanForElectronApps();
  const app = findApp(apps, query);

  if (!app) {
    console.error(`No Electron app found matching "${query}".`);
    process.exit(1);
  }

  const resolvedPath = resolve(cssFilePath);
  if (!existsSync(resolvedPath)) {
    console.error(`CSS file not found: ${resolvedPath}`);
    process.exit(1);
  }

  const css = readFileSync(resolvedPath, 'utf-8');
  const appId = getAppId(app);

  mkdirSync(CONFIG_DIR, { recursive: true });
  const configPath = join(CONFIG_DIR, `${appId}.json`);

  const config = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf-8'))
    : { css: '', enabled: true };

  config.css = css;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log(`CSS saved for "${app.name}" (${css.length} chars).`);

  if (!app.isPatched) {
    console.log(`\nNote: "${app.name}" is not patched yet. Run:`);
    console.log(`  attune patch "${app.name}"`);
  } else {
    console.log(`\nRestart "${app.name}" to see the changes.`);
  }
}

function printUsage() {
  console.log(`
attune — Dynamic UI customization for Electron apps

Usage:
  attune scan                        Scan for Electron apps on the system
  attune patch <app-name>            Inject Attune into an Electron app
  attune unpatch <app-name>          Remove Attune and restore the original app
  attune set-css <app-name> <file>   Set custom CSS for a patched app
`);
}
