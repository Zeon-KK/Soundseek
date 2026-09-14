/**
 * Rendert die PNG-Varianten des App-Icons aus icons/icon.svg.
 * Nur beim Ändern des Icons nötig:  node scripts/build-icons.mjs
 */
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(resolve(root, 'icons/icon.svg'), 'utf8');

// Maskable-Icons werden rund beschnitten: das Motiv muss in die inneren 80 %.
const maskable = svg
  .replace('<rect width="512" height="512" rx="112"', '<rect width="512" height="512" rx="0"')
  .replace(
    /(<rect[^>]*\/>)/,
    '$1<g transform="translate(256 256) scale(0.74) translate(-256 -256)">',
  )
  .replace('</svg>', '</g></svg>');

const targets = [
  { file: 'icons/icon-192.png', size: 192, source: svg },
  { file: 'icons/icon-512.png', size: 512, source: svg },
  { file: 'icons/apple-touch-icon.png', size: 180, source: svg },
  { file: 'icons/maskable-512.png', size: 512, source: maskable },
];

const browser = await chromium.launch();
const page = await browser.newPage();

for (const { file, size, source } of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0">${source.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`,
  );
  const png = await page.screenshot({ omitBackground: true });
  await writeFile(resolve(root, file), png);
  console.log(`${file}  ${size}x${size}  ${png.length} B`);
}

await browser.close();
