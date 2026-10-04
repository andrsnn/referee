// Capture the README screenshots from a running server that has the demo project.
//   PLAYWRIGHT=/path/to/node_modules/playwright node docs/capture-screenshots.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT ? pathToFileURL(path.join(process.env.PLAYWRIGHT, 'index.mjs')).href : 'playwright');
const BASE = process.env.REFEREE_URL || 'http://127.0.0.1:4600';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
const P = 'fox-run-demo';
const shots = [
  ['01-projects', '', false],
  ['02-eval-detail', `${P}/evals/2`, true],
  ['03-evals', `${P}/evals`, false],
  ['04-gaps', `${P}/gaps`, false],
  ['05-refs', `${P}/refs`, false],
  ['06-chat', `${P}/chat/2`, true],
  ['07-overview', `${P}/overview`, false],
];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5, colorScheme: 'dark' });
for (const [name, hash, full] of shots) {
  await page.goto(`${BASE}/#${hash}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full });
  console.log('saved', name);
}
await browser.close();
