import * as T from 'three';
import {clamp, type Vec} from '../sim/types';

/**
 * The sensor camera, slaved to an aircraft flying a left-hand orbit.
 *
 * This is a PerspectiveCamera on purpose. The orbit is the only continuous
 * depth cue available from altitude: as the aircraft comes round, near
 * buildings have to visibly slide against far ones. An orthographic or
 * near-orthographic projection throws that away and the whole scene reads as a
 * flat decal, which is the specific failure this rebuild exists to fix. The
 * altitude-to-radius ratio below sets a depression angle of roughly 39 degrees,
 * oblique enough for parallax to be obvious and steep enough to see into
 * streets.
 */
export const ALTITUDE = 330;
export const ORBIT_RADIUS = 400;
/** Radians per second of orbit. One full circuit takes a little over four minutes. */
export const ORBIT_RATE = 0.025;

/**
 * Field of view in degrees at each zoom step, wide to narrow.
 *
 * The ladder matters for the identification problem. Slant range is about
 * 520 m, so at the widest step a 2.4 m figure is only a few pixels tall and
 * nobody can tell a bundle from a rifle — that step is for finding things, not
 * naming them. Step 2 is the default and is where the mission is normally
 * flown; the two narrow steps are what a gunner actually reaches for before
 * shooting near a column of civilians.
 */
export const ZOOM_STEPS = [30, 19, 12, 8, 5] as const;
export const ZOOM_LABELS = ['WIDE', 'MED', 'NARO', 'TIGHT', 'MAX'] as const;

/** How far the player may pan the view away from the column, in metres. */
const PAN_LIMIT = 300;
const PAN_SPEED = 150;
/** Past this gap the orbit centre snaps to the column instead of easing to it. */
const REACQUIRE_RANGE = 120;

export class GunshipCamera {
  camera = new T.PerspectiveCamera(ZOOM_STEPS[1], 1, 1, 4000);
  /** Where the aircraft is in its orbit, in radians. */
  angle = 0.4;
  /** The point the orbit is centred on: the column, plus the player's pan. */
  anchor = new T.Vector3();
  pan = new T.Vector3();
  zoomStep = 1;
  /** Smoothed field of view, so zoom steps ease rather than snap. */
  private fov = ZOOM_STEPS[1];
  locked = false;
  shake = 0;
  /** Extra judder applied on hard camera movement, for the tape look. */
  judder = 0;

  aim = new T.Vector3();
  mouse = new T.Vector2(0, 0);
  keys = new Set<string>();
  private raycaster = new T.Raycaster();
  private plane = new T.Plane(new T.Vector3(0, 1, 0), 0);
  private size = {w: 1, h: 1};

  get center() {
    return new T.Vector3(this.anchor.x + this.pan.x, 0, this.anchor.z + this.pan.z);
  }

  resize(w: number, h: number) {
    this.size = {w, h};
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  sensorPoint(clientX: number, clientY: number) {
    this.mouse.set(clientX / this.size.w * 2 - 1, -clientY / this.size.h * 2 + 1);
    this.locked = false;
    this.pick();
  }

  pick() {
    if (this.locked) return;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.plane, this.aim)) return;
    const c = this.center;
    // Keep the reticle within reach of the orbit so it cannot be flung to the
    // horizon by a shallow ray.
    this.aim.x = clamp(this.aim.x, c.x - 900, c.x + 900);
    this.aim.z = clamp(this.aim.z, c.z - 900, c.z + 900);
  }

  setZoom(delta: number) {
    const next = clamp(this.zoomStep + delta, 0, ZOOM_STEPS.length - 1);
    if (next !== this.zoomStep) this.judder = Math.max(this.judder, 0.5);
    this.zoomStep = next;
  }

  /** Snap the pan so `p` is centred, used by the next-threat key. */
  focus(p: Vec) {
    this.pan.set(
      clamp(p.x - this.anchor.x, -PAN_LIMIT, PAN_LIMIT), 0,
      clamp(p.z - this.anchor.z, -PAN_LIMIT, PAN_LIMIT));
    this.judder = Math.max(this.judder, 0.7);
  }

  /**
   * @param dt      real seconds since the last frame
   * @param orbitDt seconds of orbit motion to apply (zero while paused)
   * @param follow  the point the orbit should be centred on: the column head
   */
  update(dt: number, orbitDt: number, follow: Vec) {
    this.angle += ORBIT_RATE * orbitDt;
    // The orbit centre chases the column rather than snapping to it, so the
    // ground still drifts under the aircraft instead of being locked to it.
    // Beyond a re-acquisition range it does snap: after a pause, a fast-forward
    // or a long stall the column can be hundreds of metres away, and easing
    // toward it leaves the player staring at empty ground for several seconds.
    const gap = Math.hypot(follow.x - this.anchor.x, follow.z - this.anchor.z);
    const k = gap > REACQUIRE_RANGE ? 1 : Math.min(1, dt * 1.1);
    this.anchor.x += (follow.x - this.anchor.x) * k;
    this.anchor.z += (follow.z - this.anchor.z) * k;

    const zoomFactor = ZOOM_STEPS[0] / ZOOM_STEPS[this.zoomStep];
    const speed = PAN_SPEED * dt / Math.sqrt(zoomFactor);
    // Pan is in screen terms: forward is away from the aircraft.
    const forward = new T.Vector3(-Math.sin(this.angle), 0, -Math.cos(this.angle));
    const right = new T.Vector3(Math.cos(this.angle), 0, -Math.sin(this.angle));
    let moved = false;
    const held = (...ks: string[]) => ks.some(k => this.keys.has(k));
    if (held('w', 'arrowup')) {this.pan.addScaledVector(forward, speed); moved = true;}
    if (held('s', 'arrowdown')) {this.pan.addScaledVector(forward, -speed); moved = true;}
    if (held('a', 'arrowleft')) {this.pan.addScaledVector(right, -speed); moved = true;}
    if (held('d', 'arrowright')) {this.pan.addScaledVector(right, speed); moved = true;}
    if (moved) this.judder = Math.max(this.judder, 0.28);
    this.pan.x = clamp(this.pan.x, -PAN_LIMIT, PAN_LIMIT);
    this.pan.z = clamp(this.pan.z, -PAN_LIMIT, PAN_LIMIT);

    this.fov += (ZOOM_STEPS[this.zoomStep] - this.fov) * Math.min(1, dt * 7);
    this.camera.fov = this.fov;

    const c = this.center;
    this.camera.position.set(
      c.x + Math.sin(this.angle) * ORBIT_RADIUS,
      ALTITUDE,
      c.z + Math.cos(this.angle) * ORBIT_RADIUS);
    this.camera.lookAt(c);
    // Gun-camera wobble. Scaled by zoom, because a long lens magnifies it.
    const wobble = (this.shake * 2.2 + this.judder * 1.4) * zoomFactor * 0.06;
    if (wobble > 0.0001) {
      this.camera.rotateX((Math.random() - 0.5) * wobble * 0.02);
      this.camera.rotateY((Math.random() - 0.5) * wobble * 0.02);
    }
    this.shake = Math.max(0, this.shake - dt * 3);
    this.judder = Math.max(0, this.judder - dt * 2.4);

    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.pick();
  }

  /** Project a world point to normalised device coordinates. */
  project(p: {x: number; z: number; y?: number}) {
    return new T.Vector3(p.x, p.y ?? 2, p.z).project(this.camera);
  }

  /** Metres per screen pixel at the aim point, for scaling ground markers. */
  get groundScale() {
    const slant = this.camera.position.distanceTo(this.aim);
    return 2 * slant * Math.tan(this.camera.fov * Math.PI / 360) / this.size.h;
  }
}
