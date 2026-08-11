import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const baseUrl = process.env.ATTUNE_CLAUDE_GPT_BASE_URL;
const diagnosticsPath = process.env.ATTUNE_CLAUDE_GPT_DIAGNOSTICS_PATH;
const previousBaseRoute = classifyBaseUrl(process.env.ANTHROPIC_BASE_URL);

if (baseUrl && isAttuneLoopbackBaseUrl(baseUrl)) {
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = 'true';
  writePreloadDiagnostic(diagnosticsPath, 'cliPreloadApplied', {
    processId: process.pid,
    previousBaseRoute,
    route: 'loopbackRouter',
  });
} else {
  writePreloadDiagnostic(diagnosticsPath, 'cliPreloadRejected', {
    processId: process.pid,
    previousBaseRoute,
    reason: baseUrl ? 'invalidBaseUrl' : 'missingBaseUrl',
  });
}

delete process.env.ATTUNE_CLAUDE_GPT_BASE_URL;
delete process.env.ATTUNE_CLAUDE_GPT_DIAGNOSTICS_PATH;

function isAttuneLoopbackBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && Number.isSafeInteger(Number(url.port))
      && Number(url.port) >= 1
      && Number(url.port) <= 65_535
      && /^\/\.attune\/[A-Za-z0-9_-]{16,128}$/.test(url.pathname)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function classifyBaseUrl(value: string | undefined): string {
  if (!value) return 'missing';
  if (isAttuneLoopbackBaseUrl(value)) return 'loopbackRouter';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'api.anthropic.com'
      ? 'anthropicApi'
      : 'other';
  } catch {
    return 'invalid';
  }
}

function writePreloadDiagnostic(
  path: string | undefined,
  event: 'cliPreloadApplied' | 'cliPreloadRejected',
  fields: Readonly<Record<string, string | number>>,
): void {
  if (!path) return;
  try {
    const expectedPath = resolve(join(homedir(), '.attune', 'logs', 'claude-gpt-routing.jsonl'));
    const resolvedPath = resolve(path);
    if (resolvedPath !== expectedPath) return;
    const parent = dirname(resolvedPath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentInfo = lstatSync(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) return;
    chmodSync(parent, 0o700);
    try {
      const fileInfo = lstatSync(resolvedPath);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) return;
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'ENOENT')) return;
    }
    appendFileSync(resolvedPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      component: 'session',
      event,
      ...fields,
    })}\n`, { mode: 0o600 });
    chmodSync(resolvedPath, 0o600);
  } catch {
    // Diagnostics must never affect Claude Code startup.
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

export {};
