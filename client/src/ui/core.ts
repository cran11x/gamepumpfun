// Internal UI plumbing shared by every screen (not part of the cross-module contract).

import type { Snapshot } from '../../../shared/protocol';
import type { AppContext, SoundName } from '../context';

export type Tone = 'info' | 'good' | 'bad';

/** One routed view (home, lobby, role reveal, HUD, meeting, ejection, game over). */
export interface Screen {
  el: HTMLElement;
  /** Called with every snapshot while this screen is mounted (null only for home). */
  update(snap: Snapshot | null): void;
  destroy(): void;
  /** Optional keyboard hook (only called when no text input / modal / minigame has focus). */
  onKey?(ev: KeyboardEvent): boolean;
  /** Optional Escape hook: return true when the screen consumed it (e.g. closed a menu). */
  onEscape?(): boolean;
}

export interface RosterEntry {
  name: string;
  color: number;
  isBot: boolean;
}

export interface ModalHandle {
  el: HTMLElement;
  close(): void;
}

export interface ModalOpts {
  title: string;
  body: HTMLElement;
  cls?: string;
  onClose?: () => void;
}

export interface UiCore {
  ctx: AppContext;
  root: HTMLElement;
  toast(text: string, tone?: Tone): void;
  sound(name: SoundName): void;
  /** Reference-counted input blocking: game input is blocked while any key is on. */
  setBlocker(key: string, on: boolean): void;
  myId(): string | null;
  /** Name/color of any player seen in this room, even after they left or went out of view. */
  who(id: string): RosterEntry | null;
  isTouch(): boolean;
  /** Leave the room (or game) and go back home. */
  leaveRoom(): void;
  openModal(opts: ModalOpts): ModalHandle;
  openLeaderboard(): void;
  openHowTo(): void;
  openRename(): void;
  toggleMap(force?: boolean): void;
  isMapOpen(): boolean;
  /** Copy to clipboard with a toast; falls back to a manual-copy modal. */
  copy(text: string, what: string): void;
  /** True on screens narrower than the mobile breakpoint. */
  isNarrow(): boolean;
  /** Server time the current game started (0 when unknown, e.g. after a mid-game rejoin). */
  gameStartedAt(): number;
}
