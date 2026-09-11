import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createModel, MODEL_NAMES, type ModelName} from './ModelFactory';

/**
 * The one place the runtime looks up a model. Swapping visuals means replacing
 * `public/models/<name>.glb` and nothing else: AI, collision, damage, mission
 * logic and scoring never touch this file. If a GLB fails to load, the matching
 * procedural mesh stands in, so a missing asset degrades the look and never
 * breaks the game.
 */
export class AssetLibrary {
  models = new Map<ModelName, T.Group>();
  /** Names that fell back to procedural geometry, surfaced by the debug hooks. */
  fallbacks: ModelName[] = [];

  async load() {
    const loader = new GLTFLoader();
    await Promise.all(MODEL_NAMES.map(async name => {
      try {
        const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${name}.glb`);
        gltf.scene.traverse(o => {
          if (!(o instanceof T.Mesh)) return;
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            if (!(m instanceof T.MeshStandardMaterial)) continue;
            if (m.userData.heat !== undefined) continue;
            // Fallback path: a `_heat_0.90` suffix on the material name.
            const tagged = m.name.match(/_heat_([0-9.]+)/);
            m.userData.heat = tagged ? Number(tagged[1]) : 0;
            if (m.userData.optical === undefined) m.userData.optical = m.color.getHex();
          }
        });
        this.models.set(name, gltf.scene);
      } catch {
        this.fallbacks.push(name);
        this.models.set(name, createModel(name));
      }
    }));
  }

  get(name: ModelName) {
    return (this.models.get(name) ?? createModel(name)).clone(true);
  }
}
