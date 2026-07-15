import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface DiscoveredApp {
  name: string;
  path: string;
  bundleId: string | null;
}

/**
 * Scan the system for installed Electron apps.
 * Checks /Applications and ~/Applications for .app bundles
 * that contain the Electron Framework.
 */
export function scanForElectronApps(): DiscoveredApp[] {
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
      const frameworkPath = join(appPath, 'Contents/Frameworks/Electron Framework.framework');

      if (!existsSync(frameworkPath)) continue;

      apps.push({
        name: entry.replace('.app', ''),
        path: appPath,
        bundleId: getBundleId(appPath),
      });
    }
  }

  return apps;
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
