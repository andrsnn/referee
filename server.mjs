// Art Director: a code-blind visual judge for autonomous coding agents.
// Projects hold target refs (images/videos), a description, and scoring criteria.
// Evals send candidate images/videos/PDFs; a vision LLM (Claude via the `claude` CLI, or any
// OpenAI-compatible endpoint) scores them against the refs and a persistent gap ledger, so feedback
// stays consistent across rounds.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
// Order of precedence: environment variable > config.json (or the file in ARTDIR_CONFIG) > default.
// See config.example.json and the README for every key.
const CONFIG_FILE = process.env.ARTDIR_CONFIG || path.join(ROOT, 'config.json');
const FILE_CFG = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } })();
const cfg = (key, env, def) => process.env[env] ?? FILE_CFG[key] ?? def;

const DATA = path.resolve(ROOT, cfg('data_dir', 'ARTDIR_DATA', 'data'));
const PORT = Number(cfg('port', 'ARTDIR_PORT', 4600));
const HOST = cfg('host', 'ARTDIR_HOST', '127.0.0.1');   // no auth: keep it on localhost unless you trust the network
const DEFAULT_BACKEND = cfg('default_backend', 'ARTDIR_BACKEND', 'claude');
const CLAUDE_BIN = cfg('claude_bin', 'ARTDIR_CLAUDE_BIN', 'claude');
const CLAUDE_MODEL = cfg('claude_model', 'ARTDIR_CLAUDE_MODEL', 'sonnet');
const OPENAI_URL = cfg('openai_url', 'ARTDIR_OPENAI_URL', 'http://127.0.0.1:8000/v1/chat/completions');
const OPENAI_MODEL = cfg('openai_model', 'ARTDIR_OPENAI_MODEL', 'local-vision-model');
const OPENAI_KEY = cfg('openai_api_key', 'ARTDIR_OPENAI_API_KEY', '');
const PYTHON = cfg('python', 'ARTDIR_PYTHON', 'python');
const JUDGE_TIMEOUT_MS = Number(cfg('judge_timeout_min', 'ARTDIR_JUDGE_TIMEOUT_MIN', 20)) * 60000;
const SUPERVISE_EVERY_MS = Number(cfg('supervise_every_min', 'ARTDIR_SUPERVISE_EVERY_MIN', 10)) * 60000;
// Backend names: 'claude' (Claude Code CLI, falls back to openai) and 'openai' (OpenAI-compatible endpoint only).
const normBackend = b => (b === 'claude' || b === 'openai') ? b : DEFAULT_BACKEND;

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.webp', '.bmp', '.gif']);
const VID_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);
// A gap still open after this many evals is 'stuck': it leads the reply and the priority list.
const STUCK_AFTER = Number(cfg('stuck_after', 'ARTDIR_STUCK_AFTER', 5));
// Returned with every eval so every agent gets the same working rules. Override per project with settings.agent_rules.
const AGENT_RULES = cfg('agent_rules', 'ARTDIR_AGENT_RULES', 'Spend most of your time building visible, user-facing features. Ask for a judgement after a meaningful feature milestone, not after every small change. Capture with one reusable script: a short video of real use plus up to 8 stills of what changed. Do not produce bespoke evidence, audits, proof documents or measurements for the judge. Work next_round.plan first, then the top_priorities in order; skip small polish, the judge tracks the rest. Include the capture_requests (at most 3) in your next capture. Rounds that mostly repeat the previous images are rejected. A gap is fixed only when a later eval marks it closed. Never edit gaps, criteria, refs or calibration yourself.');
const TXT_EXT = new Set(['.md', '.txt']);   // speaker notes, scripts, written answers
const PDF_EXT = new Set(['.pdf']);

fs.mkdirSync(path.join(DATA, 'projects'), { recursive: true });

// ---------- storage ----------
const pdir = id => path.join(DATA, 'projects', id);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const loadProject = id => readJson(path.join(pdir(id), 'project.json'), null);
const saveProject = p => writeJson(path.join(pdir(p.id), 'project.json'), p);
const loadGaps = id => readJson(path.join(pdir(id), 'gaps.json'), []);
const saveGaps = (id, g) => writeJson(path.join(pdir(id), 'gaps.json'), g);
const listEvals = id => {
  const d = path.join(pdir(id), 'evals');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(n => /^\d+$/.test(n)).sort((a, b) => a - b)
    .map(n => readJson(path.join(d, n, 'result.json'), null)).filter(Boolean);
};
const slug = s => String(s || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';

// ---------- media ----------
function ffmpeg(args) { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'pipe' }); }
function videoDuration(f) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim();
  return Number(out) || 0;
}
// Normalise an image to a JPEG with max width; returns the output path.
function toJpeg(src, dst, maxW) {
  ffmpeg(['-i', src, '-vf', `scale='min(${maxW},iw)':-2`, '-frames:v', '1', '-q:v', '3', dst]);
  return dst;
}
// Pull N evenly spaced frames out of a video.
function videoFrames(src, outDir, base, n, maxW) {
  const dur = videoDuration(src);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = dur > 0 ? (dur * (i + 0.5)) / n : i;
    const dst = path.join(outDir, `${base}_f${String(i + 1).padStart(2, '0')}.jpg`);
    try { ffmpeg(['-ss', t.toFixed(2), '-i', src, '-frames:v', '1', '-vf', `scale='min(${maxW},iw)':-2`, '-q:v', '3', dst]); out.push({ file: dst, t: +t.toFixed(1) }); } catch { }
  }
  return out;
}
// Ingest a list of {path} or {name, base64} into a directory as JPEGs. Videos become frames.
function ingest(items, outDir, { maxW, framesPerVideo, note }) {
  fs.mkdirSync(outDir, { recursive: true });
  const added = [];
  for (const it of items) {
    let src = it.path, tmp = null;
    if (!src && it.base64) {
      tmp = path.join(os.tmpdir(), `artdir-${crypto.randomUUID()}${path.extname(it.name || '.png')}`);
      fs.writeFileSync(tmp, Buffer.from(it.base64, 'base64'));
      src = tmp;
    }
    if (!src || !fs.existsSync(src)) { added.push({ error: `missing: ${it.path || it.name}` }); continue; }
    const ext = path.extname(src).toLowerCase();
    const base = slug(path.basename(src, ext)) + '-' + crypto.randomBytes(2).toString('hex');
    const label = it.note || note || '';
    if (VID_EXT.has(ext)) {
      const frames = videoFrames(src, outDir, base, it.frames || framesPerVideo, maxW);
      for (const f of frames) added.push({ file: path.basename(f.file), source: path.basename(src), kind: 'video-frame', t: f.t, note: label });
    } else if (PDF_EXT.has(ext)) {
      const r = spawnSync(`"${PYTHON}" "${path.join(ROOT, 'pdf2png.py')}" "${src}" "${outDir}" "${base}" ${maxW}`, { shell: true, encoding: 'utf8' });
      const pages = (r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(l => /\.jpg$/i.test(l) && fs.existsSync(l));
      if (!pages.length) added.push({ error: `pdf render failed: ${(r.stderr || '').slice(0, 200)}` });
      pages.forEach((f, i) => added.push({ file: path.basename(f), source: `${path.basename(src)} p${i + 1}`, kind: 'pdf-page', note: label }));
    } else if (TXT_EXT.has(ext)) {
      const dst = path.join(outDir, base + ext);
      fs.copyFileSync(src, dst);
      added.push({ file: path.basename(dst), source: path.basename(src), kind: 'text', note: label });
    } else if (IMG_EXT.has(ext)) {
      const dst = path.join(outDir, base + '.jpg');
      toJpeg(src, dst, maxW);
      added.push({ file: path.basename(dst), source: path.basename(src), kind: 'image', note: label });
    } else added.push({ error: `unsupported type: ${src}` });
    if (tmp) fs.rmSync(tmp, { force: true });
  }
  return added;
}
// Expand a directory path into its media files.
function expandPaths(items) {
  const out = [];
  for (const it of items) {
    const o = typeof it === 'string' ? { path: it } : it;
    if (o.path && fs.existsSync(o.path) && fs.statSync(o.path).isDirectory()) {
      for (const n of fs.readdirSync(o.path).sort()) {
        const e = path.extname(n).toLowerCase();
        if (IMG_EXT.has(e) || VID_EXT.has(e) || PDF_EXT.has(e) || TXT_EXT.has(e)) out.push({ ...o, path: path.join(o.path, n) });
      }
    } else out.push(o);
  }
  return out;
}
// Evenly sample k items from a list (keeps every source represented in order).
// Replace each video's frames with one 3-column sheet of up to 6 frames, so a capped candidate set
// still shows every clip as a sequence over time instead of one frozen frame.
function videoSheets(list, dir) {
  const out = [], done = new Set();
  for (const c of list) {
    if (c.kind !== 'video-frame') { out.push(c); continue; }
    if (done.has(c.source)) continue;
    done.add(c.source);
    const frames = sample(list.filter(x => x.kind === 'video-frame' && x.source === c.source), 6);
    if (frames.length < 2) { out.push(...frames); continue; }
    const tmp = path.join(os.tmpdir(), `artdir-sheet-${crypto.randomUUID()}`);
    fs.mkdirSync(tmp);
    try {
      frames.forEach((f, i) => fs.copyFileSync(path.join(dir, f.file), path.join(tmp, `${String(i + 1).padStart(2, '0')}.jpg`)));
      const file = c.file.replace(/_f\d+\.jpg$/, '') + '_sheet.jpg';
      ffmpeg(['-i', path.join(tmp, '%02d.jpg'), '-vf', `scale=640:-2,tile=3x${Math.ceil(frames.length / 3)}:padding=4`, '-frames:v', '1', '-q:v', '3', path.join(dir, file)]);
      out.push({ file, source: c.source, kind: 'video-sheet', ts: frames.map(f => f.t), note: c.note });
    } catch { out.push(...frames); }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return out;
}
function sample(list, k) {
  if (list.length <= k) return list;
  const out = [];
  for (let i = 0; i < k; i++) out.push(list[Math.floor((i * list.length) / k)]);
  return out;
}

// Refs for an eval: every pinned ref, then an even sample of the rest up to max_refs.
function pickRefs(all, max) {
  const pinned = all.filter(r => r.pinned), rest = all.filter(r => !r.pinned);
  return [...pinned, ...sample(rest, Math.max(0, max - pinned.length))];
}

// ---------- prompt ----------
function buildPrompt(p, gaps, history, refs, cands, prev, texts = []) {
  const brief = refs.length === 0;   // no refs: judge against the brief (decks, docs, written answers)
  const crit = p.criteria.map(c => `- ${c.key} (weight ${c.weight ?? 1}): ${c.description}`).join('\n');
  const open = gaps.filter(g => g.status !== 'closed');
  const ledger = open.length
    ? open.map(g => `- ${g.id} [${g.criterion}] (seen ${g.seen}x, first eval ${g.first_eval})${g.seen >= STUCK_AFTER ? ' STUCK: check this one carefully; close it if it is really fixed, otherwise describe exactly what is still wrong in its note' : ''}: ${g.text}`).join('\n')
    : '(none yet)';
  const hist = history.slice(-5).map(e => `- eval ${e.n}${e.label ? ` (${e.label})` : ''}: ` +
    p.criteria.map(c => `${c.key}=${e.scores?.[c.key]?.owner_score ?? e.scores?.[c.key]?.score ?? '?'}${e.scores?.[c.key]?.owner_score != null ? '(owner-corrected)' : ''}`).join(' ') + ` overall=${e.overall}`).join('\n') || '(first eval)';
  const calib = (p.calibration || []).filter(c => c.active !== false);
  const calibBlock = calib.length ? `\nOWNER CALIBRATION (from the project owner; authoritative, apply every one):\n${calib.map(c => `- ${c.criterion ? `[${c.criterion}] ` : ''}${c.text}`).join('\n')}\n` : '';
  const recentOverall = history.slice(-4).map(e => e.owner_overall ?? e.overall);
  const stalled = recentOverall.length >= 4 && Math.max(...recentOverall.slice(1)) <= recentOverall[0] + 0.1;
  const stallBlock = stalled ? `
PROGRESS HAS STALLED: overall has not improved over the last ${recentOverall.length - 1} evals (${recentOverall.join(' -> ')}). Small fixes are not moving the score. next_round.plan must name big, user-visible features that are missing entirely, not polish.
` : '';
  const imgList = (arr, tag) => arr.map((x, i) => `${tag}${i + 1}: ${x.source}${x.ts ? ` — video sheet, ${x.ts.length} frames in time order left to right, top to bottom, at ${x.ts.join('s, ')}s` : x.t != null ? ` @${x.t}s` : ''}${x.pinned ? ' [key ref]' : ''}${x.note ? ` — ${x.note}` : ''}`).join('\n');
  const textBlock = texts.length ? `
CANDIDATE TEXT (speaker notes, script or written material that goes with the candidate):
${texts.map(t => `--- ${t.source} ---
${t.content}`).join('\n\n')}
` : '';
  return `${brief
    ? 'You are a strict judge of a deliverable (for example a slide deck), shown to you as images of its pages and any accompanying text. Judge it as the stated audience would experience it. You know nothing about how it was made; judge only what is shown.'
    : 'You are a strict, code-blind VISUAL judge. You only see images. You know nothing about how the candidate was made, and you must not guess at code, engines or implementation. Judge only what is visible. Judge the result as a player or user sees it in use; never ask for or reward logs, measurements, audits or written proof.'}

PROJECT: ${p.name}
WHAT IS BEING BUILT:
${p.description}

${brief ? 'REFERENCES: none. Judge against the brief above, the criteria and the audience it describes.' : `TARGET REFERENCES (ground truth, what the result should look like):
${imgList(refs, 'R')}`}

CANDIDATE IMAGES (the current build, judge these):
${imgList(cands, 'C')}
${textBlock}${prev.length ? `\nPREVIOUS-EVAL CANDIDATES (the last build you judged, for before/after comparison only):\n${imgList(prev, 'P')}\n` : ''}
CRITERIA (score each 0-10):
${crit}
${calibBlock}${stallBlock}
SCORE SCALE: ${brief
    ? '0-2 unusable; 3-4 weak, the audience would be unconvinced; 5-6 adequate but with clear problems; 7-8 strong, the audience would be impressed; 9-10 exceptional, nothing material to change.'
    : '0-2 nothing like the refs; 3-4 same genre but clearly wrong look; 5-6 recognisably the same kind of scene with obvious differences; 7-8 a casual viewer could confuse it with the refs; 9-10 indistinguishable from the refs.'}

SCORE HISTORY (for calibration only; score the current images on their own merits). Use half points (e.g. 6.5). When a ledger gap for a criterion is improved or closed, that criterion should usually rise by 0.5-1; when a gap gets worse or a new severe gap appears, it should fall. Never copy the previous scores unchanged unless the images really look the same:
${hist}

OPEN GAP LEDGER (${brief ? 'problems' : 'visual differences'} found in earlier evals):
${ledger}

${history.at(-1)?.capture_requests?.length ? `CAPTURES YOU REQUESTED LAST EVAL (check whether this candidate set now includes them; if not, repeat only the most important one, and lower coverage only if a core feature cannot be judged at all):\n${history.at(-1).capture_requests.map(r => `- ${r}`).join('\n')}\n\n` : ''}TASK:
1. ${brief ? 'Read every page and any candidate text against the brief.' : 'Compare the candidates with the references.'} Where a previous version is shown, compare against it too.
2. Score every criterion. Give a one-sentence reason naming the candidate page/image (C1, C2...)${brief ? '' : ' and reference (R1...)'}.
3. For EVERY open ledger gap, decide: "open" (still visible), "improved" (better but still visible), or "closed" (no longer visible). One short note each.
4. List NEW gaps not already in the ledger (at most 5). Each is one concrete visible difference a non-programmer could check by looking, e.g. "no fog or haze: the distance is crisp and clear where the refs fade into thick mist" or "the hero fills a third of the frame; the refs show characters small at a top-down distance". Do not repeat a ledger gap with new words.
5. CONSOLIDATE the ledger: when several open gaps describe the same underlying problem (same missing feature, same visual flaw seen in different shots), merge them into one gap with one clear description. Keep the oldest id as the survivor.
5b. Pick the TOP 5 gaps (ledger ids or NEW ids): significant, obvious problems a player or user would notice right away and that need real work to fix (a missing feature, screen, level or system; a look that is clearly wrong across the board). Do not pick small polish, single-pixel artifacts or tweaks. Order them by how much fixing them would raise the scores.
${brief
  ? '6. Grade COVERAGE (0-10): can you judge the whole deliverable from what you were given? Penalise missing or unreadable pages, missing speaker notes or script where the brief implies spoken delivery, and anything you had to guess at.\n7. List 1-4 capture_requests: what the builder should include next time so you can judge better (e.g. "include speaker notes for each slide", "send slides at higher resolution").\n\nIGNORE THE NEXT TWO LINES ABOUT VISUAL BUILDS (they apply to visual builds only):\n'
  : ''}6. Grade COVERAGE (0-10): can you actually judge the whole build from this candidate set? Compare with what the references show. Penalise: the same camera angle, zoom or scene in most images; images nearly identical to the previous eval's (P) images; no sequence or video frames showing things moving and happening over time (characters moving, a fight or interaction starting and ending, menus and UI responding to input); refs' scene types, distances or UI states missing. 9-10 means every important look and moment in the refs has a matching candidate.
8. Write next_round.plan: the 1-3 biggest user-visible changes the builder should make next to raise the scores most, judged from what is MISSING or weakest in the images. Prefer whole missing features or screens over polish. Each item: what the player or user should see, which criterion it lifts, and a done_when that you could check from screenshots.
7. List 1-3 capture_requests, only for features you could not see at all (never ask for proof, logs, measurements or documentation): concrete shots or short videos the builder should capture NEXT round so you can judge what you cannot judge now (e.g. "20 s video of the player meeting an enemy and fighting until one side wins, camera at normal play distance" or "close-up of the inventory screen with several items equipped").

Reply with ONLY this JSON, no prose:
{"scores":{"<criterion key>":{"score":0,"reason":""}},
 "vs_previous":{"<criterion key>":"better|same|worse"},
 "ledger":[{"id":"G1","status":"open|improved|closed","note":""}],
 "new_gaps":[{"criterion":"<key>","text":"","severity":1,"evidence":"C2 vs R4"}],
 "merges":[{"into":"G3","ids":["G7","G12"],"text":"one clear description of the merged problem"}],
 "top_priorities":["G3","NEW1","G9","G14","G2"],
 "coverage":{"score":0,"repeats_previous":false,"reason":"","cannot_judge":["things you could not assess from these images"]},
 "capture_requests":["",""],
 "next_round":{"plan":[{"feature":"","criterion":"","done_when":""}]},
 "summary":"one or two sentences"}
In new_gaps refer to them as NEW1, NEW2... in top_priorities. severity: 1 minor, 2 clear, 3 dominant.`;
}

// ---------- backends ----------
// Any OpenAI-compatible chat completions endpoint with vision (vLLM, llama.cpp server, LM Studio, Ollama, OpenAI).
async function judgeOpenAI(prompt, images) {
  const content = [{ type: 'text', text: prompt }];
  for (const im of images) {
    content.push({ type: 'text', text: `${im.tag}:` });
    content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + fs.readFileSync(im.file).toString('base64') } });
  }
  const headers = { 'Content-Type': 'application/json' };
  if (OPENAI_KEY) headers.Authorization = `Bearer ${OPENAI_KEY}`;
  const r = await fetch(OPENAI_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ model: OPENAI_MODEL, max_tokens: 12000, temperature: 0.2, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`openai HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`);
  const j = await r.json();
  return { text: j.choices?.[0]?.message?.content || '', usage: j.usage };
}
// Claude through the Claude Code CLI (`claude -p`), run in an empty temp dir that holds only the images.
async function judgeClaude(prompt, images) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artdir-claude-'));
  const lines = [];
  for (const im of images) {
    const f = path.join(dir, `${im.tag}.jpg`);
    fs.copyFileSync(im.file, f);
    lines.push(`${im.tag}: ${f}`);
  }
  const full = `${prompt}\n\nIMAGE FILES (open every one with the Read tool before judging):\n${lines.join('\n')}`;
  const text = await new Promise((res, rej) => {
    const cp = spawn(CLAUDE_BIN, ['-p', '--model', CLAUDE_MODEL, '--allowedTools', 'Read', '--output-format', 'json'],
      { cwd: dir, shell: true, windowsHide: true });
    let out = '', err = '';
    cp.stdout.on('data', d => out += d); cp.stderr.on('data', d => err += d);
    const timer = setTimeout(() => cp.kill(), JUDGE_TIMEOUT_MS);
    cp.on('close', code => {
      clearTimeout(timer);
      let j = null; try { j = JSON.parse(out); } catch { }
      if (j?.is_error || code) return rej(new Error(`claude ${code}: ${(j?.result || err || out).slice(0, 400)}`));
      res(j ? j.result || '' : out);
    });
    cp.stdin.end(full);
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { text };
}
function parseJson(text) {
  const s = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON in judge reply');
  return JSON.parse(s.slice(a, b + 1));
}

// Run a prompt + images on the wanted backend; claude falls back to openai (credits/limits/errors)
// unless fallback is set to "none".
const FALLBACK = cfg('fallback', 'ARTDIR_FALLBACK', 'openai');
async function callModel(wanted, prompt, images) {
  wanted = normBackend(wanted);
  const order = wanted === 'claude' ? (FALLBACK === 'none' ? ['claude'] : ['claude', 'openai']) : ['openai'];
  const errors = [];
  for (const be of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = be === 'claude' ? await judgeClaude(prompt, images) : await judgeOpenAI(prompt, images);
        const parsed = parseJson(raw.text);
        return { raw, parsed, backend: be, fallback_reason: be !== wanted ? errors.join(' | ').slice(0, 500) : null };
      } catch (e) { errors.push(`${be}: ${e.message}`); if (be === 'claude' && /limit|credit|quota|usage|rate|auth|login/i.test(e.message)) break; }
    }
  }
  throw new Error(`model failed: ${errors.join(' | ')}`);
}

// ---------- ref captions ----------
// Caption refs in batches so the judge (and the owner) can read what each ref shows.
async function captionRefs(p, { onlyEmpty = true, files = null } = {}) {
  const f = path.join(pdir(p.id), 'refs.json');
  const todo = readJson(f, []).filter(r => files ? files.includes(r.file) : !onlyEmpty || !r.note);
  const done = [];
  for (let i = 0; i < todo.length; i += 6) {
    const batch = todo.slice(i, i + 6);
    const images = batch.map((r, k) => ({ tag: `R${k + 1}`, file: path.join(pdir(p.id), 'refs', r.file) }));
    const prompt = `You are captioning REFERENCE images for a visual judge. Project: ${p.name}.
${p.description}

For each image write a caption of 2-4 plain sentences: the scene and camera distance; the characters, objects and structures visible (shape, colour, size in frame); lighting, colour palette and atmosphere; effects in progress (particles, explosions, motion); and any UI or text. Name things concretely. Do not guess at anything not visible.

Images: ${batch.map((r, k) => `R${k + 1} (${r.source}${r.t != null ? ' @' + r.t + 's' : ''})`).join(', ')}
Reply with ONLY JSON: {"R1":"caption", "R2":"caption", ...}`;
    const { parsed } = await callModel(p.judge.backend, prompt, images);
    const all = readJson(f, []);
    batch.forEach((r, k) => {
      const c = parsed[`R${k + 1}`];
      const x = all.find(y => y.file === r.file);
      if (c && x) { x.note = String(c).trim(); x.caption_auto = true; done.push(x.file); }
    });
    writeJson(f, all);
  }
  return done;
}

// ---------- eval ----------
const queues = new Map();   // one eval at a time per project
function enqueue(id, fn) {
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.catch(() => { }).then(fn);
  queues.set(id, next);
  return next;
}

async function runEval(p, body) {
  const evals = listEvals(p.id);
  const n = (evals.at(-1)?.n || 0) + 1;
  const edir = path.join(pdir(p.id), 'evals', String(n));
  const candDir = path.join(edir, 'candidates');
  const items = expandPaths([...(body.paths || []), ...(body.files || [])]);
  if (!items.length) throw new Error('no candidate images: pass paths[] or files[]');
  const added = ingest(items, candDir, { maxW: p.settings.candidate_width, framesPerVideo: p.settings.frames_per_video, note: '' })
    .filter(x => !x.error);
  if (!added.length) throw new Error('no candidate images could be read');

  // Reject a round that mostly re-sends the previous eval's images: the judge can only help on fresh captures.
  // Perceptual fingerprint: 16x16 greyscale, bit = pixel above mean. Survives re-encoding; distance <= 12 bits = same shot.
  const hashOf = f => { try { const px = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-vf', 'scale=16:16,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-']);
    const mean = px.reduce((a, b) => a + b, 0) / px.length; return Array.from(px, v => v > mean ? '1' : '0').join(''); } catch { return null; } };
  const same = (a, b) => { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d <= 12; };
  for (const c of added) c.phash = hashOf(path.join(candDir, c.file));
  const prevEval = evals.at(-1);
  const prevHashes = new Set((prevEval?.candidates || []).map(c => {
    if (c.phash) return c.phash;
    const f = path.join(pdir(p.id), 'evals', String(prevEval.n), 'candidates', c.file);
    return fs.existsSync(f) ? hashOf(f) : null;   // evals from before hashing was added
  }).filter(Boolean));
  const imgs = added.filter(c => c.kind !== 'text');
  const prevList = [...prevHashes];
  const repeats = imgs.filter(c => prevList.some(h => same(h, c.phash))).length;
  if (prevHashes.size && imgs.length && repeats / imgs.length >= 0.6 && !body.allow_repeat) {
    fs.rmSync(edir, { recursive: true, force: true });
    throw new Error(`rejected: ${repeats} of ${imgs.length} images are identical to eval ${prevEval.n}. Rebuild and capture fresh shots of what changed, including everything in the last reply's capture_requests (new views, other levels or screens, a video of real use). Pass "allow_repeat": true only if you deliberately need a re-score.`);
  }

  const refMeta = readJson(path.join(pdir(p.id), 'refs.json'), []);
  const refs = pickRefs(refMeta, p.settings.max_refs).map(r => ({ ...r, file: path.join(pdir(p.id), 'refs', r.file) }));
  const texts = added.filter(c => c.kind === 'text').map(c => ({ source: c.source, content: fs.readFileSync(path.join(candDir, c.file), 'utf8').slice(0, 40000) }));
  const cands = sample(videoSheets(added.filter(c => c.kind !== 'text'), candDir), p.settings.max_candidates).map(c => ({ ...c, file: path.join(candDir, c.file) }));
  const last = evals.at(-1);
  const prev = last && p.settings.compare_previous
    ? sample((last.judged || last.candidates || []).filter(c => c.kind !== 'text'), Math.min(4, p.settings.max_candidates)).map(c => ({ ...c, file: path.join(pdir(p.id), 'evals', String(last.n), 'candidates', c.file) }))
      .filter(c => fs.existsSync(c.file))
    : [];

  const gaps = loadGaps(p.id);
  const prompt = buildPrompt(p, gaps, evals, refs, cands, prev, texts);
  const images = [...refs.map((r, i) => ({ tag: `R${i + 1}`, file: r.file })), ...cands.map((c, i) => ({ tag: `C${i + 1}`, file: c.file })),
  ...prev.map((c, i) => ({ tag: `P${i + 1}`, file: c.file }))];
  if (body.agent?.type) { const pp = loadProject(p.id); pp.agent = { ...body.agent }; saveProject(pp); }
  const t0 = Date.now();
  const { raw, parsed, backend, fallback_reason } = await callModel(body.backend || p.judge.backend, prompt, images);

  // scores + weighted overall
  const scores = {};
  let wsum = 0, tot = 0;
  for (const c of p.criteria) {
    const s = parsed.scores?.[c.key];
    const v = Math.round(Math.max(0, Math.min(10, Number(s?.score ?? s) || 0)) * 2) / 2;
    scores[c.key] = { score: v, reason: s?.reason || '' };
    wsum += c.weight ?? 1; tot += v * (c.weight ?? 1);
  }
  const overall = +(tot / (wsum || 1)).toFixed(2);

  // gap ledger update
  const byId = new Map(gaps.map(g => [g.id, g]));
  const ledgerOut = [];
  for (const u of parsed.ledger || []) {
    const g = byId.get(u.id);
    if (!g || g.status === 'closed') continue;
    const st = ['open', 'improved', 'closed'].includes(u.status) ? u.status : 'open';
    g.status = st; g.seen = (g.seen || 1) + (st === 'closed' ? 0 : 1); g.last_eval = n;
    g.history = [...(g.history || []), { eval: n, status: st, note: u.note || '' }];
    if (st === 'closed') g.closed_eval = n;
    ledgerOut.push({ id: g.id, criterion: g.criterion, text: g.text, status: st, note: u.note || '' });
  }
  let maxId = gaps.reduce((m, g) => Math.max(m, Number(g.id.slice(1)) || 0), 0);
  const newMap = {};
  const newGaps = [];
  (parsed.new_gaps || []).slice(0, 5).forEach((ng, i) => {
    if (!ng?.text) return;
    const g = { id: `G${++maxId}`, criterion: ng.criterion || 'general', text: ng.text, severity: ng.severity || 2, evidence: ng.evidence || '',
      status: 'open', first_eval: n, last_eval: n, seen: 1, history: [{ eval: n, status: 'new', note: ng.evidence || '' }] };
    gaps.push(g); newGaps.push(g); newMap[`NEW${i + 1}`] = g.id;
  });
  let merged = 0;
  for (const m of parsed.merges || []) {
    const into = gaps.find(g => g.id === m?.into && g.status !== 'closed');
    if (!into || !Array.isArray(m.ids)) continue;
    for (const id of m.ids) {
      const g = gaps.find(x => x.id === id && x.id !== into.id && x.status !== 'closed');
      if (!g) continue;
      g.status = 'closed'; g.closed_eval = n; g.merged_into = into.id;
      g.history = [...(g.history || []), { eval: n, status: 'merged', note: 'merged into ' + into.id }];
      into.seen = Math.max(into.seen || 1, g.seen || 1); merged++;
    }
    if (m.text) into.text = m.text;
    into.history = [...(into.history || []), { eval: n, status: 'merged', note: 'absorbed ' + m.ids.join(', ') }];
  }
  saveGaps(p.id, gaps);
  const top = (parsed.top_priorities || []).map(x => newMap[x] || x).filter(id => gaps.some(g => g.id === id && g.status !== 'closed')).slice(0, 5)
    .map(id => { const g = gaps.find(x => x.id === id); return { id, criterion: g.criterion, text: g.text, status: g.status, seen: g.seen }; });

  // Stuck gaps: open for STUCK_AFTER+ evals. They lead the reply and the priority list.
  const stuck = gaps.filter(g => g.status !== 'closed' && g.seen >= STUCK_AFTER).sort((a, b) => b.seen - a.seen).slice(0, 5)
    .map(g => ({ id: g.id, criterion: g.criterion, text: g.text, seen: g.seen, note: ledgerOut.find(l => l.id === g.id)?.note || '' }));
  for (const g of gaps) g.stuck = g.status !== 'closed' && g.seen >= STUCK_AFTER;
  saveGaps(p.id, gaps);
  const topIds = new Set(top.map(t => t.id));
  const priorities = top.map(t => ({ ...t, stuck: (gaps.find(g => g.id === t.id)?.seen || 0) >= STUCK_AFTER }));

  const result = {
    n, label: body.label || '', at: new Date().toISOString(),
    agent_rules: p.settings.agent_rules || AGENT_RULES,
    stuck_gaps: stuck,
    backend, fallback_reason, seconds: Math.round((Date.now() - t0) / 1000),
    overall, scores, vs_previous: parsed.vs_previous || {},
    delta: last ? Object.fromEntries(p.criteria.map(c => [c.key, +(scores[c.key].score - (last.scores?.[c.key]?.score ?? 0)).toFixed(1)])) : null,
    top_priorities: priorities, new_gaps: newGaps.map(g => ({ id: g.id, criterion: g.criterion, text: g.text, severity: g.severity })),
    ledger: ledgerOut, merged_count: merged, open_gap_count: gaps.filter(g => g.status !== 'closed').length,
    coverage: parsed.coverage ? { ...parsed.coverage, score: Math.round(Math.max(0, Math.min(10, Number(parsed.coverage.score) || 0)) * 2) / 2 } : null,
    next_round: { stalled: (() => { const r = evals.slice(-3).map(e => e.owner_overall ?? e.overall).concat([overall]); return r.length >= 4 && Math.max(...r.slice(1)) <= r[0] + 0.1; })(), plan: Array.isArray(parsed.next_round?.plan) ? parsed.next_round.plan.filter(x => x?.feature).slice(0, 3) : [] },
    capture_requests: Array.isArray(parsed.capture_requests) ? parsed.capture_requests.filter(Boolean).slice(0, 3) : [],
    summary: parsed.summary || '',
    candidates: added, judged: cands.map(c => ({ ...c, file: path.basename(c.file) })), refs_used: refs.map(r => r.file && path.basename(r.file)), usage: raw.usage || null,
  };
  writeJson(path.join(edir, 'result.json'), result);
  fs.writeFileSync(path.join(edir, 'raw.txt'), raw.text);
  fs.writeFileSync(path.join(edir, 'prompt.txt'), prompt);
  return result;
}

// What agents get back: scores, the plan and the top 5 gaps only. The full ledger stays in result.json and the UI.
function compactResult(r) {
  return { n: r.n, label: r.label, at: r.at, agent_rules: r.agent_rules, overall: r.overall,
    scores: r.scores, delta: r.delta, next_round: r.next_round, top_priorities: r.top_priorities,
    coverage: r.coverage, capture_requests: r.capture_requests, summary: r.summary,
    open_gap_count: r.open_gap_count, merged_count: r.merged_count,
    note: 'Compact reply: the full gap ledger is tracked by the judge. Add "full": true to the request to get everything.' };
}

// ---------- owner chat ----------
// The owner talks to the judge ("that's a 7 not an 8", "this image is the look I want", general commentary).
// Each reply carries a PROPOSAL of changes. Nothing is applied until the owner accepts it; further
// messages revise the same proposal. Accepting snapshots state so it can be undone.
const chatFile = id => path.join(pdir(id), 'chat.json');
const proposalFile = id => path.join(pdir(id), 'proposal.json');
const EMPTY_CHANGES = { score_overrides: [], calibration_add: [], calibration_remove: [], criteria_update: [], criteria_add: [], criteria_remove: [], gap_updates: [], gap_add: [], add_refs: [] };

function describeChanges(c, ev) {
  const out = [];
  for (const o of c.score_overrides || []) out.push(`eval ${ev ?? '?'} ${o.criterion}: set to ${o.score}${o.why ? ` (${o.why})` : ''}`);
  for (const k of c.calibration_add || []) out.push(`add rule ${k.criterion ? `[${k.criterion}] ` : ''}${k.text}`);
  for (const k of c.calibration_remove || []) out.push(`retire rule ${k}`);
  for (const u of c.criteria_update || []) out.push(`criterion ${u.key}: ${u.description ? `new description "${u.description}"` : ''}${u.weight != null ? ` weight ${u.weight}` : ''}`);
  for (const a of c.criteria_add || []) out.push(`add criterion ${a.key} (weight ${a.weight ?? 1}): ${a.description}`);
  for (const k of c.criteria_remove || []) out.push(`remove criterion ${k}`);
  for (const u of c.gap_updates || []) out.push(`gap ${u.id}: ${u.status || ''}${u.text ? ` "${u.text}"` : ''}`);
  for (const a of c.gap_add || []) out.push(`add gap [${a.criterion}] ${a.text}`);
  for (const a of c.add_refs || []) out.push(`add ${a.image} as ${a.pinned !== false ? 'key ' : ''}ref: ${a.caption}`);
  return out;
}

async function runChat(p, b) {
  const chat = readJson(chatFile(p.id), []);
  const pending = readJson(proposalFile(p.id), null);
  const evals = listEvals(p.id);
  const general = b.eval === 'none';
  const ev = general ? null : b.eval ? evals.find(e => String(e.n) === String(b.eval)) : evals.at(-1);
  const chatDir = path.join(pdir(p.id), 'chat');
  const uploads = (b.images || []).length
    ? ingest(b.images, chatDir, { maxW: 1280, framesPerVideo: 6 }).filter(x => !x.error) : [];
  const userMsg = { id: crypto.randomUUID(), role: 'owner', at: new Date().toISOString(), text: b.text || '', eval: ev?.n ?? null,
    images: uploads.map(u => u.file) };
  // images from earlier messages still under discussion stay visible (U1.. numbering is stable across the open proposal)
  const allUploads = [...(pending?.uploads || []), ...uploads];

  const cands = ev ? (ev.candidates || []).filter(c => c.kind !== 'text').slice(0, 8)
    .map(c => ({ ...c, file: path.join(pdir(p.id), 'evals', String(ev.n), 'candidates', c.file) })).filter(c => fs.existsSync(c.file)) : [];
  const images = [...cands.map((c, i) => ({ tag: `C${i + 1}`, file: c.file })), ...allUploads.map((u, i) => ({ tag: `U${i + 1}`, file: path.join(chatDir, u.file) }))];
  const gaps = loadGaps(p.id).filter(g => g.status !== 'closed');
  const recent = chat.slice(-14).map(m => `${m.role === 'owner' ? 'OWNER' : m.role === 'system' ? 'SYSTEM' : 'JUDGE'}: ${m.text}`).join('\n');
  const prompt = `You are the judge for the project below, talking with the project OWNER. The owner's word is final on taste and scoring. Understand their feedback, answer briefly, and PROPOSE durable changes so future evals score the way the owner would. Nothing you propose is applied until the owner accepts it, so propose exactly what the owner's words support and nothing more. Do not drift: keep criteria close to their current wording unless the owner asks for a change.

PROJECT: ${p.name}
DESCRIPTION:
${p.description}

CRITERIA:
${p.criteria.map(c => `- ${c.key} (weight ${c.weight ?? 1}): ${c.description}`).join('\n')}

CURRENT OWNER CALIBRATION RULES:
${(p.calibration || []).filter(c => c.active !== false).map(c => `- ${c.id} ${c.criterion ? `[${c.criterion}] ` : ''}${c.text}`).join('\n') || '(none)'}

${ev ? `EVAL BEING DISCUSSED: eval ${ev.n}${ev.label ? ` (${ev.label})` : ''}, overall ${ev.owner_overall ?? ev.overall}
${Object.entries(ev.scores).map(([k, v]) => `- ${k}: ${v.owner_score ?? v.score}${v.owner_score != null ? ' (owner-corrected)' : ''}: ${v.reason}`).join('\n')}
Candidate images from that eval: ${cands.map((c, i) => `C${i + 1} ${c.source}`).join(', ') || 'none'}` : 'GENERAL COMMENTARY: the owner is not talking about one eval. Do not propose score_overrides.'}

OPEN GAPS:
${gaps.map(g => `- ${g.id} [${g.criterion}] ${g.text}`).join('\n') || '(none)'}

${allUploads.length ? `IMAGES THE OWNER ATTACHED: ${allUploads.map((u, i) => `U${i + 1} (${u.source})`).join(', ')}\n` : ''}${pending ? `CURRENT PENDING PROPOSAL (not yet accepted; revise it to match what the owner now says, and return the FULL revised proposal, not a diff):\n${JSON.stringify(pending.changes)}\n\n` : ''}RECENT CONVERSATION:
${recent || '(start)'}

OWNER SAYS NOW:
${b.text || '(no text)'}

Typical cases:
- "that's a 7 not an 8" → a score_override on that eval AND a calibration rule explaining the standard (a rule about what earns which score, not just the number).
- "you're missing X" / "X matters more" → a reworded criterion, a weight change, or a calibration rule.
- general commentary about taste or priorities → calibration rules and/or criteria changes.
- an attached image that shows the target → add_refs with a caption saying what it shows and why (only for projects that judge against refs), or describe it in a rule.
- a wrong or already fixed gap → update or close it. A missing problem → add a gap.
- just a question → answer it and propose nothing (empty arrays).

Reply with ONLY this JSON:
{"reply":"short answer to the owner in plain words; say what you propose and ask if anything is off",
 "changes":{"score_overrides":[{"criterion":"key","score":7,"why":""}],
  "calibration_add":[{"criterion":"key or empty","text":"rule the judge must follow"}],
  "calibration_remove":["K1"],
  "criteria_update":[{"key":"existing key","description":"new text (omit to keep)","weight":1.5}],
  "criteria_add":[{"key":"new_key","description":"","weight":1}],
  "criteria_remove":["key"],
  "gap_updates":[{"id":"G3","status":"open|improved|closed","text":"optional new text"}],
  "gap_add":[{"criterion":"key","text":""}],
  "add_refs":[{"image":"U1","caption":"","pinned":true}]}}
Use empty arrays for anything you do not change.`;

  const { parsed, backend } = await callModel(p.judge.backend, prompt, images);
  const changes = { ...EMPTY_CHANGES, ...(parsed.changes || {}) };
  const lines = describeChanges(changes, ev?.n ?? pending?.eval);
  let proposal = null;
  if (lines.length) {
    proposal = { id: pending?.id || crypto.randomUUID(), eval: ev?.n ?? pending?.eval ?? null, changes, lines, uploads: allUploads,
      revision: (pending?.revision || 0) + 1, at: new Date().toISOString() };
    writeJson(proposalFile(p.id), proposal);
  } else if (pending) {
    // reply proposed nothing: keep the earlier proposal open, unchanged
    proposal = pending;
  }
  const judgeMsg = { id: crypto.randomUUID(), role: 'judge', at: new Date().toISOString(), text: parsed.reply || '',
    proposal: lines.length ? { id: proposal.id, revision: proposal.revision, lines } : null, backend };
  chat.push(userMsg, judgeMsg);
  writeJson(chatFile(p.id), chat);
  return { owner: userMsg, judge: judgeMsg, pending: proposal };
}

// Apply the open proposal. Snapshots project/gaps/refs (+ the eval) first so it can be undone.
function acceptProposal(p) {
  const prop = readJson(proposalFile(p.id), null);
  if (!prop) throw new Error('no pending proposal');
  const c = prop.changes;
  const evN = prop.eval;
  const snapId = prop.id;
  const snapDir = path.join(pdir(p.id), 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  for (const f of ['project.json', 'gaps.json', 'refs.json']) {
    const src = path.join(pdir(p.id), f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(snapDir, `${snapId}.${f}`));
  }
  const evFile = evN != null ? path.join(pdir(p.id), 'evals', String(evN), 'result.json') : null;
  if (evFile && fs.existsSync(evFile)) fs.copyFileSync(evFile, path.join(snapDir, `${snapId}.eval${evN}.json`));

  const applied = [];
  const proj = loadProject(p.id);
  proj.calibration ??= [];
  let kMax = proj.calibration.reduce((m, x) => Math.max(m, Number(String(x.id).slice(1)) || 0), 0);
  for (const k of c.calibration_add || []) if (k?.text) {
    const note = { id: `K${++kMax}`, criterion: k.criterion || '', text: k.text, from_eval: evN, at: new Date().toISOString(), active: true };
    proj.calibration.push(note); applied.push(`rule ${note.id}: ${note.criterion ? `[${note.criterion}] ` : ''}${note.text}`);
  }
  for (const id of c.calibration_remove || []) {
    const x = proj.calibration.find(y => y.id === id); if (x) { x.active = false; applied.push(`rule ${id} retired`); }
  }
  for (const u of c.criteria_update || []) {
    const x = proj.criteria.find(y => y.key === u.key); if (!x) continue;
    if (u.description) x.description = u.description;
    if (u.weight != null && Number(u.weight) > 0) x.weight = Number(u.weight);
    applied.push(`criterion ${u.key} updated`);
  }
  for (const a of c.criteria_add || []) if (a?.key && !proj.criteria.some(x => x.key === a.key)) {
    proj.criteria.push({ key: a.key, description: a.description || a.key, weight: Number(a.weight) || 1 }); applied.push(`criterion ${a.key} added`);
  }
  for (const k of c.criteria_remove || []) {
    const before = proj.criteria.length; proj.criteria = proj.criteria.filter(x => x.key !== k);
    if (proj.criteria.length < before) applied.push(`criterion ${k} removed`);
  }
  saveProject(proj);

  if (evFile && fs.existsSync(evFile) && (c.score_overrides || []).length) {
    const r = readJson(evFile, null);
    for (const o of c.score_overrides) {
      if (!r?.scores?.[o.criterion] || o.score == null) continue;
      r.scores[o.criterion].owner_score = Math.round(Number(o.score) * 2) / 2;
      r.scores[o.criterion].owner_why = o.why || '';
      applied.push(`eval ${evN} ${o.criterion}: ${r.scores[o.criterion].score} → ${r.scores[o.criterion].owner_score}`);
    }
    let w = 0, t = 0;
    for (const x of proj.criteria) { const s = r.scores[x.key]; if (!s) continue; w += x.weight ?? 1; t += (s.owner_score ?? s.score) * (x.weight ?? 1); }
    r.owner_overall = +(t / (w || 1)).toFixed(2);
    writeJson(evFile, r);
  }

  const g = loadGaps(p.id);
  for (const u of c.gap_updates || []) {
    const x = g.find(y => y.id === u.id); if (!x) continue;
    if (u.status) x.status = u.status; if (u.text) x.text = u.text;
    x.history = [...(x.history || []), { eval: evN ?? x.last_eval, status: u.status || 'edited', note: 'owner chat' }];
    applied.push(`gap ${u.id} ${u.status || 'edited'}`);
  }
  let gMax = g.reduce((m, x) => Math.max(m, Number(x.id.slice(1)) || 0), 0);
  for (const a of c.gap_add || []) if (a?.text) {
    const n = evN ?? (listEvals(p.id).at(-1)?.n || 0);
    g.push({ id: `G${++gMax}`, criterion: a.criterion || 'general', text: a.text, severity: 2, evidence: 'owner chat', status: 'open', first_eval: n, last_eval: n, seen: 1, history: [{ eval: n, status: 'new', note: 'owner chat' }] });
    applied.push(`gap G${gMax} added`);
  }
  saveGaps(p.id, g);

  const chatDir = path.join(pdir(p.id), 'chat');
  for (const a of c.add_refs || []) {
    const k = Number(String(a.image || '').replace(/\D/g, '')) - 1;
    const u = (prop.uploads || [])[k]; if (!u) continue;
    fs.mkdirSync(path.join(pdir(p.id), 'refs'), { recursive: true });
    fs.copyFileSync(path.join(chatDir, u.file), path.join(pdir(p.id), 'refs', u.file));
    const all = readJson(path.join(pdir(p.id), 'refs.json'), []);
    all.push({ file: u.file, source: u.source, kind: 'image', note: a.caption || '', pinned: a.pinned !== false });
    writeJson(path.join(pdir(p.id), 'refs.json'), all);
    applied.push(`ref added from ${a.image}`);
  }

  fs.rmSync(proposalFile(p.id), { force: true });
  const chat = readJson(chatFile(p.id), []);
  chat.push({ id: crypto.randomUUID(), role: 'system', at: new Date().toISOString(), text: `Accepted proposal (revision ${prop.revision}).`, applied, snapshot: snapId });
  writeJson(chatFile(p.id), chat);
  return { applied, snapshot: snapId };
}

function discardProposal(p) {
  const prop = readJson(proposalFile(p.id), null);
  fs.rmSync(proposalFile(p.id), { force: true });
  if (prop) {
    const chat = readJson(chatFile(p.id), []);
    chat.push({ id: crypto.randomUUID(), role: 'system', at: new Date().toISOString(), text: `Discarded proposal (revision ${prop.revision}). Nothing was changed.` });
    writeJson(chatFile(p.id), chat);
  }
  return { discarded: !!prop };
}

// Clear the conversation and any open proposal. Accepted changes stay (and stay undoable from the snapshots folder).
function clearChat(p) {
  fs.rmSync(chatFile(p.id), { force: true });
  fs.rmSync(proposalFile(p.id), { force: true });
  return { cleared: true };
}

function undoChat(p, snapId) {
  const snapDir = path.join(pdir(p.id), 'snapshots');
  const files = fs.existsSync(snapDir) ? fs.readdirSync(snapDir).filter(f => f.startsWith(snapId + '.')) : [];
  if (!files.length) throw new Error('no snapshot for that change');
  for (const f of files) {
    const rest = f.slice(snapId.length + 1);
    const m = rest.match(/^eval(\d+)\.json$/);
    const dst = m ? path.join(pdir(p.id), 'evals', m[1], 'result.json') : path.join(pdir(p.id), rest);
    fs.copyFileSync(path.join(snapDir, f), dst);
  }
  const chat = readJson(chatFile(p.id), []);
  const msg = chat.find(x => x.snapshot === snapId);
  if (msg) msg.undone = true;
  writeJson(chatFile(p.id), chat);
  return { restored: files.length };
}

// ---------- supervisor: nudge idle or drifting agents ----------
// project.agent tells the judge how to reach the agent that builds the project. Set it with PATCH /projects/:id
// or send "agent" in an eval request. Supported channels:
//   {type:'tmux', target:'build:0.0', wsl?:true}   types the message into a tmux pane (Codex, Claude Code, any TUI agent)
//   {type:'claude', session:'<id>', name?:'..'}    resumes a Claude Code background session with the message
//   {type:'webhook', url:'https://..', busy_url?}  POSTs {project, eval, kind, text} as JSON
//   {type:'command', run:'my-notify.sh'}           runs a shell command; message on stdin and in ARTDIR_MESSAGE
//                                                  (only when allow_agent_commands is true in config)
// Every supervise_every_min: if a project has had no eval for settings.nudge_after_min (default 120) and its agent
// is idle, it gets the latest plan and top gaps. Right after an eval that shows a stall or a coverage drop, it gets
// a drift correction. Log: <data>/nudges.log
const ALLOW_AGENT_COMMANDS = String(cfg('allow_agent_commands', 'ARTDIR_ALLOW_AGENT_COMMANDS', false)) === 'true';
const SAFE_ID = /^[\w:.@%+-]+$/;   // tmux targets and session ids go into a shell command line
const nudgeLog = m => fs.appendFileSync(path.join(DATA, 'nudges.log'), new Date().toISOString() + ' ' + m + '\n');
function nudgeText(p, last, hours) {
  const plan = (last?.next_round?.plan || []).map((x, i) => `${i + 1}. ${x.feature} (${x.criterion}; done when: ${x.done_when})`).join(' ');
  const top = (last?.top_priorities || []).slice(0, 5).map(g => `${g.id}: ${g.text}`).join(' | ');
  return `Art Director supervisor: no eval for project ${p.id} in ${hours} h. Get back on the judge loop now: rebuild, capture fresh shots and video, and submit (POST /projects/${p.id}/evals). Work this first. Plan: ${plan || 'see last reply'}. Top gaps: ${top || 'see last reply'}. Do not spend rounds on small polish.`;
}
async function agentBusy(a) {
  try {
    if (a.type === 'claude') {
      const out = execFileSync(CLAUDE_BIN, ['agents', '--json'], { encoding: 'utf8', shell: true, timeout: 30000 });
      const s = JSON.parse(out).find(x => x.sessionId === a.session || x.id === a.session);
      return s ? { busy: s.status === 'busy', cwd: s.cwd, sessionId: s.sessionId } : { busy: false, missing: true };
    }
    if (a.type === 'webhook' && a.busy_url) {
      const r = await fetch(a.busy_url, { headers: a.headers || {}, signal: AbortSignal.timeout(15000) });
      return { busy: !!(await r.json()).busy };
    }
    // tmux and command: a message typed into a busy TUI agent is delivered at its next step, so no check is needed.
    return { busy: false };
  } catch (e) { return { busy: true, error: e.message }; }
}
async function sendNudge(p, a, msg, info, kind = 'nudge') {
  const one = msg.replace(/\s+/g, ' ');
  if (a.type === 'tmux') {
    const t = a.target;
    if (!SAFE_ID.test(t || '')) throw new Error('tmux target missing or has unsafe characters');
    // Load the text through stdin into a paste buffer and paste it bracketed, so the TUI receives it as one paste.
    // Some TUIs (e.g. Codex) collapse a long paste into "[Pasted Content]" and need a second Enter to submit it.
    const script = `tmux load-buffer -b artdir - && tmux paste-buffer -p -d -b artdir -t ${t} && sleep 3 && tmux send-keys -t ${t} Enter && sleep 3 && if tmux capture-pane -p -t ${t} | tail -8 | grep -q "Pasted Content"; then tmux send-keys -t ${t} Enter; fi`;
    const r = a.wsl ? spawnSync('wsl.exe', ['-e', 'bash', '-c', script], { input: one, encoding: 'utf8', timeout: 60000 })
      : spawnSync('bash', ['-c', script], { input: one, encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) throw new Error('tmux delivery failed: ' + ((r.stderr || '') + (r.error?.message || '')).slice(0, 200));
  } else if (a.type === 'webhook') {
    const r = await fetch(a.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(a.headers || {}) },
      body: JSON.stringify({ project: p.id, eval: listEvals(p.id).at(-1)?.n ?? null, kind, text: msg }), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`webhook HTTP ${r.status}`);
  } else if (a.type === 'command') {
    if (!ALLOW_AGENT_COMMANDS) throw new Error('agent type "command" is disabled: set allow_agent_commands to true in config');
    const r = spawnSync(a.run, { shell: true, input: msg, encoding: 'utf8', timeout: 120000, cwd: a.cwd || undefined,
      env: { ...process.env, ARTDIR_MESSAGE: msg, ARTDIR_PROJECT: p.id, ARTDIR_KIND: kind } });
    if (r.status !== 0) throw new Error('command failed: ' + ((r.stderr || '') + (r.error?.message || '')).slice(0, 200));
  } else if (a.type === 'claude') {
    if (!info.sessionId) throw new Error('claude session not found');
    if (!SAFE_ID.test(a.session) || !SAFE_ID.test(info.sessionId)) throw new Error('claude session id has unsafe characters');
    // Resuming a session that is still loaded makes a copy. Stop it first, resume it, then record the new id.
    spawnSync(CLAUDE_BIN, ['stop', a.session], { shell: true, encoding: 'utf8', timeout: 30000 });
    const r = spawnSync(CLAUDE_BIN, ['--bg', '--resume', info.sessionId, '--remote-control', JSON.stringify(a.name || 'agent'), '--dangerously-skip-permissions', JSON.stringify(one)], { cwd: info.cwd, shell: true, encoding: 'utf8', timeout: 90000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const id = out.match(/backgrounded\s*·\s*([0-9a-f]{8})/)?.[1] || out.match(/claude attach ([0-9a-f]{8})/)?.[1];
    if (!id) throw new Error('claude resume gave no session id: ' + out.slice(0, 200));
    const pp = loadProject(p.id); pp.agent.session = id; saveProject(pp);
  } else throw new Error(`unknown agent type: ${a.type}`);
}
// Drift correction: right after an eval that shows a stall or a coverage drop, tell the agent exactly what to change.
function driftText(p, ev, prevBestCov) {
  const plan = (ev.next_round?.plan || []).map((x, i) => `${i + 1}. ${x.feature} (done when: ${x.done_when})`).join(' ');
  const why = [ev.next_round?.stalled ? 'the overall score has not improved for 3 evals' : '',
    prevBestCov != null && (ev.coverage?.score ?? 10) <= prevBestCov - 2 ? `coverage fell to ${ev.coverage?.score} from ${prevBestCov}: your captures stopped showing parts of the build (${(ev.coverage?.cannot_judge || []).join('; ')})` : ''].filter(Boolean).join(', and ');
  return `Art Director correction for ${p.id} (eval ${ev.n}): ${why}. Stop the current small fixes. Next round: (a) build this plan first: ${plan}. (b) Capture the WHOLE build every round, not a subset: every screen and mode the judge lists in capture_requests, plus a video of real use: ${(ev.capture_requests || []).join(' | ')}. Then submit.`;
}
async function correctDrift(p) {
  const evs = listEvals(p.id); const ev = evs.at(-1); if (!ev || !p.agent?.type || p.agent.corrected_eval === ev.n) return;
  const prevBestCov = evs.slice(-4, -1).reduce((m, e) => Math.max(m, e.coverage?.score ?? -1), -1);
  const drift = ev.next_round?.stalled || (prevBestCov >= 0 && (ev.coverage?.score ?? 10) <= prevBestCov - 2);
  if (!drift) return;
  const info = await agentBusy(p.agent);
  if (p.agent.type === 'claude' && info.busy) return;   // resuming a busy Claude session would fork it; retry next tick
  await sendNudge(p, p.agent, driftText(p, ev, prevBestCov >= 0 ? prevBestCov : null), info, 'drift');
  const pp = loadProject(p.id); pp.agent.corrected_eval = ev.n; saveProject(pp);
  nudgeLog(`${p.id}: drift correction after eval ${ev.n} (stalled=${!!ev.next_round?.stalled}, coverage ${ev.coverage?.score} vs best ${prevBestCov})`);
  return true;
}

async function superviseOnce() {
  for (const id of fs.readdirSync(path.join(DATA, 'projects'))) {
    const p = loadProject(id); if (!p?.agent?.type) continue;
    let corrected = false;
    try { corrected = await correctDrift(p); } catch (e) { nudgeLog(`${id}: drift correction failed: ${e.message}`); }
    if (corrected) continue;
    const last = listEvals(id).at(-1);
    const lastAt = Math.max(new Date(last?.at || 0).getTime(), new Date(p.agent.nudged_at || 0).getTime());
    const after = (p.settings.nudge_after_min ?? 120) * 60000;
    if (Date.now() - lastAt < after) continue;
    const info = await agentBusy(p.agent);
    if (info.busy && !info.error) { continue; }
    if (info.error) { nudgeLog(`${id}: status check failed: ${info.error}`); continue; }
    const hours = Math.round((Date.now() - new Date(last?.at || p.created).getTime()) / 360000) / 10;
    try {
      await sendNudge(p, p.agent, nudgeText(p, last, hours), info);
      const pp = loadProject(id); pp.agent.nudged_at = new Date().toISOString(); saveProject(pp);
      nudgeLog(`${id}: nudged ${p.agent.type} after ${hours} h`);
    } catch (e) { nudgeLog(`${id}: nudge failed: ${e.message}`); }
  }
}
setInterval(() => superviseOnce().catch(e => nudgeLog('supervisor error: ' + e.message)), SUPERVISE_EVERY_MS);
setTimeout(() => superviseOnce().catch(e => nudgeLog('supervisor error: ' + e.message)), 15000);

// ---------- HTTP ----------
const send = (res, code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v, null, 2)); };
// Lenient body parse: agents often send raw Windows paths (C:\Users\...), which are invalid JSON escapes.
const fixSlashes = b => b.replace(/\\(?!["\\/u])/g, '/');
const body = req => new Promise((res, rej) => {
  let b = ''; req.on('data', d => b += d);
  req.on('end', () => {
    if (!b) return res({});
    try { return res(JSON.parse(b)); } catch { }
    try { return res(JSON.parse(fixSlashes(b))); } catch { }
    fs.appendFileSync(path.join(DATA, 'bad-requests.log'), `${new Date().toISOString()} ${req.method} ${req.url}\n${b.slice(0, 2000)}\n\n`);
    rej(new Error('bad JSON body. Use forward slashes in paths, e.g. {"paths":["C:/Users/x/shots/round_05"]}. Body logged to bad-requests.log.'));
  });
});

const DEFAULT_SETTINGS = { max_refs: 12, max_candidates: 8, frames_per_video: 8, ref_width: 768, candidate_width: 1024, compare_previous: true };

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const parts = u.pathname.split('/').filter(Boolean);
  const m = req.method;
  if (m === 'GET' && (parts.length === 0 || parts[0] === 'ui')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(ROOT, 'ui.html'))); }
  if (m === 'GET' && parts[0] === 'api') return send(res, 200, { service: 'artdirector', docs: 'see README.md', port: PORT });
  if (parts[0] !== 'projects') return send(res, 404, { error: 'not found' });

  if (parts.length === 1) {
    if (m === 'GET') return send(res, 200, fs.readdirSync(path.join(DATA, 'projects')).map(loadProject).filter(Boolean)
      .map(p => { const ev = listEvals(p.id); const last = ev.at(-1); return { id: p.id, name: p.name, evals: ev.length, refs: readJson(path.join(pdir(p.id), 'refs.json'), []).length, last_eval_at: last?.at || null, last_overall: last ? (last.owner_overall ?? last.overall) : null, open_gaps: loadGaps(p.id).filter(g => g.status !== 'closed').length }; }));
    if (m === 'POST') {
      const b = await body(req);
      if (!b.name || !b.description || !Array.isArray(b.criteria) || !b.criteria.length) return send(res, 400, { error: 'need name, description, criteria[]' });
      let id = slug(b.id || b.name);
      if (fs.existsSync(pdir(id))) id += '-' + crypto.randomBytes(2).toString('hex');
      const p = {
        id, name: b.name, description: b.description, created: new Date().toISOString(),
        criteria: b.criteria.map(c => typeof c === 'string' ? { key: slug(c).replace(/-/g, '_'), description: c, weight: 1 }
          : { key: c.key || slug(c.name || c.description).replace(/-/g, '_'), description: c.description || c.name, weight: c.weight ?? 1 }),
        judge: { backend: normBackend(b.backend) }, settings: { ...DEFAULT_SETTINGS, ...(b.settings || {}) },
      };
      saveProject(p); saveGaps(id, []); writeJson(path.join(pdir(id), 'refs.json'), []);
      let refs = [];
      if (b.refs?.length) refs = addRefs(p, b.refs);
      return send(res, 201, { ...p, refs_added: refs.length });
    }
  }
  const p = loadProject(parts[1]);
  if (!p) return send(res, 404, { error: 'no such project' });
  const sub = parts[2];
  if (!sub) {
    if (m === 'GET') return send(res, 200, { ...p, refs: readJson(path.join(pdir(p.id), 'refs.json'), []).length, evals: listEvals(p.id).length,
      open_gaps: loadGaps(p.id).filter(g => g.status !== 'closed').length });
    if (m === 'PATCH') {
      const b = await body(req);
      for (const k of ['name', 'description', 'criteria']) if (b[k]) p[k] = b[k];
      if (b.backend) p.judge.backend = normBackend(b.backend);
      if (b.agent !== undefined) p.agent = b.agent;
      if (b.settings) p.settings = { ...p.settings, ...b.settings };
      saveProject(p); return send(res, 200, p);
    }
  }
  if (sub === 'refs') {
    if (m === 'GET') return send(res, 200, readJson(path.join(pdir(p.id), 'refs.json'), []));
    if (m === 'POST' && !parts[3]) { const b = await body(req); const added = addRefs(p, [...(b.paths || []), ...(b.files || [])]); if (b.caption) await enqueue(p.id, () => captionRefs(p, { files: added.map(a => a.file) })); return send(res, 201, { added: added.length, items: added }); }
    if (m === 'POST' && parts[3] === 'caption') {
      const b = await body(req);
      try { const done = await enqueue(p.id, () => captionRefs(p, { onlyEmpty: b.only_empty !== false, files: b.files || null })); return send(res, 200, { captioned: done.length, files: done }); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }
  }
  if (sub === 'file' && m === 'GET') {           // /projects/:id/file/<relative path under the project dir>
    const rel = decodeURIComponent(parts.slice(3).join('/'));
    const f = path.resolve(pdir(p.id), rel);
    if (!f.startsWith(path.resolve(pdir(p.id)) + path.sep) || !fs.existsSync(f)) return send(res, 404, { error: 'no such file' });
    const ext = path.extname(f).toLowerCase();
    res.writeHead(200, { 'Content-Type': ext === '.jpg' ? 'image/jpeg' : ext === '.json' ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'max-age=3600' });
    return fs.createReadStream(f).pipe(res);
  }
  if (sub === 'refs' && parts[3] && (m === 'PATCH' || m === 'DELETE')) {
    const all = readJson(path.join(pdir(p.id), 'refs.json'), []);
    const i = all.findIndex(r => r.file === parts[3]);
    if (i < 0) return send(res, 404, { error: 'no such ref' });
    if (m === 'DELETE') { fs.rmSync(path.join(pdir(p.id), 'refs', all[i].file), { force: true }); all.splice(i, 1); }
    else { const b = await body(req); if (b.note != null) { all[i].note = b.note; all[i].caption_auto = false; } if (b.pinned != null) all[i].pinned = !!b.pinned; }
    writeJson(path.join(pdir(p.id), 'refs.json'), all); return send(res, 200, { ok: true });
  }
  if (sub === 'gaps' && m === 'POST') {
    const b = await body(req); const g = loadGaps(p.id);
    const id = 'G' + (g.reduce((mx, x) => Math.max(mx, Number(x.id.slice(1)) || 0), 0) + 1);
    const n = (listEvals(p.id).at(-1)?.n || 0);
    const gap = { id, criterion: b.criterion || 'general', text: b.text || '', severity: b.severity || 2, evidence: 'added by hand', status: 'open', first_eval: n, last_eval: n, seen: 1, history: [{ eval: n, status: 'new', note: 'added by hand' }] };
    g.push(gap); saveGaps(p.id, g); return send(res, 201, gap);
  }
  if (sub === 'gaps' && parts[3] && (m === 'PATCH' || m === 'DELETE')) {
    const g = loadGaps(p.id); const i = g.findIndex(x => x.id === parts[3]);
    if (i < 0) return send(res, 404, { error: 'no such gap' });
    if (m === 'DELETE') g.splice(i, 1);
    else { const b = await body(req); for (const k of ['text', 'status', 'criterion', 'severity']) if (b[k] != null) g[i][k] = b[k]; g[i].history = [...(g[i].history || []), { eval: g[i].last_eval, status: 'edited', note: 'edited in UI' }]; }
    saveGaps(p.id, g); return send(res, 200, { ok: true });
  }
  if (sub === 'chat') {
    if (m === 'GET' && !parts[3]) return send(res, 200, readJson(chatFile(p.id), []));
    if (m === 'GET' && parts[3] === 'proposal') return send(res, 200, readJson(proposalFile(p.id), null));
    if (m === 'POST' && parts[3] === 'accept') { try { return send(res, 200, acceptProposal(p)); } catch (e) { return send(res, 400, { error: e.message }); } }
    if (m === 'POST' && parts[3] === 'discard') return send(res, 200, discardProposal(p));
    if (m === 'POST' && parts[3] === 'clear') return send(res, 200, clearChat(p));
    if (m === 'POST' && !parts[3]) {
      const b = await body(req);
      try { return send(res, 200, await enqueue(p.id + ':chat', () => runChat(p, b))); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (m === 'POST' && parts[3] === 'undo') {
      const b = await body(req);
      try { return send(res, 200, undoChat(p, b.snapshot)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
  }
  if (sub === 'gaps' && m === 'GET') {
    const st = u.searchParams.get('status');
    let g = loadGaps(p.id);
    if (st === 'open') g = g.filter(x => x.status !== 'closed'); else if (st) g = g.filter(x => x.status === st);
    return send(res, 200, g);
  }
  if (sub === 'evals') {
    if (m === 'GET' && parts[3]) { const e = listEvals(p.id).find(x => String(x.n) === parts[3]); return e ? send(res, 200, e) : send(res, 404, { error: 'no such eval' }); }
    if (m === 'GET') return send(res, 200, listEvals(p.id).map(e => ({ n: e.n, label: e.label, at: e.at, backend: e.backend, overall: e.overall,
      scores: Object.fromEntries(Object.entries(e.scores).map(([k, v]) => [k, v.owner_score ?? v.score])), owner_overall: e.owner_overall ?? null, coverage: e.coverage?.score ?? null, open_gap_count: e.open_gap_count })));
    if (m === 'POST') {
      const b = await body(req);
      try { const r = await enqueue(p.id, () => runEval(p, b)); setTimeout(() => { const pp = loadProject(p.id); if (pp?.agent?.type) correctDrift(pp).catch(e => nudgeLog(p.id + ': drift correction failed: ' + e.message)); }, 1000); return send(res, 200, b.full ? r : compactResult(r)); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }
  }
  return send(res, 404, { error: 'not found' });
}

function addRefs(p, items) {
  const added = ingest(expandPaths(items), path.join(pdir(p.id), 'refs'), { maxW: p.settings.ref_width, framesPerVideo: p.settings.frames_per_video })
    .filter(x => !x.error);
  const all = [...readJson(path.join(pdir(p.id), 'refs.json'), []), ...added];
  writeJson(path.join(pdir(p.id), 'refs.json'), all);
  return added;
}

http.createServer((req, res) => route(req, res).catch(e => send(res, 500, { error: e.message })))
  .listen(PORT, HOST, () => console.log(`artdirector on http://${HOST}:${PORT}/  data: ${DATA}`));
