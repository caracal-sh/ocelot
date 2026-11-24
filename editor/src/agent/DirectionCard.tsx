// The card the sidebar shows where the agent's `create_theme` row was: the system it chose, as something to look at (name, mood and
// direction in the agent's words, the palette with its roles, a type specimen, the radius) and two ways forward: "Adjust" opens
// Assets > Styles on the document's theme, "Another direction" asks the sidebar agent for a clearly different take on the same content.
// The data is `DirectionData` (direction.ts), kept in the transcript, so the card is still there after a reload.

import { useState } from 'react';
import { useEditor } from '../editor/context';
import { bundledFamiliesIn, fontFaceCss, FONT_BASE } from '../themes/fonts';
import type { AgentChat } from './AgentChat';
import type { DirectionData } from './direction';
import type { SendMode } from './queue';

/** How many of the system's colours get a small swatch under the three that define it. */
const CORE = 3;

/** The message "Another direction" sends: the person's words, naming what to keep and what to replace. */
export function anotherDirectionPrompt(data: DirectionData): string {
  const was = [data.mood, `${data.display.family} with ${data.text.family}`].filter(Boolean).join(', ');
  return `Give me another direction. Keep the content and the structure, but replace the system “${data.name}” (${was}) with a clearly different mood, palette and type pairing, then restyle the design with it.`;
}

export function DirectionCard({ data, chat, working, available }: { data: DirectionData; chat: Pick<AgentChat, 'send'>; /** The sidebar agent is in a turn: the message steers it instead of waiting for its end. */ working: boolean; available: boolean }) {
  const editor = useEditor();
  const [asked, setAsked] = useState(false);
  const core = data.colors.slice(0, CORE);
  const more = data.colors.slice(CORE);
  const faces = fontFaceCss(bundledFamiliesIn([data.display.stack, data.text.stack]), (file) => FONT_BASE + file);
  const [ground, ink, accent] = core;

  const another = async () => {
    setAsked(true);
    const mode: SendMode = working ? 'steer' : 'queue';
    if (!(await chat.send(anotherDirectionPrompt(data), [], mode))) setAsked(false);
  };

  return (
    <article className="at-direction" data-testid="direction-card" aria-label={`Direction: ${data.name}`}>
      {faces && <style>{faces}</style>}
      <header className="at-direction__head">
        <span className="at-direction__eyebrow">Direction</span>
        <h3 className="at-direction__name" data-testid="direction-name">{data.name}</h3>
        {data.mood && <span className="at-direction__mood" data-testid="direction-mood">{data.mood}</span>}
      </header>
      {data.direction && <p className="at-direction__line" data-testid="direction-line">{data.direction}</p>}
      <ul className="at-direction__core" aria-label="Palette">
        {core.map((c) => (
          <li key={c.role}>
            <span className="at-direction__swatch" role="img" tabIndex={0} style={{ background: c.value }} data-tip={`${c.role} ${c.value}`} aria-label={`${c.role} ${c.value}`} data-testid="direction-swatch" data-role={c.role} />
            <span className="at-direction__role">{c.role}</span>
          </li>
        ))}
      </ul>
      {more.length > 0 && (
        // One tab stop for the small ones: the tip lists every value; hovering a swatch names that one.
        <ul className="at-direction__more" aria-label="More colours" tabIndex={0} data-tip={more.map((c) => `${c.role} ${c.value}`).join(', ')} data-testid="direction-more">
          {more.map((c) => (
            <li key={c.role} className="at-direction__swatch" style={{ background: c.value }} data-tip={`${c.role} ${c.value}`} data-testid="direction-swatch" data-role={c.role} />
          ))}
        </ul>
      )}
      <div className="at-direction__stage" style={{ background: ground!.value, color: ink!.value }} data-testid="direction-type">
        <span className="at-direction__aa" style={{ fontFamily: data.display.stack, ...(data.display.weight ? { fontWeight: data.display.weight } : {}) }} aria-hidden="true">Aa</span>
        <span className="at-direction__sample" aria-hidden="true">
          <span className="at-direction__display" style={{ fontFamily: data.display.stack, ...(data.display.weight ? { fontWeight: data.display.weight } : {}) }}>Sphinx of quartz</span>
          <span className="at-direction__body" style={{ fontFamily: data.text.stack }}>Judge my vow.</span>
        </span>
      </div>
      <div className="at-direction__meta" data-testid="direction-fonts">
        <span>
          {data.display.family}
          {data.display.weight ? ` ${data.display.weight}` : ''} · {data.text.family}
          {data.radius ? ` · radius ${data.radius}` : ''}
        </span>
        {data.radius && <span className="at-direction__shape" style={{ background: accent!.value, borderRadius: data.radius }} data-tip={`Radius ${data.radius}`} data-testid="direction-radius" />}
      </div>
      <div className="at-direction__actions">
        <button type="button" className="at-btn at-btn--bordered" onClick={() => editor.ui.showAssetsLibrary('styles')} data-tip="Open Assets > Styles to adjust this system" data-testid="direction-adjust">
          Adjust
        </button>
        <button
          type="button"
          className="at-btn at-btn--bordered"
          disabled={!available || asked}
          onClick={() => void another()}
          data-tip={!available ? 'The sidebar agent is not available. Set it up or sign in in this tab first.' : asked ? 'Asked: the agent is on it' : 'Ask the agent for a clearly different mood, palette and type, keeping the content'}
          data-testid="direction-another"
        >
          Another direction
        </button>
      </div>
    </article>
  );
}
