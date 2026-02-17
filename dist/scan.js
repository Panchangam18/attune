import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
/**
 * Scan the system for installed Electron apps.
 * Checks /Applications and ~/Applications for .app bundles
 * that contain the Electron Framework.
 */
export function scanForElectronApps() {
    const searchDirs = [
        '/Applications',
        join(homedir(), 'Applications'),
    ];
    const apps = [];
    for (const dir of searchDirs) {
        if (!existsSync(dir))
            continue;
        const entries = readdirSync(dir).filter(e => e.endsWith('.app'));
        for (const entry of entries) {
            const appPath = join(dir, entry);
            const frameworkPath = join(appPath, 'Contents/Frameworks/Electron Framework.framework');
            if (!existsSync(frameworkPath))
                continue;
            const resourcesPath = join(appPath, 'Contents/Resources');
            const isPatched = existsSync(join(resourcesPath, '_original.asar'));
            apps.push({
                name: entry.replace('.app', ''),
                path: appPath,
                resourcesPath,
                bundleId: getBundleId(appPath),
                isPatched,
            });
        }
    }
    return apps;
}
/**
 * Find a discovered app by name (case-insensitive partial match).
 */
export function findApp(apps, query) {
    const lower = query.toLowerCase();
    return apps.find(a => a.name.toLowerCase() === lower)
        || apps.find(a => a.name.toLowerCase().includes(lower));
}
/**
 * Derive a stable ID for an app (used for config file naming).
 */
export function getAppId(app) {
    return app.bundleId || app.name.toLowerCase().replace(/\s+/g, '-');
}
function getBundleId(appPath) {
    try {
        const plistPath = join(appPath, 'Contents/Info');
        return execSync(`defaults read "${plistPath}" CFBundleIdentifier`, {
            encoding: 'utf-8',
            timeout: 3000,
        }).trim();
    }
    catch {
        return null;
    }
}
