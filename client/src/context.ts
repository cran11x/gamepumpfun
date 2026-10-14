// Cross-module contract for the browser client. Each module owns one of these APIs;
// client/src/main.ts creates them and wires them together into one AppContext.
//
//   game/   (createGame)      -> GameApi   : world simulation, input, rendering, interactions
//   ui/     (createUi)        -> UiApi     : DOM screens, HUD, meetings, overlays, minigame host
//   tasks/  (mountMinigame)   -> minigames : rendered inside the UI's minigame overlay
//   audio.ts (createAudio)    -> AudioApi
//   wallet.ts (createWallet)  -> WalletApi : Phantom sign-in + profile
//   api.ts                    -> HTTP helpers (config, leaderboard)

import type { FixKind, Profile, PublicConfig, SabotageKind, Snapshot, TaskKind } from '../../shared/protocol';
import type { Net } from './net';
import type { Store } from './store';

export type MinigameTarget =
  | { type: 'task'; stationId: string; kind: TaskKind }
  | { type: 'fix'; stationId: string; kind: FixKind };

export type UseTarget =
  | { type: 'task'; stationId: string; kind: TaskKind }
  | { type: 'fix'; stationId: string; kind: FixKind }
  | { type: 'emergency' }
  | { type: 'vent'; ventId: string };

/** What the local player can interact with right now. Recomputed every frame by the game module. */
export interface Interactions {
  /** Primary USE target in range (task you own, sabotage fix station, SPACES button). Null if none. */
  use: UseTarget | null;
  /** Ruggers: nearest living holder within KILL_RANGE (ignores cooldown; the HUD shows cooldown). */
  killTargetId: string | null;
  /** Nearest body within REPORT_RANGE (living players only). */
  reportBodyId: string | null;
  /** Ruggers: vent within VENT_RANGE, or the vent you are currently in. */
  ventId: string | null;
}

export interface GameApi {
  getInteractions(): Interactions;
  /** Perform the current USE target (opens minigames via ui.openMinigame, presses SPACES, etc.). */
  use(): void;
  kill(): void;
  report(): void;
  /** Enter the vent in range, or exit the current one. */
  ventToggle(): void;
  /** While inside a vent: travel to a linked vent. */
  ventMove(ventId: string): void;
  sabotage(kind: SabotageKind): void;
  /** UI blocks movement + action hotkeys while a minigame/chat input/modal is open. */
  setInputBlocked(blocked: boolean): void;
  /** Mobile joystick vector from the UI, each axis in [-1, 1]. */
  setJoystick(x: number, y: number): void;
  /** Local (predicted) position of the player, or null when not in a game. */
  getSelfPosition(): { x: number; y: number } | null;
}

export interface UiApi {
  openMinigame(target: MinigameTarget): void;
  closeMinigame(): void;
  isMinigameOpen(): boolean;
  toast(text: string, tone?: 'info' | 'good' | 'bad'): void;
}

export type SoundName =
  | 'click'
  | 'taskDone'
  | 'kill'
  | 'meeting'
  | 'vote'
  | 'eject'
  | 'sabotage'
  | 'alarm'
  | 'win'
  | 'lose'
  | 'vent'
  | 'reveal'
  | 'error';

export interface AudioApi {
  play(name: SoundName): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

export interface WalletSession {
  token: string;
  profile: Profile;
}

export interface WalletApi {
  /** window.phantom?.solana (or window.solana with isPhantom) is present. */
  isPhantomAvailable(): boolean;
  getSession(): WalletSession | null;
  /** Connect Phantom, sign a login message (no transaction), verify with the server. */
  login(): Promise<WalletSession>;
  logout(): void;
  refreshProfile(): Promise<Profile | null>;
  setName(name: string): Promise<Profile>;
  /** Called after login/logout/profile changes. */
  onChange(cb: () => void): () => void;
}

/** Props passed by the UI's minigame overlay to a minigame. */
export interface MinigameHost {
  /** The player finished successfully. The host sends taskDone / fix done and closes the overlay. */
  complete(): void;
  /** Close without completing. */
  close(): void;
  /** fixDump only: the player pressed / released the buy-wall hold pad. */
  holdStart(): void;
  holdEnd(): void;
  getSnapshot(): Snapshot | null;
  sound(name: SoundName): void;
  ticker: string;
  contractAddress: string | null;
}

export interface AppContext {
  net: Net;
  store: Store;
  game: GameApi;
  ui: UiApi;
  audio: AudioApi;
  wallet: WalletApi;
  config: PublicConfig;
}
