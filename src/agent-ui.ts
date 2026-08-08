import { HOST_ROLE_CATALOG } from './host-roles.js';

export interface AgentStyleSource {
  source: string;
  css: string;
  roles: string[];
  attunementId: string;
}

const HOST_ROLE_SELECTOR_RE = /\[data-attune-host-roles\s*~=\s*(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]/g;

export function buildAgentStyleSource(appId: string, appName: string, css: string): AgentStyleSource {
  const normalizedCss = css.trim();
  const roles = extractSemanticRoles(normalizedCss);
  const unknownRoles = roles.filter(role => !HOST_ROLE_CATALOG[role]);
  if (unknownRoles.length) {
    throw new Error(`Unknown Attune semantic role${unknownRoles.length === 1 ? '' : 's'}: ${unknownRoles.join(', ')}`);
  }

  const attunementId = `agent-style:${appId}`;
  if (!normalizedCss || roles.length === 0) {
    return { source: normalizedCss, css: normalizedCss, roles, attunementId };
  }

  const bindings = roles.map(role => ({ name: role, role, required: true }));
  const metadata = JSON.stringify({
    schemaVersion: 2,
    attunementId,
    appName,
    bindings,
  });
  return {
    source: `/* @attune-bindings\n${metadata}\n@end-attune-bindings */\n\n${normalizedCss}`,
    css: normalizedCss,
    roles,
    attunementId,
  };
}

export function extractSemanticRoles(css: string): string[] {
  const roles = new Set<string>();
  for (const match of css.matchAll(HOST_ROLE_SELECTOR_RE)) {
    const role = match[1] || match[2] || match[3];
    if (role) roles.add(role);
  }
  return [...roles].sort();
}

export function getRoleCatalogForApp(appName: string, bundleId: string | null): Record<string, { app: string; description: string }> {
  const normalized = `${appName} ${bundleId ?? ''}`.toLowerCase();
  const appLabels = new Set(['Document']);
  if (/chatgpt|codex|com\.openai\.codex/.test(normalized)) {
    appLabels.add('ChatGPT');
    appLabels.add('Codex');
  }
  if (/cursor|visual studio code|vscode|com\.microsoft\.vscode/.test(normalized)) appLabels.add('Cursor');
  if (/slack|tinyspeck/.test(normalized)) appLabels.add('Slack');
  if (/linear/.test(normalized)) appLabels.add('Linear');
  if (/chrome|youtube/.test(normalized)) appLabels.add('YouTube');

  return Object.fromEntries(Object.entries(HOST_ROLE_CATALOG).filter(([, entry]) => appLabels.has(entry.app)));
}
