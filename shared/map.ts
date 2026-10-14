// The one map: "THE TRENCHES HQ". Defined as rectangles in tile units and rasterized into a grid
// that both the server (collision, validation, bots) and the client (rendering, vision) use.

import { TILE } from './constants';
import type { FixKind, SabotageKind, TaskKind } from './protocol';

export const MAP_W = 64; // tiles
export const MAP_H = 44; // tiles
export const WORLD_W = MAP_W * TILE;
export const WORLD_H = MAP_H * TILE;

/** Grid cell values. */
export const CELL_VOID = 0; // outside the station; solid, not drawn as wall
export const CELL_FLOOR = 1;
export const CELL_WALL = 2; // solid, blocks vision
export const CELL_OBSTACLE = 3; // solid furniture, does NOT block vision

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RoomId =
  | 'launchpad'
  | 'tradingFloor'
  | 'memeLab'
  | 'rpcNode'
  | 'liquidityPool'
  | 'devVault'
  | 'telegramHq'
  | 'kolStudio'
  | 'burnRoom';

export interface RoomDef {
  id: RoomId;
  name: string;
  /** Interior floor rectangle in tiles. */
  rect: Rect;
  /** Accent color used for the room's floor tint and label. */
  accent: string;
}

export const ROOMS: RoomDef[] = [
  { id: 'launchpad', name: 'LAUNCHPAD', rect: { x: 24, y: 2, w: 16, h: 10 }, accent: '#2bff88' },
  { id: 'tradingFloor', name: 'TRADING FLOOR', rect: { x: 3, y: 2, w: 14, h: 9 }, accent: '#22e5ff' },
  { id: 'memeLab', name: 'MEME LAB', rect: { x: 47, y: 2, w: 14, h: 9 }, accent: '#b6ff3b' },
  { id: 'rpcNode', name: 'RPC NODE', rect: { x: 3, y: 16, w: 10, h: 9 }, accent: '#2f8cff' },
  { id: 'liquidityPool', name: 'LIQUIDITY POOL', rect: { x: 22, y: 16, w: 20, h: 12 }, accent: '#22e5ff' },
  { id: 'devVault', name: 'DEV VAULT', rect: { x: 51, y: 16, w: 10, h: 9 }, accent: '#ffd400' },
  { id: 'telegramHq', name: 'TELEGRAM HQ', rect: { x: 3, y: 31, w: 12, h: 10 }, accent: '#2f8cff' },
  { id: 'kolStudio', name: 'KOL STUDIO', rect: { x: 24, y: 32, w: 16, h: 9 }, accent: '#ff4fd8' },
  { id: 'burnRoom', name: 'BURN ROOM', rect: { x: 49, y: 31, w: 12, h: 10 }, accent: '#ff9f1c' },
];

/** Hallways in tiles. Carved as floor after rooms. */
export const HALLS: Rect[] = [
  { x: 17, y: 5, w: 7, h: 3 }, // trading floor <-> launchpad
  { x: 40, y: 5, w: 7, h: 3 }, // launchpad <-> meme lab
  { x: 7, y: 11, w: 3, h: 5 }, // trading floor <-> rpc node
  { x: 54, y: 11, w: 3, h: 5 }, // meme lab <-> dev vault
  { x: 30, y: 12, w: 4, h: 4 }, // launchpad <-> liquidity pool
  { x: 13, y: 19, w: 9, h: 3 }, // rpc node <-> liquidity pool
  { x: 42, y: 19, w: 9, h: 3 }, // liquidity pool <-> dev vault
  { x: 7, y: 25, w: 3, h: 6 }, // rpc node <-> telegram hq
  { x: 54, y: 25, w: 3, h: 6 }, // dev vault <-> burn room
  { x: 30, y: 28, w: 4, h: 4 }, // liquidity pool <-> kol studio
  { x: 15, y: 35, w: 9, h: 3 }, // telegram hq <-> kol studio
  { x: 40, y: 35, w: 9, h: 3 }, // kol studio <-> burn room
];

export type PropKind =
  | 'spacesTable' // emergency meeting table with the SPACES button
  | 'tradingDesk'
  | 'serverRack'
  | 'pool'
  | 'vaultSafe'
  | 'memeBoard'
  | 'couch'
  | 'ringLight'
  | 'furnace'
  | 'plant';

export interface PropDef {
  kind: PropKind;
  /** Tiles. Solid (CELL_OBSTACLE) unless `walkable`. */
  rect: Rect;
  walkable?: boolean;
}

export const PROPS: PropDef[] = [
  { kind: 'spacesTable', rect: { x: 30, y: 5, w: 4, h: 3 } },
  { kind: 'plant', rect: { x: 24, y: 2, w: 1, h: 1 } },
  { kind: 'plant', rect: { x: 39, y: 2, w: 1, h: 1 } },
  { kind: 'tradingDesk', rect: { x: 5, y: 4, w: 4, h: 1 } },
  { kind: 'tradingDesk', rect: { x: 11, y: 4, w: 4, h: 1 } },
  { kind: 'tradingDesk', rect: { x: 5, y: 8, w: 4, h: 1 } },
  { kind: 'tradingDesk', rect: { x: 11, y: 8, w: 4, h: 1 } },
  { kind: 'memeBoard', rect: { x: 50, y: 2, w: 6, h: 1 } },
  { kind: 'tradingDesk', rect: { x: 50, y: 7, w: 3, h: 1 } },
  { kind: 'serverRack', rect: { x: 4, y: 17, w: 1, h: 4 } },
  { kind: 'serverRack', rect: { x: 7, y: 17, w: 1, h: 3 } },
  { kind: 'serverRack', rect: { x: 11, y: 22, w: 1, h: 2 } },
  { kind: 'pool', rect: { x: 27, y: 20, w: 10, h: 4 } },
  { kind: 'vaultSafe', rect: { x: 57, y: 17, w: 3, h: 2 } },
  { kind: 'couch', rect: { x: 5, y: 37, w: 4, h: 1 } },
  { kind: 'plant', rect: { x: 14, y: 31, w: 1, h: 1 } },
  { kind: 'ringLight', rect: { x: 31, y: 34, w: 2, h: 2 } },
  { kind: 'couch', rect: { x: 27, y: 38, w: 3, h: 1 } },
  { kind: 'couch', rect: { x: 34, y: 38, w: 3, h: 1 } },
  { kind: 'furnace', rect: { x: 56, y: 36, w: 3, h: 3 } },
  { kind: 'plant', rect: { x: 49, y: 40, w: 1, h: 1 } },
];

export interface TaskStation {
  id: string;
  kind: TaskKind;
  room: RoomId;
  /** World px (center of the interactable). */
  x: number;
  y: number;
}

/** Tile center helper. */
const tc = (tx: number, ty: number) => ({ x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE });

export const TASK_STATIONS: TaskStation[] = [
  { id: 'tf_verify', kind: 'verifyCA', room: 'tradingFloor', ...tc(6, 3) },
  { id: 'tf_swap', kind: 'swapSol', room: 'tradingFloor', ...tc(12, 9) },
  { id: 'tf_snipe', kind: 'snipeLaunch', room: 'tradingFloor', ...tc(13, 3) },
  { id: 'lp_snipe', kind: 'snipeLaunch', room: 'launchpad', ...tc(26, 10) },
  { id: 'lp_socials', kind: 'connectSocials', room: 'launchpad', ...tc(37, 10) },
  { id: 'ml_shill', kind: 'shillPost', room: 'memeLab', ...tc(52, 3) },
  { id: 'ml_socials', kind: 'connectSocials', room: 'memeLab', ...tc(59, 9) },
  { id: 'rpc_sync', kind: 'syncNode', room: 'rpcNode', ...tc(9, 17) },
  { id: 'rpc_bubble', kind: 'bubblemap', room: 'rpcNode', ...tc(5, 23) },
  { id: 'pool_add_w', kind: 'addLiquidity', room: 'liquidityPool', ...tc(26, 22) },
  { id: 'pool_add_e', kind: 'addLiquidity', room: 'liquidityPool', ...tc(37, 22) },
  { id: 'dv_swap', kind: 'swapSol', room: 'devVault', ...tc(52, 23) },
  { id: 'dv_bubble', kind: 'bubblemap', room: 'devVault', ...tc(58, 20) },
  { id: 'tg_verify', kind: 'verifyCA', room: 'telegramHq', ...tc(4, 32) },
  { id: 'tg_bots', kind: 'deleteBots', room: 'telegramHq', ...tc(12, 39) },
  { id: 'kol_shill', kind: 'shillPost', room: 'kolStudio', ...tc(26, 33) },
  { id: 'kol_bots', kind: 'deleteBots', room: 'kolStudio', ...tc(38, 33) },
  { id: 'burn_lp', kind: 'burnLP', room: 'burnRoom', ...tc(55, 35) },
  { id: 'burn_sync', kind: 'syncNode', room: 'burnRoom', ...tc(50, 32) },
];

/** Minimum time (ms) a task must stay open before the server accepts `taskDone`. */
export const TASK_MIN_MS: Record<TaskKind, number> = {
  verifyCA: 1500,
  snipeLaunch: 1000,
  burnLP: 1500,
  shillPost: 2000,
  addLiquidity: 1500,
  bubblemap: 1000,
  connectSocials: 1500,
  deleteBots: 1500,
  swapSol: 1000,
  syncNode: 5000,
};

export const TASK_TITLES: Record<TaskKind, string> = {
  verifyCA: 'Verify the CA',
  snipeLaunch: 'Snipe the Launch',
  burnLP: 'Burn the LP',
  shillPost: 'Shill on X',
  addLiquidity: 'Add Liquidity',
  bubblemap: 'Check Bubblemaps',
  connectSocials: 'Connect Socials',
  deleteBots: 'Delete Bot Comments',
  swapSol: 'Swap SOL',
  syncNode: 'Sync the RPC Node',
};

export interface Vent {
  id: string;
  room: RoomId;
  x: number;
  y: number;
  /** Vent ids reachable from this one. Symmetric. */
  links: string[];
}

/** Ruggers' "bridges" (vents). */
export const VENTS: Vent[] = [
  { id: 'v_launch', room: 'launchpad', ...tc(25, 7), links: ['v_pool_n'] },
  { id: 'v_pool_n', room: 'liquidityPool', ...tc(32, 17), links: ['v_launch', 'v_kol'] },
  { id: 'v_kol', room: 'kolStudio', ...tc(25, 39), links: ['v_pool_n'] },
  { id: 'v_trade', room: 'tradingFloor', ...tc(4, 10), links: ['v_rpc', 'v_tg'] },
  { id: 'v_rpc', room: 'rpcNode', ...tc(11, 18), links: ['v_trade', 'v_tg'] },
  { id: 'v_tg', room: 'telegramHq', ...tc(10, 32), links: ['v_trade', 'v_rpc'] },
  { id: 'v_meme', room: 'memeLab', ...tc(59, 3), links: ['v_vault', 'v_burn'] },
  { id: 'v_vault', room: 'devVault', ...tc(59, 23), links: ['v_meme', 'v_burn'] },
  { id: 'v_burn', room: 'burnRoom', ...tc(59, 32), links: ['v_meme', 'v_vault'] },
];

export interface SabotageStation {
  id: string;
  sabotage: SabotageKind;
  fix: FixKind;
  room: RoomId;
  x: number;
  y: number;
}

export const SABOTAGE_STATIONS: SabotageStation[] = [
  // DEV DUMP: two "buy wall" consoles that must be held at the same time.
  { id: 'dump_a', sabotage: 'devDump', fix: 'fixDump', room: 'tradingFloor', ...tc(9, 6) },
  { id: 'dump_b', sabotage: 'devDump', fix: 'fixDump', room: 'devVault', ...tc(55, 17) },
  // FUD: lights out for holders. Fixed in Telegram HQ.
  { id: 'fud_fix', sabotage: 'fud', fix: 'fixFud', room: 'telegramHq', ...tc(8, 39) },
  // RPC DOWN: comms; task list and bonding curve hidden. Fixed at the RPC node.
  { id: 'rpc_fix', sabotage: 'rpcDown', fix: 'fixRpc', room: 'rpcNode', ...tc(5, 16) },
];

export const SABOTAGE_TITLES: Record<SabotageKind, string> = {
  devDump: 'DEV DUMP',
  fud: 'FUD',
  rpcDown: 'RPC DOWN',
};

/** The SPACES button on the launchpad table: calls an emergency meeting. */
export const EMERGENCY_BUTTON = { x: 32 * TILE, y: 6.5 * TILE };

/** Spawn ring around the SPACES table (world px). Index = player slot. */
export const SPAWN_POINTS: { x: number; y: number }[] = Array.from({ length: 10 }, (_, i) => {
  const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
  return { x: 32 * TILE + Math.cos(a) * 150, y: 6.5 * TILE + Math.sin(a) * 105 };
});

// ---------- Rasterization ----------

function buildGrid(): Uint8Array {
  const g = new Uint8Array(MAP_W * MAP_H); // CELL_VOID
  const fill = (r: Rect, v: number) => {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++)
        if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) g[y * MAP_W + x] = v;
  };
  for (const room of ROOMS) fill(room.rect, CELL_FLOOR);
  for (const hall of HALLS) fill(hall, CELL_FLOOR);
  // Walls: any void cell that touches floor (8-neighborhood).
  const out = g.slice();
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (g[y * MAP_W + x] !== CELL_VOID) continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++)
        for (let dx = -1; dx <= 1 && !touches; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < MAP_W && ny < MAP_H && g[ny * MAP_W + nx] === CELL_FLOOR) touches = true;
        }
      if (touches) out[y * MAP_W + x] = CELL_WALL;
    }
  }
  for (const p of PROPS) if (!p.walkable) {
    for (let y = p.rect.y; y < p.rect.y + p.rect.h; y++)
      for (let x = p.rect.x; x < p.rect.x + p.rect.w; x++) out[y * MAP_W + x] = CELL_OBSTACLE;
  }
  return out;
}

export const GRID: Uint8Array = buildGrid();

export function cellAt(tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return CELL_VOID;
  return GRID[ty * MAP_W + tx];
}

export function isSolidCell(tx: number, ty: number): boolean {
  return cellAt(tx, ty) !== CELL_FLOOR;
}

/** Cells that block line of sight (walls and void; furniture does not). */
export function blocksVisionCell(tx: number, ty: number): boolean {
  const c = cellAt(tx, ty);
  return c === CELL_WALL || c === CELL_VOID;
}

export function roomAt(x: number, y: number): RoomDef | null {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  for (const r of ROOMS) {
    if (tx >= r.rect.x && tx < r.rect.x + r.rect.w && ty >= r.rect.y && ty < r.rect.y + r.rect.h) return r;
  }
  return null;
}

export function stationById(id: string): TaskStation | undefined {
  return TASK_STATIONS.find((s) => s.id === id);
}

export function ventById(id: string): Vent | undefined {
  return VENTS.find((v) => v.id === id);
}

export function sabotageStationById(id: string): SabotageStation | undefined {
  return SABOTAGE_STATIONS.find((s) => s.id === id);
}
