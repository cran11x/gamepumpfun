// Game module: requestAnimationFrame loop with a fixed-step simulation, local movement
// prediction, move reporting, remote interpolation, interactions, hotkeys and actions.
// Rendering is delegated to render/.

import { BASE_SPEED, BASE_VISION, FUD_VISION_MULT, GHOST_SPEED_MULT, INTERP_DELAY_MS, PLAYER_RADIUS } from '../../../shared/constants';
import { moveWithCollision, type Vec } from '../../../shared/geometry';
import { SABOTAGE_STATIONS, stationById, ventById, WORLD_H, WORLD_W } from '../../../shared/map';
import type { GameEvent, MeView, PlayerView, SabotageKind, Snapshot } from '../../../shared/protocol';
import type { AppContext, AudioApi, GameApi, Interactions, MinigameTarget, SoundName, UiApi } from '../context';
import { Renderer, type RenderPlayer, type WorldView } from '../render/index';
import { COLORS } from '../render/palette';
import { hashString } from '../render/util';
import { bridgePops, ventsInSight } from './bridgeSight';
import { Input, type InputVector } from './input';
import { computeInteractions, NO_INTERACTIONS } from './interactions';
import { InterpClock, RemoteInterpolator } from './interp';
import { MoveSync } from './moveSync';

/** Fixed simulation step (seconds). */
const SIM_DT = 1 / 60;
/** Never simulate more than this many steps per frame (tab was hidden, long GC, ...). */
const MAX_SIM_STEPS = 8;
/** After asking to enter a bridge, freeze movement until the server confirms (or this passes). */
const VENT_PENDING_MS = 700;
/** Phases whose DOM screen covers the canvas completely: the world isn't drawn under them... */
const COVERED_PHASES: ReadonlySet<string> = new Set(['meeting', 'ejection', 'gameOver']);
/** ...once their fade-in (0.28 s screen-in animation) is over. */
const COVER_FADE_MS = 450;
/** Tolerance for client/server clock skew when checking cooldowns locally. */
const COOLDOWN_SLACK_MS = 150;
const NO_COLORS: readonly number[] = [];
const NO_SKINS: readonly (string | undefined)[] = [];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function findPlayer(list: readonly PlayerView[], id: string): PlayerView | undefined {
  for (const p of list) if (p.id === id) return p;
  return undefined;
}

export function createGame(canvas: HTMLCanvasElement, ctx: AppContext): GameApi {
  const { net, store } = ctx;
  const renderer = new Renderer(canvas);
  const input = new Input();
  const remotes = new RemoteInterpolator();
  const clock = new InterpClock();

  // ctx.ui (and in principle ctx.audio) are attached after createGame returns: read lazily.
  const ui = (): UiApi | undefined => (ctx as Partial<AppContext>).ui;
  const sound = (name: SoundName): void => {
    const a: AudioApi | undefined = (ctx as Partial<AppContext>).audio;
    a?.play(name);
  };

  // ---------- local player state ----------
  const self: RenderPlayer = {
    id: '',
    name: '',
    color: 0,
    x: 0,
    y: 0,
    facing: 1,
    moving: false,
    walk: 0,
    alive: true,
    isRugger: false,
    inVent: false,
    disconnected: false,
    seed: 0,
  };
  /** Simulated (authoritative-for-us) position, and the previous step for render smoothing. */
  const sim: Vec = { x: 0, y: 0 };
  let prevX = 0;
  let prevY = 0;
  let initialized = false;
  let teleportSeq = -1;
  let selfId: string | null = null;
  let snapCamera = true;
  let blocked = false;
  let acc = 0;
  const moves = new MoveSync();
  /** Actions waiting for a position flush (see syncThen). */
  let flushTimer: number | null = null;
  const flushQueue: Array<() => void> = [];
  /** When the current covered phase (COVERED_PHASES) began, or -1. */
  let coveredSince = -1;
  let ventPendingUntil = 0;
  let interactions: Interactions = NO_INTERACTIONS;
  let prevSnap: Snapshot | null = null;
  /** The snapshot before prevSnap (bridge detection extrapolates where a vanished player was heading). */
  let prevPrevSnap: Snapshot | null = null;
  /** Bridges whose hatch was in our fog when prevSnap arrived (see bridgePops). */
  let ventsSeen: ReadonlySet<string> = new Set();
  /** Players who left the room this game: they vanish without using a bridge. */
  const departed = new Set<string>();
  let backdropSnap: Snapshot | null = null;
  let backdropColors: readonly number[] = NO_COLORS;
  let backdropSkins: readonly (string | undefined)[] = NO_SKINS;
  const guards = new Map<string, number>();
  const vec: InputVector = { x: 0, y: 0, mag: 0 };
  const taskGlow: string[] = [];

  const view: WorldView = {
    phase: 'playing',
    self,
    selfVentId: null,
    role: 'holder',
    viewerDead: false,
    noFog: false,
    visionRadius: BASE_VISION,
    fud: false,
    remotes: remotes.list,
    bodies: [],
    sabotage: null,
    taskGlow,
    interactions,
    snapCamera: true,
    serverNow: 0,
  };

  function guard(name: string, ms: number): boolean {
    const now = performance.now();
    const last = guards.get(name) ?? -Infinity;
    if (now - last < ms) return false;
    guards.set(name, now);
    return true;
  }

  /** Best estimate of the server clock (ms). */
  function serverTime(): number {
    const h = store.history;
    const last = h[h.length - 1];
    const fromSnap = last ? last.snap.now + (Date.now() - last.recvAt) : Date.now();
    if (net.rtt > 0) {
      const s = net.serverNow();
      if (Math.abs(s - fromSnap) < 1500) return s;
    }
    return fromSnap;
  }

  function inGame(): boolean {
    const s = store.snap;
    return !!(s && s.me && s.phase !== 'lobby' && initialized);
  }

  function isInVent(me: MeView): boolean {
    return !!me.ventId || performance.now() < ventPendingUntil;
  }

  function snapTo(x: number, y: number): void {
    sim.x = prevX = self.x = x;
    sim.y = prevY = self.y = y;
    self.moving = false;
    moves.placed(x, y);
    acc = 0;
    snapCamera = true;
  }

  function cancelFlush(): void {
    if (flushTimer !== null) window.clearTimeout(flushTimer);
    flushTimer = null;
    flushQueue.length = 0;
  }

  function resetLocal(): void {
    if (!initialized && teleportSeq === -1) return;
    initialized = false;
    teleportSeq = -1;
    selfId = null;
    self.moving = false;
    moves.idle();
    cancelFlush();
    ventPendingUntil = 0;
    interactions = NO_INTERACTIONS;
    remotes.clear();
    clock.reset();
    prevSnap = null;
    prevPrevSnap = null;
    departed.clear();
  }

  /** Stop local movement right now (the stop is reported on the next send slot). */
  function stopNow(): void {
    self.moving = false;
    prevX = sim.x;
    prevY = sim.y;
    acc = 0;
  }

  // ---------- network: snapshots, phases, events ----------

  store.onSnapshot((snap) => {
    clock.onSnapshot(snap.now, performance.now());
    const me = snap.me;
    if (!me || snap.phase === 'lobby') {
      resetLocal();
      prevSnap = snap;
      prevPrevSnap = null;
      return;
    }
    if (!initialized || me.id !== selfId || me.teleportSeq !== teleportSeq) {
      snapTo(me.x, me.y);
      teleportSeq = me.teleportSeq;
      selfId = me.id;
      initialized = true;
    }
    if (me.ventId) ventPendingUntil = 0;
    if (snap.phase !== 'playing') {
      self.moving = false;
      moves.idle();
      ventPendingUntil = 0;
    }
    // Our own bridge entry pops once the server confirms it (a rejected request shows nothing).
    if (me.ventId && snap.phase === 'playing' && prevSnap?.phase === 'playing' && prevSnap.me && !prevSnap.me.ventId) {
      const v = ventById(me.ventId);
      if (v) {
        renderer.effects.hatch(v.x, v.y);
        sound('vent');
      }
    }
    detectBridgeUse(prevPrevSnap, prevSnap, snap, me);
    prevPrevSnap = prevSnap;
    prevSnap = snap;
  });

  store.onPhase(({ from, to }) => {
    if (from === null || to === 'roleReveal' || to === 'lobby') {
      renderer.resetForNewGame();
      clock.reset();
    }
    if (to === 'meeting' && from !== null) renderer.effects.flash('#ffffff', 0.9, 0.8);
  });

  store.onEvent((ev) => {
    try {
      onGameEvent(ev);
    } catch (err) {
      console.error('[game] event handling failed', err);
    }
  });

  // A refused bridge entry (too far, ...) must not keep us frozen for the rest of VENT_PENDING_MS.
  store.onError(({ code }) => {
    if (code === 'INVALID_ACTION' && ventPendingUntil > performance.now()) ventPendingUntil = 0;
  });

  /** Where a player is right now: the latest snapshot is closest to the server's truth. */
  function positionOf(id: string): Vec | null {
    const snap = store.snap;
    if (snap?.me && id === snap.me.id) return { x: sim.x, y: sim.y };
    if (snap) {
      const b = snap.bodies.find((q) => q.id === id);
      if (b) return { x: b.x, y: b.y };
      const p = findPlayer(snap.players, id);
      if (p) return { x: p.x, y: p.y };
    }
    const r = remotes.get(id);
    return r ? { x: r.x, y: r.y } : null;
  }

  function onGameEvent(ev: GameEvent): void {
    const me = store.snap?.me;
    const fx = renderer.effects;
    switch (ev.kind) {
      case 'rugged': {
        if (!me) return;
        const pos = positionOf(ev.victimId);
        if (!pos) return;
        if (ev.killerId === me.id) fx.slash(pos.x, pos.y, true);
        else if (ev.victimId === me.id) {
          fx.slash(pos.x, pos.y, false);
          fx.addShake(12);
        } else if (renderer.canSee(pos.x, pos.y)) fx.slash(pos.x, pos.y, false);
        break;
      }
      case 'taskCompleted': {
        const st = stationById(ev.stationId);
        if (st) fx.sparkle(st.x, st.y);
        break;
      }
      case 'sabotageStarted':
        if (ev.sabotage === 'devDump') {
          fx.flash(COLORS.rug, 0.35, 0.7);
          fx.addShake(5);
        } else if (ev.sabotage === 'rpcDown') {
          fx.startGlitch(0.8);
        } else {
          fx.flash('#000000', 0.55, 0.7);
        }
        break;
      case 'sabotageFixed':
        for (const st of SABOTAGE_STATIONS) if (st.sabotage === ev.sabotage) fx.ring(st.x, st.y, COLORS.pump);
        break;
      case 'gameStarted':
        renderer.resetForNewGame();
        departed.clear();
        break;
      case 'playerLeft':
        departed.add(ev.playerId);
        break;
      case 'kicked':
        resetLocal();
        break;
      default:
        break;
    }
  }

  /** Bridge hatch pops for other players entering/leaving bridges in plain sight (see bridgePops). */
  function detectBridgeUse(prevPrev: Snapshot | null, prev: Snapshot | null, snap: Snapshot, me: MeView): void {
    const seen = (x: number, y: number) => renderer.canSee(x, y);
    if (prev) {
      const vents = bridgePops({ prevPrev, prev, snap, me, canSee: seen, ventsSeenBefore: ventsSeen, departed });
      for (const v of vents) renderer.effects.hatch(v.x, v.y);
      if (vents.length > 0) sound('vent');
    }
    ventsSeen = snap.phase === 'playing' ? ventsInSight(seen) : new Set();
  }

  // ---------- simulation ----------

  function simulate(dt: number, snap: Snapshot, me: MeView, inVent: boolean): void {
    prevX = sim.x;
    prevY = sim.y;
    let moved = 0;
    // Hold still while an action waits for its position flush: the server checks where we pressed.
    const canMove = snap.phase === 'playing' && !blocked && !inVent && net.connected && flushTimer === null;
    if (canMove) {
      input.read(vec);
      if (vec.mag > 0) {
        const mult = Number.isFinite(snap.room.settings.playerSpeed) ? snap.room.settings.playerSpeed : 1;
        const speed = BASE_SPEED * mult * (me.alive ? 1 : GHOST_SPEED_MULT) * vec.mag;
        const dx = vec.x * speed * dt;
        const dy = vec.y * speed * dt;
        let nx: number;
        let ny: number;
        if (me.alive) {
          const p = moveWithCollision(sim.x, sim.y, dx, dy);
          nx = p.x;
          ny = p.y;
        } else {
          // Ghosts float through walls but stay inside the world.
          nx = clamp(sim.x + dx, PLAYER_RADIUS, WORLD_W - PLAYER_RADIUS);
          ny = clamp(sim.y + dy, PLAYER_RADIUS, WORLD_H - PLAYER_RADIUS);
        }
        moved = Math.hypot(nx - sim.x, ny - sim.y);
        if (vec.x > 0.15) self.facing = 1;
        else if (vec.x < -0.15) self.facing = -1;
        sim.x = nx;
        sim.y = ny;
      }
    }
    self.moving = moved > 0.05;
    if (self.moving) self.walk += moved * 0.11;
  }

  function maybeSendMove(now: number, snap: Snapshot, inVent: boolean): void {
    if (snap.phase !== 'playing') {
      moves.idle();
      return;
    }
    if (inVent || !net.connected) return;
    const moving = moves.due(now, self.moving && !blocked);
    if (moving !== null) sendMove(now, moving);
  }

  function sendMove(now: number, moving: boolean): void {
    net.send({ t: 'move', x: sim.x, y: sim.y, facing: self.facing, moving });
    moves.sent(now, sim.x, sim.y, moving);
  }

  /**
   * Run `send` (an action the server range-checks against our last accepted move) right after
   * reporting where we are now. Moves only go out at CLIENT_SEND_HZ, so otherwise the server
   * would judge a position up to 50 ms old and refuse presses made on arrival. The flush keeps
   * FLUSH_GAP_MS after the previous move, so the action can wait up to that long (movement is
   * held meanwhile). Queued actions are dropped if we leave play or lose the connection first.
   */
  function syncThen(send: () => void): void {
    if (flushTimer !== null) {
      flushQueue.push(send);
      return;
    }
    const wait = store.snap?.me?.ventId || !net.connected ? null : moves.flushDelay(performance.now(), sim.x, sim.y);
    if (wait === null) {
      send();
      return;
    }
    if (wait <= 0) {
      sendMove(performance.now(), self.moving && !blocked);
      send();
      return;
    }
    flushQueue.push(send);
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      const queued = flushQueue.splice(0);
      const c = current();
      if (!c) return;
      if (!c.me.ventId) sendMove(performance.now(), self.moving && !blocked);
      for (const f of queued) {
        try {
          f();
        } catch (err) {
          console.error('[game] action failed', err);
        }
      }
    }, wait);
  }

  // ---------- frame ----------

  function buildView(snap: Snapshot, me: MeView): WorldView {
    const mine = findPlayer(snap.players, me.id);
    if (self.id !== me.id) {
      self.id = me.id;
      self.seed = hashString(me.id) % 1000;
    }
    self.name = mine?.name ?? self.name;
    self.color = mine?.color ?? self.color;
    self.cosmetics = mine?.cosmetics;
    self.alive = me.alive;
    self.isRugger = me.role === 'rugger';
    self.inVent = !!me.ventId;
    self.disconnected = false;

    const settings = snap.room.settings;
    const fud = snap.sabotage?.kind === 'fud' && me.role === 'holder';
    const mult = me.role === 'rugger' ? settings.ruggerVision : settings.crewVision * (fud ? FUD_VISION_MULT : 1);
    taskGlow.length = 0;
    const hideTasks = me.role === 'holder' && snap.sabotage?.kind === 'rpcDown';
    if (snap.phase === 'playing' && !hideTasks) for (const t of me.tasks) if (!t.done) taskGlow.push(t.stationId);

    view.phase = snap.phase;
    view.selfVentId = me.ventId ?? null;
    view.role = me.role;
    view.viewerDead = !me.alive;
    view.noFog = !me.alive || snap.phase === 'gameOver';
    view.visionRadius = BASE_VISION * (Number.isFinite(mult) && mult > 0 ? mult : 1);
    view.fud = fud;
    view.bodies = snap.bodies;
    view.sabotage = snap.sabotage;
    view.interactions = interactions;
    view.snapCamera = snapCamera;
    view.serverNow = serverTime();
    return view;
  }

  /** Lobby players' colors and pill skins for the home/lobby backdrop (cached per snapshot). */
  function syncBackdrop(snap: Snapshot | null): void {
    if (!snap || snap.phase !== 'lobby') {
      backdropSnap = null;
      backdropColors = NO_COLORS;
      backdropSkins = NO_SKINS;
      return;
    }
    if (snap !== backdropSnap) {
      backdropSnap = snap;
      backdropColors = snap.players.map((p) => p.color);
      backdropSkins = snap.players.map((p) => p.cosmetics?.skin);
    }
  }

  function tick(now: number, dt: number, time: number): void {
    const snap = store.snap;
    const me = snap?.me;
    if (!snap || !me || snap.phase === 'lobby' || !initialized) {
      if (!snap || snap.phase === 'lobby') resetLocal();
      interactions = NO_INTERACTIONS;
      syncBackdrop(snap);
      renderer.renderBackdrop(dt, time, backdropColors, backdropSkins);
      snapCamera = true;
      return;
    }
    const inVent = isInVent(me);
    acc += dt;
    let steps = 0;
    while (acc >= SIM_DT && steps < MAX_SIM_STEPS) {
      simulate(SIM_DT, snap, me, inVent);
      acc -= SIM_DT;
      steps++;
    }
    if (steps >= MAX_SIM_STEPS) acc = 0;
    const alpha = acc / SIM_DT;
    self.x = prevX + (sim.x - prevX) * alpha;
    self.y = prevY + (sim.y - prevY) * alpha;

    maybeSendMove(now, snap, inVent);
    const renderTime = clock.ready ? clock.renderTime(now, INTERP_DELAY_MS) : serverTime() - INTERP_DELAY_MS;
    remotes.update(store.history, renderTime, me.id, dt);
    interactions = computeInteractions(snap, me, sim, inVent, interactions);

    // Meeting / ejection / game over screens are opaque: after their fade-in, draw one last
    // frame (only again if the canvas gets resized) and just keep the renderer's clock moving.
    const covered = COVERED_PHASES.has(snap.phase);
    if (!covered) coveredSince = -1;
    else if (coveredSince < 0) coveredSince = now;
    if (covered && now - coveredSince > COVER_FADE_MS && !renderer.canvasStale) {
      renderer.skipFrame(dt);
      return;
    }
    renderer.renderWorld(buildView(snap, me), dt, time);
    snapCamera = false;
  }

  let lastFrame = performance.now();
  let time = 0;
  let errors = 0;
  function frame(now: number): void {
    requestAnimationFrame(frame);
    const dt = clamp((now - lastFrame) / 1000, 0, 0.25);
    lastFrame = now;
    time += dt;
    try {
      tick(now, dt, time);
    } catch (err) {
      if (errors++ < 5) console.error('[game] frame failed', err);
    }
  }
  requestAnimationFrame(frame);

  // ---------- actions ----------

  /**
   * The live game state actions act on, or null. Actions are refused while disconnected:
   * net.send queues non-move messages, and a stale rug/report/X SPACES replayed seconds later
   * on reconnect would be a nasty surprise.
   */
  function current(): { snap: Snapshot; me: MeView } | null {
    const snap = store.snap;
    const me = snap?.me;
    if (!snap || !me || snap.phase !== 'playing' || !initialized || !net.connected) return null;
    return { snap, me };
  }

  const api: GameApi = {
    getInteractions(): Interactions {
      return interactions;
    },

    use(): void {
      const c = current();
      if (!c) return;
      const u = interactions.use;
      if (!u) return;
      if (u.type === 'task' || u.type === 'fix') {
        const host = ui();
        if (!host || host.isMinigameOpen()) return;
        stopNow();
        const target: MinigameTarget =
          u.type === 'task' ? { type: 'task', stationId: u.stationId, kind: u.kind } : { type: 'fix', stationId: u.stationId, kind: u.kind };
        // The overlay sends taskOpen as it opens.
        syncThen(() => {
          const h = ui();
          if (h && !h.isMinigameOpen()) h.openMinigame(target);
        });
      } else if (u.type === 'emergency') {
        if (!c.me.alive || c.me.emergencyLeft <= 0 || c.snap.sabotage?.kind === 'devDump') return;
        if (!guard('emergency', 1500)) return;
        stopNow();
        syncThen(() => net.send({ t: 'emergency' }));
      } else if (u.type === 'vent') {
        api.ventToggle();
      }
    },

    kill(): void {
      const c = current();
      if (!c || c.me.role !== 'rugger' || !c.me.alive || isInVent(c.me)) return;
      const targetId = interactions.killTargetId;
      if (!targetId) return;
      if ((c.me.killReadyAt ?? 0) - serverTime() > COOLDOWN_SLACK_MS) {
        sound('error');
        return;
      }
      if (!guard('kill', 400)) return;
      syncThen(() => net.send({ t: 'kill', targetId }));
    },

    report(): void {
      const c = current();
      if (!c || !c.me.alive || isInVent(c.me)) return;
      const bodyId = interactions.reportBodyId;
      if (!bodyId) return;
      if (!guard('report', 1500)) return;
      stopNow();
      syncThen(() => net.send({ t: 'report', bodyId }));
    },

    ventToggle(): void {
      const c = current();
      if (!c || c.me.role !== 'rugger' || !c.me.alive) return;
      if (c.me.ventId) {
        if (!guard('vent', 300)) return;
        net.send({ t: 'vent', action: 'exit' });
        renderer.effects.hatch(sim.x, sim.y);
        sound('vent');
        return;
      }
      if (performance.now() < ventPendingUntil) return;
      const ventId = interactions.ventId;
      const vent = ventId ? ventById(ventId) : undefined;
      if (!ventId || !vent) return;
      if (!guard('vent', 300)) return;
      const host = ui();
      if (host?.isMinigameOpen()) host.closeMinigame();
      stopNow();
      // Frozen from here; the hatch pops when the server confirms (see onSnapshot).
      ventPendingUntil = performance.now() + VENT_PENDING_MS;
      syncThen(() => net.send({ t: 'vent', action: 'enter', ventId }));
    },

    ventMove(ventId: string): void {
      const c = current();
      if (!c || !c.me.ventId) return;
      const from = ventById(c.me.ventId);
      const to = ventById(ventId);
      if (!from || !to || !from.links.includes(to.id)) return;
      if (!guard('ventMove', 300)) return;
      net.send({ t: 'vent', action: 'move', ventId: to.id });
      renderer.effects.hatch(from.x, from.y);
      renderer.effects.hatch(to.x, to.y);
      sound('vent');
    },

    sabotage(kind: SabotageKind): void {
      const c = current();
      if (!c || c.me.role !== 'rugger') return;
      if (c.snap.sabotage || (c.me.sabotageReadyAt ?? 0) - serverTime() > COOLDOWN_SLACK_MS) {
        sound('error');
        return;
      }
      if (!guard('sabotage', 800)) return;
      net.send({ t: 'sabotage', kind });
    },

    setInputBlocked(b: boolean): void {
      if (b === blocked) return;
      blocked = b;
      if (b) {
        input.clear();
        stopNow();
      }
    },

    setJoystick(x: number, y: number): void {
      input.setJoystick(x, y);
    },

    getSelfPosition(): { x: number; y: number } | null {
      return inGame() ? { x: sim.x, y: sim.y } : null;
    },
  };

  // ---------- hotkeys ----------

  input.isActive = () => inGame() && store.snap?.phase === 'playing' && !blocked;
  input.isBlocked = () => blocked;
  input.onAction = (action) => {
    if (blocked || input.typing()) return;
    if (!current()) return;
    if (ui()?.isMinigameOpen()) return;
    switch (action) {
      case 'use':
        api.use();
        break;
      case 'kill':
        api.kill();
        break;
      case 'report':
        api.report();
        break;
      case 'vent':
        api.ventToggle();
        break;
    }
  };

  return api;
}
