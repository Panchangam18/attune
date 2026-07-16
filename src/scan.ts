import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type ChromiumRuntime = 'electron' | 'cef';

export interface DiscoveredApp {
  name: string;
  path: string;
  bundleId: string | null;
  runtime: ChromiumRuntime;
}

/**
 * Scan the system for Chromium desktop apps that can expose the DevTools protocol.
 * Electron and CEF apps use the same local CSS injection session once launched.
 */
export function scanForSupportedApps(): DiscoveredApp[] {
  const searchDirs = [
    '/Applications',
    join(homedir(), 'Applications'),
  ];

  const apps: DiscoveredApp[] = [];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;

    const entries = readdirSync(dir).filter(e => e.endsWith('.app'));

    for (const entry of entries) {
      const appPath = join(dir, entry);
      const runtime = getChromiumRuntime(appPath);
      if (!runtime) continue;

      apps.push({
        name: entry.replace('.app', ''),
        path: appPath,
        bundleId: getBundleId(appPath),
        runtime,
      });
    }
  }

  return apps;
}

export function getChromiumRuntime(appPath: string): ChromiumRuntime | null {
  const frameworksPath = join(appPath, 'Contents/Frameworks');
  if (existsSync(join(frameworksPath, 'Electron Framework.framework'))) {
    return 'electron';
  }
  if (existsSync(join(frameworksPath, 'Chromium Embedded Framework.framework'))) {
    return 'cef';
  }
  if (existsSync(join(frameworksPath, 'Codex Framework.framework'))) {
    return 'cef';
  }
  return null;
}

/**
 * Find a discovered app by name (case-insensitive partial match).
 */
export function findApp(apps: DiscoveredApp[], query: string): DiscoveredApp | undefined {
  const lower = query.toLowerCase();
  return apps.find(a => a.name.toLowerCase() === lower)
    || apps.find(a => a.name.toLowerCase().includes(lower));
}

/**
 * Derive a stable ID for an app (used for config file naming).
 */
export function getAppId(app: DiscoveredApp): string {
  return app.bundleId || app.name.toLowerCase().replace(/\s+/g, '-');
}

export function getAppExecutablePath(app: DiscoveredApp): string {
  const plistPath = join(app.path, 'Contents/Info');
  try {
    const executable = execFileSync('defaults', ['read', plistPath, 'CFBundleExecutable'], {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    if (executable) {
      return join(app.path, 'Contents', 'MacOS', executable);
    }
  } catch {
    // Fall through to the conventional executable name.
  }

  return join(app.path, 'Contents', 'MacOS', app.name);
}

function getBundleId(appPath: string): string | null {
  try {
    const plistPath = join(appPath, 'Contents/Info');
    return execFileSync('defaults', ['read', plistPath, 'CFBundleIdentifier'], {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}
