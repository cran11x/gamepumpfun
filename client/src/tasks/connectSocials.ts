// connectSocials: four plugs on the left (X, TG, WEB, CHART) and the matching sockets shuffled on
// the right. Drag a wire from a plug to its socket (either direction works). Wrong socket: the
// wire flashes red and snaps back. Wires are SVG curves recomputed on resize.

import { el, onDrag, pick, restartClass, shuffle, svgEl, type MinigameCtx, type MinigameDef } from './kit';

type SocialId = 'x' | 'tg' | 'web' | 'chart';

interface Social {
  id: SocialId;
  label: string;
  color: string;
  icon: string;
}

const SOCIALS: Social[] = [
  {
    id: 'x',
    label: 'X',
    color: '#e8eef5',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4l14 16M19 4L5 20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  },
  {
    id: 'tg',
    label: 'TG',
    color: '#2f8cff',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 3.5L2.8 10.8c-.9.4-.9 1.6.1 1.9l4.6 1.5 1.8 5.6c.3.8 1.3 1 1.9.4l2.6-2.5 4.8 3.5c.7.5 1.7.1 1.9-.8L23 4.9c.2-1-.6-1.8-1.5-1.4zM9.6 14.3l8.6-7.1-6.6 8.4-.3 3-1.7-4.3z" fill="currentColor"/></svg>',
  },
  {
    id: 'web',
    label: 'WEB',
    color: '#2bff88',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.2 3.4 3.2 14.6 0 18M12 3c-3.2 3.4-3.2 14.6 0 18"/></g></svg>',
  },
  {
    id: 'chart',
    label: 'CHART',
    color: '#ffd400',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3.5" y="10" width="3.2" height="7" rx=".6"/><path d="M5.1 7v3M5.1 17v3"/><rect x="10.4" y="5" width="3.2" height="8" rx=".6"/><path d="M12 2.5V5M12 13v4"/><rect x="17.3" y="9" width="3.2" height="6" rx=".6"/><path d="M18.9 6v3M18.9 15v4"/></g></svg>',
  },
];

const WRONG_LINES = ['Wrong socket! That link goes to a scam site.', 'Mismatch. TG goes to TG, ser.', 'Nope. Fake socials = instant FUD.'];

interface Node {
  social: Social;
  side: 'l' | 'r';
  el: HTMLElement;
  port: HTMLElement;
  done: boolean;
}

export const connectSocials: MinigameDef = {
  hint: 'Drag a wire from each social to its matching socket.',
  mount(ctx: MinigameCtx) {
    const { scope, stage } = ctx;

    const wrap = el('div', 'tk-soc');
    const wires = svgEl('svg', { class: 'tk-soc-wires', 'aria-hidden': 'true' });
    const colL = el('div', 'tk-soc-col tk-soc-col--l');
    const colR = el('div', 'tk-soc-col tk-soc-col--r');
    const mid = el('div', 'tk-soc-mid');
    mid.append(el('span', 'tk-soc-mid-title', 'LINKTREE'), el('span', 'tk-soc-mid-count', '0/4'));
    wrap.append(wires, colL, mid, colR);
    stage.append(wrap);
    const countEl = mid.lastElementChild as HTMLElement;

    const makeNode = (social: Social, side: 'l' | 'r'): Node => {
      const node = el('div', `tk-soc-node tk-soc-node--${side}`);
      node.style.setProperty('--c', social.color);
      node.setAttribute('role', 'button');
      node.setAttribute('aria-label', `${social.label} ${side === 'l' ? 'link' : 'socket'}`);
      const ico = el('span', 'tk-soc-icon');
      ico.innerHTML = social.icon;
      const port = el('span', 'tk-soc-port');
      const label = el('span', 'tk-soc-label', social.label);
      if (side === 'l') node.append(ico, label, port);
      else node.append(port, ico, label);
      return { social, side, el: node, port, done: false };
    };

    const left = SOCIALS.map((s) => makeNode(s, 'l'));
    let order = shuffle(SOCIALS);
    for (let i = 0; i < 10 && order.every((s, k) => s.id === SOCIALS[k].id); i++) order = shuffle(SOCIALS);
    const right = order.map((s) => makeNode(s, 'r'));
    left.forEach((n) => colL.append(n.el));
    right.forEach((n) => colR.append(n.el));

    const locked: Array<{ a: Node; b: Node; path: SVGPathElement }> = [];

    const portPoint = (n: Node): { x: number; y: number } => {
      const wr = wrap.getBoundingClientRect();
      const pr = n.port.getBoundingClientRect();
      return { x: pr.left + pr.width / 2 - wr.left, y: pr.top + pr.height / 2 - wr.top };
    };
    const local = (e: PointerEvent): { x: number; y: number } => {
      const wr = wrap.getBoundingClientRect();
      return { x: e.clientX - wr.left, y: e.clientY - wr.top };
    };
    /** Cubic curve leaving `a` horizontally toward the other column. */
    const curve = (a: { x: number; y: number }, b: { x: number; y: number }, fromSide: 'l' | 'r'): string => {
      const c = Math.max(30, Math.abs(b.x - a.x) * 0.45);
      const s = fromSide === 'l' ? 1 : -1;
      return `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${(a.x + c * s).toFixed(1)},${a.y.toFixed(1)} ${(b.x - c * s).toFixed(1)},${b.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    };
    const redrawLocked = (): void => {
      for (const l of locked) l.path.setAttribute('d', curve(portPoint(l.a), portPoint(l.b), 'l'));
    };
    scope.observeSize(wrap, redrawLocked);

    /** The opposite-side node under (or very near) the pointer. */
    const nodeAt = (e: PointerEvent, side: 'l' | 'r'): Node | null => {
      const list = side === 'l' ? left : right;
      const pad = e.pointerType === 'touch' ? 18 : 10;
      for (const n of list) {
        const r = n.el.getBoundingClientRect();
        if (e.clientX >= r.left - pad && e.clientX <= r.right + pad && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad) return n;
      }
      return null;
    };

    let connected = 0;

    const attach = (from: Node): void => {
      const other: 'l' | 'r' = from.side === 'l' ? 'r' : 'l';
      let path: SVGPathElement | null = null;
      let hover: Node | null = null;
      const setHover = (n: Node | null): void => {
        if (n === hover) return;
        hover?.el.classList.remove('is-target');
        hover = n && !n.done ? n : null;
        hover?.el.classList.add('is-target');
      };
      onDrag(scope, from.el, {
        start(e) {
          if (from.done || ctx.won) return false;
          path = svgEl('path', { class: 'tk-soc-wire is-live', stroke: from.social.color });
          wires.append(path);
          path.setAttribute('d', curve(portPoint(from), local(e), from.side));
          from.el.classList.add('is-active');
          wrap.classList.add('is-dragging');
        },
        move(e) {
          if (!path) return;
          const target = nodeAt(e, other);
          setHover(target);
          // Snap the wire end onto a hovered socket for a tactile feel.
          const end = hover ? portPoint(hover) : local(e);
          path.setAttribute('d', curve(portPoint(from), end, from.side));
        },
        end(e, cancelled) {
          from.el.classList.remove('is-active');
          wrap.classList.remove('is-dragging');
          const target = cancelled ? null : nodeAt(e, other);
          setHover(null);
          const p = path;
          path = null;
          if (!p) return;
          if (!target || target.done) {
            p.remove();
            return;
          }
          if (target.social.id === from.social.id) {
            const a = from.side === 'l' ? from : target;
            const b = from.side === 'l' ? target : from;
            a.done = true;
            b.done = true;
            a.el.classList.add('is-done');
            b.el.classList.add('is-done');
            p.classList.remove('is-live');
            p.classList.add('is-locked');
            p.setAttribute('d', curve(portPoint(a), portPoint(b), 'l'));
            locked.push({ a, b, path: p });
            restartClass(b.el, 'is-zap');
            connected++;
            countEl.textContent = `${connected}/4`;
            if (connected >= SOCIALS.length) {
              ctx.win('SOCIALS LINKED');
            } else {
              ctx.click();
              ctx.flash(`${a.social.label} linked. ${connected}/4`, 'good', 900);
            }
          } else {
            p.classList.remove('is-live');
            p.classList.add('is-wrong');
            p.setAttribute('d', curve(portPoint(from), portPoint(target), from.side));
            ctx.fail(pick(WRONG_LINES), target.el);
            scope.timeout(() => p.remove(), 380);
          }
        },
      });
    };
    left.forEach(attach);
    right.forEach(attach);
  },
};
