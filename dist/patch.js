import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
const ATTUNE_DIR = join(homedir(), '.attune');
/**
 * Patch a target Electron app by replacing its app.asar with a shim
 * that injects Attune's preload script, then chain-loads the original app.
 */
export function patch(resourcesPath, appId, preloadSourcePath) {
    const asarPath = join(resourcesPath, 'app.asar');
    const originalPath = join(resourcesPath, '_original.asar');
    const unpackedPath = join(resourcesPath, 'app.asar.unpacked');
    const originalUnpackedPath = join(resourcesPath, '_original.asar.unpacked');
    if (!existsSync(asarPath)) {
        throw new Error(`No app.asar found at ${resourcesPath}`);
    }
    if (existsSync(originalPath)) {
        throw new Error('App is already patched (found _original.asar). Unpatch first.');
    }
    // Copy the preload script to a stable location
    const injectionDir = join(ATTUNE_DIR, 'injection', appId);
    mkdirSync(injectionDir, { recursive: true });
    const preloadDest = join(injectionDir, 'attune-preload.js');
    copyFileSync(preloadSourcePath, preloadDest);
    // Ensure config directory exists
    const configDir = join(ATTUNE_DIR, 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, `${appId}.json`);
    // Write default config if it doesn't exist
    if (!existsSync(configPath)) {
        writeFileSync(configPath, JSON.stringify({ css: '', enabled: true }, null, 2));
    }
    // Step 1: Backup original asar
    renameSync(asarPath, originalPath);
    if (existsSync(unpackedPath)) {
        renameSync(unpackedPath, originalUnpackedPath);
    }
    // Step 2: Create shim directory in place of app.asar
    mkdirSync(asarPath, { recursive: true });
    // Step 3: Write shim package.json
    writeFileSync(join(asarPath, 'package.json'), JSON.stringify({ name: 'attune-shim', main: 'index.js' }, null, 2));
    // Step 4: Write the shim index.js
    writeFileSync(join(asarPath, 'index.js'), generateShim(preloadDest, configPath, appId));
}
/**
 * Remove Attune's shim and restore the original app.asar.
 */
export function unpatch(resourcesPath) {
    const shimDir = join(resourcesPath, 'app.asar');
    const originalPath = join(resourcesPath, '_original.asar');
    const originalUnpackedPath = join(resourcesPath, '_original.asar.unpacked');
    const unpackedPath = join(resourcesPath, 'app.asar.unpacked');
    if (!existsSync(originalPath)) {
        throw new Error('No _original.asar found — app is not patched.');
    }
    // Remove shim directory
    rmSync(shimDir, { recursive: true, force: true });
    // Restore original
    renameSync(originalPath, join(resourcesPath, 'app.asar'));
    if (existsSync(originalUnpackedPath)) {
        renameSync(originalUnpackedPath, unpackedPath);
    }
}
/**
 * Generate the shim index.js content.
 * This script runs as the target Electron app's main process entry point.
 * It patches BrowserWindow to inject our preload, strips CSP headers,
 * and chain-loads the original app.
 */
function generateShim(preloadPath, configPath, appId) {
    // Escape backslashes for Windows paths in the generated JS string
    const safePreload = JSON.stringify(preloadPath);
    const safeConfig = JSON.stringify(configPath);
    const safeAppId = JSON.stringify(appId);
    return `'use strict';

const { app, BrowserWindow, session } = require('electron');
const path = require('path');

// --- Attune Shim ---
// Patches BrowserWindow to inject custom CSS via preload script,
// then chain-loads the original application.

const ATTUNE_PRELOAD = ${safePreload};
const ATTUNE_CONFIG  = ${safeConfig};
const ATTUNE_APP_ID  = ${safeAppId};

// Monkey-patch BrowserWindow
const OriginalBW = BrowserWindow;

function PatchedBrowserWindow(options) {
  options = options || {};
  options.webPreferences = options.webPreferences || {};

  // Save the app's original preload so ours can chain-load it
  const originalPreload = options.webPreferences.preload || null;
  if (originalPreload) {
    process.env.ATTUNE_ORIGINAL_PRELOAD = originalPreload;
  }

  // Inject our preload
  options.webPreferences.preload = ATTUNE_PRELOAD;
  process.env.ATTUNE_CONFIG_PATH = ATTUNE_CONFIG;
  process.env.ATTUNE_APP_ID = ATTUNE_APP_ID;

  // Disable sandbox so our preload has fs access to read config
  options.webPreferences.sandbox = false;

  return new OriginalBW(options);
}

// Preserve static methods and prototype chain
Object.setPrototypeOf(PatchedBrowserWindow, OriginalBW);
Object.setPrototypeOf(PatchedBrowserWindow.prototype, OriginalBW.prototype);
Object.assign(PatchedBrowserWindow, OriginalBW);

// Override require('electron') to return our patched BrowserWindow
const electronPath = require.resolve('electron');
delete require.cache[electronPath];
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: new Proxy(require('electron'), {
    get(target, prop) {
      if (prop === 'BrowserWindow') return PatchedBrowserWindow;
      return target[prop];
    }
  }),
};

// Strip CSP headers so our injected <style> elements aren't blocked
app.on('ready', () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = Object.assign({}, details.responseHeaders);
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    callback({ responseHeaders: headers });
  });
});

// Chain-load the original application
const originalAsar = path.join(__dirname, '..', '_original.asar');
require(originalAsar);
`;
}
