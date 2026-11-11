// Source lint for code layers (shown by get_code_errors). The frame runtime (render/exportRuntime.ts) makes frames
// reproducible only when animation state is a function of the frame time; these rules catch what breaks that.

export interface LintFinding {
  rule: 'wallclock' | 'unseeded-random' | 'three-clock' | 'media-element' | 'reduced-motion';
  line: number;
  message: string;
}

interface Rule {
  rule: LintFinding['rule'];
  pattern: RegExp;
  message: string;
}

const RULES: Rule[] = [
  {
    rule: 'wallclock',
    pattern: /\b(?:Date\.now\s*\(|new\s+Date\s*\(\s*\)|performance\.now\s*\()/g,
    message: 'Date.now() / new Date() / performance.now() drive animation state from the wall clock: use the requestAnimationFrame timestamp or ctx.time (ms), so video export and get_screenshot time_ms reproduce the frame.',
  },
  {
    rule: 'unseeded-random',
    pattern: /\bMath\.random\s*\(/g,
    message: 'Math.random() differs between the live canvas and an export: use a seeded PRNG (e.g. mulberry32(seed)) for anything that must look the same every time.',
  },
  {
    rule: 'three-clock',
    pattern: /\bnew\s+(?:THREE\.)?Clock\s*\(/g,
    message: 'THREE.Clock is deprecated and reads performance.now: use THREE.Timer (timer.update(now) with the rAF timestamp) or ctx.time.',
  },
  {
    rule: 'media-element',
    pattern: /<\s*(?:video|audio)\b|createElement\(\s*['"`](?:video|audio)['"`]\s*\)|new\s+Audio\s*\(/g,
    message: '<video>/<audio> cannot be stepped frame-exactly in v1 (and exports have no audio): use an image sequence on a canvas, or an image.',
  },
];

/** Replaces comments with spaces (keeping line numbers) so a mention in a comment is not a finding. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Something that keeps animating: a frame loop, an interval, GSAP, Motion's animate() or WAAPI. */
const ANIMATES = /\b(?:requestAnimationFrame|setAnimationLoop|setInterval)\s*\(|\bgsap\s*\.|\banimate\s*\(/;
const READS_REDUCED = /\breducedMotion\b|prefers-reduced-motion/;
const REDUCED_MOTION_MESSAGE =
  'the layer animates but never reads ctx.reducedMotion: under reduced motion draw one still frame (or a short opacity fade) instead of continuous motion (motion-guide, section 6).';

/**
 * Findings for one module's source, in source order. `skip` names rules to leave out (a held-out rule, or one that does not apply
 * to the page the layer is on: reduced motion on a video page).
 */
export function lintCodeSource(source: string, opts: { skip?: readonly string[] } = {}): LintFinding[] {
  const text = withoutComments(source);
  const out: LintFinding[] = [];
  if (!opts.skip?.includes('reduced-motion') && !READS_REDUCED.test(text)) {
    const m = ANIMATES.exec(text);
    if (m) out.push({ rule: 'reduced-motion', line: text.slice(0, m.index).split('\n').length, message: REDUCED_MOTION_MESSAGE });
  }
  for (const { rule, pattern, message } of RULES) {
    if (opts.skip?.includes(rule)) continue;
    for (const m of text.matchAll(pattern)) {
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ rule, line, message });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

export function formatLint(findings: readonly LintFinding[]): string {
  return findings.map((f) => `- lint [${f.rule}] line ${f.line}: ${f.message}`).join('\n');
}
