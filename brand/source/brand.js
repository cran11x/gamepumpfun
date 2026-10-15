// AMONG RUGS brand kit: comic capsule pills, the -99% sticker, the stacked wordmark, chips, bubbles.
// Everything returns inline SVG strings. Pill local coords: body is 36 x 64 centered at 0,0
// (top half = player color, bottom half = off-white), geometry follows client/src/ui/pill.ts.
(function () {
  const INK = '#0b0e14';
  const OFF = '#f2f5f8';
  const OFF_SHADE = '#c9d1db';
  const RED = '#ff3b5c', GREEN = '#2bff88', GOLD = '#ffd400', PURPLE = '#9945ff', CYAN = '#22e5ff', BG = '#07090d';
  const COLORS = {
    green: { body: '#2bff88', dark: '#12a85a' },
    red: { body: '#ff3b5c', dark: '#b01f3a' },
    purple: { body: '#9945ff', dark: '#5f22b3' },
    blue: { body: '#2f8cff', dark: '#1a55a8' },
    orange: { body: '#ff9f1c', dark: '#b86c00' },
    cyan: { body: '#22e5ff', dark: '#0f97a8' },
    pink: { body: '#ff4fd8', dark: '#b0238f' },
    gold: { body: '#ffd400', dark: '#b39400' },
    lime: { body: '#b6ff3b', dark: '#78b01f' },
  };
  let uid = 0;
  const id = (p) => `${p}${++uid}`;
  const f1 = (n) => +n.toFixed(2);

  const CAPSULE = 'M-18-14A18 18 0 0 1 18-14V14A18 18 0 0 1-18 14Z';
  const TOP = 'M-18 0V-14A18 18 0 0 1 18-14V0Z';
  const BOT = 'M-18 0V14A18 18 0 0 0 18 14V0Z';
  const ZP = [[-18, 2], [-10.5, -5], [-3, 5], [4.5, -5], [11.5, 5], [18, -1]];
  const TOP_BROKEN = `M${ZP[0]}V-14A18 18 0 0 1 18-14V${ZP[5][1]}` + ZP.slice(1, 5).reverse().map((p) => `L${p}`).join('') + 'Z';
  const BOT_BROKEN = `M${ZP[0]}` + ZP.slice(1).map((p) => `L${p}`).join('') + 'V14A18 18 0 0 1-18 14Z';

  function defs() {
    return `<pattern id="ht-dark" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><circle cx="1.6" cy="1.6" r=".9" fill="${INK}" opacity=".55"/></pattern>`;
  }

  // Sunglasses, drawn around (0,0): top bar, two separate lenses, a bridge notch, temples.
  function shadesSvg(sw, glint = true) {
    const ey = 0;
    return `<path d="M-15.5 ${ey - 4.6}H15.5V${ey - 2.2}C15.5 ${ey + 5.5} 11 ${ey + 6.4} 8 ${ey + 6.4}C4.6 ${ey + 6.4} 2 ${ey + 4} 1.4 ${ey - 0.6}H-1.4C-2 ${ey + 4} -4.6 ${ey + 6.4} -8 ${ey + 6.4}C-11 ${ey + 6.4} -15.5 ${ey + 5.5} -15.5 ${ey - 2.2}Z" fill="${INK}" stroke="${INK}" stroke-width="${sw}" stroke-linejoin="round"/>
<path d="M-12.6 ${ey - 2.4}l3.4 0M-12.8 ${ey}l1.6 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round" opacity=".85"/>
<path d="M4.4 ${ey - 2.4}l3.4 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round" opacity=".85"/>
<path d="M-15.5 ${ey - 3.4}L-19 ${ey - 5.4}M15.5 ${ey - 3.4}L19 ${ey - 5.4}" stroke="${INK}" stroke-width="${sw * 1.1}" stroke-linecap="round"/>
${glint ? `<path d="M11-5.4l1.2 2.8 2.8 1.2-2.8 1.2-1.2 2.8-1.2-2.8-2.8-1.2 2.8-1.2z" fill="#fff" stroke="${INK}" stroke-width=".7" stroke-linejoin="round"/>` : ''}`;
  }

  // Upper eyelid (body colored) over an eye circle: chord sits `beta` degrees below the eye's center, rotated by `tilt`.
  function lid(cx, cy, R, beta, tilt, fill, sw) {
    const rad = (d) => (d * Math.PI) / 180;
    const aL = 180 - beta + tilt, aR = beta + tilt;
    const pL = [cx + R * Math.cos(rad(aL)), cy + R * Math.sin(rad(aL))];
    const pR = [cx + R * Math.cos(rad(aR)), cy + R * Math.sin(rad(aR))];
    const large = beta > 0 ? 1 : 0;
    return `<path d="M${f1(pL[0])} ${f1(pL[1])}A${R} ${R} 0 ${large} 1 ${f1(pR[0])} ${f1(pR[1])}Z" fill="${fill}" stroke="${INK}" stroke-width="${sw}" stroke-linejoin="round"/>`;
  }

  function eyesSvg(kind, o) {
    const sep = o.eyeSep || 6.5;
    const lx = -sep, rx = sep, ey = -9 + (o.eyeY || 0);
    const r = o.eyeR || 6.6;
    const dx = (o.lookX ?? 1.8), dy = (o.lookY ?? 0.6);
    const sw = o.sw || 2;
    if (kind === 'xx') {
      const k = o.xSize || 4.2;
      const xx = (cx) => `<path d="M${cx - k} ${ey - k}l${2 * k} ${2 * k}M${cx + k} ${ey - k}l${-2 * k} ${2 * k}" stroke="${INK}" stroke-width="${sw * (o.xW || 1.45)}" stroke-linecap="round"/>`;
      return xx(lx) + xx(rx);
    }
    if (kind === 'shades') {
      return `<g transform="translate(0 ${ey})">${shadesSvg(sw, o.glint !== false)}</g>`;
    }
    if (kind === 'peek') {
      // THE DEV: shades slid down the face, big smug half-lidded eyes peeking over the rim.
      const pey = -13.4 + (o.eyeY || 0);
      const pr = o.eyeR || 7.1;
      const R = pr + 0.9;
      let s = '';
      const eye = (cx, side) => {
        let e = `<circle cx="${cx}" cy="${pey}" r="${pr}" fill="#fff" stroke="${INK}" stroke-width="${sw}"/>`;
        e += `<circle cx="${cx + dx}" cy="${pey + dy}" r="${pr * 0.52}" fill="${INK}"/>`;
        e += `<circle cx="${cx + dx - pr * 0.2}" cy="${pey + dy - pr * 0.22}" r="${pr * 0.15}" fill="#fff"/>`;
        e += lid(cx, pey, R, o.lidBeta ?? -16, side * (o.lidTilt ?? 9), o.color.body, sw);
        return e;
      };
      s += eye(lx, -1) + eye(rx, 1);
      if (o.brow) {
        // one raised brow over the right eye
        s += `<path d="M${rx - 5.4} ${pey - pr - 1.6}Q${rx + 0.4} ${pey - pr - 5.6} ${rx + 5.6} ${pey - pr - 2.4}" fill="none" stroke="${INK}" stroke-width="${sw * 1.35}" stroke-linecap="round"/>`;
      }
      const sy = o.shadesY ?? 2.6, srot = o.shadesRot ?? -6, sk = o.shadesK ?? 0.94;
      s += `<g transform="translate(${o.shadesX ?? 0.4} ${sy}) rotate(${srot}) scale(${sk})">${shadesSvg(sw, o.glint !== false)}</g>`;
      return s;
    }
    const eye = (cx, side) => {
      let s = `<circle cx="${cx}" cy="${ey}" r="${r}" fill="#fff" stroke="${INK}" stroke-width="${sw}"/>`;
      s += `<circle cx="${cx + dx}" cy="${ey + dy}" r="${r * 0.47}" fill="${INK}"/>`;
      s += `<circle cx="${cx + dx - r * 0.18}" cy="${ey + dy - r * 0.2}" r="${r * 0.15}" fill="#fff"/>`;
      if (kind === 'sus' || kind === 'bored') s += lid(cx, ey, r + 0.8, kind === 'bored' ? -3 : 3, 0, o.color.body, sw);
      if (kind === 'angry') {
        const a = side < 0 ? `M${cx - r} ${ey - r - 2.6}L${cx + r * 0.9} ${ey - r + 1.6}` : `M${cx - r * 0.9} ${ey - r + 1.6}L${cx + r} ${ey - r - 2.6}`;
        s += `<path d="${a}" stroke="${INK}" stroke-width="${sw * 1.5}" stroke-linecap="round"/>`;
      }
      if (kind === 'worried') {
        const a = side < 0 ? `M${cx - r} ${ey - r + 0.4}L${cx + r * 0.8} ${ey - r - 3}` : `M${cx - r * 0.8} ${ey - r - 3}L${cx + r} ${ey - r + 0.4}`;
        s += `<path d="${a}" stroke="${INK}" stroke-width="${sw * 1.3}" stroke-linecap="round"/>`;
      }
      return s;
    };
    return eye(lx, -1) + eye(rx, 1);
  }

  function mouthSvg(kind, o) {
    const sw = o.sw || 2;
    const y = 4.5 + (o.mouthY || 0);
    const mx = o.mouthX || 0;
    if (!kind) return '';
    let m = '';
    if (kind === 'smirk') m = `<path d="M-4.6 ${y}Q0.6 ${y + 3.6} 6 ${y - 1.8}" fill="none" stroke="${INK}" stroke-width="${sw * 1.25}" stroke-linecap="round"/><path d="M5 ${y - 2.6}l1.9 1.6" stroke="${INK}" stroke-width="${sw}" stroke-linecap="round"/>`;
    if (kind === 'o') m = `<ellipse cx="0" cy="${y + 1.4}" rx="2.6" ry="3.2" fill="${INK}"/>`;
    if (kind === 'shout') m = `<path d="M-5 ${y - 0.6}Q0 ${y - 1.6} 5 ${y - 0.6}Q4.4 ${y + 6} 0 ${y + 6}Q-4.4 ${y + 6} -5 ${y - 0.6}Z" fill="${INK}"/><path d="M-2.6 ${y + 4.2}Q0 ${y + 2.6} 2.6 ${y + 4.2}" fill="none" stroke="${RED}" stroke-width="1.6" stroke-linecap="round"/>`;
    if (kind === 'flat') m = `<path d="M-3.4 ${y + 0.6}H3.4" stroke="${INK}" stroke-width="${sw * 1.2}" stroke-linecap="round"/>`;
    if (kind === 'wavy') m = `<path d="M-5 ${y + 1}q1.25-2 2.5 0t2.5 0t2.5 0t2.5 0" fill="none" stroke="${INK}" stroke-width="${sw * 1.1}" stroke-linecap="round"/>`;
    if (kind === 'grin') m = `<path d="M-6 ${y - 1}Q0 ${y + 0.4} 6 ${y - 1}Q5 ${y + 5.4} 0 ${y + 5.4}Q-5 ${y + 5.4} -6 ${y - 1}Z" fill="#fff" stroke="${INK}" stroke-width="${sw}" stroke-linejoin="round"/><path d="M-5.2 ${y + 1.6}H5.2" stroke="${INK}" stroke-width="1"/>`;
    return mx ? `<g transform="translate(${mx} 0)">${m}</g>` : m;
  }

  // Noodle arm from a shoulder point to a hand point; mitten points along `dir` (deg).
  function arm(o, side, a) {
    const sw = o.sw || 2;
    const sx = side * 17.2, sy = a.sy ?? 3;
    const hx = a.x, hy = a.y;
    const cx = a.cx ?? (sx + hx) / 2 + side * 3, cy = a.cy ?? Math.max(sy, hy) + 5;
    const col = o.color.dark;
    const path = `M${sx} ${sy}Q${cx} ${cy} ${hx} ${hy}`;
    let s = `<path d="${path}" fill="none" stroke="${INK}" stroke-width="6.4" stroke-linecap="round"/>`;
    s += `<path d="${path}" fill="none" stroke="${col}" stroke-width="${6.4 - sw * 1.5}" stroke-linecap="round"/>`;
    const dir = a.dir ?? 0;
    if (a.hand === 'point') {
      s += `<g transform="translate(${hx} ${hy}) rotate(${dir})">
<rect x="0" y="-2.6" width="12.5" height="5.2" rx="2.6" fill="${OFF}" stroke="${INK}" stroke-width="${sw * 0.9}"/>
<circle r="5" fill="${OFF}" stroke="${INK}" stroke-width="${sw}"/>
<path d="M-2 2.4l4 .4" stroke="${INK}" stroke-width="1" stroke-linecap="round" opacity=".6"/>
</g>`;
    } else {
      s += `<circle cx="${hx}" cy="${hy}" r="4.4" fill="${OFF}" stroke="${INK}" stroke-width="${sw}"/>`;
    }
    return s;
  }

  function legsSvg(o) {
    const sw = o.sw || 2;
    const c = o.color.dark;
    return `<rect x="-12" y="24" width="8.6" height="12" rx="4" fill="${c}" stroke="${INK}" stroke-width="${sw * 1.1}"/>
<rect x="3.4" y="24" width="8.6" height="12" rx="4" fill="${c}" stroke="${INK}" stroke-width="${sw * 1.1}"/>`;
  }

  /** pill(opts) -> <g>. opts: color, x, y, s, rot, eyes, mouth, lookX/Y, legs, armL, armR, sw, shadow, flip, extra */
  function pill(opts = {}) {
    const o = Object.assign({ x: 0, y: 0, s: 1, rot: 0, eyes: 'normal', legs: true, sw: 2.4, shadow: true, halftone: true }, opts);
    o.color = typeof o.color === 'string' ? COLORS[o.color] : (o.color || COLORS.green);
    const cid = id('pc');
    const sw = o.sw;
    let g = '';
    if (o.shadow) g += `<ellipse cx="0" cy="${o.shadowY ?? 37}" rx="19" ry="3.4" fill="#000" opacity="${o.shadowOp ?? .4}"/>`;
    if (o.armL && o.armL.back) g += arm(o, -1, o.armL);
    if (o.armR && o.armR.back) g += arm(o, 1, o.armR);
    if (o.legs) g += legsSvg(o);
    g += `<clipPath id="${cid}"><path d="${CAPSULE}"/></clipPath>`;
    g += `<g clip-path="url(#${cid})">
<path d="${TOP}" fill="${o.color.body}"/>
<path d="${BOT}" fill="${OFF}"/>
<path d="M7-31A18 18 0 0 1 18-14V0H12.6V-13.4A13.6 13.6 0 0 0 7-31Z" fill="${o.color.dark}" opacity=".7"/>
<path d="M12.6 0H18V14A18 18 0 0 1 7 31A13.6 13.6 0 0 0 12.6 14Z" fill="${OFF_SHADE}"/>
${o.halftone ? `<path d="M3-33A18 18 0 0 1 18-14V14A18 18 0 0 1 3 33A20 20 0 0 0 9 14V-14A20 20 0 0 0 3-33Z" fill="url(#ht-dark)" opacity=".7"/>` : ''}
${o.hl === 'top' ? `<ellipse cx="-7.5" cy="-27.2" rx="2.6" ry="6" fill="#fff" opacity=".6" transform="rotate(-62 -7.5 -27.2)"/><circle cx="-14.6" cy="-22.6" r="1.3" fill="#fff" opacity=".55"/>` : `<ellipse cx="-9" cy="-21" rx="3.4" ry="6.6" fill="#fff" opacity=".55" transform="rotate(-20 -9 -21)"/>
<circle cx="-11.6" cy="-11.4" r="1.5" fill="#fff" opacity=".55"/>`}
<path d="M-18 0H18" stroke="${INK}" stroke-opacity=".45" stroke-width="${sw * 0.7}"/>
</g>
<path d="${CAPSULE}" fill="none" stroke="${INK}" stroke-width="${sw * 1.25}"/>`;
    g += eyesSvg(o.eyes, o);
    g += mouthSvg(o.mouth, o);
    if (o.extra) g += o.extra;
    if (o.armL && !o.armL.back) g += arm(o, -1, o.armL);
    if (o.armR && !o.armR.back) g += arm(o, 1, o.armR);
    const flip = o.flip ? ' scale(-1 1)' : '';
    return `<g transform="translate(${o.x} ${o.y}) rotate(${o.rot}) scale(${o.s})${flip}">${g}</g>`;
  }

  /** The dev: red-top pill, shades slid down, smug eyes peeking over. Shared by every asset. */
  function dev(opts = {}) {
    return pill(Object.assign({ color: 'red', eyes: 'peek', mouth: 'smirk', mouthY: 8.6, mouthX: 0.6, lookX: 2.5, lookY: 1.9, eyeSep: 7, brow: true, hl: 'top', shadow: false }, opts));
  }

  /** The rugged bag lying sideways: snapped pill, X_X eyes, -99% sticker (same as bagSvg in the game). */
  function bag(opts = {}) {
    const o = Object.assign({ x: 0, y: 0, s: 1, rot: 0, color: 'pink' }, opts);
    const c = typeof o.color === 'string' ? COLORS[o.color] : o.color;
    return `<g transform="translate(${o.x} ${o.y}) rotate(${o.rot}) scale(${o.s})">
<g transform="rotate(-8 -16 0)">
  <path d="M-4-12H-20a12 12 0 0 0 0 24H-4l-4-4 5-4-5-4 5-4-5-4z" fill="${c.body}" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M-26-5a7 7 0 0 1 5-4" stroke="#fff" stroke-opacity=".55" stroke-width="2.6" stroke-linecap="round" fill="none"/>
  <path d="M-25-4l5 5M-20-4l-5 5M-15-4l5 5M-10-4l-5 5" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>
</g>
<g transform="rotate(10 16 0)">
  <path d="M4-11H20a12 12 0 0 1 0 24H4l4-4-5-4 5-4-5-4 5-4z" fill="${OFF}" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"/>
  ${sticker({ x: 18.5, y: 1.4, s: 0.21, rot: -10, peel: false })}
</g></g>`;
  }

  /** Comic spiky burst polygon centered at cx,cy */
  function burst(cx, cy, rOut, rIn, n, seed = 1, rot = 0, jitter = 1) {
    let s = seed;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
      const a = (i / (n * 2)) * Math.PI * 2 + rot;
      const r = i % 2 === 0 ? rOut * (1 - 0.14 * jitter + rnd() * 0.22 * jitter) : rIn * (1 - 0.1 * jitter + rnd() * 0.15 * jitter);
      pts.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
    }
    return pts.join(' ');
  }

  /** The one and only -99% sticker: white die-cut, ink outline, red label, white Bungee with ink stroke, peeled corner. */
  function sticker(opts = {}) {
    const o = Object.assign({ x: 0, y: 0, s: 1, rot: -10, text: '-99%', peel: true }, opts);
    const W = 64, H = 30, c = 15; // half sizes, peel cut
    const outer = o.peel
      ? `M${-W + 14} ${-H}H${W - 14}A14 14 0 0 1 ${W} ${-H + 14}V${H - c}L${W - c} ${H}H${-W + 14}A14 14 0 0 1 ${-W} ${H - 14}V${-H + 14}A14 14 0 0 1 ${-W + 14} ${-H}Z`
      : `M${-W + 14} ${-H}H${W - 14}A14 14 0 0 1 ${W} ${-H + 14}V${H - 14}A14 14 0 0 1 ${W - 14} ${H}H${-W + 14}A14 14 0 0 1 ${-W} ${H - 14}V${-H + 14}A14 14 0 0 1 ${-W + 14} ${-H}Z`;
    // flap = cut corner mirrored over the cut line
    const flap = `M${W - c} ${H}L${W} ${H - c}L${W - c + 1} ${H - c + 1}Z`;
    return `<g transform="translate(${o.x} ${o.y}) rotate(${o.rot}) scale(${o.s})">
<path d="${outer}" fill="#fff" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>
<rect x="${-W + 8}" y="${-H + 8}" width="${2 * W - 16}" height="${2 * H - 16}" rx="8" fill="${RED}"/>
<path d="M${-W + 12} ${-H + 12}H${W - 22}" stroke="#fff" stroke-opacity=".28" stroke-width="3" stroke-linecap="round"/>
<text x="-1" y="12.6" font-family="Bungee" font-size="34" fill="#fff" stroke="${INK}" stroke-width="6.5" stroke-linejoin="round" paint-order="stroke" text-anchor="middle">${o.text}</text>
${o.peel ? `<path d="M${W - c - 1} ${H + 2.5}L${W + 1} ${H - c + 2.5}" stroke="#000" stroke-opacity=".25" stroke-width="5" stroke-linecap="round"/>
<path d="${flap}" fill="#d9dfe7" stroke="${INK}" stroke-width="4.4" stroke-linejoin="round"/>` : ''}
</g>`;
  }

  /** Stacked AMONG / RUGS wordmark (in-game style): white AMONG, rug-red RUGS with glow, ink outlines, solid extrusion.
   *  x,y = AMONG baseline (left edge, or center if anchor='middle'). */
  function wordmark(opts = {}) {
    const o = Object.assign({ x: 0, y: 0, size: 100, anchor: 'start', glow: true, sticker: true, stickerAt: null, glowId: 'wm-glow' }, opts);
    const S = o.size, S2 = S * 1.164;
    const sw = S * 0.085, dep = S * 0.075;
    const dx = dep * 0.62, dy = dep;
    const yR = S * 1.135;
    const ta = o.anchor === 'middle' ? ' text-anchor="middle"' : '';
    const word = (txt, size, y, fill, extr) => {
      let s = '';
      s += `<text x="${f1(dx)}" y="${f1(y + dy)}" font-family="Bungee" font-size="${size}" fill="${extr}" stroke="${INK}" stroke-width="${f1(sw * 2)}" stroke-linejoin="round"${ta}>${txt}</text>`;
      const steps = 4;
      for (let i = steps - 1; i >= 1; i--) {
        const k = i / steps;
        s += `<text x="${f1(dx * k)}" y="${f1(y + dy * k)}" font-family="Bungee" font-size="${size}" fill="${extr}" stroke="${extr}" stroke-width="${f1(sw)}" stroke-linejoin="round"${ta}>${txt}</text>`;
      }
      s += `<text x="0" y="${f1(y)}" font-family="Bungee" font-size="${size}" fill="${fill}" stroke="${INK}" stroke-width="${f1(sw)}" stroke-linejoin="round" paint-order="stroke"${ta}>${txt}</text>`;
      return s;
    };
    let g = '';
    if (o.glow) g += `<text x="0" y="${f1(yR)}" font-family="Bungee" font-size="${f1(S2)}" fill="${RED}" filter="url(#${o.glowId})" opacity=".85"${ta}>RUGS</text>`;
    g += word('AMONG', S, 0, '#fff', '#2a3444');
    g += word('RUGS', f1(S2), yR, RED, '#6e0d20');
    if (o.sticker) {
      const at = o.stickerAt || (o.anchor === 'middle' ? [S * 1.62, yR - S * 0.2] : [S * 3.62, yR - S * 0.2]);
      g += sticker({ x: f1(at[0]), y: f1(at[1]), s: f1(S * 0.0078 * (o.stickerScale || 1)), rot: o.stickerRot ?? -10 });
    }
    return `<g transform="translate(${o.x} ${o.y})">${g}</g>`;
  }
  /** filter def needed by wordmark glow */
  function glowDef(idName = 'wm-glow', std = 14) {
    return `<filter id="${idName}" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="${std}"/></filter>`;
  }

  // text measuring (fonts must be loaded first)
  const _cv = document.createElement('canvas').getContext('2d');
  function measure(text, font) { _cv.font = font; return _cv.measureText(text).width; }

  /** Rounded chip with ink outline. font: 'Bungee' | 'mono' */
  function chip(opts) {
    const o = Object.assign({ x: 0, y: 0, size: 22, fill: GOLD, color: INK, font: 'Bungee', padX: 16, h: null, rot: 0, dot: null }, opts);
    const fam = o.font === 'mono' ? `'JetBrains Mono'` : 'Bungee';
    const weight = o.font === 'mono' ? '700 ' : '';
    const tw = measure(o.text, `${weight}${o.size}px ${fam}`);
    const h = o.h || Math.round(o.size * 1.75);
    const dotW = o.dot ? o.size * 0.9 : 0;
    const w = Math.round(tw + o.padX * 2 + dotW);
    let s = `<g transform="translate(${o.x} ${o.y}) rotate(${o.rot})">`;
    s += `<rect x="3" y="4" width="${w}" height="${h}" rx="${h / 2}" fill="${INK}"/>`;
    s += `<rect x="0" y="0" width="${w}" height="${h}" rx="${h / 2}" fill="${o.fill}" stroke="${INK}" stroke-width="4"/>`;
    if (o.dot) s += `<circle cx="${o.padX + o.size * 0.32}" cy="${h / 2}" r="${o.size * 0.3}" fill="${o.dot}" stroke="${INK}" stroke-width="2.6"/>`;
    s += `<text x="${o.padX + dotW}" y="${f1(h / 2 + o.size * 0.36)}" font-family="${fam.replace(/'/g, '')}" ${o.font === 'mono' ? 'font-weight="700"' : ''} font-size="${o.size}" fill="${o.color}">${o.text}</text>`;
    s += `</g>`;
    return { svg: s, w, h };
  }
  /** a row of chips; returns svg + total width */
  function chipRow(x, y, items, gap = 12) {
    let cx = x, s = '';
    for (const it of items) { const c = chip(Object.assign({ x: cx, y }, it)); s += c.svg; cx += c.w + gap; }
    return { svg: s, w: cx - gap - x };
  }

  /** Comic speech bubble. tail = absolute tip point. */
  function bubble({ x, y, w, h, text, size = 26, tail, rot = 0, fill = '#fff', color = INK }) {
    const [tx, ty] = tail;
    const shape = `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${INK}" stroke-width="5"/>`;
    const bx = x + Math.max(-w / 3, Math.min(w / 3, (tx - x) * 0.5));
    const by = y + (ty > y ? h / 2 - 6 : -h / 2 + 6);
    const tailP = `M${bx - 16} ${by}L${tx} ${ty}L${bx + 14} ${by}`;
    return `<g transform="rotate(${rot} ${x} ${y})">
  <path d="${tailP}" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  ${shape}
  <path d="M${bx - 13} ${by - 4}L${bx + 11} ${by - 4}" stroke="${fill}" stroke-width="8"/>
  <text x="${x}" y="${y + size * 0.36}" font-family="Bungee" font-size="${size}" fill="${color}" text-anchor="middle">${text}</text>
</g>`;
  }

  /** Persian-style rug (local coords: w x h centered, skewed for table perspective); right-front corner flipped up. */
  function rug(opts = {}) {
    const o = Object.assign({ x: 0, y: 0, w: 200, h: 60, rot: 0, skew: -18, curl: true, a: 34, b: 24 }, opts);
    const W = o.w / 2, H = o.h / 2;
    const k = Math.tan((o.skew * Math.PI) / 180);
    const sk = (p) => [p[0] + k * p[1], p[1]]; // skewX applied by hand
    const fringe = (x0, y0, x1, y1, n, dx) => { let p = ''; for (let i = 0; i <= n; i++) { const t = i / n; p += `M${f1(x0 + (x1 - x0) * t)} ${f1(y0 + (y1 - y0) * t)}h${dx}`; } return p; };
    const A = [W - o.a, H], Bp = [W, H - o.b];
    const body = o.curl ? `M${-W} ${-H}H${W}V${Bp[1]}L${A[0]} ${A[1]}H${-W}Z` : `M${-W} ${-H}H${W}V${H}H${-W}Z`;
    let g = `<g transform="translate(${o.x} ${o.y}) rotate(${o.rot})"><g transform="skewX(${o.skew})">`;
    g += `<path d="${fringe(-W, -H + 3, -W, H - 3, Math.round(o.h / 6), -7)}${fringe(W, -H + 3, W, Bp[1] - 3, Math.round((o.h - o.b) / 6), 7)}" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>`;
    g += `<clipPath id="rugc${++uid}"><path d="${body}"/></clipPath>`;
    g += `<g clip-path="url(#rugc${uid})">`;
    g += `<rect x="${-W}" y="${-H}" width="${o.w}" height="${o.h}" fill="#b01f3a"/>`;
    g += `<rect x="${-W + 6}" y="${-H + 6}" width="${o.w - 12}" height="${o.h - 12}" rx="2" fill="none" stroke="${GOLD}" stroke-width="4"/>`;
    g += `<rect x="${-W + 13}" y="${-H + 13}" width="${o.w - 26}" height="${o.h - 26}" fill="${RED}"/>`;
    g += `<path d="M0 ${-H + 15}L${W * 0.34} 0L0 ${H - 15}L${-W * 0.34} 0Z" fill="${GOLD}" stroke="${INK}" stroke-width="2.2"/>`;
    g += `<path d="M0 ${-H + 22}L${W * 0.18} 0L0 ${H - 22}L${-W * 0.18} 0Z" fill="${PURPLE}"/>`;
    g += `<g fill="${GOLD}"><circle cx="${-W * 0.68}" cy="0" r="3.6"/><circle cx="${W * 0.6}" cy="${-H * 0.25}" r="3.6"/></g>`;
    g += `</g>`;
    g += `<path d="${body}" fill="none" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>`;
    g += `</g>`;
    if (o.curl) {
      // dog-ear computed in screen space: corner C folded over the cut line A-B
      const a = sk(A), b = sk(Bp), c = sk([W, H]);
      const ux = b[0] - a[0], uy = b[1] - a[1], L2 = ux * ux + uy * uy;
      const t = ((c[0] - a[0]) * ux + (c[1] - a[1]) * uy) / L2;
      const F = [2 * (a[0] + t * ux) - c[0], 2 * (a[1] + t * uy) - c[1]];
      const P = (p) => `${f1(p[0])} ${f1(p[1])}`;
      g += `<path d="M${P(a)}L${P(b)}L${P([F[0] + 3, F[1] + 6])}Z" fill="#000" opacity=".3"/>`;
      const qa = [(a[0] + F[0]) / 2 - 1, (a[1] + F[1]) / 2 + 2.5], qb = [(b[0] + F[0]) / 2 + 1.5, (b[1] + F[1]) / 2 + 2];
      g += `<path d="M${P(a)}L${P(b)}Q${P(qb)} ${P(F)}Q${P(qa)} ${P(a)}Z" fill="#efe1c2" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>`;
      g += `<path d="M${P([a[0] + (F[0] - a[0]) * .55 + (b[0] - a[0]) * .1, a[1] + (F[1] - a[1]) * .55 + (b[1] - a[1]) * .1])}L${P([a[0] + (b[0] - a[0]) * .62 + (F[0] - b[0]) * .18, a[1] + (b[1] - a[1]) * .62 + (F[1] - b[1]) * .18])}" stroke="#d3bf96" stroke-width="2.6" stroke-linecap="round"/>`;
      // the flap carries a bit of the end fringe
      const ex = F[0] - b[0], ey2 = F[1] - b[1], el = Math.hypot(ex, ey2), nx = -ey2 / el, ny = ex / el;
      let fr = '';
      for (let i = 1; i <= 2; i++) { const q = i / 3; fr += `M${f1(b[0] + ex * q)} ${f1(b[1] + ey2 * q)}l${f1(nx * 7)} ${f1(ny * 7)}`; }
      g += `<path d="${fr}" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`;
    }
    g += `</g>`;
    return g;
  }

  // ---------- text -> path (Bungee only), using browser glyph positions so kerning matches ----------
  function parsePath(d) {
    const toks = d.match(/[MLHVQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi);
    const out = []; let i = 0, cmd = null;
    while (i < toks.length) {
      const t = toks[i];
      if (/[A-Z]/i.test(t)) { cmd = t; i++; if (cmd === 'Z') { out.push(['Z']); continue; } }
      const n = { M: 2, L: 2, H: 1, V: 1, Q: 4, C: 6 }[cmd];
      const args = toks.slice(i, i + n).map(Number); i += n;
      out.push([cmd, ...args]);
      if (cmd === 'M') cmd = 'L';
    }
    return out;
  }
  const _glyphCache = {};
  function glyphCmds(ch) { if (!_glyphCache[ch]) { const g = window.BUNGEE.glyphs[ch]; _glyphCache[ch] = g ? parsePath(g.d) : []; } return _glyphCache[ch]; }
  function glyphPath(ch, ox, oy, k) {
    let cx = 0, cy = 0, s = '';
    const X = (x) => f1(ox + x * k), Y = (y) => f1(oy - y * k);
    for (const c of glyphCmds(ch)) {
      const [m, ...a] = c;
      if (m === 'M' || m === 'L') { cx = a[0]; cy = a[1]; s += `${m}${X(cx)} ${Y(cy)}`; }
      else if (m === 'H') { cx = a[0]; s += `L${X(cx)} ${Y(cy)}`; }
      else if (m === 'V') { cy = a[0]; s += `L${X(cx)} ${Y(cy)}`; }
      else if (m === 'Q') { s += `Q${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])}`; cx = a[2]; cy = a[3]; }
      else if (m === 'C') { s += `C${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])} ${X(a[4])} ${Y(a[5])}`; cx = a[4]; cy = a[5]; }
      else if (m === 'Z') s += 'Z';
    }
    return s;
  }
  /** Replace every Bungee <text> in `root` with an equivalent <path> (same fill/stroke/filter attrs). */
  function outlineTexts(root) {
    const upm = window.BUNGEE.upm;
    const texts = [...root.querySelectorAll('text')].filter((t) => (t.getAttribute('font-family') || '').includes('Bungee'));
    for (const t of texts) {
      const size = parseFloat(t.getAttribute('font-size'));
      const k = size / upm;
      const str = t.textContent;
      let d = '';
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === ' ') continue;
        const p = t.getStartPositionOfChar(i);
        d += glyphPath(ch, p.x, p.y, k);
      }
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      for (const a of ['fill', 'stroke', 'stroke-width', 'stroke-linejoin', 'paint-order', 'filter', 'opacity', 'transform']) {
        if (t.hasAttribute(a)) path.setAttribute(a, t.getAttribute(a));
      }
      path.setAttribute('data-text', str);
      t.replaceWith(path);
    }
  }


  // ---------- small comic props ----------
  const drop = (x, y, r, s) => `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})"><path d="M0-7C2.6-2.6 4.2-.2 4.2 2a4.2 4.2 0 0 1-8.4 0C-4.2-.2-2.6-2.6 0-7Z" fill="#bff6ff" stroke="${INK}" stroke-width="1.7" stroke-linejoin="round"/><path d="M-1.6 1.2a1.8 1.8 0 0 0 1.2 2" stroke="#fff" stroke-width="1.2" fill="none" stroke-linecap="round"/></g>`;
  /** sweat drops flying off a pill's right temple (pill-local coords, pass as `extra`) */
  const sweat = () => drop(21.5, -22, 24, 1.05) + drop(25, -31, 30, 0.7) + `<path d="M19.5-35l3-3.4M23.6-26.4l4.2-1.6" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"/>`;
  const anger = (x, y, r, s = 1) => `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})" stroke="${INK}" stroke-width="5" stroke-linecap="round"><path d="M0 0l-6-16"/><path d="M12-4l4-17"/><path d="M-12 8l-15-8"/></g>`;
  const mic = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})">
    <path d="M0 18V34M-14 36H14" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
    <path d="M0 18V34M-14 36H14" stroke="#9aa6b5" stroke-width="4" stroke-linecap="round"/>
    <path d="M-17 -2A17 17 0 0 0 17 -2" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
    <path d="M-17 -2A17 17 0 0 0 17 -2" fill="none" stroke="#9aa6b5" stroke-width="4" stroke-linecap="round"/>
    <rect x="-11" y="-36" width="22" height="44" rx="11" fill="#2a3444" stroke="${INK}" stroke-width="5"/>
    <path d="M-6 -24H6M-6 -16H6M-6 -8H6" stroke="#5c6b80" stroke-width="2.6" stroke-linecap="round"/>
  </g>`;
  const tape = (x, y, r) => `<g transform="translate(${x} ${y}) rotate(${r})"><rect x="-46" y="-14" width="92" height="28" fill="#f2f5f8" opacity=".78"/></g>`;
  /** round X SPACES table (ellipse) with the purple dashed ring */
  const table = (cx, cy, rx, ry) => `<ellipse cx="${cx}" cy="${cy + 14}" rx="${rx}" ry="${ry}" fill="${INK}"/><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#1b2433" stroke="${INK}" stroke-width="6"/><ellipse cx="${cx}" cy="${cy - 4}" rx="${rx - 34}" ry="${ry - 16}" fill="none" stroke="${PURPLE}" stroke-width="3" stroke-dasharray="14 9" opacity=".9"/>`;
  /** rays fanning from a point */
  function rays(cx, cy, n, len, fill) {
    let r = '';
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = a0 + Math.PI / n;
      r += `<path d="M${cx} ${cy}L${f1(cx + Math.cos(a0) * len)} ${f1(cy + Math.sin(a0) * len)}L${f1(cx + Math.cos(a1) * len)} ${f1(cy + Math.sin(a1) * len)}Z" fill="${fill}"/>`;
    }
    return r;
  }

  /** Split paint-order="stroke" elements into a stroke layer + a fill layer (same pixels, works in every SVG editor). */
  function flattenPaintOrder(root) {
    for (const el of [...root.querySelectorAll('[paint-order]')]) {
      if (!/stroke/.test(el.getAttribute('paint-order'))) continue;
      const under = el.cloneNode(true);
      under.removeAttribute('paint-order');
      under.setAttribute('fill', under.getAttribute('stroke') || 'none');
      el.removeAttribute('paint-order');
      el.removeAttribute('stroke'); el.removeAttribute('stroke-width'); el.removeAttribute('stroke-linejoin');
      el.parentNode.insertBefore(under, el);
    }
  }

  async function fontsReady() {
    await Promise.all([
      document.fonts.load('400 40px Bungee'),
      document.fonts.load('700 40px "JetBrains Mono"'),
      document.fonts.load('400 40px "JetBrains Mono"'),
      document.fonts.load('700 40px "Space Grotesk"'),
      document.fonts.load('500 40px "Space Grotesk"'),
    ]);
    await document.fonts.ready;
  }

  window.B = { pill, dev, bag, burst, sweat, anger, mic, tape, table, rays, flattenPaintOrder, defs, sticker, wordmark, glowDef, chip, chipRow, bubble, rug, measure, outlineTexts, fontsReady, shadesSvg, COLORS, INK, OFF, RED, GREEN, GOLD, PURPLE, CYAN, BG };
})();
