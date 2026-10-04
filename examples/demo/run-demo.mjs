// Create the demo project and (optionally) run an eval against it.
//   node examples/demo/run-demo.mjs            create the project and add refs
//   node examples/demo/run-demo.mjs round1     also judge round 1 (needs a working backend)
// Set REFEREE_URL if the server is not on http://127.0.0.1:4600.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.REFEREE_URL || 'http://127.0.0.1:4600';
const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const call = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${url}: ${j.error || r.status}`);
  return j;
};

let project = (await call('GET', '/projects')).find(p => p.id === 'fox-run-demo');
if (!project) {
  project = await call('POST', '/projects', {
    id: 'fox-run-demo',
    name: 'Fox Run (demo)',
    description: 'A 2D side-scrolling platformer. A small orange fox runs across layered hills at dusk, collecting gold coins. The look is soft and painterly: a purple-to-peach gradient sky, a glowing low sun, three layers of hills fading into mist, and a minimal heart-and-coin HUD.',
    criteria: [
      { key: 'atmosphere', description: 'Sky gradient, sun glow, mist and depth between hill layers', weight: 1.5 },
      { key: 'character', description: 'The fox: size in frame, silhouette, colour, readable details (tail tip, eye, chest)', weight: 1 },
      { key: 'palette', description: 'Colours match the dusk palette of the refs (purples, peach, warm orange)', weight: 1 },
      { key: 'hud', description: 'Heart and coin HUD: shapes, placement, legibility', weight: 0.5 },
    ],
    backend: process.env.REFEREE_BACKEND || undefined,
    refs: [`${HERE}/refs`],
  });
  console.log(`created ${project.id} with ${project.refs_added} refs`);
  const pin = (await call('GET', `/projects/${project.id}/refs`)).find(r => r.source === 'target-dusk-run.jpg');
  await call('PATCH', `/projects/${project.id}/refs/${encodeURIComponent(pin.file)}`, {
    pinned: true,
    note: 'Key look: dusk side view. Purple-to-peach sky, glowing sun low on the right, three hill layers fading into pink mist, orange fox small in the lower left, heart and coin HUD at the top.',
  });
} else console.log(`project ${project.id} already exists`);

const round = process.argv[2];
if (round) {
  console.log(`judging ${round} (this takes 1-3 minutes)...`);
  const r = await call('POST', `/projects/${project.id}/evals`, { paths: [`${HERE}/${round}`], label: round });
  console.log(JSON.stringify(r, null, 2));
}
console.log(`open ${BASE}/#${project.id}`);
