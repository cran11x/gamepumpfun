// Pure helpers for the ranked + burn UI (no DOM): prices, copy, start gating, countdowns, name-effect
// classes. Kept free of DOM and canvas imports so they unit-test in node.

import { MIN_PLAYERS } from '../../../shared/constants';
import { COSMETIC_SLOTS, cosmeticById, isCosmeticForSlot, type CosmeticItem, type CosmeticSlot } from '../../../shared/cosmetics';
import type { BurnConfig, BurnIntentRequest, BurnReceipt, EquippedCosmetics, PlayerView, Role } from '../../../shared/protocol';

export type BurnMode = BurnConfig['mode'];

/** The burn mode from the public config; anything unexpected reads as 'off' (every burn feature hidden). */
export function burnModeOf(config: { burn?: Partial<BurnConfig> | null } | null | undefined): BurnMode {
  const m = config?.burn?.mode;
  return m === 'live' || m === 'mock' ? m : 'off';
}

/** Whole tokens with thousands separators: 50000 -> "50,000". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/** Compact total for tight spots: 12_345_678 -> "12.3M". Below 100k it stays exact. */
export function formatTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
  ];
  for (const [v, s] of units) {
    if (n >= v) {
      const x = n / v;
      return `${x >= 100 ? Math.floor(x) : Math.floor(x * 10) / 10}${s}`;
    }
  }
  return formatTokens(n);
}

/** Whole tokens a cosmetic costs. Mirrors server/burns.ts priceOf (display only: the server decides). */
export function itemPrice(burn: Pick<BurnConfig, 'priceMultiplier'>, item: CosmeticItem): number {
  const mult = Number.isFinite(burn.priceMultiplier) && burn.priceMultiplier > 0 ? burn.priceMultiplier : 1;
  return Math.max(1, Math.round(item.price * mult));
}

/** Whole tokens a purchase costs, or null for an unknown item. */
export function purchasePrice(burn: Pick<BurnConfig, 'priceMultiplier' | 'rankedEntryPrice'>, req: BurnIntentRequest): number | null {
  if (req.purpose === 'ranked') return burn.rankedEntryPrice > 0 ? burn.rankedEntryPrice : null;
  const item = req.itemId ? cosmeticById(req.itemId) : undefined;
  return item ? itemPrice(burn, item) : null;
}

const SLOT_NOUN: Record<CosmeticSlot, string> = { skin: 'pill skin', rug: 'rug pattern', name: 'name effect' };

export function slotNoun(slot: CosmeticSlot): string {
  return SLOT_NOUN[slot] ?? slot;
}

export function slotTitle(slot: CosmeticSlot): string {
  return COSMETIC_SLOTS.find((s) => s.slot === slot)?.title ?? slot;
}

/** What the player gets, for "You get: …". */
export function burnWhat(req: BurnIntentRequest): string {
  if (req.purpose === 'ranked') return '1 ranked ticket';
  const item = req.itemId ? cosmeticById(req.itemId) : undefined;
  return item ? `${item.name} (${slotNoun(item.slot)})` : 'a cosmetic';
}

/** The burn modal's main line. Never promises a price or a return: burned tokens are simply gone. */
export function burnCopy(amount: number, ticker: string, what: string): string {
  return `Burn ${formatTokens(amount)} ${ticker}. Tokens are destroyed forever. Nobody receives them. You get: ${what}.`;
}

/** wallet.burn() gave up waiting while the burn was already sent: never offer a new burn, only a re-check. */
export function isPendingBurnError(message: string): boolean {
  return /not confirmed yet|finish confirming/i.test(message);
}

/** Toast for a burn confirmed later (resumePendingBurns). */
export function receiptToast(r: Pick<BurnReceipt, 'purpose' | 'itemId' | 'amount'>, ticker: string): string {
  const burned = r.amount > 0 ? `${formatTokens(r.amount)} ${ticker} burned. ` : '';
  if (r.purpose === 'ranked') return `${burned}Ranked ticket added.`;
  const item = r.itemId ? cosmeticById(r.itemId) : undefined;
  return `${burned}${item ? item.name : 'Item'} unlocked.`;
}

// ---------- Ranked lobby START gating ----------

export interface StartGate {
  canStart: boolean;
  hint: string;
  /** The hint explains why START is disabled. */
  warn: boolean;
}

function names(list: PlayerView[], max = 3): string {
  const shown = list.slice(0, max).map((p) => p.name);
  return list.length > max ? `${shown.join(', ')} +${list.length - max}` : shown.join(', ');
}

/** START in a ranked lobby: 4+ players (humans only), everyone holding a ticket, everyone connected. */
export function rankedStartGate(players: PlayerView[]): StartGate {
  const n = players.length;
  const need = Math.max(0, MIN_PLAYERS - n);
  if (need > 0) return { canStart: false, warn: true, hint: `need ${need} more ${need === 1 ? 'player' : 'players'} (ranked has no bots)` };
  const noTicket = players.filter((p) => p.hasTicket === false);
  if (noTicket.length) return { canStart: false, warn: true, hint: `no ticket yet: ${names(noTicket)}` };
  const away = players.filter((p) => p.disconnected);
  if (away.length) return { canStart: false, warn: true, hint: `waiting for ${names(away)} to reconnect` };
  return { canStart: true, warn: false, hint: `${n} players ready · START uses 1 ticket each` };
}

// ---------- Weekly reset ----------

const DAY = 86_400_000;

/** Start of the next ISO week (Monday 00:00 UTC) after `now`. */
export function nextWeekStartUtc(now: number): number {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return midnight + (7 - dow) * DAY;
}

/** "3d 4h", "4h 12m", "12m 09s". */
export function resetCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

export function timeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ---------- Name effects in the DOM ----------

/** CSS class per name effect (styles.css .nfx-*). Every one stays out of the rug-red family. */
export const NAME_FX_CLASS: Readonly<Record<string, string>> = {
  name_gold: 'nfx-gold',
  name_diamond: 'nfx-diamond',
  name_glitch: 'nfx-glitch',
  name_rainbow: 'nfx-rainbow',
  name_fire: 'nfx-fire',
};

/**
 * The name-effect class to put on a name, or null. `red`: this viewer sees the name in rug red (their
 * own rugger name or a fellow rugger's, ghosts in a meeting, ...). Red always wins over any effect, so
 * an effect can never hide or imitate the ally signal.
 */
export function nameFxClass(cosmetics: EquippedCosmetics | null | undefined, red: boolean): string | null {
  if (red) return null;
  const id = cosmetics?.name;
  if (!id || !isCosmeticForSlot(id, 'name')) return null;
  return NAME_FX_CLASS[id] ?? null;
}

/** Fellow-rugger red: the viewer is a rugger and so is this player (the viewer's own name included). */
export function isAllyRed(viewerRole: Role | null | undefined, playerIsRugger: boolean | null | undefined): boolean {
  return viewerRole === 'rugger' && !!playerIsRugger;
}
