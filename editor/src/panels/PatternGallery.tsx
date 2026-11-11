// Assets > Patterns: the pattern library (patterns/) as cards. Each card draws a wireframe of the screen's regions, says in one line what the
// pattern is for, lists what a reviewer should look for, and "Build with agent" hands the sidebar agent a prompt that makes it read the same spec
// through get_pattern. Agents list and read the same catalog with list_patterns / get_pattern (mcp/patternTools.ts).

import { useContext, useId, useMemo, useState } from 'react';
import { AgentChatContext } from '../agent/AgentPanel';
import { Seg } from '../app/Seg';
import { PATTERNS, filterPatterns, patternPrompt, rankPatterns } from '../patterns';
import { CATEGORY_LABELS, KIND_LABELS, PATTERN_CATEGORIES, PLATFORM_LABELS, SKETCH_HEIGHT, SKETCH_WIDTH, type Pattern, type PatternCategory } from '../patterns/types';
import './PatternGallery.css';

type PlatformFilter = 'all' | 'web' | 'mobile';

/** The pattern's regions as grey shapes on a 100 x 62 grid: a picture of the layout, never of a look. */
function Sketch({ pattern }: { pattern: Pattern }) {
  return (
    <svg className="at-pat__sketch" viewBox={`0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}`} role="presentation" aria-hidden="true" focusable="false">
      {pattern.sketch.map(([tone, x, y, w, h], i) => (
        <rect key={i} className={`at-pat__r at-pat__r--${tone}`} x={x} y={y} width={w} height={h} rx={tone === 'line' ? 0.5 : 1.2} />
      ))}
    </svg>
  );
}

function PatternCard({ pattern, onBuild }: { pattern: Pattern; onBuild: (p: Pattern) => void }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const required = pattern.states.filter((s) => s.required);
  return (
    <article className="at-pat" data-testid={`pattern-${pattern.id}`} aria-label={`${pattern.title} pattern`}>
      <div className="at-pat__stage">
        <Sketch pattern={pattern} />
      </div>
      <div className="at-pat__meta">
        <h4 className="at-pat__name">{pattern.title}</h4>
        <span className="at-pat__tag" data-tip={`${KIND_LABELS[pattern.kind]} · ${PLATFORM_LABELS[pattern.platform]} · ${CATEGORY_LABELS[pattern.category]}`}>
          {pattern.platform === 'both' ? 'Web + mobile' : PLATFORM_LABELS[pattern.platform]}
        </span>
      </div>
      <p className="at-pat__summary" data-testid={`pattern-summary-${pattern.id}`}>{pattern.summary}</p>
      <div className="at-pat__actions">
        <button type="button" className="at-btn at-btn--bordered" onClick={() => onBuild(pattern)} aria-label={`Build ${pattern.title} with agent`} data-tip="The agent reads this pattern with get_pattern, then builds every required state as its own artboard" data-testid={`pattern-build-${pattern.id}`}>
          Build with agent
        </button>
        <button type="button" className="at-btn at-pat__more" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((v) => !v)} data-testid={`pattern-more-${pattern.id}`}>
          What to look for
        </button>
      </div>
      <div className="at-pat__panel" id={panel} data-open={open || undefined} inert={!open}>
        <div className="at-pat__panel-inner">
          <h5 className="at-pat__h">Required states</h5>
          <p className="at-pat__states">{required.map((s) => s.name).join(' · ')}</p>
          <h5 className="at-pat__h">Checks</h5>
          <ul className="at-pat__checks">
            {pattern.review.map((r) => (
              <li key={r.check}>{r.check}</li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}

export function PatternGallery() {
  const chat = useContext(AgentChatContext);
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState<PlatformFilter>('all');
  const [category, setCategory] = useState<PatternCategory | 'all'>('all');
  const [about, setAbout] = useState('');

  const shown = useMemo(() => {
    const filtered = filterPatterns({ ...(category !== 'all' ? { category } : {}), ...(platform !== 'all' ? { platform } : {}) });
    if (!query.trim()) return filtered;
    return rankPatterns(query, filtered).filter((r) => r.score > 0).map((r) => r.pattern);
  }, [query, platform, category]);

  const filtering = query.trim() !== '' || platform !== 'all' || category !== 'all';
  const clear = () => {
    setQuery('');
    setPlatform('all');
    setCategory('all');
  };
  const build = (p: Pattern) => void chat?.startWithPrompt(patternPrompt(p, about));

  return (
    <section className="at-section at-pats" data-testid="patterns">
      <h3 className="at-section__title">
        Patterns <span className="at-section__count" role="status" data-testid="pattern-count">{filtering ? `${shown.length} of ${PATTERNS.length}` : PATTERNS.length}</span>
      </h3>
      <p className="at-hint at-pats__lede">Written specs for common product screens: regions, states, copy, numbers and a build recipe. The agent reads the same ones.</p>
      <div className="at-pats__filters">
        <input
          type="text"
          role="searchbox"
          autoComplete="off"
          spellCheck={false}
          className="at-input"
          value={query}
          placeholder="Search patterns, e.g. “no results”"
          aria-label="Search patterns"
          onChange={(e) => setQuery(e.currentTarget.value)}
          data-testid="pattern-search"
        />
        <div className="at-row">
          <div className="at-field">
            <span className="at-field__label">Platform</span>
            <Seg<PlatformFilter>
              label="Platform"
              value={platform}
              onChange={setPlatform}
              testId="pattern-platform"
              options={[
                { value: 'all', label: 'All' },
                { value: 'web', label: 'Web' },
                { value: 'mobile', label: 'Mobile' },
              ]}
            />
          </div>
          <label className="at-field">
            <span className="at-field__label">Category</span>
            <select className="at-input" value={category} onChange={(e) => setCategory(e.currentTarget.value as PatternCategory | 'all')} data-testid="pattern-category">
              <option value="all">All</option>
              {PATTERN_CATEGORIES.map((c) => (
                <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="at-field">
          <span className="at-field__label">About your product (sent with Build with agent)</span>
          <textarea className="at-prompt" rows={2} value={about} placeholder="Who it is for and what it does, e.g. a project management app for small agencies" onChange={(e) => setAbout(e.currentTarget.value)} data-testid="pattern-about" />
        </label>
      </div>
      {shown.length === 0 ? (
        <div className="at-empty at-pats__empty" data-testid="pattern-empty">
          <p>No pattern matches {query.trim() ? `“${query.trim()}”` : 'these filters'}.</p>
          <button type="button" className="at-btn at-btn--bordered" onClick={clear} data-testid="pattern-clear">Clear filters</button>
        </div>
      ) : (
        <ul className="at-pats__list" aria-label="Patterns" data-testid="pattern-list">
          {shown.map((p) => (
            <li key={p.id}>
              <PatternCard pattern={p} onBuild={build} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
