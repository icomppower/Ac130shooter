import {LZ, ROUTE, ROUTE_LENGTH, alongRoute} from '../sim/route';
import type {Sim} from '../sim/sim';
import {clamp} from '../sim/types';

/**
 * A moving column means the player can no longer learn where to look, so the
 * minimap is a primary instrument here rather than decoration.
 *
 * Hard rule, and the reason this file is short: it shows unclassified contacts
 * and never labelled enemies. It tells the player *where* to look. The moment
 * it tells them *what* a contact is, target identification is solved for free
 * and the civilian system dies with it. Blips are drawn from `sim.contacts`,
 * which carries a position and an expiry and nothing else — there is no path
 * from a blip on this map back to the kind of unit that made it.
 */
export class Minimap {
  canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  /** Metres across the shorter axis of the map view. */
  private span = 900;

  constructor() {
    this.canvas.className = 'minimap';
    this.ctx = this.canvas.getContext('2d')!;
  }

  resize(size: number) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(size * dpr);
    this.canvas.height = Math.floor(size * dpr);
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
  }

  draw(sim: Sim, orbitAngle: number, viewCentre: {x: number; z: number}) {
    const c = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    if (!w || !h) return;
    const head = sim.head.position;
    const scale = Math.min(w, h) / this.span;
    // The map is always centred on the column, which is the one thing the
    // player must never lose.
    const px = (x: number) => w / 2 + (x - head.x) * scale;
    const pz = (z: number) => h / 2 + (z - head.z) * scale;

    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(9,14,10,0.82)';
    c.fillRect(0, 0, w, h);

    // Range rings at 200 m and 400 m, so blip distance is readable.
    c.strokeStyle = 'rgba(150,170,140,0.16)';
    c.lineWidth = 1;
    for (const r of [200, 400]) {
      c.beginPath();
      c.arc(w / 2, h / 2, r * scale, 0, Math.PI * 2);
      c.stroke();
    }

    // The route, dimmed behind and bright ahead of the column.
    c.lineWidth = Math.max(2, 3 * scale * 4);
    c.strokeStyle = 'rgba(150,170,140,0.22)';
    c.beginPath();
    ROUTE.forEach((p, i) => i ? c.lineTo(px(p.x), pz(p.z)) : c.moveTo(px(p.x), pz(p.z)));
    c.stroke();
    c.strokeStyle = 'rgba(196,226,180,0.55)';
    c.beginPath();
    c.moveTo(px(head.x), pz(head.z));
    for (let d = sim.progress; d <= ROUTE_LENGTH; d += 40) {
      const p = alongRoute(d).position;
      c.lineTo(px(p.x), pz(p.z));
    }
    c.lineTo(px(LZ.x), pz(LZ.z));
    c.stroke();

    // Landing zone.
    c.strokeStyle = sim.heloInbound ? 'rgba(232,240,200,0.95)' : 'rgba(190,210,170,0.6)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(px(LZ.x), pz(LZ.z), Math.max(6, 26 * scale), 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = 'rgba(214,226,186,0.85)';
    c.font = `${Math.round(11 * (w / 220))}px ui-monospace, monospace`;
    c.textAlign = 'center';
    c.fillText('LZ', px(LZ.x), pz(LZ.z) - Math.max(9, 30 * scale));

    // Unclassified contacts. One shape, one colour, no label, no kind. They
    // fade as the intel goes stale and vanish when it expires.
    for (const blip of sim.contacts) {
      const age = clamp((blip.expires - sim.time) / 14, 0, 1);
      const x = px(blip.x), y = pz(blip.z);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      c.fillStyle = `rgba(226,196,120,${0.25 + age * 0.62})`;
      c.beginPath();
      c.arc(x, y, Math.max(2, 3.4 * (w / 220)) * (0.6 + age * 0.5), 0, Math.PI * 2);
      c.fill();
    }

    // The ground team.
    c.fillStyle = 'rgba(150,224,214,0.9)';
    for (const f of sim.operators) {
      c.fillRect(px(f.x) - 2, pz(f.z) - 2, 4, 4);
    }
    // The civilians, as one soft mass rather than counted dots.
    c.fillStyle = 'rgba(226,236,216,0.55)';
    for (const civ of sim.civilians) {
      c.beginPath();
      c.arc(px(civ.x), pz(civ.z), Math.max(1.5, 2.2 * (w / 220)), 0, Math.PI * 2);
      c.fill();
    }

    // Column head marker, pointing along the axis of advance.
    const heading = sim.head.heading;
    const a = Math.atan2(heading.x, -heading.z);
    c.save();
    c.translate(w / 2, h / 2);
    c.rotate(a);
    c.strokeStyle = 'rgba(236,246,220,0.95)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, -8); c.lineTo(5, 6); c.lineTo(0, 3); c.lineTo(-5, 6);
    c.closePath();
    c.stroke();
    c.restore();

    // The aircraft's own position and heading on the orbit.
    const orbitR = Math.min(w, h) * 0.44;
    const ax = w / 2 + Math.sin(orbitAngle) * orbitR;
    const ay = h / 2 + Math.cos(orbitAngle) * orbitR;
    c.strokeStyle = 'rgba(206,226,180,0.30)';
    c.setLineDash([4, 6]);
    c.beginPath();
    c.arc(w / 2, h / 2, orbitR, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    c.save();
    c.translate(ax, ay);
    c.rotate(-orbitAngle + Math.PI / 2);
    c.strokeStyle = 'rgba(236,246,220,0.9)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(-6, 0); c.lineTo(6, 0); c.moveTo(2, -5); c.lineTo(2, 5);
    c.stroke();
    c.restore();

    // Where the sensor is actually pointed, so panning is never disorienting.
    c.strokeStyle = 'rgba(255,255,255,0.45)';
    c.lineWidth = 1;
    c.strokeRect(px(viewCentre.x) - 5, pz(viewCentre.z) - 5, 10, 10);
  }
}
