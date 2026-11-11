// The CSS every artboard renders with. Shared by the canvas iframes, the
// screenshot renderer and the HTML export, so all of them look the same.
//
// It is a reset equivalent to Tailwind's preflight (border-box sizing, no
// default margins/padding, unstyled headings and lists, form controls that
// inherit fonts, line-height 1.5), so a React + Tailwind export renders exactly
// like the canvas. Designers get predictable layout: nothing has hidden
// browser-default spacing.

import { BUNDLED_FONT_FACE_CSS } from '../themes/fonts';

// Must equal Tailwind's default --font-sans / --font-mono (checked by frameDocument.test.ts).
export const DEFAULT_FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'";
export const MONO_FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

/** Reset matching Tailwind preflight semantics. */
export const RESET_CSS = `
*, ::before, ::after, ::backdrop { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid; }
html { line-height: 1.5; -webkit-text-size-adjust: 100%; tab-size: 4; font-family: ${DEFAULT_FONT_STACK}; -webkit-tap-highlight-color: transparent; }
hr { height: 0; color: inherit; border-top-width: 1px; }
abbr:where([title]) { text-decoration: underline dotted; }
h1, h2, h3, h4, h5, h6 { font-size: inherit; font-weight: inherit; }
a { color: inherit; text-decoration: inherit; }
b, strong { font-weight: bolder; }
code, kbd, samp, pre { font-family: ${MONO_FONT_STACK}; font-size: 1em; }
small { font-size: 80%; }
sub, sup { font-size: 75%; line-height: 0; position: relative; vertical-align: baseline; }
sub { bottom: -0.25em; }
sup { top: -0.5em; }
table { text-indent: 0; border-color: inherit; border-collapse: collapse; }
progress { vertical-align: baseline; }
summary { display: list-item; }
ol, ul, menu { list-style: none; }
img, svg, video, canvas, audio, iframe, embed, object { display: block; vertical-align: middle; }
img, video { max-width: 100%; height: auto; }
button, input, select, optgroup, textarea, ::file-selector-button { font: inherit; font-feature-settings: inherit; font-variation-settings: inherit; letter-spacing: inherit; color: inherit; border-radius: 0; background-color: transparent; opacity: 1; }
::placeholder { opacity: 1; color: color-mix(in oklab, currentcolor 50%, transparent); }
textarea { resize: vertical; }
button, input:where([type="button"], [type="reset"], [type="submit"]), ::file-selector-button { appearance: button; }
:-moz-focusring { outline: auto; }
[hidden]:where(:not([hidden="until-found"])) { display: none !important; }
`.trim();

/** Page frame for one artboard: body fills the viewport, the artboard root fills the body. */
export const ARTBOARD_BASE_CSS = `
${RESET_CSS}
${BUNDLED_FONT_FACE_CSS}
html, body { height: 100%; }
body { overflow: hidden; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
[data-ocelot-root] { position: relative; width: 100%; height: 100%; }
`.trim();

/** Editor-only rules (never exported). */
export const ARTBOARD_EDITOR_CSS = `
[data-ocelot-hidden] { display: none !important; }
/* Present mode: layers with a link (hotspots) read as clickable. */
html[data-ocelot-present] [data-ocelot-link-artboard], html[data-ocelot-present] [data-ocelot-link-url] { cursor: pointer; }
html[data-ocelot-paused] *, html[data-ocelot-paused] ::before, html[data-ocelot-paused] ::after { animation-play-state: paused !important; }
`.trim();

export function artboardSrcdoc(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${ARTBOARD_BASE_CSS}\n${ARTBOARD_EDITOR_CSS}</style></head><body></body></html>`;
}
