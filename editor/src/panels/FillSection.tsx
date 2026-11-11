// Inspector "Fill" section: an ordered stack of fills (top first) — solid colors, linear/radial gradients and an image —
// serialized into CSS background layers by panels/fills.ts (the same code the MCP `set_fill` tool uses).
// Rows: swatch (opens the color picker, or the gradient's stop editor), type, "…" menu (move, duplicate, convert), "−".

import { useState } from 'react';
import { Icon } from '../app/Icon';
import { computedStyleOf } from '../canvas/geometry';
import { DEFAULT_FILL_COLOR, FILL_PROPS, convertFill, fillsToStyles, isGradient, layerCss, newGradient, parseFills, type Fill, type FillStyles } from './fills';
import { ColorRow, Field, IconButton, MenuButton, Section, type Option } from './fields';
import { GradientEditor } from './GradientEditor';
import { BackgroundImageSection } from './ImageSection';
import type { StyleCtx } from './StyleSections';

const TYPES: Option[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
];

export function FillSection({ ctx }: { ctx: StyleCtx }) {
  const { editor, nodes, editState, common, set } = ctx;
  const first = nodes[0]!;
  const [imageFor, setImageFor] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const raw: Record<string, string | null> = Object.fromEntries(FILL_PROPS.map((p) => [p, common(p)]));
  const mixed = Object.values(raw).some((v) => v === null);
  const fills = mixed ? null : parseFills(raw as FillStyles);
  const image = nodes.length === 1 && !editState && (first.type === 'frame' || first.type === 'artboard');
  const hasImage = image && !!first.styles['background-image'];
  const showImage = image && (hasImage || imageFor === first.id);
  const computedBg = computedStyleOf(editor, first.id)?.backgroundColor;

  const write = (next: Fill[], live = false) => set(fillsToStyles(next), { gesture: live });
  const list = fills ?? [];
  const update = (i: number, fill: Fill, live = false) => write(list.map((f, k) => (k === i ? fill : f)), live);
  const remove = (i: number) => {
    setOpen(null);
    write(list.filter((_, k) => k !== i));
  };
  const move = (i: number, to: number) => {
    const next = [...list];
    const [f] = next.splice(i, 1);
    next.splice(to, 0, f!);
    setOpen((o) => (o === i ? to : o));
    write(next);
  };
  const add = (fill: Fill) => {
    write([fill, ...list]);
    setOpen(isGradient(fill) ? 0 : null);
  };
  const addColor = () => add({ type: 'solid', color: DEFAULT_FILL_COLOR });
  const topColor = list.find((f) => f.type === 'solid');
  const base = topColor?.type === 'solid' ? topColor.color : DEFAULT_FILL_COLOR;

  const addItems = [
    { id: 'fill-color', label: 'Color', onSelect: addColor },
    { id: 'fill-linear', label: 'Linear gradient', onSelect: () => add(newGradient('linear', base)) },
    { id: 'fill-radial', label: 'Radial gradient', onSelect: () => add(newGradient('radial', base)) },
    ...(image ? [{ id: 'fill-image', label: 'Image…', disabled: showImage, reason: 'The background image is already shown below.', onSelect: () => setImageFor(first.id) }] : []),
  ];

  const empty = !mixed && list.length === 0 && !showImage;
  return (
    <Section title="Fill" testId="fill-section" empty={empty} add={<MenuButton icon="plus" title="Add fill" testId="fill-add" items={addItems} />}>
      {mixed && (
        <ColorRow label="Fill" value={null} testId="field-background" onCommit={(v) => set(fillsToStyles(v ? [{ type: 'solid', color: v }] : []))} onRemove={() => set(fillsToStyles([]))} />
      )}
      {!mixed && fills === null && (
        // Something the editor cannot take apart (several backgrounds with extras, `background-attachment`…): edit it as CSS.
        <div className="at-irow">
          <Field label="CSS" title="Background (CSS)" value={common('background') || common('background-image') || common('background-color') || ''} testId="field-background" onCommit={(v) => set({ ...fillsToStyles([]), background: v.trim() || null })} />
          <IconButton icon="minus" title="Remove fill" onClick={() => set(fillsToStyles([]))} />
        </div>
      )}
      {list.map((fill, i) => {
        const rowMenu = (
          <MenuButton
            icon="more"
            title="Fill options"
            testId={`fill-menu-${i}`}
            items={[
              { id: `fill-up-${i}`, label: 'Move up', disabled: i === 0, reason: 'This is already the top fill.', onSelect: () => move(i, i - 1) },
              { id: `fill-down-${i}`, label: 'Move down', disabled: i === list.length - 1, reason: 'This is already the bottom fill.', onSelect: () => move(i, i + 1) },
              { id: `fill-dup-${i}`, label: 'Duplicate', onSelect: () => write([...list.slice(0, i + 1), structuredClone(fill), ...list.slice(i + 1)]) },
              ...(fill.type === 'solid' || isGradient(fill)
                ? (['solid', 'linear', 'radial'] as const).filter((t) => t !== fill.type).map((t) => ({ id: `fill-to-${t}-${i}`, label: `Convert to ${t}`, separatorBefore: t === (fill.type === 'solid' ? 'linear' : 'solid'), onSelect: () => { update(i, convertFill(fill, t)); setOpen(t === 'solid' ? null : i); } }))
                : []),
            ]}
          />
        );
        if (fill.type === 'solid') {
          // Only the bottom color layer reads the element's computed color; upper solids are real layers.
          return (
            <ColorRow
              key={i}
              label={list.length > 1 ? `Fill ${i + 1}` : 'Fill'}
              value={fill.color}
              computed={i === list.length - 1 ? computedBg : undefined}
              testId={i === 0 ? 'field-background' : `field-background-${i}`}
              onCommit={(v, live) => (v ? update(i, { type: 'solid', color: v }, live) : remove(i))}
              actions={rowMenu}
              onRemove={() => remove(i)}
            />
          );
        }
        if (isGradient(fill)) {
          return (
            <div key={i} className="at-fill" data-testid={`fill-row-${i}`}>
              <div className="at-irow">
                <div className="at-ifld at-ifld--select at-icolor">
                  <span className="at-iswatch" style={{ '--at-swatch': layerCss(fill) } as React.CSSProperties}>
                    <button type="button" className="at-iswatch__btn" aria-label={`Edit ${fill.type} gradient`} aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)} data-testid={`fill-gradient-toggle-${i}`} />
                  </span>
                  <select
                    className="at-iinput"
                    value={fill.type}
                    aria-label="Fill type"
                    data-testid={`fill-type-${i}`}
                    onChange={(e) => {
                      const t = e.currentTarget.value as 'solid' | 'linear' | 'radial';
                      update(i, convertFill(fill, t));
                      if (t === 'solid') setOpen(null);
                    }}
                  >
                    {TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                {rowMenu}
                <IconButton icon="minus" title="Remove fill" onClick={() => remove(i)} />
              </div>
              {open === i && <GradientEditor fill={fill} onChange={(g, live) => update(i, g, live)} />}
            </div>
          );
        }
        // Image and CSS layers.
        return (
          <div key={i} className="at-irow" data-testid={`fill-row-${i}`}>
            {fill.type === 'image' ? (
              <div className="at-ifld at-icolor at-fill__label">
                <span className="at-iswatch at-iswatch--image" aria-hidden="true">
                  <Icon name="image" size={10} />
                </span>
                <span className="at-fill__name">Image</span>
              </div>
            ) : (
              <Field
                label="CSS"
                title="Background layer (CSS image function)"
                value={fill.value}
                testId={`fill-css-${i}`}
                onCommit={(v) => {
                  const next = parseFills({ background: v.trim() });
                  update(i, next && next.length === 1 ? next[0]! : { type: 'css', value: v.trim() });
                }}
              />
            )}
            {rowMenu}
            <IconButton icon="minus" title={`Remove ${fill.type === 'image' ? 'image' : 'layer'}`} onClick={() => remove(i)} />
          </div>
        );
      })}
      {showImage && <BackgroundImageSection node={first} />}
    </Section>
  );
}
