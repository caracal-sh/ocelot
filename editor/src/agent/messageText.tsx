import type { ReactNode } from 'react';

/** `- `, `* ` or `• ` starts a bullet; `1. ` or `1) ` a numbered item (one or two digits, so a year opening a sentence stays prose). */
const LIST_ITEM = /^\s*(?:[-*•]|(\d{1,2})[.)])\s+(.*)$/;

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] } | { kind: 'ol'; items: string[]; start: number };

/** `code` and **bold** inside one line; everything else stays plain text. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, j) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={j}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={j}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

/**
 * An agent message: paragraphs (split by blank lines; a single line break is a space), bullet and
 * numbered lists, `code` and **bold**. A list item may continue on an indented line, and blank lines
 * between items keep one list. `caret` puts a blinking caret after the last block (streaming).
 */
export function renderText(text: string, caret = false): ReactNode {
  const blocks: Block[] = [];
  let last: Block | undefined;
  for (const line of text.trim().split('\n')) {
    if (!line.trim()) {
      if (last?.kind === 'p') last = undefined;
      continue;
    }
    const m = LIST_ITEM.exec(line);
    if (m) {
      const [, num, item = ''] = m;
      const kind = num ? 'ol' : 'ul';
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push((last = kind === 'ol' ? { kind, items: [item], start: Number(num) } : { kind, items: [item] }));
    } else if (last && last.kind !== 'p' && /^\s/.test(line)) last.items[last.items.length - 1] += ` ${line.trim()}`;
    else if (last?.kind === 'p') last.lines.push(line.trim());
    else blocks.push((last = { kind: 'p', lines: [line.trim()] }));
  }
  const tail = caret && <span className="at-caret" aria-hidden="true" />;
  const items = (b: { items: string[] }, i: number) =>
    b.items.map((item, k) => (
      <li key={k}>
        {inline(item)}
        {i === blocks.length - 1 && k === b.items.length - 1 && tail}
      </li>
    ));
  return blocks.map((b, i) => {
    if (b.kind === 'ul') return <ul key={i}>{items(b, i)}</ul>;
    if (b.kind === 'ol') return <ol key={i} start={b.start === 1 ? undefined : b.start}>{items(b, i)}</ol>;
    return (
      <p key={i}>
        {inline(b.lines.join(' '))}
        {i === blocks.length - 1 && tail}
      </p>
    );
  });
}
