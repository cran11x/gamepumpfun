// deleteBots: a coin's comment feed with 5 bot spam comments mixed in with real holders. Tap each
// bot comment to delete it; tapping a real holder flashes red. Avatars look the same for
// everyone: the tell is what they say.

import { button, el, pick, randInt, restartClass, shuffle, type MinigameCtx, type MinigameDef } from './kit';

const BOTS = 5;
const REALS = 4;

const SPAM = [
  '🚀🚀 100x gem, dm for alpha',
  'send 1 SOL get 2 back',
  'airdrop live claim now',
  '🎁 free SOL giveaway, link in bio',
  'connect wallet to claim your 🎁',
  'vip pump group, dm me 👉',
  'I made 400 SOL with this bot 🤖',
  'next 1000x loading… dm me',
  'support team here, dm your seed phrase',
  '💎 presale live, last 10 spots',
  'whitelist open!! click my profile',
];

const REAL = [
  'chart looking healthy',
  "who's the dev",
  'bought the dip',
  'gm',
  'holding till graduation',
  'this community is cooking',
  'devs on spaces tonight?',
  'nice candle ngl',
  'curve past 60% already',
  'gm frens, wagmi',
  'took profits, still holding a bag',
];

const BOT_NAMES = ['airdrop_claim_x', 'alpha_dm_777', 'free_sol_drop', 'x1000gems_', 'vip_pump_room', 'wallet_support24', 'mev_profit_ai', 'giveaway_bot_3', 'presale_king_'];
const REAL_NAMES = ['chartenjoyer', 'bagholder_bob', 'degen_sam', 'gm_frog', 'curve_watcher', 'dipbuyer', 'sol_sister', 'anon_trader', 'diamond_dan'];

const AVATAR_COLORS = ['#2bff88', '#22e5ff', '#9945ff', '#ff4fd8', '#ffd400', '#ff9f1c', '#2f8cff', '#b6ff3b', '#e8eef5'];

const WRONG_LINES = ['That was a real holder! Be nice to the community.', 'Real comment. Mods, please.', "Don't ban the believers, ser."];
const DELETE_LINES = ['Bot nuked.', 'Spam gone.', 'Banned. Bye bot.', 'Cleaned.'];

interface Comment {
  bot: boolean;
  name: string;
  text: string;
}

export const deleteBots: MinigameDef = {
  hint: 'Tap every bot comment to delete it. Leave the real holders.',
  mount(ctx: MinigameCtx) {
    const { scope, stage } = ctx;

    const spam = shuffle(SPAM).slice(0, BOTS);
    const botNames = shuffle(BOT_NAMES);
    const real = shuffle(REAL).slice(0, REALS);
    const realNames = shuffle(REAL_NAMES);
    let comments: Comment[] = [
      ...spam.map((text, i) => ({ bot: true, name: botNames[i], text })),
      ...real.map((text, i) => ({ bot: false, name: realNames[i], text })),
    ];
    comments = shuffle(comments);

    const wrap = el('div', 'tk-feed');
    const head = el('div', 'tk-feed-head');
    head.append(el('span', 'tk-feed-title', `COMMENTS · ${comments.length}`));
    const left = el('span', 'tk-feed-left', `BOTS LEFT ${BOTS}`);
    head.append(left);
    const list = el('div', 'tk-feed-list');
    wrap.append(head, list);
    stage.append(wrap);

    const rows = new Map<HTMLButtonElement, Comment>();
    let minutes = randInt(1, 3);
    comments.forEach((c, i) => {
      const row = button('tk-cm');
      row.style.setProperty('--i', String(i));
      const av = el('span', 'tk-cm-av', c.name.replace(/[^a-z]/gi, '').charAt(0).toUpperCase() || '?');
      av.style.setProperty('--c', pick(AVATAR_COLORS));
      const body = el('span', 'tk-cm-body');
      const meta = el('span', 'tk-cm-meta');
      meta.append(el('span', 'tk-cm-name', c.name), el('span', 'tk-cm-time', `${minutes}m`));
      body.append(meta, el('span', 'tk-cm-text', c.text));
      const likes = el('span', 'tk-cm-like', `♥ ${c.bot ? randInt(0, 3) : randInt(1, 42)}`);
      row.append(av, body, likes);
      row.setAttribute('aria-label', `${c.name}: ${c.text}`);
      rows.set(row, c);
      list.append(row);
      minutes += randInt(0, 3);
    });

    let remaining = BOTS;
    const gone = new Set<HTMLButtonElement>();

    scope.on<MouseEvent>(list, 'click', (e) => {
      if (ctx.won) return;
      const row = (e.target as Element | null)?.closest('.tk-cm');
      if (!(row instanceof HTMLButtonElement) || gone.has(row)) return;
      const c = rows.get(row);
      if (!c) return;
      if (c.bot) {
        gone.add(row);
        row.disabled = true;
        row.classList.add('is-del');
        scope.timeout(() => row.classList.add('is-gone'), 320);
        remaining--;
        left.textContent = remaining > 0 ? `BOTS LEFT ${remaining}` : 'FEED CLEAN';
        restartClass(left, 'is-bump');
        if (remaining <= 0) {
          left.classList.add('is-clean');
          ctx.win('FEED CLEAN');
        } else {
          ctx.click();
          ctx.flash(`${pick(DELETE_LINES)} ${remaining} to go.`, 'good', 900);
        }
      } else {
        row.classList.add('is-wrong');
        scope.timeout(() => row.classList.remove('is-wrong'), 500);
        ctx.fail(pick(WRONG_LINES), row);
      }
    });
  },
};
