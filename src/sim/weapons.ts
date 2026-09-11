import type {Difficulty} from './types';

/**
 * The weapon table is carried over from ac130astra unchanged. It was already
 * tuned there and the rebuild spec says to keep these numbers as the starting
 * point and only move them with a recorded reason. See DECISIONS.md.
 */
export const WEAPONS = [
  {name: '25 MM', label: 'GAU AUTOCANNON', magazine: 80, reserve: 960, interval: 0.115, reload: 2.2, travel: 0.28, radius: 3.4, damage: 65, shake: 0.12},
  {name: '40 MM', label: 'BOFORS CANNON', magazine: 12, reserve: 180, interval: 0.65, reload: 3.8, travel: 0.65, radius: 7.4, damage: 185, shake: 0.4},
  {name: '105 MM', label: 'HEAVY HOWITZER', magazine: 1, reserve: 55, interval: 3.8, reload: 4.2, travel: 1.45, radius: 16, damage: 510, shake: 1.4},
] as const;

export interface Slot {ammo: number; reserve: number; reload: number; cooldown: number}

export class WeaponSystem {
  selected = 0;
  slots: Slot[] = WEAPONS.map(w => ({ammo: w.magazine, reserve: w.reserve, reload: 0, cooldown: 0}));
  /** Set while the weapons-free window is open: faster cycling, instant reloads. */
  weaponsFree = false;

  constructor(difficulty: Difficulty) {
    const scale = {easy: 1.4, normal: 1, hard: 0.92}[difficulty];
    for (const s of this.slots) s.reserve = Math.round(s.reserve * scale);
  }

  update(dt: number) {
    this.slots.forEach((s, i) => {
      s.cooldown = Math.max(0, s.cooldown - dt);
      if (s.reload > 0) {
        s.reload -= dt * (this.weaponsFree ? 4 : 1);
        if (s.reload <= 0) {
          const n = Math.min(WEAPONS[i].magazine - s.ammo, s.reserve);
          s.ammo += n; s.reserve -= n; s.reload = 0;
        }
      }
    });
  }

  reload() {
    const s = this.slots[this.selected], w = WEAPONS[this.selected];
    if (!s.reload && s.ammo < w.magazine && s.reserve > 0) s.reload = w.reload;
  }

  /** Top every magazine off. Reserve still bounds it; rounds are never invented. */
  topUp() {
    this.slots.forEach((s, i) => {
      const n = Math.min(WEAPONS[i].magazine - s.ammo, s.reserve);
      s.ammo += n; s.reserve -= n; s.reload = 0;
    });
  }

  fire() {
    const s = this.slots[this.selected], w = WEAPONS[this.selected];
    if (s.reload > 0 || s.cooldown > 0) return false;
    if (!s.ammo) {this.reload(); return false;}
    s.ammo--;
    s.cooldown = w.interval * (this.weaponsFree ? 0.62 : 1);
    if (!s.ammo) this.reload();
    return true;
  }

  get remaining() {return this.slots.reduce((n, s) => n + s.ammo + s.reserve, 0);}
}
