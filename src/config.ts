import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.attune', 'config');

interface AttuneConfig {
  css: string;
  sourcePath?: string;
}

export function ensureConfig(appId: string): string {
  const configPath = getConfigPath(appId);
  if (!existsSync(configPath)) {
    writeConfig(configPath, { css: '' });
  }
  return configPath;
}

export function setStylesheetSource(appId: string, sourcePath: string, css: string): void {
  writeConfig(getConfigPath(appId), { css, sourcePath });
}

export function readStylesheet(configPath: string): string {
  const config = readConfig(configPath);
  if (config.sourcePath && existsSync(config.sourcePath)) {
    return readFileSync(config.sourcePath, 'utf8');
  }
  return config.css;
}

function getConfigPath(appId: string): string {
  return join(CONFIG_DIR, `${appId}.json`);
}

function readConfig(configPath: string): AttuneConfig {
  if (!existsSync(configPath)) {
    return { css: '' };
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<AttuneConfig>;
    return {
      css: typeof config.css === 'string' ? config.css : '',
      sourcePath: typeof config.sourcePath === 'string' ? config.sourcePath : undefined,
    };
  } catch {
    return { css: '' };
  }
}

function writeConfig(configPath: string, config: AttuneConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeAtomically(configPath, config);
}

function writeAtomically(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2));
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}
