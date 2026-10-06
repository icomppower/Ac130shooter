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
  muzzlePixels: 80,
  strobePixels: 25,
  operatorUnlit: 0.22,
  frameP95Ms: 20,
  frameSamples: 400,
  liveSeconds: 20,
  liveAdvanceSeconds: 15,
  // §24 visual upgrade, pre-registered before the first run against them.
  clutterInView: 40,        // G13, at every phase capture
  clutterLitP95Max: 0.70,   // G14, cold band ceiling for clutter
  shadowPixelsV24: 338,     // G15, 2x the §18 baseline of 169
  bloomFarLitMax: 0.02,     // G16, share of the frame >30 m out that bloom touches
  bloomNearOverFar: 20,     // G16, impact region must glow at least this much harder
  // §25 TV channel, pre-registered before its first run.
  tvSilhouette: 0.28,       // G17, worst civilian/armed pair, dark mask, zoom step 2
  tvDarkBelow: 0.20,        // G17, a pixel below this luminance belongs to the figure
};

// The reference machine is a Mac on Metal. Anywhere else the browser falls
// back to SwiftShader, a CPU rasteriser whose frame times say nothing about
// the game. G8 is then reported as SKIP rather than passed or failed: a cloud
// run can never sign off performance, and it must not pretend to.
const REFERENCE_GPU = process.platform === 'darwin';

const results = [];
let failed = 0;

function gate(id, title, ok, detail, {skip = false} = {}) {
  results.push({id, title, pass: skip ? null : !!ok, skipped: skip, detail});
  if (!ok && !skip) failed++;
  const mark = skip ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  console.log(`${skip ? '–' : ok ? '✔' : '✖'} ${id.padEnd(5)} ${mark}  ${title}`);
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
    // Where puppeteer's own Chrome download is unreachable, point this at any
    // local Chromium. Unset, puppeteer uses the browser it installed.
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    // A CPU rasteriser can take well over puppeteer's default 3 minutes to
    // produce one screenshot of the dense §25 scene.
    protocolTimeout: REFERENCE_GPU ? 180000 : 900000,
    args: [
      '--no-sandbox',
      '--enable-gpu',
      // The reference machine is a Mac. Anywhere else (a Linux CI box, a
      // cloud session) there is no Metal, so fall back to SwiftShader. Its
      // frame times are not comparable to the reference — see G7.
      ...(REFERENCE_GPU
        ? ['--use-angle=metal']
        : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--in-process-gpu']),
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
      const clutter = [];
      const marks = [6, 150, 290, 430, 560, 640, 700];
      for (const seconds of marks) {
        await page.evaluate(s => window.__spectre.fastForward(s), seconds);
        await sleep(260);
        const state = await page.evaluate(() => window.__spectre.state());
        phases.push({at: seconds, phase: state.phase, route: +state.routeFraction.toFixed(3), status: state.status});
        await page.screenshot({path: `${OUT}g5-phase${state.phase}-t${seconds}.png`});
        if (state.status !== 'playing') break;
        const c = await page.evaluate(() => window.__spectre.clutterProbe());
        clutter.push({at: seconds, phase: state.phase, inView: c.inView,
          litP95: +c.litP95.toFixed(3), litMean: +c.litMean.toFixed(3)});
      }
      const seen = new Set(phases.map(p => p.phase));
      const monotonic = phases.every((p, i) => i === 0 || p.phase >= phases[i - 1].phase);
      gate('G5', 'all five phases reached, captured, and never go backwards',
        [0, 1, 2, 3, 4].every(p => seen.has(p)) && monotonic && errors.length === 0,
        {phases, errors: errors.slice(0, 3)});

      // ---------------------------------------------- G13 / G14 clutter (§24)
      const fewest = clutter.reduce((a, b) => (a.inView <= b.inView ? a : b));
      gate('G13', `at least ${T.clutterInView} pieces of clutter in view at every phase capture`,
        clutter.length > 0 && fewest.inView >= T.clutterInView,
        {threshold: T.clutterInView, fewest, captures: clutter});
      // A wreck or a fence must never be mistaken for a person. Its brightest
      // lit faces stay in the cold band whatever the sun is doing.
      const brightest = clutter.reduce((a, b) => (a.litP95 >= b.litP95 ? a : b));
      gate('G14', `clutter stays cold: p95 of its lit pixels <= ${T.clutterLitP95Max}`,
        clutter.length > 0 && brightest.litP95 <= T.clutterLitP95Max,
        {threshold: T.clutterLitP95Max, brightest});

      // A 105 mm strike in frame, for the human review of the explosion look.
      // Record only, for the human review: never allowed to fail the run.
      try {
        await page.evaluate(() => window.__spectre.strike(2, 18, 8, 30));
        await page.screenshot({path: OUT + 'g16-strike-plume.png'});
      } catch (e) {console.log(`        (strike capture skipped: ${String(e).slice(0, 80)})`);}
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
      // §24 raised the bar: the reference frame is hard-lit, and every figure
      // throws a long black shadow. Same probe, twice the baseline.
      gate('G15', `long hard shadows: >= ${T.shadowPixelsV24} darkened pixels beside a unit (2x §18)`,
        probe && probe.shadowedPixels >= T.shadowPixelsV24
        && probe.reversePixels < probe.shadowedPixels / T.shadowReverseRatio,
        {threshold: T.shadowPixelsV24, shadowedPixels: probe?.shadowedPixels});

      // ------------------------------------------------ G16 bloom selectivity
      const bloom = await page.evaluate(() => window.__spectre.bloomProbe());
      gate('G16', 'a 105 mm impact glows where it lands and nowhere else',
        bloom
        && bloom.farLitFraction < T.bloomFarLitMax
        && bloom.nearMean >= Math.max(bloom.farMean, 1 / 255) * T.bloomNearOverFar,
        {thresholds: {farLit: T.bloomFarLitMax, nearOverFar: T.bloomNearOverFar}, ...bloom});
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
      // Every civilian variant against every armed figure. The column carries
      // three body types and adding variety must never buy itself readability:
      // the gate is the worst pair, not the first one.
      const CIVILIANS = ['civilian', 'civilian2', 'child'];
      const ARMED = ['rifle', 'mg', 'rpg'];
      const pairs = [];
      for (const civ of CIVILIANS) {
        for (const armed of ARMED) {
          const r = await page.evaluate(
            ([a, b, z]) => window.__spectre.silhouette(a, b, z),
            [civ, armed, T.silhouetteZoom]);
          pairs.push({pair: `${civ} vs ${armed}`, distance: r && +r.jaccardDistance.toFixed(4)});
        }
      }
      const worst = pairs.reduce((a, b) => (a.distance <= b.distance ? a : b));
      // Zoom sweep on the reference pair, for the record.
      const byZoom = [];
      for (const zoom of [1, 2, 3, 4]) {
        const r = await page.evaluate(z => window.__spectre.silhouette('civilian', 'rifle', z), zoom);
        byZoom.push({zoom, distance: r && +r.jaccardDistance.toFixed(4)});
      }
      for (const kind of [...CIVILIANS, ...ARMED, 'operator']) {
        await page.evaluate((k, z) => window.__spectre.silhouette(k, k, z), kind, 4);
        await page.screenshot({path: `${OUT}g7-${kind}.png`, clip: {x: 440, y: 140, width: 400, height: 440}});
      }
      gate('G7', `every civilian variant differs from every armed figure at zoom ${T.silhouetteZoom}`,
        worst.distance >= T.silhouette,
        {threshold: T.silhouette, worst, pairs, byZoom});
      await page.close();

      const same = await open(browser, '?idprobe=civilian&zoom=2&nonoise&mutate=samemodel');
      const mutated = await same.page.evaluate(z => window.__spectre.silhouette('civilian', 'rifle', z), T.silhouetteZoom);
      gate('G7n', 'negative: the measure collapses when both render the same model',
        mutated && mutated.jaccardDistance < T.silhouetteNegativeMax,
        {distance: mutated && +mutated.jaccardDistance.toFixed(4), max: T.silhouetteNegativeMax});
      await same.page.close();
    }

    // --------------------------------------- G17 TV channel identification
    {
      // The TV channel is the default (§25). A civilian must still not look
      // like an armed figure on it. Same probe, same worst-pair rule as G7,
      // but a figure is its *dark* pixels on this channel.
      const {page} = await open(browser, '?idprobe=civilian&zoom=2&nonoise&sensor=tv');
      const pairs = [];
      for (const civ of ['civilian', 'civilian2', 'child']) {
        for (const armed of ['rifle', 'mg', 'rpg']) {
          const r = await page.evaluate(
            ([a, b, z, t]) => window.__spectre.silhouette(a, b, z, t, true),
            [civ, armed, T.silhouetteZoom, T.tvDarkBelow]);
          pairs.push({pair: `${civ} vs ${armed}`, distance: r && +r.jaccardDistance.toFixed(4), areaA: r?.areaA, areaB: r?.areaB});
        }
      }
      const worst = pairs.reduce((a, b) => (a.distance <= b.distance ? a : b));
      // A mask that is empty for both figures would score 0 and fail; one that
      // swallowed the frame would also be meaningless. Require real figures.
      const real = pairs.every(p => p.areaA > 20 && p.areaB > 20);
      await page.evaluate(z => window.__spectre.silhouette('rifle', 'rifle', z, 0.2, true), 4);
      await page.screenshot({path: OUT + 'g17-tv-rifle.png', clip: {x: 440, y: 140, width: 400, height: 440}});
      gate('G17', `on the TV channel every civilian variant differs from every armed figure at zoom ${T.silhouetteZoom}`,
        real && worst.distance >= T.tvSilhouette,
        {threshold: T.tvSilhouette, darkBelow: T.tvDarkBelow, worst, pairs});
      await page.close();
    }

    // ---------------------------------------------- G12 identification IFF
    {
      const {page} = await open(browser, '?idprobe=operator&zoom=2&nonoise');
      const probe = await page.evaluate(() => window.__spectre.strobeProbe(2));
      await page.screenshot({path: OUT + 'g12-strobe.png'});
      gate('G12', 'the ground team is marked, continuously, and nothing armed is',
        probe
        && probe.friendlyLitPixels >= T.strobePixels
        && probe.armedWithStrobe === 0
        && probe.operatorVsHostileUnlit >= T.operatorUnlit,
        {thresholds: {lit: T.strobePixels, unlit: T.operatorUnlit}, ...probe});
      await page.close();
    }

    // ------------------------------------------------- G11 muzzle flashes
    {
      const {page} = await open(browser, '?idprobe=rifle&zoom=2&nonoise');
      const probe = await page.evaluate(() => window.__spectre.muzzleProbe(2));
      gate('G11', 'a firing hostile lights the ground around itself',
        probe && probe.litPixels >= T.muzzlePixels,
        {threshold: T.muzzlePixels, ...probe, rect: undefined});
      await page.close();
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
      gate('G8', `p95 frame time under ${T.frameP95Ms} ms at 1280x720, under load`
        + (REFERENCE_GPU ? '' : ' (not reference hardware: run on the Mac to sign off)'),
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
        }, {skip: !REFERENCE_GPU});
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
      // The pace half of this gate is wall-clock: 15 s of game in 20 s of real
      // time. A CPU rasteriser renders a frame every few seconds, so off the
      // reference machine only the liveness half is asserted, and the title
      // says so.
      gate('G10', 'the loop keeps running and the readouts keep up with it'
        + (REFERENCE_GPU ? '' : ' (pace not asserted off reference hardware)'),
        advanced >= (REFERENCE_GPU ? T.liveAdvanceSeconds : 0.5)
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

  const skipped = results.filter(r => r.skipped).length;
  console.log(`\n${results.length - failed - skipped}/${results.length} gates passed`
    + (skipped ? `, ${skipped} skipped (${results.filter(r => r.skipped).map(r => r.id).join(', ')})` : '') + '.');
  console.log(`Captures and report in gate/out/`);
  if (failed) process.exitCode = 1;
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
