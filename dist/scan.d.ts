export interface DiscoveredApp {
    name: string;
    path: string;
    resourcesPath: string;
    bundleId: string | null;
    isPatched: boolean;
}
/**
 * Scan the system for installed Electron apps.
 * Checks /Applications and ~/Applications for .app bundles
 * that contain the Electron Framework.
 */
export declare function scanForElectronApps(): DiscoveredApp[];
/**
 * Find a discovered app by name (case-insensitive partial match).
 */
export declare function findApp(apps: DiscoveredApp[], query: string): DiscoveredApp | undefined;
/**
 * Derive a stable ID for an app (used for config file naming).
 */
export declare function getAppId(app: DiscoveredApp): string;
