// Compact, token-efficient text views of the document for agents.

import type { Editor } from '../editor/Editor';
import type { OcelotDocument } from '../model/document';
import type { NodeData } from '../model/types';

const SUMMARY_KEYS: Array<[label: string, keys: string[]]> = [
  ['', ['display']],
  ['dir', ['flex-direction']],
  ['cols', ['grid-template-columns']],
  ['gap', ['gap', 'row-gap', 'column-gap']],
  ['pad', ['padding']],
  ['w', ['width']],
  ['h', ['height']],
  ['bg', ['background', 'background-color', 'background-image']],
  ['color', ['color']],
  ['font', ['font-size']],
  ['weight', ['font-weight']],
  ['radius', ['border-radius']],
  ['border', ['border']],
  ['pos', ['position']],
];

function clip(s: string, n = 32): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** "flex · dir column · gap 24px · pad 64px · bg #fff" */
export function summarizeStyles(styles: Record<string, string>): string {
  const parts: string[] = [];
  for (const [label, keys] of SUMMARY_KEYS) {
    const key = keys.find((k) => styles[k]);
    if (!key) continue;
    const v = clip(styles[key]!);
    parts.push(label ? `${label} ${v}` : v);
  }
  const shown = new Set(SUMMARY_KEYS.flatMap(([, k]) => k));
  const rest = Object.keys(styles).filter((k) => !shown.has(k)).length;
  if (rest) parts.push(`+${rest}`);
  return parts.join(' · ');
}

function textPreview(n: NodeData): string {
  const t = (n.text || n.html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  return t ? `"${clip(t, 48)}"` : '';
}

export function nodeLine(n: NodeData): string {
  const bits: string[] = [n.id, n.type];
  const preview = n.type === 'text' ? textPreview(n) : '';
  const defaultName = { frame: 'Frame', text: 'Text', image: 'Image', svg: 'Vector', code: 'Code', artboard: '' }[n.type];
  const nameIsNoise = n.name === defaultName || (preview && preview.startsWith(`"${n.name.slice(0, 20)}`));
  if (n.name && !nameIsNoise) bits.push(`"${clip(n.name, 40)}"`);
  if (n.type !== 'artboard') bits.push(`<${n.tag}>`);
  if (n.frame) bits.push(`${n.frame.width}×${n.frame.height} at (${n.frame.x}, ${n.frame.y})`);
  if (preview) bits.push(preview);
  if (n.type === 'image' && n.attrs.src) bits.push(`src ${clip(n.attrs.src, 40)}`);
  if (n.type === 'code' && n.code) bits.push(`code (${n.code.source.split('\n').length} lines${n.code.libraries.length ? `; ${n.code.libraries.join(', ')}` : ''})`);
  const s = summarizeStyles(n.styles);
  if (s) bits.push(`· ${s}`);
  if (n.link) bits.push(`[link → ${'artboard' in n.link ? n.link.artboard : n.link.url}]`);
  if (n.hidden) bits.push('[hidden]');
  const states = Object.keys(n.states).map((s) => (s === 'active' ? 'pressed' : s));
  if (states.length) bits.push(`[states: ${states.join(', ')}]`);
  if (n.locked) bits.push('[layer-locked]');
  return bits.join(' ');
}

/** Indented outline of a subtree, depth-limited. */
export function formatTree(doc: OcelotDocument, rootIds: string[], maxDepth: number, maxLines = 400): string {
  const lines: string[] = [];
  let truncated = false;
  const walk = (id: string, depth: number) => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    const n = doc.get(id);
    if (!n) return;
    const pad = '  '.repeat(depth);
    lines.push(pad + nodeLine(n));
    if (n.children.length === 0) return;
    if (depth >= maxDepth) {
      lines.push(`${pad}  … ${n.children.length} children (raise depth or call get_tree with root_id ${n.id})`);
      return;
    }
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const id of rootIds) walk(id, 0);
  if (truncated) lines.push(`… output truncated at ${maxLines} lines; call get_tree with a root_id to see a smaller part.`);
  return lines.join('\n');
}

export interface ArtboardMeasure {
  rendered: boolean;
  contentWidth: number;
  contentHeight: number;
}

/** Live measurement of an artboard's content from the canvas iframe (if mounted). */
export function measureArtboard(editor: Editor, artboardId: string): ArtboardMeasure {
  const root = editor.renderers.get(artboardId)?.root as HTMLElement | undefined;
  if (!root) return { rendered: false, contentWidth: 0, contentHeight: 0 };
  return { rendered: true, contentWidth: Math.ceil(root.scrollWidth), contentHeight: Math.ceil(root.scrollHeight) };
}

/** Node rect relative to its artboard, from the live canvas iframe. */
export function liveRect(editor: Editor, nodeId: string): { x: number; y: number; width: number; height: number } | null {
  const artboard = editor.doc.artboardOf(nodeId);
  if (!artboard) return null;
  const r = editor.renderers.get(artboard);
  const el = r?.elementFor(nodeId) as HTMLElement | undefined;
  const root = r?.root as HTMLElement | undefined;
  if (!el || !root || !el.isConnected) return null;
  const a = el.getBoundingClientRect();
  const b = root.getBoundingClientRect();
  return { x: Math.round(a.left - b.left), y: Math.round(a.top - b.top), width: Math.round(a.width), height: Math.round(a.height) };
}

export function overflowNote(frame: { width: number; height: number }, m: ArtboardMeasure): string | null {
  if (!m.rendered) return null;
  const notes: string[] = [];
  if (m.contentHeight > frame.height + 1) {
    notes.push(`content is ${m.contentHeight}px tall but the artboard is ${frame.height}px, so ${m.contentHeight - frame.height}px are cut off. Increase the height with update_artboard (height: ${m.contentHeight}) if the page should show everything.`);
  }
  if (m.contentWidth > frame.width + 1) {
    notes.push(`content is ${m.contentWidth}px wide but the artboard is ${frame.width}px: something overflows horizontally (check fixed widths, long words or missing flex-wrap).`);
  }
  return notes.length ? notes.join(' ') : null;
}
