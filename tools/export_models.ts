/**
 * Tier 1 asset pipeline: the pack that ships.
 *
 * The models are generated with Three.js, not Blender. The reference build's
 * README is explicit that its Blender script never executed and that its
 * shipped pack was procedural, so the look being carried over here *is*
 * procedural geometry. That is a feature: it reproduces with no Blender
 * dependency at all, and Blender (tools/blender_assets.py) becomes an optional
 * upgrade rather than a prerequisite.
 *
 * Geometry is merged by material before export, so each model is one draw call
 * per material. The files are small and untextured: no compression decoder, no
 * downloaded textures, no content delivery network.
 *
 *   npm run assets
 */
import * as T from 'three';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {createModel, MODEL_NAMES} from '../src/assets/ModelFactory';
import {mkdir, writeFile} from 'node:fs/promises';

/** The exporter reaches for FileReader, which Node does not provide. */
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob) {
    blob.arrayBuffer().then(a => {this.result = a; this.onloadend?.();});
  }
  readAsDataURL(blob: Blob) {
    blob.arrayBuffer().then(a => {
      this.result = `data:${blob.type};base64,${Buffer.from(a).toString('base64')}`;
      this.onloadend?.();
    });
  }
}
Object.assign(globalThis, {FileReader: NodeFileReader});

await mkdir('public/models', {recursive: true});

for (const name of MODEL_NAMES) {
  const source = createModel(name);
  source.updateMatrixWorld(true);

  // Bucket every mesh by material, bake its world transform into the geometry,
  // and merge. Material extras (optical, heat) ride along on the material.
  const buckets = new Map<T.Material, T.BufferGeometry[]>();
  source.traverse(o => {
    if (!(o instanceof T.Mesh)) return;
    const m = o.material as T.Material;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (!g.index) g.setIndex(Array.from({length: g.attributes.position.count}, (_, i) => i));
    const list = buckets.get(m) ?? [];
    list.push(g);
    buckets.set(m, list);
  });

  const group = new T.Group();
  group.name = name;
  for (const [material, geometries] of buckets) {
    const merged = mergeGeometries(geometries, false);
    if (!merged) continue;
    // glTF drops unknown material fields, so the sensor extras are carried in
    // the material name as well. AssetLibrary reads either.
    const out = (material as T.MeshStandardMaterial).clone();
    const heat = Number(material.userData?.heat ?? 0);
    out.name = `${material.name || 'mat'}_heat_${heat.toFixed(2)}`;
    out.userData = {...material.userData};
    group.add(new T.Mesh(merged, out));
  }

  const glb = await new GLTFExporter().parseAsync(group, {binary: true});
  await writeFile(`public/models/${name}.glb`, Buffer.from(glb as ArrayBuffer));
}

await writeFile('public/models/manifest.json', JSON.stringify({
  generator: 'Three.js procedural pack (tier 1)',
  scale: '1 unit = 1 metre',
  origin: 'ground centre',
  forward: '+Z, Y up',
  extras: {optical: 'integer sRGB hex', heat: '0-1 thermal signature'},
  note: 'Replace any file here to change visuals. Gameplay, damage and scoring are untouched by asset swaps.',
  models: MODEL_NAMES,
}, null, 2));

console.log(`Exported ${MODEL_NAMES.length} merged GLB models to public/models/.`);
