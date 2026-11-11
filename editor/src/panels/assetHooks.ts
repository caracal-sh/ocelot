// React bindings for the asset store: the manifest with usage counts, the provider catalog, a ticking clock for progress.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { errorMessage } from '../bridge/rpc';
import type { AssetRecord, ImageProviderList } from '../bridge/schema.gen';
import { assetUsage } from '../assets/refs';
import type { Editor } from '../editor/Editor';
import { jobStoreFor, removeBackgroundSupport, type JobSnapshot, type RemoveBackgroundSupport } from './assetActions';

/**
 * The stored assets (newest first) and which layers use each. Re-renders when the manifest changes, the
 * document changes or the selection moves (frame-batched). While `active` is false (a hidden tab)
 * nothing is tracked; it catches up when the tab shows again.
 */
export function useAssetsState(editor: Editor, active = true): { assets: AssetRecord[]; usage: Map<string, string[]> } {
  const [version, bump] = useReducer((v: number) => v + 1, 0);
  useEffect(() => {
    if (!active) return;
    bump();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(bump);
    };
    const offs = [editor.assets.subscribe(schedule), editor.on('change', schedule), editor.on('document', schedule), editor.selection.subscribe(schedule)];
    return () => {
      cancelAnimationFrame(raf);
      offs.forEach((off) => off());
    };
  }, [editor, active]);
  // `version` is the cache key: the manifest and the document are read fresh whenever it moves.
  return useMemo(() => ({ assets: editor.assets.list(), usage: assetUsage(editor.doc) }), [editor, version]);
}

export interface ProvidersState {
  list: ImageProviderList | null;
  error: string | null;
  loading: boolean;
  /** Re-asks the host (`force` skips its cache). */
  refresh(force?: boolean): Promise<void>;
  /** Takes a list the caller got from the host (after setting a key or a default). */
  set(list: ImageProviderList): void;
}

/** The provider catalog from the host (cached by the asset service). */
export function useProviders(editor: Editor): ProvidersState {
  const [list, setList] = useState<ImageProviderList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refresh = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const next = force ? await editor.assets.refreshProviders() : await editor.assets.providers();
        if (alive.current) {
          setList(next);
          setError(null);
        }
      } catch (err) {
        if (alive.current) setError(errorMessage(err));
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [editor],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // A provider was marked unavailable (rejected credential) or the host changed its list: re-read the cached list.
  useEffect(
    () =>
      editor.assets.onProvidersChanged(() => {
        void editor.assets.providers().then(
          (next) => alive.current && setList(next),
          () => {},
        );
      }),
    [editor],
  );
  const set = useCallback((next: ImageProviderList) => {
    setList(next);
    setError(null);
  }, []);
  return { list, error, loading, refresh, set };
}

/** Snapshot of the Assets panel's generation job. */
export function useImageJob(editor: Editor): JobSnapshot {
  const store = jobStoreFor(editor);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/**
 * Whether a background can be removed right now (and whether "Crop to subject" is offered); null while the
 * host is being asked. Asked again when `refreshKey` changes (for example after the provider list changed).
 */
export function useRemoveBackgroundSupport(editor: Editor, refreshKey?: unknown): RemoveBackgroundSupport | null {
  const [support, setSupport] = useState<RemoveBackgroundSupport | null>(null);
  useEffect(() => {
    let alive = true;
    void removeBackgroundSupport(editor).then((s) => alive && setSupport(s));
    return () => {
      alive = false;
    };
  }, [editor, refreshKey]);
  return support;
}

/** Whole seconds since `startedAt`, ticking once a second; 0 when null. */
export function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}
