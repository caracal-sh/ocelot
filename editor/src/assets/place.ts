// Putting stored images on the canvas: into an existing node, as a new image node, and the sized
// placeholder shown while a generation runs. Pure model operations; callers choose the actor
// (agent steps for MCP, human actions for the UI).

import type { AssetRecord } from '../bridge/schema.gen';
import { ModelError, type NodeData, type NodeSpec } from '../model/types';
import type { OcelotDocument, DocumentOps } from '../model/document';
import { assetRef, cssUrl } from './refs';

/** Attribute on placeholder nodes; the loader removes leftovers from a crashed generation. */
export const GENERATING_ATTR = 'data-ocelot-generating';
/** What documents saved by the app's Atelier releases carry; still recognised (and removed) on load. */
const LEGACY_GENERATING_ATTR = 'data-atelier-generating';

export interface NewImageOptions {
  parentId: string;
  index?: number | undefined;
  /** CSS px. With only one of the two the other follows the image's aspect ratio. */
  width?: number | undefined;
  height?: number | undefined;
  /** Extra styles (win over the defaults). */
  styles?: Record<string, string> | undefined;
  name?: string | undefined;
  alt?: string | undefined;
}

/** Display size for an image of `aspect` (w/h): honors one or both of width/height, else 480px wide. */
export function displaySize(aspect: number, width?: number, height?: number): { width: number; height: number } {
  if (width && height) return { width, height };
  if (width) return { width, height: Math.round(width / aspect) };
  if (height) return { width: Math.round(height * aspect), height };
  return { width: 480, height: Math.round(480 / aspect) };
}

export function imageSpec(asset: Pick<AssetRecord, 'id' | 'width' | 'height' | 'prompt' | 'name'>, opts: NewImageOptions): NodeSpec {
  const aspect = asset.width && asset.height ? asset.width / asset.height : 1;
  const size = displaySize(aspect, opts.width, opts.height);
  const alt = opts.alt ?? '';
  const label = opts.name ?? asset.name ?? (asset.prompt ? asset.prompt.slice(0, 40) : 'Image');
  return {
    type: 'image',
    name: label,
    attrs: { src: assetRef(asset.id), alt },
    styles: { width: `${size.width}px`, height: `${size.height}px`, 'object-fit': 'cover', ...(opts.styles ?? {}) },
  };
}

/** The "Generating…" box that holds the image's place in the layout. */
export function placeholderSpec(aspect: number, opts: NewImageOptions): NodeSpec {
  const size = displaySize(aspect, opts.width, opts.height);
  return {
    type: 'frame',
    name: 'Generating image…',
    attrs: { [GENERATING_ATTR]: '1' },
    styles: {
      width: `${size.width}px`,
      height: `${size.height}px`,
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
      background: 'linear-gradient(135deg, #ececf1 0%, #dcdce4 100%)',
      color: '#7a7a8a',
      'font-size': '13px',
      'flex-shrink': '0',
      ...(opts.styles ?? {}),
    },
    children: [{ type: 'text', name: 'Label', text: 'Generating…', styles: { color: 'inherit', 'font-size': '13px' } }],
  };
}

/**
 * Puts an asset into a node: an image node gets `src`; a frame or artboard gets a cover background
 * image. Anything else cannot show an image and the error says what to pick.
 */
export function setAssetOnNode(ops: DocumentOps, doc: OcelotDocument, nodeId: string, asset: Pick<AssetRecord, 'id'>, alt?: string): 'src' | 'background' {
  const n = doc.require(nodeId);
  if (n.type === 'image') {
    ops.setAttrs(nodeId, { src: assetRef(asset.id), ...(alt !== undefined ? { alt } : {}) });
    return 'src';
  }
  if (n.type === 'frame' || n.type === 'artboard') {
    ops.updateStyles(nodeId, {
      'background-image': cssUrl(asset.id),
      ...(n.styles['background-size'] ? {} : { 'background-size': 'cover' }),
      ...(n.styles['background-position'] ? {} : { 'background-position': 'center' }),
      ...(n.styles['background-repeat'] ? {} : { 'background-repeat': 'no-repeat' }),
    });
    return 'background';
  }
  throw new ModelError('invalid_argument', `A ${n.type} node ("${n.name}") cannot show an image. Pick an image layer (sets its src) or a frame (sets its background image), or use new_image to insert an image into a frame.`);
}

/** Natural aspect (w/h) of the image a node currently shows, if it is a stored asset. */
export function assetIdOfNode(n: NodeData): string | null {
  const src = n.attrs['src'];
  if (src) {
    const m = /^asset:\/\/([0-9a-f]{64})$/.exec(src.trim());
    if (m) return m[1]!;
  }
  const bg = n.styles['background-image'];
  const m = bg ? /url\(\s*["']?asset:\/\/([0-9a-f]{64})["']?\s*\)/.exec(bg) : null;
  return m ? m[1]! : null;
}

const EMBEDDED_IMAGE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/;

/**
 * A raster image embedded in the node as a data: URI (pasted or agent-written HTML), which can be imported
 * into the asset store on demand. SVG data URIs are excluded: cutouts and edits need pixels.
 */
export function embeddedImageOf(n: NodeData): { mime: string; base64: string } | null {
  const src = n.attrs['src']?.trim();
  const fromBg = n.styles['background-image'] ? /url\(\s*["']?(data:[^"')]+)["']?\s*\)/.exec(n.styles['background-image'])?.[1] : undefined;
  const m = EMBEDDED_IMAGE.exec(src ?? fromBg ?? '');
  return m ? { mime: m[1]!, base64: m[2]!.replace(/\s+/g, '') } : null;
}

/** Removes placeholders a crashed generation left in a document (called when a document is loaded). */
export function removeStalePlaceholders(doc: OcelotDocument, ops: DocumentOps): number {
  const stale: string[] = [];
  for (const id of doc.nodes.keys()) {
    const n = doc.get(id);
    if (n && (GENERATING_ATTR in n.attrs || LEGACY_GENERATING_ATTR in n.attrs) && n.parent && !stale.some((s) => doc.isAncestor(s, id))) stale.push(id);
  }
  if (stale.length) ops.deleteNodes(stale);
  return stale.length;
}
