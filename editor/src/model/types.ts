// Plain (non-Yjs) shapes of the document. The Yjs layout lives in document.ts.

export type NodeType = 'artboard' | 'frame' | 'text' | 'image' | 'svg' | 'code';

export const NODE_TYPES: readonly NodeType[] = ['artboard', 'frame', 'text', 'image', 'svg', 'code'];

/** Libraries a code layer can import (vendored, pinned; see render/codeLayer.ts for versions). */
export const CODE_LIBRARIES = ['three', 'gsap', 'motion'] as const;
export type CodeLibrary = (typeof CODE_LIBRARIES)[number];

/** A live code layer: an ES module whose default export is `mount(el, ctx)`, run in a sandboxed frame. */
export interface CodeData {
  source: string;
  libraries: CodeLibrary[];
}

/** CSS properties in kebab-case ("background-color", "--brand"), values as CSS text. */
export type StyleMap = Record<string, string>;
export type AttrMap = Record<string, string>;

/**
 * Style sets a node can carry besides its base styles. `hover`, `active` (pressed, CSS :active) and `focus` (:focus-visible) are
 * interaction states; `placeholder` styles the `::placeholder` of an input or textarea (always on, not an interaction: the canvas
 * reset sets `::placeholder { color }`, which an inline style on the input cannot reach).
 */
export const STATE_NAMES = ['hover', 'active', 'focus', 'placeholder'] as const;
export type StateName = (typeof STATE_NAMES)[number];
/** Style overrides per state (kebab-case properties). A state is absent when it has no overrides. */
export type StateStyles = Partial<Record<StateName, StyleMap>>;

/** One stop of a @keyframes rule. `offset` is "from", "to" or a percentage such as "40%". */
export interface KeyframeStop {
  offset: string;
  styles: StyleMap;
}
/** Document-level named @keyframes: name (a CSS identifier) -> stops in ascending offset order. */
export type KeyframesMap = Record<string, KeyframeStop[]>;

export interface ArtboardFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PageKind = 'canvas' | 'deck' | 'video';
export const PAGE_KINDS: readonly PageKind[] = ['canvas', 'deck', 'video'];

/** How a slide (deck) or scene (video) enters. `ms` is the length; `none` is a hard cut. */
export const TRANSITION_KINDS = ['none', 'fade', 'push-left', 'push-up', 'zoom', 'dissolve'] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];
export interface Transition {
  kind: TransitionKind;
  ms: number;
}

/** Default slide / scene size of a deck or video page. */
export const DEFAULT_SLIDE_FORMAT = { width: 1920, height: 1080 } as const;
/** Default scene length of a video, in ms. */
export const DEFAULT_SCENE_MS = 5000;
/** Default frame rate of a video page. */
export const DEFAULT_VIDEO_FPS = 30;

/**
 * A page: a named, ordered group of artboards. The canvas shows one page at a time. A `deck` page's artboards are its
 * slides and a `video` page's artboards are its scenes, both in page order; `canvas` (the default) is free-form.
 */
export interface PageData {
  id: string;
  name: string;
  /** Artboard ids of this page, in the page's order. */
  artboards: string[];
  /** Absent means 'canvas'. */
  kind?: PageKind;
  /** Deck / video: the size of every slide / scene. New ones are created at it. */
  format?: { width: number; height: number };
  /** Deck: the default transition into a slide. Video: the default transition between scenes. */
  transition?: Transition;
  /** Video only; default 30. */
  fps?: number;
}

/** Per-slide (deck) or per-scene (video) data on an artboard of a deck / video page. */
export interface SlideData {
  /** Deck: speaker notes, plain text. */
  notes?: string;
  /** Deck: override of the page transition into this slide. Video: the transition into this scene. */
  transition?: Transition;
  /** Video: scene length in ms (default 5000). */
  durationMs?: number;
}

/**
 * The document's theme (see themes/): a catalog id plus token overrides, or the document's own theme (`base` set): `id` is the slug
 * of `name`, `base` the catalog theme whose tokens it starts from, and `overrides` hold everything that makes it this document's.
 */
export interface ThemeRef {
  id: string;
  /** The document's own theme: its name ("Ferrule"). */
  name?: string;
  /** The document's own theme: the catalog theme it starts from. */
  base?: string;
  overrides?: Record<string, string>;
}

/**
 * A prototype link on a layer. `artboard` points at a screen by id (it survives renames and page moves; when that artboard is
 * deleted the link is "missing": it stays stored so undo brings it back, and nothing happens on click). `url` is an external
 * http, https or mailto address. Layers with a link are clickable in Present mode; edit mode never navigates.
 */
export type NodeLink = { artboard: string } | { url: string };

export interface NodeData {
  id: string;
  type: NodeType;
  name: string;
  /** HTML tag rendered for this node (artboards render as a root div). */
  tag: string;
  styles: StyleMap;
  attrs: AttrMap;
  /** Plain text content (text nodes). */
  text: string;
  /**
   * Sanitized markup: inline rich text for text nodes (e.g. "Hello <b>you</b>"),
   * inner SVG markup for svg nodes. Empty when unused. Takes precedence over `text`.
   */
  html: string;
  children: string[];
  parent: string | null;
  hidden: boolean;
  locked: boolean;
  /** Style overrides for :hover, :active (pressed), :focus-visible and ::placeholder. Rendered as generated stylesheet rules. */
  states: StateStyles;
  /** Live code (code nodes only); null for every other type. */
  code: CodeData | null;
  /** Prototype link (artboards cannot have one); null when unset. */
  link: NodeLink | null;
  /** Canvas placement; artboards only. */
  frame: ArtboardFrame | null;
  /** Slide / scene data; artboards on deck and video pages only. Absent when unset. */
  slide?: SlideData;
  /** Main root of a document component: the component id (see components.ts). Absent otherwise. */
  component?: ComponentId;
  /** Instance root of a document component. Absent otherwise. */
  instance?: InstanceData;
  /** A part of an instance: the id of the main-subtree node it mirrors. Absent otherwise. */
  of?: string;
}

// ---------- document components (model/components.ts) ----------

export type ComponentId = string;

/** What an override or a prop binding writes: `text`, `html`, `hidden`, `attr:<name>` or `style:<property>`. */
export type OverrideField = 'text' | 'html' | 'hidden' | `attr:${string}` | `style:${string}`;

export interface PropBinding {
  /** Main-subtree node id. */
  node: string;
  field: OverrideField;
}

/** A named parameter of a component, mapped onto overrides. Defaults are derived from the main (variant: `default`). */
export type ComponentProp =
  | { name: string; type: 'text'; bind: PropBinding[] }
  | { name: string; type: 'boolean'; nodes: string[]; invert?: boolean }
  | { name: string; type: 'variant'; options: Record<string, Overrides>; default: string };

export type PropValue = string | boolean;

export interface ComponentDef {
  id: ComponentId;
  name: string;
  /** Node id of the main. */
  root: string;
  description?: string;
  props: ComponentProp[];
}

/** Per-layer overrides of one instance; every key is optional and absent means "follows the main". */
export interface NodeOverride {
  text?: string;
  html?: string;
  hidden?: boolean;
  attrs?: Record<string, string>;
  styles?: Record<string, string>;
  /** This instance's own prototype link on the layer (a nav item, a button); false = no link here although the main has one. */
  link?: NodeLink | false;
}

/** Overrides keyed by main-subtree node id (the main root's id keys the instance's own root). */
export type Overrides = Record<string, NodeOverride>;

export interface InstanceData {
  component: ComponentId;
  props?: Record<string, PropValue>;
  overrides?: Overrides;
}

/** An instance with its component resolved (`OcelotDocument.instanceInfo`). */
export interface InstanceInfo {
  id: string;
  component: ComponentDef;
  /** The main's root id: the override key of the instance's own root. */
  mainRoot: string;
  /** Explicit prop values plus the defaults derived from the main. */
  props: Record<string, PropValue>;
  /** Explicit overrides (orphans included). */
  overrides: Overrides;
  /** Override keys whose layer no longer exists in the main (ignored; they come back on undo). */
  orphaned: string[];
}

/** Input shape for creating nodes (possibly nested). */
export interface NodeSpec {
  type: Exclude<NodeType, 'artboard'>;
  tag?: string;
  name?: string;
  styles?: Record<string, string>;
  attrs?: AttrMap;
  text?: string;
  html?: string;
  /** Code layer source and libraries (type "code" only). */
  code?: CodeData;
  states?: StateStyles;
  /** Prototype link (kept by duplicate and copy). */
  link?: NodeLink;
  /** Hidden / locked layers keep that state when duplicated. */
  hidden?: boolean;
  locked?: boolean;
  /**
   * An instance of a document component: the layer's other content is rebuilt from the main (so only `name`, `hidden`, `locked` and
   * `link` count). A component missing from the document makes it an ordinary layer with its `children`.
   */
  instance?: InstanceData;
  children?: NodeSpec[];
}

export const ARTBOARD_PRESETS = {
  desktop: { name: 'Desktop', width: 1440, height: 900 },
  tablet: { name: 'Tablet', width: 768, height: 1024 },
  mobile: { name: 'Mobile', width: 375, height: 812 },
} as const;

export type ArtboardPreset = keyof typeof ARTBOARD_PRESETS;

export const DEFAULT_TAGS: Record<NodeType, string> = {
  artboard: 'div',
  frame: 'div',
  text: 'p',
  image: 'img',
  svg: 'svg',
  code: 'div',
};

/** Node types that may contain child nodes. */
export function isContainer(type: NodeType): boolean {
  return type === 'artboard' || type === 'frame';
}

/**
 * Errors from document operations. Messages are written for whoever called the
 * operation (a human-facing UI or an agent) and say what to do next.
 */
export class ModelError extends Error {
  readonly code: ModelErrorCode;
  constructor(code: ModelErrorCode, message: string) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
  }
}

export type ModelErrorCode =
  | 'not_found'
  | 'invalid_parent'
  | 'invalid_argument'
  | 'locked'
  | 'cycle';
