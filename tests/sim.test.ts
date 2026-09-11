import test from 'node:test';
import assert from 'node:assert/strict';
import {Sim, CIVILIAN_COUNT, OPERATOR_COUNT} from '../src/sim/sim';
import {MissionDirector, PHASES, SPAWN_CUTOFF} from '../src/sim/director';
import {RadioSystem} from '../src/sim/radio';
import {WeaponSystem, WEAPONS} from '../src/sim/weapons';
import {alongRoute, bearingOf, bearingPoint, HOLD_SECONDS, LZ, ROUTE, ROUTE_LENGTH} from '../src/sim/route';
import {Rng} from '../src/sim/rng';
import {distance} from '../src/sim/types';
import {autoGunner, playMission, report} from './harness';

test('route geometry is continuous and bearings are relative to the axis of advance', () => {
  assert.ok(ROUTE_LENGTH > 1200 && ROUTE_LENGTH < 1700, `route length ${ROUTE_LENGTH}`);
  assert.ok(distance(alongRoute(0).position, ROUTE[0]) < 1e-6);
  assert.ok(distance(alongRoute(ROUTE_LENGTH).position, LZ) < 1e-6);
  // Past the end the route clamps rather than extrapolating off the map.
  assert.ok(distance(alongRoute(ROUTE_LENGTH * 3).position, LZ) < 1e-6);
  // Walking the route never jumps.
  let prev = alongRoute(0).position;
  for (let d = 5; d <= ROUTE_LENGTH; d += 5) {
    const p = alongRoute(d).position;
    assert.ok(distance(prev, p) < 6.5, `gap of ${distance(prev, p)} at ${d}m`);
    prev = p;
  }
  const heading = {x: 1, z: 0};
  const origin = {x: 0, z: 0};
  assert.equal(bearingOf({x: 50, z: 0}, origin, heading), 'ahead');
  assert.equal(bearingOf({x: -50, z: 0}, origin, heading), 'trailing');
  assert.equal(bearingOf({x: 0, z: 50}, origin, heading), 'right');
  assert.equal(bearingOf({x: 0, z: -50}, origin, heading), 'left');
  // bearingPoint and bearingOf are inverses.
  for (const b of ['ahead', 'left', 'right', 'trailing'] as const) {
    assert.equal(bearingOf(bearingPoint(origin, heading, b, 120), origin, heading), b);
  }
});

test('the seeded generator replays identically and the sim is deterministic', () => {
  const a = new Rng(1234), b = new Rng(1234);
  for (let i = 0; i < 500; i++) assert.equal(a.next(), b.next());

  const one = playMission(new Sim('score', 'normal', 777)).sim;
  const two = playMission(new Sim('score', 'normal', 777)).sim;
  assert.equal(one.status, two.status);
  assert.equal(one.time.toFixed(4), two.time.toFixed(4));
  assert.equal(one.stats.score, two.stats.score);
  assert.equal(one.progress.toFixed(4), two.progress.toFixed(4));
  assert.deepEqual(one.stats, two.stats);
});

test('hardcore ends on a civilian casualty; score mode penalises and continues', () => {
  for (const mode of ['hardcore', 'score'] as const) {
    const s = new Sim(mode);
    s.start();
    s.entities = s.entities.filter(e => e.side === 'friendly');
    const c = s.spawn('civilian', {x: 900, z: 900}, 'trailing');
    s.explode({x: c.x, z: c.z, weapon: 0});
    assert.equal(c.hp, 0);
    assert.equal(s.stats.civilians, 1);
    assert.equal(s.stats.score, -2500);
    assert.equal(s.status, mode === 'hardcore' ? 'lost' : 'playing');
  }
});

test('the civilian rule is source-independent: enemy fire fails hardcore too', () => {
  const s = new Sim('hardcore');
  s.start();
  s.damage(s.civilians[0], 999, 'enemy');
  assert.equal(s.status, 'lost');
  assert.match(s.reason, /rules of engagement/i);
});

test('enemy mortar fire actually reaches the civilians in the column', () => {
  // Score mode, so the run continues and the damage can be observed. The column
  // is pinned by an armoured blocker and the tube is parked beyond the ground
  // team's reach, which is the situation the mortar threat models: standoff
  // fire the player has to go and hunt.
  const s = new Sim('score');
  s.start();
  const {position, heading} = s.head;
  const flank = {x: -heading.z, z: heading.x};
  const tube = s.spawn('mortar', {x: position.x + flank.x * 400, z: position.z + flank.z * 400}, 'right');
  const blocker = s.spawn('assault', {x: position.x + heading.x * 60, z: position.z + heading.z * 60}, 'ahead');
  blocker.hp = blocker.maxHp = 1e9;

  let hurt = -1;
  for (let i = 0; i < 3000 && hurt < 0; i++) {
    s.update(0.1);
    if (s.entities.some(e => e.side === 'civilian' && e.hp < e.maxHp)) hurt = s.time;
  }
  assert.ok(hurt > 0 && hurt < 120, `no civilian took mortar damage within 120s (got ${hurt})`);
  assert.ok(tube.hp > 0, 'the tube should be beyond the ground team, not killable by them');
  assert.equal(s.pinned, true, 'the blocker should have stopped the column');
});

test('friendly-fire with a heavy weapon ends a hardcore run; losing the team ends any run', () => {
  const s = new Sim('hardcore');
  s.start();
  const f = s.operators[0];
  s.explode({x: f.x, z: f.z, weapon: 2});
  assert.ok(s.stats.friendlyFire > 0);
  assert.equal(s.status, 'lost');

  const t = new Sim('score');
  t.start();
  t.entities = t.entities.filter(e => e.side !== 'friendly');
  t.update(0.1);
  assert.equal(t.status, 'lost');
});

test('shells have flight time and splash falls off with distance', () => {
  const s = new Sim('score');
  s.start();
  // Keep the civilians: with no one left to escort the mission ends immediately
  // and the shell in flight would never land.
  const near = s.spawn('assault', {x: 900, z: 800}, 'ahead');
  const far = s.spawn('assault', {x: 912, z: 800}, 'ahead');
  s.weapons.selected = 2;
  assert.ok(s.fire(near, {x: 1200, z: 1200}));
  s.update(0.5);
  assert.equal(near.hp, near.maxHp, 'shell must not land instantly');
  s.update(1.2);
  assert.ok(near.hp < far.hp, `falloff: near ${near.hp} vs far ${far.hp}`);
  assert.equal(s.stats.hits, 1);
});

test('reloading moves rounds out of reserve and never manufactures them', () => {
  const w = new WeaponSystem('normal');
  w.selected = 2;
  assert.ok(w.fire());
  assert.ok(!w.fire());
  const before = w.remaining;
  w.update(5);
  assert.equal(w.remaining, before);
  assert.equal(w.slots[2].ammo, 1);
  assert.equal(w.slots[2].reserve, 54);

  // The weapons-free top-up is also bounded by reserve.
  const dry = new WeaponSystem('normal');
  dry.slots.forEach(s => {s.ammo = 0; s.reserve = 0;});
  dry.topUp();
  assert.equal(dry.remaining, 0);
});

test('radio warnings interrupt low-priority chatter and the queue stays bounded', () => {
  const r = new RadioSystem();
  r.push({speaker: 'A', text: 'normal', priority: 1, duration: 6});
  r.push({speaker: 'B', text: 'queued', priority: 1, duration: 4});
  r.push({speaker: 'A', text: 'warning', priority: 5, duration: 2});
  assert.equal(r.current?.text, 'warning');
  r.update(3);
  assert.equal(r.current?.text, 'queued');
  for (let i = 0; i < 50; i++) r.push({speaker: 'X', text: `spam ${i}`, priority: 1, duration: 5});
  assert.ok(r.queue.length <= 8);
  assert.ok(r.history.length <= 6);
});

test('the same line is not repeated back to back, but returns once it is stale', () => {
  const r = new RadioSystem();
  const line = {speaker: 'GHOST 1-1', text: 'Column is moving.', priority: 1, duration: 4};
  r.push({...line});
  assert.equal(r.current?.text, 'Column is moving.');
  r.update(5);
  assert.equal(r.current?.text, undefined);
  // Straight away: refused, because it would just read as a stuck recording.
  r.push({...line});
  assert.equal(r.current?.text, undefined);
  // Well after the window: allowed again, because by then it is new news.
  r.update(30);
  r.push({...line});
  assert.equal(r.current?.text, 'Column is moving.');
  assert.equal(r.history.filter(m => m.text === 'Column is moving.').length, 2);
});

test('a queued message is not silenced by its own admission record', () => {
  // The repeat window applies when a line is offered, not when it finally
  // reaches the air. Checking it again on promotion would drop every message
  // that ever had to wait behind a higher-priority one.
  const r = new RadioSystem();
  r.push({speaker: 'A', text: 'holding', priority: 1, duration: 3});
  r.push({speaker: 'A', text: 'waiting its turn', priority: 1, duration: 3});
  r.push({speaker: 'A', text: 'urgent', priority: 5, duration: 2});
  assert.equal(r.current?.text, 'urgent');
  r.update(3);
  assert.equal(r.current?.text, 'waiting its turn');
});

test('the director runs every leg, spawns every unit type, and stops spawning', () => {
  const d = new MissionDirector('normal');
  const kinds = new Set<string>();
  for (let t = 0; t < 600; t += 1) {
    const leg = Math.min(3, Math.floor(t / 150));
    for (const s of d.update(t, leg, false, 0).spawns) kinds.add(s.kind);
  }
  assert.equal(d.phase, 3);
  for (const k of ['rifle', 'mg', 'rpg', 'mortar', 'technical', 'transport']) {
    assert.ok(kinds.has(k), `director never spawned ${k}`);
  }
  // The hold phase adds the heavy vehicle, then spawning must terminate.
  for (let t = 600; t < 900; t += 1) {
    for (const s of d.update(t, 3, true, t - 600).spawns) kinds.add(s.kind);
  }
  assert.ok(kinds.has('assault'));
  assert.equal(d.phase, 4);
  assert.equal(d.finishedSpawning, true);
  assert.deepEqual(d.update(2000, 3, true, HOLD_SECONDS).spawns, []);
  assert.ok(SPAWN_CUTOFF > 0 && SPAWN_CUTOFF < HOLD_SECONDS);
  assert.equal(PHASES.length, 5);
});

test('the column is pinned by contact and only moves when the axis is clear', () => {
  const s = new Sim('score');
  s.start();
  const before = s.progress;
  // An armoured blocker: a lone rifleman is killed by the ground team in under
  // a second, which would make this test measure nothing.
  const blocker = s.spawn('assault', {x: s.head.position.x + 40, z: s.head.position.z}, 'ahead');
  for (let i = 0; i < 30; i++) s.update(0.1);
  assert.equal(s.pinned, true);
  assert.ok(s.progress - before < 0.5, `column advanced ${s.progress - before}m while pinned`);
  blocker.hp = 0;
  for (let i = 0; i < 30; i++) s.update(0.1);
  assert.equal(s.pinned, false);
  assert.ok(s.progress - before > 4, `column did not resume: ${s.progress - before}m`);
});

test('civilians scatter under fire and rejoin the column afterwards', () => {
  const s = new Sim('score');
  s.start();
  // Keep one civilian. With the whole column present a neighbour dies in the
  // same blast and the panic ripple from the body masks what is being tested.
  const civ = s.civilians[0];
  s.entities = s.entities.filter(e => e.side !== 'civilian' || e.id === civ.id);
  const blast = {x: civ.x + 10, z: civ.z + 10, weapon: 1};
  s.explode(blast);
  assert.ok(civ.panic > 0, 'civilian did not panic near a blast');
  assert.ok(distance(civ.panicFrom, blast) < 1e-6, 'civilian did not register what scared them');
  const before = distance(civ, blast);
  for (let i = 0; i < 20; i++) s.update(0.1);
  assert.ok(distance(civ, blast) > before + 3, 'civilian did not run from the blast');
  // Once the panic expires they close back up on the column.
  for (let i = 0; i < 200; i++) s.update(0.1);
  assert.equal(civ.panic <= 0, true);
  assert.ok(distance(civ, s.head.position) < 90, `civilian stranded ${distance(civ, s.head.position)}m out`);
});

test('minimap contacts are unclassified and decay when not re-observed', () => {
  const s = new Sim('score', 'normal');
  s.start();
  const e = s.spawn('technical', {x: s.head.position.x + 80, z: s.head.position.z}, 'ahead');
  s.update(0.1);
  const blip = s.contacts.find(c => c.id === e.id);
  assert.ok(blip, 'no contact generated for a hostile beside the column');
  // The only fields a blip carries are position and timing. Nothing classifies it.
  assert.deepEqual(Object.keys(blip!).sort(), ['expires', 'id', 'seen', 'x', 'z']);
  // Move it out of the ground team's awareness and keep it quiet: the blip
  // must age out rather than tracking it forever.
  e.x = 6000; e.z = 6000;
  for (let i = 0; i < 400; i++) {s.update(0.1); e.lastFired = -99;}
  assert.equal(s.contacts.some(c => c.id === e.id), false, 'stale contact never expired');
});

test('replacement operators link up on the kill threshold in both casualty modes', () => {
  for (const mode of ['score', 'hardcore'] as const) {
    const s = new Sim(mode);
    s.start();
    s.operators[0].hp = 0;
    assert.equal(s.operators.length, OPERATOR_COUNT - 1);
    // Feed it kills until the threshold trips.
    for (let i = 0; i < 30 && s.stats.replacements === 0; i++) {
      const e = s.spawn('rifle', {x: 2000 + i * 30, z: 2000}, 'ahead');
      s.explode({x: e.x, z: e.z, weapon: 1});
    }
    assert.equal(s.stats.replacements, 1, `${mode}: no replacement operator`);
    assert.equal(s.operators.length, OPERATOR_COUNT);
  }
});

test('the weapons-free window needs a full bar, then speeds the guns up', () => {
  const s = new Sim('score');
  s.start();
  assert.equal(s.spendWeaponsFree(), false, 'spent an empty bar');
  s.energy = 100;
  assert.equal(s.spendWeaponsFree(), true);
  assert.equal(s.energy, 0);
  s.update(0.01);
  assert.equal(s.weaponsFree, true);
  s.weapons.selected = 0;
  s.weapons.fire();
  assert.ok(s.weapons.slots[0].cooldown < WEAPONS[0].interval, 'guns did not speed up');
  assert.equal(s.spendWeaponsFree(), false, 'window was spendable twice');
});

test('a full escort mission can be won, on foot, with finite ammunition', () => {
  const run = playMission(new Sim('score', 'normal', 9341));
  const s = run.sim;
  assert.equal(s.status, 'won', JSON.stringify(report(run)));
  assert.equal(s.routeFraction, 1, 'won without walking the whole route');
  assert.ok(s.heloLanded, 'won without the extraction landing');
  assert.equal(s.stats.civilians, 0, 'the scripted gunner should never hit a civilian');
  assert.ok(s.stats.saved >= CIVILIAN_COUNT - 2, `only ${s.stats.saved} civilians extracted`);
  assert.ok(s.weapons.remaining > 0, 'mission required more ammunition than it carries');
  // A full mission should be a mission, not a skirmish, and not an endurance test.
  assert.ok(s.time > 480 && s.time < 1500, `mission ran ${(s.time / 60).toFixed(2)} minutes`);
  console.log(JSON.stringify(report(run)));
});

test('the mission is winnable on every difficulty and both casualty modes', () => {
  for (const difficulty of ['easy', 'normal', 'hard'] as const) {
    const run = playMission(new Sim('score', difficulty, 4242));
    assert.equal(run.sim.status, 'won', `${difficulty}: ${run.sim.status} — ${run.sim.reason}`);
    console.log(JSON.stringify({difficulty, ...report(run)}));
  }
  const hardcore = playMission(new Sim('hardcore', 'normal', 4242)).sim;
  assert.equal(hardcore.status, 'won', `hardcore: ${hardcore.status} — ${hardcore.reason}`);
  assert.equal(hardcore.stats.civilians, 0);
});

/**
 * The negative half of the winnability oracle, and the most load-bearing test
 * here. A mission the ground team completes on its own is a screensaver: the
 * gunship has to be the reason it works.
 *
 * This covers every difficulty, including Easy. An earlier balance let the
 * escort walk itself home on Easy and win unaided on two seeds out of five on
 * Normal, which meant the aircraft was decoration for part of the difficulty
 * range while every other gate stayed green.
 */
test('without the gunship the escort is overrun on every difficulty', () => {
  for (const difficulty of ['easy', 'normal', 'hard'] as const) {
    for (const seed of [9341, 4242, 777]) {
      const run = playMission(new Sim('score', difficulty, seed), {gunship: false});
      const s = run.sim;
      assert.equal(s.status, 'lost',
        `${difficulty}/${seed} completed with a silent gunship: ${JSON.stringify(report(run))}`);
      assert.ok(s.routeFraction < 0.9, `${difficulty}/${seed} nearly walked itself home`);
    }
    const sample = playMission(new Sim('score', difficulty, 9341), {gunship: false});
    console.log(JSON.stringify({difficulty, unaided: report(sample)}));
  }
});

/**
 * Difficulty has to change what the mission feels like, not just the score at
 * the end of it. An earlier balance finished all three in 11.4 minutes with
 * 14/14 extracted and six operators alive, and the only thing that moved was
 * leftover ammunition — which is difficulty you cannot feel while playing.
 *
 * Measured against the scripted gunner, so this is the floor: a human sees a
 * wider spread than this, not a narrower one.
 */
test('difficulty changes the pressure, not just the leftovers', () => {
  const runs = (['easy', 'normal', 'hard'] as const).map(difficulty => {
    const seeds = [9341, 4242, 777];
    const all = seeds.map(seed => playMission(new Sim('score', difficulty, seed)));
    const mean = (f: (r: typeof all[0]) => number) => all.reduce((a, r) => a + f(r), 0) / all.length;
    return {
      difficulty,
      won: all.every(r => r.sim.status === 'won'),
      pinned: mean(r => r.pinnedSeconds),
      ammo: mean(r => r.sim.weapons.remaining),
      kills: mean(r => r.sim.stats.kills + r.sim.stats.vehicles),
    };
  });
  const [easy, normal, hard] = runs;
  for (const r of runs) assert.ok(r.won, `${r.difficulty} was not winnable`);

  // Time spent stopped by contact rises with difficulty.
  assert.ok(easy.pinned < normal.pinned && normal.pinned < hard.pinned,
    `pinning is not ordered: ${JSON.stringify(runs)}`);
  assert.ok(hard.pinned > easy.pinned * 2, 'Hard should stop the column far more than Easy');
  // Ammunition left over falls with difficulty, and Hard is genuinely tight.
  assert.ok(easy.ammo > normal.ammo && normal.ammo > hard.ammo,
    `ammunition margin is not ordered: ${JSON.stringify(runs)}`);
  assert.ok(hard.ammo > 0, 'Hard must be completable without running dry');
  assert.ok(hard.ammo < easy.ammo / 5, 'Hard should be a materially tighter ammunition budget');
  // And there is simply more to shoot.
  assert.ok(hard.kills > easy.kills * 1.4, `kill load is not ordered: ${JSON.stringify(runs)}`);
  console.log(JSON.stringify(runs.map(r => ({
    ...r, pinned: +r.pinned.toFixed(1), ammo: Math.round(r.ammo), kills: Math.round(r.kills),
  }))));
});

/**
 * Ambushes are the only pressure that survives a competent gunner: everything
 * else spawns far enough out to be killed on the approach. If they stop
 * appearing inside the stopping distance, the column stops being stopped and
 * the whole "buy metres" loop quietly becomes a walk.
 */
test('close ambushes appear inside the stopping distance and halt the column', () => {
  const s = new Sim('score', 'normal', 9341);
  s.start();
  let spawnedInside = 0;
  const seen = new Set<number>();
  for (let i = 0; i < 4000 && s.status === 'playing'; i++) {
    for (const e of s.enemies) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      // Measured at the moment of spawn, before anything has walked anywhere.
      if (distance(e, s.head.position) < 95) spawnedInside++;
    }
    autoGunner(s);
    s.update(0.1);
    s.impacts = []; s.traces = [];
  }
  assert.ok(spawnedInside >= 15,
    `only ${spawnedInside} hostiles ever appeared inside the stopping distance`);
});

test('contact stops the column, so clearing the axis is what buys ground', () => {
  // A mission flown without the gunship spends real time pinned; a mission
  // flown well barely stops at all. That difference is the game.
  const silent = playMission(new Sim('score', 'normal', 9341), {gunship: false});
  const flown = playMission(new Sim('score', 'normal', 9341));
  assert.ok(silent.pinnedSeconds > 60,
    `a silent orbit should be stopped repeatedly, got ${silent.pinnedSeconds}s`);
  assert.ok(flown.pinnedSeconds < silent.pinnedSeconds / 3,
    `clearing the axis should unstick the column: ${flown.pinnedSeconds}s vs ${silent.pinnedSeconds}s`);
});
