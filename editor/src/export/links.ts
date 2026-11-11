// Prototype links in exports. Internal links name an artboard by id; code needs a path:
//   HTML   `<slug>.html` next to the file when the target is exported with it (several artboards), else `#`.
//   React  the route `/<slug>`; wiring the router is up to the app (the exported file says so).
// External URLs stay as they are.
//
// Slugs come from the artboard names, unique across the whole document in document order, so a screen has the same slug in a
// single export, a multi-artboard export and the React routes.

import type { OcelotDocument } from '../model/document';
import type { NodeLink } from '../model/types';

/** "Onboarding / Welcome — Desktop" → "onboarding-welcome-desktop". */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'screen';
}

/** A unique slug per artboard of the document ("pricing", "pricing-2", …), in document order. */
export function artboardSlugs(doc: OcelotDocument): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const id of doc.artboardIds()) {
    const base = slugify(doc.require(id).name);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    out.set(id, slug);
  }
  return out;
}

/** How the serializers write links: the href for a screen link, or null when the target is not part of the export. */
export interface LinkTargets {
  screenHref(artboardId: string): string | null;
}

/** Multi-artboard HTML: screens in `included` link to `<slug>.html`; others (and deleted targets) drop to `#`. */
export function htmlLinkTargets(slugs: ReadonlyMap<string, string>, included: ReadonlySet<string>): LinkTargets {
  return { screenHref: (id) => (included.has(id) && slugs.has(id) ? `${slugs.get(id)}.html` : null) };
}

/** React: the route path `/<slug>` for every screen that exists. */
export function reactLinkTargets(slugs: ReadonlyMap<string, string>): LinkTargets {
  return { screenHref: (id) => (slugs.has(id) ? `/${slugs.get(id)}` : null) };
}

/** What an exported layer does when clicked: an href (anchors), and/or a target for non-anchor hotspots. */
export interface ExportedLink {
  /** For `<a>`: the href. Internal links to a missing target and links outside the export are `#`. */
  href: string;
  /** Where a non-anchor layer should go on click, or null when there is nowhere to go (a dropped internal link). */
  go: string | null;
}

export function exportedLink(link: NodeLink, targets: LinkTargets): ExportedLink {
  if ('url' in link) return { href: link.url, go: link.url };
  const href = targets.screenHref(link.artboard);
  return { href: href ?? '#', go: href };
}
