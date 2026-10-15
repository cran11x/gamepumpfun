// Cosmetics catalog. Bought by burning the project's token; purely visual, never a gameplay advantage.
//
// Rules for anyone adding items:
// - A cosmetic must never reveal or imitate a role. In particular, name effects must not use the
//   rug-red family (#ff3b5c and similar reds): fellow ruggers see each other's names in red.
// - Pill skins draw on top of the player's color; the color must stay clearly recognisable,
//   because "red is sus" is how players talk about each other.
// - Rug patterns only ever show under your OWN rugged bag and on your own ejection ride, so they
//   cannot reveal who rugged whom.

export type CosmeticSlot = 'skin' | 'rug' | 'name';

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface CosmeticItem {
  id: string;
  slot: CosmeticSlot;
  name: string;
  /** One short line for the shop card. */
  blurb: string;
  rarity: Rarity;
  /** Base price in whole tokens. The server multiplies by BurnConfig.priceMultiplier. */
  price: number;
}

export const COSMETICS: readonly CosmeticItem[] = [
  // ---- Pill skins (drawn over the top half of the pill, keeping the player color) ----
  { id: 'skin_candles', slot: 'skin', name: 'Green Candles', blurb: 'A tiny pump chart printed on your pill.', rarity: 'common', price: 15_000 },
  { id: 'skin_shades', slot: 'skin', name: 'Cabal Shades', blurb: 'Black shades. You know things.', rarity: 'common', price: 20_000 },
  { id: 'skin_diamond', slot: 'skin', name: 'Diamond Hands', blurb: 'Crystal facets that sparkle when you move.', rarity: 'rare', price: 25_000 },
  { id: 'skin_onchain', slot: 'skin', name: 'On-Chain', blurb: 'Hex digits stream down your pill.', rarity: 'rare', price: 35_000 },
  { id: 'skin_laser', slot: 'skin', name: 'Laser Eyes', blurb: 'Glowing eyes. Maximum conviction.', rarity: 'rare', price: 40_000 },
  { id: 'skin_gold', slot: 'skin', name: 'Gold Bag', blurb: 'Gold rim, gold legs, gold shine.', rarity: 'epic', price: 60_000 },
  { id: 'skin_crown', slot: 'skin', name: 'Whale Crown', blurb: 'A crown for the biggest bag in the room.', rarity: 'epic', price: 75_000 },
  { id: 'skin_holo', slot: 'skin', name: 'Holo Pill', blurb: 'Animated rainbow foil, like a rare card.', rarity: 'legendary', price: 100_000 },

  // ---- Rug patterns (under your own rugged bag and on your ejection ride) ----
  { id: 'rug_persian', slot: 'rug', name: 'Persian Classic', blurb: 'Grandma\'s rug. Still gets pulled.', rarity: 'common', price: 10_000 },
  { id: 'rug_checker', slot: 'rug', name: 'Checkered Degen', blurb: 'Black and white, like your PnL.', rarity: 'common', price: 12_000 },
  { id: 'rug_dump', slot: 'rug', name: 'Red Candle', blurb: 'The chart you never want to see.', rarity: 'rare', price: 15_000 },
  { id: 'rug_frog', slot: 'rug', name: 'Frog Pond', blurb: 'Green, warty, oddly comfy.', rarity: 'rare', price: 20_000 },
  { id: 'rug_gold', slot: 'rug', name: 'Golden Fringe', blurb: 'If you get rugged, get rugged in style.', rarity: 'epic', price: 50_000 },
  { id: 'rug_galaxy', slot: 'rug', name: 'Galaxy Rug', blurb: 'An animated starfield. To the moon, horizontally.', rarity: 'legendary', price: 80_000 },

  // ---- Name effects (never red: see the rules above) ----
  { id: 'name_gold', slot: 'name', name: 'Gold Glow', blurb: 'Your name in warm gold.', rarity: 'common', price: 20_000 },
  { id: 'name_diamond', slot: 'name', name: 'Diamond Badge', blurb: 'A 💎 next to your name.', rarity: 'rare', price: 25_000 },
  { id: 'name_glitch', slot: 'name', name: 'Glitch', blurb: 'Your name jitters like a bad RPC.', rarity: 'rare', price: 30_000 },
  { id: 'name_rainbow', slot: 'name', name: 'Rainbow', blurb: 'Cycling rainbow letters.', rarity: 'epic', price: 40_000 },
  { id: 'name_fire', slot: 'name', name: 'On Fire', blurb: 'Flickering orange flames. Hot streak.', rarity: 'legendary', price: 60_000 },
];

export const COSMETIC_SLOTS: readonly { slot: CosmeticSlot; title: string }[] = [
  { slot: 'skin', title: 'Pill skins' },
  { slot: 'rug', title: 'Rug patterns' },
  { slot: 'name', title: 'Name effects' },
];

export const RARITY_COLORS: Record<Rarity, string> = {
  common: '#9aa6b5',
  rare: '#2f8cff',
  epic: '#9945ff',
  legendary: '#ffd400',
};

export function cosmeticById(id: string): CosmeticItem | undefined {
  return COSMETICS.find((c) => c.id === id);
}

/** True if `id` exists and belongs to `slot`. */
export function isCosmeticForSlot(id: string, slot: CosmeticSlot): boolean {
  return cosmeticById(id)?.slot === slot;
}
