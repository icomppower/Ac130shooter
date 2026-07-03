'use strict';
/* SPECTRE 1-3 — AC-130 Close Air Support
   Vanilla Canvas 2D + Web Audio. No dependencies. */

// ============================================================ CONFIG

const MAP = 3600;                 // world is MAP x MAP units
const ORBIT_RATE = 0.048;         // rad/s apparent ground rotation
const ZOOMS = [0.45, 0.9, 1.8];
const TILT = 0.68;                // ~45° look-down: vertical foreshortening of the ground plane

const WEAPONS = [
  { name: '25MM GATLING', rate: 10,  flight: 0.55, dmg: 26,  radius: 15, spread: 17, mag: 100, reload: 4.0, auto: true,  shake: 0.6, snd: 'g25' },
  { name: '40MM BOFORS',  rate: 1.7, flight: 1.05, dmg: 95,  radius: 38, spread: 12, mag: 8,   reload: 4.5, auto: true,  shake: 2.2, snd: 'g40' },
  { name: '105MM HOWITZER', rate: 0.6, flight: 2.1, dmg: 520, radius: 100, spread: 22, mag: 1, reload: 6.0, auto: false, shake: 9,   snd: 'g105' },
];

const ENEMY_TYPES = {
  rifle:     { hp: 30,  speed: 27, range: 190, dps: 2.2, r: 5,  score: 1 },
  rpg:       { hp: 30,  speed: 22, range: 300, dps: 7.0, r: 5,  score: 2 },
  technical: { hp: 170, speed: 62, range: 260, dps: 8.0, r: 12, score: 3 },
};

const FRIEND_HP = 100;
const FRIEND_DPS = 6;
const FRIEND_RANGE = 330;
const SQUAD_SPEED = 20;
const HOLD_TIME = 45;             // seconds to hold at LZ before extract

const WAYPOINTS = [
  [620, 3020], [1380, 2440], [1820, 1820], [2420, 1330], [2920, 700],
];
const FORMATION = [[0, 0], [34, 22], [-28, 32], [24, -32], [-34, -22], [40, 40]];

// ============================================================ STATE

const worldCanvas = document.getElementById('world');
const hudCanvas = document.getElementById('hud');
const wctx = worldCanvas.getContext('2d');
const hctx = hudCanvas.getContext('2d');
let W = 0, H = 0;

const cam = { x: WAYPOINTS[0][0], y: WAYPOINTS[0][1], a: 0, zi: 1, zoom: ZOOMS[1] };

const state = {
  running: false, paused: false, over: false, win: false,
  t: 0, wep: 0, firing: false, firedThisPress: false,
  cooldown: 0, blackhot: false, shake: 0,
  spawnT: 5, chatterT: 14, checkFireT: 0, dangerT: 0,
  wpIndex: 1, atLZ: false, holdT: HOLD_TIME,
  kills: 0, fired: 0, friendlyLost: 0,
};

const weaponState = WEAPONS.map(w => ({ ammo: w.mag, reloading: 0 }));

let friendlies = [], enemies = [], shells = [], fx = [], flashes = [];
let buildings = [], trees = [];
let radioLines = [];  // {text, t, reveal}
let ground = null, gctx = null;
let noiseTiles = [];

// ============================================================ UTIL

const rnd = (a, b) => a + Math.random() * (b - a);
const irnd = (a, b) => Math.floor(rnd(a, b + 1));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function dirName(x, y, ox, oy) {
  const ang = Math.atan2(y - oy, x - ox);
  const names = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  return names[Math.round(((ang + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];
}

function squadCenter() {
  const alive = friendlies.filter(f => !f.dead);
  if (!alive.length) return [MAP / 2, MAP / 2];
  let sx = 0, sy = 0;
  for (const f of alive) { sx += f.x; sy += f.y; }
  return [sx / alive.length, sy / alive.length];
}

// screen-space vector -> world-space vector (accounts for camera rotation and tilt)
function screenToWorldVec(sx, sy) {
  const c = Math.cos(cam.a), s = Math.sin(cam.a);
  const ty = sy / TILT;
  return [(sx * c - ty * s) / cam.zoom, (sx * s + ty * c) / cam.zoom];
}

function pointInBuilding(x, y) {
  for (const b of buildings) {
    if (!b.dead && x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) return b;
  }
  return null;
}

// ============================================================ AUDIO

let AC = null, master = null, noiseBuf = null;

function initAudio() {
  if (AC) { AC.resume(); return; }
  AC = new (window.AudioContext || window.webkitAudioContext)();
  master = AC.createGain();
  master.gain.value = 0.6;
  master.connect(AC.destination);

  const len = AC.sampleRate * 2;
  noiseBuf = AC.createBuffer(1, len, AC.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

  startDrone();
}

function noiseSrc() {
  const s = AC.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  return s;
}

function startDrone() {
  // engine drone: filtered noise + low throb
  const n = noiseSrc();
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 130;
  const g = AC.createGain(); g.gain.value = 0.11;
  n.connect(f); f.connect(g); g.connect(master); n.start();

  const o = AC.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 54;
  const of = AC.createBiquadFilter(); of.type = 'lowpass'; of.frequency.value = 120;
  const og = AC.createGain(); og.gain.value = 0.05;
  o.connect(of); of.connect(og); og.connect(master); o.start();

  const lfo = AC.createOscillator(); lfo.frequency.value = 11;
  const lg = AC.createGain(); lg.gain.value = 0.02;
  lfo.connect(lg); lg.connect(og.gain); lfo.start();
}

function burst(freq, dur, vol, type) {
  const t = AC.currentTime;
  const n = noiseSrc();
  const f = AC.createBiquadFilter(); f.type = type || 'lowpass'; f.frequency.value = freq;
  const g = AC.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  n.connect(f); f.connect(g); g.connect(master);
  n.start(t); n.stop(t + dur + 0.05);
}

function thump(f0, f1, dur, vol) {
  const t = AC.currentTime;
  const o = AC.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = AC.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}

const SFX = {
  g25()  { burst(2400, 0.09, 0.22, 'bandpass'); thump(190, 90, 0.06, 0.10); },
  g40()  { burst(900, 0.22, 0.4); thump(150, 55, 0.18, 0.35); },
  g105() { burst(420, 0.7, 0.8); thump(110, 28, 0.8, 0.9); },
  hitS() { burst(1400, 0.15, 0.16, 'bandpass'); },
  hitM() { burst(600, 0.5, 0.45); thump(120, 40, 0.4, 0.4); },
  hitL() { burst(300, 1.4, 0.9); thump(90, 22, 1.3, 0.9); },
  beep() {
    const t = AC.currentTime;
    const o = AC.createOscillator(); o.type = 'square'; o.frequency.value = 1180;
    const g = AC.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.1);
  },
};

function sfx(name) { if (AC) SFX[name](); }

// ============================================================ RADIO

function radio(text) {
  radioLines.push({ text, t: 0, reveal: 0 });
  if (radioLines.length > 5) radioLines.shift();
  sfx('beep');
}

const CHATTER = [
  'Spectre 1-3, you are cleared hot.',
  'Ghost 1-1 copies, keep scanning.',
  'Sensor, keep eyes on that treeline.',
  'Winds two-four-zero at one-five.',
  'TOC copies all, continue mission.',
];

// ============================================================ WORLD GEN

function distToPath(x, y) {
  let best = Infinity;
  for (let i = 0; i < WAYPOINTS.length - 1; i++) {
    const [ax, ay] = WAYPOINTS[i], [bx, by] = WAYPOINTS[i + 1];
    const dx = bx - ax, dy = by - ay;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1);
    best = Math.min(best, dist(x, y, ax + dx * t, ay + dy * t));
  }
  return best;
}

function genWorld() {
  buildings = []; trees = [];

  // town buildings clustered mid-map, clear of the road corridor
  for (let tries = 0; tries < 900 && buildings.length < 46; tries++) {
    const w = rnd(70, 210), h = rnd(70, 210);
    const x = rnd(500, MAP - 500 - w), y = rnd(500, MAP - 500 - h);
    const cx = x + w / 2, cy = y + h / 2;
    if (dist(cx, cy, MAP / 2, MAP / 2) > 1400) continue;
    if (distToPath(cx, cy) < 120 + Math.max(w, h) / 2) continue;
    let ok = true;
    for (const b of buildings) {
      if (x < b.x + b.w + 46 && x + w > b.x - 46 && y < b.y + b.h + 46 && y + h > b.y - 46) { ok = false; break; }
    }
    if (ok) buildings.push({ x, y, w, h, hp: 320, dead: false });
  }

  for (let i = 0; i < 150; i++) {
    const x = rnd(120, MAP - 120), y = rnd(120, MAP - 120);
    if (!pointInBuilding(x, y) && distToPath(x, y) > 60) trees.push({ x, y, r: rnd(9, 22) });
  }

  // static ground layer, drawn once (craters/bodies stamped onto it later)
  ground = document.createElement('canvas');
  ground.width = MAP; ground.height = MAP;
  gctx = ground.getContext('2d');

  gctx.fillStyle = '#2c2c2c';
  gctx.fillRect(0, 0, MAP, MAP);

  // terrain mottling: a few broad soft patches, then fine speckle
  for (let i = 0; i < 900; i++) {
    const c = 44 + irnd(-8, 8);
    gctx.fillStyle = `rgba(${c},${c},${c},0.5)`;
    gctx.beginPath();
    gctx.arc(rnd(0, MAP), rnd(0, MAP), rnd(20, 90), 0, 7);
    gctx.fill();
  }
  for (let i = 0; i < 9000; i++) {
    const c = 44 + irnd(-13, 13);
    gctx.fillStyle = `rgba(${c},${c},${c},0.7)`;
    gctx.beginPath();
    gctx.arc(rnd(0, MAP), rnd(0, MAP), rnd(2, 9), 0, 7);
    gctx.fill();
  }
  // field patches
  for (let i = 0; i < 26; i++) {
    const c = irnd(30, 52);
    gctx.fillStyle = `rgba(${c},${c},${c},0.5)`;
    gctx.fillRect(rnd(0, MAP - 400), rnd(0, MAP - 400), rnd(200, 520), rnd(200, 520));
  }

  // roads: the squad route + two cross streets
  gctx.strokeStyle = '#4a4a4a';
  gctx.lineCap = 'round'; gctx.lineJoin = 'round';
  gctx.lineWidth = 66;
  gctx.beginPath();
  gctx.moveTo(WAYPOINTS[0][0], WAYPOINTS[0][1]);
  for (const [x, y] of WAYPOINTS) gctx.lineTo(x, y);
  gctx.stroke();
  gctx.lineWidth = 44;
  gctx.beginPath(); gctx.moveTo(600, 1500); gctx.lineTo(3100, 2100); gctx.stroke();
  gctx.beginPath(); gctx.moveTo(1200, 600); gctx.lineTo(2000, 3100); gctx.stroke();

  for (const t of trees) {
    gctx.fillStyle = '#1d1d1d';
    gctx.beginPath(); gctx.arc(t.x, t.y, t.r, 0, 7); gctx.fill();
    gctx.fillStyle = 'rgba(60,60,60,0.35)';
    gctx.beginPath(); gctx.arc(t.x - t.r * 0.25, t.y - t.r * 0.25, t.r * 0.5, 0, 7); gctx.fill();
  }

  for (const b of buildings) drawBuilding(b);

  // LZ marking
  const [lx, ly] = WAYPOINTS[WAYPOINTS.length - 1];
  gctx.strokeStyle = '#585858'; gctx.lineWidth = 8;
  gctx.beginPath(); gctx.arc(lx, ly, 120, 0, 7); gctx.stroke();
  gctx.font = '48px monospace'; gctx.fillStyle = '#585858';
  gctx.fillText('LZ', lx - 26, ly + 16);

  // noise tiles for film grain
  noiseTiles = [];
  for (let n = 0; n < 3; n++) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const x = c.getContext('2d');
    const img = x.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = irnd(0, 255);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 26;
    }
    x.putImageData(img, 0, 0);
    noiseTiles.push(c);
  }
}

function drawBuilding(b) {
  gctx.fillStyle = '#565656';
  gctx.fillRect(b.x, b.y, b.w, b.h);
  gctx.fillStyle = '#3f3f3f';
  gctx.fillRect(b.x + 8, b.y + 8, b.w - 16, b.h - 16);
  gctx.strokeStyle = '#616161'; gctx.lineWidth = 3;
  gctx.strokeRect(b.x, b.y, b.w, b.h);
}

function stampRubble(b) {
  gctx.fillStyle = '#242424';
  gctx.fillRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
  for (let i = 0; i < 24; i++) {
    const c = irnd(30, 70);
    gctx.fillStyle = `rgb(${c},${c},${c})`;
    gctx.beginPath();
    gctx.arc(b.x + rnd(0, b.w), b.y + rnd(0, b.h), rnd(6, 26), 0, 7);
    gctx.fill();
  }
}

function stampCrater(x, y, r) {
  gctx.fillStyle = 'rgba(12,12,12,0.85)';
  gctx.beginPath(); gctx.arc(x, y, r * 0.55, 0, 7); gctx.fill();
  gctx.strokeStyle = 'rgba(20,20,20,0.5)';
  for (let i = 0; i < 7; i++) {
    const a = rnd(0, 7);
    gctx.lineWidth = rnd(2, 5);
    gctx.beginPath();
    gctx.moveTo(x + Math.cos(a) * r * 0.4, y + Math.sin(a) * r * 0.4);
    gctx.lineTo(x + Math.cos(a) * r * rnd(0.9, 1.3), y + Math.sin(a) * r * rnd(0.9, 1.3));
    gctx.stroke();
  }
}

function stampBody(x, y) {
  gctx.fillStyle = 'rgba(150,150,150,0.55)';
  gctx.beginPath();
  gctx.ellipse(x, y, 7, 3.5, rnd(0, 7), 0, 7);
  gctx.fill();
}

// ============================================================ ENTITIES

function spawnSquad() {
  friendlies = [];
  for (let i = 0; i < 6; i++) {
    friendlies.push({
      x: WAYPOINTS[0][0] + FORMATION[i][0],
      y: WAYPOINTS[0][1] + FORMATION[i][1],
      hp: FRIEND_HP, dead: false,
      off: FORMATION[i], fireT: rnd(0, 0.5), flash: 0,
    });
  }
}

function spawnGroup() {
  if (enemies.length > 60) return;
  // spawn converging on the squad, far enough out to stay off-screen
  const [sx, sy] = squadCenter();
  let ex = MAP / 2, ey = MAP / 2;
  for (let tries = 0; tries < 12; tries++) {
    const a = rnd(0, Math.PI * 2), d = rnd(950, 1500);
    ex = clamp(sx + Math.cos(a) * d, 150, MAP - 150);
    ey = clamp(sy + Math.sin(a) * d, 150, MAP - 150);
    if (!pointInBuilding(ex, ey) && dist(ex, ey, sx, sy) > 850) break;
  }
  const n = clamp(2 + Math.floor(state.t / 65) + irnd(0, 2), 2, 9);
  for (let i = 0; i < n; i++) {
    let type = 'rifle';
    const roll = Math.random();
    if (state.t > 50 && roll < 0.16) type = 'technical';
    else if (roll < 0.34) type = 'rpg';
    const t = ENEMY_TYPES[type];
    enemies.push({
      type, hp: t.hp,
      x: ex + rnd(-90, 90), y: ey + rnd(-90, 90),
      speed: t.speed * rnd(0.85, 1.15), range: t.range, dps: t.dps, r: t.r,
      fireT: rnd(0, 1), flash: 0, dead: false,
      heading: 0,
    });
  }
  radio(`Spectre, we got movement to our ${dirName(ex, ey, sx, sy)}!`);
}

// ============================================================ COMBAT

function fireWeapon() {
  const w = WEAPONS[state.wep];
  const ws = weaponState[state.wep];
  if (ws.reloading > 0 || state.cooldown > 0) return;
  if (!w.auto && state.firedThisPress) return;

  ws.ammo--;
  state.fired++;
  state.cooldown = 1 / w.rate;
  state.firedThisPress = true;
  state.shake = Math.max(state.shake, w.shake);
  sfx(w.snd);

  const a = rnd(0, Math.PI * 2), r = Math.sqrt(Math.random()) * w.spread;
  shells.push({
    tx: clamp(cam.x + Math.cos(a) * r, 40, MAP - 40),
    ty: clamp(cam.y + Math.sin(a) * r, 40, MAP - 40),
    t: w.flight, total: w.flight, wep: state.wep,
  });

  if (ws.ammo <= 0) {
    ws.reloading = w.reload;
    if (state.wep !== 0) radio(`${w.name} reloading.`);
  }
}

function explode(x, y, wi) {
  const w = WEAPONS[wi];
  fx.push({ x, y, t: 0, dur: wi === 2 ? 2.6 : wi === 1 ? 1.4 : 0.7, r: w.radius });
  sfx(wi === 2 ? 'hitL' : wi === 1 ? 'hitM' : 'hitS');
  if (wi === 2) state.shake = Math.max(state.shake, 5);
  if (wi > 0) stampCrater(x, y, w.radius * 0.8);

  let killsNow = 0;
  for (const e of enemies) {
    if (e.dead) continue;
    const d = dist(x, y, e.x, e.y);
    if (d < w.radius + e.r) {
      e.hp -= w.dmg * (1 - d / (w.radius + e.r) * 0.6);
      if (e.hp <= 0) { killEnemy(e); killsNow++; }
    }
  }
  if (killsNow >= 3) radio(pick(['Good effect on target.', 'They are dropping like flies down there.', 'Beautiful. Keep it coming.']));

  for (const f of friendlies) {
    if (f.dead) continue;
    const d = dist(x, y, f.x, f.y);
    if (d < w.radius) {
      f.hp -= w.dmg * (1 - d / w.radius * 0.5);
      if (f.hp <= 0) {
        f.dead = true;
        state.friendlyLost++;
        stampBody(f.x, f.y);
        endMission(false, 'FRATRICIDE', 'You fired on an IR strobe. Ghost 1-1 is combat ineffective.');
        return;
      } else if (state.checkFireT <= 0) {
        radio('CHECK FIRE! CHECK FIRE! Danger close, you are hitting friendlies!');
        state.checkFireT = 6;
      }
    }
  }

  for (const b of buildings) {
    if (b.dead) continue;
    const nx = clamp(x, b.x, b.x + b.w), ny = clamp(y, b.y, b.y + b.h);
    if (dist(x, y, nx, ny) < w.radius) {
      b.hp -= w.dmg;
      if (b.hp <= 0) { b.dead = true; stampRubble(b); }
    }
  }
}

function killEnemy(e) {
  e.dead = true;
  state.kills++;
  if (e.type === 'technical') {
    stampCrater(e.x, e.y, 20);
    fx.push({ x: e.x, y: e.y, t: 0, dur: 1.2, r: 30 });
  } else {
    stampBody(e.x, e.y);
  }
}

// ============================================================ MISSION FLOW

function startGame() {
  state.running = true; state.paused = false; state.over = false; state.win = false;
  state.t = 0; state.wep = 0; state.firing = false; state.cooldown = 0;
  state.shake = 0; state.spawnT = 6; state.chatterT = 16; state.checkFireT = 0;
  state.wpIndex = 1; state.atLZ = false; state.holdT = HOLD_TIME;
  state.kills = 0; state.fired = 0; state.friendlyLost = 0;
  for (let i = 0; i < WEAPONS.length; i++) {
    weaponState[i].ammo = WEAPONS[i].mag;
    weaponState[i].reloading = 0;
  }
  cam.x = WAYPOINTS[0][0]; cam.y = WAYPOINTS[0][1]; cam.a = rnd(0, 7); cam.zi = 1; cam.zoom = ZOOMS[1];
  enemies = []; shells = []; fx = []; flashes = []; radioLines = [];
  genWorld();
  spawnSquad();
  radio('Spectre 1-3 on station. Ghost 1-1, we have your strobes.');
  setTimeout(() => { if (state.running && !state.over) radio('Ghost 1-1 moving to extraction. Cover our advance.'); }, 4000);
}

function endMission(win, title, sub) {
  if (state.over) return;
  state.over = true; state.win = win; state.firing = false;
  document.exitPointerLock && document.exitPointerLock();
  const alive = friendlies.filter(f => !f.dead).length;
  const mm = Math.floor(state.t / 60), ss = Math.floor(state.t % 60);
  document.getElementById('endTitle').textContent = title;
  document.getElementById('endTitle').className = win ? '' : 'fail';
  document.getElementById('endSub').textContent = sub;
  document.getElementById('endStats').textContent =
    `HOSTILES KIA ........ ${state.kills}\n` +
    `ROUNDS EXPENDED ..... ${state.fired}\n` +
    `GHOST 1-1 ........... ${alive}/6 SURVIVED\n` +
    `TIME ON STATION ..... ${mm}:${String(ss).padStart(2, '0')}`;
  document.getElementById('end').classList.remove('hidden');
}

// ============================================================ UPDATE

function update(dt) {
  state.t += dt;
  cam.a = (cam.a + ORBIT_RATE * dt) % (Math.PI * 2);
  state.shake = Math.max(0, state.shake - state.shake * 4 * dt - 0.5 * dt);
  state.checkFireT = Math.max(0, state.checkFireT - dt);

  // weapons
  state.cooldown = Math.max(0, state.cooldown - dt);
  for (let i = 0; i < WEAPONS.length; i++) {
    const ws = weaponState[i];
    if (ws.reloading > 0) {
      ws.reloading -= dt;
      if (ws.reloading <= 0) { ws.reloading = 0; ws.ammo = WEAPONS[i].mag; }
    }
  }
  if (state.firing) fireWeapon();

  // shells
  for (let i = shells.length - 1; i >= 0; i--) {
    const s = shells[i];
    s.t -= dt;
    if (s.t <= 0) { explode(s.tx, s.ty, s.wep); shells.splice(i, 1); }
  }
  if (state.over) return;

  // fx
  for (let i = fx.length - 1; i >= 0; i--) {
    fx[i].t += dt;
    if (fx[i].t > fx[i].dur) fx.splice(i, 1);
  }
  for (let i = flashes.length - 1; i >= 0; i--) {
    flashes[i].t -= dt;
    if (flashes[i].t <= 0) flashes.splice(i, 1);
  }

  updateSquad(dt);
  updateEnemies(dt);

  // spawn director
  state.spawnT -= dt;
  if (state.spawnT <= 0) {
    spawnGroup();
    state.spawnT = state.atLZ ? rnd(4, 6.5) : Math.max(4.5, 12 - state.t / 50) + rnd(0, 3);
  }

  // idle chatter
  state.chatterT -= dt;
  if (state.chatterT <= 0) {
    radio(pick(CHATTER));
    state.chatterT = rnd(22, 40);
  }

  // extraction hold
  if (state.atLZ) {
    state.holdT -= dt;
    if (state.holdT <= 0) {
      endMission(true, 'MISSION COMPLETE', 'Pedro 6-6 wheels up. Ghost 1-1 extracted. Good work, Spectre.');
    }
  }
}

function updateSquad(dt) {
  const alive = friendlies.filter(f => !f.dead);
  if (alive.length === 0) {
    endMission(false, 'MISSION FAILED', 'Ghost 1-1 is gone. We lost the whole team.');
    return;
  }
  const leader = alive[0];
  const wp = WAYPOINTS[Math.min(state.wpIndex, WAYPOINTS.length - 1)];

  // squad halts to fight when enemies are close
  let nearestD = Infinity;
  for (const e of enemies) if (!e.dead) nearestD = Math.min(nearestD, dist(leader.x, leader.y, e.x, e.y));
  const advancing = nearestD > 300 && !state.atLZ;

  if (advancing) {
    const d = dist(leader.x, leader.y, wp[0], wp[1]);
    if (d < 40) {
      if (state.wpIndex >= WAYPOINTS.length - 1) {
        state.atLZ = true;
        radio(`Ghost 1-1 at the LZ. Holding for extract — ${HOLD_TIME} seconds out.`);
      } else {
        state.wpIndex++;
        radio('Ghost 1-1 passing phase line, continuing to move.');
      }
    } else {
      const vx = (wp[0] - leader.x) / d, vy = (wp[1] - leader.y) / d;
      leader.x += vx * SQUAD_SPEED * dt;
      leader.y += vy * SQUAD_SPEED * dt;
    }
  }

  for (const f of alive) {
    if (f !== leader) {
      const tx = leader.x + f.off[0], ty = leader.y + f.off[1];
      const d = dist(f.x, f.y, tx, ty);
      if (d > 6) {
        f.x += (tx - f.x) / d * Math.min(42, d * 2) * dt;
        f.y += (ty - f.y) / d * Math.min(42, d * 2) * dt;
      }
    }
    // return fire
    f.flash = Math.max(0, f.flash - dt);
    let tgt = null, best = FRIEND_RANGE;
    for (const e of enemies) {
      if (e.dead) continue;
      const d = dist(f.x, f.y, e.x, e.y);
      if (d < best) { best = d; tgt = e; }
    }
    if (tgt) {
      tgt.hp -= FRIEND_DPS * dt;
      f.fireT -= dt;
      if (f.fireT <= 0) {
        f.fireT = rnd(0.25, 0.7);
        f.flash = 0.07;
        f.fx = tgt.x; f.fy = tgt.y;
      }
      if (tgt.hp <= 0) killEnemy(tgt);
    }
  }
}

function updateEnemies(dt) {
  const alive = friendlies.filter(f => !f.dead);
  let friendlyDied = false;

  for (const e of enemies) {
    if (e.dead) continue;
    e.flash = Math.max(0, e.flash - dt);

    let tgt = null, best = Infinity;
    for (const f of alive) {
      const d = dist(e.x, e.y, f.x, f.y);
      if (d < best) { best = d; tgt = f; }
    }
    if (!tgt) continue;

    if (best > e.range) {
      const vx = (tgt.x - e.x) / best, vy = (tgt.y - e.y) / best;
      e.heading = Math.atan2(vy, vx);
      let nx = e.x + vx * e.speed * dt;
      let ny = e.y + vy * e.speed * dt;
      // slide around standing buildings
      if (pointInBuilding(nx, ny)) {
        if (!pointInBuilding(nx, e.y)) ny = e.y;
        else if (!pointInBuilding(e.x, ny)) nx = e.x;
        else { nx = e.x; ny = e.y; }
      }
      e.x = nx; e.y = ny;
    } else {
      tgt.hp -= e.dps * dt;
      e.fireT -= dt;
      if (e.fireT <= 0) {
        e.fireT = e.type === 'technical' ? rnd(0.12, 0.3) : rnd(0.4, 1.1);
        e.flash = 0.07;
        e.fx = tgt.x; e.fy = tgt.y;
      }
      if (tgt.hp <= 0 && !tgt.dead) {
        tgt.dead = true;
        state.friendlyLost++;
        stampBody(tgt.x, tgt.y);
        friendlyDied = true;
      }
    }
  }

  if (friendlyDied) {
    const left = friendlies.filter(f => !f.dead).length;
    if (left > 0) radio(`Man down! Man down! ${left} effective, we need that fire support NOW!`);
  }
  enemies = enemies.filter(e => !e.dead);
}

// ============================================================ RENDER

function render() {
  const shx = (Math.random() - 0.5) * state.shake * 2;
  const shy = (Math.random() - 0.5) * state.shake * 2;
  // slow sensor drift
  const wobX = Math.sin(state.t * 0.6) * 2.2 + Math.sin(state.t * 1.7) * 1.1;
  const wobY = Math.cos(state.t * 0.5) * 2.2 + Math.sin(state.t * 1.3) * 1.1;

  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.fillStyle = '#161616';
  wctx.fillRect(0, 0, W, H);

  wctx.save();
  wctx.translate(W / 2 + shx + wobX, H / 2 + shy + wobY);
  wctx.scale(cam.zoom, cam.zoom * TILT);   // oblique gunner view, not straight top-down
  wctx.rotate(-cam.a);
  wctx.translate(-cam.x, -cam.y);

  wctx.drawImage(ground, 0, 0);

  drawFlashes();
  drawEnemies();
  drawFriendlies();
  drawShellTracers();
  drawFx();

  wctx.restore();

  // film grain + scanlines + vignette (on world canvas so polarity inverts them too)
  const tile = noiseTiles[Math.floor(state.t * 24) % 3];
  if (tile) {
    wctx.save();
    wctx.globalAlpha = 0.55;
    const pat = wctx.createPattern(tile, 'repeat');
    wctx.fillStyle = pat;
    wctx.translate(irnd(0, 128), irnd(0, 128));
    wctx.fillRect(-256, -256, W + 512, H + 512);
    wctx.restore();
  }
  wctx.fillStyle = 'rgba(0,0,0,0.10)';
  for (let y = 0; y < H; y += 4) wctx.fillRect(0, y, W, 1);
  const vg = wctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.38, W / 2, H / 2, Math.max(W, H) * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.72)');
  wctx.fillStyle = vg;
  wctx.fillRect(0, 0, W, H);

  renderHUD();
}

function drawFriendlies() {
  const strobe = Math.floor(state.t * 4) % 2 === 0;
  for (const f of friendlies) {
    if (f.dead) continue;
    if (f.flash > 0 && f.fx !== undefined) {
      wctx.strokeStyle = 'rgba(255,255,255,0.85)';
      wctx.lineWidth = 1.6;
      const d = dist(f.x, f.y, f.fx, f.fy);
      wctx.beginPath();
      wctx.moveTo(f.x, f.y);
      wctx.lineTo(f.x + (f.fx - f.x) / d * Math.min(d, 46), f.y + (f.fy - f.y) / d * Math.min(d, 46));
      wctx.stroke();
    }
    wctx.fillStyle = '#f4f4f4';
    wctx.beginPath(); wctx.arc(f.x, f.y, 5, 0, 7); wctx.fill();
    if (strobe) {
      // IR strobe cross
      wctx.strokeStyle = 'rgba(255,255,255,0.95)';
      wctx.lineWidth = 2.5;
      wctx.beginPath();
      wctx.moveTo(f.x - 14, f.y); wctx.lineTo(f.x + 14, f.y);
      wctx.moveTo(f.x, f.y - 14); wctx.lineTo(f.x, f.y + 14);
      wctx.stroke();
      wctx.strokeStyle = 'rgba(255,255,255,0.35)';
      wctx.beginPath(); wctx.arc(f.x, f.y, 20, 0, 7); wctx.stroke();
    }
  }
}

function drawEnemies() {
  for (const e of enemies) {
    if (e.flash > 0 && e.fx !== undefined) {
      wctx.strokeStyle = 'rgba(255,255,255,0.8)';
      wctx.lineWidth = 1.4;
      const d = dist(e.x, e.y, e.fx, e.fy);
      wctx.beginPath();
      wctx.moveTo(e.x, e.y);
      wctx.lineTo(e.x + (e.fx - e.x) / d * Math.min(d, 60), e.y + (e.fy - e.y) / d * Math.min(d, 60));
      wctx.stroke();
    }
    if (e.type === 'technical') {
      wctx.save();
      wctx.translate(e.x, e.y);
      wctx.rotate(e.heading);
      wctx.fillStyle = '#a9a9a9';
      wctx.fillRect(-13, -7, 26, 14);
      wctx.fillStyle = '#ffffff';           // hot engine block
      wctx.beginPath(); wctx.arc(8, 0, 4.5, 0, 7); wctx.fill();
      wctx.fillStyle = '#e8e8e8';           // gunner
      wctx.beginPath(); wctx.arc(-5, 0, 3.5, 0, 7); wctx.fill();
      wctx.restore();
    } else {
      wctx.fillStyle = 'rgba(255,255,255,0.25)';
      wctx.beginPath(); wctx.arc(e.x, e.y, e.r + 3.5, 0, 7); wctx.fill();
      wctx.fillStyle = '#f0f0f0';
      wctx.beginPath(); wctx.arc(e.x, e.y, e.r, 0, 7); wctx.fill();
    }
  }
}

function drawShellTracers() {
  for (const s of shells) {
    const rem = s.t;
    if (rem < 0.22) {
      // incoming round streak, direction fixed in screen space (guns on the left)
      const [dx, dy] = screenToWorldVec(-0.75, -0.66);   // unit-ish vector / zoom
      const len = (s.wep === 0 ? 90 : 170) * (rem / 0.22 + 0.3) * cam.zoom;
      wctx.strokeStyle = `rgba(255,255,255,${0.9 - rem * 2})`;
      wctx.lineWidth = s.wep === 2 ? 3.5 : 1.8;
      wctx.beginPath();
      wctx.moveTo(s.tx + dx * len, s.ty + dy * len);
      wctx.lineTo(s.tx, s.ty);
      wctx.stroke();
    }
  }
}

function drawFlashes() {
  for (const fl of flashes) {
    wctx.fillStyle = `rgba(255,255,255,${fl.t * 6})`;
    wctx.beginPath(); wctx.arc(fl.x, fl.y, fl.r, 0, 7); wctx.fill();
  }
}

function drawFx() {
  for (const f of fx) {
    const p = f.t / f.dur;
    if (p < 0.25) {
      // white-hot flash
      const q = p / 0.25;
      wctx.fillStyle = `rgba(255,255,255,${1 - q * 0.4})`;
      wctx.beginPath(); wctx.arc(f.x, f.y, f.r * (0.4 + q * 1.1), 0, 7); wctx.fill();
    }
    // cooling smoke
    const q = clamp((p - 0.1) / 0.9, 0, 1);
    const c = Math.floor(200 - 150 * q);
    wctx.fillStyle = `rgba(${c},${c},${c},${0.55 * (1 - q)})`;
    wctx.beginPath();
    wctx.arc(f.x - q * 12, f.y - q * 18, f.r * (0.7 + q * 1.6), 0, 7);
    wctx.fill();
  }
}

// ---------------------------- HUD

function renderHUD() {
  hctx.setTransform(1, 0, 0, 1, 0, 0);
  hctx.clearRect(0, 0, W, H);
  if (!state.running) return;

  const white = 'rgba(235,242,235,0.92)';
  const dim = 'rgba(235,242,235,0.55)';
  hctx.strokeStyle = white;
  hctx.fillStyle = white;
  hctx.lineWidth = 1.5;
  hctx.font = '13px Consolas, Menlo, monospace';

  const cx = W / 2, cy = H / 2;

  // crosshair
  const gap = 26, arm = 60;
  hctx.beginPath();
  hctx.moveTo(cx - gap - arm, cy); hctx.lineTo(cx - gap, cy);
  hctx.moveTo(cx + gap, cy); hctx.lineTo(cx + gap + arm, cy);
  hctx.moveTo(cx, cy - gap - arm); hctx.lineTo(cx, cy - gap);
  hctx.moveTo(cx, cy + gap); hctx.lineTo(cx, cy + gap + arm);
  hctx.stroke();
  hctx.strokeRect(cx - 3, cy - 3, 6, 6);
  hctx.strokeStyle = dim;
  hctx.strokeRect(cx - 130, cy - 130, 260, 260);
  hctx.strokeStyle = white;

  // top-left block
  hctx.textAlign = 'left';
  const mm = Math.floor(state.t / 60), ss = Math.floor(state.t % 60);
  hctx.fillText('SPECTRE 1-3', 24, 32);
  hctx.fillStyle = dim;
  hctx.fillText(`IR ${state.blackhot ? 'BHOT' : 'WHOT'}   FOV ${['WIDE', 'MED', 'NARO'][cam.zi]}`, 24, 52);
  hctx.fillText('ALT 12,500   GS 145', 24, 70);
  hctx.fillText(`TOS ${mm}:${String(ss).padStart(2, '0')}`, 24, 88);

  // heading (view rotates, so heading changes as we orbit)
  const hdg = Math.round(cam.a * 180 / Math.PI) % 360;
  hctx.fillStyle = white;
  hctx.textAlign = 'center';
  hctx.fillText(`HDG ${String(hdg).padStart(3, '0')}`, cx, 32);

  // weapon panel, bottom-left
  hctx.textAlign = 'left';
  let wy = H - 118;
  for (let i = 0; i < WEAPONS.length; i++) {
    const sel = i === state.wep;
    const ws = weaponState[i];
    hctx.fillStyle = sel ? white : dim;
    let status;
    if (ws.reloading > 0) status = `LOADING ${Math.ceil(ws.reloading)}s`;
    else status = `${ws.ammo}/${WEAPONS[i].mag}`;
    hctx.fillText(`${sel ? '▶' : ' '} ${i + 1}  ${WEAPONS[i].name.padEnd(16)} ${status}`, 24, wy);
    if (sel && ws.reloading > 0) {
      const p = 1 - ws.reloading / WEAPONS[i].reload;
      hctx.strokeStyle = dim;
      hctx.strokeRect(24, wy + 8, 200, 6);
      hctx.fillStyle = dim;
      hctx.fillRect(24, wy + 8, 200 * p, 6);
    }
    wy += 30;
  }
  hctx.fillStyle = 'rgba(235,242,235,0.35)';
  hctx.fillText('RMB / Q — NEXT WEAPON', 24, wy);

  // mission block, top-right
  hctx.textAlign = 'right';
  hctx.fillStyle = white;
  hctx.fillText(`HOSTILES KIA ${state.kills}`, W - 24, 32);
  const alive = friendlies.filter(f => !f.dead).length;
  hctx.fillStyle = alive < 4 ? 'rgba(240,180,140,0.95)' : dim;
  hctx.fillText(`GHOST 1-1  ${alive}/6 UP`, W - 24, 52);
  hctx.fillStyle = dim;
  if (state.atLZ) {
    hctx.fillStyle = white;
    hctx.fillText(`EXTRACT IN ${Math.max(0, Math.ceil(state.holdT))}s — HOLD THE LZ`, W - 24, 72);
  } else {
    hctx.fillText(`PHASE ${state.wpIndex}/${WAYPOINTS.length - 1} — MOVING TO LZ`, W - 24, 72);
  }

  // squad locator arrow when squad is off-screen
  drawSquadLocator(cx, cy, dim);

  // danger close warning when aiming near friendlies
  let nearF = Infinity;
  for (const f of friendlies) if (!f.dead) nearF = Math.min(nearF, dist(cam.x, cam.y, f.x, f.y));
  if (nearF < 170 && Math.floor(state.t * 3) % 2 === 0) {
    hctx.textAlign = 'center';
    hctx.fillStyle = 'rgba(250,210,160,0.95)';
    hctx.font = 'bold 15px Consolas, Menlo, monospace';
    hctx.fillText('⚠ DANGER CLOSE — FRIENDLIES ⚠', cx, cy + 165);
    hctx.font = '13px Consolas, Menlo, monospace';
  }

  // radio log, bottom-right
  hctx.textAlign = 'right';
  let ry = H - 28 - (radioLines.length - 1) * 20;
  for (const line of radioLines) {
    const shown = line.text.slice(0, Math.floor(line.reveal));
    const age = line.t;
    hctx.fillStyle = `rgba(210,230,210,${clamp(1.2 - age / 9, 0.15, 0.95)})`;
    hctx.fillText(`» ${shown}`, W - 24, ry);
    ry += 20;
  }
}

function drawSquadLocator(cx, cy, color) {
  const alive = friendlies.filter(f => !f.dead);
  if (!alive.length) return;
  let sx = 0, sy = 0;
  for (const f of alive) { sx += f.x; sy += f.y; }
  sx /= alive.length; sy /= alive.length;
  // world -> screen
  const dx = sx - cam.x, dy = sy - cam.y;
  const c = Math.cos(-cam.a), s = Math.sin(-cam.a);
  const px = (dx * c - dy * s) * cam.zoom;
  const py = (dx * s + dy * c) * cam.zoom * TILT;
  if (Math.abs(px) < W / 2 - 60 && Math.abs(py) < H / 2 - 60) return;
  const ang = Math.atan2(py, px);
  const rr = Math.min(W, H) / 2 - 70;
  const ax = cx + Math.cos(ang) * rr, ay = cy + Math.sin(ang) * rr;
  hctx.save();
  hctx.translate(ax, ay);
  hctx.rotate(ang);
  hctx.fillStyle = color;
  hctx.beginPath();
  hctx.moveTo(12, 0); hctx.lineTo(-6, -7); hctx.lineTo(-6, 7);
  hctx.closePath(); hctx.fill();
  hctx.restore();
  hctx.fillStyle = color;
  hctx.textAlign = 'center';
  hctx.fillText('GHOST', ax - Math.cos(ang) * 32, ay - Math.sin(ang) * 32 + 4);
}

// ============================================================ INPUT

function isLocked() { return document.pointerLockElement === hudCanvas; }

function cycleWeapon() {
  state.wep = (state.wep + 1) % WEAPONS.length;
  state.firing = false;
  sfx('beep');
}

hudCanvas.addEventListener('mousedown', e => {
  if (!state.running || state.over) return;
  if (!isLocked()) { hudCanvas.requestPointerLock(); return; }
  if (e.button === 0) { state.firing = true; state.firedThisPress = false; }
  if (e.button === 2) cycleWeapon();
});
window.addEventListener('contextmenu', e => e.preventDefault());
window.addEventListener('mouseup', e => {
  if (e.button === 0) { state.firing = false; state.firedThisPress = false; }
});

window.addEventListener('mousemove', e => {
  if (!isLocked() || state.paused || state.over) return;
  const [wx, wy] = screenToWorldVec(e.movementX, e.movementY);
  cam.x = clamp(cam.x + wx, 150, MAP - 150);
  cam.y = clamp(cam.y + wy, 150, MAP - 150);
});

window.addEventListener('wheel', e => {
  if (!state.running) return;
  cam.zi = clamp(cam.zi + (e.deltaY < 0 ? 1 : -1), 0, ZOOMS.length - 1);
  cam.zoom = ZOOMS[cam.zi];
});

window.addEventListener('keydown', e => {
  if (!state.running) return;
  if (e.code === 'Digit1') state.wep = 0;
  if (e.code === 'Digit2') state.wep = 1;
  if (e.code === 'Digit3') state.wep = 2;
  if (e.code === 'KeyQ') cycleWeapon();
  if (e.code === 'Tab') { e.preventDefault(); cycleWeapon(); }
  if (e.code === 'KeyN') {
    state.blackhot = !state.blackhot;
    worldCanvas.classList.toggle('blackhot', state.blackhot);
  }
});

document.addEventListener('pointerlockchange', () => {
  if (!state.running || state.over) return;
  if (!isLocked()) {
    state.paused = true;
    state.firing = false;
    document.getElementById('pause').classList.remove('hidden');
  } else {
    state.paused = false;
    document.getElementById('pause').classList.add('hidden');
  }
});

document.getElementById('btnStart').addEventListener('click', () => {
  initAudio();
  document.getElementById('start').classList.add('hidden');
  startGame();
  hudCanvas.requestPointerLock();
});

document.getElementById('btnRestart').addEventListener('click', () => {
  document.getElementById('end').classList.add('hidden');
  startGame();
  hudCanvas.requestPointerLock();
});

document.getElementById('btnResume').addEventListener('click', () => {
  document.getElementById('pause').classList.add('hidden');
  hudCanvas.requestPointerLock();
});

// ============================================================ LOOP

function resize() {
  W = window.innerWidth; H = window.innerHeight;
  worldCanvas.width = W; worldCanvas.height = H;
  hudCanvas.width = W; hudCanvas.height = H;
}
window.addEventListener('resize', resize);
resize();

// debug: ?autostart skips the menu; &ff=N fast-forwards N sim seconds (headless smoke tests)
if (location.search.includes('autostart')) {
  document.getElementById('start').classList.add('hidden');
  try { initAudio(); } catch (e) { /* no audio in headless */ }
  startGame();
  const ff = Number((location.search.match(/ff=(\d+)/) || [])[1] || 0);
  const autofire = location.search.includes('autofire');
  for (let i = 0; i < ff * 60 && !state.over; i++) {
    if (autofire && enemies.length) {
      let best = Infinity, tgt = null;
      for (const e of enemies) {
        const d = dist(e.x, e.y, cam.x, cam.y);
        if (d < best) { best = d; tgt = e; }
      }
      if (tgt) { cam.x = tgt.x; cam.y = tgt.y; }
      state.wep = Math.floor(i / 420) % 3;
      state.firing = true;
      if (i % 90 === 0) state.firedThisPress = false;
    }
    update(1 / 60);
  }
}

let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (state.running && !state.paused) {
    update(dt);
    for (const line of radioLines) {
      line.t += dt;
      line.reveal = Math.min(line.text.length, line.reveal + dt * 55);
    }
  }
  if (state.running) render();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
