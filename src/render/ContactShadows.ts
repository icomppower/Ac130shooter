import * as T from 'three';

/**
 * A dark blob pressed into the ground under every person and vehicle.
 *
 * The shadow map gives correct directional shadows, but at this altitude a
 * single low sun leaves small units with almost nothing under them. This is the
 * cheap half of the fix: a soft contact darkening that sits directly beneath
 * each unit regardless of sun angle, so nothing reads as a decal floating on
 * the terrain. At this poly count it is close to free and it buys more
 * perceived depth than any amount of asset work.
 */
export class ContactShadows {
  mesh: T.InstancedMesh;
  private dummy = new T.Object3D();
  private used = 0;

  constructor(public capacity = 260) {
    const texture = ContactShadows.blobTexture();
    const material = new T.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      color: 0x000000,
    });
    this.mesh = new T.InstancedMesh(new T.PlaneGeometry(1, 1), material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.hideFrom(0);
  }

  /** A soft radial falloff, drawn once into a small texture. */
  private static blobTexture() {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.72)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    return texture;
  }

  begin() {this.used = 0;}

  /** Place one blob. `radius` is in metres; `strength` scales its darkness. */
  add(x: number, z: number, radius: number, strength = 1) {
    if (this.used >= this.capacity) return;
    this.dummy.position.set(x, 0.05, z);
    this.dummy.rotation.set(-Math.PI / 2, 0, 0);
    this.dummy.scale.set(radius * 2, radius * 2, 1);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(this.used, this.dummy.matrix);
    // Strength is folded into scale rather than per-instance colour so the
    // whole set stays one draw call with one material.
    if (strength < 1) {
      this.dummy.scale.multiplyScalar(0.6 + strength * 0.4);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(this.used, this.dummy.matrix);
    }
    this.used++;
  }

  end() {
    this.hideFrom(this.used);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = this.capacity;
  }

  private hideFrom(start: number) {
    this.dummy.scale.setScalar(0);
    this.dummy.position.set(0, -9999, 0);
    this.dummy.updateMatrix();
    for (let i = start; i < this.capacity; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
  }
}
