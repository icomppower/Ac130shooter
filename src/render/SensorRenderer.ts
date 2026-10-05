import * as T from 'three';

export const POLARITY = ['WHITE HOT', 'BLACK HOT'] as const;

/**
 * Objects on this layer are bloom sources (§24): fire, flashes, tracers. Only
 * these are rendered into the glow buffer, so bodies — which are just as
 * bright — never bloom, and a figure's outline is never smeared into a blob.
 * Bloom that keyed off brightness alone would undo the silhouette gate.
 */
export const BLOOM_LAYER = 1;

/**
 * The gun-camera tape layer. Everything the player sees passes through here.
 *
 * There is no night-vision mode and no optical mode: this is a thermal sensor
 * and nothing else. Polarity is a post-process inversion, exactly as a real
 * white-hot/black-hot switch behaves, so the scene itself is rendered once and
 * the toggle costs nothing.
 *
 * §24 moved the look from flat to hard-lit. The contrast comes from the
 * lighting (low sun, thin ambient), not from a curve here — an S-curve was
 * tried and crushed the cold band into black. What this layer adds is
 * selective bloom on hot effects only. The tape layer — interlace, grain,
 * tearing, telemetry — stays on top of all of it.
 */
export class SensorRenderer {
  blackHot = false;
  target: T.WebGLRenderTarget;
  private scene = new T.Scene();
  private quadCamera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  material: T.ShaderMaterial;
  /** Decaying full-frame luminance spike, driven by heavy impacts. */
  flash = 0;
  /** Decaying horizontal tear, driven by hard camera movement. */
  tear = 0;
  /** Bloom strength. Zero turns the pass off entirely (the gate's A/B). */
  bloom = 1;
  private glow: T.WebGLRenderTarget;
  private blurA: T.WebGLRenderTarget;
  private blurB: T.WebGLRenderTarget;
  private blurMaterial: T.ShaderMaterial;
  private blurScene = new T.Scene();

  constructor(public renderer: T.WebGLRenderer) {
    // Plain 8-bit: the shader output is low dynamic range anyway, and a byte
    // target can be read back directly, which is what the kill gate measures.
    this.target = new T.WebGLRenderTarget(1, 1);
    this.glow = new T.WebGLRenderTarget(1, 1);
    this.blurA = new T.WebGLRenderTarget(1, 1);
    this.blurB = new T.WebGLRenderTarget(1, 1);
    this.blurMaterial = new T.ShaderMaterial({
      uniforms: {image: {value: null}, step: {value: new T.Vector2()}},
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      // Nine-tap separable gaussian. Run twice at quarter resolution, that is a
      // wide soft halo for the cost of four tiny passes.
      fragmentShader: `
precision highp float;
uniform sampler2D image; uniform vec2 step; varying vec2 vUv;
void main(){
  vec3 c = texture2D(image, vUv).rgb * 0.2270;
  c += texture2D(image, vUv + step * 1.3846).rgb * 0.3162;
  c += texture2D(image, vUv - step * 1.3846).rgb * 0.3162;
  c += texture2D(image, vUv + step * 3.2308).rgb * 0.0703;
  c += texture2D(image, vUv - step * 3.2308).rgb * 0.0703;
  gl_FragColor = vec4(c, 1.0);
}`,
    });
    this.blurScene.add(new T.Mesh(new T.PlaneGeometry(2, 2), this.blurMaterial));
    this.material = new T.ShaderMaterial({
      uniforms: {
        image: {value: this.target.texture},
        glow: {value: this.blurB.texture},
        glowGain: {value: 1},
        time: {value: 0},
        blackHot: {value: 0},
        flash: {value: 0},
        tear: {value: 0},
        // Scales grain, fixed-pattern noise and interlace together. The
        // identification probe sets it to zero so a silhouette comparison
        // measures shape rather than sensor grain.
        noiseScale: {value: 1},
        resolution: {value: new T.Vector2(1, 1)},
      },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader: `
precision highp float;
uniform sampler2D image, glow;
uniform float time, blackHot, flash, tear, noiseScale, glowGain;
uniform vec2 resolution;
varying vec2 vUv;

float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}

void main(){
  vec2 uv = vUv;

  // Horizontal tearing: whole scanlines slip sideways while the camera is
  // being slewed hard. Bands, not per-pixel noise, or it reads as static.
  if (tear > 0.001) {
    float band = floor(uv.y * 84.0);
    float slip = (hash(vec2(band, floor(time * 26.0))) - 0.5);
    slip *= step(0.72, hash(vec2(band * 1.7, floor(time * 26.0) + 3.0)));
    uv.x += slip * tear * 0.045;
  }

  float l = dot(texture2D(image, uv).rgb, vec3(0.299, 0.587, 0.114));
  // Sensor response: slightly compressed highlights, lifted black floor.
  l = pow(clamp(l, 0.0, 1.4), 1.06);
  // Selective bloom: halo from fire and flashes only. Added before polarity,
  // so in black-hot a fireball blooms dark, as an inverted sensor would.
  l += dot(texture2D(glow, vUv).rgb, vec3(0.333)) * glowGain;
  l = mix(l, 1.0 - l, blackHot);

  // Fixed-pattern sensor noise plus a per-frame grain.
  float grain = (hash(uv * resolution + fract(time) * 823.0) - 0.5) * 0.040;
  float fixedPattern = (hash(floor(uv * resolution * 0.5)) - 0.5) * 0.012;
  // Interlace: every other line sits a touch darker, as a tape would.
  float scan = (mod(floor(uv.y * resolution.y), 2.0) < 1.0 ? -0.022 : 0.0)
             + sin(uv.y * resolution.y * 3.14159) * 0.010;
  float vignette = 1.0 - 0.22 * pow(length(uv - 0.5) * 1.35, 2.0);

  float c = (l + (grain + fixedPattern + scan) * noiseScale) * vignette;
  // Heavy-round flash. Blows the whole frame out for a few dozen milliseconds.
  c = mix(c, blackHot > 0.5 ? 0.0 : 1.0, clamp(flash, 0.0, 0.92));

  // A faint green-grey cast: a phosphor monitor filmed off the glass, not a
  // clean digital frame.
  gl_FragColor = vec4(vec3(c) * vec3(0.94, 1.0, 0.96), 1.0);
}`,
    });
    this.scene.add(new T.Mesh(new T.PlaneGeometry(2, 2), this.material));
  }

  resize(w: number, h: number) {
    this.target.setSize(w, h);
    this.glow.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.blurA.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.blurB.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.material.uniforms.resolution.value.set(w, h);
  }

  /**
   * Push every material into thermal response. Heat, not albedo, decides how
   * bright a surface is; the optical colour only survives as a faint texture in
   * the cold parts of the image. Run this whenever meshes are added.
   */
  apply(scene: T.Object3D) {
    scene.traverse(o => {
      if (!(o instanceof T.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!(m instanceof T.MeshStandardMaterial)) continue;
        if (m.userData.optical === undefined) m.userData.optical = m.color.getHex();
        const heat: number = m.userData.heat ?? 0;
        const optical = new T.Color(m.userData.optical);
        const albedo = optical.r * 0.3 + optical.g * 0.5 + optical.b * 0.2;
        // Cold surfaces keep a little of their own tone so terrain still has
        // structure; hot surfaces converge on the top of the range.
        //
        // Two failures shaped these numbers, in opposite directions. Too low a
        // floor and the whole battlefield renders at 7% luminance and the
        // shadows have nothing to darken. Too much albedo contribution and
        // cold clutter climbs into the same brightness band as people — with
        // a 0.55 albedo term a pale rock rendered at 0.57 against a body at
        // 0.97, and a battlefield of seven hostiles read as a field of pebbles
        // because nothing separated a person from a stone.
        //
        // So: a modest floor that keeps terrain lit, and a *small* albedo term
        // so every cold thing clusters tightly just above it whatever colour
        // it happens to be. Heat, not albedo, is what makes something bright.
        // That is also simply what a thermal image looks like — a dull, even
        // ground with living things burning out of it.
        //
        // §24 adds one per-material knob, `coldGain`. The reference frame is a
        // pale ground with black shadows cut into it; a shadow can only read
        // that strongly when the surface it falls on is bright. So the ground
        // and the track are lifted; clutter is pushed one step *below* the
        // plain band (Terrain's CLUTTER_COLD_GAIN), and G14 checks it stays
        // there.
        const coldGain: number = m.userData.coldGain ?? 1;
        const cold = (albedo * 0.20 + 0.30) * coldGain;
        const warm = Math.pow(heat, 0.7);
        m.color.setScalar(cold * (1 - warm) + 0.97 * warm);
        // Hot things emit rather than merely being pale, so a body is bright
        // on its own account instead of depending on how the sun happens to
        // catch it. This is what actually makes a person findable: at the
        // default zoom a figure is only a few pixels wide, and a merely
        // light-grey one is averaged away against dark ground by antialiasing
        // before it ever reaches the eye. A self-lit one survives being small,
        // stays visible inside a shadow, and is what a thermal sensor shows
        // anyway — heat is the signal, not reflected light.
        m.emissive.setScalar(Math.pow(warm, 1.4) * 0.95);
        m.roughness = 1;
        m.metalness = 0;
      }
    });
  }

  /** The blurred glow buffer as luminance, for the bloom gate. */
  readGlow() {
    const t = this.blurB, w = t.width, h = t.height;
    const buffer = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(t, 0, 0, w, h, buffer);
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = (buffer[i * 4] + buffer[i * 4 + 1] + buffer[i * 4 + 2]) / 765;
    return {width: w, height: h, lum};
  }

  /** Effects-only render into the glow buffer, then two blur passes. */
  private renderGlow(scene: T.Scene, camera: T.Camera) {
    const r = this.renderer;
    const background = scene.background, fog = scene.fog;
    const mask = camera.layers.mask;
    // The shadow map was already drawn by the main pass this frame. Without
    // this the effects-only pass would redraw it for nothing.
    const autoShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    scene.background = null;
    scene.fog = null;
    camera.layers.set(BLOOM_LAYER);
    r.setRenderTarget(this.glow);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(scene, camera);
    camera.layers.mask = mask;
    r.shadowMap.autoUpdate = autoShadow;
    scene.background = background;
    scene.fog = fog;
    const pass = (from: T.WebGLRenderTarget, to: T.WebGLRenderTarget, x: number, y: number) => {
      this.blurMaterial.uniforms.image.value = from.texture;
      this.blurMaterial.uniforms.step.value.set(x / to.width, y / to.height);
      r.setRenderTarget(to);
      r.render(this.blurScene, this.quadCamera);
    };
    pass(this.glow, this.blurA, 1, 0);
    pass(this.blurA, this.blurB, 0, 1);
    pass(this.blurB, this.blurA, 2, 0);
    pass(this.blurA, this.blurB, 0, 2);
  }

  update(dt: number) {
    this.flash = Math.max(0, this.flash - dt * 4.2);
    this.tear = Math.max(0, this.tear - dt * 3.0);
  }

  /** A heavy round just landed: blow the frame out. */
  strike(weight: number) {
    this.flash = Math.min(1, this.flash + weight);
    this.tear = Math.min(1, this.tear + weight * 0.7);
  }

  /**
   * Cost of the scene pass alone. `renderer.info` is overwritten by the
   * fullscreen post pass, so anything reading it afterwards sees one draw call
   * and two triangles and concludes the scene is free.
   */
  sceneCalls = 0;
  sceneTriangles = 0;

  render(scene: T.Scene, camera: T.Camera, time: number) {
    const u = this.material.uniforms;
    u.time.value = time;
    u.blackHot.value = this.blackHot ? 1 : 0;
    u.flash.value = this.flash;
    u.tear.value = this.tear;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.sceneCalls = this.renderer.info.render.calls;
    this.sceneTriangles = this.renderer.info.render.triangles;
    u.glowGain.value = this.bloom * 1.35;
    if (this.bloom > 0) this.renderGlow(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.quadCamera);
  }
}
