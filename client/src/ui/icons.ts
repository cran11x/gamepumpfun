// Static inline SVG icons (24x24, currentColor). Trusted markup, never mixed with user content.

const svg = (body: string, fill = false) =>
  `<svg viewBox="0 0 24 24" width="1em" height="1em" ${
    fill ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"'
  }>${body}</svg>`;

export const ICONS = {
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  check: svg('<path d="M4.5 12.5l5 5L19.5 7"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  crown: svg('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>', true),
  bot: svg(
    '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/><circle cx="12" cy="3.5" r="1.2" fill="currentColor"/><circle cx="9" cy="14" r="1.4" fill="currentColor"/><circle cx="15" cy="14" r="1.4" fill="currentColor"/>',
  ),
  wallet: svg('<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1.3" fill="currentColor"/>'),
  phantom: svg(
    '<path d="M4 13.2C4 8.1 7.6 4.5 12.3 4.5 17 4.5 20 8 20 12.4c0 3-1.7 6.1-4.2 6.1-1.2 0-1.7-.8-2.6-.8s-1.6 1.6-3.7 1.6C6.1 19.3 4 16.8 4 13.2z"/><circle cx="11" cy="11" r="1.3" fill="#0b0f16" stroke="none"/><circle cx="15" cy="11" r="1.3" fill="#0b0f16" stroke="none"/>',
    true,
  ),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  logout: svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  soundOn: svg('<path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  soundOff: svg('<path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  map: svg('<path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>'),
  chat: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
  trophy: svg('<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v4M8 20h8"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 0 1 5 1c0 1.8-2.5 2-2.5 3.6"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/>'),
  hand: svg('<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5A5.5 5.5 0 0 1 5.8 17L4 13.5a1.4 1.4 0 0 1 2.4-1.4L8 14"/>'),
  task: svg('<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="M8 9l1.5 1.5L12 8M8 15l1.5 1.5L12 14M14.5 9.5H17M14.5 15.5H17"/>'),
  wrench: svg('<path d="M14.5 6.5a4 4 0 0 0 5 5l-8.5 8.5a2.1 2.1 0 0 1-3-3z"/><path d="M14.5 6.5L17 4l3 3-2.5 2.5"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>'),
  megaphone: svg('<path d="M4 10v4h3l9 5V5L7 10z"/><path d="M7 14l1.5 5h3L10 15M19 9.5a3 3 0 0 1 0 5"/>'),
  rug: svg('<path d="M3 5l5.5 6 4-3.5L21 17"/><path d="M15 17h6v-6"/>'),
  bolt: svg('<path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z"/>', true),
  bridge: svg(
    '<ellipse cx="12" cy="12" rx="9" ry="9"/><ellipse cx="12" cy="12" rx="4.5" ry="9"/><path d="M3 12h18"/>',
  ),
  exit: svg('<path d="M12 3v10M7.5 8.5L12 13l4.5-4.5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  arrowRight: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  x: svg('<path d="M4 4l16 16M20 4L4 20" stroke-width="2.6"/>'),
  telegram: svg('<path d="M21 4L3 11l6 2.5L19 7l-7.5 8v5l3.5-3.5 4 3z"/>'),
  pill: svg('<rect x="4" y="9" width="16" height="7" rx="3.5" transform="rotate(-35 12 12.5)"/><path d="M10 9.5l4.2 6"/>'),
  users: svg('<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.5a3.2 3.2 0 0 1 0 6.2M18.5 14.5a6 6 0 0 1 3 5.5"/>'),
  ghost: svg('<path d="M5 20V11a7 7 0 0 1 14 0v9l-2.5-2-2.3 2-2.2-2-2.2 2-2.3-2z"/><circle cx="9.5" cy="11" r="1.2" fill="currentColor"/><circle cx="14.5" cy="11" r="1.2" fill="currentColor"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  play: svg('<path d="M7 4.5v15l12.5-7.5z"/>', true),
  door: svg('<path d="M14 3H6v18h8"/><path d="M11 12h10M17.5 8.5L21 12l-3.5 3.5"/>'),
  warning: svg('<path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r=".6" fill="currentColor"/>'),
  skip: svg('<path d="M5 5l8 7-8 7zM15 5v14"/>'),
  send: svg('<path d="M4 12l16-8-6 16-2.5-6.5z"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'),
  dice: svg('<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.3" fill="currentColor"/><circle cx="15" cy="15" r="1.3" fill="currentColor"/><circle cx="15" cy="9" r="1.3" fill="currentColor"/><circle cx="9" cy="15" r="1.3" fill="currentColor"/>'),
} as const;

export type IconName = keyof typeof ICONS;
