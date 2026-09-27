/*
 * Helpers shared by the ink debug view and the test recorder. Moved over from the spike's
 * single main.js without changes in behaviour. Everything the debug view writes goes under
 * _spike/ in the vault.
 */
import type { DataAdapter } from 'obsidian';

export const ROOT = '_spike';
export const LOG_PREFIX = '[notebook-spike]';

export const pad = (n: number | string, w = 2) => String(n).padStart(w, '0');
export const r1 = (v: number) => Math.round(v * 10) / 10;
export const r2 = (v: number) => Math.round(v * 100) / 100;

export function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
export function clock(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function mmss(ms: number) {
  const s = Math.max(0, ms) / 1000;
  return `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
}
export function median(a: number[]) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function kb(bytes: number) {
  return bytes < 1e6 ? `${Math.round(bytes / 1024)} kB` : `${r1(bytes / 1048576)} MB`;
}
export function fmt(v: number | null | undefined, d = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '-';
}
export function yn(v: boolean | null | undefined) {
  return v == null ? '?' : v ? 'yes' : 'no';
}

// Runs async jobs one at a time so file appends land in order.
export class Queue {
  private p: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.p.then(fn);
    this.p = next.catch(e => console.error(LOG_PREFIX, e));
    return next;
  }
}

export async function ensureDir(adapter: DataAdapter, path: string) {
  let acc = '';
  for (const part of path.split('/')) {
    acc = acc ? `${acc}/${part}` : part;
    if (!(await adapter.exists(acc))) await adapter.mkdir(acc);
  }
}

export async function appendText(adapter: DataAdapter, path: string, text: string, header = '') {
  if (await adapter.exists(path)) await adapter.append(path, text);
  else await adapter.write(path, header + text);
}
