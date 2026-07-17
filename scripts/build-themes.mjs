import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const themesDir = join(root, 'themes');
const outputDir = join(root, 'examples');
const requestedThemeIds = new Set(process.argv.slice(2));

const entries = await readdir(themesDir, { withFileTypes: true });
const themeIds = entries
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => entry.name)
  .filter((themeId) => requestedThemeIds.size === 0 || requestedThemeIds.has(themeId));

await mkdir(outputDir, { recursive: true });

let generatedCount = 0;

for (const themeId of themeIds) {
  const themeDir = join(themesDir, themeId);
  const manifestPath = join(themeDir, 'manifest.json');
  try {
    await access(manifestPath);
  } catch {
    continue;
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const [tokens, base] = await Promise.all([
    manifest.tokens ? readCssSource(join(root, manifest.tokens)) : '',
    manifest.baseLayout ? readCssSource(join(root, manifest.baseLayout)) : '',
  ]);

  for (const adapter of Object.values(manifest.adapters ?? {})) {
    if (!adapter.source || !adapter.output) continue;

    const source = await readCssSource(join(root, adapter.source));
    const stylesheet = `/* Generated from themes/${themeId}. Run npm run build:themes to refresh. */\n\n${tokens}\n${base}\n${source}`;
    await writeFile(join(root, adapter.output), stylesheet);
    generatedCount += 1;
  }
}

console.log(`Generated ${generatedCount} theme stylesheets.`);

async function readCssSource(sourcePath) {
  const css = await readFile(sourcePath, 'utf8');
  return inlineLocalUrls(css, dirname(sourcePath));
}

async function inlineLocalUrls(css, baseDir) {
  let output = css;
  const urls = [...css.matchAll(/url\((["']?)([^"')]+)\1\)/g)];

  for (const match of urls) {
    const [fullMatch, , rawUrl] = match;
    if (/^(?:data:|https?:|file:|#)/i.test(rawUrl)) continue;

    const assetPath = resolve(baseDir, rawUrl);
    const mediaType = mediaTypeFor(assetPath);
    if (!mediaType) continue;

    const asset = await readFile(assetPath);
    output = output.replace(fullMatch, `url("data:${mediaType};base64,${asset.toString('base64')}")`);
  }

  return output;
}

function mediaTypeFor(path) {
  switch (extname(path).toLowerCase()) {
    case '.ttf':
      return 'font/ttf';
    case '.otf':
      return 'font/otf';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return null;
  }
}
