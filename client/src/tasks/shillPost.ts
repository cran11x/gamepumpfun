// shillPost: type the shill line shown above into a tweet composer. Letters light up green as
// they match and red on a typo. Case, curly quotes and repeated spaces don't matter (phone
// keyboards autocapitalize). It posts itself on an exact match; POST / Enter also work.
// Paste is blocked: real shillers type.

import { button, el, normTicker, pick, restartClass, type MinigameCtx, type MinigameDef } from './kit';

function shillLines(tk: string): string[] {
  return [
    `gm. ${tk} is going to graduate. lfg`,
    `${tk} to the moon. lfg`,
    `just aped ${tk}. wagmi`,
    `${tk} dev is based. send it`,
    `${tk} curve is cooking. lfg`,
    `gm. ${tk} holders eat first`,
  ];
}

const TYPO_LINES = ['Typo! A shill with typos is FUD.', 'Fix it first. KOLs would never.', 'That is not the line, ser.'];

/** Lowercase, straight quotes, single spaces, no leading whitespace. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/^ /, '');
}

export const shillPost: MinigameDef = {
  hint: 'Type the shill exactly, then post it. No copy-paste, ser.',
  mount(ctx: MinigameCtx) {
    const { scope, stage, host } = ctx;
    const tk = normTicker(host.ticker);
    const lines = shillLines(tk);
    const line = Math.random() < 0.4 ? lines[0] : pick(lines);
    const want = normalize(line);

    const wrap = el('div', 'tk-shill');

    const brief = el('div', 'tk-shill-brief');
    brief.append(el('div', 'tk-shill-label', 'TODAY\'S SHILL'));
    const lineEl = el('div', 'tk-shill-line');
    const chars = Array.from(line).map((ch) => {
      const span = el('span', 'tk-shill-ch', ch);
      if (ch === ' ') span.classList.add('is-space');
      lineEl.append(span);
      return span;
    });
    const progress = el('div', 'tk-shill-progress');
    const progressFill = el('span', 'tk-shill-progress-fill');
    progress.append(progressFill);
    brief.append(lineEl, progress);

    const tweet = el('div', 'tk-tweet');
    const who = el('div', 'tk-tweet-who');
    const avatar = el('span', 'tk-avatar');
    avatar.append(el('span', 'tk-avatar-eye'), el('span', 'tk-avatar-eye'));
    const names = el('span', 'tk-tweet-names');
    names.append(el('span', 'tk-tweet-name', 'trench anon'), el('span', 'tk-tweet-handle', '@degen_anon · now'));
    who.append(avatar, names);

    const input = el('textarea', 'tk-tweet-input');
    input.rows = 2;
    input.maxLength = line.length + 24;
    input.placeholder = 'What\'s pumping?!';
    input.spellcheck = false;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('enterkeyhint', 'send');
    input.setAttribute('aria-label', `Type: ${line}`);

    const foot = el('div', 'tk-tweet-foot');
    const tools = el('span', 'tk-tweet-tools', '🖼  📊  😀  📍');
    const counter = el('span', 'tk-tweet-count', `0/${line.length}`);
    const post = button('tk-tweet-post', 'POST');
    foot.append(tools, counter, post);
    tweet.append(who, input, foot);

    wrap.append(brief, tweet);
    stage.append(wrap);

    let hadTypo = false;
    let posted = false;

    const matches = (): boolean => normalize(input.value).trimEnd() === want;

    const refresh = (): void => {
      const typed = normalize(input.value);
      let firstBad = -1;
      for (let i = 0; i < chars.length; i++) {
        const span = chars[i];
        const c = typed[i];
        const ok = c !== undefined && c === want[i];
        const bad = c !== undefined && !ok;
        if (bad && firstBad < 0) firstBad = i;
        span.classList.toggle('is-ok', ok && (firstBad < 0 || i < firstBad));
        span.classList.toggle('is-bad', bad || (c !== undefined && firstBad >= 0 && i > firstBad));
        span.classList.toggle('is-cur', i === typed.length);
      }
      const overflow = typed.trimEnd().length > want.length;
      const goodPrefix = firstBad < 0 ? Math.min(typed.length, want.length) : firstBad;
      progressFill.style.transform = `scaleX(${want.length ? goodPrefix / want.length : 0})`;
      counter.textContent = `${Math.min(typed.length, 999)}/${line.length}`;
      const typo = firstBad >= 0 || overflow;
      tweet.classList.toggle('has-typo', typo);
      if (typo && !hadTypo) {
        ctx.sound('error');
        restartClass(lineEl, 'tk-shake-sm');
        ctx.flash('Typo! Backspace it.', 'bad', 1200);
      }
      hadTypo = typo;
      const ready = matches();
      post.classList.toggle('is-ready', ready);
      tweet.classList.toggle('is-ready', ready);
      if (ready) submit();
    };

    const submit = (): void => {
      if (posted || ctx.won) return;
      if (!matches()) {
        ctx.fail(pick(TYPO_LINES), tweet);
        return;
      }
      posted = true;
      input.readOnly = true;
      tweet.classList.add('is-posted');
      // Drop the phone keyboard so the success animation is visible.
      input.blur();
      ctx.win('POSTED');
    };

    scope.on(input, 'input', refresh);
    scope.on<KeyboardEvent>(input, 'keydown', (e) => {
      // Keep game / UI hotkeys from seeing typed letters; Escape still closes the panel.
      if (e.key !== 'Escape') e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!e.repeat) submit();
      }
    });
    scope.on<KeyboardEvent>(input, 'keyup', (e) => {
      if (e.key !== 'Escape') e.stopPropagation();
    });
    const noPaste = (e: Event): void => {
      e.preventDefault();
      ctx.flash('No copy-paste. Real shillers type.', 'bad');
      ctx.sound('error');
    };
    scope.on(input, 'paste', noPaste);
    scope.on(input, 'drop', noPaste);
    scope.on<InputEvent>(input, 'beforeinput', (e) => {
      if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop' || e.inputType === 'insertFromYank') noPaste(e);
    });
    scope.on(post, 'click', () => {
      if (!ctx.won) submit();
    });
    // Tapping anywhere on the composer focuses the box.
    scope.on<PointerEvent>(tweet, 'pointerdown', (e) => {
      if (e.target !== input && e.target !== post && !ctx.won) {
        e.preventDefault();
        input.focus();
      }
    });
    scope.add(() => {
      if (document.activeElement === input) input.blur();
    });

    refresh();
    // Synchronous focus keeps us inside the opening tap, which lets mobile browsers raise the keyboard.
    try {
      input.focus();
    } catch {
      /* focus can fail in detached / hidden documents */
    }
  },
};
