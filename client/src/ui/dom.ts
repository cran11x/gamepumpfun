// Tiny DOM helpers for the UI layer. User-provided strings (names, chat) only ever go through
// textContent; `html` is reserved for trusted static markup such as the inline SVG icons.

import { ROOMS, type RoomId } from '../../../shared/map';
import { ICONS, type IconName } from './icons';

export type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  /** Trusted static markup only (icons, pills). Never user content. */
  html?: string;
  title?: string;
  type?: string;
  disabled?: boolean;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
  style?: string;
  onClick?: (ev: MouseEvent) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.html !== undefined) el.innerHTML = props.html;
    if (props.text !== undefined) el.textContent = props.text;
    if (props.title) el.title = props.title;
    if (props.type) el.setAttribute('type', props.type);
    if (props.disabled) (el as HTMLButtonElement).disabled = true;
    if (props.style) el.setAttribute('style', props.style);
    if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
    if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) el.dataset[k] = v;
    if (props.onClick) el.addEventListener('click', props.onClick as EventListener);
  }
  append(el, ...children);
  return el;
}

export function append(el: Element, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** A span holding one of the static inline SVG icons. */
export function icon(name: IconName, cls = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = `ico${cls ? ` ${cls}` : ''}`;
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name];
  return s;
}

/** Button with an optional icon, a label and an optional hotkey hint. */
export function button(
  label: string,
  opts: { cls?: string; icon?: IconName; key?: string; title?: string; onClick?: (ev: MouseEvent) => void; nosfx?: boolean } = {},
): HTMLButtonElement {
  const b = h('button', { class: `btn ${opts.cls ?? ''}`.trim(), type: 'button', title: opts.title });
  if (opts.icon) b.append(icon(opts.icon));
  if (label) b.append(h('span', { class: 'btn-label', text: label }));
  if (opts.key) b.append(h('kbd', { class: 'kbd', text: opts.key }));
  if (opts.nosfx) b.dataset.nosfx = '1';
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

/** Set textContent only when it changed (cheap in-place HUD updates). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden;
}

export function toggleClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function setDisabled(el: HTMLButtonElement | HTMLInputElement, disabled: boolean): void {
  if (el.disabled !== disabled) el.disabled = disabled;
}

/** "m:ss" from milliseconds (rounded up so 0:01 shows until the very end). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function roomName(id: RoomId | string): string {
  return ROOMS.find((r) => r.id === id)?.name ?? String(id).toUpperCase();
}

export function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    return t !== 'button' && t !== 'checkbox' && t !== 'radio' && t !== 'range' && t !== 'submit' && t !== 'reset';
  }
  return el instanceof HTMLSelectElement;
}

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** Copy text with the async clipboard API, falling back to a hidden textarea + execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    const prev = document.activeElement as HTMLElement | null;
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    prev?.focus?.();
    return ok;
  } catch {
    return false;
  }
}

/** Shorten a long base58 address for display: "7xKq…3fQa". */
export function shortCa(ca: string): string {
  return ca.length > 12 ? `${ca.slice(0, 4)}…${ca.slice(-4)}` : ca;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** True on phones/tablets (coarse primary pointer, no hover). */
export function detectTouch(): boolean {
  try {
    if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return true;
  } catch {
    /* old browser */
  }
  return 'ontouchstart' in window && navigator.maxTouchPoints > 0 && !window.matchMedia?.('(pointer: fine)').matches;
}
