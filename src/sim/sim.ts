import {Rng} from './rng';
import {MissionDirector, PHASES, type SpawnOrder} from './director';
import {RadioSystem} from './radio';
import {WeaponSystem, WEAPONS} from './weapons';
import {
  alongRoute, BEARING_LABEL, bearingOf, bearingPoint, buildings, HELO_INBOUND, HOLD_SECONDS,
  LZ, LZ_RADIUS, obstructed, ROUTE, ROUTE_LENGTH, rooftopNear,
} from './route';
import {
  approach, clamp, distance, person, priority, vehicle,
  type Bearing, type Building, type Contact, type Difficulty, type Entity, type Impact,
  type Kind, type Mode, type RadioMessage, type Shot, type Stats, type Status, type Trace, type Vec,
} from './types';

const CONFIG: Record<Kind, {hp: number; speed: number; range: number; damage: number; interval: number}> = {
  rifle: {hp: 65, speed: 2.1, range: 46, damage: 5, interval: 2.3},
  mg: {hp: 110, speed: 1.4, range: 78, damage: 9, interval: 2.2},
  rpg: {hp: 85, speed: 1.5, range: 95, damage: 24, interval: 7},
  mortar: {hp: 105, speed: 0.6, range: 460, damage: 18, interval: 9},
  technical: {hp: 260, speed: 8.4, range: 72, damage: 13, interval: 2.5},
  transport: {hp: 340, speed: 6.6, range: 60, damage: 0, interval: 8},
  assault: {hp: 750, speed: 4.6, range: 82, damage: 26, interval: 3.5},
  // The ground team suppresses; it does not clear. An earlier pass gave them
  // 96 m of reach and 20 damage per second each, and six of them vacuumed up
  // every wave before it got near the column — the gunship became optional and
  // all three difficulties finished identically. They are an escort now.
  operator: {hp: 280, speed: 3.4, range: 70, damage: 17, interval: 1.45},
  civilian: {hp: 40, speed: 2.9, range: 0, damage: 0, interval: 0},
};

/** Base marching pace of the column, metres per second. */
const COLUMN_SPEED = 2.45;
/** A living hostile inside this radius of the column head stops the column dead. */
const PIN_RADIUS = 95;
/** Kills between replacement operators linking up. Applies in both modes. */
const REPLACEMENT_EVERY = 22;
/** Seconds the weapons-free window stays open once spent. */
const WEAPONS_FREE_SECONDS = 12;
/** Energy gained per hostile killed; the bar runs 0-100. */
const ENERGY_PER_KILL = 5;
/** How long an unobserved contact stays on the minimap, by difficulty. */
const BLIP_LIFE: Record<Difficulty, number> = {easy: 22, normal: 14, hard: 8};
/** The helicopter will not touch down while hostiles are this close to the zone. */
const LZ_CLEAR_RADIUS = 170;
export const CIVILIAN_COUNT = 14;
export const OPERATOR_COUNT = 6;

/** Formation offsets as (forward, lateral) metres relative to the column head. */
const FORMATION: readonly [number, number][] = [
  [20, 0], [6, -15], [6, 15], [-16, -13], [-16, 13], [-28, 0],
];

export class Sim {
  status: Status = 'menu';
  time = 0;
  reason = '';
  entities: Entity[] = [];
  buildings: Building[] = buildings();
  shots: Shot[] = [];
  impacts: Impact[] = [];
  traces: Trace[] = [];
  contacts: Contact[] = [];
  radio = new RadioSystem();
  director: MissionDirector;
  weapons: WeaponSystem;
  stats: Stats = {
    kills: 0, vehicles: 0, mortars: 0, rpgs: 0, priority: 0,
    civilians: 0, friendly: 0, friendlyFire: 0, shots: 0, hits: 0,
    responseTotal: 0, responseCount: 0, saved: 0, replacements: 0, score: 0,
  };

  /** Metres the column has travelled along the route. */
  progress = 0;
  atLZ = false;
  held = 0;
  /** True once the helicopter has turned inbound and is audible. */
  heloInbound = false;
  heloLanded = false;
  /** Set while the column is stopped by contact; drives the radio and the HUD. */
  pinned = false;
  /** Power bar, 0-100. Full means the weapons-free window can be spent. */
  energy = 0;
  weaponsFreeUntil = -1;

  nextId = 1;
  private nextChatter = 26;
  dangerUntil = 0;
  private lastDanger = -10;
  selectedTarget: number | null = null;
  private rng: Rng;
  private detours = new Map<number, Vec>();

  constructor(public mode: Mode = 'score', public difficulty: Difficulty = 'normal', seed = 9341) {
    this.rng = new Rng(seed);
    this.director = new MissionDirector(difficulty, seed ^ 0x5f5f);
    this.weapons = new WeaponSystem(difficulty);
    const head = this.head;
    for (let i = 0; i < OPERATOR_COUNT; i++) {
      const e = this.spawn('operator', this.formationPoint(i), 'ahead');
      e.slot = i;
      e.cooldown = i * 0.15;
      e.maxHp = e.hp = e.maxHp * (difficulty === 'easy' ? 1.4 : difficulty === 'hard' ? 0.78 : 1);
    }
    for (let i = 0; i < CIVILIAN_COUNT; i++) {
      const lag = 8 + (i / CIVILIAN_COUNT) * 30 + this.rng.range(0, 6);
      const e = this.spawn('civilian', {x: head.position.x, z: head.position.z}, 'trailing');
      e.slot = i;
      e.lag = lag;
      // Lateral offset is kept modest so the column reads as a column, not a crowd.
      e.target = {x: this.rng.spread(9), z: 0};
      const p = this.columnSlot(e);
      e.x = p.x; e.z = p.z;
    }
  }

  // ---------------------------------------------------------------- geometry

  get head() {return alongRoute(this.progress);}

  /** Where operator `slot` should be standing right now. */
  private formationPoint(slot: number): Vec {
    const {position, heading} = this.head;
    const [forward, lateral] = FORMATION[slot % FORMATION.length];
    return {
      x: position.x + heading.x * forward + -heading.z * lateral,
      z: position.z + heading.z * forward + heading.x * lateral,
    };
  }

  /** Where civilian `e` should be walking, given its straggle lag. */
  private columnSlot(e: Entity): Vec {
    const back = alongRoute(Math.max(0, this.progress - e.lag));
    return {
      x: back.position.x + -back.heading.z * e.target.x,
      z: back.position.z + back.heading.x * e.target.x,
    };
  }

  // ---------------------------------------------------------------- entities

  spawn(kind: Kind, p: Vec, bearing: Bearing): Entity {
    const c = CONFIG[kind];
    const e: Entity = {
      id: this.nextId++, kind,
      side: kind === 'operator' ? 'friendly' : kind === 'civilian' ? 'civilian' : 'enemy',
      x: p.x, z: p.z, y: 0,
      hp: c.hp, maxHp: c.hp, speed: c.speed,
      cooldown: 2 + this.rng.next() * 4,
      born: this.time, marked: false, deployed: false, saved: false,
      target: {x: 0, z: 0}, slot: 0, lag: 0, panic: 0, panicFrom: {x: p.x, z: p.z},
      lastFired: -99, bearing,
    };
    this.entities.push(e);
    return e;
  }

  get operators() {return this.entities.filter(e => e.side === 'friendly' && e.hp > 0);}
  get civilians() {return this.entities.filter(e => e.side === 'civilian' && e.hp > 0 && !e.saved);}
  get enemies() {return this.entities.filter(e => e.side === 'enemy' && e.hp > 0);}
  get accuracy() {return this.stats.shots ? Math.round(this.stats.hits / this.stats.shots * 100) : 0;}
  get weaponsFree() {return this.time < this.weaponsFreeUntil;}
  get holdRemaining() {return Math.max(0, HOLD_SECONDS - this.held);}
  /** 0-1 along the whole route, for the HUD progress strip. */
  get routeFraction() {return clamp(this.progress / ROUTE_LENGTH, 0, 1);}

  start() {
    this.status = 'playing';
    this.say('Spectre One-Three on station, Ghost One-One. We have your strobes. Column is yours to move.', 3, undefined, 'SPECTRE');
    this.say(PHASES[0].radio, 3, undefined, 'GHOST 1-1');
  }

  say(text: string, priorityLevel = 1, targetId?: number, speaker = 'GHOST 1-1') {
    const message: RadioMessage = {speaker, text, priority: priorityLevel, duration: priorityLevel > 2 ? 6 : 5};
    if (targetId !== undefined) message.targetId = targetId;
    this.radio.push(message);
  }

  // ---------------------------------------------------------------- shooting

  fire(point: Vec, from: Vec) {
    if (this.status !== 'playing' || !this.weapons.fire()) return false;
    const wi = this.weapons.selected, w = WEAPONS[wi];
    this.stats.shots++;
    this.shots.push({id: this.nextId++, weapon: wi, x: point.x, z: point.z, from: {...from}, age: 0, travel: w.travel});
    if (this.entities.some(e => e.side !== 'enemy' && e.hp > 0 && !e.saved && distance(e, point) < w.radius + 7)) this.danger();
    return true;
  }

  /**
   * Frighten a civilian, recording what frightened them. Civilians run from the
   * thing that went off near them, which is what turns a loose round into a
   * scattered column rather than just a number on the scoreboard.
   */
  private scare(e: Entity, from: Vec, level: number) {
    if (e.side !== 'civilian' || e.hp <= 0 || e.saved) return;
    if (level <= e.panic) return;
    e.panic = level;
    e.panicFrom = {x: from.x, z: from.z};
  }

  danger() {
    this.dangerUntil = this.time + 3;
    if (this.time - this.lastDanger > 4) {
      this.say('Danger close! Check your fire — we have friendlies and civilians in that blast.', 5, undefined, 'GHOST 1-2');
      this.lastDanger = this.time;
    }
  }

  explode(shot: Pick<Shot, 'x' | 'z' | 'weapon'>) {
    const w = WEAPONS[shot.weapon];
    this.impacts.push({x: shot.x, z: shot.z, weapon: shot.weapon, radius: w.radius});
    let hit = false, friendlyIncident = false;
    for (const e of this.entities) {
      if (e.hp <= 0 || e.saved) continue;
      const d = distance(e, shot);
      if (d > w.radius + (vehicle(e.kind) ? 1.7 : 0.7)) continue;
      const damage = w.damage * (1 - clamp(d / w.radius, 0, 0.88) * 0.85);
      if (e.side === 'enemy') hit = true;
      if (e.side === 'friendly' && damage > 5) friendlyIncident = true;
      this.scare(e, shot, 6);
      this.damage(e, damage, 'player');
    }
    if (hit) this.stats.hits++;
    if (friendlyIncident) {
      this.stats.friendlyFire++;
      this.stats.score -= 750;
      this.danger();
      if (this.mode === 'hardcore' && shot.weapon >= 1) {
        this.fail('Major friendly-fire incident. Ghost was inside your blast radius.');
      }
    }
    // Civilians near any blast scatter, whether or not they were hurt.
    for (const c of this.entities) {
      if (distance(c, shot) < w.radius * 2.6) this.scare(c, shot, 4.5);
    }
    for (const b of this.buildings) {
      if (b.hp <= 0) continue;
      const d = Math.hypot(
        Math.max(0, Math.abs(b.x - shot.x) - b.width / 2),
        Math.max(0, Math.abs(b.z - shot.z) - b.depth / 2));
      if (d < w.radius) b.hp = Math.max(0, b.hp - w.damage * 0.32 * (1 - d / w.radius));
    }
  }

  damage(e: Entity, amount: number, source: 'player' | 'enemy' | 'friendly') {
    if (e.hp <= 0 || e.saved) return;
    e.hp = Math.max(0, e.hp - amount);
    if (e.hp > 0) return;

    if (e.side === 'enemy') {
      if (source === 'player') {
        if (vehicle(e.kind)) this.stats.vehicles++; else this.stats.kills++;
        if (e.kind === 'mortar') this.stats.mortars++;
        if (e.kind === 'rpg') this.stats.rpgs++;
        this.stats.score += vehicle(e.kind) ? 350 : 100;
        if (priority(e.kind)) {
          this.stats.priority++;
          this.stats.score += 150;
          if (e.marked) {this.stats.responseCount++; this.stats.responseTotal += this.time - e.born;}
        }
        if (e.kind === 'transport' && !e.deployed) {
          this.stats.score += 400;
          this.say('Transport down before dismount. That saved us a fight.', 1);
        } else if (e.marked) {
          this.say('Confirmed, priority threat is down.', 1);
        }
        this.gainEnergy();
      }
      if (vehicle(e.kind)) this.impacts.push({x: e.x, z: e.z, weapon: 1, radius: 7});
    } else if (e.side === 'civilian') {
      this.stats.civilians++;
      this.stats.score -= 2500;
      this.say('Civilian down! Cease fire, cease fire — recheck your targets!', 6, undefined, 'COMMAND');
      // Hardcore fails on any civilian death, including one caused by enemy fire.
      if (this.mode === 'hardcore') this.fail('Civilian casualty. The rules of engagement have been violated.');
      // Panic ripples outward from the body.
      for (const c of this.entities) if (distance(c, e) < 45) this.scare(c, e, 8);
    } else {
      this.stats.friendly++;
      this.stats.score -= 1500;
      this.say('Operator down! We are thinning out here!', 5);
      if (this.mode === 'hardcore' && source === 'player') {
        this.fail('Ghost operator killed by gunship fire.');
      }
    }
  }

  // ------------------------------------------------------------- feel layer

  private gainEnergy() {
    if (this.weaponsFree) return;
    this.energy = Math.min(100, this.energy + ENERGY_PER_KILL);
    const killed = this.stats.kills + this.stats.vehicles;
    if (killed > 0 && killed % REPLACEMENT_EVERY === 0) this.replaceOperator();
  }

  /**
   * A replacement operator links up on a kill threshold, so a bad early leg
   * does not silently doom the run. Available in both casualty modes: in
   * Hardcore it is the only way back from operator losses, and Hardcore is
   * already punishing enough through the civilian rule.
   */
  private replaceOperator() {
    const down = this.entities.find(e => e.side === 'friendly' && e.hp <= 0);
    if (!down) return;
    const p = this.formationPoint(down.slot);
    down.hp = down.maxHp * 0.6;
    down.x = p.x; down.z = p.z;
    down.cooldown = 1;
    this.stats.replacements++;
    this.say(`Replacement operator linked up. Ghost One-One is ${this.operators.length} effective.`, 2);
  }

  /** Spend a full power bar: faster guns, instant reloads, and a team patch-up. */
  spendWeaponsFree() {
    if (this.status !== 'playing' || this.energy < 100 || this.weaponsFree) return false;
    this.energy = 0;
    this.weaponsFreeUntil = this.time + WEAPONS_FREE_SECONDS;
    this.weapons.topUp();
    for (const f of this.operators) f.hp = Math.min(f.maxHp, f.hp + 60);
    this.say('Weapons free! Guns hot, Spectre — put it all down now.', 4, undefined, 'SPECTRE');
    return true;
  }

  // ------------------------------------------------------------------- loop

  update(dt: number) {
    if (this.status !== 'playing') return;
    this.time += dt;
    this.weapons.weaponsFree = this.weaponsFree;
    this.weapons.update(dt);
    this.radio.update(dt);

    const head = this.head;
    const event = this.director.update(this.time, head.leg, this.atLZ, this.held);
    if (event.phaseChanged) this.say(PHASES[this.director.phase].radio, 3, undefined, 'GHOST 1-1');
    for (const order of event.spawns) this.createSpawn(order, head);

    for (const shot of this.shots) {
      shot.age += dt;
      if (shot.age >= shot.travel) {this.explode(shot); shot.age = -999;}
    }
    this.shots = this.shots.filter(s => s.age >= 0);
    if (this.status !== 'playing') return;

    const operators = this.operators, enemies = this.enemies;
    for (const e of this.entities) {
      if (e.hp <= 0 || e.saved) continue;
      e.cooldown -= dt;
      if (e.panic > 0) e.panic -= dt;
      if (e.side === 'enemy') this.enemyAI(e, operators, dt);
      else if (e.side === 'friendly') this.operatorAI(e, enemies, dt);
      else this.civilianAI(e, dt);
    }

    this.advanceColumn(dt, enemies);
    this.updateContacts(dt, enemies);
    this.checkEnding(enemies);
    this.chatter(enemies);

    // Keep a bounded tail of wrecks; every living unit is always retained.
    if (this.entities.length > 210) {
      let dead = 0;
      this.entities = this.entities.filter(e => e.hp > 0 || (dead++ < 34 && vehicle(e.kind)));
    }
  }

  private createSpawn(order: SpawnOrder, head: ReturnType<typeof alongRoute>) {
    const base = bearingPoint(head.position, head.heading, order.bearing, order.range);
    // Wave members fan out along x so a group does not spawn stacked. Ambushes
    // get a much tighter scatter: the fan is sized for a wave arriving from
    // 150 m out, and applying it to a 60 m contact throws it back outside the
    // stopping distance, which is the one thing an ambush must not do.
    const fan = order.ambush ? 2.5 : 16;
    const p = {
      x: base.x + this.rng.spread(fan) + (order.ambush ? 0 : order.offset * 1.6),
      z: base.z + this.rng.spread(fan),
    };

    if (order.ambush) {
      // Come out of the nearest cover rather than standing up in open ground.
      // A close contact appearing from behind a wall is a surprise; the same
      // contact appearing on bare dirt is just a spawn the player missed.
      const cover = this.buildings
        .filter(b => b.hp > 0 && distance(b, p) < 45)
        .sort((a, b) => distance(a, p) - distance(b, p))[0];
      if (cover) {
        const away = Math.atan2(p.x - cover.x, p.z - cover.z);
        const reach = Math.max(cover.width, cover.depth) / 2 + 2.5;
        const edge = {x: cover.x + Math.sin(away) * reach, z: cover.z + Math.cos(away) * reach};
        // Only take the cover if it does not push the contact back out of
        // range. Cover is the flavour; being close is the mechanic.
        if (distance(edge, head.position) < PIN_RADIUS - 6) {p.x = edge.x; p.z = edge.z;}
      }
    }

    const e = this.spawn(order.kind, p, order.bearing);

    // Rocket teams take a rooftop if one is within reach; that is what makes the
    // chokepoint dangerous and what forces the player to look up, not just out.
    if (order.kind === 'rpg') {
      const roof = rooftopNear(p, this.buildings, 70);
      if (roof) {e.x = roof.x; e.z = roof.z; e.y = roof.height;}
    }
    if (order.kind === 'mortar') {e.target = {x: e.x, z: e.z};}

    if (order.ambush) {
      // Called as contact, not as a fire request. Nobody asks for air support
      // on something that is already inside the perimeter.
      e.marked = false;
      this.say(`Contact, close! ${BEARING_LABEL[order.bearing]} — danger close, watch the column!`, 4, e.id, 'GHOST 1-2');
      for (const c of this.entities) if (distance(c, e) < 40) this.scare(c, e, 4);
      return;
    }

    if (priority(order.kind)) {
      e.marked = true;
      const label = e.kind === 'assault' ? 'Heavy assault vehicle'
        : e.kind === 'technical' ? 'Technical'
        : e.kind === 'transport' ? 'Troop transport'
        : `${e.kind.toUpperCase()} team`;
      const urgency = e.kind === 'mortar' || e.kind === 'assault' ? 4 : 2;
      this.say(`${label} ${BEARING_LABEL[order.bearing]}! Request immediate fire.`, urgency, e.id);
    }
  }

  /**
   * The column only moves when the ground immediately around it is clear. This
   * is the whole loop: the player is not defending a place, they are buying
   * metres. Mortars sit outside this radius on purpose — they bleed you without
   * stopping you, so they have to be hunted rather than waited out.
   */
  private advanceColumn(dt: number, enemies: Entity[]) {
    if (this.atLZ) {
      this.held += dt;
      if (!this.heloInbound && this.holdRemaining <= HELO_INBOUND) {
        this.heloInbound = true;
        this.say('Pedro Six-Six is inbound, three zero seconds. Get that zone clear or he waves off.', 5, undefined, 'COMMAND');
      }
      return;
    }
    const head = this.head;
    const near = enemies.filter(e => distance(e, head.position) < PIN_RADIUS);
    this.pinned = near.length > 0;
    if (this.pinned) return;

    // Stragglers hold the column back; a scattered column walks at half pace.
    const behind = this.civilians.filter(c => distance(c, head.position) > c.lag + 34).length;
    const pace = behind > 3 ? 0.5 : behind > 0 ? 0.8 : 1;
    this.progress = Math.min(ROUTE_LENGTH, this.progress + COLUMN_SPEED * pace * dt);

    if (this.progress >= ROUTE_LENGTH - 0.01 && distance(head.position, LZ) < LZ_RADIUS + 4) {
      this.atLZ = true;
      this.say(PHASES[4].radio, 4, undefined, 'GHOST 1-1');
    }
  }

  /**
   * Unclassified sensor returns for the minimap. A contact is created by the
   * ground team noticing something, never by knowing what it is: the blip
   * carries a position and an expiry and nothing else. Classification is the
   * player's job, through the sensor, at zoom.
   */
  private updateContacts(dt: number, enemies: Entity[]) {
    void dt;
    const head = this.head.position;
    const life = BLIP_LIFE[this.difficulty];
    for (const e of enemies) {
      // Observed if it is close enough for the ground team to see, or if it
      // just fired and gave its position away. Neither says what it is.
      const observed = distance(e, head) < 240 || this.time - e.lastFired < 3;
      if (!observed) continue;
      const existing = this.contacts.find(c => c.id === e.id);
      if (existing) {existing.x = e.x; existing.z = e.z; existing.seen = this.time; existing.expires = this.time + life;}
      else this.contacts.push({id: e.id, x: e.x, z: e.z, seen: this.time, expires: this.time + life});
    }
    this.contacts = this.contacts.filter(c => c.expires > this.time);
  }

  private checkEnding(enemies: Entity[]) {
    if (!this.operators.length) {
      this.fail('Ghost One-One has been overrun. The escort is gone.');
      return;
    }
    if (!this.civilians.length && !this.stats.saved) {
      this.fail('There is no one left to escort.');
      return;
    }
    if (!this.atLZ || this.holdRemaining > 0) return;

    const nearZone = enemies.filter(e => distance(e, LZ) < LZ_CLEAR_RADIUS).length;
    if (nearZone > 0) {
      if (this.time > this.nextChatter) {
        this.nextChatter = this.time + 14;
        this.say(`Pedro Six-Six is holding off — ${nearZone} still up around the zone. Clear it, Spectre!`, 5, undefined, 'COMMAND');
      }
      return;
    }
    this.heloLanded = true;
    for (const c of this.civilians) {c.saved = true; this.stats.saved++;}
    this.status = 'won';
    this.reason = 'Pedro Six-Six is wheels up. Ghost One-One and the column are out.';
    this.stats.score += 2000 + this.stats.saved * 250 + this.operators.length * 200;
    this.say('Everyone is aboard. Pedro Six-Six wheels up. Outstanding work, Spectre.', 6, undefined, 'COMMAND');
  }

  private chatter(enemies: Entity[]) {
    if (this.time <= this.nextChatter) return;
    this.nextChatter = this.time + 24;
    const head = this.head.position;
    const close = enemies.filter(e => distance(e, head) < PIN_RADIUS).length;
    const panicking = this.civilians.filter(c => c.panic > 0).length;
    const hurt = this.operators.filter(o => o.hp < o.maxHp * 0.5).length;

    if (close > 6) {
      this.say(this.rng.pick([
        'We are pinned and taking it from every side! Get fire on them!',
        'They are all over us! Spectre, we need that gun now!',
        'Too many! We cannot hold this and move at the same time!',
      ]), 4);
    } else if (this.pinned) {
      this.say(this.rng.pick([
        'Column is stopped. We cannot move until that is off our axis.',
        'We are holding in place. Clear our front and we will step off again.',
        'Nobody is moving down here until you put that down, Spectre.',
      ]), 3);
    } else if (panicking > 4) {
      this.say(this.rng.pick([
        'Civilians are scattering — we are herding them back. Hold your fire.',
        'The column has broken up. Give us a moment to get them together.',
        'We have people running in the open. Check your targets, check them twice.',
      ]), 3, undefined, 'GHOST 1-2');
    } else if (hurt >= 2) {
      this.say(this.rng.pick([
        'We are taking casualties down here. Two of us are hurting.',
        'Ghost is getting thin, Spectre. We could use the pressure off.',
      ]), 3);
    } else if (this.atLZ) {
      this.say(this.rng.pick([
        `Holding the zone. ${Math.ceil(this.holdRemaining)} seconds to extract.`,
        'Zone is ours so far. Keep the approaches clear.',
        'Civilians are down flat at the pad. Just keep them off us.',
      ]), 2);
    } else {
      this.say(this.rng.pick([
        'Column is moving. Keep scanning our flanks.',
        'Good pace down here. Eyes on the high ground, Spectre.',
        'Still walking. Watch behind us — they like coming up the tail.',
        'Everyone is up and moving. Nothing on us right now.',
      ]), 1, undefined, 'GHOST 1-2');
    }
  }

  // --------------------------------------------------------------------- AI

  private enemyAI(e: Entity, operators: Entity[], dt: number) {
    const c = CONFIG[e.kind];
    const head = this.head.position;
    let target: Entity | undefined;
    let bestD = Infinity;
    for (const f of operators) {
      const d = distance(e, f);
      if (d < bestD) {bestD = d; target = f;}
    }
    const goal: Vec = target ?? head;
    const dist = distance(e, goal);

    if (e.kind === 'transport' && !e.deployed && distance(e, head) < 150) {
      e.deployed = true;
      for (let i = 0; i < 5; i++) {
        this.spawn(i === 4 ? 'mg' : 'rifle', {x: e.x + i * 2.4 - 4.8, z: e.z + 4}, e.bearing);
      }
      this.say('Transport is dumping infantry. They are in the open right now.', 3, e.id);
    }
    // A rocket team loses its perch when the building under it comes down.
    if (e.kind === 'rpg' && e.y > 0) {
      const under = this.buildings.find(b => Math.abs(e.x - b.x) < 1.5 && Math.abs(e.z - b.z) < 1.5);
      if (under && under.hp <= 0) {e.y = 0; this.damage(e, 80, 'player');}
    }

    const stationary = e.kind === 'mortar' || e.y > 0;
    if (dist > c.range && !stationary) {
      const step = e.speed * dt
        * (this.difficulty === 'hard' ? 1.12 : 1)
        * (vehicle(e.kind) && e.hp < e.maxHp * 0.35 ? 0.45 : 1);
      this.move(e, goal, step);
      return;
    }
    if (e.cooldown > 0) return;
    e.cooldown = c.interval + this.rng.next() * 0.8;
    e.lastFired = this.time;

    if (e.kind === 'mortar') {
      // Tubes walk rounds onto the column. They do not aim at civilians, but
      // the column is what they are ranging on, and the civilians are in it.
      const aim = {x: head.x + this.rng.spread(16), z: head.z + this.rng.spread(16)};
      this.impacts.push({x: aim.x, z: aim.z, radius: 5, weapon: -1});
      for (const f of operators) if (distance(f, aim) < 8) this.damage(f, c.damage, 'enemy');
      for (const civ of this.entities) {
        if (civ.side !== 'civilian' || civ.hp <= 0 || civ.saved) continue;
        const d = distance(civ, aim);
        if (d < 5) {this.scare(civ, aim, 7); this.damage(civ, 14, 'enemy');}
        else if (d < 30) this.scare(civ, aim, 6);
      }
      for (const b of this.buildings) if (distance(b, aim) < 14) b.hp = Math.max(0, b.hp - 16);
      return;
    }
    if (e.kind === 'transport') return;
    if (target) {
      const scale = this.difficulty === 'easy' ? 0.65 : this.difficulty === 'hard' ? 1.3 : 1;
      this.damage(target, c.damage * scale, 'enemy');
      this.traces.push({from: {x: e.x, z: e.z}, to: {x: target.x, z: target.z}, hostile: true});
      for (const civ of this.entities) if (distance(civ, e) < 55) this.scare(civ, e, 5);
    }
  }

  private operatorAI(e: Entity, enemies: Entity[], dt: number) {
    const range = CONFIG.operator.range;
    const inRange = enemies.filter(n => distance(e, n) < range);
    const post = this.formationPoint(e.slot);
    // Under heavy pressure operators collapse inward onto the civilians.
    const pressure = inRange.filter(n => distance(e, n) < 46).length;
    const head = this.head.position;
    const dest = pressure > 4 || e.hp < e.maxHp * 0.35
      ? {x: (post.x + head.x) / 2, z: (post.z + head.z) / 2}
      : post;
    this.move(e, dest, e.speed * dt);

    if (inRange.length && e.cooldown <= 0) {
      let target = inRange[0], bestD = distance(e, target);
      for (const n of inRange) {
        const d = distance(e, n);
        if (d < bestD) {bestD = d; target = n;}
      }
      e.cooldown = CONFIG.operator.interval;
      e.lastFired = this.time;
      this.damage(target, CONFIG.operator.damage, 'friendly');
      this.traces.push({from: {x: e.x, z: e.z}, to: {x: target.x, z: target.z}, hostile: false});
    }
    if (!inRange.length) e.hp = Math.min(e.maxHp, e.hp + dt * 2.0);
  }

  /**
   * Civilians are the escorted party, not set dressing. They walk their slot in
   * the column, bunch toward each other when calm, and scatter away from the
   * nearest threat when something goes off near them. That is what makes
   * danger-close continuous rather than scripted.
   */
  private civilianAI(e: Entity, dt: number) {
    if (this.heloLanded) return;
    if (e.panic > 0) {
      // Run from whatever scared them, unless a living hostile is now nearer
      // than that — a body or a crater stops mattering once a gun is closer.
      let flee: Vec = e.panicFrom, bestD = distance(e, e.panicFrom);
      for (const n of this.entities) {
        if (n.side !== 'enemy' || n.hp <= 0) continue;
        const d = distance(e, n);
        if (d < bestD) {bestD = d; flee = n;}
      }
      const dx = e.x - flee.x, dz = e.z - flee.z, len = Math.hypot(dx, dz);
      // Standing exactly on the source: break the tie away from the route.
      const away = len > 0.01
        ? {x: e.x + dx / len * 60, z: e.z + dz / len * 60}
        : {x: e.x + 40, z: e.z + 40};
      this.move(e, away, e.speed * 1.45 * dt);
      return;
    }
    const slot = this.columnSlot(e);
    // Gentle attraction to nearby civilians: this is the bunching that makes a
    // single loose round expensive.
    let bx = 0, bz = 0, n = 0;
    for (const c of this.entities) {
      if (c.side !== 'civilian' || c.hp <= 0 || c.saved || c.id === e.id) continue;
      if (distance(c, e) > 22) continue;
      bx += c.x; bz += c.z; n++;
    }
    const dest = n > 0
      ? {x: slot.x * 0.76 + (bx / n) * 0.24, z: slot.z * 0.76 + (bz / n) * 0.24}
      : slot;
    const pace = distance(e, slot) > 24 ? 1.25 : 0.85;
    this.move(e, dest, e.speed * pace * dt);
  }

  /** Move with a simple wall-slide and a one-shot corner detour around buildings. */
  private move(e: Entity, to: Vec, step: number) {
    if (e.y > 0) return;
    let waypoint = this.detours.get(e.id);
    if (waypoint && distance(e, waypoint) < 1) {this.detours.delete(e.id); waypoint = undefined;}
    const before = {x: e.x, z: e.z};
    approach(e, waypoint ?? to, step);
    if (!obstructed(e, this.buildings, 0.6)) return;

    if (!obstructed({x: e.x, z: before.z}, this.buildings, 0.6)) {e.z = before.z; return;}
    if (!obstructed({x: before.x, z: e.z}, this.buildings, 0.6)) {e.x = before.x; return;}
    e.x = before.x; e.z = before.z;

    const probe = {...before};
    approach(probe, waypoint ?? to, Math.max(step, 1.5));
    const b = this.buildings.find(b => b.hp > 0
      && Math.abs(probe.x - b.x) < b.width / 2 + 1
      && Math.abs(probe.z - b.z) < b.depth / 2 + 1);
    if (!b) return;
    const corners: Vec[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      corners.push({x: b.x + sx * (b.width / 2 + 2), z: b.z + sz * (b.depth / 2 + 2)});
    }
    const valid = corners.filter(c => !obstructed(c, this.buildings, 0.8));
    valid.sort((p, q) => distance(e, p) + distance(p, to) - distance(e, q) - distance(q, to));
    if (valid[0]) this.detours.set(e.id, valid[0]);
  }

  // ------------------------------------------------------------------ result

  fail(reason: string) {
    if (this.status === 'won' || this.status === 'lost') return;
    this.status = 'lost';
    this.reason = reason;
  }

  /** Cycle the camera through called-out priority threats. Never auto-fires. */
  cycleTarget() {
    const targets = this.enemies.filter(e => e.marked);
    if (!targets.length) {this.selectedTarget = null; return null;}
    const i = targets.findIndex(e => e.id === this.selectedTarget);
    const e = targets[(i + 1) % targets.length];
    this.selectedTarget = e.id;
    return e;
  }

  get grade() {
    if (this.status === 'lost') return 'F';
    const s = this.stats;
    const response = s.responseCount ? s.responseTotal / s.responseCount : 999;
    if (s.civilians === 0 && s.friendly === 0 && s.friendlyFire === 0 && this.accuracy >= 60 && response < 25) return 'S';
    if (s.civilians === 0 && s.friendly <= 1 && this.accuracy >= 40) return 'A';
    if (s.civilians <= 1 && s.friendly <= 2) return 'B';
    if (s.civilians <= 3) return 'C';
    return 'D';
  }
}

export {PHASES, WEAPONS, ROUTE, LZ, HOLD_SECONDS, CONFIG, person, bearingOf};
