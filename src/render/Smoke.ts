import * as T from 'three';

interface Puff {
  life: number; max: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  size: number; grow: number;
  /** 0..1 starting heat: fresh smoke from a fireball is hot, dust is not. */
  heat: number;
  spin: number;
}

/**
 * Smoke and dust plumes (§24).
 *
 * The reference frame's explosions are a white-hot core with a dark plume
 * rolling off it and drifting downwind. The old particle pool drew smoke as
 * small grey solids, which from altitude read as gravel thrown in the air.
 * These are soft camera-facing sprites that grow, rise, drift on one wind
 * vector, and cool from bright to dark as they age — so a plume is hot where
 * it leaves the fire and cold by the time it is a smear across the ground.
 *
 * One bounded pool, one instanced draw call. Deliberately kept out of the
 * bloom layer: smoke is what bloom has to glow *through*, not a source.
 */
export class Smoke {
  mesh: T.InstancedMesh;
  private puffs: Puff[] = [];
  private cursor = 0;
  private dummy = new T.Object3D();
  /** Per-instance (brightness, opacity). */
  private shade: T.InstancedBufferAttribute;
  /** Metres per second. One wind for the whole battlefield. */
  wind = new T.Vector3(2.2, 0, -1.1);

  constructor(public capacity = 360) {
    // A small shader rather than MeshBasicMaterial, because a puff has to fade
    // its *opacity* per instance. Fading its colour instead leaves a black
    // smudge that pops out of existence at the end of its life.
    const material = new T.ShaderMaterial({
      uniforms: {map: {value: Smoke.texture()}},
      transparent: true,
      depthWrite: false,
      vertexShader: `
attribute vec2 shade;
varying vec2 vUv;
varying vec2 vShade;
void main(){
  vUv = uv;
  vShade = shade;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}`,
      fragmentShader: `
uniform sampler2D map;
varying vec2 vUv;
varying vec2 vShade;
void main(){
  float a = texture2D(map, vUv).a * vShade.y;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vec3(vShade.x), a);
}`,
    });
    const geometry = new T.PlaneGeometry(1, 1);
    this.shade = new T.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.shade.setUsage(T.DynamicDrawUsage);
    geometry.setAttribute('shade', this.shade);
    this.mesh = new T.InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    for (let i = 0; i < capacity; i++) {
      this.puffs.push({life: 0, max: 1, x: 0, y: -1000, z: 0, vx: 0, vy: 0, vz: 0, size: 0, grow: 0, heat: 0, spin: 0});
      this.dummy.scale.setScalar(0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
  }

  /** A soft, lumpy puff, drawn once. */
  private static texture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    // Deterministic lumps so every run looks the same.
    let seed = 71;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 18; i++) {
      const x = size / 2 + (rnd() - 0.5) * 50, y = size / 2 + (rnd() - 0.5) * 50;
      const r = 18 + rnd() * 26;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.42)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.16)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
    const texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    return texture;
  }

  private emit(x: number, y: number, z: number, size: number, life: number, heat: number,
    vx: number, vy: number, vz: number, grow: number) {
    const p = this.puffs[this.cursor++ % this.capacity];
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.size = size; p.grow = grow;
    p.life = p.max = life;
    p.heat = heat;
    p.spin = Math.random() * Math.PI * 2;
  }

  /** An explosion of a given weight: 0 = 25 mm, 1 = 40 mm, 2 = 105 mm. */
  burst(x: number, z: number, radius: number, weight: number) {
    const n = weight === 2 ? 26 : weight === 1 ? 9 : 2;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * radius * 0.5;
      const column = weight === 2 && i < n * 0.45;
      this.emit(
        x + Math.cos(a) * r, column ? 2 + Math.random() * 6 : 0.8, z + Math.sin(a) * r,
        (weight === 2 ? 6 : weight === 1 ? 3.6 : 1.8) * (0.7 + Math.random() * 0.6),
        (weight === 2 ? 9 : weight === 1 ? 6 : 2.6) * (0.7 + Math.random() * 0.6),
        weight === 0 ? 0.25 : 0.95,
        Math.cos(a) * radius * 0.4, column ? 5 + Math.random() * 5 : 1 + Math.random() * 2, Math.sin(a) * radius * 0.4,
        weight === 2 ? 2.4 : 1.5);
    }
  }

  /** A burning wreck or building: a thin continuous trickle. */
  smoulder(x: number, z: number) {
    this.emit(x + (Math.random() - 0.5) * 2, 2, z + (Math.random() - 0.5) * 2,
      2.2, 7, 0.55, 0, 2.2 + Math.random(), 0, 1.6);
  }

  update(dt: number, camera: T.Camera) {
    const q = camera.quaternion;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.puffs[i];
      if (p.life > 0) {
        p.life -= dt;
        const age = 1 - Math.max(0, p.life) / p.max;
        // Initial throw decays; the wind takes over.
        const drag = 1 - Math.min(1, dt * 1.6);
        p.vx = p.vx * drag + this.wind.x * dt * 1.6;
        p.vz = p.vz * drag + this.wind.z * dt * 1.6;
        p.vy *= 1 - Math.min(1, dt * 0.5);
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const s = p.size * (1 + age * p.grow) * Math.min(1, (p.max - p.life) * 8);
        // A camera-facing sprite tilts toward the ground, and where it passes
        // below it the depth test cuts it along a hard straight line. Keep
        // every puff high enough that its lower edge clears the ground.
        p.y = Math.max(p.y, s * 0.42);
        this.dummy.position.set(p.x, p.y, p.z);
        this.dummy.quaternion.copy(q);
        this.dummy.rotateZ(p.spin + age * 0.6);
        this.dummy.scale.set(s, s, 1);
        // Hot as it leaves the fire, cold and dark by the time it drifts off.
        // A fade-out at the end so plumes thin rather than pop.
        // Cools fast: only the first fifth of a puff's life is anywhere near the
        // fireball's brightness. The reference plumes are dark almost at once.
        const k = Math.max(0, p.heat * (1 - age * 8));
        this.shade.setXY(i, 0.1 + k * 0.85, 0.85 * Math.min(1, Math.max(0, p.life) * 0.6));
        if (p.life <= 0) this.dummy.scale.setScalar(0);
      } else {
        this.dummy.scale.setScalar(0);
      }
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.shade.needsUpdate = true;
  }

  clear() {for (const p of this.puffs) p.life = 0;}
}
