import * as T from 'three';
import {Rng} from '../sim/rng';

export type ModelName =
  | 'house' | 'house2' | 'house3' | 'building' | 'wall' | 'road' | 'tree' | 'rock' | 'market'
  | 'gunship' | 'helo' | 'lzpad'
  | 'civilian' | 'civilian2' | 'child' | 'cart' | 'operator' | 'rifle' | 'mg' | 'rpg' | 'mortar'
  | 'technical' | 'transport' | 'assault' | 'wreck'
  | 'fence' | 'pickup' | 'sedan' | 'junk' | 'trailer' | 'deadtree' | 'grass' | 'scrub' | 'drums';

export const MODEL_NAMES: readonly ModelName[] = [
  'house', 'house2', 'house3', 'building', 'wall', 'road', 'tree', 'rock', 'market',
  'gunship', 'helo', 'lzpad',
  'civilian', 'civilian2', 'child', 'cart', 'operator', 'rifle', 'mg', 'rpg', 'mortar',
  'technical', 'transport', 'assault', 'wreck',
  'fence', 'pickup', 'sedan', 'junk', 'trailer', 'deadtree', 'grass', 'scrub', 'drums',
];

/**
 * Clutter: the stuff between buildings that makes a place read as a place.
 * None of it is gameplay — Terrain scatters it, instanced, and the simulation
 * never knows it exists.
 *
 * Every piece is cold. Metal and dead wood at night sit in the same narrow band
 * as the ground (§21), and that is load-bearing: a wrecked car or a junk pile
 * that rendered anywhere near the brightness of a body would put back exactly
 * the field-of-pebbles problem the visibility pass removed. G14 gates it.
 */
export const CLUTTER_TYPES: readonly ModelName[] = [
  'fence', 'pickup', 'sedan', 'junk', 'trailer', 'deadtree', 'grass', 'scrub', 'drums',
];
/** Thermal signatures for clutter. Never above METAL_HEAT. */
const METAL_HEAT = 0.05, WOOD_HEAT = 0.07, PLANT_HEAT = 0.04;

/**
 * The three house types. They differ in roof shape, because from the orbit a
 * roof is most of what a building is — one rescaled model over a whole
 * district reads as a tiling pattern rather than a place.
 */
export const HOUSE_TYPES: readonly ModelName[] = ['house', 'house2', 'house3'];

/**
 * Civilian variants. Every one of these has to stay clearly unarmed at
 * altitude: the silhouette gate checks each against every armed figure, not
 * just the first one.
 */
export const CIVILIAN_TYPES: readonly ModelName[] = ['civilian', 'civilian2', 'child'];

/**
 * Materials carry two extras that the sensor layer reads:
 *   optical — the material's colour outside thermal, as an integer sRGB hex.
 *   heat    — 0 to 1, its thermal signature.
 *
 * This is load-bearing for the identification problem. Every person is hot, so
 * heat can never separate a civilian from a hostile. What separates them is
 * silhouette: a hostile carries something long and horizontal, a civilian
 * carries a bundle or pushes a cart. Build the models with that in mind.
 */
const materials = new Map<string, T.MeshStandardMaterial>();
/**
 * §25 TV channel. While a figure is being built, every material it uses is a
 * figure material: on the TV channel people read dark against a pale lit
 * ground, as in the reference. Skin stays a shade lighter than kit so a head
 * still reads, but nothing on a person goes anywhere near the ground's tone.
 */
let buildingFigure = false;
function figureTv(color: number) {
  const c = new T.Color(color);
  return 0.05 + (c.r * 0.3 + c.g * 0.5 + c.b * 0.2) * 0.14;
}

function mat(color: number, heat = 0) {
  const key = `${color}:${heat}:${buildingFigure ? 'f' : ''}`;
  let m = materials.get(key);
  if (!m) {
    m = new T.MeshStandardMaterial({color, roughness: 1, flatShading: true});
    m.name = `m_${color.toString(16)}_heat_${heat.toFixed(2)}${buildingFigure ? '_fig' : ''}`;
    m.userData = buildingFigure ? {optical: color, heat, tv: figureTv(color)} : {optical: color, heat};
    // Dry plants read mid-grey on the TV channel, never paler than the dirt.
    if (!buildingFigure && heat === PLANT_HEAT) m.userData.tvGain = 0.55;
    materials.set(key, m);
  }
  return m;
}

export function box(g: T.Group, x: number, y: number, z: number, w: number, h: number, d: number, color: number, heat = 0) {
  const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat(color, heat));
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

function cyl(g: T.Group, x: number, y: number, z: number, r: number, h: number, color: number, sides = 8, heat = 0) {
  const m = new T.Mesh(new T.CylinderGeometry(r, r, h, sides), mat(color, heat));
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

/**
 * §24 character pass: a rounded body part with exactly the footprint of the
 * box it replaces (w × h × d). The silhouettes were tuned against the
 * identification gate box by box, so the envelope is kept and only the
 * corners go: a capsule reads as a limb, a box reads as a crate.
 */
function limb(g: T.Group, x: number, y: number, z: number, w: number, h: number, d: number, color: number, heat = 0) {
  const m = new T.Mesh(new T.CapsuleGeometry(0.5, 1, 2, 6), mat(color, heat));
  m.scale.set(w, h / 2, d);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

const STONE = 0x777364, ROOF = 0x55584e, DARK = 0x202c2a;
/** Stone and roofing re-radiate the day's heat well into the night. */
const MASONRY = 0.13, ROOF_HEAT = 0.10;
/**
 * Thermal identification panel. Deliberately the coldest thing worn by anyone:
 * it has to read as a dark bar against a body at 0.92, which is the one
 * signature on this battlefield that cannot occur by accident.
 */
const PANEL = 0x1b201c, PANEL_HEAT = 0.015;
/** Bodies sit near the top of the heat range; nothing else in the scene does. */
const SKIN = 0.98, TORSO = 0.92, LIMB = 0.86;

/**
 * Ground-team operators, armed hostiles and civilians share one body. They are
 * deliberately oversized (roughly 2.4 m) so the silhouette survives being a few
 * pixels tall at gunship altitude.
 */
function figure(g: T.Group, kind: ModelName) {
  buildingFigure = true;
  try {figureParts(g, kind);} finally {buildingFigure = false;}
}

function figureParts(g: T.Group, kind: ModelName) {
  const civilian = kind === 'civilian' || kind === 'civilian2' || kind === 'child';
  const uniform = civilian ? 0x918877 : kind === 'operator' ? 0x657567 : 0x615f50;

  limb(g, 0, 1.3, 0, 0.8, 1.1, 0.46, uniform, TORSO);
  const head = new T.Mesh(new T.IcosahedronGeometry(0.3, 1), mat(0xaf9b7f, SKIN));
  head.position.y = 2.13;
  g.add(head);
  // §25: legs in mid-stride rather than standing stiff, so a figure reads as
  // a person moving across the ground. Same footprint, splayed fore and aft.
  const legA = limb(g, -0.25, 0.5, 0.16, 0.23, 0.9, 0.27, uniform, LIMB);
  legA.rotation.x = -0.38;
  const legB = limb(g, 0.25, 0.5, -0.12, 0.23, 0.9, 0.27, uniform, LIMB);
  legB.rotation.x = 0.34;

  if (kind === 'civilian2') {
    // Stooped under a tall back load. No headload, so it is distinct from the
    // first civilian from above, but still nothing horizontal anywhere on it.
    const left = limb(g, -0.5, 1.26, 0.06, 0.22, 0.84, 0.22, uniform, LIMB);
    left.rotation.x = 0.22;
    const right = limb(g, 0.5, 1.26, 0.06, 0.22, 0.84, 0.22, uniform, LIMB);
    right.rotation.x = 0.3;
    const load = box(g, 0, 1.86, -0.46, 0.86, 1.5, 0.62, 0x8a7f68, 0.32);
    load.rotation.x = 0.2;
    box(g, 0, 2.62, -0.5, 0.66, 0.42, 0.48, 0x7f7460, 0.28);
    return;
  }

  if (kind === 'child') {
    // Nothing carried at all. Small, and it moves with the column.
    box(g, 0, 1.9, 0, 0.4, 0.24, 0.34, 0x93876d, 0.3);
    const left = limb(g, -0.44, 1.3, 0.02, 0.18, 0.72, 0.18, uniform, LIMB);
    left.rotation.x = -0.2;
    const right = limb(g, 0.44, 1.3, 0.02, 0.18, 0.72, 0.18, uniform, LIMB);
    right.rotation.x = 0.2;
    g.scale.setScalar(0.66);
    return;
  }

  if (civilian) {
    // Arms hang, and the load rides on the back and the head. Nothing on a
    // civilian sticks out sideways, which is the whole point: from altitude
    // the outline is a single upright blob with a wide cap on top, and there
    // is no long thin bar anywhere on it.
    const left = limb(g, -0.5, 1.3, 0.02, 0.22, 0.86, 0.22, uniform, LIMB);
    left.rotation.x = -0.12;
    const right = limb(g, 0.5, 1.3, 0.02, 0.22, 0.86, 0.22, uniform, LIMB);
    right.rotation.x = 0.14;
    // A bundle on the back: bulk along the body axis, never across it, and
    // cool, because cloth and grain are not a gun barrel.
    const bundle = box(g, 0, 1.34, -0.5, 0.78, 0.94, 0.56, 0x8a7f68, 0.34);
    bundle.rotation.x = 0.12;
    // A headload. From directly above this is the civilian's signature: a
    // broad flat cap wider than the shoulders, where a hostile has a helmet
    // narrower than them.
    box(g, 0, 2.56, 0, 1.12, 0.34, 0.86, 0x93876d, 0.3);
    box(g, 0, 2.78, 0, 0.72, 0.24, 0.56, 0x8d8064, 0.26);
    return;
  }

  // Armed figures: arms come up and forward into a firing posture, and the
  // weapon projects a long horizontal bar clear of the body outline.
  const left = limb(g, -0.53, 1.36, 0.1, 0.23, 0.82, 0.22, uniform, LIMB);
  left.rotation.x = -0.85;
  const right = limb(g, 0.53, 1.36, 0.1, 0.23, 0.82, 0.22, uniform, LIMB);
  right.rotation.x = -0.72;
  // Helmet and webbing: hard, squared-off shoulders instead of a soft outline.
  cyl(g, 0, 2.28, 0, 0.34, 0.22, uniform, 8, 0.42);
  box(g, 0, 1.4, -0.32, 0.66, 0.72, 0.3, 0x3e493f, 0.5);

  if (kind === 'rpg') {
    // A launch tube over the shoulder. It is yawed across the body rather than
    // aimed straight down the figure's axis: pointed dead ahead it foreshortens
    // to almost nothing from the orbit, and the launcher ends up reading as a
    // lumpy civilian. Yawed, it throws a long bar clear of the outline on both
    // ends from any direction the aircraft happens to be on.
    const tube = cyl(g, -0.12, 1.9, 0.0, 0.18, 2.9, DARK, 8, 0.66);
    tube.rotation.x = Math.PI / 2;
    tube.rotation.z = 0.16;
    tube.rotation.y = 0.62;
    // Warhead at the front, backblast cone at the rear: both widen the ends.
    box(g, 0.62, 2.02, 1.02, 0.34, 0.34, 0.52, DARK, 0.6);
    box(g, -0.86, 1.78, -1.02, 0.3, 0.3, 0.42, DARK, 0.5);
    box(g, -0.1, 1.5, 0.3, 0.2, 0.46, 0.24, DARK, 0.55);
  } else if (kind === 'mg') {
    // A belt-fed gun on a bipod: the widest weapon silhouette of the three.
    box(g, 0.3, 1.22, 1.0, 0.28, 0.3, 2.3, DARK, 0.6);
    box(g, 0.3, 0.6, 1.8, 0.14, 1.24, 0.14, DARK, 0.35);
    box(g, 0.3, 1.34, 0.3, 0.44, 0.36, 0.56, 0x3b463c, 0.5);
  } else if (kind !== 'operator') {
    // A rifle held across the body. Long, thin, horizontal and warm from
    // firing: the one shape in this game that means "armed".
    const gun = box(g, 0.2, 1.36, 0.78, 0.22, 0.24, 2.0, DARK, 0.58);
    gun.rotation.y = 0.22;
    box(g, -0.1, 1.3, -0.1, 0.2, 0.3, 0.5, DARK, 0.45);
  } else {
    // The ground team carries a carbine plus a radio antenna.
    box(g, 0.29, 1.4, 0.66, 0.17, 0.19, 1.34, DARK, 0.4);
    const antenna = box(g, -0.32, 2.2, -0.34, 0.06, 1.5, 0.06, 0x2c3630, 0.25);
    antenna.rotation.x = -0.16;

    // Thermal identification panels, worn across the shoulders and on top of
    // the helmet. These are real kit and they work by being *cold*: a panel
    // that does not radiate reads as a dark bar lying on a white-hot body, and
    // nothing else on this battlefield looks remotely like that.
    //
    // It is the continuous half of the identification-friend-or-foe system.
    // The strobe blinks, so between flashes it tells you nothing; the panels
    // are always there. Together they mean a friendly is never mistakable.
    // And, as with the strobe, the information only ever runs one way — it
    // says "this one is ours", never "that one is not a civilian".
    box(g, 0, 1.97, -0.04, 1.18, 0.2, 0.54, PANEL, PANEL_HEAT);
    box(g, 0, 2.46, 0, 0.62, 0.13, 0.62, PANEL, PANEL_HEAT);
    // A third down the back, so the marking survives being seen from behind.
    box(g, 0, 1.42, -0.38, 0.58, 0.66, 0.16, PANEL, PANEL_HEAT);
  }
}

export function createModel(name: ModelName): T.Group {
  const g = new T.Group();
  g.name = name;

  if (name === 'house' || name === 'building') {
    // Standard footprint 12 x 10 m, main roof at 6.8 m. Gameplay rescales it.
    //
    // Masonry carries a little heat. That is real — stone gives back the day's
    // warmth for hours after dark — and it is also what keeps buildings from
    // sinking into the ground now that cold things all sit in one narrow band.
    // A chokepoint whose objective is "watch the rooftops" needs visible
    // rooftops.
    box(g, 0, 3.4, 0, 12, 6.8, 10, STONE, MASONRY);
    box(g, 0, 6.8, 0, 12.6, 0.45, 10.6, ROOF, ROOF_HEAT);
    for (const x of [-6, 6]) box(g, x, 7.2, 0, 0.35, 0.8, 10.4, 0x919080);
    for (const z of [-5, 5]) box(g, 0, 7.2, z, 12, 0.8, 0.35, 0x919080);
    box(g, -3, 7.5, -2, 2.7, 1.1, 2.4, 0x626659);
    cyl(g, 3, 8, -2, 1.2, 2, 0x444d49, 10);
    box(g, 0, 1.7, 5.06, 1.6, 3.4, 0.12, DARK);
    // Windows hold a trace of heat so occupied buildings are not dead black.
    for (const x of [-3.8, 3.8]) for (const z of [-5.03, 5.03]) box(g, x, 3.6, z, 1.5, 1.7, 0.09, 0xb9a478, 0.12);
    for (const z of [-2.5, 2.5]) box(g, 6.04, 3.6, z, 0.1, 1.5, 1.4, DARK);
  } else if (name === 'house2') {
    // Flat roof behind a parapet, with a stair head and water tanks. From
    // above this reads as a clean rectangle with small blocks on it, where
    // `house` reads as a ridged cap.
    box(g, 0, 3.5, 0, 12, 7, 10, 0x6f6c5f, MASONRY);
    box(g, 0, 7.05, 0, 12.4, 0.3, 10.4, 0x5a5d52, ROOF_HEAT);
    for (const x of [-6.1, 6.1]) box(g, x, 7.5, 0, 0.3, 0.9, 10.4, 0x8a8878);
    for (const z of [-5.1, 5.1]) box(g, 0, 7.5, z, 12.4, 0.9, 0.3, 0x8a8878);
    box(g, -3.4, 8.0, 2.4, 2.8, 2.0, 2.6, 0x6a685c);
    for (const x of [2.2, 4.4]) {
      const tank = cyl(g, x, 8.1, -2.6, 0.85, 1.6, 0x7d7a68, 10, 0.22);
      tank.rotation.z = 0;
    }
    box(g, 0, 1.8, 5.06, 1.8, 3.6, 0.12, DARK);
    for (const x of [-3.6, 0, 3.6]) for (const z of [-5.03, 5.03]) {
      box(g, x, 4.0, z, 1.4, 1.8, 0.09, 0xb9a478, 0.12);
    }
  } else if (name === 'house3') {
    // An L-shaped compound around a walled yard. The notch is the whole point:
    // it is the one footprint in the pack that is not a rectangle from above.
    box(g, -2.6, 3.1, 0, 6.8, 6.2, 10, STONE, MASONRY);
    box(g, -2.6, 6.35, 0, 7.2, 0.4, 10.4, ROOF, ROOF_HEAT);
    box(g, 3.2, 2.5, -3.0, 5.2, 5.0, 4, 0x716e60, MASONRY);
    box(g, 3.2, 5.15, -3.0, 5.6, 0.4, 4.4, ROOF, ROOF_HEAT);
    // Yard wall closing the open corner.
    box(g, 3.2, 1.1, 3.6, 5.4, 2.2, 0.5, 0x807c6b);
    box(g, 5.7, 1.1, 1.2, 0.5, 2.2, 5.4, 0x807c6b);
    cyl(g, -4.4, 7.2, -3.2, 0.9, 1.8, 0x444d49, 10);
    box(g, -2.6, 1.7, 5.06, 1.6, 3.4, 0.12, DARK);
    for (const z of [-3.2, 2.4]) box(g, -6.04, 3.4, z, 0.1, 1.6, 1.4, 0xb9a478, 0.12);
    // A cold water trough in the yard: a little interior detail at zoom.
    box(g, 2.4, 0.4, 1.6, 2.6, 0.8, 1.2, 0x6b6759, 0.08);
  } else if (name === 'wall') {
    box(g, 0, 1.2, 0, 10, 2.4, 0.8, STONE, MASONRY);
    for (let i = -4; i < 5; i += 2) box(g, i, 2.6, 0, 1, 0.5, 1, 0x8d8875);
  } else if (name === 'road') {
    box(g, 0, 0.01, 0, 10, 0.04, 30, 0x494d42);
  } else if (name === 'tree') {
    const trunk = cyl(g, 0, 3, 0, 0.38, 6, 0x514c3c, 6);
    trunk.rotation.z = 0.12;
    for (let i = 0; i < 7; i++) {
      const leaf = box(g, Math.sin(i * 0.9) * 1.7, 6.2, Math.cos(i * 0.9) * 1.7, 0.8, 0.2, 5, 0x485644);
      leaf.rotation.y = i * 0.9;
      leaf.rotation.x = 0.25;
    }
  } else if (name === 'rock') {
    const m = new T.Mesh(new T.DodecahedronGeometry(1.4, 0), mat(0x5e5c52));
    m.scale.set(1.2, 0.6, 1);
    m.position.y = 0.45;
    g.add(m);
  } else if (name === 'market') {
    for (const x of [-2.5, 2.5]) for (const z of [-1.6, 1.6]) box(g, x, 1.8, z, 0.15, 3.6, 0.15, 0x695842);
    box(g, 0, 1, 0, 4.8, 1.8, 2.8, 0x746349);
    for (let i = 0; i < 6; i++) box(g, -2.1 + i * 0.83, 3.7, 0, 0.84, 0.15, 3.8, i % 2 ? 0x8c8671 : 0x55665e);
    for (let i = 0; i < 5; i++) box(g, -1.8 + i * 0.85, 2, 0, 0.6, 0.4, 0.8, 0x9a8057);
  } else if (name === 'cart') {
    // A handcart travelling with the column. Reads as a long low box beside a
    // civilian, never as a weapon: it is wide, not thin, and it is cold.
    box(g, 0, 0.9, 0, 1.7, 0.6, 2.6, 0x6d6350, 0.12);
    box(g, 0, 1.3, -1.0, 1.6, 0.7, 0.5, 0x7b6f57, 0.2);
    for (const x of [-0.92, 0.92]) {
      const wheel = cyl(g, x, 0.55, 0.3, 0.55, 0.16, 0x3b3830, 10, 0.08);
      wheel.rotation.z = Math.PI / 2;
    }
    box(g, 0, 1.05, 1.5, 0.12, 0.12, 1.2, 0x5c5344, 0.1);
  } else if (name === 'civilian' || name === 'civilian2' || name === 'child'
    || name === 'operator' || name === 'rifle' || name === 'mg' || name === 'rpg') {
    figure(g, name);
  } else if (name === 'mortar') {
    const crew = createModel('rifle');
    crew.position.x = 1.2;
    g.add(crew);
    cyl(g, 0, 0.12, 0, 0.85, 0.22, 0x39443d, 8, 0.4);
    const barrel = cyl(g, 0, 1.05, 0, 0.2, 2.1, 0x454f44, 8, 0.72);
    barrel.rotation.z = 0.28;
    box(g, -0.45, 0.6, 0, 0.1, 1.1, 0.1, 0x39443d, 0.3);
    box(g, 0.5, 0.35, -0.9, 0.9, 0.5, 0.6, 0x4a5347, 0.2);
  } else if (name === 'technical' || name === 'transport' || name === 'assault' || name === 'wreck') {
    const transport = name === 'transport', armored = name === 'assault', wreck = name === 'wreck';
    const len = transport ? 7 : 6;
    const color = wreck ? 0x282925 : armored ? 0x686951 : 0x646d56;
    box(g, 0, 1.1, 0, 2.9, 0.55, len, color, 0.6);
    box(g, 0, 1.9, 1.7, 2.7, 1.35, 2, color, 0.5);
    box(g, 0, 2.2, 2.73, 2.2, 0.7, 0.05, 0x293632, 0.1);
    box(g, 0, 1.6, -1.2, 2.8, 0.6, 3.2, color, 0.4);
    if (transport) box(g, 0, 2.55, -1.1, 2.7, 1.5, 3.9, 0x776f54, 0.3);
    if (armored) box(g, 0, 2.55, -1, 2.6, 1.2, 2.5, color, 0.4);
    if (!transport && !wreck) {
      cyl(g, 0, 2.6, -1, 0.6, 0.5, color, 8, 0.4);
      box(g, 0, 2.95, 0.1, 0.25, 0.25, 2.4, DARK, 0.8);
    }
    for (const x of [-1.55, 1.55]) for (const z of [-2.1, 2.1]) {
      const wheel = cyl(g, x, 0.7, z, 0.66, 0.4, 0x202821, 10, 0.2);
      wheel.rotation.z = Math.PI / 2;
    }
    if (wreck) {
      g.rotation.z = 0.09;
      box(g, 1, 1.5, 0, 0.6, 0.2, 4, 0x191e1b);
    }
  } else if (name === 'fence') {
    // An 8 m run of corrugated sheet on posts. The ribs matter: under a low
    // sun they throw a fine comb of shadow, which is most of what makes the
    // reference frame's fences read as metal rather than as a grey wall.
    const sheet = 0x5f6156;
    box(g, 0, 1.15, 0, 8, 2.3, 0.05, sheet, METAL_HEAT);
    // §25: boards of uneven height and shade, so the top edge is ragged as in
    // the reference wall, instead of one clean sheet line.
    const planks = new Rng(6113);
    for (let x = -3.9; x <= 3.95; x += 0.36) {
      const h = planks.range(2.25, 2.85);
      box(g, x, h / 2, 0.05, 0.3, h, 0.06, planks.pick([0x6b6d61, 0x75766a, 0x5d5f55, 0x808174]), METAL_HEAT);
    }
    for (const x of [-4, 0, 4]) box(g, x, 1.3, -0.12, 0.14, 2.6, 0.14, 0x4f4b40, WOOD_HEAT);
    // A rail top and bottom, and one sheet hanging loose at the end.
    box(g, 0, 2.1, -0.1, 8, 0.1, 0.1, 0x4f4b40, WOOD_HEAT);
    box(g, 0, 0.3, -0.1, 8, 0.1, 0.1, 0x4f4b40, WOOD_HEAT);
    const loose = box(g, 3.4, 1.0, 0.25, 1.4, 2.0, 0.05, sheet, METAL_HEAT);
    loose.rotation.z = 0.32;
    loose.rotation.y = 0.25;
  } else if (name === 'pickup' || name === 'sedan') {
    // Burnt-out civilian vehicles. Cold: they died a long time ago. One side
    // sits on its rims, so they never read as a live vehicle on the move.
    const pickup = name === 'pickup';
    const body = pickup ? 0x55574d : 0x4c4e46;
    const len = pickup ? 5.4 : 4.6;
    box(g, 0, 0.75, 0, 2.0, 0.7, len, body, METAL_HEAT);
    if (pickup) {
      box(g, 0, 1.45, 1.0, 1.9, 0.9, 1.6, body, METAL_HEAT);
      box(g, 0, 1.95, 1.0, 1.7, 0.08, 1.4, 0x3d3f38, METAL_HEAT);
      // Open bed with sides, and junk in it.
      for (const x of [-0.95, 0.95]) box(g, x, 1.3, -1.2, 0.08, 0.5, 2.8, body, METAL_HEAT);
      box(g, 0, 1.3, -2.6, 2.0, 0.5, 0.08, body, METAL_HEAT);
      box(g, 0.3, 1.25, -1.4, 0.8, 0.4, 0.9, 0x6a6352, WOOD_HEAT);
    } else {
      // Crushed cabin: the roof is pushed in and off-centre.
      const cabin = box(g, 0.1, 1.35, -0.1, 1.8, 0.6, 2.2, body, METAL_HEAT);
      cabin.rotation.z = 0.08;
      box(g, 0, 1.0, 1.6, 1.9, 0.12, 1.3, 0x3f413a, METAL_HEAT);
    }
    for (const [x, z, flat] of [[-1.0, 1.5, 0], [1.0, 1.5, 1], [-1.0, -1.5, 0], [1.0, -1.5, 1]] as const) {
      if (flat) continue;
      const wheel = cyl(g, x, 0.42, z * len / 4.6, 0.42, 0.3, 0x24261f, 10, METAL_HEAT);
      wheel.rotation.z = Math.PI / 2;
    }
    g.rotation.z = 0.07;
  } else if (name === 'junk') {
    // A scrap heap: sheets, planks, a tyre stack and a drum or two. Seeded,
    // so the exported GLB is identical on every run.
    const rng = new Rng(4417);
    for (let i = 0; i < 16; i++) {
      const w = rng.range(0.5, 2.2), d = rng.range(0.4, 1.8);
      const piece = box(g, rng.spread(1.8), rng.range(0.1, 0.7), rng.spread(1.6),
        w, rng.range(0.06, 0.5), d, rng.pick([0x5c5e53, 0x6c6555, 0x4e5048, 0x766e5c]),
        rng.next() < 0.5 ? METAL_HEAT : WOOD_HEAT);
      piece.rotation.set(rng.spread(0.5), rng.range(0, 3), rng.spread(0.5));
    }
    for (let i = 0; i < 3; i++) {
      const tyre = new T.Mesh(new T.TorusGeometry(0.42, 0.16, 6, 12), mat(0x2a2b26, METAL_HEAT));
      tyre.rotation.x = Math.PI / 2;
      tyre.position.set(1.6, 0.16 + i * 0.3, -1.2);
      g.add(tyre);
    }
    cyl(g, -1.6, 0.5, 1.0, 0.32, 1.0, 0x50534a, 10, METAL_HEAT);
  } else if (name === 'drums') {
    // A cluster of oil drums, one on its side.
    for (const [x, z] of [[0, 0], [0.7, 0.15], [0.3, 0.72]] as const) cyl(g, x, 0.5, z, 0.32, 1.0, 0x575a50, 10, METAL_HEAT);
    const fallen = cyl(g, -0.9, 0.32, 0.4, 0.32, 1.0, 0x575a50, 10, METAL_HEAT);
    fallen.rotation.z = Math.PI / 2;
    fallen.rotation.y = 0.6;
  } else if (name === 'trailer') {
    // An abandoned caravan, the big pale box in the reference frame.
    box(g, 0, 1.75, 0, 2.6, 2.3, 7.2, 0x7a7867, METAL_HEAT);
    box(g, 0, 2.95, 0, 2.4, 0.15, 6.9, 0x6b695b, METAL_HEAT);
    for (const z of [-2.2, 0.2, 2.4]) for (const x of [-1.31, 1.31]) box(g, x, 2.1, z, 0.04, 0.6, 1.1, 0x2e302b, METAL_HEAT);
    box(g, 1.31, 1.4, -0.9, 0.04, 1.9, 0.8, 0x3a3c35, METAL_HEAT);
    // Hitch, propped on a block, and the axle with its wheels gone.
    box(g, 0, 0.6, 4.1, 0.18, 0.18, 1.4, 0x3f413a, METAL_HEAT);
    box(g, 0, 0.3, 4.6, 0.5, 0.6, 0.5, 0x6b6759, WOOD_HEAT);
    box(g, 0, 0.45, -0.6, 2.4, 0.2, 0.2, 0x2f312b, METAL_HEAT);
    g.rotation.x = -0.03;
  } else if (name === 'deadtree') {
    // Bare and branching. From altitude a dead tree is all shadow: a spray of
    // dark lines across the ground, which is what the reference frame shows.
    const rng = new Rng(2207);
    const bark = 0x4c463a;
    const grow = (x: number, y: number, z: number, len: number, r: number, yaw: number, pitch: number, depth: number) => {
      const dir = new T.Vector3(Math.sin(pitch) * Math.cos(yaw), Math.cos(pitch), Math.sin(pitch) * Math.sin(yaw));
      const end = new T.Vector3(x, y, z).addScaledVector(dir, len);
      const limb = new T.Mesh(new T.CylinderGeometry(r * 0.65, r, len, 5), mat(bark, WOOD_HEAT));
      limb.position.set((x + end.x) / 2, (y + end.y) / 2, (z + end.z) / 2);
      limb.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir);
      g.add(limb);
      if (depth === 0) return;
      const n = depth > 1 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        grow(end.x, end.y, end.z, len * rng.range(0.55, 0.75), r * 0.6,
          yaw + rng.spread(1.6) + i * 2.1, Math.min(1.25, pitch + rng.range(0.25, 0.6)), depth - 1);
      }
    };
    grow(0, 0, 0, 3.6, 0.34, 0.4, 0.12, 3);
  } else if (name === 'grass') {
    // A tuft of dry grass: thin upright blades fanning out. Instanced by the
    // thousand, so it is kept to a handful of triangles.
    const rng = new Rng(907);
    // §25: taller and fuller — the reference yards are thick with dry tufts.
    for (let i = 0; i < 7; i++) {
      const tall = rng.range(0.9, 1.7);
      const blade = new T.Mesh(new T.ConeGeometry(0.11, tall, 3, 1, true), mat(rng.pick([0x6a6d58, 0x7d7f68, 0x5c5f4c]), PLANT_HEAT));
      const a = i / 7 * Math.PI * 2;
      blade.position.set(Math.cos(a) * 0.16, tall * 0.42, Math.sin(a) * 0.16);
      blade.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
      g.add(blade);
    }
  } else if (name === 'scrub') {
    // Low thornbush: a flattened knot, darker than the grass.
    const rng = new Rng(311);
    for (let i = 0; i < 4; i++) {
      const knot = new T.Mesh(new T.DodecahedronGeometry(rng.range(0.4, 0.7), 0), mat(0x4d5244, PLANT_HEAT));
      knot.position.set(rng.spread(0.5), 0.3, rng.spread(0.5));
      knot.scale.y = 0.6;
      g.add(knot);
    }
  } else if (name === 'lzpad') {
    // The landing zone marker: a cold ring with four hot strobes at the corners.
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * Math.PI * 2;
      box(g, Math.cos(a) * 15, 0.06, Math.sin(a) * 15, 1.6, 0.1, 1.6, 0x8d8b70, 0.15);
    }
    for (const [x, z] of [[-11, -11], [11, -11], [-11, 11], [11, 11]]) {
      box(g, x, 0.3, z, 0.7, 0.6, 0.7, 0xd8d6a8, 0.95);
    }
    box(g, 0, 0.07, 0, 3, 0.1, 14, 0xa9a688, 0.2);
    box(g, 0, 0.07, 0, 14, 0.1, 3, 0xa9a688, 0.2);
  } else if (name === 'helo') {
    // The extraction helicopter. Hot engines, long tail, wide rotor disc.
    const body = new T.Mesh(new T.CapsuleGeometry(1.5, 4.2, 4, 10), mat(0x4f5c56, 0.3));
    body.rotation.x = Math.PI / 2;
    body.position.set(0, 2.6, 0.4);
    g.add(body);
    box(g, 0, 2.9, -5.6, 0.7, 0.7, 6.4, 0x4b5852, 0.28);
    box(g, 0, 4.1, -8.4, 0.3, 2.2, 1.5, 0x4b5852, 0.25);
    // Engine deck, the hottest part of the airframe.
    box(g, 0, 4.1, 0.2, 2.1, 0.9, 2.6, 0x5d6a62, 0.78);
    for (const x of [-1.4, 1.4]) {
      const skid = box(g, x, 0.35, 0.4, 0.16, 0.16, 5.4, 0x3a453f, 0.15);
      box(g, x, 1.1, 1.6, 0.14, 1.4, 0.14, 0x3a453f, 0.12);
      box(g, x, 1.1, -1.4, 0.14, 1.4, 0.14, 0x3a453f, 0.12);
      skid.rotation.x = 0;
    }
    const mast = cyl(g, 0, 4.9, 0.2, 0.22, 0.9, 0x39443e, 8, 0.5);
    mast.name = 'mast';
    const rotor = new T.Group();
    rotor.name = 'rotor';
    rotor.position.set(0, 5.3, 0.2);
    for (let i = 0; i < 4; i++) {
      const blade = box(rotor, 0, 0, 0, 15.5, 0.12, 0.62, 0x2f3a34, 0.2);
      blade.rotation.y = i * Math.PI / 4;
    }
    g.add(rotor);
    const tailRotor = new T.Group();
    tailRotor.name = 'tailRotor';
    tailRotor.position.set(0.35, 4.1, -8.4);
    for (let i = 0; i < 2; i++) {
      const blade = box(tailRotor, 0, 0, 0, 0.1, 3.4, 0.34, 0x2f3a34, 0.2);
      blade.rotation.x = i * Math.PI / 2;
    }
    g.add(tailRotor);
  } else if (name === 'gunship') {
    const fuselage = new T.Mesh(new T.CylinderGeometry(1.8, 1.4, 22, 12), mat(0x55635f));
    fuselage.rotation.x = Math.PI / 2;
    fuselage.position.y = 1;
    g.add(fuselage);
    const nose = new T.Mesh(new T.SphereGeometry(1.75, 12, 8), mat(0x62736d));
    nose.position.set(0, 1, 11);
    nose.scale.z = 1.6;
    g.add(nose);
    box(g, 0, 1.6, 1, 31, 0.42, 4, 0x56655f);
    box(g, 0, 2, -8.5, 12, 0.35, 2.3, 0x56655f);
    box(g, 0, 4, -9, 0.4, 5, 3, 0x53665d);
    for (const x of [-11, -6, 6, 11]) {
      const engine = cyl(g, x, 1, 1.5, 0.7, 4, 0x3f4f48, 10, 0.55);
      engine.rotation.x = Math.PI / 2;
      box(g, x, 1, 3.7, 0.16, 4, 0.15, 0x293833);
      box(g, x, 1, 3.7, 4, 0.16, 0.15, 0x293833);
    }
    for (const z of [-1, -4, -6]) {
      const gun = box(g, -2.6, 0.3, z, 3, 0.3, 0.3, 0x293d33);
      gun.rotation.y = -0.1;
    }
  }
  return g;
}
