// Render a standalone SVG file (no page, no webfonts) and screenshot it, to prove it needs nothing external.
// usage: node svgcheck.mjs file.svg W H out.png
import { resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MJS || new URL('../../node_modules/playwright/index.mjs', import.meta.url).href);
const [, , svg, w, h, out] = process.argv;
const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const page = await browser.newPage();
await page.setViewportSize({ width: +w, height: +h });
const reqs = [];
page.on('request', (r) => { if (!r.url().startsWith('file://')) reqs.push(r.url()); });
await page.goto('file://' + resolve(svg));
await page.waitForTimeout(300);
await page.screenshot({ path: out, omitBackground: true });
console.log('external requests:', reqs.length ? reqs : 'none');
await browser.close();
