export interface HostRoleCatalogEntry {
  app: string;
  description: string;
}

/**
 * Public, agent-readable catalog of the semantic DOM contract exposed by Attune.
 * Runtime resolver implementations live beside this catalog in the per-app
 * registries inside installHostMapper().
 */
export const HOST_ROLE_CATALOG: Record<string, HostRoleCatalogEntry> = {
  'document.root': { app: 'Document', description: 'The document element.' },
  'document.body': { app: 'Document', description: 'The document body.' },
  'codex.primaryChat': { app: 'Codex', description: 'The primary conversation surface.' },
  'codex.composer': { app: 'Codex', description: 'The prompt composer root.' },
  'codex.appShell': { app: 'Codex', description: 'The shell containing the primary chat and sidebar.' },
  'codex.timeline': { app: 'Codex', description: 'The conversation timeline scroller.' },
  'codex.chatActions': { app: 'Codex', description: 'The chat actions control.' },
  'codex.chatHeader': { app: 'Codex', description: 'The header for the active chat.' },
  'codex.sidebar': { app: 'Codex', description: 'The application sidebar.' },
  'codex.sidebarThreads': { app: 'Codex', description: 'The thread list inside the sidebar.' },
  'codex.modelPicker': { app: 'Codex', description: 'The model picker in the composer.' },
  'chatgpt.conversation': { app: 'ChatGPT', description: 'The active conversation surface.' },
  'chatgpt.composer': { app: 'ChatGPT', description: 'The prompt composer.' },
  'chatgpt.attachmentMenu': { app: 'ChatGPT', description: 'The attachment or upload menu.' },
  'linear.workspace': { app: 'Linear', description: 'The Linear application workspace.' },
  'linear.issueList': { app: 'Linear', description: 'The visible issue list.' },
  'linear.issueDetail': { app: 'Linear', description: 'The active issue detail surface.' },
  'linear.statusControl': { app: 'Linear', description: 'The issue status control.' },
  'slack.workspace': { app: 'Slack', description: 'The Slack workspace shell.' },
  'slack.composer': { app: 'Slack', description: 'The message composer.' },
  'slack.sendButton': { app: 'Slack', description: 'The message send control.' },
  'cursor.workbench': { app: 'Cursor', description: 'The editor workbench.' },
  'cursor.titlebar': { app: 'Cursor', description: 'The editor title bar.' },
  'youtube.player': { app: 'YouTube', description: 'The primary video player.' },
};

export const HOST_MAPPER_VERSION = 4;

/**
 * This function is serialized into the target renderer. Keep it self-contained:
 * it must not close over module state or imported values.
 */
function installHostMapper(bindingSets: unknown[], savedFingerprints: Record<string, unknown>) {
  type ElementLike = HTMLElement & {
    innerText?: string;
  };
  type Fingerprint = {
    tag: string;
    role: string;
    label: string;
    text: string;
    attributes: Record<string, string>;
    classes: string[];
    ancestor: { tag: string; role: string; label: string } | null;
    geometry: { horizontal: string; vertical: string; widthRatio: number; heightRatio: number } | null;
  };
  type Resolution = {
    element: ElementLike | null;
    method: 'deterministic' | 'fingerprint' | 'unavailable';
    confidence: number;
    runnerUp: number;
    evidence: string[];
  };
  type RoleDefinition = {
    description: string;
    candidates: string;
    resolve: (context: ResolverContext) => ElementLike | null;
  };
  type ResolverContext = {
    visible: (element: ElementLike | null | undefined) => boolean;
    first: (selector: string, root?: ParentNode) => ElementLike | null;
    resolve: (role: string) => ElementLike | null;
  };

  const fingerprintThreshold = 0.72;
  const fingerprintMargin = 0.12;
  const validationThreshold = 0.48;
  const mappedElements = new Map<string, ElementLike>();
  const resolutions = new Map<string, Resolution>();
  const learnedFingerprints = new Map<string, Fingerprint>();
  const listeners = new Set<(roles: string[]) => void>();
  let frame = 0;
  let disposed = false;

  const visible = (element: ElementLike | null | undefined) => {
    if (!element?.isConnected) return false;
    const bounds = element.getBoundingClientRect?.();
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
    return Boolean(bounds)
      && style?.display !== 'none'
      && style?.visibility !== 'hidden'
      && bounds.width > 0
      && bounds.height > 0;
  };
  const first = (selector: string, root: ParentNode = document) => {
    const candidates = [...root.querySelectorAll(selector)] as ElementLike[];
    return candidates.find(visible) || candidates[0] || null;
  };
  const compactText = (value: unknown, limit = 120) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const attributeValue = (element: ElementLike, name: string) => element.getAttribute?.(name) || '';
  const accessibleRole = (element: ElementLike) => attributeValue(element, 'role') || element.tagName?.toLowerCase() || '';
  const accessibleLabel = (element: ElementLike) => compactText(
    attributeValue(element, 'aria-label')
      || attributeValue(element, 'title')
      || attributeValue(element, 'placeholder'),
  );
  const region = (position: number, size: number) => {
    if (!size) return 'unknown';
    const ratio = position / size;
    return ratio < 0.34 ? 'start' : ratio > 0.66 ? 'end' : 'center';
  };
  const captureFingerprint = (element: ElementLike): Fingerprint => {
    const attributes: Record<string, string> = {};
    for (const name of [
      'id', 'role', 'aria-label', 'aria-labelledby', 'title', 'placeholder',
      'data-testid', 'data-qa', 'data-app-shell-main-surface',
      'data-codex-composer-root', 'data-app-action-timeline-scroll',
      'data-codex-intelligence-trigger',
    ]) {
      const value = attributeValue(element, name);
      if (value) attributes[name] = compactText(value, 160);
    }
    const classes = Array.from(element.classList || [])
      .filter(value => /^[a-z][a-z0-9_-]{2,48}$/i.test(value) && !/\d{3,}/.test(value))
      .slice(0, 8);
    const parent = element.parentElement as ElementLike | null;
    const bounds = element.getBoundingClientRect?.();
    const viewportWidth = Number(globalThis.innerWidth || document.documentElement?.clientWidth || 0);
    const viewportHeight = Number(globalThis.innerHeight || document.documentElement?.clientHeight || 0);
    return {
      tag: element.tagName?.toLowerCase() || '',
      role: accessibleRole(element),
      label: accessibleLabel(element),
      text: compactText(element.innerText || element.textContent, 160),
      attributes,
      classes,
      ancestor: parent ? {
        tag: parent.tagName?.toLowerCase() || '',
        role: accessibleRole(parent),
        label: accessibleLabel(parent),
      } : null,
      geometry: bounds && viewportWidth && viewportHeight ? {
        horizontal: region(bounds.x + bounds.width / 2, viewportWidth),
        vertical: region(bounds.y + bounds.height / 2, viewportHeight),
        widthRatio: Math.round((bounds.width / viewportWidth) * 100) / 100,
        heightRatio: Math.round((bounds.height / viewportHeight) * 100) / 100,
      } : null,
    };
  };
  const normalizedSimilarity = (left: string, right: string) => {
    if (!left || !right) return 0;
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.72;
    const leftWords = new Set(a.split(/\W+/).filter(Boolean));
    const rightWords = new Set(b.split(/\W+/).filter(Boolean));
    const intersection = [...leftWords].filter(word => rightWords.has(word)).length;
    const union = new Set([...leftWords, ...rightWords]).size;
    return union ? intersection / union : 0;
  };
  const compareFingerprint = (baseline: Fingerprint, element: ElementLike) => {
    const current = captureFingerprint(element);
    const contributions: Array<{ name: string; weight: number; value: number }> = [];
    if (baseline.tag) contributions.push({ name: 'tag', weight: 0.13, value: baseline.tag === current.tag ? 1 : 0 });
    if (baseline.role) contributions.push({ name: 'role', weight: 0.16, value: baseline.role === current.role ? 1 : 0 });
    if (baseline.label) contributions.push({ name: 'label', weight: 0.18, value: normalizedSimilarity(baseline.label, current.label) });
    if (baseline.text) contributions.push({ name: 'text', weight: 0.08, value: normalizedSimilarity(baseline.text, current.text) });
    const attributeEntries = Object.entries(baseline.attributes || {});
    if (attributeEntries.length) {
      const score = attributeEntries.reduce((sum, [name, value]) => (
        sum + normalizedSimilarity(value, current.attributes[name] || '')
      ), 0) / attributeEntries.length;
      contributions.push({ name: 'stable attributes', weight: 0.24, value: score });
    }
    if (baseline.classes?.length) {
      const overlap = baseline.classes.filter(value => current.classes.includes(value)).length / baseline.classes.length;
      contributions.push({ name: 'class tokens', weight: 0.07, value: overlap });
    }
    if (baseline.ancestor) {
      const ancestorScore = current.ancestor
        ? (Number(baseline.ancestor.tag === current.ancestor.tag)
          + Number(baseline.ancestor.role === current.ancestor.role)
          + normalizedSimilarity(baseline.ancestor.label, current.ancestor.label)) / 3
        : 0;
      contributions.push({ name: 'ancestor', weight: 0.09, value: ancestorScore });
    }
    if (baseline.geometry && current.geometry) {
      const locationScore = (
        Number(baseline.geometry.horizontal === current.geometry.horizontal)
        + Number(baseline.geometry.vertical === current.geometry.vertical)
      ) / 2;
      const sizeScore = 1 - Math.min(1, (
        Math.abs(baseline.geometry.widthRatio - current.geometry.widthRatio)
        + Math.abs(baseline.geometry.heightRatio - current.geometry.heightRatio)
      ) / 2);
      contributions.push({ name: 'geometry', weight: 0.05, value: (locationScore + sizeScore) / 2 });
    }
    const totalWeight = contributions.reduce((sum, item) => sum + item.weight, 0) || 1;
    const score = contributions.reduce((sum, item) => sum + item.weight * item.value, 0) / totalWeight;
    const evidence = contributions
      .filter(item => item.value >= 0.65)
      .sort((left, right) => right.weight * right.value - left.weight * left.value)
      .slice(0, 4)
      .map(item => item.name);
    return { score, evidence };
  };

  const primaryChatScore = (element: ElementLike) => {
    let score = element.tagName === 'MAIN' ? 1 : 0;
    if (element.hasAttribute?.('data-app-shell-main-surface')) score += 6;
    if (element.classList?.contains('main-surface')) score += 5;
    if (element.querySelector?.('[data-codex-composer-root]')) score += 4;
    if (element.querySelector?.('[data-app-action-timeline-scroll]')) score += 3;
    if (element.querySelector?.('button[aria-label="Chat actions"]')) score += 3;
    if (visible(element)) score += 1;
    return score;
  };
  const chatGptConversationScore = (element: ElementLike) => {
    let score = element.tagName === 'MAIN' || attributeValue(element, 'role') === 'main' ? 2 : 0;
    const messageCount = element.querySelectorAll?.(
      '[data-message-author-role], article[data-turn], [data-user-message-bubble]',
    ).length || 0;
    if (messageCount) score += Math.min(8, messageCount);
    if (element.querySelector?.('#prompt-textarea, form[data-type="unified-composer"], [data-lexical-editor="true"]')) score += 3;
    if (visible(element)) score += 1;
    return score;
  };

  let resolveRole = (_role: string): ElementLike | null => null;
  const context: ResolverContext = { visible, first, resolve: role => resolveRole(role) };

  // Registries are deliberately grouped by host app so an agent can discover,
  // extend, and test one application's semantic contract independently.
  const documentRoles: Record<string, RoleDefinition> = {
    'document.root': { description: 'The document element.', candidates: 'html', resolve: () => document.documentElement as ElementLike },
    'document.body': { description: 'The document body.', candidates: 'body', resolve: () => document.body as ElementLike },
  };
  const codexRoles: Record<string, RoleDefinition> = {
    'codex.primaryChat': {
      description: 'The primary conversation surface.', candidates: 'main, [role="main"], section',
      resolve: () => ([...document.querySelectorAll('main')] as ElementLike[])
        .map(element => ({ element, score: primaryChatScore(element) }))
        .filter(candidate => candidate.score >= 8)
        .sort((left, right) => right.score - left.score)[0]?.element || null,
    },
    'codex.composer': { description: 'The prompt composer root.', candidates: '[data-codex-composer-root], form, [contenteditable="true"]', resolve: c => c.first('[data-codex-composer-root]') },
    'codex.appShell': {
      description: 'The shell containing chat and sidebar.', candidates: 'main, [class*="shell"], #root > div',
      resolve: c => {
        const main = c.resolve('codex.primaryChat');
        const sidebar = c.resolve('codex.sidebar');
        return (main?.parentElement && (!sidebar || main.parentElement.contains(sidebar))
          ? main.parentElement : sidebar?.parentElement) as ElementLike || null;
      },
    },
    'codex.timeline': { description: 'The conversation timeline scroller.', candidates: '[data-app-action-timeline-scroll], main [role="log"], main', resolve: c => c.first('[data-app-action-timeline-scroll]') },
    'codex.chatActions': { description: 'The chat actions control.', candidates: 'button, [role="button"]', resolve: c => c.first('button[aria-label="Chat actions"]') },
    'codex.chatHeader': { description: 'The active chat header.', candidates: 'header, [role="banner"]', resolve: c => c.resolve('codex.chatActions')?.closest?.('header') as ElementLike || document.querySelector('.app-header-tint') as ElementLike || null },
    'codex.sidebar': { description: 'The application sidebar.', candidates: 'aside, nav, [role="navigation"]', resolve: () => ([...document.querySelectorAll('aside.app-shell-left-panel, aside')] as ElementLike[]).find(element => element.querySelector?.('[data-app-action-sidebar-scroll]') || visible(element)) || null },
    'codex.sidebarThreads': { description: 'The sidebar thread list.', candidates: '[data-app-action-sidebar-scroll], aside nav, aside', resolve: c => c.resolve('codex.sidebar')?.querySelector?.('[data-app-action-sidebar-scroll], nav') as ElementLike || c.resolve('codex.sidebar') },
    'codex.modelPicker': { description: 'The model picker.', candidates: '[data-codex-intelligence-trigger], button[aria-haspopup="menu"], [role="combobox"]', resolve: c => { const composer = c.resolve('codex.composer'); return c.first('[data-codex-intelligence-trigger]', composer || document) || c.first('button[aria-haspopup="menu"]', composer || document); } },
  };
  const chatgptRoles: Record<string, RoleDefinition> = {
    'chatgpt.conversation': { description: 'The active conversation surface.', candidates: 'main, [role="main"], section', resolve: () => ([...document.querySelectorAll('main, [role="main"]')] as ElementLike[]).map(element => ({ element, score: chatGptConversationScore(element) })).filter(candidate => candidate.score >= 3).sort((left, right) => right.score - left.score)[0]?.element || null },
    'chatgpt.composer': { description: 'The prompt composer.', candidates: '#prompt-textarea, form, [contenteditable="true"], textarea', resolve: c => c.first('#prompt-textarea, form[data-type="unified-composer"] textarea, form[data-type="unified-composer"] [contenteditable="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"], textarea') },
    'chatgpt.attachmentMenu': { description: 'The attachment menu.', candidates: '[role="menu"], [data-radix-popper-content-wrapper], .popover', resolve: () => ([...document.querySelectorAll('[data-radix-popper-content-wrapper] .popover, div.popover, [role="menu"]')] as ElementLike[]).find(element => visible(element) && /Add photos|Attach|Upload/i.test(element.textContent || '')) || null },
  };
  const linearRoles: Record<string, RoleDefinition> = {
    'linear.workspace': { description: 'The Linear workspace.', candidates: '[data-testid="app-shell"], #root, #app, body', resolve: () => document.querySelector('[data-testid="app-shell"], #root, #app') as ElementLike || document.body as ElementLike },
    'linear.issueList': { description: 'The visible issue list.', candidates: '[role="list"], [data-testid*="list" i], main', resolve: c => c.first('a[href*="/issue/"], a[href*="/team/"]')?.closest?.('[role="list"], [data-testid*="list" i], main') as ElementLike || c.resolve('linear.workspace') },
    'linear.issueDetail': { description: 'The active issue detail.', candidates: '[role="dialog"], main, [data-testid*="issue" i]', resolve: c => document.querySelector('[aria-label="Issue description"]')?.closest?.('[role="dialog"], main, [data-testid*="issue" i]') as ElementLike || (location.pathname.includes('/issue/') ? c.resolve('linear.workspace') : null) },
    'linear.statusControl': { description: 'The issue status control.', candidates: 'button, [role="button"], [role="combobox"]', resolve: () => ([...document.querySelectorAll('button, [role="button"]')] as ElementLike[]).find(element => visible(element) && /^(backlog|todo|in progress|started|done|completed)$/i.test(compactText(element.innerText || element.textContent))) || null },
  };
  const slackRoles: Record<string, RoleDefinition> = {
    'slack.workspace': { description: 'The Slack workspace shell.', candidates: '[data-qa="client_container"], .p-client, #client-ui, body', resolve: () => document.querySelector('[data-qa="client_container"], .p-client, #client-ui') as ElementLike || document.body as ElementLike },
    'slack.composer': { description: 'The message composer.', candidates: '[data-qa="texty_input"], [contenteditable="true"][role="textbox"]', resolve: c => c.first('[data-qa="texty_input"], [contenteditable="true"][role="textbox"]') },
    'slack.sendButton': { description: 'The message send control.', candidates: '[data-qa="texty_send_button"], button[aria-label*="send" i]', resolve: c => { const composer = c.resolve('slack.composer'); return composer?.closest?.('form, [data-qa*="message_input" i]')?.querySelector?.('[data-qa="texty_send_button"], button[aria-label*="send" i]') as ElementLike || c.first('[data-qa="texty_send_button"], button[aria-label*="send" i]'); } },
  };
  const cursorRoles: Record<string, RoleDefinition> = {
    'cursor.workbench': { description: 'The editor workbench.', candidates: '.monaco-workbench, #workbench, body', resolve: () => document.querySelector('.monaco-workbench') as ElementLike || document.body as ElementLike },
    'cursor.titlebar': { description: 'The editor title bar.', candidates: '.part.titlebar, [role="banner"], header', resolve: c => c.first('.monaco-workbench .part.titlebar, .part.titlebar') },
  };
  const youtubeRoles: Record<string, RoleDefinition> = {
    'youtube.player': { description: 'The primary video player.', candidates: 'video, #movie_player', resolve: c => c.first('video.html5-main-video, #movie_player video, video') },
  };
  const registry: Record<string, RoleDefinition> = Object.assign(
    {}, documentRoles, codexRoles, chatgptRoles, linearRoles, slackRoles, cursorRoles, youtubeRoles,
  );

  for (const [role, value] of Object.entries(savedFingerprints || {})) {
    if (value && typeof value === 'object') learnedFingerprints.set(role, value as Fingerprint);
  }

  const findByFingerprint = (definition: RoleDefinition, baseline: Fingerprint): Resolution => {
    let candidates: ElementLike[] = [];
    try {
      candidates = [...document.querySelectorAll(definition.candidates)] as ElementLike[];
    } catch {}
    if (candidates.length < 2) {
      try {
        candidates = [...new Set([...candidates, ...document.querySelectorAll('body *')])] as ElementLike[];
      } catch {}
    }
    const ranked = candidates.slice(0, 3000)
      .map(element => ({ element, ...compareFingerprint(baseline, element) }))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const runnerUp = ranked[1]?.score || 0;
    if (!best || best.score < fingerprintThreshold || best.score - runnerUp < fingerprintMargin) {
      return { element: null, method: 'unavailable', confidence: best?.score || 0, runnerUp, evidence: best?.evidence || [] };
    }
    return { element: best.element, method: 'fingerprint', confidence: best.score, runnerUp, evidence: best.evidence };
  };

  const resolving = new Set<string>();
  resolveRole = (role: string) => {
    if (mappedElements.has(role)) return mappedElements.get(role)!;
    const definition = registry[role];
    if (!definition || resolving.has(role)) return null;
    resolving.add(role);
    try {
      const baseline = learnedFingerprints.get(role);
      let deterministic: ElementLike | null = null;
      try { deterministic = definition.resolve(context); } catch {}
      if (deterministic) {
        const comparison = baseline ? compareFingerprint(baseline, deterministic) : null;
        if (!comparison || comparison.score >= validationThreshold) {
          resolutions.set(role, {
            element: deterministic,
            method: 'deterministic',
            confidence: comparison?.score ?? 1,
            runnerUp: 0,
            evidence: comparison?.evidence || ['resolver'],
          });
          return deterministic;
        }
      }
      if (baseline) {
        const fallback = findByFingerprint(definition, baseline);
        resolutions.set(role, fallback);
        return fallback.element;
      }
      resolutions.set(role, { element: null, method: 'unavailable', confidence: 0, runnerUp: 0, evidence: [] });
      return null;
    } finally {
      resolving.delete(role);
    }
  };

  type ActiveBindingSet = {
    schemaVersion: number;
    attunementId: string;
    appName: string;
    bindings: Array<{ name: string; role: string; required: boolean }>;
  };
  let activeBindingSets = bindingSets as ActiveBindingSet[];
  const requestedRoles = new Set(activeBindingSets
    .flatMap(set => set.bindings || []).map(binding => binding.role).filter((role): role is string => Boolean(role)));
  const setElementRoles = (element: ElementLike, roles: Set<string>) => {
    if (roles.size) element.setAttribute('data-attune-host-roles', [...roles].sort().join(' '));
    else element.removeAttribute('data-attune-host-roles');
  };
  const reconcile = () => {
    if (disposed) return;
    const previous = new Map(mappedElements);
    const rolesByElement = new Map<ElementLike, Set<string>>();
    mappedElements.clear();
    resolutions.clear();
    for (const role of requestedRoles) {
      const element = resolveRole(role);
      if (!element) continue;
      mappedElements.set(role, element);
      learnedFingerprints.set(role, captureFingerprint(element));
      const roles = rolesByElement.get(element) || new Set<string>();
      roles.add(role);
      rolesByElement.set(element, roles);
    }
    for (const element of new Set(previous.values())) {
      if (!rolesByElement.has(element)) setElementRoles(element, new Set());
    }
    for (const [element, roles] of rolesByElement) setElementRoles(element, roles);
    const reports = Object.fromEntries(activeBindingSets.map(set => {
      const capabilities = Object.fromEntries(set.bindings.map(binding => {
        const resolution = resolutions.get(binding.role);
        return [binding.name, {
          role: binding.role,
          required: binding.required,
          status: mappedElements.has(binding.role) ? 'available' : 'unavailable',
          method: resolution?.method || 'unavailable',
          confidence: Math.round((resolution?.confidence || 0) * 100) / 100,
          runnerUp: Math.round((resolution?.runnerUp || 0) * 100) / 100,
          evidence: resolution?.evidence || [],
        }];
      }));
      const missingRequired = set.bindings.filter(binding => binding.required && !mappedElements.has(binding.role)).map(binding => binding.role);
      return [set.attunementId, {
        schemaVersion: set.schemaVersion,
        appName: set.appName,
        status: missingRequired.length ? 'unavailable'
          : Object.values(capabilities).some((capability: any) => capability.status === 'unavailable') ? 'degraded' : 'compatible',
        missingRequired,
        capabilities,
        checkedAt: Date.now(),
      }];
    }));
    (window as any).__attuneCompatibilityReports = reports;
    const changes = [...requestedRoles].filter(role => previous.get(role) !== mappedElements.get(role));
    if (changes.length) {
      for (const listener of listeners) {
        try { listener(changes); } catch (error) { console.warn('[attune] host mapping listener failed', error); }
      }
      window.dispatchEvent(new CustomEvent('attune:host-mappings-changed', { detail: { roles: changes } }));
    }
  };
  const schedule = () => {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => { frame = 0; reconcile(); });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  reconcile();

  return {
    resolve: (role: string) => mappedElements.get(role) || null,
    describe: (role: string) => registry[role] ? { role, description: registry[role].description } : null,
    roles: () => Object.keys(registry),
    report: (attunementId: string) => (window as any).__attuneCompatibilityReports?.[attunementId] || null,
    fingerprints: () => Object.fromEntries(learnedFingerprints),
    request: (set: ActiveBindingSet) => {
      if (!set || typeof set.attunementId !== 'string' || !Array.isArray(set.bindings)) return null;
      const validBindings = set.bindings.filter(binding => (
        binding && typeof binding.name === 'string' && typeof binding.role === 'string'
      ));
      activeBindingSets = [
        ...activeBindingSets.filter(candidate => candidate.attunementId !== set.attunementId),
        { ...set, bindings: validBindings },
      ];
      for (const binding of validBindings) requestedRoles.add(binding.role);
      reconcile();
      return (window as any).__attuneCompatibilityReports?.[set.attunementId] || null;
    },
    subscribe: (listener: (roles: string[]) => void) => {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconcile,
    cleanup: () => {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      for (const element of new Set(mappedElements.values())) setElementRoles(element, new Set());
      mappedElements.clear();
      listeners.clear();
    },
  };
}

export function getHostMapperInstallerSource(): string {
  return installHostMapper.toString();
}

export function buildHostFingerprintProbeExpression(): string {
  return `(() => window.__attuneHost?.fingerprints?.() || {})()`;
}
