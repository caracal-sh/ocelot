// The studio's preset code: paste a shadcn preset code (b2fA) into the draft, copy the draft's own code. Applying only patches the draft
// (nothing in the document changes until Apply); a code that cannot be read stays in the field with the reason under it.

import { useId, useMemo, useState } from 'react';
import type { Host } from '../host/host';
import { presetCodeOf } from '../designsystem/knobs';
import type { DesignSystemRecord } from '../designsystem/model';
import { useEditor } from '../editor/context';
import './DsPresetCode.css';

export interface DsPresetCodeProps {
  draft: DesignSystemRecord;
  /** Applies the code to the draft: null when it went in, else what to tell the user. */
  onApply(code: string): string | null;
  /** The clipboard of the Mac app; a browser without one uses `navigator.clipboard`. */
  host?: Host;
}

export function DsPresetCode({ draft, onApply, host }: DsPresetCodeProps) {
  const editor = useEditor();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const preset = useMemo(() => presetCodeOf(draft), [draft]);

  const submit = () => {
    const problem = text.trim() ? onApply(text) : 'Paste a preset code first. It looks like b2fA; ui.shadcn.com/create shows yours.';
    setError(problem);
    if (!problem) setText('');
  };

  const copy = async () => {
    if (!preset.code) return;
    try {
      if (host) await host.call('host.copyText', { text: preset.code });
      else await navigator.clipboard.writeText(preset.code);
      editor.ui.toast(`Copied preset code ${preset.code}.`);
    } catch (err) {
      editor.ui.toast(`Could not copy the preset code: ${err instanceof Error ? err.message : String(err)}`, 'warn');
    }
  };

  return (
    <section className="ds-knob ds-preset" data-testid="ds-preset">
      <h4 className="ds-knob__label">
        Preset code
        <span className="ds-knob__value ds-preset__code" data-testid="ds-preset-current">{preset.code ?? 'none'}</span>
      </h4>
      <div className="ds-preset__row">
        <input
          className="at-input ds-preset__field"
          value={text}
          placeholder="Paste preset code"
          aria-label="Paste preset code"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          onChange={(e) => {
            setText(e.currentTarget.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape' && (text || error)) {
              // The first Escape clears the field; the studio closes on the next one.
              e.preventDefault();
              e.stopPropagation();
              setText('');
              setError(null);
            }
          }}
          data-testid="ds-preset-field"
        />
        <button type="button" className="at-btn at-btn--bordered" onClick={submit} data-tip="Apply the code to this draft; nothing in the document changes until you Apply the studio" data-testid="ds-preset-apply">
          Apply
        </button>
      </div>
      {error && (
        <p id={errorId} className="at-hint at-hint--error ds-preset__error" role="alert" data-testid="ds-preset-error">
          {error}
        </p>
      )}
      <button
        type="button"
        className="at-btn at-btn--bordered ds-preset__copy"
        disabled={!preset.code}
        onClick={copy}
        data-tip={preset.code ? `Copy the preset code of this draft (${preset.code}) for ui.shadcn.com/create or shadcn init --preset` : 'This design system has no shadcn palette, so there is no code to copy'}
        data-testid="ds-preset-copy"
      >
        Copy preset code
      </button>
      {preset.notes.map((note) => (
        <p key={note} className="at-hint ds-preset__note" data-testid="ds-preset-note">
          {note}
        </p>
      ))}
    </section>
  );
}
