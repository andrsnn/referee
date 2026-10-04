// Playtest runner: started by server.mjs as a child process, one at a time.
// usage: node playtest-runner.mjs <scenario.mjs> <url> <outDir> <maxSeconds>
// Runs the scenario in headless Chromium (never a visible window), records a video, collects console errors and
// FPS samples, and writes <outDir>/report.json. The video is trimmed to start when the scenario says play began.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const [scenarioPath, url, outDir, maxArg] = process.argv.slice(2);
const maxSeconds = Number(maxArg) || 75;
const LOAD_SECONDS = Number(process.env.PLAYTEST_LOAD_SECONDS || 240);   // allowance for page + world load, on top of maxSeconds
// A module name ('playwright', resolved from this folder) or a path to playwright's index.mjs.
const PW = process.env.PLAYTEST_PLAYWRIGHT || 'playwright';
const ARGS = (process.env.PLAYTEST_BROWSER_ARGS || '').split(',').map(s => s.trim()).filter(Boolean);
fs.mkdirSync(outDir, { recursive: true });
const rawDir = path.join(outDir, 'raw');
const report = { ok: false, url, scenario: path.basename(scenarioPath), started: new Date().toISOString(), steps: [], console_errors: [], page_errors: [], failed_requests: [], fps: [], error: null, video: null, play_started_s: null };
const log = m => { const line = `${new Date().toISOString()} ${m}`; report.steps.push(line); console.log(line); };
const write = () => fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

let browser, context, page, video, t0 = 0;
const deadline = Date.now() + (maxSeconds + LOAD_SECONDS) * 1000;
const hardStop = setTimeout(() => { report.error = report.error || `runner exceeded ${maxSeconds + LOAD_SECONDS + 30}s`; write(); process.exit(3); }, (maxSeconds + LOAD_SECONDS + 30) * 1000);

try {
  const { chromium } = await import(/[\\/]/.test(PW) ? pathToFileURL(path.resolve(PW)).href : PW);
  const mod = await import(pathToFileURL(path.resolve(scenarioPath)).href);
  const scenario = mod.default;
  report.description = mod.description || '';
  browser = await chromium.launch({ headless: true, args: ARGS });   // always headless: no window opens
  context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: rawDir, size: { width: 1280, height: 720 } } });
  page = await context.newPage();
  t0 = Date.now();
  video = page.video();
  page.setDefaultTimeout(30000);
  page.on('console', m => { if (m.type() === 'error' && report.console_errors.length < 200) report.console_errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => { if (report.page_errors.length < 100) report.page_errors.push(String(e.message || e).slice(0, 300)); });
  page.on('response', r => { if (r.status() >= 400 && report.failed_requests.length < 100) report.failed_requests.push(`${r.status()} ${r.url().slice(0, 200)}`); });

  let playEnd = 0;
  const left = () => deadline - Date.now();
  const t = {
    page, url, log,
    wait: ms => page.waitForTimeout(Math.max(0, Math.min(ms, playEnd ? playEnd - Date.now() : left()))),
    // Click the first visible element whose text matches (button, link or anything clickable).
    clickText: async (re, timeout = 30000) => {
      const loc = page.getByRole('button', { name: re }).or(page.getByRole('link', { name: re })).or(page.getByText(re)).filter({ visible: true }).first();
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click({ timeout });
      log(`clicked ${re}`);
    },
    tryClickText: async (re, timeout = 5000) => { try { await t.clickText(re, timeout); return true; } catch { return false; } },
    waitGone: async (re, timeout = 150000) => {
      await page.waitForFunction(src => !new RegExp(src, 'i').test(document.body?.innerText || ''), re.source, { timeout, polling: 500 });
      log(`gone ${re}`);
    },
    hold: async (keys, ms) => {
      const ks = [].concat(keys);
      for (const k of ks) await page.keyboard.down(k);
      await t.wait(ms);
      for (const k of ks.reverse()) await page.keyboard.up(k);
    },
    press: async (key, after = 400) => { await page.keyboard.press(key); await t.wait(after); },
    look: async (dx, dy = 0, steps = 20) => {
      const box = { x: 640, y: 360 };
      await page.mouse.move(box.x, box.y);
      await page.mouse.move(box.x + dx, box.y + dy, { steps });
    },
    // Mark the moment real play begins: the video is trimmed to start here and the play clock starts.
    playing: () => { report.play_started_s = (Date.now() - t0) / 1000; playEnd = Date.now() + maxSeconds * 1000; log(`play started at ${report.play_started_s.toFixed(1)}s`); },
    timeLeft: () => playEnd ? playEnd - Date.now() : left(),
    // Frames per second over `seconds`, counted with requestAnimationFrame.
    fps: async (seconds = 5, label = '') => {
      const v = await page.evaluate(s => new Promise(res => { let n = 0; const end = performance.now() + s * 1000; const f = () => { n++; if (performance.now() < end) requestAnimationFrame(f); else res(n / s); }; requestAnimationFrame(f); }), seconds);
      const r = { label, fps: +v.toFixed(1) };
      report.fps.push(r); log(`fps ${label}: ${r.fps}`);
      return r.fps;
    },
  };
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log(`opened ${url}`);
  await scenario(t);
  if (!report.fps.length) await t.fps(5, 'end');
  report.ok = true;
} catch (e) {
  report.error = String(e?.stack || e).slice(0, 1500);
  log('ERROR ' + String(e?.message || e).split('\n')[0]);
  if (page) await page.screenshot({ path: path.join(outDir, 'failure.png') }).catch(() => { });
} finally {
  try { if (context) await context.close(); } catch { }
  try {
    if (video) {
      const raw = await video.path();
      const full = path.join(outDir, 'full.webm');
      fs.renameSync(raw, full);
      const out = path.join(outDir, 'playtest.mp4');
      const ss = Math.max(0, (report.play_started_s ?? 0) - 1);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', ss.toFixed(2), '-i', full, '-t', String(maxSeconds + 5), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', out], { stdio: 'pipe' });
      report.video = out;
    }
  } catch (e) { report.video_error = String(e?.message || e).slice(0, 300); }
  try { if (browser) await browser.close(); } catch { }
  report.finished = new Date().toISOString();
  write();
  clearTimeout(hardStop);
}
