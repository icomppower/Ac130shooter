import type {Game} from './Game';
import type {Difficulty, Mode} from '../sim/types';
import type {ModelName} from '../assets/ModelFactory';

/**
 * Debug flags, read from the query string. These are what make the kill gate
 * possible: a build nobody can drive headlessly is a build nobody checks, and
 * that is exactly how the reference build reached deploy without ever being
 * looked at.
 *
 *   ?autostart            skip the menu and begin the mission
 *   &ff=N                 fast-forward N simulated seconds before the first frame
 *   &autofire             run the scripted gunner
 *   &mode=hardcore|score  casualty rules
 *   &diff=easy|normal|hard
 *   &seed=N               simulation seed
 *   &zoom=0..4            sensor zoom step
 *   &polarity=black|white
 *   &nonoise              disable sensor grain, for pixel comparisons
 *   &idprobe=<kind>       place one figure of that kind alone, camera fixed
 *   &mutate=noshadows     turn the shadow map off, to prove the shadow gate can fail
 *   &mutate=samemodel     render civilians with the hostile model, to prove the
 *                         silhouette gate can fail
 */

/** Where the identification probe stands. Flat ground, clear of buildings. */
export const PROBE_POSITION = {x: -300, z: 250};
/** Fixed orbit angle for the probe, so every capture is from one viewpoint. */
export const PROBE_ANGLE = 0.9;
/** Fixed facing for the probe figure, so the silhouette is not orientation luck. */
export const PROBE_FACING = 1.35;

export type Mutation = 'none' | 'noshadows' | 'samemodel';

export class DebugFlags {
  readonly params: URLSearchParams;
  readonly autostart: boolean;
  readonly autofire: boolean;
  readonly fastForward: number;
  readonly mode: Mode;
  readonly difficulty: Difficulty;
  readonly seed: number;
  readonly zoom: number | null;
  readonly blackHot: boolean | null;
  readonly nonoise: boolean;
  readonly probe: ModelName | null;
  readonly mutation: Mutation;

  constructor(search: string) {
    // Accept flags from either the query string or the hash, so a static host
    // that rewrites one of them still reaches the harness.
    this.params = new URLSearchParams(search.replace(/^[?#]/, '').replace(/#/g, '&'));
    const has = (k: string) => this.params.has(k);
    const num = (k: string, fallback: number) => {
      const v = Number(this.params.get(k));
      return Number.isFinite(v) && this.params.get(k) !== null ? v : fallback;
    };
    this.autostart = has('autostart');
    this.autofire = has('autofire');
    this.fastForward = num('ff', 0);
    this.mode = this.params.get('mode') === 'hardcore' ? 'hardcore' : 'score';
    const diff = this.params.get('diff');
    this.difficulty = diff === 'easy' || diff === 'hard' ? diff : 'normal';
    this.seed = num('seed', 9341);
    this.zoom = has('zoom') ? num('zoom', 2) : null;
    const polarity = this.params.get('polarity');
    this.blackHot = polarity ? polarity === 'black' : null;
    this.probe = (this.params.get('idprobe') as ModelName) ?? null;
    this.nonoise = has('nonoise') || this.probe !== null;
    const mutate = this.params.get('mutate');
    this.mutation = mutate === 'noshadows' || mutate === 'samemodel' ? mutate : 'none';
  }

  mutate(which: Mutation) {return this.mutation === which;}

  /** Model substitution, used only by the silhouette mutation test. */
  model(kind: string, normal: ModelName): ModelName {
    if (this.mutation === 'samemodel' && kind === 'civilian') return 'rifle';
    return normal;
  }

  /** Applied once the renderer is live. */
  onReady(game: Game) {
    if (this.blackHot !== null) game.sensor.blackHot = this.blackHot;
    if (this.nonoise) game.sensor.material.uniforms.noiseScale.value = 0;

    if (this.probe) {
      this.setUpProbe(game);
      return;
    }
    if (!this.autostart) return;

    game.start(this.mode, this.difficulty, this.seed);
    if (this.zoom !== null) game.camera.zoomStep = this.zoom;
    if (this.autofire) game.autoGunner = true;
    // Fast-forward runs the simulation without rendering, so a gate can reach
    // a late phase in seconds instead of minutes.
    if (this.fastForward > 0) {
      const dt = 1 / 30;
      for (let t = 0; t < this.fastForward && game.sim.status === 'playing'; t += dt) {
        if (this.autofire) game.runAutoGunner();
        game.sim.update(dt);
        game.sim.impacts = [];
        game.sim.traces = [];
      }
    }
  }

  /**
   * Stand one figure alone on flat ground with the camera nailed down, so two
   * captures differ only by the model in them. This is what the silhouette
   * comparison measures.
   */
  private setUpProbe(game: Game) {
    const kind = this.probe!;
    game.start(this.mode, this.difficulty, this.seed);
    const sim = game.sim;
    sim.entities = [];
    const simKind = kind === 'civilian' ? 'civilian' : kind === 'operator' ? 'operator' : 'rifle';
    const e = sim.spawn(simKind, PROBE_POSITION, 'ahead');
    e.cooldown = 1e9;
    game.probeEntityId = e.id;
    // Force the model even when it is not the sim kind's usual one, so a probe
    // can be taken of any figure in the pack.
    game.probeModel = kind;
    game.followOverride = {...PROBE_POSITION};
    game.camera.angle = PROBE_ANGLE;
    game.camera.anchor.set(PROBE_POSITION.x, 0, PROBE_POSITION.z);
    game.camera.pan.set(0, 0, 0);
    game.camera.zoomStep = this.zoom ?? 3;
    game.rebuild();
    sim.status = 'paused';
  }

  /**
   * Screen-space box of the probe figure, padded, in device-independent
   * pixels. The gate crops exactly this rectangle from each capture.
   */
  probeRect(game: Game) {
    if (!game.probeEntityId) return null;
    const e = game.sim.entities.find(x => x.id === game.probeEntityId);
    if (!e) return null;
    // Project the figure's bounding box corners rather than a single point, so
    // the crop is the same size regardless of which model is standing there.
    const half = 2.6, top = 3.4;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const dx of [-half, half]) for (const dz of [-half, half]) for (const y of [0, top]) {
      const v = game.camera.project({x: e.x + dx, z: e.z + dz, y});
      const sx = (v.x + 1) * innerWidth / 2;
      const sy = (-v.y + 1) * innerHeight / 2;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    return {
      x: Math.round(minX), y: Math.round(minY),
      width: Math.round(maxX - minX), height: Math.round(maxY - minY),
    };
  }
}
