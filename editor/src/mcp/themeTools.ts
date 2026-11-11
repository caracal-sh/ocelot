// MCP tools for themes: `list_themes`, `get_theme`, `apply_theme`, `create_theme` (the document's own, task-specific theme). The Assets > Styles gallery (panels/ThemeGallery.tsx) uses the same
// operations (themes/apply.ts), so a human and an agent get the same tokens, the same one-step undo and the same contrast report.

import { COLOR_TOKENS, THEMES, type ThemeDefinition } from '../themes/catalog';
import { applyThemeOps, requireTheme, type ThemeApplyReport } from '../themes/apply';
import { isOwnTheme, planOwnTheme, requireThemeOf, themeOfRef } from '../themes/custom';
import { contrastReport, truncate2, type ContrastReport } from '../themes/contrast';
import { familiesOf } from '../themes/fonts';
import { rememberTheme, revertTarget } from '../themes/actions';
import { effectiveColors, groupTokens, normalizeOverrides, themeTokens, ThemeError } from '../themes/tokens';
import type { ThemeRef } from '../model/types';
import { ToolError, agentLabel, json, layerLockOf, str, write, type Args, type ToolContext, type ToolDef } from './toolkit';

/** First family of a font stack: "Geist". */
function primaryFamily(stack: string): string {
  return familiesOf(stack)[0] ?? stack;
}

function contrastSummary(report: ContrastReport) {
  return {
    pairs: report.rows.length,
    lowest_text_ratio: truncate2(report.lowestText),
    lowest_ratio: truncate2(report.lowest),
    all_pass: report.pass,
  };
}

function failingRows(report: ContrastReport) {
  return report.failing.map((r) => `${r.label}: ${truncate2(r.ratio)}:1 (needs ${r.min}:1)`);
}

function themeSummary(t: ThemeDefinition) {
  return {
    id: t.id,
    name: t.name,
    mood: t.mood,
    scheme: t.scheme,
    best_for: t.useFor,
    avoid_for: t.avoidFor,
    swatches: { canvas: t.colors.canvas, surface: t.colors.surface, ink: t.colors.ink, accent: t.colors.accent, accent_soft: t.colors['accent-soft'] },
    fonts: { display: primaryFamily(t.fonts.display), sans: primaryFamily(t.fonts.sans), mono: primaryFamily(t.fonts.mono) },
    contrast: contrastSummary(contrastReport(t)),
  };
}

function toolError(err: unknown): never {
  if (err instanceof ThemeError) throw new ToolError(err.message);
  throw err;
}

/** A document's theme as the tools name it: id, name, whether it is the document's own, and its overrides. */
function refSummary(ref: ThemeRef) {
  return { id: ref.id, name: themeOfRef(ref)?.name ?? ref.id, ...(isOwnTheme(ref) ? { own: true, based_on: ref.base } : {}), ...(ref.overrides ? { overrides: ref.overrides } : {}) };
}

function currentRef(ctx: ToolContext) {
  const ref = ctx.editor.doc.theme();
  return ref ? { ref, theme: themeOfRef(ref) ?? null } : null;
}

/** The theme Revert returns to: `{ id: "none" }` when that was no theme; undefined when no switch was made yet. */
function previousTheme(ctx: ToolContext) {
  const target = revertTarget(ctx.editor);
  if (!target) return undefined;
  const ref = target.ref;
  if (!ref) return { id: 'none', name: 'No theme' };
  return refSummary(ref);
}

function describeApplied(report: ThemeApplyReport) {
  const ref = report.theme;
  return {
    theme: ref ? refSummary(ref) : null,
    artboards_updated: report.artboards,
    ...(report.skipped.length ? { skipped_layer_locked: report.skipped } : {}),
    ...(report.kept.length ? { kept_your_root_styles: report.kept } : {}),
    ...(report.contrast && !report.contrast.pass ? { contrast_warnings: failingRows(report.contrast) } : {}),
    next: ref
      ? 'Design with the tokens: color: var(--theme-color-ink), background: var(--theme-color-surface), border-radius: var(--theme-radius-lg), box-shadow: var(--theme-shadow-2), font-family: var(--theme-font-display). get_theme returns every token, the rules and example button/card CSS. Screenshot after writing.'
      : 'The --theme-* tokens were removed from every artboard; layers that referenced var(--theme-…) now fall back to inherited values. Apply another theme or restyle with plain values.',
  };
}

export const THEME_TOOLS: ToolDef[] = [
  {
    name: 'list_themes',
    title: 'List themes',
    readOnly: true,
    description:
      'The theme catalog: 12 ready-made visual systems plus a dark Ocelot Default (and, when the document has one, its own theme as "own"). Each has an id, a mood word, light/dark scheme, what it is best and worst for, swatches, its fonts (bundled, they render offline) ' +
      'and a contrast summary (every text/background pair is verified: ink 7:1, other text 4.5:1, borders and focus 3:1). Also returns the theme the document currently has. ' +
      'Call it when the user names a style ("brutalist", "glassy", "editorial") and pick the theme that matches, then apply_theme. With no direction and no theme, derive a system for the task with create_theme instead. Skip it when the user brought their own design system.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, ctx) {
      const cur = currentRef(ctx);
      return json({
        current: cur ? refSummary(cur.ref) : null,
        ...(cur?.theme && isOwnTheme(cur.ref) ? { own: themeSummary(cur.theme) } : {}),
        themes: THEMES.map(themeSummary),
        next: 'apply_theme {"theme_id": "<id>"} applies one to every artboard in one undo step; get_theme {"theme_id": "<id>"} shows the tokens, rules and example CSS first. None fits the brief: create_theme derives a system for this task.',
      });
    },
  },
  {
    name: 'get_theme',
    title: 'Get a theme and its tokens',
    readOnly: true,
    description:
      'Without theme_id: the document\'s current theme, its overrides and the token values every artboard root carries (null when no theme was applied). With theme_id: that catalog theme (without applying it). ' +
      'Returns the mood, when to use it, the rules that keep it working, every token as a CSS custom property you can reference as var(--theme-…) (colours, fonts, type scale with line-height/weight/tracking, radii, shadows, spacing, motion, theme extras), ' +
      'the contrast verification, and example button + card CSS written with the tokens. Read it before designing inside a theme.',
    inputSchema: {
      type: 'object',
      properties: { theme_id: { type: 'string', description: 'A catalog id from list_themes, e.g. "soft-machine". Omit for the document\'s current theme.' } },
      additionalProperties: false,
    },
    run(args, ctx) {
      const id = str(args, 'theme_id', { optional: true });
      const cur = currentRef(ctx);
      if (id === undefined && !cur) {
        const prev = previousTheme(ctx);
        return json({ theme: null, ...(prev ? { previous_theme: prev } : {}), note: 'This document has no theme. list_themes shows the catalog; apply_theme {"theme_id": "..."} applies one.' });
      }
      let theme: ThemeDefinition;
      try {
        theme = id !== undefined ? (cur && id.toLowerCase() === cur.ref.id ? requireThemeOf(cur.ref) : requireTheme(id)) : (cur?.theme ?? requireThemeOf(cur!.ref));
      } catch (err) {
        return toolError(err);
      }
      const applied = cur?.ref.id === theme.id;
      const overrides = applied ? (cur!.ref.overrides ?? {}) : {};
      const report = contrastReport(theme, effectiveColors(theme, overrides));
      return json({
        id: theme.id,
        name: theme.name,
        ...(applied && isOwnTheme(cur!.ref) ? { own: true, based_on: cur!.ref.base, set_explicitly: Object.keys(cur!.ref.overrides ?? {}), derived_colors: COLOR_TOKENS.map((c) => `--theme-color-${c}`).filter((k) => !(k in (cur!.ref.overrides ?? {}))) } : {}),
        applied,
        ...(previousTheme(ctx) ? { previous_theme: previousTheme(ctx) } : {}),
        ...(applied && cur!.ref.overrides ? { overrides: cur!.ref.overrides } : {}),
        mood: `${theme.mood}: ${theme.moodLine}`,
        scheme: theme.scheme,
        best_for: theme.useFor,
        avoid_for: theme.avoidFor,
        rules: theme.rules,
        motion: theme.motion.personality,
        spacing_scale_px: theme.spacing.steps,
        tokens: groupTokens(themeTokens(theme, overrides)),
        contrast: { ...contrastSummary(report), ...(report.pass ? {} : { failing: failingRows(report) }) },
        example_css: theme.example,
        usage:
          'Reference tokens with var(--theme-…) in any style value (update_styles, write_html, set_state_styles, keyframes). Text step: ' +
          'font-size: var(--theme-text-xl); line-height: var(--theme-text-xl--line-height); font-weight: var(--theme-text-xl--weight); letter-spacing: var(--theme-text-xl--tracking). ' +
          'Do not invent hex values: text colours come from --theme-color-ink / ink-2 / ink-3 on canvas / surface / surface-2, accent-ink on accent, accent-text for links.',
      });
    },
  },
  {
    name: 'apply_theme',
    title: 'Apply a theme',
    readOnly: false,
    description:
      'Applies a catalog theme to the whole document as ONE undo step: writes the --theme-* tokens (colours, bundled fonts, type scale, radii, shadows, spacing, motion) on every artboard of every page, ' +
      'binds each artboard\'s background, text colour and font to them (only where the artboard still has its default white background or no value of its own), and remembers the theme in the document. ' +
      'Existing layers that use plain values do not change; layers written with var(--theme-…) restyle instantly, so design with the tokens (get_theme lists them) and switching themes later restyles every page. ' +
      'overrides changes single tokens of the chosen theme, e.g. {"color-accent": "#e11d48", "radius-lg": "16px"} (names without --theme-); the result warns when an override breaks a contrast pair. ' +
      'With the id of the document\'s own theme (create_theme), overrides are merged into it: that is how you change a token of it later. ' +
      'theme_id "none" removes the theme and its tokens again; theme_id "previous" goes back to the theme the document had before the last switch (the gallery\'s Revert; get_theme returns it as previous_theme) and refuses when no switch was made yet. New artboards created afterwards inherit the theme. Layers the user locked in the layers panel are skipped and reported.',
    inputSchema: {
      type: 'object',
      properties: {
        theme_id: { type: 'string', description: 'A catalog id from list_themes (e.g. "aurora"), the id of the document\'s own theme (create_theme) to change its tokens, "none" to remove the theme, or "previous" to revert to the theme before the last switch.' },
        overrides: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Token overrides: { "color-accent": "#e11d48" }. Keys are token names without the --theme- prefix; values are plain CSS. get_theme lists the tokens.',
        },
      },
      required: ['theme_id'],
      additionalProperties: false,
    },
    run(args: Args, ctx) {
      const id = str(args, 'theme_id', {});
      const raw = args['overrides'];
      if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Object.values(raw).every((v) => typeof v === 'string'))) {
        throw new ToolError('overrides must be an object of token name to CSS value, e.g. {"color-accent": "#e11d48"}.');
      }
      const overrides = raw as Record<string, string> | undefined;
      try {
        const before = ctx.editor.doc.theme();
        let ref: ThemeRef | null;
        let theme: ThemeDefinition | null;
        let revert = false;
        if (id.toLowerCase() === 'previous') {
          if (overrides) throw new ThemeError('"previous" restores the earlier theme exactly as it was; drop overrides, or apply the theme by its id and send overrides with it.');
          const target = revertTarget(ctx.editor);
          if (!target) throw new ThemeError('There is no previous theme: no theme switch was made in this session. Send a catalog id from list_themes (or "none") instead.');
          if (JSON.stringify(target.ref) === JSON.stringify(before)) throw new ThemeError(`The document already has the previous theme (${target.ref ? `"${target.ref.id}"` : 'none'}). get_theme returns previous_theme.`);
          ref = target.ref;
          theme = ref ? requireThemeOf(ref) : null;
          revert = true;
        } else if (before && isOwnTheme(before) && id.toLowerCase() === before.id) {
          // The document's own theme: overrides change tokens of it (they merge), they never reset it to its base.
          theme = requireThemeOf(before);
          ref = null;
        } else {
          theme = id.toLowerCase() === 'none' ? null : requireTheme(id);
          ref = null;
        }
        if (!theme && overrides) throw new ThemeError('"none" removes the theme; overrides only apply to a theme. Send theme_id with a catalog id, or drop overrides.');
        if (!revert && theme && before && isOwnTheme(before) && theme.id === before.id) {
          const merged = { ...(before.overrides ?? {}), ...(overrides ? normalizeOverrides(theme, overrides) : {}) };
          ref = { ...before, ...(Object.keys(merged).length ? { overrides: merged } : {}) };
        } else if (!revert) ref = theme ? { id: theme.id, ...(overrides ? { overrides: normalizeOverrides(theme, overrides) } : {}) } : null;
        const applied = ref;
        const report = write(ctx, theme ? `${revert ? 'Revert to' : 'Apply'} theme ${theme.name}` : revert ? 'Revert to no theme' : 'Remove theme', () =>
          applyThemeOps(ctx.editor.doc, ctx.editor.agent, applied, { isLocked: (aid) => layerLockOf(ctx, aid) !== null }),
        );
        // A real switch (not a token tweak, not a revert) is what Revert returns from; the gallery's Revert and this tool share it.
        if (!revert && before?.id !== applied?.id) rememberTheme(ctx.editor, before);
        ctx.editor.ui.toast(revert ? `${agentLabel(ctx)} reverted the theme${theme ? ` to “${theme.name}”` : ' (no theme)'}.` : theme ? `${agentLabel(ctx)} applied the theme “${theme.name}”.` : `${agentLabel(ctx)} removed the theme.`, 'agent');
        return json(describeApplied(report));
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: 'create_theme',
    title: 'Create a theme for this document',
    readOnly: false,
    description:
      'Derives the document\'s own, task-specific system and applies it as ONE undo step: a named theme (e.g. "Ferrule") with the palette, type families and scale, radii, shadows, spacing and motion this brief calls for, written as --theme-* tokens on every artboard so layers use var(--theme-…) and the person can adjust the system later in Assets > Styles. ' +
      'Use it when the document has no theme or design system and the person named no style: before the first write. tokens is { "color-canvas": "#F4EDE1", "color-ink": "#2A1B12", "color-accent": "#B4451F", "font-display": "Fraunces", "font-sans": "Geist", "radius-lg": "6px", "text-5xl": "72px", … } (names without --theme-; same names as apply_theme overrides; get_theme lists them). ' +
      'color-canvas, color-ink and color-accent are required. Every other colour (surface, surface-2, ink-2, ink-3, accent-ink, accent-text, accent-soft, accent-hover, line, line-subtle, focus, danger, success) is derived from them so that every text pair passes (ink 7:1, other text 4.5:1, borders, focus and the accent 3:1), or you set it yourself and it is measured. ' +
      'It refuses a palette that fails contrast and names the pair. A bare font family ("Fraunces") becomes a stack; bundled families (list_fonts) render everywhere. Everything you leave out comes from based_on (a catalog id from list_themes; default the neutral Ocelot Default, or its dark twin when scheme is "dark" or the canvas is dark): its type scale, radii, shadows, spacing, motion and extra tokens. ' +
      'Calling it again replaces the document\'s theme (also a stock one); change single tokens later with apply_theme using the theme\'s id and overrides. The person picks a stock theme or design system themselves: then use that one, not this. Not for product UI built from components (create_design_system).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The system\'s name, 2-40 characters, for this task: "Ferrule". Its slug is the theme id.' },
        tokens: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Token name (without --theme-) to CSS value: color-canvas, color-ink and color-accent (required), any other color-*, font-display / font-sans / font-mono (a family name or a full stack), text-xs … text-5xl (and --line-height, --weight, --tracking suffixes), radius-sm … radius-full, shadow-*, spacing, duration-*, ease-*.',
        },
        based_on: { type: 'string', description: 'Optional catalog theme id whose type scale, radii, shadows, spacing, motion and extras the system starts from. Its colours are not used.' },
        scheme: { type: 'string', enum: ['light', 'dark'], description: 'Optional; read from the canvas colour when omitted.' },
      },
      required: ['name', 'tokens'],
      additionalProperties: false,
    },
    run(args: Args, ctx) {
      const name = str(args, 'name', {});
      const raw = args['tokens'];
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Object.values(raw).every((v) => typeof v === 'string')) {
        throw new ToolError('tokens must be an object of token name to CSS value, e.g. {"color-canvas": "#F4EDE1", "color-ink": "#2A1B12", "color-accent": "#B4451F"}.');
      }
      const basedOn = str(args, 'based_on', { optional: true });
      const scheme = str(args, 'scheme', { optional: true });
      if (scheme !== undefined && scheme !== 'light' && scheme !== 'dark') throw new ToolError('scheme is "light" or "dark".');
      try {
        const before = ctx.editor.doc.theme();
        const plan = planOwnTheme({ name, tokens: raw as Record<string, string>, ...(basedOn !== undefined ? { basedOn } : {}), ...(scheme !== undefined ? { scheme } : {}) });
        const report = write(ctx, `Create theme ${plan.ref.name}`, () =>
          applyThemeOps(ctx.editor.doc, ctx.editor.agent, plan.ref, { isLocked: (aid) => layerLockOf(ctx, aid) !== null }),
        );
        if (JSON.stringify(before) !== JSON.stringify(plan.ref)) rememberTheme(ctx.editor, before);
        ctx.editor.ui.toast(`${agentLabel(ctx)} created the theme “${plan.ref.name}”.`, 'agent');
        const tokens = groupTokens(themeTokens(plan.theme, plan.ref.overrides));
        return json({
          ...describeApplied(report),
          derived_colors: plan.derived,
          tokens: { colors: tokens.colors, fonts: tokens.fonts, radii: tokens.radii },
          contrast: contrastSummary(plan.report),
          ...(plan.notes.length ? { notes: plan.notes } : {}),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  },
];
