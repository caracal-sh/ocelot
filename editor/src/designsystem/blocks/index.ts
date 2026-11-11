// Blocks (P4 step 2): load a style's block templates, list them, and insert one as ordinary design-system layers.
// A block rebuilds through `generateTree` (the same generator `insert_component` uses), so the record's tweaks, the pointer option and the
// artboard's scheme apply, and every component instance carries `data-ds` like one inserted by hand. Nothing links the layers back to the block.

import type { DocumentOps, OcelotDocument } from '../../model/document';
import { ARTBOARD_PRESETS, type ArtboardPreset, type NodeSpec } from '../../model/types';
import { ComponentError } from '../components/errors';
import { generateTree, type GenerateRecord } from '../components/generate';
import { BLOCK_ATTR, schemeOf, SCHEME_ATTR } from '../components/instances';
import type { ComponentSet } from '../components/set';
import type { ComponentChild, ComponentRequest } from '../components/types';
import type { DesignSystemRecord, DsStyle, Scheme } from '../model';
import { artboardStyles } from '../tokens';
import type { BlockNode, BlockPatch, BlockRecord, BlocksFile, SkippedBlock } from './types';

export type { BlockNode, BlockPatch, BlockRecord, BlocksFile, SkippedBlock } from './types';

export { BLOCK_ATTR };

const LOADERS: Record<DsStyle, () => Promise<{ default: unknown }>> = {
  nova: () => import('../snapshot/specs/blocks/nova.json'),
  vega: () => import('../snapshot/specs/blocks/vega.json'),
  maia: () => import('../snapshot/specs/blocks/maia.json'),
  lyra: () => import('../snapshot/specs/blocks/lyra.json'),
  mira: () => import('../snapshot/specs/blocks/mira.json'),
  luma: () => import('../snapshot/specs/blocks/luma.json'),
  rhea: () => import('../snapshot/specs/blocks/rhea.json'),
  sera: () => import('../snapshot/specs/blocks/sera.json'),
};

const cache = new Map<DsStyle, Promise<BlocksFile>>();

/** The block templates of `style`, loaded once (one chunk per style). */
export function loadBlocks(style: DsStyle): Promise<BlocksFile> {
  let p = cache.get(style);
  if (!p) {
    p = LOADERS[style]().then((m) => m.default as BlocksFile);
    p.catch(() => cache.delete(style));
    cache.set(style, p);
  }
  return p;
}

/** The approved development packages: a block that needs another package is not built. */
export const APPROVED_PACKAGES: readonly string[] = ['cn', '@base-ui/react', 'class-variance-authority', 'lucide-react', 'tw-animate-css', 'shadcn', 'input-otp', 'cmdk'];

/** shadcn components that stay export-only (their blocks are skipped even when no package is missing). */
const EXPORT_ONLY: Record<string, true> = { chart: true, calendar: true, carousel: true, sonner: true, drawer: true };

export interface BlockSummary {
  name: string;
  title: string;
  description?: string;
  categories: string[];
  size: { width: number; height: number };
  /** The components the block uses (`card`, `field`, `input`: what get_component and export_design_system take), sorted. */
  components: string[];
}

export interface SkippedSummary {
  name: string;
  title?: string;
  /** What rules the block out: packages outside the approved set, export-only components. */
  needs: string[];
}

export function listBlocks(file: BlocksFile, set: ComponentSet): { blocks: BlockSummary[]; skipped: SkippedSummary[] } {
  const blocks = Object.entries(file.blocks).map(([name, b]) => ({ name, title: b.title, ...(b.description ? { description: b.description } : {}), categories: b.categories, size: b.size, components: [...new Set(b.components.map((p) => set.part(p)?.component ?? p))].sort() }));
  const skipped = Object.entries(file.skipped).map(([name, s]: [string, SkippedBlock]) => ({
    name,
    ...(s.title ? { title: s.title } : {}),
    needs: [...(s.reason ? [s.reason] : []), ...s.dependencies.filter((d) => !APPROVED_PACKAGES.includes(d)), ...s.registryDependencies.filter((d) => d in EXPORT_ONLY)],
  }));
  return { blocks, skipped };
}

/** The block's request tree for `scheme`: the light layers with the dark patch applied (or the dark tree itself). */
export function blockLayers(block: BlockRecord, scheme: Scheme): BlockNode[] {
  if (scheme === 'light') return block.layers;
  if (block.darkLayers) return block.darkLayers;
  const patch = block.dark;
  if (!patch) return block.layers;
  const apply = (list: BlockNode[], prefix: string): BlockNode[] =>
    list.map((n, i) => {
      const path = prefix === '' ? String(i) : `${prefix}.${i}`;
      const p = patch[path];
      if (typeof n === 'string') return p?.text !== undefined && p.text !== null ? p.text : n;
      if ('icon' in n) return n;
      const children = n.children ? apply(n.children, path) : undefined;
      if ('layout' in n) {
        const l = p ? patchLayout(n.layout, p) : n.layout;
        return { layout: l, ...(children ? { children } : {}) };
      }
      return { ...n, ...(p?.styles ? { styles: patchMap(n.styles, p.styles) } : {}), ...(p?.attrs ? { attrs: patchMap(n.attrs, p.attrs) } : {}), ...(children ? { children } : {}) };
    });
  return apply(block.layers, '');
}

function patchMap(base: Record<string, string> | undefined, patch: Record<string, string | null>): Record<string, string> {
  const out = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

function patchLayout(layout: BlockLayout, p: BlockPatch): BlockLayout {
  const out: BlockLayout = { ...layout };
  if (p.styles) out.styles = patchMap(layout.styles, p.styles);
  if (p.attrs) out.attrs = patchMap(layout.attrs, p.attrs);
  if (p.states !== undefined) out.states = p.states;
  if (p.text !== undefined) {
    if (p.text === null) delete out.text;
    else out.text = p.text;
  }
  if (p.html !== undefined) {
    if (p.html === null) delete out.html;
    else out.html = p.html;
  }
  return out;
}

type BlockLayout = Extract<BlockNode, { layout: unknown }>['layout'];

/** The request tree in the generator's own shape (`part` becomes `component`, flags become boolean props). */
function toChild(n: BlockNode): ComponentChild {
  if (typeof n === 'string') return n;
  if ('icon' in n) return { icon: n.icon, ...(n.at ? { at: n.at } : {}) };
  const children = n.children?.map(toChild);
  if ('layout' in n) return { layout: n.layout, ...(children ? { children } : {}) };
  const props: Record<string, string | boolean> = { ...(n.props ?? {}), ...Object.fromEntries((n.flags ?? []).map((f) => [f, true])) };
  const req: ComponentRequest = { component: n.part, ...(Object.keys(props).length ? { props } : {}), ...(n.attrs ? { attrs: n.attrs } : {}), ...(n.styles ? { styles: n.styles } : {}), ...(children ? { children } : {}) };
  return req;
}

/** The layers of a block as the generator writes them: parts become instances of the record's style, in `scheme`. */
export function blockSpecs(set: ComponentSet, record: GenerateRecord, name: string, block: BlockRecord, scheme: Scheme): { specs: NodeSpec[]; warnings: string[] } {
  const warnings: string[] = [];
  const specs = generateTree(set, record, blockLayers(block, scheme).map(toChild), { scheme, warn: (m) => warnings.push(m) });
  for (const s of specs) s.attrs = { ...(s.attrs ?? {}), [BLOCK_ATTR]: name };
  return { specs, warnings };
}

export interface InsertBlockInput {
  block: string;
  /** An artboard or frame to write into (the block's layers are appended). */
  parentId?: string;
  /** Create an artboard for it instead: at the block's natural size unless a preset or width/height is given. */
  newArtboard?: { name?: string; preset?: ArtboardPreset; width?: number; height?: number; pageId?: string };
  /** The scheme of a NEW artboard (default: the system's default scheme). An existing parent keeps its own. */
  scheme?: Scheme;
}

export interface InsertBlockResult {
  ids: string[];
  artboardId: string;
  created: boolean;
  scheme: Scheme;
  warnings: string[];
}

/**
 * Inserts a block as one transaction (one undo step). Throws a ComponentError that names the valid blocks or the missing argument.
 */
export function insertBlock(doc: OcelotDocument, ops: DocumentOps, env: { record: DesignSystemRecord; set: ComponentSet; file: BlocksFile }, input: InsertBlockInput): InsertBlockResult {
  const block = env.file.blocks[input.block];
  if (!block) {
    const names = Object.keys(env.file.blocks);
    throw new ComponentError('unknown_component', `There is no block "${input.block}" in the ${env.file.style} style. Blocks: ${names.join(', ')}. list_blocks shows what each one is.`);
  }
  if ((input.parentId === undefined) === (input.newArtboard === undefined)) {
    throw new ComponentError('bad_prop', 'insert_block needs exactly one target: artboard_id (an artboard or frame to write into) or new_artboard ({ name?, preset? }).');
  }
  return ops.transact(() => {
    let parentId = input.parentId;
    let created = false;
    let scheme: Scheme;
    if (parentId === undefined) {
      const na = input.newArtboard!;
      const preset = na.preset ? ARTBOARD_PRESETS[na.preset] : undefined;
      if (na.preset && !preset) throw new ComponentError('bad_prop', `Unknown preset "${na.preset}". Use one of: ${Object.keys(ARTBOARD_PRESETS).join(', ')}, or leave it out for the block's own size (${block.size.width}×${block.size.height}).`);
      scheme = input.scheme ?? env.record.defaultScheme ?? 'light';
      parentId = ops.createArtboard({
        name: na.name?.trim() || block.title,
        width: na.width ?? preset?.width ?? block.size.width,
        height: na.height ?? preset?.height ?? block.size.height,
        ...(na.pageId ? { pageId: na.pageId } : {}),
        styles: artboardStyles(env.record, scheme),
      });
      ops.setAttrs(parentId, { [SCHEME_ATTR]: scheme });
      created = true;
    } else {
      const n = doc.require(parentId);
      if (n.type !== 'artboard' && n.type !== 'frame') throw new ComponentError('bad_prop', `"${parentId}" is a ${n.type} node and cannot contain a block. Pass an artboard or frame id, or new_artboard.`);
      scheme = schemeOf(doc, parentId);
    }
    const { specs, warnings } = blockSpecs(env.set, env.record, input.block, block, scheme);
    const ids = ops.insertNodes(parentId, specs);
    return { ids, artboardId: doc.artboardOf(parentId) ?? parentId, created, scheme, warnings };
  });
}
