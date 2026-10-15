// Gameplay constants shared by server and client.
// Distances are in world pixels, times in milliseconds unless noted.

/** Working title. Change in one place to rebrand. */
export const GAME_NAME = 'AMONG RUGS';
export const DEFAULT_TICKER = '$RUGS';

export const TILE = 40;
export const PLAYER_RADIUS = 14;

/** Base movement speed in px/second (multiplied by settings.playerSpeed). */
export const BASE_SPEED = 200;
/** Ghosts move faster and ignore walls. */
export const GHOST_SPEED_MULT = 1.25;

/** Base vision radius in px (multiplied by crewVision / ruggerVision settings). */
export const BASE_VISION = 300;
/** Holders' vision multiplier while FUD (lights) sabotage is active. */
export const FUD_VISION_MULT = 0.3;

export const KILL_RANGE = 70;
export const REPORT_RANGE = 90;
export const USE_RANGE = 70;
export const VENT_RANGE = 55;
/** Reaches the SPACES button from every side of the Launchpad table (half-width 80 px + PLAYER_RADIUS, corners included). */
export const EMERGENCY_RANGE = 115;

export const SERVER_TICK_HZ = 20;
export const CLIENT_SEND_HZ = 20;
/** Remote players are rendered this far in the past for smooth interpolation. */
export const INTERP_DELAY_MS = 100;

export const ROLE_REVEAL_MS = 4000;
export const EJECTION_MS = 6000;
export const MEETING_RESULTS_MS = 4000;
/** Cooldown applied to kills and sabotage right after a game starts or a meeting ends. */
export const POST_MEETING_COOLDOWN_MS = 10000;
export const SABOTAGE_COOLDOWN_MS = 30000;
export const DEV_DUMP_DURATION_MS = 40000;
/** Ghost players, disconnected-player grace window. */
export const RECONNECT_GRACE_MS = 20000;

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 10;
export const ROOM_CODE_LENGTH = 4;
export const MAX_NAME_LENGTH = 16;
export const MAX_CHAT_LENGTH = 140;
export const CHAT_RATE_LIMIT_MS = 700;

/** Player colors: index is the color id. Top half of the pill uses `body`, shading uses `dark`. */
export const PLAYER_COLORS: ReadonlyArray<{ name: string; body: string; dark: string }> = [
  { name: 'Pump Green', body: '#2bff88', dark: '#12a85a' },
  { name: 'Rug Red', body: '#ff3b5c', dark: '#b01f3a' },
  { name: 'Sol Purple', body: '#9945ff', dark: '#5f22b3' },
  { name: 'Degen Blue', body: '#2f8cff', dark: '#1a55a8' },
  { name: 'Bonk Orange', body: '#ff9f1c', dark: '#b86c00' },
  { name: 'Pepe Lime', body: '#b6ff3b', dark: '#78b01f' },
  { name: 'Whale Cyan', body: '#22e5ff', dark: '#0f97a8' },
  { name: 'Cabal Pink', body: '#ff4fd8', dark: '#b0238f' },
  { name: 'Gold Bag', body: '#ffd400', dark: '#b39400' },
  { name: 'Exit White', body: '#e8eef5', dark: '#9aa6b5' },
  { name: 'Shadow Black', body: '#3a3f4b', dark: '#1d2027' },
  { name: 'Copium Brown', body: '#a0663a', dark: '#6b3f1f' },
];

export interface GameSettings {
  /** Number of impostors ("ruggers"). Effective count is clamped by player count. */
  ruggers: number;
  /** Kill cooldown in seconds. */
  killCooldown: number;
  /** Multiplier on BASE_SPEED. */
  playerSpeed: number;
  /** Multiplier on BASE_VISION for holders. */
  crewVision: number;
  /** Multiplier on BASE_VISION for ruggers. */
  ruggerVision: number;
  /** Seconds of discussion before voting opens. */
  discussionTime: number;
  /** Seconds of voting. */
  votingTime: number;
  tasksPerPlayer: number;
  emergencyMeetings: number;
  /** Reveal whether the ejected player was a rugger. */
  confirmEjects: boolean;
  /** Whether the room appears in quick play. */
  isPublic: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = {
  ruggers: 1,
  killCooldown: 25,
  playerSpeed: 1,
  crewVision: 1,
  ruggerVision: 1.5,
  discussionTime: 30,
  votingTime: 60,
  tasksPerPlayer: 5,
  emergencyMeetings: 1,
  confirmEjects: true,
  isPublic: true,
};

/** Inclusive bounds the server clamps settings to. */
export const SETTINGS_BOUNDS: Record<
  Exclude<keyof GameSettings, 'confirmEjects' | 'isPublic'>,
  { min: number; max: number; step: number }
> = {
  ruggers: { min: 1, max: 3, step: 1 },
  killCooldown: { min: 10, max: 60, step: 5 },
  playerSpeed: { min: 0.5, max: 2, step: 0.25 },
  crewVision: { min: 0.5, max: 2, step: 0.25 },
  ruggerVision: { min: 0.5, max: 2.5, step: 0.25 },
  discussionTime: { min: 0, max: 120, step: 15 },
  votingTime: { min: 15, max: 180, step: 15 },
  tasksPerPlayer: { min: 2, max: 10, step: 1 },
  emergencyMeetings: { min: 0, max: 3, step: 1 },
};

/** Max ruggers allowed for a given player count (mirrors the classic 4/7/9 thresholds). */
export function maxRuggersFor(playerCount: number): number {
  if (playerCount >= 9) return 3;
  if (playerCount >= 7) return 2;
  return 1;
}

/** Weekly ranked points per finished ranked game. */
export const RANKED_POINTS = {
  holderWin: 30,
  ruggerWin: 40,
  perRug: 5,
  perTask: 1,
  perCorrectVote: 5,
  /** Holder still alive at the end of a game the holders won. */
  survived: 5,
  /** Left (removed after the reconnect grace) before the game ended. Replaces everything else. */
  leftEarly: -20,
} as const;

export const DEFAULT_RANKED_ENTRY_PRICE = 50_000;
