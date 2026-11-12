// Types of the bundled design-system snapshot (FROZEN interface of stream W1; additive changes only, tell the dependents).
//
// The snapshot is dev-time generated data (`editor/scripts/ds-snapshot`, `bun run ds:snapshot` + `bun run ds:specs`), shipped as JSON:
//   tokens.json           colour overlays of shadcn's knobs               -> `tokenOverlays`
//   icons/lucide.json     the lucide icons the parts use                  -> `iconSet`
//   fonts.json            shadcn's registry:font items                    -> `fontCatalog`
//   sources/<style>.json  raw (pre-transform) registry TSX of one style   -> `loadStyle(style).sources`  (registry export)
//   specs/<style>.json    part templates + patches of one style           -> `loadStyle(style).specs`    (canvas instances)
// The editor loads ONE style at a time (`loadStyle` is a dynamic import per style, so each is its own chunk).
//
// Composition rules (`compose.ts`, shared by the runtime and by the build's compose == direct assertion):
//   scheme S, props P (enum values, missing = default), flags F (boolean names):
//     node = root                              (light)  |  apply(root, dark.root)            (dark)
//     for each prop in declaration order:  apply(node, variantPatch(prop, P[prop]))   // dark uses dark.variants[prop][value] ?? variants[prop][value]
//     for each flag in declaration order:  apply(node, flagPatch(flag))               // dark uses dark.flags[flag] ?? flags[flag]
//     for each interaction in order whose `when` holds: apply(node, interaction.patch)  // dark uses dark.interactions ?? interactions
//   Interactions are the exact corrections the build derives wherever two options do not compose (button size xs + icon-start changes padding
//   differently than size lg + icon-start): `when` = `{ props?: {size:'xs'}, flags?: ['icon-start'] }` (every listed prop value / flag is set).
//   `apply` sets/deletes (null) per node path per key. Paths address `root.children` indexes, slot entries included: '' = the root,
//   '0' = first child, '0.1' = its second child. '@icon' addresses `extras.icon`.

export const DS_STYLES = ['nova', 'vega', 'maia', 'lyra', 'mira', 'luma', 'rhea', 'sera'] as const;
export type DsStyle = (typeof DS_STYLES)[number];
export type Scheme = 'light' | 'dark';

// ---------- raw sources (registry export) ----------

export interface SourceFile {
  /** Registry path, e.g. `registry/base-nova/ui/button.tsx`. */
  path: string;
  type: string;
  /** Raw, pre-transform TSX (still has `IconPlaceholder` and the `cn-*` markers). */
  content: string;
}

export interface SourceItem {
  /** `registry:ui` | `registry:lib` | `registry:hook` | `registry:style`. */
  type: string;
  title?: string;
  dependencies: string[];
  devDependencies?: string[];
  registryDependencies: string[];
  files: SourceFile[];
  cssVars?: Record<string, unknown>;
  css?: Record<string, unknown>;
  links?: Record<string, string>;
}

export interface StyleSources {
  v: 1;
  style: DsStyle;
  shadcn: string;
  /** By registry item name (`button`, `card`, `utils`, `use-mobile`, `style`, ...), sorted. */
  items: Record<string, SourceItem>;
}

// ---------- token overlays (knobs -> CSS variables) ----------

/** CSS variable values without the `--` prefix (the registry's `cssVars` keys): `primary`, `chart-1`, `sidebar-ring`, `radius` (light only). */
export type VarMap = Record<string, string>;
export interface ModeVars {
  light: VarMap;
  dark: VarMap;
}

export type RadiusKnob = 'default' | 'none' | 'small' | 'medium' | 'large';

export interface TokenOverlays {
  v: 1;
  shadcn: string;
  /** The usable base colours (`gray` is accepted by the preset codec but refused by `ui.shadcn.com/init`). */
  baseColors: string[];
  /** The 24 usable theme names (the 7 base colours + 17 accent themes; shadcn's 25th, `gray`, is refused by init). */
  themes: string[];
  /** Per base colour: valid themes (the base colour itself first) and valid chart colours (its own default first). */
  valid: { themes: Record<string, string[]>; charts: Record<string, string[]> };
  /** What a `registry:base` item carries besides colours in a default init: `cssVars.theme` (`--font-heading`) and the CLI's `css` block. */
  template: { cssVarsTheme: Record<string, string>; css: Record<string, unknown> };
  /** Surfaces and defaults per base colour: theme = chart = the base colour, radius `default`, menu accent `subtle`. Includes light `radius`. */
  base: Record<string, ModeVars>;
  /** `${base}/${theme}`: only the variables the theme changes relative to `base[base]` (absent when theme == base). */
  theme: Record<string, ModeVars>;
  /** `${base}/${chart}`: only the variables the chart colour changes (absent for the default chart). */
  chart: Record<string, ModeVars>;
  /** `${base}/${theme}/${chart}`: exact corrections applied LAST where base + theme + chart is not additive. */
  combo: Record<string, ModeVars>;
  /**
   * Menu accent `bold` overlay (accent, accent-foreground), applied after theme/chart/combo. The bold accent is the theme colour, so an accent
   * theme has ONE entry for every base colour (key `${theme}`); a base colour's own theme has `${base}/${base}`.
   * Lookup: `menuAccentBold[`${base}/${theme}`] ?? menuAccentBold[theme]`.
   */
  menuAccentBold: Record<string, ModeVars>;
  /** The light `--radius` value per radius knob. */
  radius: Record<RadiusKnob, string>;
}

// ---------- fonts ----------

export interface FontItem {
  title: string;
  font: { family: string; provider: string; import: string; variable: string; subsets: string[]; dependency: string; weight?: string[]; selector?: string };
}
export interface FontCatalog {
  v: 1;
  shadcn: string;
  /** `font-geist`, `font-heading-geist`, ... by registry item name. */
  items: Record<string, FontItem>;
}

// ---------- icons ----------

export interface IconDef {
  /** Inner markup of the `<svg>` (paths, circles, ...), as lucide renders it. */
  html: string;
}
export interface IconSet {
  v: 1;
  lucide: string;
  /** Attributes every lucide svg carries (`xmlns`, `width`, `height`, `viewBox`, `fill`, `stroke`, ...). */
  svgAttrs: Record<string, string>;
  /** By kebab-case lucide name (`chevron-down`, `check`, `x`, `plus`). */
  icons: Record<string, IconDef>;
  /** Names of the other icon libraries' components for each lucide component (`CheckIcon` -> {tabler, hugeicons, phosphor, remixicon}), for the export. */
  placeholders: Record<string, Partial<Record<'tabler' | 'hugeicons' | 'phosphor' | 'remixicon', string>>>;
}

// ---------- part templates ----------

/** `placeholder` is the `::placeholder` style of an input or textarea (always on); the others are interaction states. */
export type StateName = 'hover' | 'active' | 'focus' | 'placeholder';
export type StateStyles = Partial<Record<StateName, Record<string, string>>>;

/** A `PartNode` with every `{ slot }` filled: structurally a `NodeSpec` (`model/types.ts`). What `instantiate` returns. */
export type InstanceNode = Omit<PartNode, 'children'> & { children?: InstanceNode[] };

/** One layer of a part, shaped like `NodeSpec` plus `{ slot: 'children' }` placeholders where the caller's children go. */
export interface PartNode {
  type: 'frame' | 'text' | 'svg' | 'image';
  tag: string;
  name?: string;
  styles: Record<string, string>;
  states?: StateStyles;
  /** Always carries `data-slot` on a part's root and on every nested part-shaped structure node. */
  attrs?: Record<string, string>;
  /** Sample text of a text layer. */
  text?: string;
  /** Inner svg markup of an svg layer (icons: lucide path data). */
  html?: string;
  children?: Array<PartNode | { slot: 'children' }>;
}

/** Per node path, per key: a value sets, `null` deletes. */
export interface NodePatch {
  styles?: Record<string, string | null>;
  states?: Partial<Record<StateName, Record<string, string | null>>>;
  attrs?: Record<string, string | null>;
}
export type PartPatch = Record<string, NodePatch>;

export interface PartProp {
  values: string[];
  default: string;
  /** The value comes from the nearest ancestor instance of this part when the request does not set it (card `size` -> card-header). */
  inherit?: string;
}

export interface SchemeDelta {
  /** Patch of the light root giving the dark default state. */
  root?: PartPatch;
  /** Where the dark patch differs from the light one (full replacement of that variant's patch). */
  variants?: Record<string, Record<string, PartPatch>>;
  flags?: Record<string, PartPatch>;
  /** Replaces the light `interactions` list when present. */
  interactions?: PartInteraction[];
}

export interface PartInteraction {
  when: { props?: Record<string, string>; flags?: string[] };
  patch: PartPatch;
}

export interface PartTemplate {
  /** Registry item the part lives in (`card`). */
  component: string;
  /** The `data-slot` (`card-header`). */
  part: string;
  /** React function name in the style's source (`CardHeader`), for the React export. */
  fn: string;
  /** Light scheme, every prop at its default, no flag. */
  root: PartNode;
  props: Record<string, PartProp>;
  /** prop -> value -> patch, each relative to `root` with every other prop at its default. */
  variants: Record<string, Record<string, PartPatch>>;
  /** Boolean states: styles AND attrs (`disabled=""`, `aria-invalid="true"`, `data-checked=""`, ...). Also `icon-start`/`icon-end`/`icon` (set by `instantiate` when a child icon asks for it). */
  flags: Record<string, PartPatch>;
  /**
   * Flags the generator sets from context, never the caller: `first` / `last` (the instance is the first / last of its part among its siblings)
   * and `in-<part>` (the nearest part ancestor is that part), for parents that style their children by position and type (table rows).
   */
  contextFlags?: string[];
  /** Flags that come from an ancestor part: flag name -> the ancestor part (alert `icon` -> alert-title). `instantiate` sets them when the nearest such ancestor has the flag. */
  inheritFlags?: Record<string, string>;
  /** React props each flag stands for (`{ invalid: { 'aria-invalid': true } }`), for the React export. */
  flagProps?: Record<string, Record<string, string | boolean>>;
  /** Sample nodes of content kinds in this part's context (`icon`: an svg child, styled by this part's rules). Addressed as path `@icon` in patches. */
  extras?: { icon?: PartNode };
  /** Non-composing option combinations (see the composition rules above). */
  interactions?: PartInteraction[];
  dark?: SchemeDelta;
  /** True when the part has hover/active/focus state declarations (buttons, triggers, rows, items). */
  interactive?: boolean;
  /**
   * The `data-slot` of the layer inside the template that takes the instance's `placeholder`, `value` and similar attributes, when the part's own
   * root is not the field (a combobox input is an input-group around its input).
   */
  attrTarget?: string;
  /**
   * Text the instance supplies as an attribute: `{ heading: 'cmdk-group-heading' }` makes `attrs.heading` the text of the layer that carries the
   * attribute `cmdk-group-heading`, and drops that layer when the attribute is absent (a command group's heading).
   */
  textProps?: Record<string, string>;
  /**
   * Flags that come from the siblings before the instance (`peer-data-[slot=checkbox]:normal-case` on a label): flag name -> the parts that
   * switch it on when one of them stands before the instance in the same parent. `generate` and `instantiate` set them when they know the siblings.
   */
  peerFlags?: Record<string, string[]>;
  /**
   * Flags a part gets from its index among the siblings of its own part in `parent` (Base UI places a toast by `--toast-index`): `flags[i]` is the flag of
   * the sibling at index `i + 1` (the first one has none, an index past the end takes the last). `generate` and `instantiate` set them from the siblings
   * before the instance, when the nearest part ancestor is `parent`. They are context flags (`contextFlags`), never the caller's.
   */
  stackFlags?: { parent: string; flags: string[] };
}

export interface ComponentInfo {
  /** Registry item name (`card`). */
  name: string;
  /** Registry path of the source file. */
  file: string;
  /** DOM parts (the keys of `StyleSpecs.parts`), in source order. */
  parts: string[];
  /** Parts with no layer of their own (`Select`, `Dialog`: context roots). `fn` is the React function name. */
  virtual: Array<{ part: string; fn: string }>;
  /** A typical composition as a request tree (what `get_component` shows and the fidelity specimens use). */
  example: PartRequest;
  /** Where each part sits in `example`: part -> parent part (null for the root part). */
  nesting: Record<string, string | null>;
}

export interface StyleSpecs {
  v: 1;
  style: DsStyle;
  shadcn: string;
  /** sha256 (12 hex) of `sources/<style>.json`: which sources produced these templates. */
  sourcesHash: string;
  components: Record<string, ComponentInfo>;
  parts: Record<string, PartTemplate>;
}

/** A tree to instantiate: parts, text and icons. `part` is a data-slot (DOM part) or a virtual part name (`select`, `dialog`). */
export interface PartRequest {
  part: string;
  props?: Record<string, string>;
  flags?: string[];
  /** Attributes merged onto the part's root after composition (`placeholder`, `value`, `type`, `aria-label`, ...). */
  attrs?: Record<string, string>;
  /** Style declarations merged over the part's root styles after composition (the instance's own overrides). */
  styles?: Record<string, string>;
  /** Plain text children, parts, icons and ready-made layers, in order. */
  children?: Array<PartRequest | string | IconRequest | LayerRequest | LayoutRequest>;
}
/**
 * A layout element of a block (a plain frame or text layer) whose children are requests too, so parts nested in it still get their
 * ancestors and sibling position. Its own `children` field is ignored: the request's `children` replace it.
 */
export interface LayoutRequest {
  layout: Omit<InstanceNode, 'children'>;
  children?: Array<PartRequest | string | IconRequest | LayerRequest | LayoutRequest>;
}
/** A ready-made layer placed inside a part's content slot (a plain frame or text layer the caller built). */
export interface LayerRequest {
  layer: InstanceNode;
}
export interface IconRequest {
  /** kebab-case lucide name. */
  icon: string;
  /** `start`/`end` sets the part's `icon-start`/`icon-end` flag and the `data-icon` attribute. */
  at?: 'start' | 'end';
}

// ---------- the loaded bundle ----------

export interface LoadedStyle {
  sources: StyleSources;
  specs: StyleSpecs;
}

export interface SnapshotInfo {
  shadcn: string;
  /** 12 hex chars over every tracked snapshot file: what a design-system record stores as `snapshot.hash`. */
  hash: string;
  baseUi: string;
  lucide: string;
  fetchedAt: string;
}
