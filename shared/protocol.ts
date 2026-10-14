// Wire protocol between browser and server. JSON over a single WebSocket at /ws.
// Every message is an object with a string discriminator `t`.
//
// Authority model:
// - The server is authoritative for roles, kills, tasks, meetings, votes, sabotage and win conditions.
// - Movement is client-reported (`move`) and server-validated (speed clamp + wall collision).
//   The server never echoes your own position back unless it teleports you; it signals that
//   by incrementing `me.teleportSeq`, and the client must then snap to `me.x/me.y`.

import type { GameSettings } from './constants';

export type Role = 'holder' | 'rugger';

export type Phase = 'lobby' | 'roleReveal' | 'playing' | 'meeting' | 'ejection' | 'gameOver';

export type TaskKind =
  | 'verifyCA' // pick the real contract address among poisoned look-alikes
  | 'snipeLaunch' // stop a moving marker inside the green zone
  | 'burnLP' // drag LP tokens into the furnace
  | 'shillPost' // type the shill tweet exactly
  | 'addLiquidity' // hold to fill the pool up to the target line, release in the band
  | 'bubblemap' // click the bundled cluster on a bubble map
  | 'connectSocials' // connect matching colored links (wires)
  | 'deleteBots' // delete the bot comments from a comment feed
  | 'swapSol' // set the slider to the target amount
  | 'syncNode'; // wait for an RPC sync progress bar (stand still)

export type SabotageKind = 'devDump' | 'fud' | 'rpcDown';

/** Minigames used to fix sabotage. devDump is a two-station simultaneous hold. */
export type FixKind = 'fixDump' | 'fixFud' | 'fixRpc';

export type MeetingReason = 'report' | 'emergency';

export type GameOverReason =
  | 'tasks' // bonding curve reached 100%
  | 'ruggersEjected' // all ruggers voted out or left
  | 'parity' // ruggers >= holders alive
  | 'devDump' // critical sabotage timer ran out
  | 'abandoned'; // not enough players left

export type Winner = 'holders' | 'ruggers';

/** Public room info + lobby configuration. Present in every snapshot. */
export interface RoomView {
  code: string;
  hostId: string;
  settings: GameSettings;
  ticker: string;
}

export interface PlayerView {
  id: string;
  name: string;
  /** Index into PLAYER_COLORS. */
  color: number;
  x: number;
  y: number;
  /** 1 = facing right, -1 = facing left. */
  facing: 1 | -1;
  moving: boolean;
  alive: boolean;
  isBot: boolean;
  /** Shortened wallet address when the player signed in with Phantom, e.g. "7xKq…3fQa". */
  wallet?: string;
  /** Only sent to fellow ruggers, and to everyone in gameOver. */
  isRugger?: boolean;
  /** Only sent to fellow ruggers (others simply don't receive vented ruggers). */
  inVent?: boolean;
  /** True while the player's socket is disconnected (grace window). */
  disconnected?: boolean;
}

export interface BodyView {
  /** Equals the victim's player id. */
  id: string;
  color: number;
  x: number;
  y: number;
}

export interface TaskAssignment {
  stationId: string;
  kind: TaskKind;
  done: boolean;
}

export interface MeView {
  id: string;
  role: Role;
  alive: boolean;
  /** Server-side position; only meaningful when teleportSeq changed. */
  x: number;
  y: number;
  teleportSeq: number;
  /** Holders: real tasks. Ruggers: fake task list (done is always false; for blending in). */
  tasks: TaskAssignment[];
  /** Station id of the task minigame the server considers open for you. */
  activeStationId: string | null;
  /** Ruggers only. Absolute server time (ms) when kill becomes available. */
  killReadyAt?: number;
  /** Ruggers only. Absolute server time (ms) when sabotage becomes available. */
  sabotageReadyAt?: number;
  /** Ruggers only. Vent id when hiding inside a bridge. */
  ventId?: string | null;
  emergencyLeft: number;
}

export interface SabotageStationView {
  id: string;
  fixed: boolean;
  /** devDump only: number of players currently holding this station. */
  holders?: number;
}

export interface SabotageView {
  kind: SabotageKind;
  /** Critical sabotage only (devDump): absolute server time when ruggers win. */
  endsAt?: number;
  stations: SabotageStationView[];
}

export interface MeetingView {
  callerId: string;
  reason: MeetingReason;
  /** Color of the reported body (report meetings). */
  bodyColor?: number;
  stage: 'discussion' | 'voting' | 'results';
  /** Ids of players who have voted (not whom they voted for). */
  votedIds: string[];
  /** Your own vote: player id or 'skip'. */
  myVote?: string;
  /** Present in the results stage: voterId -> targetId | 'skip'. */
  votes?: Record<string, string>;
  ejectedId?: string | null;
  tie?: boolean;
}

export interface EjectionView {
  ejectedId: string | null;
  ejectedName?: string;
  ejectedColor?: number;
  /** Undefined when settings.confirmEjects is false. */
  wasRugger?: boolean;
  tie: boolean;
  /** Living ruggers after the ejection. Undefined when settings.confirmEjects is false (it would reveal the role). */
  ruggersLeft?: number;
}

export interface GameOverView {
  winner: Winner;
  reason: GameOverReason;
  /** playerId -> role for everyone in the game. */
  roles: Record<string, Role>;
}

/** Per-client view of the room. Sent at SERVER_TICK_HZ while playing, otherwise on change (>= 2 Hz). */
export interface Snapshot {
  t: 'snap';
  /** Server clock in ms (Date.now() on the server). */
  now: number;
  phase: Phase;
  /** Absolute server time when the current timed phase/stage ends. */
  phaseEndsAt?: number;
  room: RoomView;
  /**
   * Players visible to you. Living players don't receive ghosts; non-ruggers don't receive vented ruggers.
   * While playing, a living viewer only receives players near its vision radius and in line of sight
   * (fellow ruggers always), so an absent player may simply be out of view.
   */
  players: PlayerView[];
  bodies: BodyView[];
  /** Bonding curve 0..1 = completed holder tasks / total holder tasks. Hidden (-1) during rpcDown for holders. */
  taskProgress: number;
  sabotage: SabotageView | null;
  /** Absent in the lobby. */
  me?: MeView;
  meeting?: MeetingView;
  ejection?: EjectionView;
  gameOver?: GameOverView;
}

// ---------- Client -> Server ----------

export type C2S =
  | { t: 'create'; name: string; authToken?: string }
  | { t: 'join'; code: string; name: string; authToken?: string }
  | { t: 'quick'; name: string; authToken?: string }
  | { t: 'rejoin'; code: string; playerId: string; sessionKey: string }
  | { t: 'leave' }
  | { t: 'setColor'; color: number }
  | { t: 'settings'; settings: Partial<GameSettings> } // host, lobby only
  | { t: 'addBot' } // host, lobby only
  | { t: 'removeBot' } // host, lobby only
  | { t: 'kick'; playerId: string } // host, lobby only
  | { t: 'start' } // host, lobby only
  | { t: 'move'; x: number; y: number; facing: 1 | -1; moving: boolean }
  | { t: 'taskOpen'; stationId: string }
  | { t: 'taskClose' }
  | { t: 'taskDone'; stationId: string }
  | { t: 'kill'; targetId: string }
  | { t: 'report'; bodyId: string }
  | { t: 'emergency' }
  | { t: 'vent'; action: 'enter'; ventId: string }
  | { t: 'vent'; action: 'move'; ventId: string }
  | { t: 'vent'; action: 'exit' }
  | { t: 'sabotage'; kind: SabotageKind }
  /** devDump: press/release on a station. fud/rpcDown: `done` after the fix minigame. */
  | { t: 'fix'; stationId: string; action: 'holdStart' | 'holdEnd' | 'done' }
  | { t: 'chat'; text: string }
  | { t: 'vote'; target: string } // player id or 'skip'
  | { t: 'backToLobby' } // host, gameOver only
  | { t: 'ping'; ts: number };

// ---------- Server -> Client ----------

export type ChatChannel = 'lobby' | 'meeting' | 'ghost' | 'system';

export interface ChatMessage {
  t: 'chat';
  channel: ChatChannel;
  fromId: string | null;
  fromName: string;
  color: number;
  text: string;
  ts: number;
}

export type GameEvent =
  | { kind: 'gameStarted' }
  | { kind: 'rugged'; victimId: string; killerId: string } // sent to killer, victim and fellow ruggers only
  | { kind: 'bodyReported'; reporterId: string; bodyColor: number }
  | { kind: 'emergencyCalled'; callerId: string }
  | { kind: 'sabotageStarted'; sabotage: SabotageKind }
  | { kind: 'sabotageFixed'; sabotage: SabotageKind }
  | { kind: 'taskCompleted'; stationId: string } // sent to the completer only
  | { kind: 'votingOpened' }
  | { kind: 'playerJoined'; playerId: string; name: string }
  | { kind: 'playerLeft'; playerId: string; name: string }
  | { kind: 'kicked' };

export type S2C =
  | { t: 'welcome'; playerId: string; sessionKey: string; code: string }
  | { t: 'error'; code: ErrorCode; message: string }
  | Snapshot
  | ChatMessage
  | { t: 'event'; event: GameEvent }
  | { t: 'pong'; ts: number; serverNow: number };

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'GAME_IN_PROGRESS'
  | 'NOT_HOST'
  | 'NOT_ENOUGH_PLAYERS'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED'
  | 'REJOIN_FAILED'
  | 'INVALID_ACTION';

// ---------- HTTP API (same origin) ----------
// GET  /api/config                     -> PublicConfig
// GET  /api/auth/nonce?address=<b58>   -> { message: string; nonce: string }
// POST /api/auth/verify {address, nonce, signature(base58)} -> AuthResult | 401
// GET  /api/me            (Authorization: Bearer <token>) -> Profile | 401
// POST /api/me/name {name} (Authorization: Bearer <token>) -> Profile
// GET  /api/leaderboard?sort=wins|ruggerWins|holderWins|rugs|correctVotes -> LeaderboardEntry[]
// GET  /api/rooms                      -> { publicLobbies: number; playersOnline: number }

export interface PublicConfig {
  gameName: string;
  ticker: string;
  /** Contract address of the project's coin, if configured. Display only. */
  contractAddress: string | null;
  links: { x?: string; telegram?: string; pumpfun?: string };
}

export interface PlayerStats {
  gamesPlayed: number;
  wins: number;
  holderWins: number;
  ruggerWins: number;
  /** Kills as rugger. */
  rugs: number;
  timesRugged: number;
  tasksDone: number;
  /** Times this player voted for a rugger who then got ejected. */
  correctVotes: number;
}

export interface Profile {
  address: string;
  name: string;
  stats: PlayerStats;
  createdAt: number;
}

export interface AuthResult {
  token: string;
  profile: Profile;
}

export interface LeaderboardEntry {
  address: string;
  shortAddress: string;
  name: string;
  stats: PlayerStats;
}

export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}
