// Shop: cosmetics unlocked by burning the token. Tabs per slot, animated pill previews (the world's own
// drawing code), rarity, price, owned / equipped state, BURN TO UNLOCK / EQUIP / UNEQUIP and a
// try-on profile preview. Looks only: nothing here changes gameplay.

import { COSMETIC_SLOTS, COSMETICS, RARITY_COLORS, type CosmeticItem, type CosmeticSlot } from '../../../shared/cosmetics';
import type { EquippedCosmetics, Profile } from '../../../shared/protocol';
import { testModeBadge } from './burn';
import type { UiCore } from './core';
import { button, clear, h, icon, setText } from './dom';
import { nameSpan } from './names';
import { createPillPreview, type PillPreview } from './previews';
import { formatTokens, itemPrice, slotNoun } from './ranked';

/** Card preview canvas (CSS px; scaled to fit the art box with object-fit). Wide so name labels fit. */
const PREVIEW_W = 168;
const PREVIEW_H = 96;

export function openShop(core: UiCore): void {
  const { ctx } = core;
  const mode = core.burnMode();
  const off = mode === 'off';
  const ticker = ctx.config.ticker;
  let slot: CosmeticSlot = 'skin';
  let tryOn: { slot: CosmeticSlot; id: string } | null = null;
  let equipping: string | null = null;
  let closed = false;
  const cards: Array<{ item: CosmeticItem; el: HTMLElement; pv: PillPreview }> = [];

  // ----- You (try-on preview) -----
  const meName = h('div', { class: 'shop-me-name' });
  const meLook = h('ul', { class: 'shop-me-look' });
  const meHint = h('div', { class: 'shop-me-hint' });
  // zoom/shiftY: headroom above the name label for tall effects (On Fire's flames).
  const mePv = createPillPreview(156, core.myColor(), null, { cls: 'shop-me-pv', h: 112, label: null, zoom: 0.9, shiftY: 0.04 });
  const meBox = h(
    'div',
    { class: 'shop-me' },
    h('div', { class: 'shop-me-stage' }, mePv.el),
    h('div', { class: 'shop-me-info' }, h('div', { class: 'shop-me-k', text: 'YOUR LOOK' }), meName, meLook, meHint),
  );

  const banner = h('div', { class: 'shop-banner' });

  // ----- Tabs -----
  const tabs = h('div', { class: 'shop-tabs', attrs: { role: 'tablist' } });
  const tabBtns = new Map<CosmeticSlot, { btn: HTMLButtonElement; count: HTMLElement }>();
  for (const s of COSMETIC_SLOTS) {
    const count = h('span', { class: 'shop-tab-n' });
    const short = s.slot === 'skin' ? 'SKINS' : s.slot === 'rug' ? 'RUGS' : 'NAMES';
    const b = h(
      'button',
      { class: 'shop-tab', type: 'button', attrs: { role: 'tab', 'aria-label': s.title }, dataset: { slot: s.slot } },
      h('span', { class: 'shop-tab-long', text: s.title.toUpperCase() }),
      h('span', { class: 'shop-tab-short', text: short }),
      count,
    );
    b.addEventListener('click', () => {
      slot = s.slot;
      tryOn = null;
      build();
    });
    tabBtns.set(s.slot, { btn: b, count });
    tabs.append(b);
  }
  const grid = h('div', { class: 'shop-grid' });
  const foot = h('p', {
    class: 'shop-foot',
    text: off
      ? 'Looks only. Nothing in the shop changes the game.'
      : `Prices in ${ticker}. Burned tokens are destroyed forever. Nobody receives them. Looks only: no gameplay advantage.`,
  });

  const body = h('div', { class: `shop${off ? ' shop--off' : ''}`, attrs: { id: 'shop-modal' } }, mode === 'mock' ? testModeBadge() : null, banner, meBox, tabs, grid, foot);

  function profile(): Profile | null {
    return ctx.wallet.getSession()?.profile ?? null;
  }

  function myName(): string {
    const p = profile();
    if (p) return p.name;
    try {
      const n = (localStorage.getItem('amongrugs.name') ?? '').trim();
      return n || 'degen';
    } catch {
      return 'degen';
    }
  }

  function look(): EquippedCosmetics {
    const eq: EquippedCosmetics = { ...(profile()?.cosmetics.equipped ?? {}) };
    if (tryOn) eq[tryOn.slot] = tryOn.id;
    return eq;
  }

  function renderBanner(): void {
    clear(banner);
    banner.hidden = false;
    if (off) {
      banner.className = 'shop-banner shop-banner--soon';
      banner.append(icon('flame'), h('div', null, h('strong', { text: 'Shop opens when the token launches.' }), h('span', { text: ' Browse the looks now.' })));
      return;
    }
    if (!profile()) {
      banner.className = 'shop-banner shop-banner--wallet';
      const connect = button('CONNECT PHANTOM', { cls: 'btn--sm btn--phantom', icon: 'phantom', onClick: () => void core.signIn() });
      banner.append(h('div', { class: 'shop-banner-txt', text: 'Connect Phantom to unlock and equip looks.' }), connect);
      return;
    }
    banner.hidden = true;
  }

  function renderMe(): void {
    const eq = look();
    mePv.set(core.myColor(), eq, { label: myName() });
    clear(meName);
    meName.append(nameSpan(myName(), eq, false));
    clear(meLook);
    for (const s of COSMETIC_SLOTS) {
      const id = eq[s.slot];
      const it = id ? COSMETICS.find((c) => c.id === id) : undefined;
      const trying = tryOn?.slot === s.slot;
      meLook.append(
        h(
          'li',
          { class: trying ? 'is-trying' : '' },
          h('span', { class: 'shop-me-slot', text: slotNoun(s.slot) }),
          h('span', { class: 'shop-me-item', text: it ? it.name : 'none' }),
          trying ? h('span', { class: 'shop-me-try', text: 'TRYING ON' }) : null,
        ),
      );
    }
    setText(meHint, tryOn ? 'Tap the card again to stop trying it on.' : 'Tap a card to try it on. Rugs only show under your own rugged bag.');
  }

  function itemButton(item: CosmeticItem): HTMLElement {
    if (off) return h('span', { class: 'shop-soon', text: 'SOON' });
    const p = profile();
    const owned = !!p?.cosmetics.owned.includes(item.id);
    const equipped = p?.cosmetics.equipped[item.slot] === item.id;
    if (!owned) {
      const b = button('BURN TO UNLOCK', { cls: 'btn--sm btn--burn shop-buy', icon: 'flame' });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        void buy(item);
      });
      return b;
    }
    const b = button(equipped ? 'UNEQUIP' : 'EQUIP', { cls: `btn--sm ${equipped ? 'btn--ghost' : 'btn--green'} shop-equip` });
    b.disabled = equipping !== null;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      void equip(item.slot, equipped ? null : item.id);
    });
    return b;
  }

  async function buy(item: CosmeticItem): Promise<void> {
    if (!profile()) {
      const ok = await core.signIn();
      if (!ok || closed) return;
      if (profile()?.cosmetics.owned.includes(item.id)) return;
    }
    tryOn = { slot: item.slot, id: item.id };
    refresh();
    core.openBurn({ request: { purpose: 'cosmetic', itemId: item.id }, onDone: () => refresh() });
  }

  async function equip(s: CosmeticSlot, id: string | null): Promise<void> {
    if (equipping) return;
    equipping = id ?? `-${s}`;
    refresh();
    try {
      await ctx.wallet.equip(s, id);
      if (tryOn?.slot === s) tryOn = null;
      const it = id ? COSMETICS.find((c) => c.id === id) : null;
      core.toast(it ? `${it.name} equipped.` : `${slotNoun(s)[0].toUpperCase()}${slotNoun(s).slice(1)} removed.`, 'good');
    } catch (err) {
      core.toast(err instanceof Error ? err.message : "Couldn't change your look.", 'bad');
    } finally {
      equipping = null;
      if (!closed) refresh();
    }
  }

  function cardState(item: CosmeticItem): { owned: boolean; equipped: boolean } {
    const p = profile();
    return { owned: !!p?.cosmetics.owned.includes(item.id), equipped: p?.cosmetics.equipped[item.slot] === item.id };
  }

  function fillCard(c: (typeof cards)[number]): void {
    const { item, el } = c;
    const st = cardState(item);
    el.classList.toggle('is-owned', st.owned);
    el.classList.toggle('is-equipped', st.equipped);
    el.classList.toggle('is-trying', tryOn?.id === item.id);
    const foot = el.querySelector('.shop-card-foot')!;
    clear(foot);
    if (st.equipped) foot.append(h('span', { class: 'shop-tag shop-tag--on' }, icon('check'), 'EQUIPPED'));
    else if (st.owned) foot.append(h('span', { class: 'shop-tag', text: 'OWNED' }));
    else if (!off) {
      foot.append(
        h('span', { class: 'shop-price' }, icon('flame'), h('span', { class: 'shop-price-n', text: formatTokens(itemPrice(ctx.config.burn, item)) }), h('span', { class: 'shop-price-t', text: ticker })),
      );
    }
    foot.append(itemButton(item));
  }

  function build(): void {
    clear(grid);
    for (const c of cards) c.pv.destroy();
    cards.length = 0;
    for (const [s, t] of tabBtns) {
      t.btn.classList.toggle('is-active', s === slot);
      t.btn.setAttribute('aria-selected', String(s === slot));
    }
    for (const item of COSMETICS.filter((c) => c.slot === slot)) {
      const pv = createPillPreview(PREVIEW_W, core.myColor(), { [item.slot]: item.id }, {
        cls: 'shop-card-pv',
        h: PREVIEW_H,
        label: item.slot === 'name' ? myName() : null,
        seed: cards.length * 7 + 1,
      });
      const title = item.slot === 'name' ? nameSpan(item.name, { name: item.id }, false, 'shop-card-name') : h('span', { class: 'shop-card-name', text: item.name });
      const el = h(
        'div',
        { class: 'shop-card', dataset: { item: item.id, rarity: item.rarity }, attrs: { role: 'button', tabindex: '0', 'aria-label': `${item.name}, ${item.rarity}` } },
        h('div', { class: 'shop-card-art' }, pv.el),
        h('span', { class: 'shop-card-rar', text: item.rarity.toUpperCase() }),
        title,
        h('span', { class: 'shop-card-blurb', text: item.blurb }),
        h('div', { class: 'shop-card-foot' }),
      );
      el.style.setProperty('--rar', RARITY_COLORS[item.rarity]);
      const toggleTry = () => {
        tryOn = tryOn?.id === item.id ? null : { slot: item.slot, id: item.id };
        refresh();
      };
      el.addEventListener('click', (e) => {
        if ((e.target as Element).closest('button')) return;
        toggleTry();
      });
      el.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
          e.preventDefault();
          toggleTry();
        }
      });
      const c = { item, el, pv };
      cards.push(c);
      grid.append(el);
    }
    refresh();
  }

  function refresh(): void {
    if (closed) return;
    renderBanner();
    renderMe();
    const p = profile();
    for (const s of COSMETIC_SLOTS) {
      const t = tabBtns.get(s.slot)!;
      const all = COSMETICS.filter((c) => c.slot === s.slot);
      const owned = p ? all.filter((c) => p.cosmetics.owned.includes(c.id)).length : 0;
      setText(t.count, p && !off ? `${owned}/${all.length}` : String(all.length));
    }
    for (const c of cards) {
      fillCard(c);
      c.pv.set(core.myColor(), { [c.item.slot]: c.item.id }, { label: c.item.slot === 'name' ? myName() : null });
    }
  }

  const off$ = ctx.wallet.onChange(() => refresh());
  core.openModal({
    title: 'SHOP',
    body,
    cls: 'modal--shop',
    onClose: () => {
      closed = true;
      off$();
      for (const c of cards) c.pv.destroy();
      mePv.destroy();
    },
  });
  build();
  // Fresh owned / equipped state (e.g. after a burn confirmed on another device).
  if (profile()) void ctx.wallet.refreshProfile();
}
