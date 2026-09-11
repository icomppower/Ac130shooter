/**
 * The kill gate. The build is not done until this passes.
 *
 * It drives the production build in a real browser and asserts numbers, not
 * impressions. Thresholds are pre-registered in DECISIONS.md and are not
 * adjusted to fit a result. Two of the gates carry a paired negative test,
 * because a gate that cannot fail is not a gate.
 *
 *   npm run build && npm run gate
 *
 * Screenshots land in gate/out/ as a record for a human. Nothing is asserted
 * from them.
 */
import {spawn} from 'node:child_process';
import {mkdir, writeFile, rm} from 'node:fs/promises';
import {createConnection} from 'node:net';
import puppeteer from 'puppeteer';

const PORT = 4187;
const BASE = `http://127.0.0.1:${PORT}/Ac130shooter/`;
const OUT = new URL('./out/', import.meta.url).pathname;

// --- pre-registered thresholds (see DECISIONS.md) ---------------------------
const T = {
  shadowPixels: 150,
  shadowReverseRatio: 3,
  shadowNegativeMax: 50,
  silhouette: 0.28,
  silhouetteNegativeMax: 0.10,
  silhouetteZoom: 2,
  frameP95Ms: 20,
  frameSamples: 400,
  liveSeconds: 20,
  liveAdvanceSeconds: 15,
};

const results = [];
let failed = 0;

function gate(id, title, ok, detail) {
  results.push({id, title, pass: !!ok, detail});
  if (!ok) failed++;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${ok ? '✔' : '✖'} ${id.padEnd(5)} ${mark}  ${title}`);
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise(resolve => {
      const socket = createConnection({port, host: '127.0.0.1'});
      socket.on('connect', () => {socket.end(); resolve(true);});
      socket.on('error', () => resolve(false));
      socket.setTimeout(700, () => {socket.destroy(); resolve(false);});
    });
    if (open) return true;
    await sleep(250);
  }
  return false;
}

/** Open a page, collect its console errors, and wait for the game to be ready. */
async function open(browser, query, {width = 1280, height = 720, touch = false} = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => {if (m.type() === 'error') errors.push(m.text());});
  page.on('pageerror', e => errors.push(String(e)));
  page.on('requestfailed', r => errors.push(`requestfailed ${r.url()}`));
  await page.setViewport({
    width, height,
    deviceScaleFactor: 1,
    hasTouch: touch,
    isMobile: touch,
  });
  await page.goto(BASE + query, {waitUntil: 'load', timeout: 45000});
  await page.waitForFunction(
    () => window.__spectre && window.__spectre.state().assetFallbacks !== undefined,
    {timeout: 45000});
  // One extra frame so the first measurement is not of a half-built scene.
  await sleep(400);
  return {page, errors};
}

async function main() {
  await rm(OUT, {recursive: true, force: true});
  await mkdir(OUT, {recursive: true});

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    stdio: 'ignore',
    detached: false,
  });
  const up = await waitForPort(PORT);
  if (!up) {
    server.kill();
    throw new Error(`preview server never came up on ${PORT}; run npm run build first`);
  }

  // Real GPU, no frame-rate cap. A p95 frame-time gate measured with vsync on
  // measures the monitor's refresh period, not the cost of the frame.
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--enable-gpu',
      '--use-angle=metal',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu',
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });

  try {
    // ---------------------------------------------------------------- G0 boot
    {
      const {page, errors} = await open(browser, '');
      const state = await page.evaluate(() => window.__spectre.state());
      const renderer = await page.evaluate(() => {
        const gl = document.querySelector('canvas').getContext('webgl2')
          || document.querySelector('canvas').getContext('webgl');
        const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
      });
      await page.screenshot({path: OUT + 'g0-menu.png'});
      gate('G0', 'boots clean with every asset loaded',
        errors.length === 0 && state.assetFallbacks === 0,
        {errors, assetFallbacks: state.assetFallbacks, renderer});
      await page.close();
    }

    // -------------------------------------------------- G5 phases + captures
    {
      const {page, errors} = await open(browser, '?autostart&autofire&ff=6');
      const phases = [];
      const marks = [6, 150, 290, 430, 560, 640, 700];
      for (const seconds of marks) {
        await page.evaluate(s => window.__spectre.fastForward(s), seconds);
        await sleep(260);
        const state = await page.evaluate(() => window.__spectre.state());
        phases.push({at: seconds, phase: state.phase, route: +state.routeFraction.toFixed(3), status: state.status});
        await page.screenshot({path: `${OUT}g5-phase${state.phase}-t${seconds}.png`});
        if (state.status !== 'playing') break;
      }
      const seen = new Set(phases.map(p => p.phase));
      const monotonic = phases.every((p, i) => i === 0 || p.phase >= phases[i - 1].phase);
      gate('G5', 'all five phases reached, captured, and never go backwards',
        [0, 1, 2, 3, 4].every(p => seen.has(p)) && monotonic && errors.length === 0,
        {phases, errors: errors.slice(0, 3)});
      await page.close();
    }

    // ---------------------------------------------------- G6 shadows + G6n
    {
      const {page} = await open(browser, '?idprobe=rifle&zoom=2&nonoise');
      const probe = await page.evaluate(() => window.__spectre.shadowProbe(2));
      await page.screenshot({path: OUT + 'g6-shadow-on.png'});
      const ok = probe
        && probe.shadowedPixels >= T.shadowPixels
        && probe.reversePixels < probe.shadowedPixels / T.shadowReverseRatio;
      gate('G6', 'the shadow map actually darkens ground beside a unit', ok, probe);
      await page.close();

      const off = await open(browser, '?idprobe=rifle&zoom=2&nonoise&mutate=noshadows');
      const probeOff = await off.page.evaluate(() => window.__spectre.shadowProbe(2));
      await off.page.screenshot({path: OUT + 'g6n-shadow-off.png'});
      gate('G6n', 'negative: the same probe fails on a build with shadows off',
        probeOff && probeOff.shadowedPixels < T.shadowNegativeMax,
        probeOff);
      await off.page.close();
    }

    // ------------------------------------------------- G7 silhouette + G7n
    {
      const {page} = await open(browser, '?idprobe=civilian&zoom=2&nonoise');
      const measured = [];
      for (const zoom of [1, 2, 3, 4]) {
        const r = await page.evaluate(z => window.__spectre.silhouette('civilian', 'rifle', z), zoom);
        measured.push({zoom, distance: r && +r.jaccardDistance.toFixed(4), areaCiv: r?.areaA, areaHostile: r?.areaB});
      }
      // Capture the two figures at the gated zoom, side by side, for the record.
      for (const kind of ['civilian', 'rifle', 'mg', 'rpg']) {
        await page.evaluate((k, z) => window.__spectre.silhouette(k, k, z), kind, T.silhouetteZoom);
        await page.screenshot({path: `${OUT}g7-${kind}.png`});
      }
      const gated = measured.find(m => m.zoom === T.silhouetteZoom);
      gate('G7', `civilian and hostile resolve to different shapes at zoom ${T.silhouetteZoom}`,
        gated && gated.distance >= T.silhouette,
        {threshold: T.silhouette, measured});
      await page.close();

      const same = await open(browser, '?idprobe=civilian&zoom=2&nonoise&mutate=samemodel');
      const mutated = await same.page.evaluate(z => window.__spectre.silhouette('civilian', 'rifle', z), T.silhouetteZoom);
      gate('G7n', 'negative: the measure collapses when both render the same model',
        mutated && mutated.jaccardDistance < T.silhouetteNegativeMax,
        {distance: mutated && +mutated.jaccardDistance.toFixed(4), max: T.silhouetteNegativeMax});
      await same.page.close();
    }

    // ------------------------------------------------------ G8 performance
    {
      // Measure mid-fight, not after it. An earlier version of this gate
      // fast-forwarded past the end of the mission and happily reported a
      // 2.8 ms p95 for an empty map, so the measurement now has to prove
      // there was something on screen while it was taken.
      const {page, errors} = await open(browser, '?autostart&autofire&ff=430');
      await sleep(700);
      await page.evaluate(() => window.__spectre.resetFrameStats());
      const during = [];
      for (let i = 0; i < 7; i++) {
        await sleep(2000);
        during.push(await page.evaluate(() => {
          const s = window.__spectre.state();
          return {enemies: s.enemies, entities: s.liveEntities, status: s.status, calls: s.drawCalls};
        }));
      }
      const stats = await page.evaluate(() => window.__spectre.frameStats());
      const state = await page.evaluate(() => window.__spectre.state());
      await page.screenshot({path: OUT + 'g8-fight.png'});
      // "Under load" means the scene was populated and the mission was live
      // throughout. Enemy count alone is a bad proxy: the scripted gunner
      // clears waves faster than they arrive, so it dips to zero between them.
      const busy = during.every(d => d.status === 'playing' && d.entities >= 15 && d.calls >= 120)
        && Math.max(...during.map(d => d.enemies)) >= 3;
      gate('G8', `p95 frame time under ${T.frameP95Ms} ms at 1280x720, under load`,
        busy && stats.samples >= T.frameSamples && stats.p95 <= T.frameP95Ms,
        {
          samples: stats.samples,
          p50: +stats.p50?.toFixed(2),
          p95: +stats.p95?.toFixed(2),
          p99: +stats.p99?.toFixed(2),
          sceneDrawCalls: state.drawCalls,
          sceneTriangles: state.triangles,
          sceneWasBusy: busy,
          enemiesDuring: during.map(d => d.enemies),
          errors: errors.slice(0, 3),
        });
      await page.close();
    }

    // ------------------------------------------------------------ G9 phone
    {
      const {page, errors} = await open(browser, '?autostart&ff=4', {width: 390, height: 844, touch: true});
      await sleep(500);
      const reach = await page.evaluate(() => {
        const controls = Array.from(document.querySelectorAll('.touch button'));
        const misses = [];
        for (const el of controls) {
          const r = el.getBoundingClientRect();
          if (r.width < 28 || r.height < 28) {misses.push({el: el.textContent?.trim(), reason: 'too small', w: r.width, h: r.height}); continue;}
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (hit !== el && !el.contains(hit)) {
            misses.push({el: el.textContent?.trim(), reason: 'occluded', by: hit?.className || hit?.tagName});
          }
        }
        const doc = document.documentElement;
        return {
          controls: controls.length,
          misses,
          overflowX: doc.scrollWidth - doc.clientWidth,
          bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
        };
      });
      await page.screenshot({path: OUT + 'g9-phone.png'});
      gate('G9', 'every touch control is reachable at 390x844 with no sideways scroll',
        reach.controls > 0 && reach.misses.length === 0 && reach.overflowX <= 0 && errors.length === 0,
        {...reach, errors: errors.slice(0, 3)});
      await page.close();
    }

    // ------------------------------------------------- G10 sustained loop
    {
      const {page, errors} = await open(browser, '?autostart&autofire&ff=560');
      const sample = () => page.evaluate(() => ({
        state: window.__spectre.state(),
        timecode: document.querySelector('[data-id=tc]')?.textContent,
        routeText: document.querySelector('[data-id=routeText]')?.textContent,
        subtitle: document.querySelector('[data-id=subtitle]')?.textContent,
      }));
      const before = await sample();
      await sleep(T.liveSeconds * 1000);
      const after = await sample();
      await page.screenshot({path: OUT + 'g10-live.png'});
      const advanced = after.state.time - before.state.time;
      gate('G10', 'the loop keeps running and the readouts keep up with it',
        advanced >= T.liveAdvanceSeconds
        && after.timecode !== before.timecode
        && after.state.status !== 'lost'
        && errors.length === 0,
        {
          advancedSeconds: +advanced.toFixed(1),
          timecode: [before.timecode, after.timecode],
          status: after.state.status,
          heloInbound: after.state.heloInbound,
          held: +after.state.held.toFixed(1),
          errors: errors.slice(0, 3),
        });
      await page.close();
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  await writeFile(OUT + 'report.json', JSON.stringify({
    when: new Date().toISOString(),
    thresholds: T,
    results,
    failed,
  }, null, 2));

  console.log(`\n${results.length - failed}/${results.length} gates passed.`);
  console.log(`Captures and report in gate/out/`);
  if (failed) process.exitCode = 1;
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
