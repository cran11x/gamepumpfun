// Strict shape validation for client -> server messages. Never trust the client: every field is
// type- and range-checked, and the result is a fresh object holding only the known fields.

import { PLAYER_COLORS, type GameSettings } from '../../shared/constants';
import type { C2S, SabotageKind } from '../../shared/protocol';

/** Raw length caps (sanitizers trim further). */
const MAX_RAW_NAME = 256;
const MAX_RAW_CHAT = 2048;
const MAX_TOKEN = 2048;
const MAX_ID = 64;
const MAX_CODE = 16;
/** Positions far outside the world are always garbage. */
const COORD_LIMIT = 100_000;

const SABOTAGE_KINDS: ReadonlySet<string> = new Set<SabotageKind>(['devDump', 'fud', 'rpcDown']);
const FIX_ACTIONS: ReadonlySet<string> = new Set(['holdStart', 'holdEnd', 'done']);

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}

function id(v: unknown): string | null {
  const s = str(v, MAX_ID);
  return s !== null && s.length > 0 ? s : null;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Optional auth token: anything other than a sane string is treated as "not signed in". */
function token(v: unknown): string | undefined {
  const s = str(v, MAX_TOKEN);
  return s !== null && s.length > 0 ? s : undefined;
}

function settingsPatch(v: unknown): Partial<GameSettings> | null {
  if (!isObj(v)) return null;
  const out: Partial<GameSettings> = {};
  const numKeys = [
    'ruggers',
    'killCooldown',
    'playerSpeed',
    'crewVision',
    'ruggerVision',
    'discussionTime',
    'votingTime',
    'tasksPerPlayer',
    'emergencyMeetings',
  ] as const;
  for (const k of numKeys) {
    const n = finite(v[k]);
    if (n !== null) out[k] = n;
  }
  if (typeof v.confirmEjects === 'boolean') out.confirmEjects = v.confirmEjects;
  if (typeof v.isPublic === 'boolean') out.isPublic = v.isPublic;
  return out;
}

/** Returns a validated copy of the message, or null if it is malformed. */
export function parseC2S(raw: unknown): C2S | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'create':
    case 'quick': {
      const name = str(raw.name ?? '', MAX_RAW_NAME);
      if (name === null) return null;
      const authToken = token(raw.authToken);
      const msg: Extract<C2S, { t: 'create' | 'quick' }> = authToken ? { t: raw.t, name, authToken } : { t: raw.t, name };
      // Only a literal `true` asks for ranked; anything else is a normal room.
      if (raw.ranked === true) msg.ranked = true;
      return msg;
    }
    case 'join': {
      const name = str(raw.name ?? '', MAX_RAW_NAME);
      const code = str(raw.code, MAX_CODE);
      if (name === null || code === null) return null;
      const authToken = token(raw.authToken);
      return authToken ? { t: 'join', code, name, authToken } : { t: 'join', code, name };
    }
    case 'rejoin': {
      const code = str(raw.code, MAX_CODE);
      const playerId = id(raw.playerId);
      const sessionKey = str(raw.sessionKey, 256);
      if (code === null || playerId === null || sessionKey === null) return null;
      return { t: 'rejoin', code, playerId, sessionKey };
    }
    case 'leave':
    case 'addBot':
    case 'removeBot':
    case 'start':
    case 'taskClose':
    case 'emergency':
    case 'backToLobby':
      return { t: raw.t };
    case 'setColor': {
      const c = finite(raw.color);
      if (c === null || !Number.isInteger(c) || c < 0 || c >= PLAYER_COLORS.length) return null;
      return { t: 'setColor', color: c };
    }
    case 'settings': {
      const settings = settingsPatch(raw.settings);
      return settings ? { t: 'settings', settings } : null;
    }
    case 'kick': {
      const playerId = id(raw.playerId);
      return playerId ? { t: 'kick', playerId } : null;
    }
    case 'move': {
      const x = finite(raw.x);
      const y = finite(raw.y);
      if (x === null || y === null) return null;
      if (Math.abs(x) > COORD_LIMIT || Math.abs(y) > COORD_LIMIT) return null;
      if (raw.facing !== 1 && raw.facing !== -1) return null;
      if (typeof raw.moving !== 'boolean') return null;
      return { t: 'move', x, y, facing: raw.facing, moving: raw.moving };
    }
    case 'taskOpen':
    case 'taskDone': {
      const stationId = id(raw.stationId);
      return stationId ? { t: raw.t, stationId } : null;
    }
    case 'kill': {
      const targetId = id(raw.targetId);
      return targetId ? { t: 'kill', targetId } : null;
    }
    case 'report': {
      const bodyId = id(raw.bodyId);
      return bodyId ? { t: 'report', bodyId } : null;
    }
    case 'vent': {
      if (raw.action === 'exit') return { t: 'vent', action: 'exit' };
      if (raw.action === 'enter' || raw.action === 'move') {
        const ventId = id(raw.ventId);
        return ventId ? { t: 'vent', action: raw.action, ventId } : null;
      }
      return null;
    }
    case 'sabotage': {
      if (typeof raw.kind !== 'string' || !SABOTAGE_KINDS.has(raw.kind)) return null;
      return { t: 'sabotage', kind: raw.kind as SabotageKind };
    }
    case 'fix': {
      const stationId = id(raw.stationId);
      if (!stationId || typeof raw.action !== 'string' || !FIX_ACTIONS.has(raw.action)) return null;
      return { t: 'fix', stationId, action: raw.action as 'holdStart' | 'holdEnd' | 'done' };
    }
    case 'chat': {
      const text = str(raw.text, MAX_RAW_CHAT);
      return text !== null ? { t: 'chat', text } : null;
    }
    case 'vote': {
      const target = id(raw.target);
      return target ? { t: 'vote', target } : null;
    }
    case 'ping': {
      const ts = finite(raw.ts);
      return ts !== null ? { t: 'ping', ts } : null;
    }
    default:
      return null;
  }
}
