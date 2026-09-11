import {Rng} from './rng';
import {clamp, distance, type Bearing, type Building, type Vec} from './types';

/**
 * The column's route across the map, in metres. One unit is one metre.
 *
 * Four movement legs plus a hold at the landing zone. There are no named roads:
 * the player never learns "the north road", they learn to read the column's
 * axis of advance. Threats are called relative to that axis.
 */
export const ROUTE: readonly Vec[] = [
  {x: -600, z: 420},   // line of departure
  {x: -300, z: 250},   // end of leg 0
  {x: 10, z: 140},     // end of leg 1
  {x: 300, z: -40},    // end of leg 2
  {x: 600, z: -300},   // landing zone
];

export const LZ: Vec = ROUTE[ROUTE.length - 1];
/** Radius within which the column is considered "at the landing zone". */
export const LZ_RADIUS = 26;
/** Seconds the column must hold at the landing zone before the helicopter lands. */
export const HOLD_SECONDS = 105;
/** The helicopter becomes audible and visible this many seconds before touchdown. */
export const HELO_INBOUND = 38;

export const LEG_LENGTHS: readonly number[] =
  ROUTE.slice(1).map((p, i) => distance(ROUTE[i], p));
export const ROUTE_LENGTH = LEG_LENGTHS.reduce((a, b) => a + b, 0);

/** Cumulative distance at which each waypoint sits. */
export const LEG_STARTS: readonly number[] = (() => {
  const out = [0];
  for (const d of LEG_LENGTHS) out.push(out[out.length - 1] + d);
  return out;
})();

export interface RoutePoint {position: Vec; heading: Vec; leg: number}

/** Position, unit heading and leg index at `metres` travelled along the route. */
export function alongRoute(metres: number): RoutePoint {
  const s = clamp(metres, 0, ROUTE_LENGTH);
  let leg = 0;
  while (leg < LEG_LENGTHS.length - 1 && s >= LEG_STARTS[leg + 1]) leg++;
  const a = ROUTE[leg], b = ROUTE[leg + 1];
  const t = LEG_LENGTHS[leg] > 0 ? (s - LEG_STARTS[leg]) / LEG_LENGTHS[leg] : 0;
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  return {
    position: {x: a.x + dx * t, z: a.z + dz * t},
    heading: {x: dx / len, z: dz / len},
    leg,
  };
}

/**
 * Which side of the column's advance a point lies on. This is the only
 * spatial vocabulary the radio uses.
 */
export function bearingOf(point: Vec, origin: Vec, heading: Vec): Bearing {
  const dx = point.x - origin.x, dz = point.z - origin.z;
  const forward = dx * heading.x + dz * heading.z;
  // Right-hand normal of the heading in the x/z plane.
  const lateral = dx * -heading.z + dz * heading.x;
  if (forward > Math.abs(lateral)) return 'ahead';
  if (-forward > Math.abs(lateral)) return 'trailing';
  return lateral > 0 ? 'right' : 'left';
}

/** A spawn point `range` metres off the column on the given bearing. */
export function bearingPoint(origin: Vec, heading: Vec, bearing: Bearing, range: number): Vec {
  const nx = -heading.z, nz = heading.x;
  switch (bearing) {
    case 'ahead': return {x: origin.x + heading.x * range, z: origin.z + heading.z * range};
    case 'trailing': return {x: origin.x - heading.x * range, z: origin.z - heading.z * range};
    case 'right': return {x: origin.x + nx * range, z: origin.z + nz * range};
    case 'left': return {x: origin.x - nx * range, z: origin.z - nz * range};
  }
}

export const BEARING_LABEL: Record<Bearing, string> = {
  ahead: 'ahead of the column',
  left: 'on our left flank',
  right: 'on our right flank',
  trailing: 'trailing the column',
};

/**
 * Structures along the route. Leg 2 is the built-up chokepoint and carries most
 * of them; the rest are sparse compounds so the open legs still read as open.
 */
export function buildings(seed = 4471): Building[] {
  const rng = new Rng(seed);
  const out: Building[] = [];
  let id = 1;
  const add = (x: number, z: number, w: number, d: number, h: number) => {
    out.push({id: id++, x, z, width: w, depth: d, height: h, hp: 900, maxHp: 900, rooftop: h >= 6.5});
  };

  // Departure compound, behind and beside the line of departure.
  add(-648, 372, 14, 12, 7);
  add(-598, 336, 12, 14, 5.5);
  add(-536, 430, 16, 13, 8);

  // A lone farmstead on the open-ground leg. Deliberately isolated: the leg has
  // to feel exposed, so this is cover the column can be denied rather than used.
  add(-176, 280, 18, 15, 7.4);
  add(-142, 252, 11, 11, 4.6);

  // The chokepoint. A dense block the route threads through, with rooftops high
  // enough to hold rocket teams that can see down onto the column.
  const blockCentre = {x: 210, z: 10};
  for (let i = 0; i < 14; i++) {
    const ring = i < 6 ? 0 : 1;
    const angle = (i / (ring ? 8 : 6)) * Math.PI * 2 + (ring ? 0.4 : 0);
    const radius = ring ? rng.range(74, 104) : rng.range(30, 48);
    const x = blockCentre.x + Math.cos(angle) * radius;
    const z = blockCentre.z + Math.sin(angle) * radius * 0.78;
    add(x, z, rng.range(11, 19), rng.range(10, 17), rng.range(5.2, 11));
  }
  // Two market rows that narrow the throat the column has to walk.
  add(252, -66, 22, 8, 4.2);
  add(168, 62, 22, 8, 4.2);

  // Final approach: a walled yard the enemy uses as a support-by-fire position.
  add(452, -136, 17, 15, 8.4);
  add(496, -92, 13, 12, 5.4);

  // Landing zone: low outbuildings only. Nothing should block the helicopter.
  add(672, -246, 13, 11, 4.4);
  add(556, -376, 12, 12, 4.6);
  return out;
}

/** True if `p` is inside any standing building footprint, plus `margin`. */
export function obstructed(p: Vec, bs: readonly Building[], margin = 1) {
  return bs.some(b => b.hp > 0
    && Math.abs(p.x - b.x) < b.width / 2 + margin
    && Math.abs(p.z - b.z) < b.depth / 2 + margin);
}

/** Nearest standing building with an occupiable roof, within `range`. */
export function rooftopNear(p: Vec, bs: readonly Building[], range: number): Building | undefined {
  let best: Building | undefined;
  let bestD = range;
  for (const b of bs) {
    if (!b.rooftop || b.hp <= 0) continue;
    const d = distance(p, b);
    if (d < bestD) {bestD = d; best = b;}
  }
  return best;
}
