import * as T from 'three';
import type {Impact, Trace} from '../sim/types';

interface Particle {
  life: number; max: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  size: number; smoke: boolean;
}

/**
 * Fixed-capacity particles, impact rings and tracers. Every pool is bounded, so
 * a bad minute in the chokepoint cannot turn into an allocation storm.
 *
 * The heavy round gets its own treatment: a bright expanding disc on the ground
 * plus a single pooled light. A 105 has to read as heavier than a 40, not
 * merely louder, and at this altitude the only way to sell that is with light.
 */
export class Effects {
  group = new T.Group();
  particles: Particle[] = [];
  capacity = 650;
  private cursor = 0;
  mesh: T.InstancedMesh;
  private dummy = new T.Object3D();
  private color = new T.Color();
  private rings: {mesh: T.Mesh; life: number; max: number; radius: number}[] = [];
  private traceLines: {line: T.Line; life: number}[] = [];
  /** One reused light for heavy impacts. Never more than one at a time. */
  private heavyLight = new T.PointLight(0xfff2c8, 0, 260, 2);
  private heavyLife = 0;
  private heavyDisc: T.Mesh;

  constructor() {
    this.mesh = new T.InstancedMesh(
      new T.IcosahedronGeometry(1, 0),
      new T.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.72, depthWrite: false}),
      this.capacity);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    for (let i = 0; i < this.capacity; i++) {
      this.particles.push({life: 0, max: 1, x: 0, y: -1000, z: 0, vx: 0, vy: 0, vz: 0, size: 0, smoke: false});
      this.dummy.scale.setScalar(0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.heavyLight.position.set(0, 26, 0);
    this.group.add(this.heavyLight);
    this.heavyDisc = new T.Mesh(
      new T.CircleGeometry(1, 40),
      new T.MeshBasicMaterial({color: 0xfffbe4, transparent: true, opacity: 0, depthWrite: false}));
    this.heavyDisc.rotation.x = -Math.PI / 2;
    this.heavyDisc.position.y = 0.12;
    this.heavyDisc.renderOrder = 2;
    this.group.add(this.heavyDisc);
  }

  impact(e: Impact) {
    const heavy = e.weapon === 2;
    const count = heavy ? 70 : e.weapon === 0 ? 10 : 34;
    for (let i = 0; i < count; i++) {
      const p = this.particles[this.cursor++ % this.capacity];
      const a = Math.random() * Math.PI * 2;
      const smoke = i > count * 0.45;
      p.x = e.x; p.y = 0.3; p.z = e.z;
      p.vx = Math.cos(a) * Math.random() * e.radius * 1.5;
      p.vy = Math.random() * (heavy ? 19 : 9) + 2;
      p.vz = Math.sin(a) * Math.random() * e.radius * 1.5;
      p.life = smoke ? 5 + Math.random() * 4 : 1 + Math.random();
      p.size = smoke ? (heavy ? 2.6 : 1.4) : 0.25 + Math.random() * 0.5;
      p.smoke = smoke;
      p.max = p.life;
    }
    if (this.rings.length < 24) {
      const ring = new T.Mesh(
        new T.RingGeometry(0.75, 1, 40),
        new T.MeshBasicMaterial({color: 0xf6f3d1, transparent: true, opacity: 0.9, side: T.DoubleSide, depthWrite: false}));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(e.x, 0.25, e.z);
      ring.renderOrder = 2;
      this.group.add(ring);
      this.rings.push({mesh: ring, life: 0.45, max: 0.45, radius: e.radius});
    }
    if (heavy) {
      // Local terrain brightening: the ground around the crater is briefly lit
      // far past everything else in frame.
      this.heavyLight.position.set(e.x, 24, e.z);
      this.heavyLight.intensity = 260000;
      this.heavyLife = 0.42;
      this.heavyDisc.position.set(e.x, 0.12, e.z);
      this.heavyDisc.scale.setScalar(e.radius * 1.4);
      (this.heavyDisc.material as T.MeshBasicMaterial).opacity = 0.95;
    }
  }

  trace(t: Trace) {
    if (this.traceLines.length > 55) return;
    const geo = new T.BufferGeometry().setFromPoints([
      new T.Vector3(t.from.x, 1.5, t.from.z),
      new T.Vector3(t.to.x, 1.5, t.to.z),
    ]);
    const line = new T.Line(geo, new T.LineBasicMaterial({
      color: t.hostile ? 0xbfc0a0 : 0xeaf4dc, transparent: true, opacity: 0.6,
    }));
    this.group.add(line);
    this.traceLines.push({line, life: 0.1});
  }

  update(dt: number) {
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life > 0) {
        p.x += p.vx * dt; p.z += p.vz * dt;
        p.y = Math.max(0.2, p.y + p.vy * dt);
        p.vy -= dt * (p.smoke ? 1 : 18);
        p.vx *= 1 - dt * 0.5;
        p.vz *= 1 - dt * 0.5;
        const age = 1 - p.life / p.max;
        this.dummy.position.set(p.x, p.y, p.z);
        this.dummy.scale.setScalar(p.size * (p.smoke ? 0.6 + age * 2 : 1) * Math.min(1, p.life));
        // Smoke is cooler than flame, and both are hotter than the ground.
        this.color.setScalar(p.smoke ? 0.34 : 1);
      } else {
        this.dummy.scale.setScalar(0);
      }
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.color);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    for (const r of this.rings) {
      r.life -= dt;
      const age = 1 - r.life / r.max;
      r.mesh.scale.setScalar(r.radius * (0.2 + age));
      (r.mesh.material as T.MeshBasicMaterial).opacity = Math.max(0, 1 - age);
      if (r.life <= 0) this.dispose(r.mesh);
    }
    this.rings = this.rings.filter(r => r.life > 0);

    for (const t of this.traceLines) {
      t.life -= dt;
      if (t.life <= 0) this.dispose(t.line);
    }
    this.traceLines = this.traceLines.filter(t => t.life > 0);

    if (this.heavyLife > 0) {
      this.heavyLife -= dt;
      const k = Math.max(0, this.heavyLife / 0.42);
      this.heavyLight.intensity = 260000 * k * k;
      this.heavyDisc.scale.multiplyScalar(1 + dt * 2.4);
      (this.heavyDisc.material as T.MeshBasicMaterial).opacity = 0.95 * k;
      if (this.heavyLife <= 0) {
        this.heavyLight.intensity = 0;
        (this.heavyDisc.material as T.MeshBasicMaterial).opacity = 0;
      }
    }
  }

  private dispose(o: T.Mesh | T.Line) {
    this.group.remove(o);
    o.geometry.dispose();
    (o.material as T.Material).dispose();
  }

  clear() {
    for (const p of this.particles) p.life = 0;
    for (const r of this.rings) this.dispose(r.mesh);
    for (const t of this.traceLines) this.dispose(t.line);
    this.rings = [];
    this.traceLines = [];
    this.heavyLife = 0;
    this.heavyLight.intensity = 0;
    (this.heavyDisc.material as T.MeshBasicMaterial).opacity = 0;
  }
}
