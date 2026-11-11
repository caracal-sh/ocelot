import type { Guide } from './snapping';

/**
 * Smart guides while dragging or resizing, in world space inside the transformed layer (sizes are divided by the zoom in
 * CSS so lines stay 1px and labels 11px on screen). Alignment lines are thin; measured gaps have end ticks and a pill with
 * the distance in px.
 */
export function Guides({ guides }: { guides: readonly Guide[] }) {
  if (guides.length === 0) return null;
  return (
    <div className="at-guides" data-testid="guides" aria-hidden="true">
      {guides.map((g, i) => {
        if (g.kind === 'line') {
          const style = g.axis === 'x' ? { left: g.pos, top: g.from, height: g.to - g.from } : { left: g.from, top: g.pos, width: g.to - g.from };
          return <div key={`l${i}`} className={`at-guide at-guide--line at-guide--${g.axis === 'x' ? 'v' : 'h'}`} style={style} data-guide="line" />;
        }
        const style = g.axis === 'x' ? { left: g.from, top: g.cross, width: g.to - g.from } : { left: g.cross, top: g.from, height: g.to - g.from };
        return (
          <div key={`g${i}`} className={`at-guide at-guide--gap at-guide--${g.axis === 'x' ? 'h' : 'v'}${g.equal ? ' is-equal' : ''}`} style={style} data-guide="gap">
            <span className="at-guide__label">{Math.round(g.to - g.from)}</span>
          </div>
        );
      })}
    </div>
  );
}
