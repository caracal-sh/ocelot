// Inspector: a layer's prototype link. Target None / Screen / URL; collapsed while the layer has no link. Every change is one
// undo step through `editor.actions`; an agent can do the same with set_link.

import { useState } from 'react';
import type { Editor } from '../editor/Editor';
import { checkExternalUrl, inferExternalUrl, isExternalLink, isInternalLink, linkEquals, resolveLink } from '../model/links';
import type { NodeData } from '../model/types';
import { Field, MenuButton, Section, SelectField } from './fields';

type Kind = 'screen' | 'url';

/** Artboard picker grouped by page (a single page lists its screens flat). */
function ScreenSelect({ editor, value, missing }: { editor: Editor; value: string; missing: string | null }) {
  const pages = editor.doc.pageList();
  const options = (ids: string[]) =>
    ids.map((id) => (
      <option key={id} value={id}>
        {editor.doc.require(id).name}
      </option>
    ));
  return (
    <label className="at-ifld at-ifld--select at-ifld--span" data-tip="Screen to open">
      <select
        className="at-iinput"
        value={missing ?? value}
        aria-label="Screen to open"
        data-testid="link-screen"
        onChange={(e) => {
          const id = e.currentTarget.value;
          if (id) editor.actions.setLink(editor.selection.ids, { artboard: id });
        }}
      >
        {missing ? (
          <option value={missing} disabled>
            Missing screen
          </option>
        ) : (
          <option value="" disabled hidden>
            Choose a screen…
          </option>
        )}
        {pages.length > 1
          ? pages.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {options(p.artboards)}
              </optgroup>
            ))
          : options(pages.flatMap((p) => p.artboards))}
      </select>
    </label>
  );
}

export function LinkSection({ editor, nodes }: { editor: Editor; nodes: NodeData[] }) {
  // "Screen" / "URL" can be chosen before there is a target to store; remembered for this selection only.
  const [pending, setPending] = useState<{ key: string; kind: Kind } | null>(null);
  if (editor.ui.editingState || nodes.some((n) => n.type === 'artboard')) return null;
  const ids = nodes.map((n) => n.id);
  const key = ids.join(',');
  const first = nodes[0]!.link;
  const same = nodes.every((n) => linkEquals(n.link, first));
  const mine = pending?.key === key ? pending.kind : null;
  const kind: Kind | 'mixed' | null = mine ?? (!same ? 'mixed' : first ? (isInternalLink(first) ? 'screen' : 'url') : null);
  const resolved = same ? resolveLink(editor.doc, first) : null;
  const missing = !mine && resolved?.kind === 'missing' ? resolved.artboardId : null;
  const set = (link: Parameters<typeof editor.actions.setLink>[1]) => {
    setPending(null);
    editor.actions.setLink(ids, link);
  };

  const commitUrl = (raw: string) => {
    const typed = raw.trim();
    if (!typed) {
      set(null);
      return;
    }
    const url = inferExternalUrl(typed);
    const check = checkExternalUrl(url);
    if (!check.ok) {
      editor.ui.toast(check.reason, 'warn');
      return;
    }
    set({ url: check.url });
  };

  return (
    <Section
      title="Link"
      testId="link-section"
      empty={kind === null}
      meta={missing ? <span className="at-hint--error" data-testid="link-missing">missing target</span> : undefined}
      add={
        kind === null ? (
          <MenuButton
            icon="plus"
            title="Add link"
            testId="link-add"
            items={[
              { id: 'link-screen', label: 'Screen…', onSelect: () => setPending({ key, kind: 'screen' }) },
              { id: 'link-url', label: 'URL…', onSelect: () => setPending({ key, kind: 'url' }) },
            ]}
          />
        ) : undefined
      }
    >
      <SelectField
        label="To"
        title="Link target"
        value={kind === 'mixed' ? null : (kind ?? '')}
        unset="None"
        options={[
          { value: 'screen', label: 'Screen' },
          { value: 'url', label: 'URL' },
        ]}
        onChange={(v) => {
          if (v === '') set(null);
          else if (v !== kind) setPending({ key, kind: v as Kind });
        }}
        testId="link-kind"
      />
      {kind === 'screen' && <ScreenSelect editor={editor} value={first && isInternalLink(first) ? first.artboard : ''} missing={missing} />}
      {kind === 'url' && (
        <Field
          title="Link URL"
          label="URL"
          span
          placeholder="https://example.com"
          value={first && isExternalLink(first) && same ? first.url : ''}
          onCommit={commitUrl}
          testId="link-url"
        />
      )}
      {missing && <div className="at-hint at-hint--error">Missing target: that screen was deleted. Pick another screen or choose None.</div>}
      {kind === 'url' && <div className="at-hint">Opens in the default browser when presenting.</div>}
    </Section>
  );
}
