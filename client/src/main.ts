// Entry point: builds the AppContext and wires modules together.

import './styles.css';
import { GAME_NAME, DEFAULT_TICKER } from '../../shared/constants';
import type { PublicConfig } from '../../shared/protocol';
import { fetchConfig } from './api';
import { createAudio } from './audio';
import type { AppContext } from './context';
import { createGame } from './game/index';
import { Net } from './net';
import { Store } from './store';
import { createUi } from './ui/index';
import { createWallet } from './wallet';

async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;

  const fallback: PublicConfig = {
    gameName: GAME_NAME,
    ticker: DEFAULT_TICKER,
    contractAddress: null,
    links: {},
    burn: { mode: 'off', cluster: 'mainnet-beta', mint: null, decimals: 6, rankedEntryPrice: 0, priceMultiplier: 1 },
  };
  const config = await fetchConfig().catch(() => fallback);

  const net = new Net();
  const store = new Store(net);

  // Modules receive the full context; fields are filled before any of them run user-facing logic.
  const ctx = { net, store, config } as AppContext;
  ctx.audio = createAudio();
  ctx.wallet = createWallet();
  ctx.game = createGame(canvas, ctx);
  ctx.ui = createUi(uiRoot, ctx);

  net.connect();
}

void boot();
