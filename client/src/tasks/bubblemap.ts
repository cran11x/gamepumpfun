// bubblemap: a holder bubble map. Decoy groups sit close together but aren't linked; exactly one
// cluster is a bundle, every wallet wired to the others. Tap the bundle. Drawn in SVG, laid out
// to the stage's aspect ratio so bubbles stay finger-sized on phones.

import { clamp, el, pick, rand, randInt, restartClass, shuffle, svgEl, type MinigameCtx, type MinigameDef } from './kit';

interface Bubble {
  x: number;
  y: number;
  r: number;
  group: number; // -1 = lone wallet
  ph: number;
  w: number;
  node: SVGCircleElement;
  isLP?: boolean;
  label?: SVGTextElement;
}

interface Group {
  id: number;
  cx: number;
  cy: number;
  rad: number;
  bundle: boolean;
  color: string;
  g: SVGGElement;
  bubbles: Bubble[];
  links: Array<{ a: Bubble; b: Bubble; line: SVGLineElement }>;
}

const PALETTE = ['#2bff88', '#22e5ff', '#9945ff', '#ff4fd8', '#ffd400', '#ff9f1c', '#2f8cff', '#b6ff3b'];
const GROUP_RAD = 44;

const MISS_GROUP = ['Not linked. Just whales vibing.', 'Close together, but no links. Not a bundle.', 'Those wallets never touched. Keep looking.'];
const MISS_LONE = ['Solo holder. Probably a real one.', 'Lone wallet. Diamond hands, not a bundle.', 'Just a random holder.'];

export const bubblemap: MinigameDef = {
  hint: 'Find the bundle: the cluster where every wallet is linked. Tap it.',
  mount(ctx: MinigameCtx) {
    const { scope, stage } = ctx;

    const wrap = el('div', 'tk-bm');
    const mapBox = el('div', 'tk-bm-map');
    const legend = el('div', 'tk-bm-legend');
    wrap.append(mapBox, legend);
    stage.append(wrap);

    // Lay out in a coordinate space matching the box aspect so nothing gets letterboxed tiny.
    const bw = mapBox.clientWidth || 480;
    const bh = mapBox.clientHeight || 290;
    const W = Math.round(clamp(bw, 300, 520));
    const H = Math.round(clamp((W * bh) / bw, 220, 560));
    const margin = 26;

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', class: 'tk-bm-svg', role: 'img', 'aria-label': 'Bubble map of holders' });
    const gridG = svgEl('g', { class: 'tk-bm-grid' });
    for (let x = 40; x < W; x += 40) gridG.append(svgEl('line', { x1: x, y1: 0, x2: x, y2: H }));
    for (let y = 40; y < H; y += 40) gridG.append(svgEl('line', { x1: 0, y1: y, x2: W, y2: y }));
    const linkLayer = svgEl('g', { class: 'tk-bm-links' });
    const bubbleLayer = svgEl('g', { class: 'tk-bm-bubbles' });
    const labelLayer = svgEl('g', { class: 'tk-bm-labels' });
    svg.append(gridG, linkLayer, bubbleLayer, labelLayer);
    mapBox.append(svg);

    const all: Bubble[] = [];
    const groups: Group[] = [];
    const colors = shuffle(PALETTE);

    const fits = (x: number, y: number, r: number, gap: number): boolean => {
      if (x - r < margin * 0.6 || x + r > W - margin * 0.6 || y - r < margin * 0.6 || y + r > H - margin * 0.6) return false;
      return all.every((b) => Math.hypot(b.x - x, b.y - y) >= b.r + r + gap);
    };

    const addBubble = (x: number, y: number, r: number, group: number, color: string, parent: SVGGElement): Bubble => {
      const node = svgEl('circle', { cx: x, cy: y, r, class: 'tk-bm-bubble', fill: color, stroke: color });
      parent.append(node);
      const b: Bubble = { x, y, r, group, ph: rand(0, Math.PI * 2), w: rand(0.8, 1.6), node };
      all.push(b);
      return b;
    };

    // Group centers, spread out with rejection sampling (relaxing the spacing if needed).
    const groupCount = 1 + randInt(2, 3);
    const centers: Array<{ x: number; y: number }> = [];
    for (let minD = 150; centers.length < groupCount && minD >= 70; minD -= 15) {
      centers.length = 0;
      for (let tries = 0; tries < 400 && centers.length < groupCount; tries++) {
        const c = { x: rand(margin + GROUP_RAD, W - margin - GROUP_RAD), y: rand(margin + GROUP_RAD, H - margin - GROUP_RAD) };
        if (centers.every((o) => Math.hypot(o.x - c.x, o.y - c.y) >= minD)) centers.push(c);
      }
    }
    if (centers.length === 0) centers.push({ x: W / 2, y: H / 2 });
    const bundleIdx = randInt(0, centers.length - 1);

    centers.forEach((c, i) => {
      const bundle = i === bundleIdx;
      const color = colors[i % colors.length];
      const g = svgEl('g', { class: `tk-bm-group${bundle ? ' is-bundle' : ''}` });
      bubbleLayer.append(g);
      const group: Group = { id: i, cx: c.x, cy: c.y, rad: GROUP_RAD, bundle, color, g, bubbles: [], links: [] };
      const n = bundle ? randInt(5, 7) : randInt(3, 5);
      // The bundle hub (funding wallet) goes in the middle.
      if (bundle) group.bubbles.push(addBubble(c.x, c.y, rand(11, 14), i, color, g));
      for (let tries = 0; tries < 300 && group.bubbles.length < n; tries++) {
        const a = rand(0, Math.PI * 2);
        const d = rand(bundle ? 22 : 8, GROUP_RAD);
        const r = rand(7, bundle ? 11 : 14);
        const x = c.x + Math.cos(a) * d;
        const y = c.y + Math.sin(a) * d;
        if (fits(x, y, r, 4)) group.bubbles.push(addBubble(x, y, r, i, color, g));
      }
      groups.push(group);
    });

    const link = (group: Group, a: Bubble, b: Bubble): void => {
      const line = svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `tk-bm-link${group.bundle ? ' is-bundle' : ''}`, stroke: group.color });
      linkLayer.append(line);
      group.links.push({ a, b, line });
    };
    for (const group of groups) {
      if (group.bundle) {
        // Hub to everyone, plus a ring between neighbours: unmistakably one entity.
        const [hub, ...rest] = group.bubbles;
        rest.sort((p, q) => Math.atan2(p.y - hub.y, p.x - hub.x) - Math.atan2(q.y - hub.y, q.x - hub.x));
        rest.forEach((b) => link(group, hub, b));
        for (let k = 0; k < rest.length; k++) if (rest.length > 2 || k === 0) link(group, rest[k], rest[(k + 1) % rest.length]);
      }
    }

    // The LP: a big lone bubble.
    const loneG = svgEl('g', { class: 'tk-bm-lone' });
    bubbleLayer.append(loneG);
    for (let tries = 0; tries < 300; tries++) {
      const r = 22;
      const x = rand(margin + r, W - margin - r);
      const y = rand(margin + r, H - margin - r);
      if (fits(x, y, r, 14) && centers.every((c) => Math.hypot(c.x - x, c.y - y) > GROUP_RAD + r + 12)) {
        const lp = addBubble(x, y, r, -1, '#e8eef5', loneG);
        lp.isLP = true;
        lp.node.classList.add('is-lp');
        const t = svgEl('text', { x, y, class: 'tk-bm-lp-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        t.textContent = 'LP';
        labelLayer.append(t);
        lp.label = t;
        break;
      }
    }
    // Lone wallets.
    const lone = clamp(Math.round((W * H) / 12000) + randInt(-1, 2), 7, 14);
    for (let tries = 0, made = 0; tries < 600 && made < lone; tries++) {
      const r = rand(5, 11);
      const x = rand(margin, W - margin);
      const y = rand(margin, H - margin);
      if (!fits(x, y, r, 8)) continue;
      if (!centers.every((c) => Math.hypot(c.x - x, c.y - y) > GROUP_RAD + r + 14)) continue;
      addBubble(x, y, r, -1, pick(PALETTE), loneG);
      made++;
    }

    const bundle = groups.find((g) => g.bundle)!;
    const supply = randInt(24, 47);
    const holders = all.length + randInt(180, 900);
    const warn = el('span', 'tk-bm-stat tk-bm-stat--warn', 'BUNDLE DETECTED?');
    legend.append(el('span', 'tk-bm-stat', `HOLDERS ${holders.toLocaleString('en-US')}`), el('span', 'tk-bm-stat', `TOP 10 ${randInt(22, 38)}%`), warn);

    // Gentle float.
    const pos = (b: Bubble, t: number): { x: number; y: number } => ({
      x: b.x + Math.sin(t * b.w + b.ph) * 1.6,
      y: b.y + Math.cos(t * b.w * 0.8 + b.ph) * 1.6,
    });
    let time = 0;
    scope.loop((dt) => {
      time += dt;
      for (const b of all) {
        const p = pos(b, time);
        b.node.setAttribute('cx', p.x.toFixed(2));
        b.node.setAttribute('cy', p.y.toFixed(2));
        if (b.label) {
          b.label.setAttribute('x', p.x.toFixed(2));
          b.label.setAttribute('y', p.y.toFixed(2));
        }
      }
      for (const g of groups) {
        for (const l of g.links) {
          const a = pos(l.a, time);
          const b = pos(l.b, time);
          l.line.setAttribute('x1', a.x.toFixed(2));
          l.line.setAttribute('y1', a.y.toFixed(2));
          l.line.setAttribute('x2', b.x.toFixed(2));
          l.line.setAttribute('y2', b.y.toFixed(2));
        }
      }
    });

    const toLocal = (e: PointerEvent): { x: number; y: number } | null => {
      const m = svg.getScreenCTM();
      if (!m) return null;
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
      return { x: p.x, y: p.y };
    };

    const hitTest = (e: PointerEvent): { bubble: Bubble | null; inBundle: boolean } => {
      const p = toLocal(e);
      if (!p) return { bubble: null, inBundle: false };
      const slop = e.pointerType === 'touch' ? 14 : 7;
      let best: Bubble | null = null;
      let bestD = Infinity;
      for (const b of all) {
        const d = Math.hypot(b.x - p.x, b.y - p.y) - b.r;
        if (d < slop && d < bestD) {
          best = b;
          bestD = d;
        }
      }
      const inBundle = best ? best.group === bundle.id : Math.hypot(bundle.cx - p.x, bundle.cy - p.y) < bundle.rad + 8;
      return { bubble: best, inBundle };
    };

    let hoverGroup: Group | null = null;
    scope.on<PointerEvent>(svg, 'pointermove', (e) => {
      if (e.pointerType !== 'mouse' || ctx.won) return;
      const { bubble, inBundle } = hitTest(e);
      const g = inBundle ? bundle : bubble && bubble.group >= 0 ? groups[bubble.group] : null;
      if (g === hoverGroup) return;
      hoverGroup?.g.classList.remove('is-hover');
      hoverGroup = g;
      g?.g.classList.add('is-hover');
      svg.style.cursor = bubble || inBundle ? 'pointer' : 'default';
    });

    scope.on<PointerEvent>(svg, 'pointerdown', (e) => {
      if (ctx.won || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      const { bubble, inBundle } = hitTest(e);
      if (inBundle) {
        bundle.g.classList.add('is-found');
        linkLayer.classList.add('is-found');
        wrap.classList.add('is-found');
        const tag = svgEl('text', {
          x: bundle.cx,
          y: Math.max(16, bundle.cy - bundle.rad - 10),
          class: 'tk-bm-found-label',
          'text-anchor': 'middle',
        });
        tag.textContent = `BUNDLED: ${supply}% OF SUPPLY`;
        labelLayer.append(tag);
        warn.textContent = `BUNDLE: ${supply}% SUPPLY`;
        ctx.win('BUNDLE EXPOSED');
        return;
      }
      if (!bubble) return;
      restartClass(bubble.node, 'is-wrong');
      if (bubble.isLP) ctx.fail("That's the LP, ser. Not a bundle.", mapBox);
      else ctx.fail(pick(bubble.group >= 0 ? MISS_GROUP : MISS_LONE), mapBox);
    });
  },
};
