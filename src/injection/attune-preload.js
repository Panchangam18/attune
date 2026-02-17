'use strict';

// --- Attune Preload ---
// This script is injected into the target Electron app's renderer process.
// It reads custom CSS from a config file and injects it into the page.
// A MutationObserver ensures the styles persist through SPA navigation.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.ATTUNE_CONFIG_PATH || '';
const ORIGINAL_PRELOAD = process.env.ATTUNE_ORIGINAL_PRELOAD || '';

const STYLE_ID = 'attune-custom-styles';

// --- Load config ---
function loadConfig() {
  try {
    if (CONFIG_PATH && fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('[Attune] Failed to load config:', e);
  }
  return { css: '', enabled: true };
}

// --- CSS injection ---
let currentCSS = '';

function injectCSS(css) {
  if (!css) return;
  currentCSS = css;

  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    el.setAttribute('data-attune', 'true');
  }
  el.textContent = css;

  const target = document.head || document.documentElement;
  if (!target.contains(el)) {
    target.appendChild(el);
  }
}

// --- MutationObserver to re-inject if SPA navigation removes our style ---
function watchForRemoval() {
  const observer = new MutationObserver(() => {
    if (currentCSS && !document.getElementById(STYLE_ID)) {
      injectCSS(currentCSS);
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

// --- Initialize ---
function initialize() {
  const config = loadConfig();
  if (!config.enabled) return;

  if (config.css) {
    injectCSS(config.css);
  }

  watchForRemoval();
  console.log('[Attune] Custom styles applied.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}

// --- Chain-load the original preload script ---
if (ORIGINAL_PRELOAD && fs.existsSync(ORIGINAL_PRELOAD)) {
  try {
    require(ORIGINAL_PRELOAD);
  } catch (e) {
    console.error('[Attune] Failed to load original preload:', e);
  }
}
