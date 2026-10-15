# AMONG RUGS

A social deduction game from the trenches, played in the browser. 4 to 10 players share a station. Most of them are **Holders**, pumping the bonding curve to 100%. A few are secretly **Ruggers**, rugging holders one by one. Call an **X SPACES** meeting, argue, and blacklist the rugger before it's too late.

- Multiplayer in real time from one link (`/?room=CODE`), with an authoritative Node server.
- Bots fill empty seats, so you can play solo or with 2 friends.
- Optional **Phantom** sign-in. Signing in only signs a message, never a transaction. The wallet is linked to a public leaderboard: Most Honest Devs, Top Ruggers and others.
- **Ranked** and the **Shop** (when `TOKEN_MINT` is set): players burn the project's SPL token for a ranked ticket (default 50,000 per game) or for looks (pill skins, rug patterns, name effects). Burned tokens are destroyed with SPL `BurnChecked`; nobody receives them and there is no pot. Ranked rooms are humans only with standard settings, and feed a weekly leaderboard (resets Monday 00:00 UTC). Cosmetics are looks only. Playing stays free.
- Works on desktop and mobile, with a touch joystick on phones.

## Gameplay

| | Holders | Ruggers |
|---|---|---|
| Goal | Bonding curve to 100% (GRADUATED), or blacklist every rugger | Rug holders until ruggers ≥ holders, or let a DEV DUMP run out |
| Actions | Tasks (10 minigames), report rugged bags, call X SPACES, fix sabotage | Rug (cooldown), travel through bridges, sabotage, fake tasks |

**Sabotage**
- **DEV DUMP:** two BUY WALLs, in the Trading Floor and the Dev Vault, must be held at the same moment before the timer ends.
- **FUD:** holders' vision shrinks.
- **RPC DOWN:** the task list and the bonding curve are hidden.

**Keys:** WASD/arrows to move, E/Space to use, Q to rug, R to report, V for the bridge, M for the map. On phones, use the joystick and the on-screen buttons.

## Run it

```bash
npm install
npm run dev          # server :8787 + Vite :5173 (open http://localhost:5173)
```

Production, a single process that serves the client and the WebSocket:

```bash
npm run build
PORT=8787 npm start  # open http://localhost:8787
```

Checks:

```bash
npm run typecheck
npm test             # vitest: rules, bots, auth, store, map, burns (live mode against mocked RPC)
npm run build && npm run e2e   # Playwright: e2e/smoke.mjs (3 browsers + bots play a full game) then
                               # e2e/ranked.mjs (BURN_MODE=mock: 4 wallets burn for looks and tickets,
                               # play a ranked game, check the weekly board). About 3-4 min in total.
npm run e2e:smoke / npm run e2e:ranked   # one suite
```

**Real on-chain burns.** `e2e/chain-burn.mjs` runs the live burn flow against a real Solana runtime:
1. It signs in, burns for a ranked ticket and a cosmetic through the API, and sends the server-built transactions.
2. It checks that the token balance and the **supply** drop by exactly the price.
3. It checks the grants, replay rejection and idempotent confirms.

It works with a local `solana-test-validator` (no faucet limits) or devnet, for both classic SPL Token and Token-2022 mints. The usage is at the top of the file. Last run: 11/11 checks passed for both token programs.

## Configuration (env)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP + WebSocket port |
| `DATA_DIR` | `./data` | Where profiles and the leaderboard are stored (`db.json`) |
| `GAME_NAME` | `AMONG RUGS` | Display name |
| `TICKER` | `$RUGS` | Your coin's ticker, shown in the UI and used in minigames |
| `CONTRACT_ADDRESS` | unset | Your coin's CA. It is shown with a copy button, and the "Verify the CA" task uses it, so players learn the real CA |
| `LINK_X`, `LINK_TELEGRAM`, `LINK_PUMPFUN` | unset | Links on the home screen (https only) |
| `PUBLIC_ORIGIN` | unset | Public origin (e.g. `https://amongrugs.fun`) that the Phantom login message is bound to. A comma-separated list allows several (e.g. `https://amongrugs.fun,https://www.amongrugs.fun`). Set it in production: unset, the message follows the request's Host header |
| `TRUST_PROXY` | unset | Set it when the server runs behind a reverse proxy, so the per-IP limits use the real client IP |
| `MAX_SOCKETS_PER_IP` | `64` | Concurrent WebSocket connections allowed per client IP |
| `TOKEN_MINT` | unset | SPL mint of your coin. Unset: burns are off and Ranked and the Shop are hidden |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | RPC for live burns (use a dedicated one, e.g. Helius). Never sent to clients or logged |
| `SOLANA_CLUSTER` | `mainnet-beta` | `mainnet-beta` or `devnet` (explorer links) |
| `BURN_MODE` | unset | `mock` fakes burns for local testing and e2e (the server refuses to start with it when `NODE_ENV=production` or when `TOKEN_MINT` is set; its data goes to `db.mock.json`, never `db.json`); `off` disables burns |
| `RANKED_ENTRY_PRICE` | `50000` | Whole tokens burned for one ranked ticket |
| `COSMETIC_PRICE_MULTIPLIER` | `1` | Multiplies every shop price |

## Deploy

The game server keeps live WebSocket connections and in-memory rooms. It needs a host that runs a long-lived Node process, such as Railway, Fly.io, Render or a VPS. Serverless platforms like Vercel functions won't work.

```bash
docker build -t among-rugs .
docker run -p 8787:8787 -v $(pwd)/data:/data -e TICKER='$RUGS' among-rugs
```

Mount a volume at `/data` so the leaderboard survives restarts. Run a single instance: rooms live in memory.

## Project layout

```
shared/      protocol (wire types), constants, map + geometry (shared by client and server)
server/      express + ws server, room state machine, bots, Phantom auth, JSON store
client/      Vite app: canvas renderer (client/src/render), game loop (game), DOM UI (ui), minigames (tasks)
tests/       vitest unit tests
e2e/         Playwright suites: smoke.mjs (a full game with bots), ranked.mjs (burns, shop, ranked), lib.mjs (shared harness)
docs/SPEC.md rules and module contract
```

## Notes

- "AMONG RUGS" is a parody working title. Before a public launch, consider whether you want a name further from the game it parodies. Change `GAME_NAME` in `shared/constants.ts` (or the env var) to rebrand.
- No money is paid to anyone through the game. Burns only destroy tokens (no pot, no prizes from burns), and the server verifies every burn on-chain itself; the client is never trusted about amounts. The only transaction the app ever asks Phantom to sign is the BurnChecked + Memo the server built, and the client checks it before Phantom opens. Rewards from creator fees, if you add them later, should not require paying to enter.
