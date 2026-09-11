import * as T from 'three';
import {Sim} from '../sim/sim';
import {WEAPONS} from '../sim/weapons';
import {HELO_INBOUND, LZ} from '../sim/route';
import {distance, vehicle, type Difficulty, type Entity, type Mode} from '../sim/types';
import {AssetLibrary} from '../assets/AssetLibrary';
import type {ModelName} from '../assets/ModelFactory';
import {Terrain} from '../render/Terrain';
import {GunshipCamera, ALTITUDE, ZOOM_STEPS} from '../render/GunshipCamera';
import {SensorRenderer, POLARITY} from '../render/SensorRenderer';
import {Effects} from '../render/Effects';
import {ContactShadows} from '../render/ContactShadows';
import {AudioManager} from '../audio/AudioManager';
import {HUD} from '../ui/HUD';
import {DebugFlags, PROBE_FACING} from './debug';
import {autoGunner} from '../sim/autogunner';

/** Sim entity kind to model name. Civilians alternate with a handcart. */
const MODEL: Record<string, ModelName> = {
  rifle: 'rifle', mg: 'mg', rpg: 'rpg', mortar: 'mortar',
  technical: 'technical', transport: 'transport', assault: 'assault',
  operator: 'operator', civilian: 'civilian',
};

export class Game {
  scene = new T.Scene();
  renderer: T.WebGLRenderer;
  camera = new GunshipCamera();
  sensor: SensorRenderer;
  assets = new AssetLibrary();
  effects = new Effects();
  contacts = new ContactShadows();
  audio = new AudioManager();
  hud: HUD;
  sim = new Sim();
  terrain: Terrain | null = null;
  flags: DebugFlags;

  private sun = new T.DirectionalLight(0xdfe6cf, 3.0);
  private entities = new Map<number, T.Group>();
  private projectiles = new Map<number, T.Line>();
  private aircraft: T.Group | null = null;
  private helo: T.Group | null = null;
  private blastRing: T.LineLoop;

  firing = false;
  loaded = false;
  private lastMs = 0;
  private wallTime = 0;
  private lastHud = 0;
  private lastRadio = -1;
  private lastStatus = 'menu';
  private nextBurn = 0;
  private nextFirefight = 0;
  /** Rolling frame times in milliseconds, for the performance gate. */
  frameTimes: number[] = [];

  // Harness hooks. Inert unless a debug flag sets them.
  /** Run the scripted gunner every frame instead of the player. */
  autoGunner = false;
  /** Centre the orbit here instead of on the column. */
  followOverride: {x: number; z: number} | null = null;
  /** The lone figure placed by the identification probe. */
  probeEntityId = 0;
  probeModel: ModelName | null = null;

  constructor(root: HTMLElement) {
    this.flags = new DebugFlags(location.search + location.hash);

    this.renderer = new T.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.domElement.className = 'battlefield';
    root.appendChild(this.renderer.domElement);

    // Rendering fix 1: one directional shadow-casting light, low in the sky.
    // Without ground contact shadows every unit reads as a decal pasted onto
    // the terrain, which is the single thing this rebuild most exists to fix.
    // The mutation flag exists so the shadow gate can be shown to fail when
    // shadows are off — a gate that cannot fail is not a gate.
    this.renderer.shadowMap.enabled = !this.flags.mutate('noshadows');
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.sun.castShadow = this.renderer.shadowMap.enabled;
    this.sun.shadow.mapSize.set(2048, 2048);
    const shadowCam = this.sun.shadow.camera;
    // The shadow volume is kept tight on purpose. A 2048 map over a 480 m box
    // gives 23 cm texels, and a person is 80 cm wide — their shadow lands on
    // three texels and disappears into the bias. Over a 260 m box the texels
    // are 13 cm and the figure actually casts something. The volume rides with
    // the view, so the covered area is always the area being looked at.
    shadowCam.left = -130; shadowCam.right = 130;
    shadowCam.top = 130; shadowCam.bottom = -130;
    shadowCam.near = 1; shadowCam.far = 900;
    this.sun.shadow.bias = -0.0004;
    // Normal bias is in world units and pushes the sample along the surface
    // normal. Anything near the width of a person erases their shadow outright.
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun, this.sun.target);

    this.scene.background = new T.Color(0x12180f);
    this.scene.fog = new T.FogExp2(0x222c1e, 0.00058);
    // Sun-dominant, ambient thin. The balance is what makes a shadow read: an
    // earlier pass had the hemisphere light brighter than the sun, so a
    // shadowed patch of ground lost almost none of its illumination and the
    // shadow map may as well not have been there.
    this.scene.add(new T.HemisphereLight(0x9fb0a2, 0x3d4636, 1.1));
    this.scene.add(this.effects.group);
    this.scene.add(this.contacts.mesh);

    const ring = Array.from({length: 72}, (_, i) =>
      new T.Vector3(Math.cos(i / 72 * Math.PI * 2), 0.3, Math.sin(i / 72 * Math.PI * 2)));
    this.blastRing = new T.LineLoop(
      new T.BufferGeometry().setFromPoints(ring),
      new T.LineBasicMaterial({color: 0xe2dab1, transparent: true, opacity: 0.36, depthTest: false}));
    this.blastRing.renderOrder = 3;
    this.scene.add(this.blastRing);

    this.sensor = new SensorRenderer(this.renderer);

    this.hud = new HUD(root, {
      start: (m, d) => this.start(m, d),
      pause: () => this.pause(),
      resume: () => this.resume(),
      menu: () => this.menu(),
      weapon: n => {this.sim.weapons.selected = n;},
      polarity: () => {this.sensor.blackHot = !this.sensor.blackHot;},
      zoom: d => this.camera.setZoom(d),
      reload: () => this.sim.weapons.reload(),
      weaponsFree: () => this.spendWeaponsFree(),
      mute: () => {this.audio.init(); this.audio.setMute(); return this.audio.muted;},
      voice: () => {this.audio.init(); this.audio.voice = !this.audio.voice; return this.audio.voice;},
      // The real action runs first; unlocking audio afterwards can never swallow it.
      fire: v => {this.firing = v; this.audio.init();},
      hold: () => {this.camera.locked = !this.camera.locked;},
      target: () => this.nextTarget(),
      pan: (k, d) => {d ? this.camera.keys.add(k) : this.camera.keys.delete(k);},
    });

    this.bind();
    this.resize();
    this.init().catch(error => {
      console.error(error);
      this.hud.error('The sensor could not initialize. Reload and make sure WebGL is enabled.');
    });
  }

  private async init() {
    await this.assets.load();
    this.rebuild();
    this.aircraft = this.assets.get('gunship');
    this.aircraft.scale.setScalar(1.5);
    this.scene.add(this.aircraft);
    this.sensor.apply(this.scene);
    this.loaded = true;
    this.hud.ready();
    this.camera.anchor.set(this.sim.head.position.x, 0, this.sim.head.position.z);
    this.renderer.setAnimationLoop(ms => this.frame(ms));
    this.exposeDebug();
    this.flags.onReady(this);
  }

  rebuild() {
    if (this.terrain) this.scene.remove(this.terrain.group);
    for (const g of this.entities.values()) this.scene.remove(g);
    this.entities.clear();
    for (const line of this.projectiles.values()) {
      this.scene.remove(line);
      line.geometry.dispose();
      (line.material as T.Material).dispose();
    }
    this.projectiles.clear();
    if (this.helo) {this.scene.remove(this.helo); this.helo = null;}
    this.terrain = new Terrain(this.assets, this.sim.buildings);
    this.scene.add(this.terrain.group);
    this.effects.clear();
    this.syncEntities();
    this.sensor.apply(this.scene);
  }

  start(mode: Mode, difficulty: Difficulty, seed?: number) {
    if (!this.loaded) return;
    this.audio.stopAll();
    this.sim = new Sim(mode, difficulty, seed ?? this.flags.seed);
    this.sim.start();
    this.firing = false;
    this.camera.keys.clear();
    this.camera.pan.set(0, 0, 0);
    this.camera.anchor.set(this.sim.head.position.x, 0, this.sim.head.position.z);
    this.camera.zoomStep = 2;
    this.camera.locked = false;
    this.lastRadio = -1;
    this.nextBurn = 0;
    this.rebuild();
    this.hud.controls(false);
    this.audio.init();
    this.audio.startEngine();
    this.hud.screen('playing');
    this.lastStatus = 'playing';
  }

  menu() {
    this.firing = false;
    this.camera.keys.clear();
    this.audio.stopAll();
    this.sim = new Sim(this.hud.mode, this.hud.difficulty, this.flags.seed);
    this.camera.pan.set(0, 0, 0);
    this.camera.zoomStep = 1;
    this.rebuild();
    this.hud.screen('menu');
    this.lastStatus = 'menu';
  }

  pause() {
    if (this.sim.status !== 'playing') return;
    this.sim.status = 'paused';
    this.firing = false;
    this.camera.keys.clear();
    this.hud.screen('paused');
    this.lastStatus = 'paused';
    if ('speechSynthesis' in window) speechSynthesis.pause();
  }

  resume() {
    if (this.sim.status !== 'paused') return;
    this.sim.status = 'playing';
    this.hud.screen('playing');
    this.lastStatus = 'playing';
    if ('speechSynthesis' in window) speechSynthesis.resume();
  }

  private spendWeaponsFree() {
    if (this.sim.spendWeaponsFree()) this.audio.weaponsFree();
  }

  private nextTarget() {
    const e = this.sim.cycleTarget();
    if (e) this.camera.focus(e);
  }

  private bind() {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse' || e.buttons) this.camera.sensorPoint(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointerdown', e => {
      this.camera.sensorPoint(e.clientX, e.clientY);
      if (e.button === 0 && e.pointerType === 'mouse' && this.sim.status === 'playing') {
        this.firing = true;
        canvas.setPointerCapture(e.pointerId);
      }
      this.audio.init();
    });
    addEventListener('pointerup', () => {this.firing = false;});
    addEventListener('pointercancel', () => {this.firing = false;});
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.camera.setZoom(e.deltaY < 0 ? 1 : -1);
    }, {passive: false});
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        if (this.hud.onControls) {this.hud.controls(false); return;}
        this.sim.status === 'playing' ? this.pause() : this.resume();
        return;
      }
      if (this.sim.status !== 'playing' || this.hud.onControls) return;
      if ([' ', 'tab', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
      this.camera.keys.add(k);
      if (e.repeat) return;
      if (k === '1' || k === '2' || k === '3') this.sim.weapons.selected = Number(k) - 1;
      if (k === 'q' || k === 'e') this.sensor.blackHot = !this.sensor.blackHot;
      if (k === 'r') this.sim.weapons.reload();
      if (k === 'f') this.spendWeaponsFree();
      if (k === 'tab') this.nextTarget();
      if (k === ' ') this.camera.locked = !this.camera.locked;
      if (k === '=' || k === '+') this.camera.setZoom(1);
      if (k === '-') this.camera.setZoom(-1);
    });
    addEventListener('keyup', e => this.camera.keys.delete(e.key.toLowerCase()));
    addEventListener('resize', () => this.resize());
    addEventListener('blur', () => this.pause());
    document.addEventListener('visibilitychange', () => {if (document.hidden) this.pause();});
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    const ratio = Math.min(devicePixelRatio, 1.6);
    this.renderer.setSize(w, h);
    this.camera.resize(w, h);
    this.sensor.resize(Math.floor(w * ratio), Math.floor(h * ratio));
  }

  // -------------------------------------------------------------- rendering

  private syncEntities() {
    const live = new Set<number>();
    let added = false;
    for (const e of this.sim.entities) {
      live.add(e.id);
      let g = this.entities.get(e.id);
      if (!g) {
        g = this.assets.get(this.modelFor(e));
        g.userData.kind = e.kind;
        // Civilians travel with belongings: a handcart on some of them makes
        // the column read as a column, and adds a cold, wide shape no armed
        // figure ever has.
        if (e.kind === 'civilian' && e.slot % 4 === 1) {
          const cart = this.assets.get('cart');
          cart.position.set(1.6, 0, 0.4);
          g.add(cart);
        }
        g.traverse(o => {
          if (!(o instanceof T.Mesh)) return;
          o.castShadow = true;
          o.receiveShadow = true;
        });
        this.entities.set(e.id, g);
        this.scene.add(g);
        added = true;
      }
      if (e.saved) {g.visible = false; continue;}
      g.visible = true;
      g.position.set(e.x, e.y, e.z);

      if (e.hp <= 0) {
        if (vehicle(e.kind)) {
          if (!g.userData.wreck) {
            this.scene.remove(g);
            g = this.assets.get('wreck');
            g.position.set(e.x, 0, e.z);
            g.userData.wreck = true;
            g.traverse(o => {if (o instanceof T.Mesh) {o.castShadow = true; o.receiveShadow = true;}});
            this.entities.set(e.id, g);
            this.scene.add(g);
            added = true;
          }
        } else {
          g.rotation.z = Math.PI / 2;
          g.position.y = 0.35;
          g.scale.setScalar(0.78);
          if (!g.userData.cooled) {
            // A body cools. It should stop looking like a live target.
            g.userData.cooled = true;
            g.traverse(o => {
              if (!(o instanceof T.Mesh)) return;
              const m = (o.material as T.MeshStandardMaterial).clone();
              m.userData = {...m.userData, heat: 0.30};
              o.material = m;
            });
            added = true;
          }
        }
        continue;
      }

      const prev = g.userData.previous as {x: number; z: number} | undefined;
      const moving = prev && Math.hypot(prev.x - e.x, prev.z - e.z) > 0.002;
      if (moving) {
        g.rotation.y = Math.atan2(e.x - prev!.x, e.z - prev!.z);
        // A walk bob. It is the only motion cue at this range, and movement is
        // half of how a civilian is told apart from a hostile.
        if (!vehicle(e.kind)) {
          const rate = e.panic > 0 ? 16 : 9;
          g.position.y = e.y + Math.abs(Math.sin(this.sim.time * rate + e.id)) * (e.panic > 0 ? 0.22 : 0.11);
        }
      } else if (e.side === 'enemy') {
        const head = this.sim.head.position;
        g.rotation.y = Math.atan2(head.x - e.x, head.z - e.z);
      }
      // The probe figure faces a fixed way, so a silhouette comparison is not
      // measuring which direction the model happened to be turned.
      if (this.probeEntityId && e.id === this.probeEntityId) {
        g.rotation.y = PROBE_FACING;
        g.position.y = e.y;
      }
      g.userData.previous = {x: e.x, z: e.z};
    }
    for (const [id, g] of this.entities) {
      if (live.has(id)) continue;
      this.scene.remove(g);
      this.entities.delete(id);
    }
    if (added) this.sensor.apply(this.scene);
  }

  private modelFor(e: Entity): ModelName {
    // The mutation applies to the probe too, or the silhouette gate's negative
    // test would quietly measure the unmutated build and always "pass".
    const base = this.probeModel && e.id === this.probeEntityId
      ? this.probeModel
      : MODEL[e.kind] ?? 'rifle';
    return this.flags.model(base === 'civilian' ? 'civilian' : e.kind, base);
  }

  /** One tick of the scripted gunner, shared with the headless tests. */
  runAutoGunner() {
    return autoGunner(this.sim, {
      x: this.camera.camera.position.x,
      z: this.camera.camera.position.z,
    });
  }

  /** Rendering fix 2: a soft darkening pressed under every unit. */
  private syncContactShadows() {
    this.contacts.begin();
    for (const e of this.sim.entities) {
      if (e.saved || e.y > 0.5) continue;
      const alive = e.hp > 0;
      if (vehicle(e.kind)) this.contacts.add(e.x, e.z, 3.4, alive ? 1 : 0.7);
      else this.contacts.add(e.x, e.z, 1.25, alive ? 1 : 0.6);
    }
    if (this.helo && this.helo.visible) {
      this.contacts.add(this.helo.position.x, this.helo.position.z, 9, 1);
    }
    this.contacts.end();
  }

  private syncProjectiles() {
    const live = new Set<number>();
    for (const s of this.sim.shots) {
      live.add(s.id);
      let line = this.projectiles.get(s.id);
      if (!line) {
        line = new T.Line(
          new T.BufferGeometry(),
          new T.LineBasicMaterial({color: 0xf7fbe9, transparent: true, opacity: 0.95}));
        this.scene.add(line);
        this.projectiles.set(s.id, line);
      }
      const t = Math.min(1, s.age / s.travel);
      const tail = Math.max(0, t - 0.04);
      const at = (v: number) => new T.Vector3(
        T.MathUtils.lerp(s.from.x, s.x, v),
        ALTITUDE * (1 - v) + Math.sin(v * Math.PI) * 14 + 1,
        T.MathUtils.lerp(s.from.z, s.z, v));
      line.geometry.dispose();
      line.geometry = new T.BufferGeometry().setFromPoints([at(tail), at(t)]);
    }
    for (const [id, line] of this.projectiles) {
      if (live.has(id)) continue;
      this.scene.remove(line);
      line.geometry.dispose();
      (line.material as T.Material).dispose();
      this.projectiles.delete(id);
    }
  }

  /** The extraction helicopter: flies in on the last leg of the hold and lands. */
  private syncHelo(dt: number) {
    const s = this.sim;
    if (!s.heloInbound) return;
    if (!this.helo) {
      this.helo = this.assets.get('helo');
      this.helo.traverse(o => {if (o instanceof T.Mesh) {o.castShadow = true; o.receiveShadow = true;}});
      this.scene.add(this.helo);
      this.sensor.apply(this.scene);
      this.audio.startHelo();
      this.audio.warn(true);
    }
    // Run in from the south-east, flare, and settle onto the pad.
    const remaining = s.status === 'won' ? 0 : Math.max(0, s.holdRemaining);
    const t = 1 - remaining / HELO_INBOUND;
    const k = Math.min(1, Math.max(0, t));
    this.helo.position.set(
      LZ.x + (1 - k) * 520,
      1.2 + (1 - k) * (1 - k) * 190,
      LZ.z + (1 - k) * 380);
    this.helo.rotation.y = Math.PI * 0.82;
    this.helo.rotation.x = (1 - k) * -0.12;
    const rotor = this.helo.getObjectByName('rotor');
    const tail = this.helo.getObjectByName('tailRotor');
    if (rotor) rotor.rotation.y += dt * 34;
    if (tail) tail.rotation.x += dt * 48;
  }

  private frame(ms: number) {
    const frameStart = performance.now();
    const dt = Math.min(0.05, (ms - this.lastMs) / 1000 || 0.016);
    this.lastMs = ms;
    this.wallTime = ms / 1000;
    const s = this.sim;
    const playing = s.status === 'playing';

    if (playing && this.autoGunner) this.runAutoGunner();
    if (playing && this.firing) {
      if (s.fire(this.camera.aim, {x: this.camera.camera.position.x, z: this.camera.camera.position.z})) {
        this.audio.fire(s.weapons.selected);
        this.camera.shake += WEAPONS[s.weapons.selected].shake * 0.35;
        if (s.weapons.selected === 2) this.sensor.strike(0.18);
      }
    }

    s.update(playing ? dt : 0);

    this.camera.update(dt, playing ? dt : 0, this.followOverride ?? s.head.position);
    // The shadow camera rides with the column so a 2048 map covers the fight
    // rather than the whole 1.4 km route at uselessly low resolution.
    const focus = this.camera.center;
    this.sun.position.set(focus.x - 160, 170, focus.z + 277);
    this.sun.target.position.set(focus.x, 0, focus.z);
    this.sun.target.updateMatrixWorld();

    this.syncEntities();
    this.syncContactShadows();
    this.syncProjectiles();
    this.syncHelo(playing ? dt : 0);
    this.terrain?.update(s.buildings);

    for (const impact of s.impacts) {
      this.effects.impact(impact);
      if (!playing) continue;
      this.audio.impact(Math.max(0, impact.weapon));
      this.camera.shake += impact.weapon === 2 ? 1.6 : 0.18;
      // Rendering fix 3: the heavy round blows the whole frame out. A 105 has
      // to read as heavier than a 40, not merely louder.
      if (impact.weapon === 2) this.sensor.strike(0.85);
    }
    s.impacts = [];
    for (const trace of s.traces) this.effects.trace(trace);
    s.traces = [];

    if (playing && s.time > this.nextBurn) {
      this.nextBurn = s.time + 2;
      let n = 0;
      for (const e of s.entities) {
        if (vehicle(e.kind) && e.hp < e.maxHp * 0.3 && n++ < 8) {
          this.effects.impact({x: e.x, z: e.z, radius: 1, weapon: 0});
        }
      }
      for (const b of s.buildings) {
        if (b.hp > 0 && b.hp < b.maxHp * 0.3) this.effects.impact({x: b.x, z: b.z, radius: 1, weapon: 0});
      }
    }
    if (playing && s.time > this.nextFirefight) {
      this.nextFirefight = s.time + 3;
      const near = s.enemies.filter(e => distance(e, s.head.position) < 220).length;
      this.audio.firefight(Math.min(1, near / 14));
    }

    this.effects.update(playing ? dt : 0);
    this.sensor.update(dt);

    if (s.radio.sequence !== this.lastRadio && s.radio.current && playing) {
      this.lastRadio = s.radio.sequence;
      this.audio.radio(s.radio.current);
      if (s.radio.current.priority >= 5) this.audio.warn(true);
    }
    if (playing) this.audio.update(s.time, s.director.phase);

    if (this.aircraft) {
      const a = this.camera.angle;
      const c = this.camera.center;
      this.aircraft.position.set(c.x + Math.sin(a) * 470, ALTITUDE + 40, c.z + Math.cos(a) * 470);
      this.aircraft.rotation.y = a + Math.PI / 2;
      this.aircraft.rotation.z = -0.14;
    }

    if (s.status !== this.lastStatus) {
      this.hud.screen(s.status);
      this.lastStatus = s.status;
      if (s.status === 'won' || s.status === 'lost') {
        this.firing = false;
        this.hud.result(s);
        this.audio.end(s.status === 'won');
        if (s.status === 'lost') this.audio.stopHelo(2);
      }
    }

    this.blastRing.visible = playing;
    this.blastRing.position.set(this.camera.aim.x, 0.3, this.camera.aim.z);
    this.blastRing.scale.setScalar(WEAPONS[s.weapons.selected].radius);

    this.sensor.render(this.scene, this.camera.camera, this.wallTime);

    const aim = this.camera.project(this.camera.aim);
    this.hud.reticle(
      (aim.x + 1) * innerWidth / 2,
      (-aim.y + 1) * innerHeight / 2,
      Math.max(6, WEAPONS[s.weapons.selected].radius / Math.max(0.05, this.camera.groundScale)));

    if (ms - this.lastHud > 80) {
      this.lastHud = ms;
      this.hud.update(s, {
        polarity: POLARITY[this.sensor.blackHot ? 1 : 0],
        zoomStep: this.camera.zoomStep,
        angle: this.camera.angle,
        locked: this.camera.locked,
      });
      this.hud.minimap.draw(s, this.camera.angle, this.camera.center);
      this.markers();
    }

    this.frameTimes.push(performance.now() - frameStart);
    if (this.frameTimes.length > 900) this.frameTimes.shift();
  }

  private markers() {
    const s = this.sim;
    let html = '';
    const place = (p: {x: number; z: number; y?: number}, label: string, cls: string) => {
      const v = this.camera.project(p);
      if (Math.abs(v.x) > 0.96 || Math.abs(v.y) > 0.92 || v.z > 1) return;
      html += `<div class="marker ${cls}" style="left:${(v.x + 1) * 50}%;top:${(-v.y + 1) * 50}%">${label}</div>`;
    };
    const wide = this.camera.zoomStep <= 1;
    for (const f of s.operators) place({...f, y: f.y + 4}, wide ? '' : `GHOST ${f.slot + 1}`, 'friendly');
    // Civilians get a bracket only when zoomed in, so the wide view never
    // labels the column for free.
    if (this.camera.zoomStep >= 3) {
      for (const c of s.civilians) place({...c, y: 3.4}, '', 'civilian');
    }
    const marked = s.enemies.filter(e =>
      e.marked && (e.id === s.selectedTarget || e.id === s.radio.current?.targetId)).slice(0, 2);
    for (const e of marked) {
      place({...e, y: e.y + 6},
        `<span class="diamond"></span>${e.kind === 'assault' ? 'HIGH PRIORITY' : e.kind.toUpperCase()}`,
        'priority');
    }
    place({x: LZ.x, z: LZ.z, y: 6}, s.atLZ ? 'EXTRACTION POINT' : 'LANDING ZONE', 'place');
    this.hud.markers(html);
  }

  // ------------------------------------------------------------------ debug

  /**
   * Numeric state for the kill gate. Screenshots cost a lot and routinely prove
   * nothing; assertions over these values prove something. Anything the gate
   * needs to check lives here.
   */
  private exposeDebug() {
    const game = this;
    (window as unknown as Record<string, unknown>).__spectre = {
      get sim() {return game.sim;},
      get camera() {return game.camera;},
      state() {
        const s = game.sim;
        return {
          status: s.status,
          time: s.time,
          phase: s.director.phase,
          progress: s.progress,
          routeFraction: s.routeFraction,
          pinned: s.pinned,
          atLZ: s.atLZ,
          held: s.held,
          heloInbound: s.heloInbound,
          heloLanded: s.heloLanded,
          energy: s.energy,
          weaponsFree: s.weaponsFree,
          operators: s.operators.length,
          civilians: s.civilians.length,
          enemies: s.enemies.length,
          contacts: s.contacts.length,
          saved: s.stats.saved,
          civilianCasualties: s.stats.civilians,
          replacements: s.stats.replacements,
          score: s.stats.score,
          grade: s.grade,
          ammo: s.weapons.remaining,
          zoomStep: game.camera.zoomStep,
          fov: ZOOM_STEPS[game.camera.zoomStep],
          blackHot: game.sensor.blackHot,
          shadowsEnabled: game.renderer.shadowMap.enabled,
          sunCastsShadow: game.sun.castShadow,
          shadowCasters: game.countShadowCasters(),
          assetFallbacks: game.assets.fallbacks.length,
          drawCalls: game.sensor.sceneCalls,
          triangles: game.sensor.sceneTriangles,
          liveEntities: s.entities.filter(e => e.hp > 0 && !e.saved).length,
          mutation: game.flags.mutation,
        };
      },
      frameStats() {
        const t = [...game.frameTimes].sort((a, b) => a - b);
        if (!t.length) return {samples: 0};
        const at = (q: number) => t[Math.min(t.length - 1, Math.floor(t.length * q))];
        return {samples: t.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: t[t.length - 1]};
      },
      resetFrameStats() {game.frameTimes = [];},
      /**
       * Run the simulation forward without rendering. This is how a gate
       * reaches a late phase in a second instead of eleven minutes, and it is
       * the same stepping the `ff` flag uses.
       */
      fastForward(untilSeconds: number, withGunner = true) {
        const dt = 1 / 30;
        let steps = 0;
        while (game.sim.time < untilSeconds && game.sim.status === 'playing' && steps++ < 200000) {
          if (withGunner) game.runAutoGunner();
          game.sim.update(dt);
          game.sim.impacts = [];
          game.sim.traces = [];
        }
        return game.sim.time;
      },
      /** Screen-space box of the probe figure, for the silhouette comparison. */
      probeRect: () => game.flags.probeRect(game),

      /**
       * Silhouette comparison. Renders two figures in turn at the same place,
       * from the same viewpoint, with sensor grain off, thresholds each image
       * into a hot mask, and returns the Jaccard distance between the masks:
       * the area they disagree on over the area either covers.
       *
       * A value near zero means the two shapes are the same shape, which is
       * exactly the failure this is here to catch.
       */
      silhouette(kindA: ModelName, kindB: ModelName, zoomStep = 2, hot = 0.30) {
        game.sensor.material.uniforms.noiseScale.value = 0;
        game.setProbe(kindA, zoomStep);
        const rect = game.flags.probeRect(game);
        if (!rect) return null;
        const a = game.readLuminance(rect);
        game.setProbe(kindB, zoomStep);
        const b = game.readLuminance(rect);
        let intersection = 0, union = 0, areaA = 0, areaB = 0;
        for (let i = 0; i < a.lum.length && i < b.lum.length; i++) {
          const ma = a.lum[i] > hot, mb = b.lum[i] > hot;
          if (ma) areaA++;
          if (mb) areaB++;
          if (ma || mb) union++;
          if (ma && mb) intersection++;
        }
        return {
          jaccardDistance: union ? 1 - intersection / union : 0,
          areaA, areaB, union, rect,
          pixels: a.width * a.height,
          zoomStep,
        };
      },

      /**
       * Shadow presence, measured rather than asserted. Renders the same
       * figure with the shadow map on and off and counts how many ground
       * pixels the shadow actually darkens. The reverse count is returned too:
       * if turning shadows off made the image darker, the measurement is
       * picking up something other than a shadow and should not be trusted.
       */
      shadowProbe(zoomStep = 2) {
        game.sensor.material.uniforms.noiseScale.value = 0;
        game.setProbe('rifle', zoomStep);
        const base = game.flags.probeRect(game);
        if (!base) return null;
        // Widen the window well past the figure: the shadow is cast to one
        // side of it, not under it.
        const rect = {
          x: Math.round(base.x - base.width * 1.2),
          y: Math.round(base.y - base.height * 0.5),
          width: Math.round(base.width * 3.4),
          height: Math.round(base.height * 2.2),
        };
        const withShadows = game.readLuminance(rect);
        const restore = game.renderer.shadowMap.enabled;
        game.setShadows(false);
        game.renderOnce();
        const without = game.readLuminance(rect);
        game.setShadows(restore);
        game.renderOnce();

        let darker = 0, brighter = 0, delta = 0, maxDelta = 0, onSum = 0, offSum = 0;
        const n = Math.min(withShadows.lum.length, without.lum.length);
        for (let i = 0; i < n; i++) {
          const d = without.lum[i] - withShadows.lum[i];
          delta += d;
          onSum += withShadows.lum[i];
          offSum += without.lum[i];
          if (d > maxDelta) maxDelta = d;
          if (d > 8 / 255) darker++;
          else if (d < -8 / 255) brighter++;
        }
        return {
          shadowedPixels: darker,
          reversePixels: brighter,
          meanDelta: n ? delta / n : 0,
          maxDelta,
          meanWithShadows: n ? onSum / n : 0,
          meanWithout: n ? offSum / n : 0,
          pixels: n,
          rect,
          shadowMapEnabled: restore,
        };
      },
      start: (mode: Mode, difficulty: Difficulty, seed?: number) => game.start(mode, difficulty, seed),
      setZoom: (step: number) => {game.camera.zoomStep = step;},
      setPolarity: (blackHot: boolean) => {game.sensor.blackHot = blackHot;},
    };
  }

  countShadowCasters() {
    let n = 0;
    this.scene.traverse(o => {if (o instanceof T.Mesh && o.castShadow) n++;});
    return n;
  }

  // ------------------------------------------------------- gate measurement
  //
  // The kill gate needs to check two things a screenshot cannot prove on its
  // own: that shadows are actually reaching the ground under a unit, and that
  // a civilian and a hostile do not resolve to the same shape. Both are
  // measured here, in the page, off the sensor render target, and returned as
  // numbers. Screenshots are still captured alongside, but as a record for a
  // human rather than as the thing being asserted.

  /**
   * Turn the shadow map on or off at runtime. Three.js bakes the shadow path
   * into each compiled shader, so every material has to be marked for
   * recompilation or the toggle silently does nothing.
   */
  setShadows(on: boolean) {
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    this.renderer.shadowMap.needsUpdate = true;
    this.scene.traverse(o => {
      if (!(o instanceof T.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
    });
  }

  /** Force one full render so a measurement reflects the current setup. */
  private renderOnce() {
    this.syncEntities();
    this.syncContactShadows();
    this.camera.update(0.016, 0, this.followOverride ?? this.sim.head.position);
    const focus = this.camera.center;
    this.sun.position.set(focus.x - 160, 170, focus.z + 277);
    this.sun.target.position.set(focus.x, 0, focus.z);
    this.sun.target.updateMatrixWorld();
    this.sensor.render(this.scene, this.camera.camera, this.wallTime);
  }

  /**
   * Read a rectangle of the sensor image back as luminance, 0-1. The rectangle
   * is given in CSS pixels; the render target is in device pixels with its
   * origin at the bottom left, so both are converted here.
   */
  readLuminance(rect: {x: number; y: number; width: number; height: number}) {
    const ratio = Math.min(devicePixelRatio, 1.6);
    const tw = this.sensor.target.width, th = this.sensor.target.height;
    const x = Math.max(0, Math.min(tw - 1, Math.round(rect.x * ratio)));
    const w = Math.max(1, Math.min(tw - x, Math.round(rect.width * ratio)));
    const yTop = Math.round(rect.y * ratio);
    const h = Math.max(1, Math.min(th, Math.round(rect.height * ratio)));
    const y = Math.max(0, Math.min(th - h, th - yTop - h));
    const buffer = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(this.sensor.target, x, y, w, h, buffer);
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      lum[i] = (buffer[i * 4] * 0.299 + buffer[i * 4 + 1] * 0.587 + buffer[i * 4 + 2] * 0.114) / 255;
    }
    return {width: w, height: h, lum};
  }

  /** Reconfigure the identification probe at runtime and re-render. */
  setProbe(kind: ModelName, zoomStep: number) {
    const simKind = kind === 'civilian' ? 'civilian' : kind === 'operator' ? 'operator' : 'rifle';
    this.sim.entities = [];
    for (const g of this.entities.values()) this.scene.remove(g);
    this.entities.clear();
    const e = this.sim.spawn(simKind, {x: this.followOverride!.x, z: this.followOverride!.z}, 'ahead');
    e.cooldown = 1e9;
    this.probeEntityId = e.id;
    this.probeModel = kind;
    this.camera.zoomStep = zoomStep;
    this.sensor.apply(this.scene);
    // Two passes: the first settles the smoothed field of view, the second is
    // the one that gets measured.
    this.renderOnce();
    this.camera.zoomStep = zoomStep;
    for (let i = 0; i < 30; i++) this.camera.update(0.05, 0, this.followOverride!);
    this.renderOnce();
  }
}
