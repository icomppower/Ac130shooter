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

  /**
   * Muzzle flashes.
   *
   * This is how a player finds hostiles, and it is the only identification
   * channel in the game that is free of the silhouette problem: a figure that
   * is firing at the ground team has identified itself by its own action, the
   * way it would in reality. Nothing else marks an enemy, and civilians never
   * produce one. Before these existed a frame with seven hostiles in it had no
   * cue whatsoever that any of them were there.
   */
  private muzzleCapacity = 48;
  private muzzleMesh: T.InstancedMesh;
  private muzzles: {x: number; y: number; z: number; life: number; max: number; size: number}[] = [];
  private muzzleCursor = 0;

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

    // Flat discs lying on the ground plane. Seen from an orbit they never need
    // billboarding, and additive blending lets them blow out past anything
    // else in frame, which is exactly what a flash should do on a tape.
    this.muzzleMesh = new T.InstancedMesh(
      new T.CircleGeometry(1, 12),
      new T.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.95,
        blending: T.AdditiveBlending, depthWrite: false, depthTest: false,
      }),
      this.muzzleCapacity);
    this.muzzleMesh.frustumCulled = false;
    this.muzzleMesh.renderOrder = 4;
    this.muzzleMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    for (let i = 0; i < this.muzzleCapacity; i++) {
      this.muzzles.push({x: 0, y: 0, z: 0, life: 0, max: 1, size: 1});
      this.dummy.scale.setScalar(0);
      this.dummy.updateMatrix();
      this.muzzleMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.group.add(this.muzzleMesh);
  }

  /** A weapon just fired here. `size` scales with how big the weapon is. */
  muzzle(x: number, y: number, z: number, size = 1) {
    const m = this.muzzles[this.muzzleCursor++ % this.muzzleCapacity];
    m.x = x; m.y = y + 1.6; m.z = z;
    m.life = m.max = 0.13;
    m.size = size;
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
    // The flash comes first and is the part that matters: a line one pixel
    // wide is close to invisible at altitude, and line width is not something
    // WebGL honours, so the tracer is a supporting cue rather than the cue.
    this.muzzle(t.from.x, 0, t.from.z, t.hostile ? 1 : 0.8);
    if (this.traceLines.length > 55) return;
    const geo = new T.BufferGeometry().setFromPoints([
      new T.Vector3(t.from.x, 1.6, t.from.z),
      new T.Vector3(t.to.x, 1.6, t.to.z),
    ]);
    const line = new T.Line(geo, new T.LineBasicMaterial({
      color: t.hostile ? 0xfff4d2 : 0xd8f0e4,
      transparent: true,
      opacity: 0.92,
      blending: T.AdditiveBlending,
      depthWrite: false,
    }));
    this.group.add(line);
    this.traceLines.push({line, life: 0.18});
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
      (t.line.material as T.LineBasicMaterial).opacity = Math.max(0, t.life / 0.18) * 0.92;
      if (t.life <= 0) this.dispose(t.line);
    }
    this.traceLines = this.traceLines.filter(t => t.life > 0);

    let muzzleActive = false;
    for (let i = 0; i < this.muzzleCapacity; i++) {
      const m = this.muzzles[i];
      if (m.life > 0) {
        m.life -= dt;
        // Flare out fast: full size immediately, then gone.
        const k = Math.max(0, m.life / m.max);
        this.dummy.position.set(m.x, m.y, m.z);
        this.dummy.rotation.set(-Math.PI / 2, 0, 0);
        this.dummy.scale.setScalar(m.size * (2.6 - k * 1.1) * (k > 0 ? 1 : 0));
        muzzleActive = true;
      } else {
        this.dummy.scale.setScalar(0);
      }
      this.dummy.updateMatrix();
      this.muzzleMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.muzzleMesh.instanceMatrix.needsUpdate = true;
    this.muzzleMesh.visible = muzzleActive;

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
    for (const m of this.muzzles) m.life = 0;
    for (const r of this.rings) this.dispose(r.mesh);
    for (const t of this.traceLines) this.dispose(t.line);
    this.rings = [];
    this.traceLines = [];
    this.heavyLife = 0;
    this.heavyLight.intensity = 0;
    (this.heavyDisc.material as T.MeshBasicMaterial).opacity = 0;
  }
}
