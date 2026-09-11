import {Rng} from './rng';
import type {Bearing, Difficulty, Kind} from './types';
import {HELO_INBOUND, HOLD_SECONDS} from './route';

/**
 * Five phases, but they are route legs rather than arbitrary waves. The first
 * four track the column's progress along the route; the fifth is the hold at
 * the landing zone. Nothing here is on a wall clock except the hold, so a
 * player who clears the path fast gets to the landing zone fast.
 */
export const PHASES = [
  {
    name: 'DEPARTURE',
    objective: 'Get the column moving and off the line of departure.',
    interval: 26,
    radio: 'Spectre, Ghost One-One. Column is formed and stepping off. Fourteen civilians with us. Eyes out.',
  },
  {
    name: 'OPEN GROUND',
    objective: 'Cover the column across open ground. No cover out here.',
    interval: 24,
    radio: 'We are in the open. Nothing to hide behind for the next stretch — you are our cover, Spectre.',
  },
  {
    name: 'CHOKEPOINT',
    objective: 'Thread the built-up ground. Watch the rooftops.',
    interval: 22,
    radio: 'Built-up ground ahead. Rooftops on both sides of the throat. Danger close from here on, check your fire.',
  },
  {
    name: 'FINAL APPROACH',
    objective: 'Break the standoff fire. Push the column to the landing zone.',
    interval: 23,
    radio: 'Taking standoff fire on the approach. Tubes somewhere out there. Find them or we do not make the zone.',
  },
  {
    name: 'LANDING ZONE',
    objective: 'Hold the zone. Keep it clear for the extraction.',
    interval: 20,
    radio: 'Ghost One-One at the zone. Pedro Six-Six is inbound. Hold this ground, Spectre — everything they have left is coming here.',
  },
] as const;

export interface SpawnOrder {
  kind: Kind;
  bearing: Bearing;
  /** Metres from the column head along that bearing. */
  range: number;
  /** Index within the wave, used to fan a group out rather than stack it. */
  offset: number;
}

/** Spawning stops the moment the helicopter turns inbound. */
export const SPAWN_CUTOFF = HOLD_SECONDS - HELO_INBOUND;

const FLANKS: readonly Bearing[] = ['left', 'right'];

export class MissionDirector {
  phase = -1;
  waves = 0;
  nextSpawn = 6;
  finishedSpawning = false;
  private rng: Rng;

  constructor(public difficulty: Difficulty, seed = 20771) {this.rng = new Rng(seed);}

  /**
   * @param time     mission clock in seconds
   * @param leg      which route leg the column is on (0-3)
   * @param atLZ     the column has reached the landing zone
   * @param held     seconds spent holding at the landing zone
   */
  update(time: number, leg: number, atLZ: boolean, held: number): {phaseChanged: boolean; spawns: SpawnOrder[]} {
    const next = atLZ ? 4 : Math.min(3, leg);
    const phaseChanged = next !== this.phase;
    this.phase = next;

    if (atLZ && held >= SPAWN_CUTOFF) {
      this.finishedSpawning = true;
      return {phaseChanged, spawns: []};
    }
    if (time < this.nextSpawn) return {phaseChanged, spawns: []};

    const factor = {easy: 0.7, normal: 1, hard: 1.3}[this.difficulty];
    const spawns: SpawnOrder[] = [];
    const infantry = Math.ceil((2 + next) * factor);
    // Early waves come at the head and tail of the column; later ones wrap it.
    const primary: Bearing = next === 0
      ? (this.waves % 2 ? 'trailing' : 'ahead')
      : this.rng.pick(['ahead', 'ahead', 'trailing', ...FLANKS]);

    for (let i = 0; i < infantry; i++) {
      spawns.push({
        kind: i === infantry - 1 && next > 0 ? 'mg' : 'rifle',
        bearing: primary,
        range: this.rng.range(120, 185),
        offset: i,
      });
    }

    // Open ground is where wheels hurt most: technicals can actually run at you.
    if (next >= 1 && this.waves % 2 === 0) {
      spawns.push({kind: 'technical', bearing: this.rng.pick(FLANKS), range: this.rng.range(210, 280), offset: 9});
    }
    // The chokepoint puts rocket teams on rooftops looking down into the column.
    if (next >= 2) {
      spawns.push({kind: 'rpg', bearing: this.rng.pick(['ahead', ...FLANKS]), range: this.rng.range(90, 150), offset: 10});
    }
    // Standoff fire: tubes sit far enough out that they must be hunted.
    if (next >= 3 && this.waves % 2 === 0) {
      spawns.push({kind: 'mortar', bearing: this.rng.pick([...FLANKS, 'trailing']), range: this.rng.range(300, 420), offset: 11});
    }
    if (next >= 3) {
      spawns.push({kind: 'transport', bearing: this.rng.pick(['ahead', ...FLANKS]), range: this.rng.range(240, 320), offset: 12});
    }
    if (next === 4 && this.waves % 3 === 0) {
      spawns.push({kind: 'assault', bearing: this.rng.pick(['ahead', ...FLANKS]), range: this.rng.range(260, 340), offset: 13});
    }
    if (this.difficulty === 'hard' && next >= 2) {
      spawns.push({kind: this.waves % 2 ? 'rpg' : 'mortar', bearing: this.rng.pick(FLANKS), range: this.rng.range(160, 320), offset: 14});
    }

    this.nextSpawn = time + PHASES[next].interval / (this.difficulty === 'hard' ? 1.15 : 1);
    this.waves++;
    return {phaseChanged, spawns};
  }
}
