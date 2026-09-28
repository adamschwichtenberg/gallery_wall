import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'fs';
const svg = readFileSync('public/icon.svg', 'utf8');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const size of [180, 192, 512]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await p.screenshot({ path: `public/icon-${size}.png` });
}
await b.close();
