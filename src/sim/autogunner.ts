import type {Sim} from './sim';
import {WEAPONS} from './weapons';
import {distance, vehicle} from './types';

/**
 * A scripted gunner: pick the most dangerous living hostile that can be
 * engaged without putting a friendly or a civilian inside the blast, and shoot
 * it with the lightest weapon that will do. Spends the weapons-free window as
 * soon as the bar fills.
 *
 * It is not meant to play well, only to play legally and to finish. Both the
 * headless winnability tests and the browser `autofire` debug flag run this
 * one function, so the kill gate and the test suite exercise the same
 * behaviour rather than two lookalikes that can drift apart.
 */
const RANK: Record<string, number> = {
  mortar: 5, assault: 4, rpg: 3, technical: 2, transport: 2, mg: 1,
};

export function autoGunner(s: Sim, from = {x: 240, z: 240}) {
  if (s.status !== 'playing') return false;
  const head = s.head.position;
  const enemies = [...s.enemies].sort((a, b) => {
    const byRank = (RANK[b.kind] ?? 0) - (RANK[a.kind] ?? 0);
    return byRank || distance(a, head) - distance(b, head);
  });
  s.spendWeaponsFree();
  for (const e of enemies) {
    for (const wi of vehicle(e.kind) ? [2, 1, 0] : [0, 1]) {
      const w = WEAPONS[wi], slot = s.weapons.slots[wi];
      if (slot.reload > 0 || slot.cooldown > 0 || !slot.ammo) continue;
      const unsafe = s.entities.some(f =>
        f.side !== 'enemy' && f.hp > 0 && !f.saved && distance(f, e) < w.radius + 4);
      if (unsafe) continue;
      s.weapons.selected = wi;
      if (s.fire(e, from)) return true;
    }
  }
  return false;
}
