import { useState } from 'react';
import type { ImageProviderList } from '../bridge/schema.gen';
import type { Operation } from '../assets/generate';
import { falModelId, modelGroups, otherFalState, OTHER_FAL } from './assetLogic';

interface Props {
  list: ImageProviderList;
  operation: Operation;
  /** Full model id (`fal:fal-ai/flux/dev` for a typed endpoint), or '' for none. */
  value: string;
  onChange(modelId: string): void;
  disabled?: boolean;
  label?: string;
}

/**
 * Model picker grouped by provider. Models that cannot run right now stay visible but disabled, with the
 * reason; "Other fal endpoint…" takes a free-text endpoint id and yields `fal:<id>`.
 */
export function ModelSelect({ list, operation, value, onChange, disabled, label = 'Model' }: Props) {
  const groups = modelGroups(list, operation);
  const fal = otherFalState(list);
  const known = groups.some((g) => g.models.some((m) => m.id === value));
  const [otherOpen, setOtherOpen] = useState(() => !!value && !known && value.startsWith('fal:'));
  const [endpoint, setEndpoint] = useState(() => (value.startsWith('fal:') && !known ? value.slice(4) : ''));
  const other = otherOpen || (!!value && !known && value.startsWith('fal:'));
  const selected = groups.flatMap((g) => g.models).find((m) => m.id === value);
  const typedInvalid = other && endpoint.trim() !== '' && falModelId(endpoint) === null;

  return (
    <div className="at-modelselect">
      <label className="at-field">
        <span className="at-field__label">{label}</span>
        <select
          className="at-input"
          value={other ? OTHER_FAL : known ? value : ''}
          disabled={disabled}
          data-testid="model-select"
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v === OTHER_FAL) {
              setOtherOpen(true);
              onChange(falModelId(endpoint) ?? '');
            } else {
              setOtherOpen(false);
              onChange(v);
            }
          }}
        >
          {!other && !known && (
            <option value="" disabled>
              {groups.length || fal ? 'Choose a model' : 'No image models'}
            </option>
          )}
          {groups.map((g) => (
            <optgroup key={g.id} label={g.label}>
              {g.models.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.available} title={m.available ? m.note : m.reason}>
                  {m.available ? `${m.label}${m.cost ? ` · ${m.cost}` : ''}` : `${m.label} (unavailable: ${m.reason})`}
                </option>
              ))}
            </optgroup>
          ))}
          {fal && (
            <optgroup label="Custom">
              <option value={OTHER_FAL} disabled={!fal.available} title={fal.reason}>
                {fal.available ? 'Other fal endpoint…' : `Other fal endpoint… (unavailable: ${fal.reason})`}
              </option>
            </optgroup>
          )}
        </select>
      </label>
      {other && (
        <label className="at-field">
          <span className="at-field__label">fal endpoint id</span>
          <input
            className="at-input"
            value={endpoint}
            placeholder="fal-ai/flux/dev"
            spellCheck={false}
            disabled={disabled}
            data-testid="fal-endpoint"
            onChange={(e) => {
              setEndpoint(e.currentTarget.value);
              onChange(falModelId(e.currentTarget.value) ?? '');
            }}
          />
          {typedInvalid && <span className="at-hint at-hint--error">Use the form &lt;owner&gt;/&lt;app&gt;, for example fal-ai/flux/dev.</span>}
        </label>
      )}
      {selected?.note && <span className="at-hint">{selected.note}</span>}
    </div>
  );
}
