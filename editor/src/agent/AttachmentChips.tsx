// Attachment UI for the agent sidebar: the composer's state hook, the chips (composer and sent messages) and the
// preview (image lightbox, text with a scroll and a copy button). The model and the limits live in attachments.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../app/Icon';
import { SwapIcon } from '../app/Crossfade';
import { formatBytes } from '../panels/assetLogic';
import { attachmentErrors, imageUrl, ingestFile, isLongPaste, lineCount, pastedTextAttachment, type Attachment } from './attachments';

/** The composer's attachments: what is attached, what is still being read, and what keeps the set from being sent. */
export interface AttachmentSet {
  items: Attachment[];
  /** Files still being read. */
  pending: number;
  /** Per-chip problems; empty when the set can be sent. */
  errors: ReadonlyMap<string, string>;
  addFiles(files: readonly File[]): Promise<void>;
  addPasted(text: string): void;
  remove(id: string): void;
  /** Puts attachments back in front (a send that did not start). */
  restore(list: readonly Attachment[]): void;
  clear(): void;
}

export function useAttachments(): AttachmentSet {
  const [items, setItems] = useState<Attachment[]>([]);
  const [pending, setPending] = useState(0);
  const errors = useMemo(() => attachmentErrors(items), [items]);

  /** Reads picked, dropped or pasted files. Unsupported ones become chips with an error. */
  const addFiles = useCallback(async (files: readonly File[]) => {
    if (!files.length) return;
    setPending((n) => n + files.length);
    try {
      const made = await Promise.all(files.map((f) => ingestFile(f)));
      setItems((cur) => [...cur, ...made]);
    } finally {
      setPending((n) => n - files.length);
    }
  }, []);
  const addPasted = useCallback((text: string) => setItems((cur) => [...cur, pastedTextAttachment(text, cur)]), []);
  const remove = useCallback((id: string) => setItems((cur) => cur.filter((a) => a.id !== id)), []);
  const restore = useCallback((list: readonly Attachment[]) => setItems((cur) => [...list, ...cur]), []);
  const clear = useCallback(() => setItems([]), []);
  return { items, pending, errors, addFiles, addPasted, remove, restore, clear };
}

/** Does a paste event carry files, or text long enough to become a chip? Returns what the composer should do with it. */
export function readPaste(data: DataTransfer): { files: File[] } | { longText: string } | null {
  const files = Array.from(data.files);
  if (files.length) return { files };
  const text = data.getData('text/plain');
  return isLongPaste(text) ? { longText: text } : null;
}

export function hasFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}

interface ChipsProps {
  items: readonly Attachment[];
  /** Per-chip problems (composer only). */
  errors?: ReadonlyMap<string, string>;
  onRemove?: (id: string) => void;
  /** A pasted chip goes back into the input as text (composer only). */
  onPasteAsText?: (a: Attachment) => void;
  onCopy: (text: string) => Promise<void>;
  /** Chips of a sent message: image thumbnails as tiles, right-aligned. */
  sent?: boolean;
}

export function AttachmentChips({ items, errors, onRemove, onPasteAsText, onCopy, sent }: ChipsProps) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  if (!items.length) return null;
  return (
    <>
      <div className={`at-chips${sent ? ' at-chips--sent' : ''}`} role="list" aria-label="Attachments" data-testid="attachment-chips">
        {items.map((a) => (
          <Chip key={a.id} a={a} error={errors?.get(a.id)} sent={sent} {...(onRemove ? { onRemove } : {})} {...(onPasteAsText ? { onPasteAsText } : {})} onPreview={() => setPreview(a)} />
        ))}
      </div>
      {preview && <AttachmentPreview a={preview} onClose={() => setPreview(null)} onCopy={onCopy} />}
    </>
  );
}

function Chip({ a, error, sent, onRemove, onPasteAsText, onPreview }: { a: Attachment; error: string | undefined; sent: boolean | undefined; onRemove?: (id: string) => void; onPasteAsText?: (a: Attachment) => void; onPreview: () => void }) {
  const isImage = a.kind === 'image' && !!a.image && !error;
  const meta = isImage ? `${a.image!.width}×${a.image!.height}` : a.kind === 'text' && a.text !== undefined ? `${lineCount(a.text)} ${lineCount(a.text) === 1 ? 'line' : 'lines'}` : formatBytes(a.size);
  const tile = sent && isImage;
  return (
    <div className={`at-chip${error ? ' at-chip--error' : ''}${tile ? ' at-chip--tile' : ''}${onRemove ? ' at-chip--enter' : ''}`} role="listitem" data-kind={a.kind} data-testid="attachment-chip">
      <button type="button" className="at-chip__main" onClick={onPreview} disabled={!!error} title={error ?? `${a.name}: ${meta}`} aria-label={`Preview ${a.name}`}>
        {isImage ? (
          <img className="at-chip__thumb" src={imageUrl(a)} alt="" draggable={false} />
        ) : (
          <span className="at-chip__icon">
            <Icon name="file" size={14} />
          </span>
        )}
        {!tile && (
          <>
            <span className="at-chip__name">{a.name}</span>
            <span className="at-chip__meta">{error ? 'Cannot attach' : meta}</span>
          </>
        )}
      </button>
      {a.pasted && !error && onPasteAsText && (
        <button type="button" className="at-chip__act" onClick={() => onPasteAsText(a)} data-testid="attachment-paste-as-text">
          Paste as text
        </button>
      )}
      {onRemove && (
        <button type="button" className="at-chip__x" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.name}`} data-testid="attachment-remove">
          <Icon name="close" size={10} />
        </button>
      )}
      {error && (
        <p className="at-chip__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Text previews stop here; the whole file is still sent. */
const PREVIEW_CHARS = 50_000;

/** Image: a lightbox (click or Esc closes). Text: the file's content with a scroll and a copy button. */
export function AttachmentPreview({ a, onClose, onCopy }: { a: Attachment; onClose: () => void; onCopy: (text: string) => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => {
    ref.current?.focus();
    return () => window.clearTimeout(timer.current);
  }, []);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  if (a.kind === 'image' && a.image) {
    return createPortal(
      <div className="at-modal at-modal--lightbox" onMouseDown={onClose}>
        <div ref={ref} className="at-lightbox" role="dialog" aria-modal="true" aria-label={a.name} tabIndex={-1} onKeyDown={key} data-testid="attachment-preview">
          <img className="at-lightbox__img" src={imageUrl(a)} alt={a.name} />
          <p className="at-lightbox__caption">
            {a.name} · {a.image.width}×{a.image.height}
            {a.image.assetId ? ' · in Assets' : ''}
          </p>
        </div>
      </div>,
      document.body,
    );
  }

  const text = a.text ?? '';
  const shown = text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
  const lines = lineCount(text);
  return createPortal(
    <div className="at-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="at-dialog at-dialog--wide" role="dialog" aria-modal="true" aria-label={a.name} tabIndex={-1} onKeyDown={key} data-testid="attachment-preview">
        <header className="at-dialog__head">
          <h2 className="at-dialog__title at-attach__title">
            {a.name}
            <span className="at-attach__count">
              {lines} {lines === 1 ? 'line' : 'lines'} · {text.length.toLocaleString('en-US')} characters
            </span>
          </h2>
          <button
            type="button"
            className="at-btn at-btn--withicon"
            onClick={() => {
              void onCopy(text).then(() => {
                setCopied(true);
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => setCopied(false), 1500);
              });
            }}
            data-testid="attachment-copy"
          >
            <SwapIcon on={copied}>
              <Icon name="copy" size={12} />
              <Icon name="check" size={12} />
            </SwapIcon>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="at-btn" onClick={onClose}>
            Done
          </button>
        </header>
        <pre className="at-attach__text" tabIndex={0}>
          {shown}
        </pre>
        {shown.length < text.length && <p className="at-attach__more">Showing the first {PREVIEW_CHARS.toLocaleString('en-US')} characters. The whole file is sent.</p>}
      </div>
    </div>,
    document.body,
  );
}
