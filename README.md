# AMONG RUGS

A social deduction game from the trenches, played in the browser. 4 to 10 players share a station. Most of them are **Holders**, pumping the bonding curve to 100%. A few are secretly **Ruggers**, rugging holders one by one. Call an **X SPACES** meeting, argue, and blacklist the rugger before it's too late.

- Multiplayer in real time from one link (`/?room=CODE`), with an authoritative Node server.
- Bots fill empty seats, so you can play solo or with 2 friends.
- Optional **Phantom** sign-in. It only signs a message and never requests a transaction. The wallet is linked to a public leaderboard: Most Honest Devs, Top Ruggers and others.
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
npm test             # vitest: rules, bots, auth, store, map
npm run build && npm run e2e   # Playwright smoke test: 3 browsers + bots play a full game (~1-2 min)
```

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
| `MAX_SOCKETS_PER_IP` | `20` | Concurrent WebSocket connections allowed per client IP |

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
e2e/         Playwright multiplayer smoke test
docs/SPEC.md rules and module contract
```

## Notes

- "AMONG RUGS" is a parody working title. Before a public launch, consider whether you want a name further from the game it parodies. Change `GAME_NAME` in `shared/constants.ts` (or the env var) to rebrand.
- No real money moves through the game. Rewards from creator fees, if you add them later, should not require paying to enter.
