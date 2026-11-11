// MCP tools for themes: `list_themes`, `get_theme`, `apply_theme`. The Assets > Styles gallery (panels/ThemeGallery.tsx) uses the same
// operations (themes/apply.ts), so a human and an agent get the same tokens, the same one-step undo and the same contrast report.

import { THEMES, themeById, type ThemeDefinition } from '../themes/catalog';
import { applyThemeOps, requireTheme, type ThemeApplyReport } from '../themes/apply';
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

function currentRef(ctx: ToolContext) {
  const ref = ctx.editor.doc.theme();
  return ref ? { ref, theme: themeById(ref.id) ?? null } : null;
}

/** The theme Revert returns to: `{ id: "none" }` when that was no theme; undefined when no switch was made yet. */
function previousTheme(ctx: ToolContext) {
  const target = revertTarget(ctx.editor);
  if (!target) return undefined;
  const ref = target.ref;
  if (!ref) return { id: 'none', name: 'No theme' };
  return { id: ref.id, name: themeById(ref.id)?.name ?? ref.id, ...(ref.overrides ? { overrides: ref.overrides } : {}) };
}

function describeApplied(report: ThemeApplyReport) {
  const ref = report.theme;
  const theme = ref ? themeById(ref.id) : undefined;
  return {
    theme: ref ? { id: ref.id, name: theme?.name ?? ref.id, ...(ref.overrides ? { overrides: ref.overrides } : {}) } : null,
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
      'The theme catalog: 12 ready-made visual systems plus a dark Ocelot Default. Each has an id, a mood word, light/dark scheme, what it is best and worst for, swatches, its fonts (bundled, they render offline) ' +
      'and a contrast summary (every text/background pair is verified: ink 7:1, other text 4.5:1, borders and focus 3:1). Also returns the theme the document currently has. ' +
      'Call it when the user names a style ("brutalist", "glassy", "editorial") or gives no direction, pick the theme that fits the product, then apply_theme. Skip it when the user brought their own design system.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, ctx) {
      const cur = currentRef(ctx);
      return json({
        current: cur ? { id: cur.ref.id, name: cur.theme?.name ?? cur.ref.id, ...(cur.ref.overrides ? { overrides: cur.ref.overrides } : {}) } : null,
        themes: THEMES.map(themeSummary),
        next: 'apply_theme {"theme_id": "<id>"} applies one to every artboard in one undo step; get_theme {"theme_id": "<id>"} shows the tokens, rules and example CSS first.',
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
        theme = id !== undefined ? requireTheme(id) : (cur?.theme ?? requireTheme(cur!.ref.id));
      } catch (err) {
        return toolError(err);
      }
      const applied = cur?.ref.id === theme.id;
      const overrides = applied ? (cur!.ref.overrides ?? {}) : {};
      const report = contrastReport(theme, effectiveColors(theme, overrides));
      return json({
        id: theme.id,
        name: theme.name,
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
      'theme_id "none" removes the theme and its tokens again; theme_id "previous" goes back to the theme the document had before the last switch (the gallery\'s Revert; get_theme returns it as previous_theme) and refuses when no switch was made yet. New artboards created afterwards inherit the theme. Layers the user locked in the layers panel are skipped and reported.',
    inputSchema: {
      type: 'object',
      properties: {
        theme_id: { type: 'string', description: 'A catalog id from list_themes (e.g. "aurora"), "none" to remove the theme, or "previous" to revert to the theme before the last switch.' },
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
          theme = ref ? requireTheme(ref.id) : null;
          revert = true;
        } else {
          theme = id.toLowerCase() === 'none' ? null : requireTheme(id);
          ref = null;
        }
        if (!theme && overrides) throw new ThemeError('"none" removes the theme; overrides only apply to a theme. Send theme_id with a catalog id, or drop overrides.');
        if (!revert) ref = theme ? { id: theme.id, ...(overrides ? { overrides: normalizeOverrides(theme, overrides) } : {}) } : null;
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
];
