/**
 * Patch a target Electron app by replacing its app.asar with a shim
 * that injects Attune's preload script, then chain-loads the original app.
 */
export declare function patch(resourcesPath: string, appId: string, preloadSourcePath: string): void;
/**
 * Remove Attune's shim and restore the original app.asar.
 */
export declare function unpatch(resourcesPath: string): void;
