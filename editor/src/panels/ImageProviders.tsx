import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { errorMessage } from '../bridge/rpc';
import type { ImageProviderInfo, ImageProviderList } from '../bridge/schema.gen';
import { useEditor } from '../editor/context';
import { falKeySource } from './assetLogic';
import { useProviders } from './assetHooks';

const STATUS_LABEL: Record<string, string> = { ready: 'Ready', needs_setup: 'Needs setup', unavailable: 'Unavailable' };

function StatusDot({ status }: { status: string }) {
  return <span className={`at-dot at-dot--${status}`} role="img" aria-label={STATUS_LABEL[status] ?? status} />;
}

/** Key field of the fal provider. The stored key is never shown or read back; the host only says whether one exists. */
function FalKey({ provider, onList }: { provider: ImageProviderInfo; onList(list: ImageProviderList): void }) {
  const editor = useEditor();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = falKeySource(provider);

  const apply = async (next: string | null) => {
    setBusy(true);
    setError(null);
    try {
      onList(await editor.assets.setKey('fal', next));
      setKey('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="at-provider__key">
      <label className="at-field">
        <span className="at-field__label">fal API key</span>
        <input
          className="at-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          disabled={busy}
          placeholder={provider.keyStored ? 'Enter a new key to replace the stored one' : 'Paste your fal key'}
          data-testid="fal-key"
          onChange={(e) => setKey(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && key.trim() && void apply(key.trim())}
        />
      </label>
      <div className="at-provider__buttons">
        <button type="button" className="at-btn at-btn--bordered" disabled={busy || !key.trim()} onClick={() => void apply(key.trim())} data-testid="fal-key-save">
          Save key
        </button>
        <button type="button" className="at-btn at-btn--bordered" disabled={busy || !provider.keyStored} onClick={() => void apply(null)} data-testid="fal-key-remove">
          Remove key
        </button>
      </div>
      <p className="at-hint">
        {source === 'env'
          ? 'This host reads the key from the FAL_KEY environment variable; set it before starting the host.'
          : provider.keyStored
            ? 'Key stored in the macOS Keychain.'
            : 'The key is stored in the macOS Keychain; Ocelot never shows it again.'}
      </p>
      {error && <p className="at-hint at-hint--error" role="alert">{error}</p>}
    </div>
  );
}

function ProviderCard({ provider, onList }: { provider: ImageProviderInfo; onList(list: ImageProviderList): void }) {
  return (
    <section className="at-provider" data-testid={`provider-${provider.id}`} data-status={provider.status}>
      <header className="at-provider__head">
        <StatusDot status={provider.status} />
        <strong>{provider.label}</strong>
        <span className="at-provider__status">{STATUS_LABEL[provider.status] ?? provider.status}</span>
        <span className="at-provider__count">
          {provider.models.length} model{provider.models.length === 1 ? '' : 's'}
        </span>
      </header>
      <p className="at-provider__detail">{provider.detail}</p>
      {provider.status !== 'ready' && provider.setup && <p className="at-provider__setup">{provider.setup}</p>}
      {provider.id === 'fal' && <FalKey provider={provider} onList={onList} />}
    </section>
  );
}

/** Settings dialog: provider status, the fal key and the default model. */
export function ImageProviders({ onClose, onChange }: { onClose(): void; onChange?(list: ImageProviderList): void }) {
  const editor = useEditor();
  const providers = useProviders(editor);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => dialogRef.current?.focus(), []);

  const take = (list: ImageProviderList) => {
    providers.set(list);
    onChange?.(list);
  };
  const list = providers.list;
  const choices = list?.providers.flatMap((p) => p.models.filter((m) => m.capabilities.includes('generate') && m.available)) ?? [];

  const setDefault = async (model: string) => {
    setError(null);
    try {
      take(await editor.assets.setDefaultModel(model || null));
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const refresh = async () => {
    setError(null);
    await providers.refresh(true);
    try {
      onChange?.(await editor.assets.providers());
    } catch {
      // The hook shows the error.
    }
  };

  return createPortal(
    <div className="at-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className="at-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="at-providers-title"
        tabIndex={-1}
        data-testid="providers-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="at-dialog__head">
          <h2 id="at-providers-title" className="at-dialog__title">Image providers</h2>
          <button type="button" className="at-btn at-btn--bordered" onClick={() => void refresh()} disabled={providers.loading} data-testid="providers-refresh">
            {providers.loading ? 'Checking…' : 'Refresh'}
          </button>
          <button type="button" className="at-btn" onClick={onClose} aria-label="Close" data-testid="providers-close">
            Done
          </button>
        </header>
        <div className="at-dialog__body">
          {providers.error && <p className="at-hint at-hint--error" role="alert">{providers.error}</p>}
          {list && list.providers.length === 0 && (
            <p className="at-hint">This host has no image providers. Image generation needs the Ocelot app or the headless host.</p>
          )}
          {list?.providers.map((p) => <ProviderCard key={p.id} provider={p} onList={take} />)}
          {list && choices.length > 0 && (
            <label className="at-field at-provider__default">
              <span className="at-field__label">Default model (used when a prompt or an agent does not name one)</span>
              <select className="at-input" value={list.defaultModel ?? ''} onChange={(e) => void setDefault(e.currentTarget.value)} data-testid="default-model">
                <option value="">Automatic: first available model</option>
                {choices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.provider}: {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && <p className="at-hint at-hint--error" role="alert">{error}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
