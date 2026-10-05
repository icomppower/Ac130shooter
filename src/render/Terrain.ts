import * as T from 'three';
import type {AssetLibrary} from '../assets/AssetLibrary';
import {box, HOUSE_TYPES, type ModelName} from '../assets/ModelFactory';
import {Rng} from '../sim/rng';
import {LEG_STARTS, LZ, ROUTE, ROUTE_LENGTH, alongRoute} from '../sim/route';
import type {Building} from '../sim/types';
import {PROBE_POSITION} from '../game/debug';

/**
 * The static world: ground, the track the column walks, the buildings, and
 * enough scatter that the orbit has something to slide near objects against.
 *
 * Everything here casts and receives shadows. That is not decoration — without
 * ground contact shadows every unit reads as a decal pasted onto the terrain,
 * which was the single biggest thing wrong with the reference build's look.
 */
/** See scatterClutter: clutter's thermal floor relative to the plain cold band. */
const CLUTTER_COLD_GAIN = 0.82;

export class Terrain {
  group = new T.Group();
  structures = new Map<number, T.Group>();
  private stages = new Map<number, number>();
  /**
   * Where every piece of clutter stands, by type. Read by the kill gate
   * (G13/G14) to count clutter inside the sensor frustum and to find its
   * pixels; the simulation never sees any of this.
   */
  clutter: {kind: ModelName; x: number; z: number; radius: number}[] = [];
  /** The instanced meshes that draw the clutter, for the clutter-only probe render. */
  clutterMeshes: T.InstancedMesh[] = [];

  constructor(assets: AssetLibrary, buildings: Building[]) {
    const rng = new Rng(8821);

    // The ground is not a plane of one grey. A tiled dirt-and-gravel texture
    // gives it grain at every zoom step, and the cold-band brightness from the
    // sensor layer multiplies straight through it.
    const groundMat = new T.MeshStandardMaterial({color: 0x4e564a, roughness: 1, map: Terrain.dirtTexture(77, 1)});
    groundMat.map!.repeat.set(4200 / 34, 4200 / 34);
    groundMat.userData = {optical: 0x4e564a, heat: 0.02, coldGain: 1.6};
    const ground = new T.Mesh(new T.PlaneGeometry(4200, 4200), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.08;
    ground.receiveShadow = true;
    this.group.add(ground);

    // The old low-relief boxes are gone (§24). Under a 20 degree sun their
    // hard edges threw long straight shadows that read as concrete slabs; the
    // soft soil patches below do the same job without edges.

    // Large soft patches of darker soil and paler dust, laid over the tiled
    // texture so its repeat never shows: at the medium zoom a 34 m tile would
    // otherwise be visible as a pattern.
    {
      const patchMat = new T.MeshBasicMaterial({
        map: Terrain.blobTexture(), transparent: true, depthWrite: false, color: 0x000000, opacity: 0.22,
      });
      const lightMat = new T.MeshBasicMaterial({
        map: Terrain.blobTexture(), transparent: true, depthWrite: false, color: 0xffffff, opacity: 0.07,
      });
      for (const [material, count] of [[patchMat, 420], [lightMat, 260]] as const) {
        const patches = new T.InstancedMesh(new T.PlaneGeometry(1, 1), material, count);
        patches.renderOrder = 0;
        const d = new T.Object3D();
        for (let i = 0; i < count; i++) {
          const along = rng.range(-150, ROUTE_LENGTH + 150);
          const {position, heading} = alongRoute(Math.max(0, Math.min(ROUTE_LENGTH, along)));
          const off = rng.range(0, 380) * (rng.next() < 0.5 ? -1 : 1);
          d.position.set(position.x - heading.z * off + rng.spread(60), 0.015 + i * 0.00001,
            position.z + heading.x * off + rng.spread(60));
          d.rotation.set(-Math.PI / 2, 0, rng.range(0, 6));
          const r = rng.range(8, 46);
          d.scale.set(r * rng.range(0.8, 2.2), r, 1);
          d.updateMatrix();
          patches.setMatrixAt(i, d.matrix);
        }
        this.group.add(patches);
      }
    }

    // The track: a worn strip following the route, so the player can read where
    // the column has come from and where it is going without the minimap.
    const track = new T.Group();
    const step = 9;
    // The track shares the dirt texture, more heavily worn, so it reads as
    // trodden ground rather than a smooth grey strip laid on top.
    const trackMat = new T.MeshStandardMaterial({color: 0x6b6c5b, roughness: 1, map: Terrain.dirtTexture(91, 1.4)});
    trackMat.userData = {optical: 0x6b6c5b, heat: 0.04, coldGain: 1.45};
    for (let d = 0; d < ROUTE_LENGTH; d += step) {
      const {position, heading} = alongRoute(d);
      const seg = box(track, position.x, 0.02, position.z, 11, 0.05, step + 1.4, 0x6b6c5b, 0.04);
      seg.rotation.y = Math.atan2(heading.x, heading.z);
      seg.receiveShadow = true;
      seg.material = trackMat;
      // Two tyre ruts worn into the track, the strongest line in the
      // reference frame after the fences.
      for (const side of [-1.7, 1.7]) {
        const rut = box(track, position.x - heading.z * side, 0.05, position.z + heading.x * side,
          0.55, 0.04, step + 1.4, 0x4a4b3f, 0.03);
        rut.rotation.y = seg.rotation.y;
        rut.receiveShadow = true;
      }
    }
    // Waypoint scuffs, so leg boundaries are legible on the ground.
    for (let i = 1; i < ROUTE.length - 1; i++) {
      const p = ROUTE[i];
      const scuff = box(track, p.x, 0.03, p.z, 26, 0.05, 26, 0x6e705c, 0.04);
      scuff.rotation.y = LEG_STARTS[i] * 0.01;
      scuff.receiveShadow = true;
      scuff.material = trackMat;
    }
    this.group.add(track);

    const pad = assets.get('lzpad');
    pad.position.set(LZ.x, 0, LZ.z);
    pad.traverse(o => {if (o instanceof T.Mesh) o.receiveShadow = true;});
    this.group.add(pad);

    for (const b of buildings) {
      // Three roof types, picked deterministically off the building id. From
      // the orbit a roof is most of what a building is, and one model rescaled
      // across a whole district reads as a tiling pattern rather than a place.
      const g = assets.get(HOUSE_TYPES[b.id % HOUSE_TYPES.length]);
      g.position.set(b.x, 0, b.z);
      g.scale.set(b.width / 12, b.height / 6.8, b.depth / 10);
      g.rotation.y = rng.range(-0.25, 0.25);
      g.userData.building = b.id;
      g.traverse(o => {
        if (!(o instanceof T.Mesh)) return;
        o.castShadow = true;
        o.receiveShadow = true;
      });
      this.group.add(g);
      this.structures.set(b.id, g);
    }

    // Market rows in the chokepoint: clutter the column has to squeeze past.
    for (let i = 0; i < 9; i++) {
      const stall = assets.get('market');
      stall.position.set(176 + i * 8.5, 0.05, 44 - i * 1.4);
      stall.rotation.y = 0.12 + rng.range(-0.1, 0.1);
      stall.traverse(o => {if (o instanceof T.Mesh) {o.castShadow = true; o.receiveShadow = true;}});
      this.group.add(stall);
    }

    // Compound walls, placed off the route so they break sightlines without
    // blocking the column.
    for (let i = 0; i < 16; i++) {
      const d = rng.range(60, ROUTE_LENGTH - 60);
      const {position, heading} = alongRoute(d);
      const side = rng.next() < 0.5 ? -1 : 1;
      const off = rng.range(38, 90) * side;
      const w = assets.get('wall');
      w.position.set(position.x + -heading.z * off, 0, position.z + heading.x * off);
      w.rotation.y = rng.range(0, Math.PI);
      w.traverse(o => {if (o instanceof T.Mesh) {o.castShadow = true; o.receiveShadow = true;}});
      this.group.add(w);
    }

    for (let i = 0; i < 120; i++) {
      const d = rng.range(-120, ROUTE_LENGTH + 120);
      const {position, heading} = alongRoute(Math.max(0, Math.min(ROUTE_LENGTH, d)));
      const off = rng.range(45, 320) * (rng.next() < 0.5 ? -1 : 1);
      const along = rng.range(-60, 60);
      const t = assets.get('tree');
      t.position.set(
        position.x + -heading.z * off + heading.x * along, 0,
        position.z + heading.x * off + heading.z * along);
      t.rotation.y = rng.range(0, 6);
      t.scale.setScalar(rng.range(0.75, 1.5));
      t.traverse(o => {if (o instanceof T.Mesh) {o.castShadow = true; o.receiveShadow = true;}});
      this.group.add(t);
    }

    // Rubble and scrub, instanced so the draw-call count stays bounded.
    const debrisMat = new T.MeshStandardMaterial({color: 0x6e6e5d, roughness: 1, flatShading: true});
    debrisMat.userData = {optical: 0x6e6e5d, heat: 0.03};
    const debris = new T.InstancedMesh(new T.DodecahedronGeometry(1, 0), debrisMat, 700);
    debris.castShadow = true;
    debris.receiveShadow = true;
    const dummy = new T.Object3D();
    for (let i = 0; i < 700; i++) {
      const d = rng.range(-200, ROUTE_LENGTH + 200);
      const {position, heading} = alongRoute(Math.max(0, Math.min(ROUTE_LENGTH, d)));
      const off = rng.range(22, 420) * (rng.next() < 0.5 ? -1 : 1);
      dummy.position.set(
        position.x + -heading.z * off + rng.range(-70, 70), 0.15,
        position.z + heading.x * off + rng.range(-70, 70));
      dummy.scale.set(rng.range(0.3, 1.4), rng.range(0.2, 0.8), rng.range(0.4, 1.5));
      dummy.rotation.set(rng.next(), rng.range(0, 6), rng.next());
      dummy.updateMatrix();
      debris.setMatrixAt(i, dummy.matrix);
    }
    this.group.add(debris);

    this.scatterClutter(assets, buildings, new Rng(5150));
  }

  /**
   * The clutter pass (§24): fences, wrecks, junk, trailers, dead trees, grass.
   *
   * Every type is drawn as one InstancedMesh per material, so a few thousand
   * pieces cost a couple of dozen draw calls. Placement is seeded and keeps
   * off the track and out of building footprints. Nothing here is gameplay.
   */
  private scatterClutter(assets: AssetLibrary, buildings: Building[], rng: Rng) {
    const placed = new Map<ModelName, T.Matrix4[]>();
    const d = new T.Object3D();
    // The identification probe stands on clear ground at PROBE_POSITION. Clutter
    // in its window would be measured as part of every figure's silhouette, so
    // the probe's patch is kept bare — treated exactly like a building.
    const inBuilding = (x: number, z: number, pad: number) =>
      Math.hypot(x - PROBE_POSITION.x, z - PROBE_POSITION.z) < 45 || buildings.some(b =>
        Math.abs(x - b.x) < b.width / 2 + pad && Math.abs(z - b.z) < b.depth / 2 + pad);
    const onTrack = (x: number, z: number, clear: number) => {
      // Coarse but sufficient: the nearest sampled point of the route.
      for (let s = 0; s <= ROUTE_LENGTH; s += 6) {
        const p = alongRoute(s).position;
        if (Math.hypot(p.x - x, p.z - z) < clear) return true;
      }
      return false;
    };
    const put = (kind: ModelName, x: number, z: number, yaw: number, scale = 1, radius = 2,
      tilt = 0) => {
      d.position.set(x, 0, z);
      d.rotation.set(0, yaw, tilt);
      d.scale.setScalar(scale);
      d.updateMatrix();
      const list = placed.get(kind) ?? [];
      list.push(d.matrix.clone());
      placed.set(kind, list);
      this.clutter.push({kind, x, z, radius: radius * scale});
    };
    const routePoint = (along: number, off: number, slide = 0) => {
      const {position, heading} = alongRoute(Math.max(0, Math.min(ROUTE_LENGTH, along)));
      return {
        x: position.x - heading.z * off + heading.x * slide,
        z: position.z + heading.x * off + heading.z * slide,
        yaw: Math.atan2(heading.x, heading.z),
      };
    };

    // Fence runs alongside the track: contiguous sheets with gaps and leans,
    // like the yard boundary in the reference frame.
    for (let i = 0; i < 34; i++) {
      const along = rng.range(20, ROUTE_LENGTH - 20);
      const off = rng.range(13, 34) * (rng.next() < 0.5 ? -1 : 1);
      const n = rng.int(2, 6);
      for (let k = 0; k < n; k++) {
        if (rng.next() < 0.14) continue;
        const p = routePoint(along + k * 7.9, off + rng.spread(0.3));
        if (inBuilding(p.x, p.z, 1.5) || onTrack(p.x, p.z, 9)) continue;
        put('fence', p.x, p.z, p.yaw + Math.PI / 2 + rng.spread(0.05), 1, 4.2, rng.spread(0.06));
      }
    }

    // Compound fences, junk and drums around buildings: lived-in yards.
    for (const b of buildings) {
      const sides = rng.int(1, 3);
      for (let k = 0; k < sides; k++) {
        const side = rng.int(0, 3);
        const along = side % 2 === 0;
        const span = along ? b.width + 8 : b.depth + 8;
        const n = Math.max(1, Math.floor(span / 8));
        for (let j = 0; j < n; j++) {
          if (rng.next() < 0.18) continue;
          const t = -span / 2 + 4 + j * 8;
          const x = b.x + (along ? t : (side === 1 ? 1 : -1) * (b.width / 2 + 5));
          const z = b.z + (along ? (side === 0 ? 1 : -1) * (b.depth / 2 + 5) : t);
          if (onTrack(x, z, 8)) continue;
          put('fence', x, z, along ? 0 : Math.PI / 2, 1, 4.2, rng.spread(0.05));
        }
      }
      for (let k = 0; k < 2; k++) {
        const a = rng.range(0, Math.PI * 2), r = Math.max(b.width, b.depth) / 2 + rng.range(3, 9);
        const x = b.x + Math.cos(a) * r, z = b.z + Math.sin(a) * r;
        if (inBuilding(x, z, 1) || onTrack(x, z, 8)) continue;
        put(rng.next() < 0.6 ? 'junk' : 'drums', x, z, rng.range(0, 6), rng.range(0.8, 1.3), 2.4);
      }
    }

    // Burnt-out vehicles along the verges, and abandoned trailers.
    for (let i = 0; i < 44; i++) {
      const p = routePoint(rng.range(0, ROUTE_LENGTH), rng.range(9, 60) * (rng.next() < 0.5 ? -1 : 1), rng.spread(10));
      if (inBuilding(p.x, p.z, 3) || onTrack(p.x, p.z, 8)) continue;
      put(rng.next() < 0.55 ? 'pickup' : 'sedan', p.x, p.z, p.yaw + rng.spread(0.9), 1, 3);
    }
    for (let i = 0; i < 9; i++) {
      const p = routePoint(rng.range(0, ROUTE_LENGTH), rng.range(14, 50) * (rng.next() < 0.5 ? -1 : 1));
      if (inBuilding(p.x, p.z, 5) || onTrack(p.x, p.z, 10)) continue;
      put('trailer', p.x, p.z, p.yaw + rng.spread(1.2), 1, 4.2);
    }
    for (let i = 0; i < 70; i++) {
      const p = routePoint(rng.range(0, ROUTE_LENGTH), rng.range(10, 130) * (rng.next() < 0.5 ? -1 : 1), rng.spread(30));
      if (inBuilding(p.x, p.z, 2) || onTrack(p.x, p.z, 8)) continue;
      put(rng.next() < 0.6 ? 'junk' : 'drums', p.x, p.z, rng.range(0, 6), rng.range(0.7, 1.4), 2.4);
    }

    // Dead trees, singly and in small stands.
    for (let i = 0; i < 64; i++) {
      const p = routePoint(rng.range(-60, ROUTE_LENGTH + 60), rng.range(11, 150) * (rng.next() < 0.5 ? -1 : 1), rng.spread(30));
      const stand = rng.int(1, 3);
      for (let k = 0; k < stand; k++) {
        const x = p.x + rng.spread(7), z = p.z + rng.spread(7);
        if (inBuilding(x, z, 2) || onTrack(x, z, 8)) continue;
        put('deadtree', x, z, rng.range(0, 6), rng.range(0.8, 1.5), 3);
      }
    }

    // Grass and scrub, clumped rather than uniform: a clump centre, then
    // tufts scattered round it. Allowed right up to the track edge.
    for (let i = 0; i < 260; i++) {
      const c = routePoint(rng.range(-80, ROUTE_LENGTH + 80), rng.range(6, 180) * (rng.next() < 0.5 ? -1 : 1), rng.spread(40));
      const n = rng.int(6, 18);
      for (let k = 0; k < n; k++) {
        const x = c.x + rng.spread(9), z = c.z + rng.spread(9);
        if (inBuilding(x, z, 0.5) || onTrack(x, z, 6.5)) continue;
        put(rng.next() < 0.8 ? 'grass' : 'scrub', x, z, rng.range(0, 6), rng.range(0.7, 1.6), 0.6);
      }
    }

    for (const [kind, matrices] of placed) {
      const template = assets.get(kind);
      template.updateMatrixWorld(true);
      template.traverse(o => {
        if (!(o instanceof T.Mesh)) return;
        const local = o.matrixWorld.clone();
        // Clutter sits one step below the plain cold band. The low §24 sun hits
        // fence sheets and car panels square-on, and at the plain band their
        // lit faces climbed to 0.73 — past G14's pre-registered 0.70 ceiling,
        // i.e. into the range where a wreck starts to compete with a body.
        // The threshold stays; the clutter comes down. Materials are cloned so
        // nothing else that happens to share one is affected.
        const material = (o.material as T.Material).clone();
        material.userData = {...(o.material as T.Material).userData, coldGain: CLUTTER_COLD_GAIN};
        const inst = new T.InstancedMesh(o.geometry, material, matrices.length);
        const m = new T.Matrix4();
        matrices.forEach((placement, i) => inst.setMatrixAt(i, m.multiplyMatrices(placement, local)));
        inst.castShadow = kind !== 'grass';
        inst.receiveShadow = true;
        inst.userData.clutter = kind;
        // Instances spread over the whole map; per-instance culling is not
        // available, so the bounding sphere has to cover all of them.
        inst.computeBoundingSphere();
        this.group.add(inst);
        this.clutterMeshes.push(inst);
      });
    }
  }

  /**
   * Dirt and gravel, drawn once into a canvas and tiled. Values sit in a
   * narrow band near white so the sensor's cold-band brightness passes through
   * with texture rather than being darkened wholesale.
   */
  static dirtTexture(seed: number, strength: number) {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const rng = new Rng(seed);
    ctx.fillStyle = 'rgb(222,222,222)';
    ctx.fillRect(0, 0, size, size);
    const dab = (x: number, y: number, r: number, v: number, a: number) => {
      ctx.fillStyle = `rgba(${v},${v},${v},${a})`;
      // Tile seamlessly: draw each dab at every wrapped offset it overlaps.
      for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    // Broad mottling, then gravel, then fine grit.
    for (let i = 0; i < 90; i++) dab(rng.range(0, size), rng.range(0, size), rng.range(30, 90), rng.pick([150, 255]), 0.08 * strength);
    for (let i = 0; i < 2600; i++) dab(rng.range(0, size), rng.range(0, size), rng.range(0.8, 3.2), rng.pick([120, 150, 255]), 0.45 * strength);
    for (let i = 0; i < 9000; i++) dab(rng.range(0, size), rng.range(0, size), rng.range(0.4, 1), rng.pick([140, 255]), 0.35 * strength);
    const texture = new T.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = T.RepeatWrapping;
    texture.colorSpace = T.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  }

  /** Soft-edged irregular blob, for the soil patches. */
  static blobTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const rng = new Rng(19);
    for (let i = 0; i < 14; i++) {
      const x = size / 2 + rng.spread(26), y = size / 2 + rng.spread(26), r = rng.range(16, 40);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
    const texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    return texture;
  }

  /** Staged collapse: roof compression, a lean, and a darkening of the surfaces. */
  update(buildings: Building[]) {
    for (const b of buildings) {
      const stage = b.hp <= 0 ? 3 : b.hp < b.maxHp * 0.3 ? 2 : b.hp < b.maxHp * 0.65 ? 1 : 0;
      if (this.stages.get(b.id) === stage) continue;
      this.stages.set(b.id, stage);
      const g = this.structures.get(b.id);
      if (!g) continue;
      g.scale.y = b.height / 6.8 * [1, 0.94, 0.7, 0.16][stage];
      g.rotation.z = stage > 1 ? 0.045 : 0;
      if (stage === 0) continue;
      g.traverse(o => {
        if (!(o instanceof T.Mesh)) return;
        if (!o.userData.uniqueMaterial) {
          o.material = (o.material as T.MeshStandardMaterial).clone();
          o.userData.uniqueMaterial = true;
        }
        const m = o.material as T.MeshStandardMaterial;
        const optical = new T.Color(m.userData.optical ?? m.color.getHex()).multiplyScalar(0.82);
        m.userData.optical = optical.getHex();
        // Rubble holds the day's heat a little longer than intact stone.
        m.userData.heat = Math.min(0.35, (m.userData.heat ?? 0) + 0.06 * stage);
      });
    }
  }
}
