import {Sim} from '../src/sim/sim';
import {autoGunner} from '../src/sim/autogunner';

export {autoGunner};

export interface MissionRun {
  sim: Sim;
  /** Seconds the column spent stopped by contact. */
  pinnedSeconds: number;
  steps: number;
}

/** Run a mission to completion. Pass `gunship: false` to fly a silent orbit. */
export function playMission(
  sim: Sim,
  {gunship = true, maxSteps = 30000, dt = 0.1} = {},
): MissionRun {
  sim.start();
  let pinnedSeconds = 0, steps = 0;
  while (sim.status === 'playing' && steps++ < maxSteps) {
    if (gunship) autoGunner(sim);
    sim.update(dt);
    sim.impacts = []; sim.traces = [];
    if (sim.pinned) pinnedSeconds += dt;
  }
  return {sim, pinnedSeconds, steps};
}

export function report(run: MissionRun) {
  const s = run.sim;
  return {
    status: s.status,
    minutes: +(s.time / 60).toFixed(2),
    grade: s.grade,
    score: s.stats.score,
    accuracy: s.accuracy,
    saved: s.stats.saved,
    operators: s.operators.length,
    replacements: s.stats.replacements,
    ammo: s.weapons.remaining,
    routeFraction: +s.routeFraction.toFixed(3),
    pinnedSeconds: +run.pinnedSeconds.toFixed(1),
    reason: s.reason,
  };
}
