import {Minimap} from './Minimap';
import {PHASES} from '../sim/director';
import {HOLD_SECONDS} from '../sim/route';
import type {Sim} from '../sim/sim';
import {WEAPONS} from '../sim/weapons';
import {ZOOM_LABELS} from '../render/GunshipCamera';
import type {Difficulty, Mode, Status} from '../sim/types';

export interface HudCallbacks {
  start(mode: Mode, difficulty: Difficulty): void;
  pause(): void;
  resume(): void;
  menu(): void;
  weapon(index: number): void;
  polarity(): void;
  zoom(delta: number): void;
  reload(): void;
  weaponsFree(): void;
  mute(): boolean;
  voice(): boolean;
  fire(down: boolean): void;
  hold(): void;
  target(): void;
  pan(key: string, down: boolean): void;
}

const pad = (n: number) => Math.floor(n).toString().padStart(2, '0');
const timecode = (t: number) =>
  `${pad(t / 3600)}:${pad(t / 60 % 60)}:${pad(t % 60)}:${pad(t % 1 * 30)}`;

export class HUD {
  root: HTMLElement;
  mode: Mode = 'score';
  difficulty: Difficulty = 'normal';
  minimap = new Minimap();
  onControls = false;
  private el: Record<string, HTMLElement> = {};
  private lastRadioSequence = -1;

  constructor(root: HTMLElement, private cb: HudCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = TEMPLATE;
    root.appendChild(this.root);
    for (const node of Array.from(this.root.querySelectorAll<HTMLElement>('[data-id]'))) {
      this.el[node.dataset.id!] = node;
    }
    this.el.map.appendChild(this.minimap.canvas);
    this.bind();
    this.screen('menu');
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  private resize() {
    // The minimap is sized off the short edge so it never eats a phone screen.
    const size = Math.round(Math.max(122, Math.min(206, Math.min(innerWidth, innerHeight) * 0.26)));
    this.minimap.resize(size);
  }

  private q<E extends HTMLElement = HTMLElement>(selector: string) {
    return this.root.querySelector<E>(selector)!;
  }

  private bind() {
    const on = (selector: string, handler: (e: Event) => void) =>
      this.q(selector).addEventListener('click', handler);

    for (const button of Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-mode]'))) {
      button.addEventListener('click', () => {
        this.mode = button.dataset.mode as Mode;
        this.syncChoices();
      });
    }
    for (const button of Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-diff]'))) {
      button.addEventListener('click', () => {
        this.difficulty = button.dataset.diff as Difficulty;
        this.syncChoices();
      });
    }
    on('[data-id=launch]', () => this.cb.start(this.mode, this.difficulty));
    on('[data-id=resume]', () => this.cb.resume());
    on('[data-id=abort]', () => this.cb.menu());
    on('[data-id=again]', () => this.cb.start(this.mode, this.difficulty));
    on('[data-id=toMenu]', () => this.cb.menu());
    on('[data-id=help]', () => this.controls(true));
    on('[data-id=helpClose]', () => this.controls(false));
    on('[data-id=sound]', () => {
      const muted = this.cb.mute();
      this.el.sound.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
      this.el.sound.classList.toggle('off', muted);
    });
    on('[data-id=vox]', () => {
      const voice = this.cb.voice();
      this.el.vox.textContent = voice ? 'VOX ON' : 'VOX OFF';
      this.el.vox.classList.toggle('off', !voice);
    });

    // Touch controls. Each one calls the same entry point the keyboard uses.
    const press = (selector: string, down: () => void, up?: () => void) => {
      const node = this.q(selector);
      node.addEventListener('pointerdown', e => {
        e.preventDefault();
        node.setPointerCapture(e.pointerId);
        down();
      });
      const release = () => up?.();
      node.addEventListener('pointerup', release);
      node.addEventListener('pointercancel', release);
      node.addEventListener('lostpointercapture', release);
    };
    press('[data-id=fireBtn]', () => this.cb.fire(true), () => this.cb.fire(false));
    for (const key of ['w', 'a', 's', 'd']) {
      press(`[data-pan=${key}]`, () => this.cb.pan(key, true), () => this.cb.pan(key, false));
    }
    for (let i = 0; i < 3; i++) press(`[data-weapon="${i}"]`, () => this.cb.weapon(i));
    press('[data-id=tZoomIn]', () => this.cb.zoom(1));
    press('[data-id=tZoomOut]', () => this.cb.zoom(-1));
    press('[data-id=tReload]', () => this.cb.reload());
    press('[data-id=tPolarity]', () => this.cb.polarity());
    press('[data-id=tTarget]', () => this.cb.target());
    press('[data-id=tHold]', () => this.cb.hold());
    press('[data-id=tFree]', () => this.cb.weaponsFree());
    press('[data-id=tPause]', () => this.cb.pause());
  }

  private syncChoices() {
    for (const b of Array.from(this.root.querySelectorAll<HTMLElement>('[data-mode]'))) {
      b.classList.toggle('on', b.dataset.mode === this.mode);
    }
    for (const b of Array.from(this.root.querySelectorAll<HTMLElement>('[data-diff]'))) {
      b.classList.toggle('on', b.dataset.diff === this.difficulty);
    }
  }

  ready() {
    this.el.launch.removeAttribute('disabled');
    this.el.loading.textContent = 'READY';
    this.syncChoices();
  }

  error(message: string) {
    this.el.loading.textContent = message;
  }

  screen(status: Status) {
    this.root.dataset.screen = status;
  }

  controls(open: boolean) {
    this.onControls = open;
    this.root.classList.toggle('controls-open', open);
  }

  reticle(x: number, y: number, spread: number) {
    const r = this.el.reticle;
    r.style.transform = `translate(${x}px, ${y}px)`;
    r.style.setProperty('--spread', `${spread}px`);
  }

  markers(html: string) {
    this.el.markers.innerHTML = html;
  }

  /**
   * Everything here is written from the frame loop. A readout that reflects
   * simulation state has to be rewritten by the loop that owns that state, or
   * it silently freezes while the game keeps running underneath it.
   */
  update(sim: Sim, opts: {polarity: string; zoomStep: number; angle: number; locked: boolean}) {
    const phase = PHASES[Math.max(0, sim.director.phase)];

    // Burned-in tape telemetry.
    this.el.tc.textContent = timecode(sim.time);
    this.el.alt.textContent = `ALT ${Math.round(13780 + Math.sin(opts.angle * 2) * 60)} FT`;
    this.el.bank.textContent = `BNK ${(Math.sin(opts.angle) * 22).toFixed(1).padStart(5)}°`;
    this.el.hdg.textContent = `HDG ${pad((opts.angle * 180 / Math.PI + 90) % 360 / 1)}`.slice(0, 7);
    this.el.sensor.textContent = `IR ${opts.polarity === 'BLACK HOT' ? 'BHOT' : 'WHOT'}`;
    this.el.fov.textContent = `FOV ${ZOOM_LABELS[opts.zoomStep]}`;
    this.el.lockTag.textContent = opts.locked ? 'AIM HELD' : '';

    // Mission strip.
    this.el.phase.textContent = `${sim.director.phase + 1}/5  ${phase.name}`;
    this.el.objective.textContent = phase.objective;
    this.el.routeFill.style.width = `${(sim.routeFraction * 100).toFixed(1)}%`;
    this.el.routeText.textContent = sim.atLZ
      ? `AT THE ZONE  ·  EXTRACT IN ${Math.ceil(sim.holdRemaining)}s`
      : `${Math.round(sim.routeFraction * 100)}% OF ROUTE  ·  ${sim.pinned ? 'COLUMN PINNED' : 'COLUMN MOVING'}`;
    this.el.routeText.classList.toggle('alert', sim.pinned || (sim.atLZ && sim.heloInbound));
    this.el.hold.classList.toggle('on', sim.atLZ);
    if (sim.atLZ) {
      this.el.holdFill.style.width = `${((1 - sim.holdRemaining / HOLD_SECONDS) * 100).toFixed(1)}%`;
      this.el.holdText.textContent = sim.heloInbound
        ? `PEDRO 6-6 INBOUND — CLEAR THE ZONE`
        : `HOLDING — ${Math.ceil(sim.holdRemaining)}s`;
    }

    // Escort readout: the two numbers the mission is actually about.
    this.el.civilians.textContent = `${sim.civilians.length + sim.stats.saved}/14`;
    this.el.operators.textContent = `${sim.operators.length}/6`;
    this.el.civilians.classList.toggle('alert', sim.stats.civilians > 0);
    this.el.operators.classList.toggle('alert', sim.operators.length <= 2);

    // Weapons.
    for (let i = 0; i < WEAPONS.length; i++) {
      const slot = sim.weapons.slots[i];
      const row = this.el[`w${i}`];
      row.classList.toggle('on', sim.weapons.selected === i);
      row.classList.toggle('empty', !slot.ammo && !slot.reserve);
      this.el[`w${i}ammo`].textContent = slot.reload > 0
        ? `RELOAD ${slot.reload.toFixed(1)}`
        : `${slot.ammo} / ${slot.reserve}`;
    }

    // Power bar.
    const free = sim.weaponsFree;
    this.el.power.classList.toggle('ready', sim.energy >= 100 && !free);
    this.el.power.classList.toggle('active', free);
    this.el.powerFill.style.width = free
      ? `${Math.max(0, (sim.weaponsFreeUntil - sim.time) / 12 * 100).toFixed(1)}%`
      : `${sim.energy.toFixed(0)}%`;
    this.el.powerText.textContent = free
      ? `WEAPONS FREE ${Math.ceil(sim.weaponsFreeUntil - sim.time)}s`
      : sim.energy >= 100 ? 'WEAPONS FREE READY — F' : 'POWER';

    this.el.danger.classList.toggle('on', sim.time < sim.dangerUntil);

    // Radio subtitles are the primary channel and never depend on voice.
    if (sim.radio.sequence !== this.lastRadioSequence) {
      this.lastRadioSequence = sim.radio.sequence;
      this.el.log.innerHTML = sim.radio.history
        .map((m, i) => `<li class="p${Math.min(6, m.priority)}" style="opacity:${(1 - i * 0.15).toFixed(2)}"><b>${m.speaker}</b> ${escapeHtml(m.text)}</li>`)
        .join('');
    }
    const current = sim.radio.current;
    this.el.subtitle.textContent = current ? `${current.speaker}: ${current.text}` : '';
    this.el.subtitle.className = current ? `subtitle on p${Math.min(6, current.priority)}` : 'subtitle';
  }

  result(sim: Sim) {
    const won = sim.status === 'won';
    const s = sim.stats;
    const response = s.responseCount ? (s.responseTotal / s.responseCount).toFixed(1) : '—';
    this.el.endTitle.textContent = won ? 'EXTRACTION COMPLETE' : 'MISSION FAILED';
    this.el.endTitle.className = won ? 'end-title' : 'end-title fail';
    this.el.endReason.textContent = sim.reason;
    this.el.grade.textContent = sim.grade;
    this.el.grade.dataset.grade = sim.grade;
    const rows: [string, string][] = [
      ['Civilians extracted', `${s.saved} of 14`],
      ['Civilian casualties', `${s.civilians}`],
      ['Operators remaining', `${sim.operators.length} of 6`],
      ['Replacements linked up', `${s.replacements}`],
      ['Route completed', `${Math.round(sim.routeFraction * 100)}%`],
      ['Mission time', timecode(sim.time).slice(3, 8)],
      ['Hostiles eliminated', `${s.kills} on foot, ${s.vehicles} vehicles`],
      ['Mortar tubes / rocket teams', `${s.mortars} / ${s.rpgs}`],
      ['Priority threats serviced', `${s.priority}`],
      ['Accuracy', `${sim.accuracy}%`],
      ['Average response to a call', `${response}s`],
      ['Friendly-fire incidents', `${s.friendlyFire}`],
      ['Rounds remaining', `${sim.weapons.remaining}`],
      ['Score', `${s.score}`],
    ];
    this.el.endStats.innerHTML = rows
      .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`)
      .join('');
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
}

const TEMPLATE = `
<div class="markers" data-id="markers"></div>
<div class="reticle" data-id="reticle"><i></i><i></i><i></i><i></i><b></b></div>
<div class="danger" data-id="danger">DANGER CLOSE</div>

<div class="tape tl">
  <div data-id="tc">00:00:00:00</div>
  <div data-id="alt">ALT 13780 FT</div>
  <div data-id="bank">BNK   0.0&deg;</div>
  <div data-id="hdg">HDG 000</div>
</div>
<div class="tape tr">
  <div data-id="sensor">IR WHOT</div>
  <div data-id="fov">FOV MED</div>
  <div data-id="lockTag"></div>
  <div class="tag">SPECTRE 1-3</div>
</div>

<div class="mission">
  <div class="phase" data-id="phase">1/5 DEPARTURE</div>
  <div class="objective" data-id="objective"></div>
  <div class="route"><i data-id="routeFill"></i></div>
  <div class="route-text" data-id="routeText"></div>
  <div class="hold" data-id="hold"><div class="route"><i data-id="holdFill"></i></div><span data-id="holdText"></span></div>
  <div class="escort">
    <span>CIV <b data-id="civilians">14/14</b></span>
    <span>GHOST <b data-id="operators">6/6</b></span>
  </div>
</div>

<aside class="map" data-id="map"></aside>

<div class="weapons">
  <div class="wrow" data-id="w0"><span>1</span><em>25 MM</em><i data-id="w0ammo"></i></div>
  <div class="wrow" data-id="w1"><span>2</span><em>40 MM</em><i data-id="w1ammo"></i></div>
  <div class="wrow" data-id="w2"><span>3</span><em>105 MM</em><i data-id="w2ammo"></i></div>
  <div class="power" data-id="power"><i data-id="powerFill"></i><span data-id="powerText">POWER</span></div>
</div>

<ul class="log" data-id="log"></ul>
<div class="subtitle" data-id="subtitle"></div>

<div class="touch">
  <div class="dpad">
    <button data-pan="w" aria-label="Pan up">&#9650;</button>
    <button data-pan="a" aria-label="Pan left">&#9664;</button>
    <button data-pan="d" aria-label="Pan right">&#9654;</button>
    <button data-pan="s" aria-label="Pan down">&#9660;</button>
  </div>
  <div class="pads">
    <button data-weapon="0">25</button>
    <button data-weapon="1">40</button>
    <button data-weapon="2">105</button>
    <button data-id="tReload">RLD</button>
    <button data-id="tZoomIn">Z+</button>
    <button data-id="tZoomOut">Z&minus;</button>
    <button data-id="tPolarity">IR</button>
    <button data-id="tTarget">TGT</button>
    <button data-id="tHold">HOLD</button>
    <button data-id="tFree">FREE</button>
    <button data-id="tPause">II</button>
  </div>
  <button class="fire" data-id="fireBtn">FIRE</button>
</div>

<div class="screen menu">
  <div class="panel">
    <h1>SPECTRE <span>&mdash; NIGHT WATCH</span></h1>
    <p class="brief">You are the sensor and guns of an AC-130 gunship &mdash; a fixed-wing aircraft
    that orbits a target area and fires from its left side. Ghost One-One is walking fourteen
    civilians across open country to a landing zone. The column only moves when the ground around
    it is clear, so every metre it gains is one you bought.</p>
    <p class="brief warn">Your sensor is infrared. Everyone on the ground is hot, so heat will
    never tell you who is who. A hostile carries something long and horizontal; a civilian carries
    a bundle or pushes a cart. Look before you fire.</p>
    <div class="choices">
      <div><label>Casualty rules</label>
        <div class="row">
          <button data-mode="score">SCORE</button>
          <button data-mode="hardcore">HARDCORE</button>
        </div>
        <small>Hardcore ends the mission on any civilian death, including one caused by enemy fire.</small>
      </div>
      <div><label>Difficulty</label>
        <div class="row">
          <button data-diff="easy">EASY</button>
          <button data-diff="normal">NORMAL</button>
          <button data-diff="hard">HARD</button>
        </div>
        <small>Difficulty also sets how long stale contacts linger on your map.</small>
      </div>
    </div>
    <button class="go" data-id="launch" disabled>BEGIN MISSION</button>
    <div class="row-small utility">
      <button data-id="help">CONTROLS</button>
      <button data-id="sound">SOUND ON</button>
      <button data-id="vox" class="off">VOX OFF</button>
    </div>
    <div class="loading" data-id="loading">LOADING</div>
  </div>
</div>

<div class="screen paused">
  <div class="panel">
    <h2>PAUSED</h2>
    <button class="go" data-id="resume">RESUME</button>
    <div class="row-small utility"><button data-id="abort">ABORT TO MENU</button></div>
  </div>
</div>

<div class="screen over">
  <div class="panel wide">
    <div class="end-head">
      <div><div class="end-title" data-id="endTitle"></div><p data-id="endReason"></p></div>
      <div class="grade" data-id="grade">&mdash;</div>
    </div>
    <div class="stats" data-id="endStats"></div>
    <div class="row-small utility">
      <button class="go" data-id="again">FLY IT AGAIN</button>
      <button data-id="toMenu">MENU</button>
    </div>
  </div>
</div>

<div class="screen help">
  <div class="panel wide">
    <h2>CONTROLS</h2>
    <div class="keys">
      <div><b>Mouse</b> aim the sensor</div>
      <div><b>Hold left mouse</b> fire</div>
      <div><b>1 / 2 / 3</b> 25 mm, 40 mm, 105 mm</div>
      <div><b>R</b> reload</div>
      <div><b>WASD / arrows</b> pan the view around the column</div>
      <div><b>Wheel or + / &minus;</b> zoom, five steps</div>
      <div><b>Q</b> infrared polarity, white hot / black hot</div>
      <div><b>Tab</b> slew to the next called-out threat</div>
      <div><b>Space</b> hold the aim point</div>
      <div><b>F</b> spend a full power bar for a weapons-free window</div>
      <div><b>Esc</b> pause</div>
    </div>
    <p class="brief">The map shows unclassified contacts only. It tells you where something is,
    never what it is &mdash; that judgement is yours, through the sensor, at zoom.</p>
    <div class="row-small utility"><button data-id="helpClose">CLOSE</button></div>
  </div>
</div>
`;
