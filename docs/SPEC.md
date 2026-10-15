# AMONG RUGS: game spec and build contract

A real-time multiplayer social deduction game in the browser, themed on the pump.fun / Solana trenches.
4–10 players share one station, **THE TRENCHES HQ**. Most of them are **Holders** and a few are secretly **Ruggers**.
Holders complete tasks that pump the shared **bonding curve** to 100%, which means the coin **GRADUATES**.
Ruggers secretly **rug** (eliminate) holders, travel through **bridges** (vents) and **sabotage** the station.
Anyone can call an emergency **X SPACES** meeting to discuss and vote someone off. A voted-off player is **BLACKLISTED**.

This file is the source of truth for rules and module boundaries. These files define the shared contract and must not be renamed:
- `shared/constants.ts`: tuning numbers and settings.
- `shared/protocol.ts`: every network message and view type.
- `shared/map.ts`: rooms, halls, props, task stations, vents, sabotage stations, spawn points, grid.
- `shared/geometry.ts`: collision, line of sight, vision polygon, A* pathfinding.
- `client/src/context.ts`: the client cross-module APIs.
- `client/src/net.ts` and `client/src/store.ts`: the client network layer and state store.

## Glossary (use these words in UI text)

| Classic social-deduction term | Here |
|---|---|
| Crewmate | **Holder** |
| Impostor | **Rugger** |
| Kill | **Rug** ("X got rugged") |
| Dead body | **Rugged bag**: a cracked pill lying flat with a red "-99%" sticker |
| Ghost | **Ghost** (rugged holders keep doing tasks as ghosts) |
| Vent | **Bridge** (cross-chain bridge hatch) |
| Emergency meeting / button | **X SPACES**: the big SPACES button on the Launchpad table |
| Ejected | **Blacklisted** |
| Task bar | **Bonding curve** (0–100%); 100% = **GRADUATED** |
| Reactor (critical sabotage) | **DEV DUMP**: two BUY WALL consoles (Trading Floor + Dev Vault) must be held at the same time before the timer ends |
| Lights | **FUD**: holders' vision shrinks; fix at the Telegram HQ console |
| Comms | **RPC DOWN**: holders can't see their task list or the bonding curve; fix at the RPC Node console |

Avoid slurs. Never use the word "jeet". Keep jokes about trench culture, not real people or projects.

## Characters and art direction

- **Characters are capsule pills**: a vertical rounded capsule. The top half is the player color and the bottom half is off-white. The pill has two big cartoon eyes (white with black pupils looking in the `facing` direction), two tiny stub legs that swing while moving, and a soft shadow.
  - Name label above, white. Fellow ruggers see rugger names in red.
  - Do NOT copy any existing game's character silhouette (no backpack + visor bean).
- **Rugged bag (body):** the pill snapped in half, lying sideways, X_X eyes, and a red "-99%" sticker.
- **Ghost:** a translucent pill with a little halo, bobbing, no legs.
- **Look:** dark neon "trading terminal".
  - Colors: background `#07090d`, floor `#10151d` with a subtle grid, walls `#1b2330` with a neon top edge tinted by the room accent, pump green `#2bff88`, rug red `#ff3b5c`, gold `#ffd400`.
  - Fonts: **Bungee** for titles and buttons, **Space Grotesk** for text, **JetBrains Mono** for numbers, CAs and timers. All three are loaded from Google Fonts in `client/index.html`.
- **Props are drawn procedurally**, with no image assets:
  - trading desks with tiny candle charts on their monitors
  - blinking server racks
  - an animated liquidity pool
  - a gold vault safe
  - a meme board
  - couches and a KOL ring light
  - a furnace with flames
  - plants
  - the SPACES table with a big red button
- **Sound:** synthesized with WebAudio (no files).

## Rules (server-authoritative)

### Rooms and lobby
- **Room code:** 4 letters from `ABCDEFGHJKLMNPQRSTUVWXYZ`.
- **Join link:** `/?room=CODE`.
- **Size:** max 10 players, bots included. Bots count as players for every rule.
- **Host:** the first player. If the host leaves, the oldest remaining human becomes host. Bots never host. A room with no humans is destroyed.
- **Host controls in the lobby:**
  - change settings, clamped to `SETTINGS_BOUNDS`
  - add or remove bots
  - kick a player
  - start, which needs `MIN_PLAYERS` (4) or more including bots
- **Colors:** unique per room. A player picks with `setColor`; taken colors are rejected. A joining player gets the first free color.
- **Names:** trimmed, control characters stripped, at most `MAX_NAME_LENGTH`, and an empty name becomes `anon`.
  - If the player is signed in (a valid `authToken` resolves to a Profile), use the profile name and set `wallet = shortAddress(address)`.
- **Quick play:** join the public lobby (`isPublic`, phase `lobby`, not full) that has the most players. If there is none, create a new public room.

### Start
- Effective ruggers = `min(settings.ruggers, maxRuggersFor(playerCount))`, assigned uniformly at random.
- Each holder gets `tasksPerPlayer` distinct task stations at random from `TASK_STATIONS`. Each rugger gets a fake list of the same size; the server never marks it done.
- Everyone is placed on `SPAWN_POINTS[slot]`, and `teleportSeq` is incremented.
- Phase `roleReveal` lasts `ROLE_REVEAL_MS`, then phase `playing` starts.
- At `playing` start: `killReadyAt = now + POST_MEETING_COOLDOWN_MS` and `sabotageReadyAt = now + POST_MEETING_COOLDOWN_MS`.

### Movement
- The client reports `move {x, y, facing, moving}` at about 20 Hz. The server accepts it only in `playing`, and only when the player is not in a bridge.
- **Validation:** each player has a movement budget in px, where `speed = BASE_SPEED * settings.playerSpeed` (times `GHOST_SPEED_MULT` for ghosts).
  - The budget refills at `speed * 1.5` per second, up to a cap of `speed * 1.5 * 1 s + 24px`. It is reset to `speed * 1.5 * 0.15 s + 24px` on every teleport, at `playing` start, on rejoin and on bridge exit, so the first step after a restart fits at any speed (ghosts included).
  - Reject the move if it is farther than the budget; an accepted move spends its distance. Sustained speed is therefore capped at 1.5x however often moves are sent, while a client that stalled for up to a second can still catch up.
  - For living players, also reject it if `!circleFree(x, y)` or the straight path from the last position crosses a solid cell.
  - Ghosts may be anywhere inside the world bounds.
  - On rejection, keep the old position and increment `teleportSeq` so the client snaps back.
- **Rate limit:** ignore moves that arrive faster than every 25 ms.

### Tasks
- **`taskOpen {stationId}`:** valid in `playing` when the station is in the player's list and not done, the player is within `USE_RANGE` of it, and the player is not in a bridge. Living players and ghosts can open tasks.
  - The server sets `activeStationId` and records `openedAt`.
  - Ruggers may open their fake tasks; it has no effect.
- **`taskDone {stationId}`:** accepted if all of these hold:
  - `activeStationId === stationId`
  - `now - openedAt >= TASK_MIN_MS[kind]`
  - the player is within `USE_RANGE * 1.5`
  - the player is a holder (alive or ghost)

  The server marks the task done, sends the `taskCompleted` event to that player only, and runs the win check.
- **`taskClose`:** clears `activeStationId`.
- **Bonding curve** = done holder tasks / total holder tasks. Tasks of players who were removed (disconnect grace expired) are excluded from both counts. During `rpcDown` the snapshot sends `taskProgress = -1` to holders.

### Rugging (kills)
- **`kill {targetId}`:** valid in `playing` when all of these hold:
  - the killer is a living rugger, not in a bridge, with `now >= killReadyAt`
  - the target is a living holder within `KILL_RANGE`
- **Effect:**
  - The target becomes a ghost (`alive = false`), and a body appears at the target's position.
  - The killer gets `killReadyAt = now + killCooldown * 1000`.
  - The `rugged` event goes to the killer, the victim and fellow ruggers.
  - The victim's open task is closed.
  - Run the win check.

### Reporting and X SPACES (meetings)
- **`report {bodyId}`:** a living player within `REPORT_RANGE` of a body, in `playing`.
- **`emergency`:** a living player within `EMERGENCY_RANGE` of `EMERGENCY_BUTTON` (reachable from every side of the table), with `emergencyLeft > 0`, and no `devDump` active. It decrements `emergencyLeft` (which starts at `settings.emergencyMeetings`).
- **Meeting start:**
  - phase `meeting`
  - clear all sabotage
  - close all minigames
  - eject everyone from bridges
  - remove all bodies
  - teleport living players to spawn points (`teleportSeq++`)
  - send the `bodyReported` or `emergencyCalled` event to all
- **Stages:**
  1. `discussion` for `discussionTime` s. If that is 0, skip straight to voting. Chat is allowed; voting is not.
  2. `voting` for `votingTime` s, which ends early once every living player has voted. Each living player votes once for a living player id or `'skip'`. Send the `votingOpened` event.
  3. `results` for `MEETING_RESULTS_MS`. The snapshot reveals `votes`, `ejectedId` and `tie`.
- **Tally:** count votes per target. Players who didn't vote don't count. If the top count is shared (a tie), or the top target is `'skip'`, nobody is ejected.
- **Then** phase `ejection` for `EJECTION_MS`:
  - The ejected player is set dead with no body.
  - `wasRugger` and `ruggersLeft` are sent only if `confirmEjects` (the remaining count would give the role away).
  - After that, run the win check. If the game isn't over, return to `playing` with `killReadyAt = now + killCooldown * 1000` and `sabotageReadyAt = now + POST_MEETING_COOLDOWN_MS`.

### Sabotage (ruggers, alive or dead)
- **`sabotage {kind}`:** valid in `playing` when no sabotage is active and `now >= sabotageReadyAt`. The cooldown is shared by all ruggers.
  - **`devDump`** (critical): `endsAt = now + DEV_DUMP_DURATION_MS`, stations `dump_a` and `dump_b`.
    - Living players send `fix {holdStart|holdEnd}` within `USE_RANGE`.
    - A holder is dropped from a station when they move farther than `USE_RANGE * 1.5`, die, or disconnect.
    - When both stations have at least 1 holder at the same time, it is fixed (checked on every `holdStart` and every tick).
    - If `endsAt` passes first, ruggers win with reason `devDump`. Expiry is checked every tick and before any gameplay message, so an action that arrives after `endsAt` (a report, a hold, a last task) is too late.
  - **`fud`:** station `fud_fix`. Holders' vision is multiplied by `FUD_VISION_MULT` (applied client-side). Fixed by `fix {done}` from a living player within range, after the fix minigame.
  - **`rpcDown`:** station `rpc_fix`. Holders get `taskProgress = -1`; the client hides the task list and the curve. Fixed like `fud`.
- **On fix:** send the `sabotageFixed` event and set `sabotageReadyAt = now + SABOTAGE_COOLDOWN_MS` for all ruggers.
- **On sabotage start:** send the `sabotageStarted` event to everyone.

### Bridges (vents)
- **`vent enter`:** a living rugger within `VENT_RANGE` of the vent, in `playing`. The player is placed at the vent position (`teleportSeq++`).
- **`vent move`:** only to a linked vent; the player is placed at the new vent (`teleportSeq++`).
- **`vent exit`:** the player stays at the vent position.
- **While in a bridge:** no kill, no tasks, and no movement messages are accepted. Non-ruggers don't receive the player in snapshots (see Snapshot visibility).

### Snapshot visibility
- **Living non-rugger viewer:** receives living players except vented ruggers. Never receives ghosts. `isRugger` is never set.
- **Living rugger viewer:** receives living players (vented fellow ruggers included, with `inVent`). Fellow ruggers get `isRugger: true`.
- **Interest management (phase `playing`, living viewers, bots included):** another living player qualifies when it is within the viewer's vision radius + 120 px and in line of sight (`lineOfSight` to its center or to any of 4 points `PLAYER_RADIUS` off it, so nobody pops at wall edges). The vision radius is `BASE_VISION * crewVision` for holders (times `FUD_VISION_MULT` during FUD, from 500 ms after it starts, while the client's fog closes in) and `BASE_VISION * ruggerVision` for ruggers. Fellow ruggers always receive each other.
  - Line of sight is tested from several viewer points, because the client draws from its predicted position, which leads the server's copy by about 2x one-way latency + 50..150 ms: the server position, points 120/240/360 ms ahead along the viewer's recent velocity (from its accepted moves, capped at its speed, walked with `moveWithCollision`), and 4 probes 64 px around it (also walked with collision, so they stop at walls).
  - A qualifying player is sent, and keeps being sent for 300 ms after it last qualified (hysteresis), so players rarely pop in late (measured: none over 50 ms up to 100 ms one-way latency in the pop-in simulations) and don't flicker at view edges. The hold is kept short because a modified client can read every player it is sent, around corners included.
  - A rugger inside a bridge is never sent to non-ruggers, with no hold: from the moment a rugger enters a bridge, no holder receives them, whether or not they were in view, so an honest holder's client never draws a rugger lingering on the hatch. A rugger who comes out is sent again as soon as they qualify, so a holder who can see the hatch gets them standing on it in the next snapshot (the client's "came out" hatch pop). A modified client can therefore infer a bridge entry when a rugger who was inside its interest margin, but not plainly visible, disappears at once instead of after the 300 ms hold.
- **Meetings:** living viewers receive every player for the meeting cards, ghosts included, but a ghost's position is replaced by its spawn point (`moving: false`).
- **Dead viewer (ghost):** receives everyone, including ghosts, with `isRugger` set for ruggers.
- **gameOver:** everyone receives everyone with `isRugger`.
- Bodies are visible to all. Other phases (`roleReveal`, `meeting`, `ejection`) are not vision-filtered. The client still applies fog of war and must not draw players outside its vision polygon.

### Chat
- **lobby:** anyone.
- **meeting:** living players post to `meeting`, which everyone sees. Dead players post to `ghost`, which only dead players see.
- **playing:** only ghosts can chat, on the `ghost` channel.
- **Limits:** messages longer than `MAX_CHAT_LENGTH` are cut, control characters are stripped, and empty messages are dropped. Rate limit is 1 message per `CHAT_RATE_LIMIT_MS` per player.
- **System messages:** `channel 'system'` for joins, leaves and game events.
- **Chat log:** each room keeps its last 100 lines. It is cleared at game start, and on `backToLobby` only lobby lines are kept. On join and rejoin the server replays it after `welcome` and before the snapshot (once per socket and seat), by visibility at replay time: lobby, system and meeting lines for everyone, ghost lines only for dead players. Replayed lines are identical to the live ones, so the client drops duplicates by (ts, fromId, channel, text).

### Win check (runs after kills, ejections, task completions and player removals)
1. All holders' tasks done (curve = 1) → **holders** win, reason `tasks`.
2. Living ruggers = 0 → **holders** win, reason `ruggersEjected`.
3. Living ruggers ≥ living holders → **ruggers** win, reason `parity`.
4. `devDump` timer expired → **ruggers** win, reason `devDump`.

On game over, call `recordGameResults` for wallet-linked players. The host can send `backToLobby` to reset to `lobby`, keeping players and colors and dropping disconnected ones.

### Disconnects and rejoin
- **On socket close:** mark the player `disconnected` and keep them for `RECONNECT_GRACE_MS`.
- **`rejoin {code, playerId, sessionKey}`** within the grace period restores the seat and sends `welcome` again, the chat backlog (see Chat) and a snapshot.
- **After the grace period:** remove the player. If they were alive in a game, treat them as dead with no body, and exclude their tasks from the curve. Run the win check.
- **Leaving the lobby:** removes the player immediately when they send `leave`.
- **Bad rejoin:** send `REJOIN_FAILED` with the same message whether the room is missing or the seat/key is wrong, so rejoin can't probe for private room codes.
- **Failed lookups:** at most 30 failed joins (a `join` to a code with no room) per client IP per minute. Past that, `join` gets `RATE_LIMITED` until the minute ends. `rejoin` is not limited: a failed rejoin always gets `REJOIN_FAILED` (so the client drops its stale session), and a rejoin with a valid seat key always works.

### Snapshots
- Per-client, see `Snapshot` in `protocol.ts`.
- Sent at `SERVER_TICK_HZ` in `playing`.
- In the other phases, sent on every state change and at least every 500 ms.

## Server modules and ownership

| File | Owner | Exports |
|---|---|---|
| `server/index.ts` | server-core | Starts express + ws on `PORT` (default 8787). Mounts `createApiRouter` at `/api`. Serves `dist/client` statically when present (SPA fallback to `index.html`). WebSocket path `/ws`, max payload 4 KB, per-socket rate limit, at most 64 concurrent sockets per client IP (`MAX_SOCKETS_PER_IP`; IPs keyed like the HTTP API, honoring `TRUST_PROXY`). A socket over the cap first gets `{t:'error', code:'RATE_LIMITED', message:'Too many connections from your network'}`, then is closed with 1008. |
| `server/rooms.ts` | server-core | `RoomManager`: create, join, quick, rejoin, cleanup, the 20 Hz tick loop, `getRoomsInfo()`. |
| `server/game.ts` (+ `server/game/*.ts`) | server-core | `Room` / game state machine with an injectable clock and send function so it is unit-testable without sockets. |
| `server/bots.ts` | bots | `BotBrain` (see below), `botName(i)`. |
| `server/config.ts` | wallet | `getPublicConfig(): PublicConfig` from env: `GAME_NAME`, `TICKER`, `CONTRACT_ADDRESS`, `LINK_X`, `LINK_TELEGRAM`, `LINK_PUMPFUN`. |
| `server/auth.ts` | wallet | Phantom signMessage login: nonces (5 min TTL, single use), ed25519 verification (tweetnacl + bs58), session tokens. `resolveAuthToken(token?: string): Profile \| null` (sync). |
| `server/store.ts` | wallet | JSON-file persistence in `DATA_DIR` (default `./data`), debounced atomic writes. `getProfile`, `upsertProfile`, `setProfileName`, `recordGameResults(results: GameResultRecord[])`, `getLeaderboard(sort, limit)`. |
| `server/api.ts` | wallet | `createApiRouter(deps: { getRoomsInfo(): { publicLobbies: number; playersOnline: number } }): express.Router` implementing the HTTP API listed at the bottom of `protocol.ts`. |

```ts
// server/store.ts
export interface GameResultRecord {
  address: string;      // full wallet address
  role: Role;
  won: boolean;
  rugs: number;         // kills this game
  tasksDone: number;
  correctVotes: number; // votes cast for a rugger who was ejected by that vote
  wasRugged: boolean;
}
export function recordGameResults(results: GameResultRecord[]): void;

// server/bots.ts
export interface BotBrainOptions {
  id: string;
  /** Send a client message as this bot (routed straight into the room). */
  send: (msg: C2S) => void;
  /** Deterministic per-bot seed. */
  seed: number;
}
export class BotBrain {
  constructor(opts: BotBrainOptions);
  onSnapshot(snap: Snapshot): void; // the room calls this with the bot's per-client snapshot every tick
  onChat(msg: ChatMessage): void;
  onEvent(event: GameEvent): void;
  /** Called every server tick (20 Hz) with server time. Bots send `move` etc. from here. */
  tick(now: number): void;
}
export function botName(index: number): string;
```

**Bot behavior.** Bots only use the protocol: they send the same C2S messages as humans.
- They respect movement speed and collision: follow `findPath` waypoints with `moveWithCollision`, at `BASE_SPEED * settings.playerSpeed`.
- They don't "see" through walls: use `canSee` with their vision radius.
- **Bot holder:** walks to its undone task stations. It opens a task and waits about `TASK_MIN_MS + 1–3 s` before sending done. It reports bodies it sees, and goes to fix stations during sabotage.
- **Bot rugger:**
  - fakes tasks
  - rugs a holder when the kill is ready and no other living player can see the spot
  - sometimes vents away
  - sabotages occasionally
- **In meetings:**
  - says short trench-flavored lines ("I was in the Meme Lab", "dev is sus", "trust me bro", "skip, no info")
  - votes for a player it saw rug someone, or saw near a body; otherwise mostly skips
  - a rugger bot never votes for a fellow rugger

## Client modules and ownership

The client is Vite + TypeScript, an HTML5 Canvas 2D world, and a DOM UI overlay. `client/src/main.ts` (already written) wires everything; read it.

| Path | Owner | Exports / responsibility |
|---|---|---|
| `client/src/game/**` | client-core | `createGame(canvas, ctx): GameApi`. Main loop (requestAnimationFrame) and local prediction: move with `moveWithCollision`, send `move` at `CLIENT_SEND_HZ`, snap on a `teleportSeq` change. Remote interpolation on a timeline anchored to snapshot arrival: `INTERP_DELAY_MS` behind the server time of the latest-arriving snapshots (not the latency-compensated `serverNow`, which runs past the newest snapshot at high latency). Keyboard input: WASD/arrows move; E/Space use; Q rug; R report; V bridge. `Interactions` every frame. Movement is frozen outside `playing`. |
| `client/src/render/**` | client-core | Camera and zoom (about 2.4 × BASE_VISION fits the shorter screen side, clamped to 0.5–1.6, DPR-aware). Static map pre-rendered to an offscreen canvas. Props, stations (your undone tasks glow yellow), bridges, the SPACES table, characters, bodies, ghosts, fog of war from `visibilityPolygon`, and room labels. Effects: rug slash, DEV DUMP red pulse with falling red candles, FUD darkness. Draw only players inside your vision. Ghosts see everything without fog. |
| `client/src/audio.ts` | client-core | `createAudio(): AudioApi`, WebAudio synth for every `SoundName`. Unlock audio on the first user gesture. |
| `client/src/ui/**` + `client/src/styles.css` | ui | `createUi(root, ctx): UiApi`. Covers every DOM screen and overlay (see below) and hosts minigames: `openMinigame` creates the overlay and calls `mountMinigame`. It sends `taskOpen`/`taskDone`/`taskClose` and `fix` messages, and calls `game.setInputBlocked`. It also covers the mobile joystick, toasts, and the full map (M). `styles.css` holds the base page styles: full-screen canvas, UI layer above it, fonts and the color tokens above. |
| `client/src/tasks/**` | tasks | `mountMinigame(container, target: MinigameTarget, host: MinigameHost): () => void` (the cleanup function). One module per TaskKind and FixKind, and its own CSS imported from `tasks/index.ts`. |
| `client/src/wallet.ts`, `client/src/api.ts` | wallet | `createWallet(): WalletApi`. `api.ts` exports `fetchConfig(): Promise<PublicConfig>`, `fetchLeaderboard(sort): Promise<LeaderboardEntry[]>` and `fetchRoomsInfo()`. Phantom only through `window.phantom?.solana`: `connect()` then `signMessage(utf8 bytes, 'utf8')`. NEVER request a transaction. The token is kept in localStorage. |

### UI screens (ui owner)
1. **Home**
   - logo, tagline and the ticker chip
   - CA with a copy button if configured, and links
   - name input, saved to localStorage
   - buttons: QUICK PLAY, CREATE ROOM, JOIN (with code input), CONNECT PHANTOM / signed-in chip, LEADERBOARD, HOW TO PLAY
   - `?room=CODE` prefills the code and focuses JOIN
2. **Lobby**
   - big room code with a "copy invite link" button
   - player list with pill avatars, plus host crown, bot and wallet badges
   - color picker (taken colors disabled)
   - host settings panel (every `GameSettings` field)
   - host buttons: add/remove bot, kick, START (disabled under 4 players, with a hint)
   - lobby chat and a LEAVE button
3. **Role reveal**
   - HOLDER, in green: "Pump the bonding curve to 100%. Find the rugger."
   - RUGGER, in red: "Rug them all. Don't get caught.", plus the list of fellow ruggers
4. **HUD** (phase `playing`)
   - **Top:** the bonding curve bar ("BONDING CURVE 42%", or "RPC DOWN" while hidden).
   - **Left:** task list with room names. Done tasks are struck through. Ruggers see "Fake tasks: blend in". Ghosts see "You got rugged. Finish your tasks as a ghost."
   - **Bottom-right buttons:** USE (label changes with the target: TASK / FIX / SPACES), REPORT, RUG (with a cooldown ring), SABOTAGE (opens a menu of 3, with cooldown), BRIDGE. Plus, while in a bridge, buttons to each linked bridge with its room name.
   - **Sabotage banner:** DEV DUMP is a red flashing countdown that says where the 2 BUY WALLs are. FUD and RPC DOWN are notices.
   - mute toggle and a map button
5. **Rugged cutscene** for the victim: a DOM overlay for about 2 s, "YOU GOT RUGGED", showing the killer's pill.
6. **X SPACES meeting**
   - header with the reason and caller, a timer, and the stage
   - player cards: color pill, name, dead state, VOTED stamp; click a card to vote, plus a SKIP button
   - meeting chat; ghosts get ghost chat
   - results stage shows voter dots per target
7. **Ejection:** the pill drifts off-screen along a red candle. Text: "X was the Rugger." / "X was not the Rugger." / "No one was blacklisted." plus "N Rugger(s) remain."
8. **Game over:** "GRADUATED: Holders win" or "RUGGED: Ruggers win", with the reason and every player's role. Buttons: BACK TO LOBBY (host only) and LEAVE.
9. **Leaderboard modal** (tabs per sort key) and **How to play modal**.
10. **Toasts** for errors (`store.onError`) and events.

**Desktop and mobile:**
- On touch devices: virtual joystick bottom-left, big action buttons bottom-right.
- Everything must work at 375×667 portrait and 1920×1080 landscape.
- UI text is English and short.

### Minigames (tasks owner)
Each minigame fits a centered panel of about 520×420 (full width on phones), works with mouse and touch, and has a close (X) button.

| Kind | Gameplay |
|---|---|
| `verifyCA` | The real CA is shown, with 4 poisoned look-alikes (same first/last 4 chars, swapped casing or swapped middle characters). Click the real one. A wrong click flashes red and reshuffles. |
| `snipeLaunch` | A marker bounces along a bar; tap when it's in the green zone. 2 hits needed. |
| `burnLP` | Drag 3 LP tokens into the furnace. |
| `shillPost` | Type a short shill line shown above ("gm. $TICKER is going to graduate. lfg"), in a tweet composer box. |
| `addLiquidity` | Hold a button to fill a pool. Release while the level is inside the target band; overfilling drains it. |
| `bubblemap` | Bubbles, one cluster linked (bundled). Click the bundled cluster. |
| `connectSocials` | 4 icons on the left (X, TG, Web, Chart) and shuffled matching sockets on the right. Drag lines to connect them all. |
| `deleteBots` | A comment feed with 5 bot comments (generic spam like "🚀🚀 100x gem dm me") among real ones. Tap each bot comment to delete it. |
| `swapSol` | Drag a slider to the exact target SOL amount (±0.05) and press SWAP. |
| `syncNode` | A progress bar fills over about 5.5 s while the panel is open ("Syncing slot 287,4xx,xxx…"), then auto-completes. |
| `fixDump` | A big BUY WALL hold pad: pointerdown → `host.holdStart()`, pointerup/leave → `host.holdEnd()`. It shows whether the other station is held, from `host.getSnapshot().sabotage`. It closes itself when the sabotage is fixed. |
| `fixFud` | 5 toggle switches in random states; turn all on (green). |
| `fixRpc` | Drag a frequency dial until the "signal" waveform lines up. |

Minigames complete only through `host.complete()`. The UI host enforces `TASK_MIN_MS` by delaying `taskDone` if needed.

## Commands
- `npm run dev`: server on 8787 (tsx watch) plus Vite on 5173, with `/ws` and `/api` proxied.
- `npm run build && npm start`: production on `PORT`, a single process serving the client and the WebSocket.
- `npm test`: vitest. `npm run typecheck`: tsc.
