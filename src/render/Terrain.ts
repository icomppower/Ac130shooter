import * as T from 'three';
import type {AssetLibrary} from '../assets/AssetLibrary';
import {box, HOUSE_TYPES} from '../assets/ModelFactory';
import {Rng} from '../sim/rng';
import {LEG_STARTS, LZ, ROUTE, ROUTE_LENGTH, alongRoute} from '../sim/route';
import type {Building} from '../sim/types';

/**
 * The static world: ground, the track the column walks, the buildings, and
 * enough scatter that the orbit has something to slide near objects against.
 *
 * Everything here casts and receives shadows. That is not decoration — without
 * ground contact shadows every unit reads as a decal pasted onto the terrain,
 * which was the single biggest thing wrong with the reference build's look.
 */
export class Terrain {
  group = new T.Group();
  structures = new Map<number, T.Group>();
  private stages = new Map<number, number>();

  constructor(assets: AssetLibrary, buildings: Building[]) {
    const rng = new Rng(8821);

    const groundMat = new T.MeshStandardMaterial({color: 0x4e564a, roughness: 1});
    groundMat.userData = {optical: 0x4e564a, heat: 0.02};
    const ground = new T.Mesh(new T.PlaneGeometry(4200, 4200), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.08;
    ground.receiveShadow = true;
    this.group.add(ground);

    // Low relief so the ground is not a mathematical plane under the orbit.
    const relief = new T.Group();
    for (let i = 0; i < 90; i++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(240, 1500);
      const mound = box(relief,
        Math.cos(a) * r + 100, -1.2, Math.sin(a) * r,
        rng.range(40, 140), rng.range(1.6, 3.4), rng.range(40, 140), 0x525a4c, 0.02);
      mound.rotation.y = rng.range(0, Math.PI);
      mound.receiveShadow = true;
    }
    this.group.add(relief);

    // The track: a worn strip following the route, so the player can read where
    // the column has come from and where it is going without the minimap.
    const track = new T.Group();
    const step = 9;
    for (let d = 0; d < ROUTE_LENGTH; d += step) {
      const {position, heading} = alongRoute(d);
      const seg = box(track, position.x, 0.02, position.z, 11, 0.05, step + 1.4, 0x6b6c5b, 0.04);
      seg.rotation.y = Math.atan2(heading.x, heading.z);
      seg.receiveShadow = true;
    }
    // Waypoint scuffs, so leg boundaries are legible on the ground.
    for (let i = 1; i < ROUTE.length - 1; i++) {
      const p = ROUTE[i];
      const scuff = box(track, p.x, 0.03, p.z, 26, 0.05, 26, 0x74765f, 0.05);
      scuff.rotation.y = LEG_STARTS[i] * 0.01;
      scuff.receiveShadow = true;
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
