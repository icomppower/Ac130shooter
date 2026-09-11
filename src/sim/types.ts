// Shared vocabulary for the simulation. Nothing in src/sim imports a renderer.
//
// Acronyms used throughout this codebase, spelled out once here:
//   AC-130  — a fixed-wing gunship that orbits a target area and fires side-mounted guns.
//   CAS     — Close Air Support: aircraft firing in support of friendly troops on the ground.
//   LZ      — Landing Zone: where the extraction helicopter puts down.
//   IR      — Infrared. The sensor images heat, not visible light.
//   ROE     — Rules Of Engagement: who you are permitted to shoot.
//   RPG     — Rocket-Propelled Grenade, a shoulder-fired anti-vehicle rocket.
//   MG      — Machine Gun team.
//   HP      — Hit Points, an abstract health value.
//   p95     — the 95th percentile of a measurement (95% of samples are at or below it).

export type Side = 'enemy' | 'friendly' | 'civilian';
export type Kind =
  | 'rifle' | 'mg' | 'rpg' | 'mortar' | 'technical' | 'transport' | 'assault'
  | 'operator' | 'civilian';
export type Mode = 'hardcore' | 'score';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type Status = 'menu' | 'playing' | 'paused' | 'won' | 'lost';

/** Threats are described relative to the column's axis of advance, never by road name. */
export type Bearing = 'ahead' | 'left' | 'right' | 'trailing';

export interface Vec {x: number; z: number}

export interface Entity extends Vec {
  id: number;
  kind: Kind;
  side: Side;
  y: number;
  hp: number;
  maxHp: number;
  speed: number;
  cooldown: number;
  born: number;
  /** Priority threats called out over the radio are marked; used for response timing. */
  marked: boolean;
  /** Transports set this once they have dismounted their infantry. */
  deployed: boolean;
  /** Civilians who boarded the helicopter. Removed from play, counted as saved. */
  saved: boolean;
  /** Where this entity is trying to be right now. */
  target: Vec;
  /** Escort bookkeeping: formation slot, straggle lag and panic timer. */
  slot: number;
  lag: number;
  panic: number;
  /** What a panicking civilian is running away from. */
  panicFrom: Vec;
  /** Mission time this unit last fired. Drives contact freshness on the minimap. */
  lastFired: number;
  /** Bearing the unit spawned on, for radio calls. */
  bearing: Bearing;
}

export interface Building extends Vec {
  id: number;
  width: number;
  depth: number;
  height: number;
  hp: number;
  maxHp: number;
  /** Rooftops tall enough for an RPG team to occupy. */
  rooftop: boolean;
}

export interface RadioMessage {
  speaker: string;
  text: string;
  priority: number;
  duration: number;
  targetId?: number;
}

export interface Shot extends Vec {id: number; weapon: number; age: number; travel: number; from: Vec}
export interface Impact extends Vec {radius: number; weapon: number}
export interface Trace {from: Vec; to: Vec; hostile: boolean}

/** An unclassified sensor return. The minimap draws these and never labels them. */
export interface Contact extends Vec {id: number; seen: number; expires: number}

export interface Stats {
  kills: number; vehicles: number; mortars: number; rpgs: number; priority: number;
  civilians: number; friendly: number; friendlyFire: number;
  shots: number; hits: number;
  responseTotal: number; responseCount: number;
  saved: number; replacements: number; score: number;
}

export const distance = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.z - b.z);
export const vehicle = (k: Kind) => k === 'technical' || k === 'transport' || k === 'assault';
export const priority = (k: Kind) =>
  k === 'rpg' || k === 'mortar' || k === 'mg' || vehicle(k);
export const person = (k: Kind) =>
  k === 'rifle' || k === 'mg' || k === 'rpg' || k === 'mortar' || k === 'operator' || k === 'civilian';
export const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Step `a` toward `b` by at most `s` metres. Mutates `a`. */
export const approach = (a: Vec, b: Vec, s: number) => {
  const d = distance(a, b);
  if (d > s) {a.x += (b.x - a.x) / d * s; a.z += (b.z - a.z) / d * s;}
  else {a.x = b.x; a.z = b.z;}
};
