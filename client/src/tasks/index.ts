// Minigame registry and the shared frame (title, instruction line, close button, success and
// failure feedback). The UI's minigame overlay calls mountMinigame() and keeps the returned
// cleanup function; every listener, timer and animation frame a minigame registers goes
// through one Scope so cleanup is complete and safe to call twice.

import './tasks.css';
import { TASK_TITLES } from '../../../shared/map';
import type { FixKind, TaskKind } from '../../../shared/protocol';
import type { MinigameHost, MinigameTarget, SoundName } from '../context';
import { addLiquidity } from './addLiquidity';
import { bubblemap } from './bubblemap';
import { burnLP } from './burnLP';
import { connectSocials } from './connectSocials';
import { deleteBots } from './deleteBots';
import { fixDump } from './fixDump';
import { fixFud } from './fixFud';
import { fixRpc } from './fixRpc';
import { button, buzz, el, rand, restartClass, Scope, type MinigameCtx, type MinigameDef, type Tone } from './kit';
import { shillPost } from './shillPost';
import { snipeLaunch } from './snipeLaunch';
import { swapSol } from './swapSol';
import { syncNode } from './syncNode';
import { verifyCA } from './verifyCA';

type MinigameKind = TaskKind | FixKind;

const REGISTRY: Record<MinigameKind, MinigameDef> = {
  verifyCA,
  snipeLaunch,
  burnLP,
  shillPost,
  addLiquidity,
  bubblemap,
  connectSocials,
  deleteBots,
  swapSol,
  syncNode,
  fixDump,
  fixFud,
  fixRpc,
};

export const FIX_TITLES: Record<FixKind, string> = {
  fixDump: 'BUY WALL',
  fixFud: 'Kill the FUD',
  fixRpc: 'Reconnect RPC',
};

/** Success animation length before host.complete(). */
const WIN_DELAY_MS = 420;
/** Below this the container has no usable height of its own and we size the panel ourselves. */
const MIN_HOST_HEIGHT = 160;

const X_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function titleFor(target: MinigameTarget): string {
  if (target.type === 'fix') return FIX_TITLES[target.kind] ?? 'Fix';
  return TASK_TITLES[target.kind] ?? 'Task';
}

function winOverlay(label: string): HTMLElement {
  const wrap = el('div', 'tk-win');
  const burst = el('div', 'tk-win-burst');
  const n = 14;
  for (let i = 0; i < n; i++) {
    const s = el('span', `tk-win-spark${i % 3 === 0 ? ' is-gold' : ''}`);
    s.style.setProperty('--a', `${(i / n) * 360 + rand(-10, 10)}deg`);
    s.style.setProperty('--d', `${Math.round(rand(70, 135))}px`);
    s.style.setProperty('--delay', `${Math.round(rand(0, 70))}ms`);
    burst.append(s);
  }
  const badge = el('div', 'tk-win-badge');
  badge.innerHTML = CHECK_SVG;
  wrap.append(burst, badge, el('div', 'tk-win-label', label));
  return wrap;
}

/** True when the surrounding overlay already renders its own title bar and close button. */
function hostHasChrome(container: HTMLElement): boolean {
  const dialog = container.closest('[role="dialog"]');
  if (!dialog) return false;
  return Array.from(dialog.querySelectorAll('.mg-x, button[aria-label="Close"]')).some((b) => !container.contains(b));
}

export function mountMinigame(container: HTMLElement, target: MinigameTarget, host: MinigameHost): () => void {
  const scope = new Scope();
  const def = REGISTRY[target.kind as MinigameKind] as MinigameDef | undefined;

  const root = el('div', `tk tk--${target.type} tk-k-${target.kind}`);
  root.dataset.kind = target.kind;
  if (hostHasChrome(container)) root.classList.add('tk--embedded');
  if (container.clientHeight < MIN_HOST_HEIGHT) root.classList.add('tk--standalone');

  const head = el('div', 'tk-head');
  const titleEl = el('div', 'tk-title', titleFor(target));
  const closeBtn = button('tk-x');
  closeBtn.setAttribute('aria-label', 'Close minigame');
  closeBtn.title = 'Close';
  closeBtn.innerHTML = X_SVG;
  head.append(titleEl, closeBtn);
  const hintEl = el('div', 'tk-hint');
  hintEl.setAttribute('aria-live', 'polite');
  const stage = el('div', 'tk-stage');
  root.append(head, hintEl, stage);
  container.append(root);

  let won = false;
  let baseHint = '';
  let hintTimer = 0;

  const showHint = (text: string, tone: Tone | null): void => {
    hintEl.textContent = text;
    if (tone) hintEl.dataset.tone = tone;
    else delete hintEl.dataset.tone;
  };

  const sound = (name: SoundName): void => {
    try {
      host.sound(name);
    } catch (err) {
      console.warn('[tasks] sound failed', err);
    }
  };

  const ctx: MinigameCtx = {
    host,
    target,
    scope,
    stage,
    get won() {
      return won;
    },
    setHint(text) {
      baseHint = text;
      if (!hintTimer) showHint(text, won ? 'good' : null);
    },
    flash(text, tone = 'info', ms = 1500) {
      if (won && tone !== 'good') return;
      scope.clearTimeout(hintTimer);
      showHint(text, tone);
      restartClass(hintEl, 'is-flash');
      hintTimer = scope.timeout(() => {
        hintTimer = 0;
        if (!won) showHint(baseHint, null);
      }, ms);
    },
    sound,
    click() {
      sound('click');
    },
    fail(text, shake) {
      if (won) return;
      sound('error');
      buzz(35);
      restartClass(shake ?? stage, 'tk-shake');
      restartClass(root, 'tk--fail');
      if (text) ctx.flash(text, 'bad', 1700);
    },
    win(label) {
      if (won || scope.disposed) return;
      won = true;
      sound('taskDone');
      buzz(20);
      closeBtn.disabled = true;
      root.classList.add('tk--won');
      scope.clearTimeout(hintTimer);
      hintTimer = 0;
      showHint(label, 'good');
      stage.append(winOverlay(label));
      scope.timeout(() => host.complete(), WIN_DELAY_MS);
    },
  };

  scope.on(closeBtn, 'click', () => {
    if (!won) host.close();
  });
  // Without the overlay's own chrome nobody else handles Escape.
  if (!root.classList.contains('tk--embedded')) {
    scope.on<KeyboardEvent>(window, 'keydown', (e) => {
      if (e.key === 'Escape' && !won) host.close();
    });
  }
  // Long-press menus and text selection only get in the way of drags and holds.
  scope.on(root, 'contextmenu', (e) => e.preventDefault());
  scope.on(root, 'dragstart', (e) => e.preventDefault());

  if (!def) {
    ctx.setHint('This console is offline. Try another one.');
    stage.append(el('div', 'tk-offline', 'CONSOLE OFFLINE'));
  } else {
    ctx.setHint(def.hint);
    try {
      def.mount(ctx);
    } catch (err) {
      scope.dispose();
      root.remove();
      throw err;
    }
  }

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    scope.dispose();
    // The DOM stays in place so the overlay can fade it out; it just stops reacting.
    root.classList.add('tk--disposed');
  };
}
