// Capsule-pill characters as inline SVG strings (no ids, no clip paths, so any number can coexist).

import { PLAYER_COLORS } from '../../../shared/constants';

const OFF_WHITE = '#f2efe6';
const OFF_WHITE_SHADE = '#cfc8b8';
const INK = '#0b0e14';

export type PillVariant = 'alive' | 'dead' | 'ghost';

export function colorOf(index: number): { name: string; body: string; dark: string } {
  return PLAYER_COLORS[index] ?? PLAYER_COLORS[0];
}

export interface PillOpts {
  variant?: PillVariant;
  facing?: 1 | -1;
  /** CSS class on the <svg>. */
  cls?: string;
  /** Show the stub legs (default true for alive pills). */
  legs?: boolean;
}

/** A standing capsule pill: top half in the player color, bottom half off-white, two big eyes. */
export function pillSvg(color: number, opts: PillOpts = {}): string {
  const c = colorOf(color);
  const variant = opts.variant ?? 'alive';
  const f = opts.facing ?? 1;
  const legs = opts.legs ?? variant === 'alive';
  const parts: string[] = [];
  if (variant !== 'ghost') parts.push(`<ellipse cx="30" cy="76" rx="17" ry="3.2" fill="#000" opacity=".35"/>`);
  if (variant === 'ghost') parts.push(`<ellipse cx="30" cy="3.6" rx="11" ry="2.8" fill="none" stroke="#ffd400" stroke-width="2"/>`);
  if (legs) {
    parts.push(
      `<g class="pill-legs"><rect class="pill-leg pill-leg-l" x="18.5" y="64" width="8" height="10" rx="3.5" fill="${c.dark}" stroke="${INK}" stroke-width="2"/>`,
      `<rect class="pill-leg pill-leg-r" x="33.5" y="64" width="8" height="10" rx="3.5" fill="${c.dark}" stroke="${INK}" stroke-width="2"/></g>`,
    );
  }
  const body = [
    `<path d="M12 38V24a18 18 0 0 1 36 0v14z" fill="${c.body}"/>`,
    `<path d="M12 38v14a18 18 0 0 0 36 0V38z" fill="${OFF_WHITE}"/>`,
    `<path d="M36 7.4a18 18 0 0 1 12 16.6V38h-5V25A14 14 0 0 0 36 7.4z" fill="${c.dark}" opacity=".55"/>`,
    `<path d="M43 38h5v14a18 18 0 0 1-12 16.6A14 14 0 0 0 43 52z" fill="${OFF_WHITE_SHADE}" opacity=".9"/>`,
    `<ellipse cx="20.5" cy="17" rx="3.6" ry="6.2" fill="#fff" opacity=".42" transform="rotate(-18 20.5 17)"/>`,
    `<path d="M12 38h36" stroke="${INK}" stroke-opacity=".35" stroke-width="1.5"/>`,
    `<rect x="12" y="6" width="36" height="64" rx="18" fill="none" stroke="${INK}" stroke-width="2.6"/>`,
  ];
  if (variant === 'dead') {
    body.push(
      `<path d="M12 36.5l7 4 6-5.5 7 6.5 6-6 10 4" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/>`,
      xEye(24, 29),
      xEye(36, 29),
    );
  } else {
    const dx = 1.8 * f;
    body.push(
      `<circle cx="24" cy="29" r="6.2" fill="#fff" stroke="${INK}" stroke-width="1.8"/>`,
      `<circle cx="36" cy="29" r="6.2" fill="#fff" stroke="${INK}" stroke-width="1.8"/>`,
      `<circle class="pill-pupil" cx="${24 + dx}" cy="29.6" r="2.9" fill="${INK}"/>`,
      `<circle class="pill-pupil" cx="${36 + dx}" cy="29.6" r="2.9" fill="${INK}"/>`,
      `<circle cx="${23 + dx}" cy="28.2" r=".9" fill="#fff"/>`,
      `<circle cx="${35 + dx}" cy="28.2" r=".9" fill="#fff"/>`,
    );
  }
  const op = variant === 'ghost' ? ' opacity=".6"' : variant === 'dead' ? ' opacity=".85"' : '';
  parts.push(`<g class="pill-body"${op}>${body.join('')}</g>`);
  return `<svg class="pill ${opts.cls ?? ''}" viewBox="0 0 60 80" aria-hidden="true">${parts.join('')}</svg>`;
}

function xEye(cx: number, cy: number): string {
  return `<path d="M${cx - 4} ${cy - 4}l8 8M${cx + 4} ${cy - 4}l-8 8" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`;
}

/** The rugged bag: the pill snapped in half, lying sideways, X_X eyes and a red "-99%" sticker. */
export function bagSvg(color: number, cls = ''): string {
  const c = colorOf(color);
  return `<svg class="bag ${cls}" viewBox="0 0 90 54" aria-hidden="true">
<ellipse cx="46" cy="47" rx="38" ry="4" fill="#000" opacity=".4"/>
<g transform="rotate(-6 26 28)">
<path d="M40 15H21a13 13 0 0 0 0 26h19l-4-4 5-4-5-4 5-5-5-4 5-5z" fill="${c.body}" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/>
<path d="M14 22a7 7 0 0 1 6-5" stroke="#fff" stroke-opacity=".45" stroke-width="3" stroke-linecap="round" fill="none"/>
${xEye(20, 27)}${xEye(31, 27)}
</g>
<g transform="rotate(8 64 30)">
<path d="M50 17h17a13 13 0 0 1 0 26H50l4-4-5-4 5-4-5-5 5-4-5-5z" fill="${OFF_WHITE}" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/>
<rect x="55" y="23" width="25" height="13" rx="3" fill="#ff3b5c" stroke="${INK}" stroke-width="1.6" transform="rotate(-8 67 29)"/>
<text x="67.5" y="32.6" font-family="JetBrains Mono, monospace" font-weight="700" font-size="8.6" fill="#fff" text-anchor="middle" transform="rotate(-8 67 29)">-99%</text>
</g>
</svg>`;
}

/** Tiny split-color dot used for voter dots and chat names. */
export function pillDot(color: number, cls = ''): HTMLSpanElement {
  const c = colorOf(color);
  const s = document.createElement('span');
  s.className = `pdot ${cls}`.trim();
  s.style.setProperty('--pc', c.body);
  s.style.setProperty('--pd', c.dark);
  s.title = c.name;
  return s;
}

/** Span wrapper around a pill svg. */
export function pillEl(color: number, opts: PillOpts & { wrapCls?: string } = {}): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = `pillwrap ${opts.wrapCls ?? ''}`.trim();
  s.innerHTML = pillSvg(color, opts);
  return s;
}
