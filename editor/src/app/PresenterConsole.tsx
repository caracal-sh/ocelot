import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { slideHtml } from '../present/slideHtml';

/** Seconds as m:ss (h:mm:ss from an hour). */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A slide as a small, non-interactive preview: its own document in a sandboxed frame, scaled to the width of its box. */
function SlideThumb({ editor, id }: { editor: Editor; id: string }) {
  const [html, setHtml] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.2);
  const frame = editor.doc.get(id)?.frame;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      slideHtml(editor, id, { live: false }).then((h) => live && setHtml(h), () => {});
    };
    load();
    const off = editor.on('change', () => {
      clearTimeout(timer);
      timer = setTimeout(load, 300);
    });
    return () => {
      live = false;
      clearTimeout(timer);
      off();
    };
  }, [editor, id]);
  useEffect(() => {
    const el = box.current;
    if (!el || !frame) return;
    const measure = () => setScale(el.clientWidth / frame.width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frame?.width]);
  if (!frame) return null;
  return (
    <div ref={box} className="at-console__thumb" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
      {html && <iframe title="Next slide" sandbox="allow-scripts" srcDoc={html} tabIndex={-1} aria-hidden="true" style={{ width: frame.width, height: frame.height, transform: `scale(${scale})` }} />}
    </div>
  );
}

/** The speaker notes of the slide on show, editable (the same undoable edit as the inspector's notes field). */
function Notes({ editor, id }: { editor: Editor; id: string }) {
  const stored = useSyncExternalStore(
    (cb) => editor.on('change', cb),
    () => editor.doc.slideOf(id)?.notes ?? '',
  );
  const [draft, setDraft] = useState(stored);
  const lastId = useRef(id);
  if (lastId.current !== id) {
    lastId.current = id;
    setDraft(stored);
  }
  return (
    <textarea
      className="at-console__notes"
      value={draft}
      placeholder="No notes for this slide. Type here to add some."
      aria-label="Speaker notes"
      data-testid="console-notes"
      onChange={(e) => {
        setDraft(e.target.value);
        editor.actions.setSlide(id, { notes: e.target.value === '' ? null : e.target.value }, { endStep: false });
      }}
    />
  );
}

/**
 * Deck presenter view, in the editor window: the slide on show fills the left of the stage (the canvas lays it out), and this
 * column carries the slide counter and timer, the next slide, the notes and the audience status. It shows while a deck is
 * presented with an audience window, or after N. The editor window keeps the keyboard, so clicker keys work as everywhere.
 */
export function PresenterConsole() {
  const editor = useEditor();
  const present = editor.present;
  useSyncExternalStore((cb) => present.subscribe(cb), () => present.version);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const id = present.artboardId;
  if (!id || !present.consoleOpen) return null;
  const snap = present.snapshot();
  if (!snap) return null;
  const slides = present.slideIds();
  const nextId = slides[snap.index + 1];
  const name = editor.doc.get(id)?.name ?? '';
  return (
    <aside className="at-console" aria-label="Presenter view" data-testid="presenter-console">
      <div className="at-console__head">
        <div className="at-console__count" data-testid="console-counter">
          <strong>{snap.index + 1}</strong> / {snap.count}
          {present.pendingDigits && <span className="at-console__digits" data-testid="console-digits"> → {present.pendingDigits}</span>}
        </div>
        <div className="at-console__timer" data-testid="console-timer" data-tip="Time since Present started">
          {formatElapsed((now - present.startedAt) / 1000)}
        </div>
      </div>
      <div className="at-console__name">{name}</div>
      {snap.blank !== 'none' && (
        <div className="at-console__blank" data-testid="console-blank">
          {snap.blank === 'black' ? 'Black screen' : 'White screen'} · press {snap.blank === 'black' ? 'B' : 'W'} to show the slide
        </div>
      )}
      <div className="at-console__label">Next</div>
      {nextId ? (
        <SlideThumb editor={editor} id={nextId} key={nextId} />
      ) : (
        <div className="at-console__end" data-testid="console-end">
          End of the deck
        </div>
      )}
      <div className="at-console__label">Notes</div>
      <Notes editor={editor} id={id} key={id} />
      <div className="at-console__foot" data-testid="console-audience">
        {present.hasAudience ? 'Audience window is open. Keys here drive it.' : 'No audience window: this window shows the slide. Connect a display to present on it.'}
      </div>
    </aside>
  );
}
