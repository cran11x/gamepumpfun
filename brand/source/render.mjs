// AMONG RUGS brand renderer.
// usage: node render.mjs <page.html[#hash]> <W> <H> <out.png> [transparent=0|1] [scale=1] [svgOut]
// Pages build their SVG after fonts load and then set window.READY = true.
// If svgOut is given, the page's window.exportSVG() string is written there too.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const PW = process.env.PLAYWRIGHT_MJS || new URL('../../node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(PW);
const [, , pageArg, w, h, out, transparent = '0', scale = '1', svgOut] = process.argv;
const [file, hash] = pageArg.split('#');
const url = 'file://' + resolve(file) + (hash ? '#' + hash : '');
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ proxy, args: ['--ignore-certificate-errors'] });
const page = await browser.newPage({ deviceScaleFactor: +scale });
await page.setViewportSize({ width: +w, height: +h });
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[err]', e.message));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.READY === true, null, { timeout: 30000 });
await page.evaluate(() => document.fonts.ready);
const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family + ':' + f.weight));
console.log('fonts loaded:', [...new Set(fonts)].join(' | ') || 'NONE');
await page.waitForTimeout(150);
await page.screenshot({ path: out, omitBackground: transparent === '1', clip: { x: 0, y: 0, width: +w, height: +h } });
if (svgOut) {
  const svg = await page.evaluate(() => window.exportSVG());
  writeFileSync(svgOut, svg);
  console.log('svg written', svgOut, svg.length, 'bytes');
}
await browser.close();
console.log('wrote', out);
