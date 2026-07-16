import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const themeDir = join(root, 'themes', 'arrakis');
const outputDir = join(root, 'examples');
const apps = ['spotify', 'slack', 'vscode', 'claude', 'chatgpt'];

const [tokens, base] = await Promise.all([
  readFile(join(themeDir, 'tokens.css'), 'utf8'),
  readFile(join(themeDir, 'base-layout.css'), 'utf8'),
]);

await mkdir(outputDir, { recursive: true });

await Promise.all(apps.map(async app => {
  const adapter = await readFile(join(themeDir, 'adapters', `${app}.css`), 'utf8');
  const stylesheet = `/* Generated from themes/arrakis. Run npm run build:arrakis to refresh. */\n\n${tokens}\n${base}\n${adapter}`;
  await writeFile(join(outputDir, `${app}-arrakis.css`), stylesheet);
}));

console.log(`Generated ${apps.length} Arrakis stylesheets.`);
