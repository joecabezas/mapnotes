import { useEffect, useState } from 'react';
import type { Style } from '../shared/model';

/**
 * Brand icons come from svgl (https://svgl.app), full-color logos, served from
 * its GitHub repo by jsDelivr so nothing is stored in this repo. The icon name
 * is the file name in svgl's library without `.svg` (e.g. "slack", or
 * "github_dark" for logos with light/dark variants). The release is pinned so
 * a rename upstream can't silently break existing graphs.
 */
export const SVGL_VERSION = '5.0.0';
export const SVGL_SITE = 'https://svgl.app';

const svgUrl = (name: string) => `https://cdn.jsdelivr.net/gh/pheralb/svgl@${SVGL_VERSION}/static/library/${name}.svg`;

/** Data URI per icon name; `null` marks an icon that failed to load. */
const cache = new Map<string, Promise<string | null>>();

/**
 * svgl files often lack (or have odd) width/height; canvas needs an intrinsic
 * size to rasterise an SVG in every browser, so set one on the root element.
 */
function toDataUri(svg: string): string {
  const sized = svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag.replace(/\s(width|height)="[^"]*"/g, '').replace(/^<svg\b/, '<svg width="128" height="128"'),
  );
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
}

function loadIcon(name: string): Promise<string | null> {
  let p = cache.get(name);
  if (!p) {
    p = fetch(svgUrl(name))
      .then((r) => (r.ok ? r.text() : null))
      .then((svg) => (svg ? toDataUri(svg) : null))
      .catch(() => null);
    cache.set(name, p);
  }
  return p;
}

/** Loads the icons used by node styles; returns data URIs keyed by icon name ('' if it failed). */
export function useIcons(styles: Style[]): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const wanted = [...new Set(styles.flatMap((s) => (s.target === 'node' && s.icon ? [s.icon] : [])))];
  const signature = wanted.join(',');

  useEffect(() => {
    let alive = true;
    for (const name of wanted) {
      if (name in icons) continue;
      void loadIcon(name).then((uri) => {
        if (alive) setIcons((prev) => (name in prev ? prev : { ...prev, [name]: uri ?? '' }));
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return icons;
}
