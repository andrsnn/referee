// Example Referee playtest scenario for a browser game (WebGL, canvas, or DOM).
// Copy it, keep it with the judge (not in the game repo the agent edits), and point a project at it:
//   PATCH /projects/<id>  {"settings":{"playtest":{"url":"http://localhost:5173/","script":"playtests/my-game.mjs","every_eval":true,"max_seconds":75}}}
//
// The runner opens `url` in headless Chromium, records a video, and calls the default export with a helper `t`:
//   t.page                    the Playwright page (keyboard, mouse, locators)
//   t.clickText(re, ms)       click the first visible button, link or text matching re (throws if not found)
//   t.tryClickText(re, ms)    same, returns false instead of throwing
//   t.waitGone(re, ms)        wait until the page text no longer matches re (loading screens)
//   t.playing()               mark the start of play: the video is trimmed to start here and the max_seconds clock starts
//   t.hold(keys, ms)          hold one key or several keys together, e.g. t.hold(['KeyW', 'ShiftLeft'], 3000)
//   t.press(key, afterMs)     tap a key, then wait
//   t.look(dx, dy, steps)     move the mouse from the centre by dx, dy
//   t.wait(ms)                wait (never past the end of the play window)
//   t.timeLeft()              ms left in the play window
//   t.fps(seconds, label)     count requestAnimationFrame callbacks; reported to the judge
//   t.log(msg)                write to the playtest log
// Throwing (or timing out) marks the playtest as failed. The judge is told about the failure, the console errors
// and the FPS, and sees the failure screenshot.
//
// Keep the inputs fixed and simple: the point is to show the judge what a player sees after a fresh start,
// not to play well. Exercise the core loop: movement, camera, the main action, the main menus.

// One line the judge reads, describing what the script does.
export const description = 'Fresh New Game, then: walk, sprint, strafe, look around, aim and fire, reload, interact, open the main menu.';

export default async function (t) {
  const { page } = t;

  // 1. Start a fresh game from the title screen. Adjust the button text and loading text to your game.
  await t.clickText(/^(new game|start|play)/i, 120000);
  await t.tryClickText(/^(yes|confirm|overwrite)/i, 3000);   // "replace your save?" prompts
  try { await page.getByText(/loading/i).first().waitFor({ state: 'visible', timeout: 5000 }); } catch { }
  await t.waitGone(/loading/i, 150000);
  await t.wait(1500);
  await page.mouse.click(640, 360);   // focus the canvas
  t.playing();

  // 2. Movement and camera. Measure FPS while something is happening.
  await Promise.all([t.fps(5, 'moving'), t.hold('KeyW', 5000)]);
  await t.look(-300, 0); await t.wait(600); await t.look(400, 30); await t.wait(600);
  await t.hold(['KeyW', 'ShiftLeft'], 4000);        // sprint
  await t.hold('KeyA', 1800); await t.hold('KeyD', 1800);   // strafe

  // 3. The main action: aim (right mouse) and fire (left mouse), reload.
  await page.mouse.down({ button: 'right' }); await t.wait(800);
  for (let i = 0; i < 6; i++) { await page.mouse.down(); await t.wait(250); await page.mouse.up(); await t.wait(200); }
  await t.press('KeyR', 2000);
  await page.mouse.down(); await t.wait(1500); await page.mouse.up();
  await page.mouse.up({ button: 'right' });

  // 4. Interact and a menu.
  await t.hold('KeyE', 2000);
  await t.press('Escape', 2500);
  await t.press('Escape', 1000);

  // 5. Keep playing until the window ends, with a second FPS sample.
  await Promise.all([t.fps(5, 'late'), t.hold('KeyW', 5000)]);
  while (t.timeLeft() > 3000) { await t.look(200, 0); await t.hold('KeyW', 2500); }
}
