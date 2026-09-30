import { useEffect, useState } from 'react';
import type { NodeStyle, Style } from '../shared/model';

/**
 * Node icons come from two open icon sets, loaded from jsDelivr so nothing is
 * stored in this repo:
 *
 * - svgl (https://svgl.app): full-color brand logos. A style's `icon` is the
 *   file name in svgl's library without `.svg`, e.g. "slack", or "github_dark"
 *   for logos with light/dark variants.
 * - Lucide (https://lucide.dev): general-purpose line icons, written
 *   "lucide:<name>", e.g. "lucide:folder". They take a single color
 *   (`iconColor`, or black/white depending on the node's fill).
 *
 * Both releases are pinned so a rename upstream can't silently break existing graphs.
 */
export const SVGL_VERSION = '5.0.0';
export const SVGL_SITE = 'https://svgl.app';
export const LUCIDE_VERSION = '1';
export const LUCIDE_SITE = 'https://lucide.dev/icons';
export const LUCIDE_PREFIX = 'lucide:';

export type IconSource = 'svgl' | 'lucide';

export function parseIcon(icon: string): { source: IconSource; name: string } {
  return icon.startsWith(LUCIDE_PREFIX)
    ? { source: 'lucide', name: icon.slice(LUCIDE_PREFIX.length) }
    : { source: 'svgl', name: icon };
}

export function iconUrl(icon: string): string {
  const { source, name } = parseIcon(icon);
  return source === 'lucide'
    ? `https://cdn.jsdelivr.net/npm/lucide-static@${LUCIDE_VERSION}/icons/${name}.svg`
    : `https://cdn.jsdelivr.net/gh/pheralb/svgl@${SVGL_VERSION}/static/library/${name}.svg`;
}

/** Black or white, whichever reads better on `fill` (a hex color). */
function contrastColor(fill: string): string {
  const hex = fill.trim().replace(/^#/, '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return '#ffffff';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.55 ? '#1a1b26' : '#ffffff';
}

/**
 * The color a single-color (Lucide) icon is drawn in. `defaultFill` is the
 * theme's node color, used when the style has no fill of its own.
 */
export function iconColorFor(style: Pick<NodeStyle, 'iconColor' | 'color'>, defaultFill: string): string {
  return style.iconColor ?? contrastColor(style.color ?? defaultFill);
}

/** Cache key of a style's loaded icon: Lucide icons differ by color, svgl logos don't. */
export function iconKey(style: Pick<NodeStyle, 'icon' | 'iconColor' | 'color'>, defaultFill: string): string {
  if (!style.icon) return '';
  return parseIcon(style.icon).source === 'lucide' ? `${style.icon}|${iconColorFor(style, defaultFill)}` : style.icon;
}

/** Raw SVG text per icon; `null` marks an icon that failed to load. */
const svgCache = new Map<string, Promise<string | null>>();

function fetchSvg(icon: string): Promise<string | null> {
  let p = svgCache.get(icon);
  if (!p) {
    p = fetch(iconUrl(icon))
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
    svgCache.set(icon, p);
  }
  return p;
}

/**
 * Canvas needs an intrinsic size to rasterise an SVG in every browser, and
 * svgl files often lack (or have odd) width/height, so set one. Lucide icons
 * are drawn in `currentColor`, which means nothing inside an image, so it's
 * replaced by the actual color.
 */
function toDataUri(svg: string, color?: string): string {
  let out = svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag.replace(/\s(width|height)="[^"]*"/g, '').replace(/^<svg\b/, '<svg width="128" height="128"'),
  );
  if (color) out = out.replace(/currentColor/g, color.replace(/"/g, ''));
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(out)}`;
}

/** Loads the icons used by node styles; returns data URIs keyed by `iconKey` ('' if one failed). */
export function useIcons(styles: Style[], defaultFill: string): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const wanted = new Map<string, { icon: string; color?: string }>();
  for (const s of styles) {
    if (s.target !== 'node' || !s.icon) continue;
    const lucide = parseIcon(s.icon).source === 'lucide';
    wanted.set(iconKey(s, defaultFill), { icon: s.icon, color: lucide ? iconColorFor(s, defaultFill) : undefined });
  }
  const signature = [...wanted.keys()].join(',');

  useEffect(() => {
    let alive = true;
    for (const [key, { icon, color }] of wanted) {
      if (key in icons) continue;
      void fetchSvg(icon).then((svg) => {
        if (alive) setIcons((prev) => (key in prev ? prev : { ...prev, [key]: svg ? toDataUri(svg, color) : '' }));
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return icons;
}

// ---- Catalogs for the icon picker.

export interface IconChoice {
  /** Value stored in the style's `icon`. */
  icon: string;
  title: string;
}

let lucideTags: Promise<Record<string, string[]>> | null = null;

/** Lucide icons whose name or tags match `query` (all icons for an empty query). */
export async function searchLucide(query: string, limit: number): Promise<IconChoice[]> {
  lucideTags ??= fetch(`https://cdn.jsdelivr.net/npm/lucide-static@${LUCIDE_VERSION}/tags.json`).then((r) => {
    if (!r.ok) throw new Error(`Could not load the Lucide icon list (${r.status})`);
    return r.json();
  });
  let tags: Record<string, string[]>;
  try {
    tags = await lucideTags;
  } catch (err) {
    lucideTags = null; // let the next search try again
    throw err;
  }
  const q = query.trim().toLowerCase();
  const names = Object.keys(tags);
  const byName = names.filter((n) => n.includes(q));
  const byTag = q ? names.filter((n) => !n.includes(q) && tags[n].some((t) => t.toLowerCase().includes(q))) : [];
  return [...byName, ...byTag].slice(0, limit).map((name) => ({ icon: `${LUCIDE_PREFIX}${name}`, title: name }));
}

interface SvglEntry {
  title: string;
  route: string | { light: string; dark: string };
}

/**
 * svgl logos matching `query`, via svgl's search API. Logos with light and dark
 * variants give two choices. File names come from the returned URLs.
 */
export async function searchSvgl(query: string, limit: number): Promise<IconChoice[]> {
  const q = query.trim();
  const res = await fetch(q ? `https://api.svgl.app?search=${encodeURIComponent(q)}` : `https://api.svgl.app?limit=${limit}`);
  if (!res.ok) throw new Error(`svgl search failed (${res.status})`);
  const entries = (await res.json()) as SvglEntry[];
  const file = (url: string) => url.split('/').pop()!.replace(/\.svg$/, '');
  return entries
    .flatMap((e) =>
      typeof e.route === 'string'
        ? [{ icon: file(e.route), title: e.title }]
        : [
            { icon: file(e.route.light), title: `${e.title} (for light fills)` },
            { icon: file(e.route.dark), title: `${e.title} (for dark fills)` },
          ],
    )
    .slice(0, limit);
}
