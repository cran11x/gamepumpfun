// Bot players for AMONG RUGS.
//
// A BotBrain is a virtual client. It only sees its own per-client Snapshot (plus the chat lines and
// game events the room delivers to it) and it only acts by sending the same C2S messages a browser
// sends. It never touches room internals, so every rule (speed clamp, ranges, cooldowns, chat rate
// limits) is enforced by the server exactly as it is for humans.
//
// Layout:
//   Rng          seeded PRNG (mulberry32), so a bot is reproducible from its seed
//   Navigator    A* waypoints + collision-aware stepping + unstick logic
//   GameMemory   what the bot has seen this game (players, bodies, witnessed kills)
//   BotBrain     perception, holder / ghost / rugger behavior, meetings, chat
//   botName      fun unique bot names

import {
  BASE_SPEED,
  BASE_VISION,
  CHAT_RATE_LIMIT_MS,
  EMERGENCY_RANGE,
  FUD_VISION_MULT,
  GHOST_SPEED_MULT,
  KILL_RANGE,
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  PLAYER_COLORS,
  PLAYER_RADIUS,
  REPORT_RANGE,
  TILE,
  USE_RANGE,
  VENT_RANGE,
  maxRuggersFor,
} from '../shared/constants';
import { canSee, circleFree, dist, findPath, moveWithCollision, tileCenter, type Vec } from '../shared/geometry';
import {
  EMERGENCY_BUTTON,
  ROOMS,
  SPAWN_POINTS,
  TASK_MIN_MS,
  TASK_STATIONS,
  VENTS,
  isSolidCell,
  roomAt,
  sabotageStationById,
  stationById,
  ventById,
  type RoomDef,
} from '../shared/map';
import type {
  BodyView,
  C2S,
  ChatMessage,
  GameEvent,
  MeView,
  Phase,
  PlayerView,
  SabotageKind,
  Snapshot,
  TaskKind,
} from '../shared/protocol';

// ---------- Public API (see docs/SPEC.md, server/bots.ts block) ----------

export interface BotBrainOptions {
  id: string;
  /** Send a client message as this bot (routed straight into the room). */
  send: (msg: C2S) => void;
  /** Deterministic per-bot seed. */
  seed: number;
}

// ---------- Tuning ----------

/**
 * Minimum gap between two `move` messages: one per server tick (20 Hz). Ticks come from setInterval and
 * jitter by a few ms, so a 49 ms gap must still send, or the bot misses a tick and remote players see
 * it stall and then jump. The server ignores moves faster than every 25 ms.
 */
const MOVE_INTERVAL_MS = 40;
/** Longest stretch of time one tick may simulate, so a late tick never produces a giant step. */
const MAX_STEP_MS = 100;
/** Stay this far inside server interaction ranges so small drift never fails a server check. */
const RANGE_MARGIN = 14;
/** Rug only this far inside KILL_RANGE: the target may move a little before the message lands. */
const KILL_MARGIN = 18;
const KILL_RETRY_MS = 350;
const KILL_CONFIRM_MS = 900;
/** No progress along the path for this long counts as stuck. */
const STUCK_MS = 1500;
const PROGRESS_EPS = 8;
const MAX_STUCK = 6;
/** Ruggers keep counting a holder as a potential witness this long after losing sight of them. */
const WITNESS_MEMORY_MS = 2000;
/** Extra px added to a witness's vision radius (they might step closer). */
const WITNESS_MARGIN = 40;
/** A player this close to a body when it appears is treated as the one who rugged. */
const NEAR_FRESH_BODY_PX = KILL_RANGE + 45;
/** A player this close to a body when the bot first sees it is "seen near the body". */
const NEAR_BODY_PX = 150;
/** A visible player who vanishes or appears this close to a bridge just used it. */
const VENT_SIGHT_PX = VENT_RANGE + 10;
const REPORT_REACT_MS: [number, number] = [500, 2000];
const TASK_EXTRA_MS: [number, number] = [1000, 3000];
const TASK_OPEN_CONFIRM_MS = 600;
const TASK_DONE_CONFIRM_MS = 1500;
/** How long after voting opens a bot votes: sooner when it saw the rug, later while undecided. */
const VOTE_DELAY_SURE_MS: [number, number] = [2000, 8000];
const VOTE_DELAY_MS: [number, number] = [3000, 16000];
/** Always at least the server's chat rate limit, plus slack for clock jitter. */
const CHAT_GAP_MS = CHAT_RATE_LIMIT_MS + 250;
const MAX_MEETING_LINES = 2;
const FAILED_GOAL_MS = 20000;
const ESCAPE_TIMEOUT_MS = 20000;
const VENT_ESCAPE_MAX_PATH = 360;
/** After a rug: slip into a bridge this often (when one is close)... */
const ESCAPE_VENT_CHANCE = 0.6;
/** ...otherwise walk off, and this often only to a station just down the hall (this far away). */
const ESCAPE_LINGER_CHANCE = 0.3;
const LINGER_PX: [number, number] = [220, 420];
const SABOTAGE_ROLL_MS = 1000;
/** Start shadowing a lone holder this long before the rug cooldown ends. */
const PRE_HUNT_MS = 3000;
const PRE_HUNT_RANGE = 260;
/** Meeting chat that arrives before the meeting snapshot is replayed if it is at most this old. */
const PENDING_CHAT_MAX_AGE_MS = 5000;
/**
 * Rugger team pacing. After a fellow rugger's rug the others hold off this long (plus jitter), and at
 * the start of every round the ruggers take turns: the n-th rugger waits n staggers longer.
 */
const TEAM_KILL_SPACING_MS = 15000;
const TEAM_KILL_JITTER_MS = 5000;
const ROUND_STAGGER_MS = 7000;
const ROUND_HESITATION_MS: [number, number] = [0, 4000];
/** Interest management can drop a player who steps out of sight; only a spot this clear counts as a bridge. */
const BRIDGE_VIEW_MARGIN = 30;
const BRIDGE_VIEW_PROBE = 14;
/** A rugger leaving a bridge appears right on it. */
const BRIDGE_EXIT_PX = 18;
/** Who stood this close to a player the last time we saw them ("last saw X with Y"). */
const SEEN_WITH_PX = 220;
const SEEN_WITH_MAX_AGE_MS = 30000;
/** Seen with the victim this shortly before the body turned up: a real lead. */
const SEEN_WITH_RECENT_MS = 10000;
/** Seen at the spot of a body this long before we found it ("around the body"). */
const AROUND_BODY_PX = 200;
const AROUND_BODY_MS = 30000;
const AROUND_RECENT_MS = 10000;
/** Sighting history: one sample per player this often, kept this long. */
const SIGHTING_SAMPLE_MS = 500;
const SIGHTING_KEEP_MS = 90000;

// ---------- Meeting reasoning ----------
// A holder bot adds up suspicion per player from its own evidence and from what others say, each
// claim weighed by how believable it is, and votes the top suspect only past its own threshold.

/** Suspicion a holder bot needs before it votes someone out; drawn per bot per meeting. */
const VOTE_THRESHOLD: [number, number] = [2, 4.5];
/** The top suspect must lead the runner-up by this much, or the bot skips. */
const VOTE_MARGIN = 0.75;
/** Saw someone stand by a body (split between everyone who was there). */
const OWN_NEAR_BODY_WEIGHT = 4.5;
/** Saw someone at the body's spot shortly before / a while before we found it. */
const OWN_AROUND_RECENT_WEIGHT = 3;
const OWN_AROUND_WEIGHT = 1.2;
/** Last saw the victim with this player, shortly / a while before (split when with two). */
const OWN_SEEN_WITH_WEIGHT = 2.6;
const OWN_SEEN_WITH_OLD_WEIGHT = 0.8;
/**
 * Alibis by elimination: from the last time this bot saw the victim alive (at most
 * ALIBI_SPAN_MAX_MS back) until the body turned up, whoever it kept seeing can't have done it.
 * The one it saw least gets up to ALIBI_WEIGHT.
 */
const ALIBI_WEIGHT = 4;
const ALIBI_SPAN_MAX_MS = 45000;
const ALIBI_SPAN_MIN_MS = 3000;
/** Seen this much of that stretch: vouch for them if they get accused. */
const ALIBI_VOUCH_COVERAGE = 0.6;
/** A bot only tells the meeting about its own evidence when it is at least this strong. */
const VOICE_MIN_WEIGHT = 2;
/** One more rug and the ruggers win: holders stop waiting for proof (two more: less so). */
const CRITICAL_THRESHOLD_MULT = 0.5;
const CLOSE_THRESHOLD_MULT = 0.7;
/** In a must-win meeting, unless the curve is about to finish anyway, a holder never skips. */
const MUST_VOTE_PROGRESS = 0.85;
/** When a holder in a must-win meeting says who it votes for (after the first claims are in). */
const ANNOUNCE_DELAY_MS: [number, number] = [6000, 16000];
/** What one accuser's line is worth, by kind, before credibility. */
const CLAIM_WEIGHT: Record<ClaimKind, number> = { saw: 2.8, near: 2.6, evidence: 1.4, accuse: 0.7, echo: 0.25 };
/** An accuser who is under suspicion counts for less: 1 / (1 + suspicion / scale). */
const CREDIBILITY_SCALE = 3;
/** Own evidence this strong counts as a source of its own for corroboration. */
const OWN_SOURCE_MIN = 1;
/** Two or more independent sources (own evidence counts as one). */
const CORROBORATED_MULT = 1.25;
/** The accused denied it and nothing else backs the claim. */
const CONTESTED_MULT = 0.8;
/** Someone said the accused was with them elsewhere (per voucher, at most two). */
const VOUCH_MULT = 0.7;
/** An eyewitness claim that names the reported body's room. */
const ROOM_MATCH_MULT = 1.1;
/** A near-body claim about a different room than the reported body. */
const ROOM_MISMATCH_MULT = 0.5;
/** This bot saw the accused far from the claimed room right before the meeting. */
const ELSEWHERE_MULT = 0.5;
const ELSEWHERE_WINDOW_MS = 6000;
const ELSEWHERE_MIN_PX = 400;
/** The reporter was bound to be by the body; an eyewitness claim on them means a self-report. */
const REPORTER_EVIDENCE_MULT = 0.3;
const REPORTER_SAW_MULT = 0.7;
/** Extra suspicion on someone caught lying (a claim that can't be true). */
const LIAR_WEIGHT = 3.5;
/** Chance a holder bot who saw the accused elsewhere speaks up for them. */
const VOUCH_CHANCE = 0.6;

// ---------- Chat lines ----------

const GENERIC_LINES = [
  'dev is sus fr',
  "trust me bro I'm a holder",
  'skip, no alpha',
  'ngmi',
  'no info, skip',
  "didn't see anything, was grinding tasks",
  'anyone got alpha?',
  'wagmi if we vote right',
  'not voting blind, skip',
  'chart was looking bullish from where I was',
  'someone here is farming us',
  'ser this is a casino',
];
/** Only asked before anyone has said where the body was. */
const REPORT_MEETING_LINES = ['where was the body', 'where was the body ser'];
const EMERGENCY_MEETING_LINES = ['why the spaces?', 'who called this', "what's the alpha?"];
const ALIBI_TASK_LINES = ['I was in the {room} doing the {task} task', 'was in the {room} doing {task}, all good'];
const ALIBI_ROOM_LINES = ['I was in the {room}, it was quiet', "was in the {room}, didn't see anyone"];
const BODY_ROOM_LINES = ['who was near the {room}', 'anyone else in the {room}?'];
const WITNESS_LINE = '{name} rugged in {room}, I saw it';
const VENT_WITNESS_LINE = '{name} vented in the {room}, I saw it';
const WITNESS_FOLLOWUPS = ['vote {name}', '{name} is the rugger, vote them', '100% {name}, no cap'];
const NEAR_BODY_LINES = ['{name} was near the body in the {room}, sus', 'saw {name} right by the body in the {room}, sus'];
const SEEN_WITH_LINES = ['last saw {victim} with {name} in the {room}', '{name} was with {victim} in the {room} before, sus'];
const VOUCH_LINES = ['{name} was with me in the {room}', "nah {name} wasn't there, they were in the {room}"];
const AROUND_BODY_LINES = ['{name} was hanging around the {room} right before, sus', 'saw {name} near that spot in the {room} just before'];
const BACKUP_NEAR_BODY_LINES = ['saw {name} by the body too', '{name} was near the body in the {room}, I saw them too'];
const BACKUP_AROUND_LINES = ['{name} was around the {room} before too, I saw them'];
const BACKUP_SEEN_WITH_LINES = ['I last saw {victim} with {name} too'];
const ELIMINATION_LINES = ['{name} is the only one I lost track of, sus', 'I had eyes on everyone but {name}, sus'];
const ANNOUNCE_LINES = ['voting {name}, no skip this time', 'my vote is on {name}', "I'm voting {name}, we have to"];
const REPORTER_LINES = ['body in the {room}', 'found a rugged bag in the {room}'];
const ECHO_LINES = ['yeah {name} is sus', '{name} sus fr', 'agree, {name}'];
const DEFENSE_ROOM_LINES = ['not me, I was in the {room}', 'why me? I was in the {room}'];
const DEFENSE_LINES = ["trust me bro I'm a holder", "wasn't me ser, I was doing tasks", 'not me, check the chart'];
const COUNTER_LINES = ['{name} is lying, sus af', "I'm a holder, {name} is lying", '{name} is deflecting, vote {name}'];
const GHOST_LINES = [
  'rip my bags',
  'still doing tasks from the afterlife',
  'being a ghost is bullish ngl',
  'gg go next',
  'should have sold the top',
  'ghost holders unite',
  'wagmi (except me)',
];
const GHOST_KILLER_LINES = ['{name} rugged me, unreal', 'it was {name} btw, gg'];

const TASK_SHORT: Record<TaskKind, string> = {
  verifyCA: 'verify CA',
  snipeLaunch: 'snipe',
  burnLP: 'burn LP',
  shillPost: 'shill',
  addLiquidity: 'liquidity',
  bubblemap: 'bubblemap',
  connectSocials: 'socials',
  deleteBots: 'delete bots',
  swapSol: 'swap',
  syncNode: 'node sync',
};

/** Words in a chat line that make a mention an accusation. */
const ACCUSE_RE =
  /\b(sus|sussy|rug|rugs|rugged|rugger|rugging|kill|killed|killer|vent|vented|venting|bridge|bridged|saw|seen|vote|voting|eject|blacklist|liar|lying|scam|scammer|impostor|imposter|fake|faking|cap|caught|self ?report(ed)?|did it|it'?s|its)\b/;
/** An eyewitness claim ("X rugged in Y, I saw it", "saw X vent"). */
const SAW_RE = /\b(saw|seen|watched|caught)\b/;
const CRIME_RE = /\b(rug|rugged|rugging|kill|killed|vent|vented|venting|bridge|bridged)\b/;
/** Words that turn a mention into a defense ("red is not sus", "blue was with me"). */
const DEFENSE_RE = /\b(not|isn'?t|wasn'?t|never|clear|cleared|safe|innocent|with me|vouch|legit)\b|n't\b/;
/** Second-hand evidence rather than a bare accusation ("X was near the body", "last saw V with X"). */
const EVIDENCE_RE = /\b(near|by the body|around|with|last saw|following|followed|right before|just before|lost track|everyone but)\b/;
/** Standing right by the body (the strongest kind of second-hand evidence). */
const NEAR_BODY_RE = /\b(near|by|next to|over) the body\b/;
/** A rug claim (as opposed to a bridge claim), which must fit the body. */
const RUG_CRIME_RE = /\b(rug|rugged|rugging|kill|killed)\b/;
/** The accused pushing back. */
const DENIAL_RE = /\b(not me|why me|wasn'?t me|trust me|lying|liar|deflecting|i'?m a holder|doing tasks)\b/;
/** Saying who they vote for. */
const VOTE_RE = /\bvot(e|ing)\b/;
/** The reporter saying where the body was. */
const BODY_ROOM_RE = /^(?:body in the|found a rugged bag in the)\s+(.+?)\s*$/;

const BASIC_COLOR_WORDS = new Set([
  'green', 'red', 'purple', 'blue', 'orange', 'lime', 'cyan', 'pink', 'gold', 'white', 'black', 'brown',
]);
const COLOR_ALIASES: Record<string, string[]> = { gold: ['yellow'], black: ['grey', 'gray'], cyan: ['teal'] };
/** Per color index, the words players use for it in chat ("red sus"). */
const COLOR_WORDS: string[][] = PLAYER_COLORS.map((c) => {
  const words = c.name.toLowerCase().split(/\s+/);
  const base = words.find((w) => BASIC_COLOR_WORDS.has(w)) ?? words[words.length - 1] ?? '';
  return base ? [base, ...(COLOR_ALIASES[base] ?? [])] : [];
});

const BOT_NAMES = [
  'anon_bot',
  'sniper.sol',
  'BundleBot',
  'KOL_Kevin',
  'cabal_carl',
  'rugpull_rick',
  'WAGMI_wendy',
  'pepe_trader',
  'dev_dave',
  'exit_liq',
  'degen_dana',
  'gm_gary',
  'moon_mia',
  'paperhand_pam',
  'diamond_dex',
  'copium_cody',
  'bagholder_bo',
  'fomo_fiona',
  'alpha_al',
  'liq_larry',
];

/** Fun, unique bot names. Wraps around the list with a numeric suffix ("anon_bot2"). */
export function botName(index: number): string {
  const i = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  const base = BOT_NAMES[i % BOT_NAMES.length];
  const cycle = Math.floor(i / BOT_NAMES.length);
  if (cycle === 0) return base;
  const suffix = String(cycle + 1);
  return base.slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length)) + suffix;
}

// ---------- Small helpers ----------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-token matcher: `name` not glued to other letters/digits/underscores. */
function tokenSource(word: string): string {
  return `(^|[^a-z0-9_])${escapeRegex(word)}(?=$|[^a-z0-9_])`;
}

/** Fill `{key}` placeholders. Returns null when a placeholder has no value. */
function fill(template: string, vars: Record<string, string | null | undefined>): string | null {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null || v === '') {
      missing = true;
      return '';
    }
    return v;
  });
  return missing ? null : out;
}

const ACRONYMS = new Set(['RPC', 'KOL', 'HQ', 'LP', 'CA']);
/** "LIQUIDITY POOL" -> "Liquidity Pool", "RPC NODE" -> "RPC Node". */
function prettyRoomName(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => (ACRONYMS.has(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
}

function rectDistance(p: Vec, r: RoomDef): number {
  const x0 = r.rect.x * TILE;
  const y0 = r.rect.y * TILE;
  const x1 = (r.rect.x + r.rect.w) * TILE;
  const y1 = (r.rect.y + r.rect.h) * TILE;
  const dx = Math.max(x0 - p.x, 0, p.x - x1);
  const dy = Math.max(y0 - p.y, 0, p.y - y1);
  return Math.hypot(dx, dy);
}

/** Pretty name of the room at `p`, or of the nearest room when `p` is in a hallway. */
function roomLabelAt(p: Vec): string {
  let room = roomAt(p.x, p.y);
  if (!room) {
    let best = Infinity;
    for (const r of ROOMS) {
      const d = rectDistance(p, r);
      if (d < best) {
        best = d;
        room = r;
      }
    }
  }
  return room ? prettyRoomName(room.name) : 'hallway';
}

/** Lowercase room labels as bots say them, longest first so "x y" wins over "y". */
const ROOM_LABELS: { label: string; room: RoomDef }[] = ROOMS.map((r) => ({ label: prettyRoomName(r.name).toLowerCase(), room: r })).sort(
  (a, b) => b.label.length - a.label.length,
);

/** The (lowercase) room named in a chat line, if any. */
function roomInText(text: string): string | null {
  const t = text.toLowerCase();
  for (const r of ROOM_LABELS) if (t.includes(r.label)) return r.label;
  return null;
}

/** Straight-line px from `p` to the room with this lowercase label (0 inside, Infinity if unknown). */
function distanceToRoom(p: Vec, label: string): number {
  const r = ROOM_LABELS.find((x) => x.label === label);
  return r ? rectDistance(p, r.room) : Infinity;
}

/** Path length in px from `from` to `to` along findPath waypoints, Infinity if unreachable. */
function pathLength(from: Vec, to: Vec): number {
  const path = findPath(from, to);
  if (path === null) return Infinity;
  let len = 0;
  let prev = from;
  for (const w of path) {
    len += dist(prev, w);
    prev = w;
  }
  return len + dist(prev, to);
}

/**
 * The candidate with the shortest walking path from `from`, and that path length.
 * Exact but cheap: a path is never shorter than the straight line, so candidates are tried in
 * straight-line order and the search stops once no remaining one can beat the best path found.
 */
function nearestByPath<T extends Vec>(from: Vec, candidates: readonly T[]): { item: T; len: number } | null {
  const sorted = candidates.map((c) => ({ c, d: dist(from, c) })).sort((a, b) => a.d - b.d);
  let best: { item: T; len: number } | null = null;
  for (const { c, d } of sorted) {
    if (best && d >= best.len) break;
    const len = pathLength(from, c);
    if (Number.isFinite(len) && (!best || len < best.len)) best = { item: c, len };
  }
  return best;
}

/** True if a circle slid straight from a to b never overlaps a solid cell (sampled). */
function segmentClear(a: Vec, b: Vec, r: number = PLAYER_RADIUS + 2): boolean {
  const d = dist(a, b);
  const steps = Math.max(1, Math.ceil(d / 6));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!circleFree(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, r)) return false;
  }
  return true;
}

/** Free standing spots within EMERGENCY_RANGE of the SPACES button (the button sits on the table). */
const EMERGENCY_SPOTS: Vec[] = (() => {
  const spots: Vec[] = [];
  for (let deg = 0; deg < 360; deg += 10) {
    for (const r of [72, 78, 84]) {
      if (r > EMERGENCY_RANGE - 4) continue;
      const a = (deg * Math.PI) / 180;
      const x = EMERGENCY_BUTTON.x + Math.cos(a) * r;
      const y = EMERGENCY_BUTTON.y + Math.sin(a) * r;
      if (circleFree(x, y, PLAYER_RADIUS + 1)) spots.push({ x, y });
    }
  }
  return spots;
})();

// ---------- Seeded PRNG ----------

class Rng {
  private state: number;

  constructor(seed: number) {
    const s = Number.isFinite(seed) ? Math.floor(seed) : 0;
    // Fold both 32-bit halves in, then scramble (murmur3 finalizer) so nearby seeds diverge.
    let h = (s ^ Math.floor(s / 4294967296)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    this.state = (h ^ (h >>> 16)) >>> 0;
  }

  /** Uniform [0, 1). mulberry32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  between(r: [number, number]): number {
    return this.range(r[0], r[1]);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// ---------- Navigation ----------

type NavStatus = 'moving' | 'arrived' | 'unreachable';

const NUDGE_DIRS: Vec[] = Array.from({ length: 8 }, (_, i) => ({
  x: Math.cos((i / 8) * Math.PI * 2),
  y: Math.sin((i / 8) * Math.PI * 2),
}));

/**
 * Walks a circle along findPath waypoints with moveWithCollision.
 * Decision code calls goTo() every tick it wants to walk; step() then moves at most `budget` px.
 * A tick without goTo() means "stand still".
 */
class Navigator {
  private key: string | null = null;
  private target: Vec = { x: 0, y: 0 };
  private arrive = 0;
  private path: Vec[] = [];
  private unreachable = false;
  private wantsMove = false;
  private bestRemaining = Infinity;
  private progressAt = 0;
  private lastStepAt = -Infinity;
  private stuckCount = 0;
  private nudgeDir: Vec | null = null;
  private nudgeUntil = 0;

  constructor(private readonly rng: Rng) {}

  reset(): void {
    this.key = null;
    this.path = [];
    this.unreachable = false;
    this.wantsMove = false;
    this.nudgeDir = null;
    this.stuckCount = 0;
  }

  /** Stand still this tick. */
  hold(): void {
    this.wantsMove = false;
  }

  /**
   * Walk toward `target` (identified by `key`) and stop within `arrive` px.
   * A moving target is followed without re-running A* until it drifts more than `retargetPx`.
   */
  goTo(key: string, target: Vec, arrive: number, pos: Vec, now: number, retargetPx = 24): NavStatus {
    if (this.key !== key || dist(this.target, target) > retargetPx) {
      this.key = key;
      this.target = { x: target.x, y: target.y };
      this.stuckCount = 0;
      this.replan(pos, now);
    } else if (this.target.x !== target.x || this.target.y !== target.y) {
      this.retarget(target);
    }
    this.arrive = arrive;
    if (now - this.lastStepAt > 250) {
      // Resuming after standing still: don't count the pause as being stuck.
      this.progressAt = now;
      this.bestRemaining = this.remaining(pos);
    }
    if (dist(pos, this.target) <= arrive) {
      this.wantsMove = false;
      return 'arrived';
    }
    if (this.unreachable) {
      this.wantsMove = false;
      return 'unreachable';
    }
    if (this.path.length === 0 && !this.nudgeDir) {
      // As close as the grid allows (target inside furniture, etc.).
      this.wantsMove = false;
      return 'arrived';
    }
    this.wantsMove = true;
    return 'moving';
  }

  /** Advance at most `budget` px along the path. Never moves farther than `budget`. */
  step(pos: Vec, budget: number, now: number): Vec {
    if (!this.wantsMove || this.key === null) return pos;
    this.wantsMove = false;
    this.lastStepAt = now;
    if (!(budget > 0)) return pos;
    if (this.nudgeDir) {
      if (now < this.nudgeUntil) {
        return moveWithCollision(pos.x, pos.y, this.nudgeDir.x * budget, this.nudgeDir.y * budget);
      }
      this.replan(pos, now);
    }
    this.smooth(pos);
    let p = pos;
    let left = budget;
    let guard = 16;
    while (left > 1e-6 && this.path.length > 0 && guard-- > 0) {
      const wp = this.path[0];
      const d = dist(p, wp);
      if (d < 0.5) {
        this.path.shift();
        continue;
      }
      const want = Math.min(left, d);
      const next = moveWithCollision(p.x, p.y, ((wp.x - p.x) / d) * want, ((wp.y - p.y) / d) * want);
      const moved = dist(p, next);
      p = next;
      left -= want;
      if (dist(p, wp) < 0.5) this.path.shift();
      else if (moved < want * 0.5) break; // blocked; progress tracking decides what to do
      if (dist(p, this.target) <= this.arrive) break;
    }
    this.trackProgress(p, now);
    return p;
  }

  private replan(pos: Vec, now: number): void {
    this.nudgeDir = null;
    const raw = findPath(pos, this.target);
    if (raw === null) {
      this.path = [];
      this.unreachable = true;
      return;
    }
    this.unreachable = false;
    const path = raw.slice();
    if (circleFree(this.target.x, this.target.y)) {
      const last = path[path.length - 1];
      if (!last || dist(last, this.target) > 0.5) path.push({ x: this.target.x, y: this.target.y });
    }
    this.path = path;
    this.progressAt = now;
    this.bestRemaining = this.remaining(pos);
  }

  private retarget(target: Vec): void {
    const old = this.target;
    this.target = { x: target.x, y: target.y };
    if (!circleFree(target.x, target.y)) return;
    const last = this.path[this.path.length - 1];
    if (last && last.x === old.x && last.y === old.y) this.path[this.path.length - 1] = { ...this.target };
    else this.path.push({ ...this.target });
  }

  /** Skip waypoints we can already walk to in a straight line (smoother than tile-center zigzags). */
  private smooth(pos: Vec): void {
    let n = 0;
    while (this.path.length >= 2 && n < 3 && segmentClear(pos, this.path[1])) {
      this.path.shift();
      n++;
    }
  }

  private remaining(pos: Vec): number {
    if (this.path.length === 0) return dist(pos, this.target);
    let len = dist(pos, this.path[0]);
    for (let i = 1; i < this.path.length; i++) len += dist(this.path[i - 1], this.path[i]);
    return len;
  }

  private trackProgress(p: Vec, now: number): void {
    const rem = this.remaining(p);
    if (rem < this.bestRemaining - PROGRESS_EPS) {
      this.bestRemaining = rem;
      this.progressAt = now;
      return;
    }
    if (now - this.progressAt < STUCK_MS) return;
    this.stuckCount++;
    this.progressAt = now;
    if (this.stuckCount >= MAX_STUCK) {
      this.unreachable = true;
      this.path = [];
      return;
    }
    if (this.stuckCount % 2 === 1) this.replan(p, now);
    else this.startNudge(p, now);
  }

  private startNudge(p: Vec, now: number): void {
    for (const d of this.rng.shuffle(NUDGE_DIRS.slice())) {
      const q = moveWithCollision(p.x, p.y, d.x * 20, d.y * 20);
      if (dist(p, q) >= 10) {
        this.nudgeDir = d;
        this.nudgeUntil = now + this.rng.range(300, 600);
        this.progressAt = now;
        return;
      }
    }
    this.replan(p, now);
  }
}

// ---------- Memory and plans ----------

interface SeenInfo {
  x: number;
  y: number;
  t: number;
}

interface WitnessInfo {
  /** 'rug': stood over a fresh body. 'vent': vanished into / popped out of a bridge in plain sight. */
  kind: 'rug' | 'vent';
  victimId: string | null;
  room: string;
  t: number;
}

interface NearBodyInfo {
  room: string;
  t: number;
  /** mem.meetingSeq when observed: only the next meeting uses it. */
  meetingSeq: number;
  /** How many players stood near that body (the evidence is split between them). */
  group: number;
  /** Color of that body, to tell whether the meeting is about it. */
  bodyColor: number;
  /** 'near': standing by the body when we found it. 'around': seen at that spot earlier. */
  kind: 'near' | 'around';
  /** For 'around': how long before we found the body we saw them there. */
  age: number;
}

interface SeenWithInfo {
  /** Other players standing near them at the time. */
  others: string[];
  t: number;
  room: string;
}

interface SeenBody {
  x: number;
  y: number;
  color: number;
  room: string;
  t: number;
}

/** Everything a bot knows about the current game. Replaced on every new game. */
class GameMemory {
  readonly lastSeen = new Map<string, SeenInfo>();
  /** Recent sightings per player, sampled every SIGHTING_SAMPLE_MS (alibis: who was where when). */
  readonly sightings = new Map<string, SeenInfo[]>();
  /** Living players visible in the latest snapshot (vision-filtered). */
  visible: PlayerView[] = [];
  /** Ids in the previous playing snapshot's player list (null right after a phase change). */
  prevListed: Set<string> | null = null;
  readonly knownBodies = new Set<string>();
  /** False until the first playing snapshot, so pre-existing bodies don't count as fresh. */
  bodyBaseline = false;
  readonly seenBodies = new Map<string, SeenBody>();
  /** killerId -> what the bot saw. */
  readonly witnessed = new Map<string, WitnessInfo>();
  readonly nearBody = new Map<string, NearBodyInfo>();
  readonly fellowRuggers = new Set<string>();
  readonly teamKills: { killerId: string; victimId: string; t: number }[] = [];
  /**
   * Every player listed this game, and the ones known to be out (bodies, ghosts, ejected, left).
   * With interest management a far-away living player is simply not listed, so "not in the
   * snapshot" must never be read as "dead".
   */
  readonly roster = new Set<string>();
  readonly gone = new Set<string>();
  /** playerId -> who stood near them the last time this bot saw them. */
  readonly seenWith = new Map<string, SeenWithInfo>();
  /** This bot's position on the previous playing snapshot (bridge watching). */
  prevHere: Vec | null = null;
  /** Ruggers still in the game, as of the last ejection screen. */
  ruggersLeft: number | null = null;
  killedBy: string | null = null;
  readonly locallyDone = new Set<string>();
  readonly failedUntil = new Map<string, number>();
  readonly emergencyCalledFor = new Set<string>();
  readonly stalked = new Map<string, number>();
  lastRoom: string | null = null;
  alibi: { room: string; kind: TaskKind } | null = null;
  reportedRoom: string | null = null;
  meetingSeq = 0;
}

interface TaskWork {
  stationId: string;
  kind: TaskKind;
  stage: 'walking' | 'open' | 'submitted';
  openedAt: number;
  doneAt: number;
  submittedAt: number;
  attempts: number;
}

interface FakeWork {
  stationId: string;
  stage: 'walking' | 'faking' | 'idle';
  until: number;
}

interface WanderPlan {
  key: string;
  target: Vec;
  pauseUntil: number;
}

interface ReportPlan {
  bodyId: string;
  reactAt: number;
  attempts: number;
  lastSentAt: number;
}

interface EmergencyPlan {
  startAt: number;
  giveUpAt: number;
  spot: Vec | null;
  attempts: number;
  lastSentAt: number;
}

interface FixPlan {
  kind: 'fud' | 'rpcDown';
  going: boolean;
  nextRollAt: number;
  arrivedAt: number | null;
  doneAt: number;
  attempts: number;
  lastSentAt: number;
}

interface DumpPlan {
  stationId: string;
  holdSentAt: number;
  nextEvalAt: number;
}

interface HuntPlan {
  targetId: string;
  startedAt: number;
  lastSeenAt: number;
  lastPos: Vec;
  exposedSince: number | null;
}

interface StalkPlan {
  targetId: string;
  target: Vec;
  until: number;
}

interface KillAttempt {
  targetId: string;
  at: number;
  prevReadyAt: number;
}

interface EscapePlan {
  mode: 'vent' | 'walk';
  startedAt: number;
  from: Vec;
  ventId: string | null;
  target: Vec | null;
  stationId: string | null;
  enterAttempts: number;
  lastEnterAt: number;
}

interface VentPlan {
  entered: boolean;
  createdAt: number;
  hopsLeft: number;
  extraHops: number;
  currentVent: string | null;
  nextAt: number;
  waitStart: number;
  lastExitAt: number;
  from: Vec;
}

interface QueuedLine {
  at: number;
  text: string;
  channel: 'meeting' | 'ghost';
  meetingSeq: number;
}

interface Accusation {
  score: number;
  /** Independent accusers (echoes of an existing accusation don't count). */
  accusers: Set<string>;
  /** Accusers who claimed to have seen it happen. */
  eyewitnesses: Set<string>;
  /** "yeah X is sus": agreeing with someone else's accusation. */
  echoes: Set<string>;
}

/**
 * saw: "X rugged in Y, I saw it". near: "X was near the body". evidence: anything else short of
 * seeing it ("X vented", "last saw V with X"). accuse: "X sus". echo: agreeing with someone else.
 */
type ClaimKind = 'saw' | 'near' | 'evidence' | 'accuse' | 'echo';

interface Claim {
  from: string;
  target: string;
  kind: ClaimKind;
  /** The claim is about a rug (so it must fit the reported body), not a bridge. */
  rug: boolean;
  /** Lowercase room named in the line. */
  room: string | null;
}

interface MeetingState {
  startedAt: number;
  votingSeenAt: number | null;
  voteAt: number | null;
  voteAttempts: number;
  lastVoteSentAt: number;
  linesLeft: number;
  reacted: boolean;
  defended: boolean;
  /** Suspicion this (holder) bot needs before voting someone out this meeting. */
  threshold: number;
  /** Players who made an eyewitness claim against this (innocent holder) bot. */
  liars: Set<string>;
  accusations: Map<string, Accusation>;
  claims: Claim[];
  /** Accused players who denied it. */
  contested: Set<string>;
  /** playerId -> who spoke up for them ("X was with me"). */
  vouches: Map<string, Set<string>>;
  /** Players this bot already vouched for. */
  vouched: Set<string>;
  /** Players this bot already shared its own evidence about. */
  voiced: Set<string>;
  /** playerId -> who they said they are voting for. */
  announced: Map<string, string>;
  /** When to announce our vote in a must-win meeting (null: not planned or done). */
  announceAt: number | null;
  /** The vote we announced. */
  committed: string | null;
  /** Lowercase room of the reported body: seen by this bot, or said by the reporter. */
  bodyRoom: string | null;
  /** Someone already said where the body was. */
  bodyRoomHeard: boolean;
  /** Lowercase meeting lines already said by anyone (no repeats). */
  heard: Set<string>;
  /** Where this bot last saw each player before the meeting (alibis). */
  seenBefore: Map<string, SeenInfo>;
}

// ---------- The brain ----------

export class BotBrain {
  private readonly id: string;
  private readonly sendFn: (msg: C2S) => void;
  private readonly rng: Rng;
  private readonly nav: Navigator;

  private snap: Snapshot | null = null;
  private phase: Phase | null = null;
  private now = 0;
  private lastTickAt: number | null = null;
  private lastErrorLogAt = -Infinity;

  // Movement. `pos` is the bot's own simulated position; `sentPos` is what the server has.
  private pos: Vec | null = null;
  private sentPos: Vec | null = null;
  private teleportSeq: number | null = null;
  private facing: 1 | -1 = 1;
  private lastMoveSentAt = -Infinity;
  private lastSentMoving = false;
  /** Set after a message that teleports us or ends `playing`; no moves until the next snapshot. */
  private awaitingSnapshot = false;

  // Per-game state.
  private mem = new GameMemory();
  private wasAlive: boolean | null = null;
  private sabotageKind: SabotageKind | null = null;
  private lastKillReadyAt: number | null = null;
  private huntAfter = 0;
  /** No rug before this: a fellow rugger just rugged (team pacing). */
  private teamHoldUntil = 0;
  /** Round start: the kill cooldown that comes next is the round's first, so take turns. */
  private roundStartPending = false;
  /** Until our first rug chance of the round, even an opportunistic rug waits for huntAfter. */
  private roundGate = false;

  // Plans (cleared on every phase change).
  private task: TaskWork | null = null;
  private fake: FakeWork | null = null;
  private lastFakeId: string | null = null;
  private wander: WanderPlan | null = null;
  private wanderSeq = 0;
  private report: ReportPlan | null = null;
  private emergency: EmergencyPlan | null = null;
  private fix: FixPlan | null = null;
  private dump: DumpPlan | null = null;
  private hunt: HuntPlan | null = null;
  private stalk: StalkPlan | null = null;
  private killAttempt: KillAttempt | null = null;
  private lastKillAttemptAt = -Infinity;
  private escape: EscapePlan | null = null;
  private ventPlan: VentPlan | null = null;
  private openTaskId: string | null = null;
  private holdingStationId: string | null = null;
  private nextTaskPickAt = 0;
  private taskPauseUntil = 0;
  private nextSabotageRollAt = 0;
  private lastSabotageAt = -Infinity;

  // Names seen in snapshots (persist across games; players keep their seats).
  private readonly names = new Map<string, string>();
  private nameMatchers: { id: string; re: RegExp; reAll: RegExp }[] | null = null;

  // Meetings and chat.
  private meeting: MeetingState | null = null;
  private chatQueue: QueuedLine[] = [];
  private pendingMeetingChat: ChatMessage[] = [];
  private lastChatAt = -Infinity;
  private nextBanterAt = Infinity;

  constructor(opts: BotBrainOptions) {
    this.id = opts.id;
    this.sendFn = opts.send;
    this.rng = new Rng(opts.seed);
    this.nav = new Navigator(this.rng);
  }

  /** The room calls this with the bot's per-client snapshot every tick. */
  onSnapshot(snap: Snapshot): void {
    this.guard(() => this.handleSnapshot(snap));
  }

  onChat(msg: ChatMessage): void {
    this.guard(() => this.handleChat(msg));
  }

  onEvent(event: GameEvent): void {
    this.guard(() => this.handleEvent(event));
  }

  /** Called every server tick (20 Hz) with server time. */
  tick(now: number): void {
    this.guard(() => this.handleTick(now));
  }

  // ---------- Plumbing ----------

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // A confused bot must never take the room down; log at most every 10 s per bot.
      if (this.now - this.lastErrorLogAt > 10000 || this.lastErrorLogAt === -Infinity) {
        this.lastErrorLogAt = this.now;
        console.error(`[bot ${this.id}]`, err);
      }
    }
  }

  private send(msg: C2S): void {
    this.sendFn(msg);
  }

  private get here(): Vec {
    return this.pos ?? { x: 0, y: 0 };
  }

  /** Where the server thinks we are (last move we sent, or the last teleport). */
  private get serverPos(): Vec {
    return this.sentPos ?? this.here;
  }

  private inRange(p: Vec, range: number): boolean {
    return dist(this.serverPos, p) <= range - RANGE_MARGIN;
  }

  // ---------- Snapshot intake ----------

  private handleSnapshot(snap: Snapshot): void {
    this.snap = snap;
    this.awaitingSnapshot = false;
    if (Number.isFinite(snap.now) && snap.now > this.now) this.now = snap.now;
    for (const p of snap.players) this.rememberName(p.id, p.name);

    const me = snap.me;
    if (!me) {
      // Lobby (or not seated): nothing to play.
      if (this.phase !== snap.phase && this.phase !== null) this.resetGame();
      this.phase = snap.phase;
      return;
    }

    if (this.phase !== snap.phase) this.enterPhase(this.phase, snap, me);
    this.phase = snap.phase;
    this.trackRoster(snap);

    if (this.pos === null || this.teleportSeq !== me.teleportSeq || !Number.isFinite(this.pos.x)) {
      this.syncPosition(me);
    }

    if (this.wasAlive === true && !me.alive) this.onDeath(snap.now, me);
    this.wasAlive = me.alive;

    if (me.role === 'rugger') {
      for (const p of snap.players) if (p.isRugger && p.id !== me.id) this.mem.fellowRuggers.add(p.id);
      const readyAt = me.killReadyAt;
      if (readyAt !== undefined && this.roundStartPending && snap.phase === 'playing') {
        // Every rugger is ready at the same moment at round start: take turns instead of all
        // rugging at once. A later turn waits even for an opportunistic rug.
        this.roundStartPending = false;
        this.lastKillReadyAt = readyAt;
        const rank = this.ruggerRank(snap, me);
        this.roundGate = rank > 0;
        this.huntAfter = readyAt + rank * ROUND_STAGGER_MS + (rank > 0 ? this.rng.between(ROUND_HESITATION_MS) : this.rng.range(0, 3000));
      } else if (readyAt !== undefined && readyAt !== this.lastKillReadyAt) {
        this.lastKillReadyAt = readyAt;
        // A bit of human hesitation before actively hunting (opportunistic rugs ignore it).
        this.huntAfter = readyAt + this.rng.range(0, 3000);
      }
      const attempt = this.killAttempt;
      if (attempt) {
        const cooldownReset = me.killReadyAt !== undefined && me.killReadyAt > attempt.prevReadyAt;
        const bodyAppeared = snap.bodies.some((b) => b.id === attempt.targetId);
        if (cooldownReset || bodyAppeared) this.onKillConfirmed(snap.now);
      }
      if (me.ventId && this.ventPlan) this.ventPlan.entered = true;
    }

    const kind = snap.sabotage?.kind ?? null;
    if (kind !== this.sabotageKind) {
      this.sabotageKind = kind;
      this.onSabotageChange(kind, snap, me);
    }

    if (snap.phase === 'playing') this.perceive(snap, me);
  }

  /** Who is in this game and who is known to be out of it (see GameMemory.roster). */
  private trackRoster(snap: Snapshot): void {
    if (snap.phase === 'lobby') return;
    for (const p of snap.players) {
      this.mem.roster.add(p.id);
      if (!p.alive) this.mem.gone.add(p.id);
    }
    for (const b of snap.bodies) this.mem.gone.add(b.id);
    const ejected = snap.ejection?.ejectedId;
    if (ejected) this.mem.gone.add(ejected);
    const left = snap.ejection?.ruggersLeft;
    if (typeof left === 'number' && Number.isFinite(left)) this.mem.ruggersLeft = left;
  }

  /** This rugger's turn at round start among the living ruggers (rotates every meeting). */
  private ruggerRank(snap: Snapshot, me: MeView): number {
    const team = [me.id];
    for (const p of snap.players) if (p.id !== me.id && p.alive && (p.isRugger || this.mem.fellowRuggers.has(p.id))) team.push(p.id);
    team.sort();
    return (team.indexOf(me.id) + this.mem.meetingSeq) % team.length;
  }

  private rememberName(id: string, name: string): void {
    if (this.names.get(id) === name) return;
    this.names.set(id, name);
    this.nameMatchers = null;
  }

  private syncPosition(me: MeView): void {
    this.pos = { x: me.x, y: me.y };
    this.sentPos = { x: me.x, y: me.y };
    this.teleportSeq = me.teleportSeq;
    this.lastSentMoving = false;
    this.nav.reset();
  }

  private enterPhase(from: Phase | null, snap: Snapshot, me: MeView): void {
    this.clearPlans();
    this.mem.prevListed = null;
    switch (snap.phase) {
      case 'roleReveal':
        this.resetGame();
        break;
      case 'playing':
        // Bodies were cleared by the meeting; anything listed now is not "fresh".
        this.mem.knownBodies.clear();
        for (const b of snap.bodies) this.mem.knownBodies.add(b.id);
        this.mem.bodyBaseline = true;
        this.mem.prevHere = null;
        this.meeting = null;
        this.pendingMeetingChat = [];
        this.roundStartPending = true;
        this.roundGate = false;
        if (from === 'meeting' || from === 'ejection') this.maybePlanPostMeetingEmergency(snap, me);
        break;
      case 'meeting':
        this.beginMeeting(snap.now, snap, me);
        break;
      case 'ejection':
        break;
      case 'gameOver':
      case 'lobby':
        this.resetGame();
        break;
    }
  }

  private clearPlans(): void {
    this.task = null;
    this.fake = null;
    this.wander = null;
    this.report = null;
    this.emergency = null;
    this.fix = null;
    this.dump = null;
    this.hunt = null;
    this.stalk = null;
    this.killAttempt = null;
    this.escape = null;
    this.ventPlan = null;
    // The server closes minigames, holds and bridges itself on every phase change.
    this.openTaskId = null;
    this.holdingStationId = null;
    this.nextTaskPickAt = 0;
    this.taskPauseUntil = 0;
    this.nav.reset();
  }

  private resetGame(): void {
    this.clearPlans();
    this.mem = new GameMemory();
    this.meeting = null;
    this.chatQueue = [];
    this.pendingMeetingChat = [];
    this.nextBanterAt = Infinity;
    this.wasAlive = null;
    this.sabotageKind = null;
    this.lastKillReadyAt = null;
    this.huntAfter = 0;
    this.teamHoldUntil = 0;
    this.roundStartPending = false;
    this.roundGate = false;
    this.lastFakeId = null;
    this.pos = null;
    this.sentPos = null;
    this.teleportSeq = null;
    this.lastSentMoving = false;
  }

  private onDeath(now: number, me: MeView): void {
    // The server closed our task and dropped our holds; ghosts only do tasks.
    this.report = null;
    this.emergency = null;
    this.fix = null;
    this.dump = null;
    this.hunt = null;
    this.stalk = null;
    this.killAttempt = null;
    this.escape = null;
    this.openTaskId = null;
    this.holdingStationId = null;
    if (this.task) this.task.stage = 'walking';
    this.nav.reset();
    if (this.phase === 'playing' && this.rng.chance(0.35)) this.queueLine(this.ghostLine(me), now + this.rng.range(4000, 10000), 'ghost');
    this.nextBanterAt = now + this.rng.range(45000, 90000);
  }

  // ---------- Perception ----------

  private visionRadius(snap: Snapshot, me: MeView): number {
    if (me.role === 'rugger') return BASE_VISION * finiteOr(snap.room.settings.ruggerVision, 1);
    return holderVision(snap);
  }

  private speed(snap: Snapshot, me: MeView): number {
    return BASE_SPEED * finiteOr(snap.room.settings.playerSpeed, 1) * (me.alive ? 1 : GHOST_SPEED_MULT);
  }

  private perceive(snap: Snapshot, me: MeView): void {
    const pos = this.here;
    const now = snap.now;
    const ghost = !me.alive; // ghosts see everything, no fog
    const radius = this.visionRadius(snap, me);
    const visible: PlayerView[] = [];
    for (const p of snap.players) {
      if (p.id === me.id || !p.alive || p.inVent) continue;
      if (ghost || canSee(pos, p, radius)) {
        visible.push(p);
        this.mem.lastSeen.set(p.id, { x: p.x, y: p.y, t: now });
        if (me.alive) this.recordSighting(p, now);
      }
    }
    const prevVisible = this.mem.visible;
    this.mem.visible = visible;
    if (me.alive) {
      this.mem.lastRoom = roomLabelAt(pos);
      // Who is hanging around whom ("last saw X with Y" in the next meeting).
      for (const p of visible) {
        const others: string[] = [];
        for (const q of visible) if (q.id !== p.id && dist(q, p) <= SEEN_WITH_PX) others.push(q.id);
        this.mem.seenWith.set(p.id, { others, t: now, room: roomLabelAt(p) });
      }
    }
    if (me.alive && me.role === 'holder') this.watchBridges(now, snap, me, prevVisible, visible);
    this.mem.prevListed = new Set(snap.players.map((p) => p.id));
    this.mem.prevHere = { x: pos.x, y: pos.y };

    for (const b of snap.bodies) {
      const fresh = this.mem.bodyBaseline && !this.mem.knownBodies.has(b.id);
      this.mem.knownBodies.add(b.id);
      if (ghost || b.id === me.id || this.mem.seenBodies.has(b.id)) continue;
      if (!canSee(pos, b, radius)) continue;
      this.onBodySighted(now, snap, me, b, fresh, visible);
    }
    this.mem.bodyBaseline = true;
  }

  private recordSighting(p: PlayerView, now: number): void {
    let list = this.mem.sightings.get(p.id);
    if (!list) this.mem.sightings.set(p.id, (list = []));
    const last = list[list.length - 1];
    if (last && now - last.t < SIGHTING_SAMPLE_MS) return;
    list.push({ x: p.x, y: p.y, t: now });
    while (list.length > 0 && now - list[0].t > SIGHTING_KEEP_MS) list.shift();
  }

  /**
   * Holders never receive vented ruggers, so a visible player who vanishes next to a bridge (without
   * leaving a body) went into it, and one who pops up on a bridge just came out of it.
   */
  private watchBridges(now: number, snap: Snapshot, me: MeView, prevVisible: PlayerView[], visible: PlayerView[]): void {
    const prevListed = this.mem.prevListed;
    const prevHere = this.mem.prevHere;
    if (!prevListed || !prevHere) return;
    const listed = new Set(snap.players.map((p) => p.id));
    const radius = this.visionRadius(snap, me);
    // The server may also stop sending a player who just stepped out of our sight (interest
    // management), so only a spot we see clearly, from here and from where we just were, counts:
    // nobody walks out of that in one tick.
    const clearlySeen = (p: Vec) => {
      if (!canSee(this.here, p, radius - BRIDGE_VIEW_MARGIN) || !canSee(prevHere, p, radius - BRIDGE_VIEW_MARGIN)) return false;
      const d = BRIDGE_VIEW_PROBE;
      return [
        { x: p.x + d, y: p.y },
        { x: p.x - d, y: p.y },
        { x: p.x, y: p.y + d },
        { x: p.x, y: p.y - d },
      ].every((q) => canSee(this.here, q, radius));
    };
    for (const p of prevVisible) {
      // Gone without a body: into a bridge (a disconnect timeout also removes players; skip those).
      if (p.disconnected || listed.has(p.id) || snap.bodies.some((b) => b.id === p.id)) continue;
      const vent = VENTS.find((v) => dist(v, p) <= VENT_SIGHT_PX);
      if (vent && clearlySeen(vent) && clearlySeen(p)) this.sawBridge(now, snap, me, p.id, vent);
    }
    for (const p of visible) {
      // Popped up right on a bridge we were already watching.
      if (prevListed.has(p.id)) continue;
      const vent = VENTS.find((v) => dist(v, p) <= BRIDGE_EXIT_PX);
      if (vent && clearlySeen(vent) && clearlySeen(p)) this.sawBridge(now, snap, me, p.id, vent);
    }
  }

  private sawBridge(now: number, snap: Snapshot, me: MeView, playerId: string, vent: { x: number; y: number }): void {
    if (this.mem.witnessed.has(playerId)) return;
    this.mem.witnessed.set(playerId, { kind: 'vent', victimId: null, room: roomLabelAt(vent), t: now });
    // No body to report, so this is what SPACES is for (sometimes).
    if (!this.emergency && this.rng.chance(0.35) && this.emergencyPossible(snap, me)) {
      this.emergency = this.newEmergencyPlan(now + this.rng.between(REPORT_REACT_MS));
      this.mem.emergencyCalledFor.add(playerId);
    }
  }

  private onBodySighted(now: number, snap: Snapshot, me: MeView, body: BodyView, fresh: boolean, visible: PlayerView[]): void {
    const room = roomLabelAt(body);
    this.mem.seenBodies.set(body.id, { x: body.x, y: body.y, color: body.color, room, t: now });
    const others = visible.filter((p) => !this.isFellow(p.id, snap));
    const near = others.filter((p) => dist(p, body) <= NEAR_BODY_PX);
    const seq = this.mem.meetingSeq;
    for (const p of near) {
      this.mem.nearBody.set(p.id, { room, t: now, meetingSeq: seq, group: near.length, bodyColor: body.color, kind: 'near', age: 0 });
    }
    // Someone we saw at this very spot shortly before, and who is gone now.
    for (const [id, s] of this.mem.lastSeen) {
      if (id === me.id || id === body.id || visible.some((p) => p.id === id) || this.isFellow(id, snap)) continue;
      if (now - s.t > AROUND_BODY_MS || dist(s, body) > AROUND_BODY_PX || !this.isAlive(id, snap)) continue;
      const prev = this.mem.nearBody.get(id);
      if (prev && prev.meetingSeq === seq && (prev.kind === 'near' || prev.age <= now - s.t)) continue;
      this.mem.nearBody.set(id, { room, t: now, meetingSeq: seq, group: 1, bodyColor: body.color, kind: 'around', age: now - s.t });
    }
    if (me.role !== 'holder' || !me.alive) return;

    // A body that just appeared with exactly one player standing over it: we watched the rug.
    const suspects = fresh ? others.filter((p) => dist(p, body) <= NEAR_FRESH_BODY_PX) : [];
    const witnessed = suspects.length === 1 ? suspects[0] : null;
    if (witnessed) this.mem.witnessed.set(witnessed.id, { kind: 'rug', victimId: body.id, room, t: now });

    if (!this.report) {
      this.report = { bodyId: body.id, reactAt: now + this.rng.between(REPORT_REACT_MS), attempts: 0, lastSentAt: -Infinity };
    }
    // Now and then a witness runs for the SPACES button instead of reporting.
    if (witnessed && !this.emergency && this.rng.chance(0.2) && this.emergencyPossible(snap, me)) {
      this.emergency = this.newEmergencyPlan(now + this.rng.between(REPORT_REACT_MS));
      this.mem.emergencyCalledFor.add(witnessed.id);
    }
  }

  private isFellow(id: string, snap: Snapshot): boolean {
    if (snap.me?.role !== 'rugger') return false;
    if (this.mem.fellowRuggers.has(id)) return true;
    return snap.players.some((p) => p.id === id && p.isRugger === true);
  }

  /**
   * Whether a player is still in the game alive. A living player we can't see may simply not be
   * sent to us (interest management, or a holder not seeing a vented rugger), so an unlisted player
   * counts as alive unless we know they are out.
   */
  private isAlive(id: string, snap: Snapshot): boolean {
    const p = snap.players.find((q) => q.id === id);
    if (p) return p.alive;
    return this.mem.roster.has(id) && !this.mem.gone.has(id);
  }

  // ---------- Tick ----------

  private handleTick(now: number): void {
    if (!Number.isFinite(now)) return;
    // Movement uses real elapsed time between ticks, capped so one late tick never jumps.
    const dtMs = this.lastTickAt === null ? 0 : clamp(now - this.lastTickAt, 0, MAX_STEP_MS);
    this.lastTickAt = now;
    if (now > this.now) this.now = now;
    const snap = this.snap;
    const me = snap?.me;
    if (!snap || !me || !this.pos) return;

    if (snap.phase === 'playing') {
      this.thinkPlaying(now, snap, me);
      this.updateMovement(dtMs, now, snap, me);
      this.flushMove(now, me);
    } else {
      this.nav.reset();
      if (snap.phase === 'meeting') this.thinkMeeting(now, snap, me);
    }
    this.thinkChat(now, snap, me);
  }

  private updateMovement(dtMs: number, now: number, snap: Snapshot, me: MeView): void {
    if (!this.pos) return;
    if (me.ventId || this.awaitingSnapshot) {
      this.nav.hold();
      return;
    }
    const budget = (this.speed(snap, me) * dtMs) / 1000;
    const before = this.pos;
    const after = this.nav.step(before, budget, now);
    if (!Number.isFinite(after.x) || !Number.isFinite(after.y)) return;
    const dx = after.x - before.x;
    if (dx > 0.01) this.facing = 1;
    else if (dx < -0.01) this.facing = -1;
    this.pos = after;
  }

  private flushMove(now: number, me: MeView): void {
    if (!this.pos || me.ventId || this.awaitingSnapshot) return;
    if (now - this.lastMoveSentAt < MOVE_INTERVAL_MS) return;
    const changed = !this.sentPos || this.pos.x !== this.sentPos.x || this.pos.y !== this.sentPos.y;
    if (!changed && !this.lastSentMoving) return;
    this.send({ t: 'move', x: this.pos.x, y: this.pos.y, facing: this.facing, moving: changed });
    this.sentPos = { x: this.pos.x, y: this.pos.y };
    this.lastSentMoving = changed;
    this.lastMoveSentAt = now;
  }

  private thinkPlaying(now: number, snap: Snapshot, me: MeView): void {
    if (me.role === 'rugger') this.thinkRugger(now, snap, me);
    else this.thinkHolder(now, snap, me);
  }

  // ---------- Holder (and ghost) ----------

  private thinkHolder(now: number, snap: Snapshot, me: MeView): void {
    if (me.alive) {
      if (this.runEmergency(now, snap, me)) return;
      if (this.runReport(now, snap)) return;
      if (this.runDump(now, snap, me)) return;
      if (this.runFix(now, snap)) return;
    }
    if (this.runTasks(now, me)) return;
    this.runWander(now);
  }

  /** Close an open task minigame and release a BUY WALL before doing something else. */
  private leaveStation(): void {
    this.closeTaskIfOpen();
    this.releaseHold();
  }

  private openTask(stationId: string): void {
    this.send({ t: 'taskOpen', stationId });
    this.openTaskId = stationId;
  }

  private closeTaskIfOpen(): void {
    if (this.openTaskId === null) return;
    this.send({ t: 'taskClose' });
    this.openTaskId = null;
    if (this.task && this.task.stage !== 'walking') this.task.stage = 'walking';
    if (this.fake && this.fake.stage === 'faking') this.fake = null;
  }

  private releaseHold(): void {
    if (this.holdingStationId === null) return;
    if (this.snap?.sabotage?.kind === 'devDump') {
      this.send({ t: 'fix', stationId: this.holdingStationId, action: 'holdEnd' });
    }
    this.holdingStationId = null;
  }

  private failGoal(id: string, now: number): void {
    this.mem.failedUntil.set(id, now + FAILED_GOAL_MS);
  }

  private isFailed(id: string, now: number): boolean {
    return (this.mem.failedUntil.get(id) ?? 0) > now;
  }

  private runReport(now: number, snap: Snapshot): boolean {
    const plan = this.report;
    if (!plan) return false;
    const body = snap.bodies.find((b) => b.id === plan.bodyId);
    if (!body) {
      this.report = null;
      return false;
    }
    if (now < plan.reactAt) return false; // still "noticing" it; keep doing whatever we were doing
    this.leaveStation();
    if (this.inRange(body, REPORT_RANGE)) {
      this.nav.hold();
      if (plan.attempts >= 4 && now - plan.lastSentAt > 1000) {
        this.report = null;
        return false;
      }
      if (now - plan.lastSentAt >= 1000) {
        this.send({ t: 'report', bodyId: body.id });
        this.awaitingSnapshot = true; // a meeting starts right away
        plan.attempts++;
        plan.lastSentAt = now;
        this.mem.reportedRoom = roomLabelAt(body);
      }
      return true;
    }
    const status = this.nav.goTo(`body:${body.id}`, body, REPORT_RANGE * 0.5, this.here, now);
    if (status === 'unreachable') {
      this.report = null;
      return false;
    }
    return true;
  }

  private emergencyPossible(snap: Snapshot, me: MeView): boolean {
    return me.alive && me.emergencyLeft > 0 && snap.sabotage?.kind !== 'devDump' && EMERGENCY_SPOTS.length > 0;
  }

  private newEmergencyPlan(startAt: number): EmergencyPlan {
    return { startAt, giveUpAt: startAt + 30000, spot: null, attempts: 0, lastSentAt: -Infinity };
  }

  private maybePlanPostMeetingEmergency(snap: Snapshot, me: MeView): void {
    if (me.role !== 'holder' || !this.emergencyPossible(snap, me)) return;
    for (const killerId of this.mem.witnessed.keys()) {
      if (this.mem.emergencyCalledFor.has(killerId) || !this.isAlive(killerId, snap)) continue;
      this.mem.emergencyCalledFor.add(killerId);
      // The rugger we saw survived the vote: sometimes call SPACES on them again.
      if (this.rng.chance(0.35)) this.emergency = this.newEmergencyPlan(snap.now + this.rng.range(4000, 15000));
      return;
    }
  }

  private runEmergency(now: number, snap: Snapshot, me: MeView): boolean {
    const plan = this.emergency;
    if (!plan || now < plan.startAt) return false;
    if (!this.emergencyPossible(snap, me) || now > plan.giveUpAt || (plan.attempts >= 3 && now - plan.lastSentAt > 1500)) {
      this.emergency = null;
      return false;
    }
    if (!plan.spot) {
      plan.spot = this.pickEmergencySpot();
      if (!plan.spot) {
        // Can't reach the button: fall back to reporting (if there is a body).
        this.emergency = null;
        return false;
      }
    }
    this.leaveStation();
    if (dist(this.serverPos, EMERGENCY_BUTTON) <= EMERGENCY_RANGE - 4) {
      this.nav.hold();
      if (now - plan.lastSentAt >= 1200 && plan.attempts < 3) {
        this.send({ t: 'emergency' });
        this.awaitingSnapshot = true;
        plan.attempts++;
        plan.lastSentAt = now;
      }
      return true;
    }
    const status = this.nav.goTo('emergency', plan.spot, 2, this.here, now);
    if (status === 'unreachable') {
      this.emergency = null;
      return false;
    }
    return true;
  }

  private pickEmergencySpot(): Vec | null {
    return nearestByPath(this.here, EMERGENCY_SPOTS)?.item ?? null;
  }

  private onSabotageChange(kind: SabotageKind | null, snap: Snapshot, me: MeView): void {
    // A new or cleared sabotage invalidates fix plans; the server already dropped every hold.
    this.fix = null;
    this.dump = null;
    this.holdingStationId = null;
    if (kind === null || me.role !== 'holder' || !me.alive) return;
    if (kind === 'fud' || kind === 'rpcDown') {
      const undone = me.tasks.filter((t) => !t.done).length;
      this.fix = {
        kind,
        going: this.rng.chance(undone === 0 ? 0.85 : 0.5),
        nextRollAt: snap.now + this.rng.range(12000, 18000),
        arrivedAt: null,
        doneAt: 0,
        attempts: 0,
        lastSentAt: -Infinity,
      };
    }
    // devDump is planned lazily in runDump (needs the bot's position).
  }

  private runDump(now: number, snap: Snapshot, me: MeView): boolean {
    const sab = snap.sabotage;
    if (!sab || sab.kind !== 'devDump') {
      this.dump = null;
      return false;
    }
    if (sab.endsAt !== undefined && now > sab.endsAt) return false;
    if (!this.dump) {
      this.dump = this.planDump(now, sab.stations.map((s) => s.id));
      if (!this.dump) return false;
    }
    const plan = this.dump;
    const station = sabotageStationById(plan.stationId);
    if (!station) {
      this.dump = null;
      return false;
    }
    this.closeTaskIfOpen();

    const view = sab.stations.find((s) => s.id === plan.stationId);
    const otherView = sab.stations.find((s) => s.id !== plan.stationId);
    const holdingHere = this.holdingStationId === plan.stationId;

    // Spread out: if our wall is covered and the other one is empty, sometimes switch.
    if (now >= plan.nextEvalAt && view?.holders !== undefined && otherView?.holders !== undefined) {
      plan.nextEvalAt = now + 1500;
      const othersHere = view.holders - (holdingHere ? 1 : 0);
      if (otherView.holders === 0 && othersHere >= 1 && this.rng.chance(holdingHere ? 0.3 : 0.45)) {
        const other = sabotageStationById(otherView.id);
        const timeLeft = (sab.endsAt ?? Infinity) - now;
        if (other) {
          const eta = (pathLength(this.here, other) / this.speed(snap, me)) * 1000;
          if (eta < timeLeft - 2500) {
            this.releaseHold();
            plan.stationId = other.id;
            return true;
          }
        }
      }
    }

    if (this.inRange(station, USE_RANGE) && dist(this.here, station) <= USE_RANGE - RANGE_MARGIN) {
      this.nav.hold();
      if (!holdingHere) {
        this.releaseHold();
        this.send({ t: 'fix', stationId: station.id, action: 'holdStart' });
        this.holdingStationId = station.id;
        plan.holdSentAt = now;
      } else if ((view?.holders ?? 1) === 0 && now - plan.holdSentAt > 800) {
        // We got dropped (or the press never landed): press again.
        this.send({ t: 'fix', stationId: station.id, action: 'holdStart' });
        plan.holdSentAt = now;
      }
      return true;
    }
    if (holdingHere) this.releaseHold();
    const status = this.nav.goTo(`dump:${station.id}`, station, 3, this.here, now);
    if (status === 'unreachable') {
      const alt = sab.stations.find((s) => s.id !== plan.stationId);
      if (alt && !this.isFailed(alt.id, now)) {
        this.failGoal(plan.stationId, now);
        plan.stationId = alt.id;
        return true;
      }
      this.dump = null;
      return false;
    }
    return true;
  }

  private planDump(now: number, stationIds: string[]): DumpPlan | null {
    const options = stationIds
      .map((id) => sabotageStationById(id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .map((s) => ({ id: s.id, len: pathLength(this.here, s) }))
      .filter((o) => Number.isFinite(o.len))
      .sort((a, b) => a.len - b.len);
    if (options.length === 0) return null;
    let choice = options[0];
    // When both walls are about as far, split up instead of everyone running to the same one.
    if (options.length > 1 && options[1].len <= options[0].len * 1.3 && this.rng.chance(0.3)) choice = options[1];
    return { stationId: choice.id, holdSentAt: -Infinity, nextEvalAt: now + 1500 };
  }

  private runFix(now: number, snap: Snapshot): boolean {
    const sab = snap.sabotage;
    const plan = this.fix;
    if (!sab || sab.kind === 'devDump' || !plan || plan.kind !== sab.kind) return false;
    if (!plan.going) {
      if (now < plan.nextRollAt) return false;
      plan.nextRollAt = now + this.rng.range(12000, 18000);
      plan.going = this.rng.chance(0.4);
      if (!plan.going) return false;
    }
    const stationView = sab.stations.find((s) => !s.fixed) ?? sab.stations[0];
    const station = stationView ? sabotageStationById(stationView.id) : undefined;
    if (!station) return false;
    this.leaveStation();
    if (this.inRange(station, USE_RANGE)) {
      this.nav.hold();
      if (plan.arrivedAt === null) {
        plan.arrivedAt = now;
        plan.doneAt = now + this.rng.range(2500, 5000); // "doing" the fix minigame
      }
      if (now >= plan.doneAt && now - plan.lastSentAt >= 1500) {
        if (plan.attempts >= 3) {
          plan.going = false;
          return false;
        }
        this.send({ t: 'fix', stationId: station.id, action: 'done' });
        plan.attempts++;
        plan.lastSentAt = now;
      }
      return true;
    }
    plan.arrivedAt = null;
    const status = this.nav.goTo(`fix:${station.id}`, station, 3, this.here, now);
    if (status === 'unreachable') {
      plan.going = false;
      return false;
    }
    return true;
  }

  private runTasks(now: number, me: MeView): boolean {
    const isUndone = (id: string) =>
      !this.mem.locallyDone.has(id) && me.tasks.some((t) => t.stationId === id && !t.done);
    let work = this.task;
    if (work && !isUndone(work.stationId)) {
      // Finished (or no longer ours). The server clears the open task on done; tidy up otherwise.
      if (me.activeStationId === work.stationId) this.closeTaskIfOpen();
      if (this.openTaskId === work.stationId) this.openTaskId = null;
      const finished = work.stage === 'submitted';
      this.task = work = null;
      // Look around for a moment before heading to the next one, like a person would.
      if (finished) this.taskPauseUntil = now + this.rng.range(400, 2000);
    }
    if (!work && now < this.taskPauseUntil && me.tasks.some((t) => isUndone(t.stationId))) {
      this.nav.hold();
      return true;
    }
    if (!work) {
      if (now < this.nextTaskPickAt) return false;
      work = this.task = this.pickTask(now, me);
      if (!work) {
        this.nextTaskPickAt = now + 2000;
        this.closeTaskIfOpen();
        return false;
      }
    }
    const station = stationById(work.stationId);
    if (!station) {
      this.task = null;
      return false;
    }
    switch (work.stage) {
      case 'walking': {
        const status = this.nav.goTo(`task:${station.id}`, station, 3, this.here, now);
        if (status === 'unreachable') {
          this.failGoal(station.id, now);
          this.task = null;
          return false;
        }
        if (status === 'arrived' && this.inRange(station, USE_RANGE)) {
          this.nav.hold();
          this.openTask(station.id);
          work.stage = 'open';
          work.openedAt = now;
          work.doneAt = now + TASK_MIN_MS[work.kind] + this.rng.between(TASK_EXTRA_MS);
          this.mem.alibi = { room: roomLabelAt(station), kind: work.kind };
        }
        return true;
      }
      case 'open': {
        this.nav.hold();
        if (me.activeStationId !== work.stationId && now - work.openedAt > TASK_OPEN_CONFIRM_MS) {
          // Interrupted (the server closed it): open it again, which restarts the server timer too.
          work.attempts++;
          if (work.attempts > 6) {
            this.failGoal(station.id, now);
            this.task = null;
            this.openTaskId = null;
            return false;
          }
          if (this.inRange(station, USE_RANGE)) {
            this.openTask(station.id);
            work.openedAt = now;
            work.doneAt = now + TASK_MIN_MS[work.kind] + this.rng.between(TASK_EXTRA_MS);
          } else {
            this.openTaskId = null;
            work.stage = 'walking';
          }
          return true;
        }
        if (now >= work.doneAt) {
          this.send({ t: 'taskDone', stationId: station.id });
          work.stage = 'submitted';
          work.submittedAt = now;
        }
        return true;
      }
      case 'submitted': {
        this.nav.hold();
        if (now - work.submittedAt > TASK_DONE_CONFIRM_MS) {
          // Not confirmed: the server refused it. Re-open and try again a few times.
          work.attempts++;
          this.openTaskId = me.activeStationId;
          if (work.attempts > 3) {
            this.closeTaskIfOpen();
            this.failGoal(station.id, now);
            this.task = null;
            return false;
          }
          work.stage = 'walking';
        }
        return true;
      }
    }
    return false;
  }

  private pickTask(now: number, me: MeView): TaskWork | null {
    const stations = me.tasks
      .filter((t) => !t.done && !this.mem.locallyDone.has(t.stationId) && !this.isFailed(t.stationId, now))
      .map((t) => stationById(t.stationId))
      .filter((st): st is NonNullable<typeof st> => st !== undefined);
    const nearest = nearestByPath(this.here, stations);
    if (!nearest) {
      // Nothing reachable right now: don't retry those stations every tick.
      for (const st of stations) this.failGoal(st.id, now);
      return null;
    }
    const st = nearest.item;
    return { stationId: st.id, kind: st.kind, stage: 'walking', openedAt: 0, doneAt: 0, submittedAt: 0, attempts: 0 };
  }

  private runWander(now: number): boolean {
    if (!this.wander) this.wander = { key: `wander:${this.wanderSeq++}`, target: this.randomFloorPoint(), pauseUntil: 0 };
    const w = this.wander;
    if (now < w.pauseUntil) {
      this.nav.hold();
      return true;
    }
    const status = this.nav.goTo(w.key, w.target, 8, this.here, now);
    if (status === 'arrived') {
      this.nav.hold();
      this.wander = {
        key: `wander:${this.wanderSeq++}`,
        target: this.randomFloorPoint(),
        pauseUntil: now + this.rng.range(1000, 4000),
      };
    } else if (status === 'unreachable') {
      this.wander = null;
    }
    return true;
  }

  private randomFloorPoint(): Vec {
    for (let i = 0; i < 24; i++) {
      const room = this.rng.pick(ROOMS);
      const tx = room.rect.x + this.rng.int(0, room.rect.w - 1);
      const ty = room.rect.y + this.rng.int(0, room.rect.h - 1);
      if (isSolidCell(tx, ty)) continue;
      const c = tileCenter(tx, ty);
      if (circleFree(c.x, c.y)) return c;
    }
    return { x: SPAWN_POINTS[0].x, y: SPAWN_POINTS[0].y };
  }

  // ---------- Rugger ----------

  private thinkRugger(now: number, snap: Snapshot, me: MeView): void {
    if (me.ventId) {
      this.runVent(now, snap, me);
      return;
    }
    if (this.ventPlan && (this.ventPlan.entered || (!this.escape && now - this.ventPlan.createdAt > 2000))) {
      this.ventPlan = null; // exited (or the entry never happened)
    }
    this.maybeSabotage(now, snap, me);
    if (me.alive) {
      if (this.runEscape(now, snap, me)) return;
      if (this.runHunt(now, snap, me)) return;
    }
    if (this.runFakeTasks(now, me)) return;
    this.runWander(now);
  }

  /** Living holders we can currently see (rug candidates). */
  private killTargets(snap: Snapshot, me: MeView): PlayerView[] {
    return this.mem.visible.filter((p) => p.id !== me.id && p.alive && !p.inVent && !this.isFellow(p.id, snap));
  }

  /** Living holders we see now, or saw moments ago, with their (last known) positions. */
  private knownHolders(now: number, snap: Snapshot, me: MeView): Map<string, Vec> {
    const out = new Map<string, Vec>();
    for (const p of this.mem.visible) if (p.id !== me.id && !this.isFellow(p.id, snap)) out.set(p.id, p);
    for (const [id, s] of this.mem.lastSeen) {
      if (out.has(id) || id === me.id || this.isFellow(id, snap)) continue;
      if (now - s.t > WITNESS_MEMORY_MS || !this.isAlive(id, snap)) continue;
      out.set(id, s);
    }
    return out;
  }

  /** True when no known living holder other than the target could see the target or us. */
  private isIsolated(target: PlayerView, witnesses: Map<string, Vec>, snap: Snapshot): boolean {
    const radius = holderVision(snap) + WITNESS_MARGIN;
    const self = this.serverPos;
    for (const [id, w] of witnesses) {
      if (id === target.id) continue;
      if (canSee(w, target, radius) || canSee(w, self, radius)) return false;
    }
    return true;
  }

  /** Could a holder we know about (seen now or moments ago) see `spot` or us? */
  private watchedAt(now: number, snap: Snapshot, me: MeView, spot: Vec): boolean {
    const radius = holderVision(snap) + WITNESS_MARGIN;
    const self = this.serverPos;
    for (const w of this.knownHolders(now, snap, me).values()) {
      if (canSee(w, spot, radius) || canSee(w, self, radius)) return true;
    }
    return false;
  }

  private runHunt(now: number, snap: Snapshot, me: MeView): boolean {
    const readyAt = me.killReadyAt;
    if (readyAt === undefined || now < readyAt) {
      this.hunt = null;
      this.stalk = null;
      return readyAt !== undefined && this.runPreHunt(now, snap, me, readyAt);
    }
    if (this.killAttempt) {
      if (now - this.killAttempt.at < KILL_CONFIRM_MS) {
        this.nav.hold();
        return true;
      }
      this.killAttempt = null; // refused (target moved, etc.); keep hunting
    }
    // Team pacing: a fellow rugger just rugged, or it isn't our turn yet this round.
    const holdUntil = Math.max(this.teamHoldUntil, this.roundGate ? this.huntAfter : 0);
    if (now < holdUntil) {
      this.hunt = null;
      this.stalk = null;
      return this.runPreHunt(now, snap, me, holdUntil);
    }
    this.roundGate = false;
    const targets = this.killTargets(snap, me);
    const witnesses = this.knownHolders(now, snap, me);

    // Opportunistic: an isolated holder already in reach.
    const reach = KILL_RANGE - KILL_MARGIN;
    const inReach = targets
      .filter((t) => dist(this.serverPos, t) <= reach)
      .sort((a, b) => dist(this.serverPos, a) - dist(this.serverPos, b));
    for (const t of inReach) {
      if (this.isIsolated(t, witnesses, snap)) {
        this.attemptKill(now, t, readyAt);
        return true;
      }
    }

    if (this.hunt) return this.continueHunt(now, snap, targets, witnesses);
    if (now < this.huntAfter) return false;

    // Prefer someone already alone; otherwise shadow the nearest holder and wait for an opening.
    const byDistance = targets.slice().sort((a, b) => dist(this.here, a) - dist(this.here, b));
    const pick = byDistance.find((t) => this.isIsolated(t, witnesses, snap)) ?? byDistance[0];
    if (pick) {
      this.stalk = null;
      this.hunt = { targetId: pick.id, startedAt: now, lastSeenAt: now, lastPos: { x: pick.x, y: pick.y }, exposedSince: null };
      return this.continueHunt(now, snap, targets, witnesses);
    }
    return this.runStalk(now, snap, me);
  }

  /** Rug almost ready and a lone holder close by: stay with them instead of wandering off. */
  private runPreHunt(now: number, snap: Snapshot, me: MeView, readyAt: number): boolean {
    if (readyAt - now > PRE_HUNT_MS) return false;
    const witnesses = this.knownHolders(now, snap, me);
    const target = this.killTargets(snap, me)
      .filter((t) => dist(this.here, t) <= PRE_HUNT_RANGE && this.isIsolated(t, witnesses, snap))
      .sort((a, b) => dist(this.here, a) - dist(this.here, b))[0];
    if (!target) return false;
    this.closeTaskIfOpen();
    const status = this.nav.goTo(`prehunt:${target.id}`, target, 30, this.here, now, 40);
    return status !== 'unreachable';
  }

  private continueHunt(now: number, snap: Snapshot, targets: PlayerView[], witnesses: Map<string, Vec>): boolean {
    const h = this.hunt;
    if (!h) return false;
    const t = targets.find((p) => p.id === h.targetId);
    if (t) {
      h.lastSeenAt = now;
      h.lastPos = { x: t.x, y: t.y };
    }
    const isolated = t ? this.isIsolated(t, witnesses, snap) : false;
    h.exposedSince = isolated ? null : (h.exposedSince ?? now);
    const lost = !t && now - h.lastSeenAt > 2500;
    const tooLong = now - h.startedAt > 14000;
    const exposed = h.exposedSince !== null && now - h.exposedSince > 6000;
    if (lost || tooLong || exposed || !this.isAlive(h.targetId, snap)) {
      this.abandonHunt(now);
      return false;
    }
    this.closeTaskIfOpen();
    // Close in when nobody is watching; otherwise shadow them at a casual distance.
    const status = this.nav.goTo(`hunt:${h.targetId}`, h.lastPos, isolated ? 20 : 90, this.here, now, 40);
    if (status === 'unreachable') {
      this.abandonHunt(now);
      return false;
    }
    return true;
  }

  private abandonHunt(now: number): void {
    this.hunt = null;
    this.huntAfter = now + this.rng.range(2500, 6000);
  }

  /** No one in sight: drift toward where a holder was last seen. */
  private runStalk(now: number, snap: Snapshot, me: MeView): boolean {
    if (!this.stalk) {
      let bestId: string | null = null;
      let best: SeenInfo | null = null;
      for (const [id, s] of this.mem.lastSeen) {
        if (id === me.id || this.isFellow(id, snap) || now - s.t > 20000) continue;
        if (this.mem.visible.some((p) => p.id === id)) continue;
        if (this.mem.stalked.get(id) === s.t || !this.isAlive(id, snap)) continue;
        if (!best || s.t > best.t) {
          best = s;
          bestId = id;
        }
      }
      if (!best || !bestId) return false;
      this.mem.stalked.set(bestId, best.t);
      this.stalk = { targetId: bestId, target: { x: best.x, y: best.y }, until: now + 8000 };
    }
    const s = this.stalk;
    const status = this.nav.goTo(`stalk:${s.targetId}`, s.target, 40, this.here, now);
    if (status !== 'moving' || now > s.until) {
      this.stalk = null;
      this.huntAfter = now + this.rng.range(2000, 5000);
      return false;
    }
    this.closeTaskIfOpen();
    return true;
  }

  private attemptKill(now: number, target: PlayerView, readyAt: number): void {
    this.nav.hold();
    if (now - this.lastKillAttemptAt < KILL_RETRY_MS) return;
    this.lastKillAttemptAt = now;
    this.closeTaskIfOpen();
    this.send({ t: 'kill', targetId: target.id });
    this.killAttempt = { targetId: target.id, at: now, prevReadyAt: readyAt };
  }

  private onKillConfirmed(now: number): void {
    this.killAttempt = null;
    this.hunt = null;
    this.stalk = null;
    if (this.escape || this.ventPlan) return;
    this.startEscape(now);
  }

  /** After a rug: slip into a nearby bridge, or walk off to a far station. */
  private startEscape(now: number): void {
    const from = { ...this.here };
    const me = this.snap?.me;
    let ventId: string | null = null;
    if (this.rng.chance(ESCAPE_VENT_CHANCE)) {
      const candidates = VENTS.filter((v) => dist(v, from) <= VENT_ESCAPE_MAX_PATH).sort((a, b) => dist(a, from) - dist(b, from));
      for (const v of candidates.slice(0, 2)) {
        if (pathLength(from, v) <= VENT_ESCAPE_MAX_PATH) {
          ventId = v.id;
          break;
        }
      }
    }
    if (ventId) {
      this.escape = { mode: 'vent', startedAt: now, from, ventId, target: null, stationId: null, enterAttempts: 0, lastEnterAt: -Infinity };
      return;
    }
    const dest = this.escapeDestination(from, me, this.rng.chance(ESCAPE_LINGER_CHANCE));
    this.escape = { mode: 'walk', startedAt: now, from, ventId: null, target: dest.target, stationId: dest.stationId, enterAttempts: 0, lastEnterAt: -Infinity };
  }

  /** A far station to fake a task at, or (`linger`) one just down the hall, playing it cool. */
  private escapeDestination(from: Vec, me: MeView | undefined, linger = false): { target: Vec; stationId: string | null } {
    const fakeIds = new Set((me?.tasks ?? []).map((t) => t.stationId));
    const near = TASK_STATIONS.filter((s) => dist(s, from) >= LINGER_PX[0] && dist(s, from) <= LINGER_PX[1]);
    const far = linger && near.length > 0 ? near : TASK_STATIONS.filter((s) => dist(s, from) >= 450);
    const preferred = far.filter((s) => fakeIds.has(s.id));
    const pool = preferred.length > 0 ? preferred : far.length > 0 ? far : TASK_STATIONS;
    const s = this.rng.pick(pool);
    return { target: { x: s.x, y: s.y }, stationId: fakeIds.has(s.id) ? s.id : null };
  }

  private runEscape(now: number, snap: Snapshot, me: MeView): boolean {
    const e = this.escape;
    if (!e) return false;
    if (now - e.startedAt > ESCAPE_TIMEOUT_MS) {
      this.escape = null;
      return false;
    }
    if (e.mode === 'vent' && e.ventId) {
      const vent = ventById(e.ventId);
      if (!vent) {
        this.switchEscapeToWalk(e, me);
        return true;
      }
      if (this.inRange(vent, VENT_RANGE)) {
        this.nav.hold();
        if (now - e.lastEnterAt >= 1000) {
          // Someone would see us vanish into the bridge: just walk off instead.
          if (e.enterAttempts >= 2 || this.watchedAt(now, snap, me, vent)) {
            this.switchEscapeToWalk(e, me);
            return true;
          }
          this.closeTaskIfOpen();
          this.send({ t: 'vent', action: 'enter', ventId: vent.id });
          this.awaitingSnapshot = true; // the server teleports us into the bridge
          e.enterAttempts++;
          e.lastEnterAt = now;
          this.ventPlan = {
            entered: false,
            createdAt: now,
            hopsLeft: this.rng.chance(0.3) ? 2 : 1,
            extraHops: 1,
            currentVent: null,
            nextAt: now + this.rng.range(600, 1400),
            waitStart: now,
            lastExitAt: -Infinity,
            from: e.from,
          };
        }
        return true;
      }
      const status = this.nav.goTo(`escape-vent:${vent.id}`, vent, 3, this.here, now);
      if (status === 'unreachable') this.switchEscapeToWalk(e, me);
      return true;
    }
    if (!e.target) {
      this.escape = null;
      return false;
    }
    const status = this.nav.goTo('escape-walk', e.target, 6, this.here, now);
    if (status !== 'moving') {
      this.escape = null;
      // Arrive at a fake station and immediately "do" it: instant alibi.
      if (e.stationId && snap.phase === 'playing') this.fake = { stationId: e.stationId, stage: 'walking', until: 0 };
      return false;
    }
    return true;
  }

  private switchEscapeToWalk(e: EscapePlan, me: MeView): void {
    const dest = this.escapeDestination(e.from, me);
    e.mode = 'walk';
    e.ventId = null;
    e.target = dest.target;
    e.stationId = dest.stationId;
    this.ventPlan = null;
  }

  /** Inside a bridge: hop to a linked one, then pop out once nobody is looking. */
  private runVent(now: number, snap: Snapshot, me: MeView): void {
    this.nav.reset();
    this.escape = null;
    const ventId = me.ventId;
    if (!ventId) return;
    let plan = this.ventPlan;
    if (!plan) {
      plan = this.ventPlan = {
        entered: true,
        createdAt: now,
        hopsLeft: 0,
        extraHops: 1,
        currentVent: ventId,
        nextAt: now + this.rng.range(600, 1400),
        waitStart: now,
        lastExitAt: -Infinity,
        from: { ...this.here },
      };
    }
    plan.entered = true;
    if (plan.currentVent !== ventId) {
      plan.currentVent = ventId;
      plan.nextAt = now + this.rng.range(500, 1300);
      plan.waitStart = now;
    }
    if (now < plan.nextAt) return;
    const vent = ventById(ventId);
    if (plan.hopsLeft > 0 && vent && vent.links.length > 0) {
      const links = vent.links.map((id) => ventById(id)).filter((v): v is NonNullable<typeof v> => v !== undefined);
      // Prefer the bridge farther from the rug, but not always.
      links.sort((a, b) => dist(b, plan.from) - dist(a, plan.from));
      const next = links.length > 1 && this.rng.chance(0.3) ? links[1] : links[0];
      if (next) {
        this.send({ t: 'vent', action: 'move', ventId: next.id });
        this.awaitingSnapshot = true;
        plan.hopsLeft--;
        plan.nextAt = now + 1200; // fallback if the move doesn't land
        return;
      }
    }
    // Exit when no living holder could see us pop out (or we've waited long enough).
    const spot = vent ?? this.here;
    if (!this.watchedAt(now, snap, me, spot) || now - plan.waitStart > 6000) {
      if (now - plan.lastExitAt >= 800) {
        this.send({ t: 'vent', action: 'exit' });
        plan.lastExitAt = now;
      }
      return;
    }
    if (plan.extraHops > 0 && now - plan.waitStart > 2500) {
      plan.extraHops--;
      plan.hopsLeft = 1;
    }
    plan.nextAt = now + 400;
  }

  private maybeSabotage(now: number, snap: Snapshot, me: MeView): void {
    if (snap.sabotage || me.ventId) return;
    const readyAt = me.sabotageReadyAt;
    if (readyAt === undefined || now < readyAt || now < this.nextSabotageRollAt) return;
    this.nextSabotageRollAt = now + SABOTAGE_ROLL_MS;
    if (now - this.lastSabotageAt < 5000) return;
    // Roughly one sabotage per ~20 s of ready time. With the rug ready, FUD (holders' vision shrinks
    // to a sliver) is the classic setup, so it gets more likely then.
    const rugReady = me.alive && me.killReadyAt !== undefined && now >= me.killReadyAt - 2000;
    if (!this.rng.chance(rugReady ? 0.12 : 0.05)) return;
    const r = this.rng.next();
    const kind: SabotageKind = rugReady
      ? r < 0.05 ? 'devDump' : r < 0.8 ? 'fud' : 'rpcDown'
      : r < 0.1 ? 'devDump' : r < 0.55 ? 'fud' : 'rpcDown';
    this.send({ t: 'sabotage', kind });
    this.lastSabotageAt = now;
  }

  private runFakeTasks(now: number, me: MeView): boolean {
    let work = this.fake;
    if (!work) {
      if (now < this.nextTaskPickAt) return false;
      const id = this.pickFakeStation(now, me);
      if (!id) {
        this.nextTaskPickAt = now + 2000;
        return false;
      }
      work = this.fake = { stationId: id, stage: 'walking', until: 0 };
    }
    const station = stationById(work.stationId);
    if (!station) {
      this.fake = null;
      return false;
    }
    switch (work.stage) {
      case 'walking': {
        const status = this.nav.goTo(`fake:${station.id}`, station, 3, this.here, now);
        if (status === 'unreachable') {
          this.failGoal(station.id, now);
          this.fake = null;
          return false;
        }
        if (status === 'arrived' && this.inRange(station, USE_RANGE)) {
          this.nav.hold();
          if (me.tasks.some((t) => t.stationId === station.id)) this.openTask(station.id);
          work.stage = 'faking';
          work.until = now + TASK_MIN_MS[station.kind] + this.rng.range(1000, 3500);
          this.mem.alibi = { room: roomLabelAt(station), kind: station.kind };
        }
        return true;
      }
      case 'faking': {
        this.nav.hold();
        if (now >= work.until) {
          this.closeTaskIfOpen();
          this.lastFakeId = station.id;
          this.fake = { stationId: station.id, stage: 'idle', until: now + this.rng.range(300, 1800) };
        }
        return true;
      }
      case 'idle': {
        this.nav.hold();
        if (now >= work.until) this.fake = null;
        return true;
      }
    }
    return false;
  }

  private pickFakeStation(now: number, me: MeView): string | null {
    const own = me.tasks.map((t) => t.stationId).filter((id) => stationById(id) !== undefined);
    const pool = own.length > 0 ? own : TASK_STATIONS.map((s) => s.id);
    const options = pool.filter((id) => id !== this.lastFakeId && !this.isFailed(id, now));
    const list = options.length > 0 ? options : pool.filter((id) => !this.isFailed(id, now));
    return list.length > 0 ? this.rng.pick(list) : null;
  }

  // ---------- Meetings ----------

  private beginMeeting(now: number, snap: Snapshot, me: MeView): void {
    this.mem.meetingSeq++;
    this.chatQueue = [];
    const seenBefore = new Map<string, SeenInfo>();
    for (const [id, s] of this.mem.lastSeen) seenBefore.set(id, { ...s });
    const bodyRoom = this.reportedBodyRoom(snap, me);
    this.meeting = {
      startedAt: now,
      votingSeenAt: null,
      voteAt: null,
      voteAttempts: 0,
      lastVoteSentAt: -Infinity,
      linesLeft: MAX_MEETING_LINES,
      reacted: false,
      defended: false,
      threshold: this.rng.between(VOTE_THRESHOLD),
      liars: new Set(),
      accusations: new Map(),
      claims: [],
      contested: new Set(),
      vouches: new Map(),
      vouched: new Set(),
      voiced: new Set(),
      announced: new Map(),
      announceAt: null,
      committed: null,
      bodyRoom: bodyRoom ? bodyRoom.toLowerCase() : null,
      bodyRoomHeard: false,
      heard: new Set(),
      seenBefore,
    };
    if (!snap.meeting) return;
    if (me.alive && me.role === 'holder' && this.mustVote(snap)) this.meeting.announceAt = now + this.rng.between(ANNOUNCE_DELAY_MS);
    if (me.alive) {
      const lines = this.composeMeetingLines(snap, me);
      let at = now + this.rng.range(1500, 4500);
      for (const text of lines) {
        this.queueLine(text, at, 'meeting');
        at += this.rng.range(2500, 6500);
      }
      this.meeting.linesLeft -= lines.length;
    } else if (this.rng.chance(0.15)) {
      this.queueLine(this.ghostLine(me), now + this.rng.range(3000, 12000), 'ghost');
    }
    const pending = this.pendingMeetingChat.splice(0);
    for (const msg of pending) {
      if (now - msg.ts <= PENDING_CHAT_MAX_AGE_MS) this.processMeetingChat(msg, this.meeting, snap, me);
    }
  }

  private thinkMeeting(now: number, snap: Snapshot, me: MeView): void {
    const m = snap.meeting;
    const st = this.meeting;
    if (!m || !st) return;
    if (m.stage === 'voting' && st.votingSeenAt === null) this.markVotingOpened(now, snap);
    if (st.announceAt !== null && now >= st.announceAt) this.announceVote(now, snap, me, st);
    if (m.stage !== 'voting' || !me.alive || m.myVote !== undefined || st.voteAt === null) return;
    if (now < st.voteAt || st.voteAttempts >= 3 || now - st.lastVoteSentAt < 2000) return;
    const target = this.decideVote(snap, me);
    this.send({ t: 'vote', target });
    st.voteAttempts++;
    st.lastVoteSentAt = now;
  }

  /** A must-win meeting: say who we are voting for, so the holders don't split their votes. */
  private announceVote(now: number, snap: Snapshot, me: MeView, st: MeetingState): void {
    st.announceAt = null;
    // A witness already called it out by name.
    if (!me.alive || me.role !== 'holder' || !this.mustVote(snap) || this.witnessedSuspect(snap, me)) return;
    const target = this.holderVote(snap, me);
    const name = target === 'skip' ? undefined : this.names.get(target);
    if (!name) return;
    st.committed = target;
    this.queueLine(fill(this.rng.pick(ANNOUNCE_LINES), { name }) ?? `voting ${name}`, now + this.rng.range(0, 800), 'meeting');
  }

  private markVotingOpened(now: number, snap: Snapshot | null): void {
    const st = this.meeting;
    if (!st || st.votingSeenAt !== null) return;
    st.votingSeenAt = now;
    // Someone who watched the rug votes right away; everyone else takes their time.
    const me = snap?.me;
    const sure = !!snap && !!me && me.role === 'holder' && this.witnessedSuspect(snap, me) !== null;
    let at = now + this.rng.between(sure ? VOTE_DELAY_SURE_MS : VOTE_DELAY_MS);
    const endsAt = snap?.meeting?.stage === 'voting' ? snap.phaseEndsAt : undefined;
    if (endsAt !== undefined && Number.isFinite(endsAt)) at = Math.min(at, endsAt - 1500);
    const votingMs = finiteOr(snap?.room.settings.votingTime, 0) * 1000;
    if (votingMs > 0) at = Math.min(at, now + votingMs - 1500);
    st.voteAt = Math.max(at, now + 500);
  }

  /**
   * Holder: someone it saw rug or bridge > someone who lied about it > the top suspect, when that
   * suspect clears this bot's threshold and leads clearly > skip. Rugger: never a fellow.
   */
  private decideVote(snap: Snapshot, me: MeView): string {
    const living = snap.players.filter((p) => p.alive && p.id !== me.id);
    const st = this.meeting;
    if (me.role === 'holder') return this.holderVote(snap, me);
    const candidates = living.filter((p) => !this.isFellow(p.id, snap) && !p.isRugger);
    const allowed = new Set(candidates.map((p) => p.id));
    let choice = this.topAccused(allowed, 2) ?? this.topAccused(allowed, 1, true);
    if (!choice) {
      const weak = this.topAccused(allowed, 1);
      const teamUnderFire = [...(st?.accusations.entries() ?? [])].some(
        ([id, a]) => a.accusers.size > 0 && (id === me.id || this.isFellow(id, snap)),
      );
      if (weak && (teamUnderFire || this.rng.chance(0.35))) choice = weak;
    }
    if (!choice || !allowed.has(choice)) return 'skip';
    return choice;
  }

  private holderVote(snap: Snapshot, me: MeView): string {
    const st = this.meeting;
    const allowed = new Set(snap.players.filter((p) => p.alive && p.id !== me.id).map((p) => p.id));
    const witnessed = this.witnessedSuspect(snap, me);
    if (witnessed && allowed.has(witnessed.id)) return witnessed.id;
    const liar = [...(st?.liars ?? [])].find((id) => allowed.has(id));
    if (liar) return liar;
    if (!st) return 'skip';
    if (st.committed && allowed.has(st.committed)) return st.committed;
    // Never vote someone we just spoke up for.
    for (const id of st.vouched) allowed.delete(id);
    const ranked = [...this.suspicion(snap, me)].filter(([id]) => allowed.has(id)).sort((a, b) => b[1] - a[1]);
    const [top, second] = ranked;
    // With the game on the line, a decent hunch beats skipping into a loss.
    const left = this.killsToLose(snap);
    const mult = left <= 1 ? CRITICAL_THRESHOLD_MULT : left <= 2 ? CLOSE_THRESHOLD_MULT : 1;
    if (top && top[1] >= st.threshold * mult && top[1] - (second?.[1] ?? 0) >= VOTE_MARGIN * mult) return top[0];
    if (!this.mustVote(snap)) return 'skip';
    // Skipping now loses: go with the table (whoever others are voting), then our best guess.
    const called = new Map<string, number>();
    for (const [from, target] of st.announced) {
      if (target !== me.id && allowed.has(target) && !st.liars.has(from)) called.set(target, (called.get(target) ?? 0) + 1);
    }
    const score = new Map(ranked);
    const bandwagon = [...called].sort((a, b) => b[1] - a[1] || (score.get(b[0]) ?? 0) - (score.get(a[0]) ?? 0))[0];
    if (bandwagon) return bandwagon[0];
    if (top && top[1] > 0) return top[0];
    // No lead at all: whoever we kept the least eye on.
    const alibis = this.alibis(snap, me);
    const pool = [...allowed].filter((id) => !(st.vouches.get(id)?.size ?? 0));
    const options = pool.length > 0 ? pool : [...allowed];
    if (options.length === 0) return 'skip';
    const least = Math.min(...options.map((id) => alibis.get(id)?.coverage ?? 0));
    return this.rng.pick(options.filter((id) => (alibis.get(id)?.coverage ?? 0) <= least + 0.05));
  }

  /** One more rug loses and the curve won't finish first: skipping is not an option. */
  private mustVote(snap: Snapshot): boolean {
    const progress = snap.taskProgress;
    return this.killsToLose(snap) <= 1 && (progress < 0 || progress < MUST_VOTE_PROGRESS);
  }

  /**
   * How suspicious each player looks to this holder: its own evidence, plus every accuser's best
   * claim weighed by how believable it is (see the Meeting reasoning constants).
   */
  private suspicion(snap: Snapshot, me: MeView): Map<string, number> {
    const st = this.meeting;
    const out = new Map<string, number>();
    if (!st) return out;
    const m = snap.meeting;
    const report = m?.reason === 'report';
    const own = this.ownEvidence(snap, me);
    // Someone whose eyewitness claim can't fit the reported body is lying.
    const liars = new Set(st.liars);
    for (const c of st.claims) {
      if (c.kind === 'saw' && c.rug && c.room && report && st.bodyRoom && c.room !== st.bodyRoom) liars.add(c.from);
    }
    // Each accuser's best claim per target (saying it twice adds nothing).
    const best = new Map<string, { claim: Claim; w: number }>();
    for (const c of st.claims) {
      if (c.target === c.from || c.target === me.id || liars.has(c.from)) continue;
      const w = this.claimWeight(c, snap, st);
      const key = `${c.from}\n${c.target}`;
      const prev = best.get(key);
      if (!prev || w > prev.w) best.set(key, { claim: c, w });
    }
    // An accuser who is under suspicion is less believable. Hitting back at your own accuser is
    // not evidence, so those counter-claims don't count against them.
    const accusedBy = new Map<string, Set<string>>();
    for (const { claim } of best.values()) {
      const set = accusedBy.get(claim.from) ?? new Set<string>();
      set.add(claim.target);
      accusedBy.set(claim.from, set);
    }
    const against = new Map(own);
    for (const { claim, w } of best.values()) {
      if (accusedBy.get(claim.target)?.has(claim.from)) continue;
      against.set(claim.target, (against.get(claim.target) ?? 0) + w);
    }
    const credibility = (id: string) => 1 / (1 + (against.get(id) ?? 0) / CREDIBILITY_SCALE);
    const byTarget = new Map<string, { kind: ClaimKind; w: number }[]>();
    for (const { claim, w } of best.values()) {
      const list = byTarget.get(claim.target) ?? [];
      list.push({ kind: claim.kind, w: w * credibility(claim.from) });
      byTarget.set(claim.target, list);
    }
    for (const id of new Set([...own.keys(), ...byTarget.keys()])) {
      const ownW = own.get(id) ?? 0;
      const list = byTarget.get(id) ?? [];
      let claimed = list.reduce((a, c) => a + c.w, 0);
      const sources = list.filter((c) => c.kind !== 'echo').length + (ownW >= OWN_SOURCE_MIN ? 1 : 0);
      if (sources >= 2) claimed *= CORROBORATED_MULT;
      else if (st.contested.has(id)) claimed *= CONTESTED_MULT;
      const vouchers = (st.vouches.get(id)?.size ?? 0) + (st.vouched.has(id) ? 1 : 0);
      if (vouchers > 0) claimed *= VOUCH_MULT ** Math.min(2, vouchers);
      out.set(id, ownW + claimed);
    }
    for (const id of liars) out.set(id, (out.get(id) ?? 0) + LIAR_WEIGHT);
    return out;
  }

  /** How many more rugs give the ruggers parity, as far as a holder can tell. */
  private killsToLose(snap: Snapshot): number {
    let living = 0;
    for (const id of this.mem.roster) if (this.isAlive(id, snap)) living++;
    const ruggers = this.mem.ruggersLeft ?? Math.min(Math.max(1, finiteOr(snap.room.settings.ruggers, 1)), maxRuggersFor(this.mem.roster.size));
    return living - 2 * ruggers;
  }

  /** What one claim is worth before the accuser's credibility. */
  private claimWeight(c: Claim, snap: Snapshot, st: MeetingState): number {
    let w = CLAIM_WEIGHT[c.kind];
    const m = snap.meeting;
    const report = m?.reason === 'report';
    if (report && st.bodyRoom && c.room) {
      if (c.kind === 'saw' && c.rug && c.room === st.bodyRoom) w *= ROOM_MATCH_MULT;
      if ((c.kind === 'near' || c.kind === 'evidence') && c.room !== st.bodyRoom) w *= ROOM_MISMATCH_MULT;
    }
    if (c.kind === 'saw' && c.rug && c.room) {
      // We saw them somewhere else entirely right before the meeting.
      const seen = st.seenBefore.get(c.target);
      if (seen && st.startedAt - seen.t <= ELSEWHERE_WINDOW_MS && distanceToRoom(seen, c.room) >= ELSEWHERE_MIN_PX) w *= ELSEWHERE_MULT;
    }
    if (report && m && c.target === m.callerId) {
      if (c.kind === 'near' || c.kind === 'evidence') w *= REPORTER_EVIDENCE_MULT;
      else if (c.kind === 'saw') w *= REPORTER_SAW_MULT;
    }
    return w;
  }

  /** Suspicion from what this bot saw itself (besides a witnessed rug, which decides outright). */
  private ownEvidence(snap: Snapshot, me: MeView): Map<string, number> {
    const out = new Map<string, number>();
    const add = (id: string, w: number) => out.set(id, (out.get(id) ?? 0) + w);
    for (const s of this.nearBodySuspects(snap, me)) add(s.id, s.weight);
    for (const s of this.seenWithSuspects(snap, me)) add(s.id, s.weight);
    for (const [id, a] of this.alibis(snap, me)) if (a.weight > 0) add(id, a.weight);
    return out;
  }

  /**
   * For a report meeting: how much of the stretch between the victim's last sighting and the body
   * each living player spent in our sight (coverage), and the elimination weight that leaves them.
   */
  private alibis(snap: Snapshot, me: MeView): Map<string, { coverage: number; weight: number }> {
    const out = new Map<string, { coverage: number; weight: number }>();
    const m = snap.meeting;
    const st = this.meeting;
    if (!m || !st || m.reason !== 'report' || m.bodyColor === undefined) return out;
    const victim = snap.players.find((p) => p.color === m.bodyColor && !p.alive);
    if (!victim) return out;
    const found = this.mem.seenBodies.get(victim.id)?.t ?? st.startedAt;
    const lastAlive = this.mem.sightings.get(victim.id)?.at(-1)?.t ?? -Infinity;
    const from = Math.max(lastAlive, found - ALIBI_SPAN_MAX_MS);
    const span = found - from;
    if (span < ALIBI_SPAN_MIN_MS) return out;
    const ids = snap.players.filter((p) => p.alive && p.id !== me.id && !this.isFellow(p.id, snap)).map((p) => p.id);
    const coverage = ids.map((id) => {
      const seen = (this.mem.sightings.get(id) ?? []).filter((s) => s.t >= from && s.t <= found).length;
      return clamp((seen * SIGHTING_SAMPLE_MS) / span, 0, 1);
    });
    const unseen = coverage.map((c) => 1 - c);
    const total = unseen.reduce((a, b) => a + b, 0);
    const n = ids.length;
    ids.forEach((id, i) => {
      const excess = n > 1 && total > 0 ? ((unseen[i] / total - 1 / n) * n) / (n - 1) : 0;
      out.set(id, { coverage: coverage[i], weight: ALIBI_WEIGHT * Math.max(0, excess) });
    });
    return out;
  }

  /**
   * The crowd's favorite (ruggers pile on): the most-accused allowed player with at least
   * `minAccusers` distinct people accusing or agreeing (eyewitnesses only when `eyewitnessOnly`);
   * null on a tie.
   */
  private topAccused(allowed: Set<string>, minAccusers: number, eyewitnessOnly = false): string | null {
    const st = this.meeting;
    if (!st) return null;
    let best: string | null = null;
    let bestKey = -1;
    let tie = false;
    for (const [id, acc] of st.accusations) {
      const crowd = new Set([...acc.accusers, ...acc.echoes]).size;
      const count = eyewitnessOnly ? acc.eyewitnesses.size : crowd;
      if (!allowed.has(id) || count < minAccusers) continue;
      const key = crowd * 1000 + acc.score;
      if (key > bestKey) {
        best = id;
        bestKey = key;
        tie = false;
      } else if (key === bestKey) {
        tie = true;
      }
    }
    return tie ? null : best;
  }

  private witnessedSuspect(snap: Snapshot, me: MeView): { id: string; name: string; room: string; kind: WitnessInfo['kind'] } | null {
    const entries = [...this.mem.witnessed.entries()].sort((a, b) => b[1].t - a[1].t);
    for (const [id, info] of entries) {
      if (id === me.id || !this.isAlive(id, snap)) continue;
      const name = this.names.get(id);
      if (name) return { id, name, room: info.room, kind: info.kind };
    }
    return null;
  }

  /** Players seen by a body since the last meeting, the reported body's first, newest first. */
  private nearBodySuspects(
    snap: Snapshot,
    me: MeView,
  ): { id: string; name: string; room: string; kind: NearBodyInfo['kind']; weight: number; reporter: boolean }[] {
    const m = snap.meeting;
    const out: { id: string; name: string; room: string; kind: NearBodyInfo['kind']; weight: number; reporter: boolean; t: number; reported: boolean }[] = [];
    for (const [id, info] of this.mem.nearBody) {
      if (info.meetingSeq !== this.mem.meetingSeq - 1) continue;
      if (id === me.id || this.isFellow(id, snap) || !this.isAlive(id, snap)) continue;
      const name = this.names.get(id);
      if (!name) continue;
      let weight =
        info.kind === 'near'
          ? OWN_NEAR_BODY_WEIGHT / Math.max(1, info.group)
          : info.age <= AROUND_RECENT_MS
            ? OWN_AROUND_RECENT_WEIGHT
            : OWN_AROUND_WEIGHT;
      // Whoever reported it was bound to be standing there.
      if (m?.reason === 'report' && id === m.callerId) weight *= REPORTER_EVIDENCE_MULT;
      out.push({ id, name, room: info.room, kind: info.kind, weight, reporter: m?.reason === 'report' && id === m.callerId, t: info.t, reported: info.bodyColor === m?.bodyColor });
    }
    return out.sort((a, b) => Number(b.reported) - Number(a.reported) || b.weight - a.weight || b.t - a.t);
  }

  /** The reported victim was last seen (by this bot, recently) with one or two of these players. */
  private seenWithSuspects(snap: Snapshot, me: MeView): { id: string; name: string; victim: string; room: string; weight: number }[] {
    const m = snap.meeting;
    const st = this.meeting;
    if (!m || !st || m.reason !== 'report' || m.bodyColor === undefined) return [];
    const victim = snap.players.find((p) => p.color === m.bodyColor && !p.alive);
    const victimName = victim ? this.names.get(victim.id) : undefined;
    const info = victim ? this.mem.seenWith.get(victim.id) : undefined;
    if (!victim || !victimName || !info) return [];
    // How long before the body turned up (when we found it ourselves, or the meeting) we last saw them.
    const foundAt = this.mem.seenBodies.get(victim.id)?.t ?? st.startedAt;
    const age = foundAt - info.t;
    if (age > SEEN_WITH_MAX_AGE_MS) return [];
    const ids = info.others.filter((id) => id !== me.id && !this.isFellow(id, snap) && this.isAlive(id, snap));
    if (ids.length === 0 || ids.length > 2) return [];
    const weight = (age <= SEEN_WITH_RECENT_MS ? OWN_SEEN_WITH_WEIGHT : OWN_SEEN_WITH_OLD_WEIGHT) / ids.length;
    const out: { id: string; name: string; victim: string; room: string; weight: number }[] = [];
    for (const id of ids) {
      const name = this.names.get(id);
      if (name) out.push({ id, name, victim: victimName, room: info.room, weight });
    }
    return out;
  }

  private composeMeetingLines(snap: Snapshot, me: MeView): string[] {
    const m = snap.meeting;
    if (!m) return [];
    const lines: string[] = [];
    const add = (s: string | null, about?: string) => {
      if (!s || lines.includes(s)) return;
      lines.push(s);
      if (about) this.meeting?.voiced.add(about);
    };
    const holder = me.role === 'holder';
    if (holder) {
      const w = this.witnessedSuspect(snap, me);
      if (w) {
        add(fill(w.kind === 'vent' ? VENT_WITNESS_LINE : WITNESS_LINE, { name: w.name, room: w.room }), w.id);
        if (this.rng.chance(0.5)) add(fill(this.rng.pick(WITNESS_FOLLOWUPS), { name: w.name }));
        return lines.slice(0, MAX_MEETING_LINES);
      }
      if (m.callerId === me.id && m.reason === 'report') add(fill(this.rng.pick(REPORTER_LINES), { room: this.mem.reportedRoom }));
    }
    // Holders share their best lead (who was by the body, or last seen with the victim); ruggers
    // do it too, to frame a holder. A hunch too weak to stand on stays private.
    const lead = this.evidenceLine(snap, me, null, holder ? VOICE_MIN_WEIGHT : 0);
    if (lead && this.rng.chance(holder ? 0.8 : 0.4)) add(lead.line, lead.id);
    const r = this.rng.next();
    const want = Math.max(lines.length, r < 0.25 ? 0 : r < 0.7 ? 1 : 2);
    for (let guard = 0; lines.length < want && guard < 12; guard++) add(this.fillerLine(snap, me));
    return lines.slice(0, MAX_MEETING_LINES);
  }

  private fillerLine(snap: Snapshot, me: MeView): string | null {
    const m = snap.meeting;
    const options: (string | null)[] = [...GENERIC_LINES];
    const bodyRoom = this.reportedBodyRoom(snap, me);
    if (m?.callerId !== me.id) {
      // Only ask where the body was when we don't know already.
      if (m?.reason === 'report') {
        if (!bodyRoom) options.push(...REPORT_MEETING_LINES);
      } else {
        options.push(...EMERGENCY_MEETING_LINES);
      }
    }
    const alibi = this.mem.alibi;
    // Room lines are the most "human" ones, so weigh them up.
    if (alibi) {
      const line = fill(this.rng.pick(ALIBI_TASK_LINES), { room: alibi.room, task: TASK_SHORT[alibi.kind] });
      options.push(line, line, line);
    } else if (this.mem.lastRoom) {
      const line = fill(this.rng.pick(ALIBI_ROOM_LINES), { room: this.mem.lastRoom });
      options.push(line, line);
    }
    if (bodyRoom) {
      const line = fill(this.rng.pick(BODY_ROOM_LINES), { room: bodyRoom });
      options.push(line, line);
    }
    const valid = options.filter((s): s is string => s !== null);
    return valid.length > 0 ? this.rng.pick(valid) : null;
  }

  /** The room of the reported body, if the bot saw that body itself. */
  private reportedBodyRoom(snap: Snapshot, me: MeView): string | null {
    const m = snap.meeting;
    if (!m || m.reason !== 'report') return null;
    if (m.callerId === me.id && this.mem.reportedRoom) return this.mem.reportedRoom;
    if (m.bodyColor === undefined) return null;
    for (const b of this.mem.seenBodies.values()) if (b.color === m.bodyColor) return b.room;
    return null;
  }

  // ---------- Chat ----------

  private handleChat(msg: ChatMessage): void {
    if (msg.fromId === this.id) return;
    if (msg.channel !== 'meeting' || !msg.fromId) return;
    const st = this.meeting;
    const snap = this.snap;
    const me = snap?.me;
    if (!st || !snap || !me || snap.phase !== 'meeting') {
      // The room delivers chat before the snapshot: this line belongs to a meeting we haven't seen yet.
      this.pendingMeetingChat.push(msg);
      if (this.pendingMeetingChat.length > 50) this.pendingMeetingChat.shift();
      return;
    }
    this.processMeetingChat(msg, st, snap, me);
  }

  private processMeetingChat(msg: ChatMessage, st: MeetingState, snap: Snapshot, me: MeView): void {
    const fromId = msg.fromId;
    if (!fromId) return;
    const text = msg.text.toLowerCase().trim();
    st.heard.add(text);
    const m = snap.meeting;
    const bodyLine = BODY_ROOM_RE.exec(text);
    if (bodyLine) {
      st.bodyRoomHeard = true;
      const room = roomInText(bodyLine[1]);
      if (room && !st.bodyRoom && m?.reason === 'report' && fromId === m.callerId) st.bodyRoom = room;
    }
    if (DENIAL_RE.test(text)) st.contested.add(fromId);
    const { ids, bare } = this.parseMentions(text, fromId, snap);
    if (ids.length === 0) return;
    if (DEFENSE_RE.test(text)) {
      // "X was with me", "X wasn't there": vouching for X.
      for (const id of ids) {
        const set = st.vouches.get(id) ?? new Set<string>();
        set.add(fromId);
        st.vouches.set(id, set);
      }
      return;
    }
    if (!bare && !ACCUSE_RE.test(text)) return;
    const crime = CRIME_RE.test(text);
    const eyewitness = SAW_RE.test(text) && crime;
    // "X vented" without an "I saw it" still claims more than "X sus".
    const evidence = !eyewitness && (crime || EVIDENCE_RE.test(text));
    const nearBody = evidence && NEAR_BODY_RE.test(text);
    const rug = eyewitness && RUG_CRIME_RE.test(text);
    const room = roomInText(text);
    for (const id of ids) {
      const acc = st.accusations.get(id) ?? { score: 0, accusers: new Set<string>(), eyewitnesses: new Set<string>(), echoes: new Set<string>() };
      // Repeating an accusation someone else already made is agreeing, not a new source.
      const echo = !eyewitness && !evidence && [...acc.accusers].some((a) => a !== fromId);
      const kind: ClaimKind = eyewitness ? 'saw' : nearBody ? 'near' : evidence ? 'evidence' : echo ? 'echo' : 'accuse';
      st.claims.push({ from: fromId, target: id, kind, rug, room });
      if (echo) {
        acc.echoes.add(fromId);
      } else {
        acc.score += eyewitness ? 2 : 1;
        acc.accusers.add(fromId);
      }
      if (eyewitness) acc.eyewitnesses.add(fromId);
      st.accusations.set(id, acc);
    }
    if (ids.length === 1 && VOTE_RE.test(text)) st.announced.set(fromId, ids[0]);
    // A holder knows it is innocent: whoever "saw" it rug is lying.
    if (eyewitness && me.role === 'holder' && ids.includes(me.id)) st.liars.add(fromId);
    this.reactToAccusation(ids, fromId, snap, me, st, eyewitness, rug ? room : null);
  }

  private reactToAccusation(
    ids: string[],
    accuserId: string,
    snap: Snapshot,
    me: MeView,
    st: MeetingState,
    eyewitness: boolean,
    claimedRoom: string | null,
  ): void {
    if (!me.alive) return;
    const now = this.now;
    const say = (line: string | null, delay: [number, number]) => {
      if (!line) return false;
      this.queueLine(line, now + this.rng.between(delay), 'meeting');
      st.linesLeft--;
      return true;
    };
    if (ids.includes(me.id)) {
      if (st.defended) return;
      st.defended = true;
      // Nobody stays quiet when someone swears they saw them do it.
      if (!this.rng.chance(eyewitness ? 0.9 : 0.75)) return;
      const room = this.mem.alibi?.room ?? this.mem.lastRoom;
      const accuser = this.names.get(accuserId);
      let line: string | null;
      if (eyewitness && accuser && this.rng.chance(0.5)) line = fill(this.rng.pick(COUNTER_LINES), { name: accuser });
      else if (room && this.rng.chance(0.5)) line = fill(this.rng.pick(DEFENSE_ROOM_LINES), { room });
      else line = this.rng.pick(DEFENSE_LINES);
      say(line, [1200, 3500]);
      return;
    }
    // Defending yourself always gets a line; anything else needs one left.
    if (st.linesLeft <= 0) return;
    // Speak up for someone we saw far from where they supposedly rugged.
    for (const id of ids) {
      if (id === accuserId || st.vouched.has(id) || !this.isAlive(id, snap)) continue;
      const line = this.vouchLine(id, snap, me, st, claimedRoom);
      if (line) {
        st.vouched.add(id);
        say(line, [1500, 4000]);
        return;
      }
    }
    for (const id of ids) {
      if (id === accuserId || this.isFellow(id, snap) || !this.isAlive(id, snap)) continue;
      const name = this.names.get(id);
      if (!name) continue;
      // A holder backs the accusation up with what it saw itself, if it hasn't said so yet.
      if (me.role === 'holder' && !st.voiced.has(id)) {
        const lead = this.evidenceLine(snap, me, id, OWN_AROUND_WEIGHT, true);
        if (lead) {
          st.voiced.add(id);
          say(lead.line, [1500, 4000]);
          return;
        }
      }
      const acc = st.accusations.get(id);
      if (st.reacted || !acc || (acc.accusers.size + acc.echoes.size < 2 && acc.eyewitnesses.size === 0)) continue;
      st.reacted = true;
      // A holder only agrees when it actually believes it; a rugger is happy to pile on.
      if (me.role === 'holder' && (this.suspicion(snap, me).get(id) ?? 0) < st.threshold) return;
      if (this.rng.chance(0.35)) say(fill(this.rng.pick(ECHO_LINES), { name }), [1500, 4000]);
      return;
    }
  }

  /**
   * "X was with me in the Y": we kept seeing the accused while the rug must have happened, or saw
   * them far from the claimed room right before the meeting.
   */
  private vouchLine(id: string, snap: Snapshot, me: MeView, st: MeetingState, claimedRoom: string | null): string | null {
    const name = this.names.get(id);
    if (!name) return null;
    if (me.role === 'rugger') {
      // Cover a fellow rugger now and then.
      const room = this.mem.alibi?.room ?? this.mem.lastRoom;
      if (!this.isFellow(id, snap) || !room || !this.rng.chance(0.3)) return null;
      return fill(VOUCH_LINES[0], { name, room });
    }
    const alibi = this.alibis(snap, me).get(id);
    const last = this.mem.sightings.get(id)?.at(-1);
    if (alibi && last && alibi.coverage >= ALIBI_VOUCH_COVERAGE) {
      return this.rng.chance(VOUCH_CHANCE) ? fill(this.rng.pick(VOUCH_LINES), { name, room: roomLabelAt(last) }) : null;
    }
    if (!claimedRoom) return null;
    const seen = st.seenBefore.get(id);
    if (!seen || st.startedAt - seen.t > ELSEWHERE_WINDOW_MS || distanceToRoom(seen, claimedRoom) < ELSEWHERE_MIN_PX) return null;
    if (!this.rng.chance(VOUCH_CHANCE)) return null;
    return fill(this.rng.pick(VOUCH_LINES), { name, room: roomLabelAt(seen) });
  }

  /**
   * Our strongest own lead (on `only`, if given) worth at least `minWeight`, as a meeting line.
   * `backup` phrases it as agreeing with someone else's accusation.
   */
  private evidenceLine(snap: Snapshot, me: MeView, only: string | null, minWeight: number, backup = false): { id: string; line: string } | null {
    const leads: { id: string; weight: number; line: () => string | null }[] = [];
    for (const s of this.nearBodySuspects(snap, me)) {
      // A holder doesn't hold standing by the body against whoever reported it.
      if (s.kind === 'near' && s.reporter && me.role === 'holder') continue;
      const lines = s.kind === 'near' ? (backup ? BACKUP_NEAR_BODY_LINES : NEAR_BODY_LINES) : backup ? BACKUP_AROUND_LINES : AROUND_BODY_LINES;
      leads.push({ id: s.id, weight: s.weight, line: () => fill(this.rng.pick(lines), { name: s.name, room: s.room }) });
    }
    for (const s of this.seenWithSuspects(snap, me)) {
      const lines = backup ? BACKUP_SEEN_WITH_LINES : SEEN_WITH_LINES;
      leads.push({ id: s.id, weight: s.weight, line: () => fill(this.rng.pick(lines), { name: s.name, victim: s.victim, room: s.room }) });
    }
    // Only a holder reasons by elimination (a rugger's version would just be a guess).
    for (const [id, a] of me.role === 'holder' ? this.alibis(snap, me) : []) {
      const name = this.names.get(id);
      if (name && a.weight > 0) leads.push({ id, weight: a.weight, line: () => fill(this.rng.pick(ELIMINATION_LINES), { name }) });
    }
    const best = leads.filter((l) => (only === null || l.id === only) && l.weight >= minWeight).sort((a, b) => b.weight - a.weight)[0];
    const line = best?.line();
    return best && line ? { id: best.id, line } : null;
  }

  /** Ids of players named in `text` (by unique name or color word), and whether the line is just that. */
  private parseMentions(text: string, fromId: string, snap: Snapshot): { ids: string[]; bare: boolean } {
    const ids: string[] = [];
    let rest = text;
    for (const m of this.getNameMatchers()) {
      if (m.id === fromId || !m.re.test(text)) continue;
      if (!ids.includes(m.id)) ids.push(m.id);
      rest = rest.replace(m.reAll, ' ');
    }
    for (const p of snap.players) {
      if (p.id === fromId) continue;
      for (const word of COLOR_WORDS[p.color] ?? []) {
        const re = new RegExp(tokenSource(word));
        if (!re.test(text)) continue;
        if (!ids.includes(p.id)) ids.push(p.id);
        rest = rest.replace(new RegExp(tokenSource(word), 'g'), ' ');
      }
    }
    const bare = ids.length > 0 && /^[^a-z0-9]*$/.test(rest);
    return { ids, bare };
  }

  private getNameMatchers(): { id: string; re: RegExp; reAll: RegExp }[] {
    if (this.nameMatchers) return this.nameMatchers;
    const counts = new Map<string, number>();
    for (const name of this.names.values()) {
      const key = name.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const out: { id: string; re: RegExp; reAll: RegExp }[] = [];
    for (const [id, name] of this.names) {
      const key = name.trim().toLowerCase();
      // Ambiguous ("anon" twice) or too short to match reliably: skip.
      if (key.length < 2 || (counts.get(key) ?? 0) > 1) continue;
      const src = tokenSource(key);
      out.push({ id, re: new RegExp(src), reAll: new RegExp(src, 'g') });
    }
    this.nameMatchers = out;
    return out;
  }

  private ghostLine(me: MeView): string {
    const killer = this.mem.killedBy ? this.names.get(this.mem.killedBy) : undefined;
    if (killer && me.role === 'holder' && this.rng.chance(0.4)) {
      const line = fill(this.rng.pick(GHOST_KILLER_LINES), { name: killer });
      if (line) return line;
    }
    return this.rng.pick(GHOST_LINES);
  }

  private queueLine(text: string, at: number, channel: 'meeting' | 'ghost'): void {
    const clean = text.slice(0, MAX_CHAT_LENGTH);
    const last = this.chatQueue.length > 0 ? this.chatQueue[this.chatQueue.length - 1].at : -Infinity;
    this.chatQueue.push({ at: Math.max(at, last + CHAT_GAP_MS), text: clean, channel, meetingSeq: this.mem.meetingSeq });
    this.chatQueue.sort((a, b) => a.at - b.at);
  }

  private lineStillValid(line: QueuedLine, snap: Snapshot, me: MeView): boolean {
    if (line.channel === 'meeting') return snap.phase === 'meeting' && me.alive && line.meetingSeq === this.mem.meetingSeq;
    return !me.alive && (snap.phase === 'playing' || snap.phase === 'meeting');
  }

  /** Someone already said exactly this, or it asks where the body was after someone said where. */
  private isStaleMeetingLine(text: string): boolean {
    const st = this.meeting;
    if (!st) return false;
    const t = text.toLowerCase().trim();
    return st.heard.has(t) || (st.bodyRoomHeard && REPORT_MEETING_LINES.includes(t));
  }

  private thinkChat(now: number, snap: Snapshot, me: MeView): void {
    // Rare ghost banter while playing.
    if (!me.alive && snap.phase === 'playing' && now >= this.nextBanterAt) {
      this.nextBanterAt = now + this.rng.range(60000, 120000);
      if (this.rng.chance(0.3)) this.queueLine(this.ghostLine(me), now + this.rng.range(0, 3000), 'ghost');
    }
    while (this.chatQueue.length > 0) {
      const line = this.chatQueue[0];
      if (!this.lineStillValid(line, snap, me)) {
        this.chatQueue.shift();
        continue;
      }
      if (now < line.at || now - this.lastChatAt < CHAT_GAP_MS) return;
      this.chatQueue.shift();
      if (line.channel === 'meeting' && this.isStaleMeetingLine(line.text)) continue;
      this.send({ t: 'chat', text: line.text });
      this.meeting?.heard.add(line.text.toLowerCase().trim());
      this.lastChatAt = now;
      return;
    }
  }

  // ---------- Events ----------

  private handleEvent(ev: GameEvent): void {
    const now = this.now;
    switch (ev.kind) {
      case 'gameStarted':
        this.resetGame();
        break;
      case 'rugged':
        // Only the killer, the victim and fellow ruggers get this event.
        if (ev.victimId === this.id) {
          this.mem.killedBy = ev.killerId;
        } else {
          if (ev.killerId !== this.id) {
            this.mem.fellowRuggers.add(ev.killerId);
            // Space the team's rugs out instead of everyone rugging at once.
            this.teamHoldUntil = Math.max(this.teamHoldUntil, now + TEAM_KILL_SPACING_MS + this.rng.range(0, TEAM_KILL_JITTER_MS));
          }
          this.mem.teamKills.push({ killerId: ev.killerId, victimId: ev.victimId, t: now });
        }
        this.mem.gone.add(ev.victimId);
        if (ev.killerId === this.id && this.phase === 'playing') this.onKillConfirmed(now);
        break;
      case 'taskCompleted':
        this.mem.locallyDone.add(ev.stationId);
        break;
      case 'votingOpened':
        this.markVotingOpened(now, this.snap);
        break;
      case 'sabotageFixed':
        this.fix = null;
        this.dump = null;
        this.holdingStationId = null;
        break;
      case 'playerLeft':
        this.mem.lastSeen.delete(ev.playerId);
        this.mem.gone.add(ev.playerId);
        break;
      case 'kicked':
        this.resetGame();
        this.snap = null;
        this.phase = null;
        break;
      case 'bodyReported':
      case 'emergencyCalled':
      case 'sabotageStarted':
      case 'playerJoined':
        // Handled through the snapshot (phase / sabotage transitions).
        break;
    }
  }
}

/** Holders' vision radius right now (FUD shrinks it). */
function holderVision(snap: Snapshot): number {
  const fud = snap.sabotage?.kind === 'fud' ? FUD_VISION_MULT : 1;
  return BASE_VISION * finiteOr(snap.room.settings.crewVision, 1) * fud;
}
