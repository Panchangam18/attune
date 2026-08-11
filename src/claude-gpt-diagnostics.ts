import { randomBytes } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_STRING_LENGTH = 240;
const SAFE_FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const SENSITIVE_FIELD_NAME = /authorization|credential|secret|token|header|prompt|(?:^|_)body(?:_|$)|content/i;

export type RoutingDiagnosticValue = string | number | boolean | null | readonly string[];

export interface RoutingDiagnostics {
  readonly path: string | null;
  write(
    component: 'proxy' | 'router' | 'session',
    event: string,
    fields?: Readonly<Record<string, RoutingDiagnosticValue>>,
  ): void;
  flush(): Promise<void>;
}

export function createRoutingDiagnosticId(): string {
  return randomBytes(9).toString('base64url');
}

export function createRoutingDiagnostics(path?: string | null): RoutingDiagnostics {
  const resolvedPath = path ? resolve(path) : null;
  let pending = Promise.resolve();

  const write = (
    component: 'proxy' | 'router' | 'session',
    event: string,
    fields: Readonly<Record<string, RoutingDiagnosticValue>> = {},
  ): void => {
    if (!resolvedPath) return;
    const record = {
      timestamp: new Date().toISOString(),
      component,
      event: safeText(event, 80),
      ...sanitizeFields(fields),
    };
    pending = pending
      .then(async () => {
        await ensurePrivateLogPath(resolvedPath);
        await rotateIfNeeded(resolvedPath);
        await appendFile(resolvedPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        await chmod(resolvedPath, 0o600);
      })
      .catch(() => {
        // Diagnostics must never affect routing or app availability.
      });
  };

  return {
    path: resolvedPath,
    write,
    flush: () => pending,
  };
}

export function routingErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const code = 'code' in error ? String(error.code ?? '') : '';
  if (/^[A-Za-z0-9_.-]{1,80}$/.test(code)) return code;
  const name = 'name' in error ? String(error.name ?? '') : '';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name) ? name : 'unknown';
}

function sanitizeFields(
  fields: Readonly<Record<string, RoutingDiagnosticValue>>,
): Record<string, RoutingDiagnosticValue> {
  const safe: Record<string, RoutingDiagnosticValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELD_NAME.test(key) || isSensitiveFieldName(key)) continue;
    if (typeof value === 'string') safe[key] = safeText(value, MAX_STRING_LENGTH);
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === 'boolean' || value === null) safe[key] = value;
    else if (Array.isArray(value)) {
      safe[key] = value.slice(0, 32).map(item => safeText(String(item), 80));
    }
  }
  return safe;
}

function isSensitiveFieldName(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (SENSITIVE_FIELD_NAME.test(words)) return true;
  return /(?:^|_)(?:(?:api|access|private|gateway)_?)?key(?:_|$)/.test(words);
}

function safeText(value: string, maximumLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .slice(0, maximumLength);
}

async function ensurePrivateLogPath(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('The routing diagnostics parent must be a directory.');
  }
  await chmod(parent, 0o700);
}

async function rotateIfNeeded(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid diagnostics path.');
    if (info.size < MAX_LOG_BYTES) return;
    const rotatedPath = `${path}.1`;
    await rm(rotatedPath, { force: true });
    await rename(path, rotatedPath);
    await chmod(rotatedPath, 0o600);
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
