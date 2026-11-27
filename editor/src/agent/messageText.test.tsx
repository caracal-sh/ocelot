import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderText } from './messageText';

const html = (text: string, caret = false) => renderToStaticMarkup(<>{renderText(text, caret)}</>);
const CARET = '<span class="at-caret" aria-hidden="true"></span>';

describe('renderText', () => {
  it('a reply with a bullet list right under a paragraph renders the list, not one run-on paragraph', () => {
    const reply =
      'I built the landing page.\n\n- **Hero image:** the generator returned gradients.\n- **Service report:** labelled "Illustrative".\n- **Monospace figures:** kept, they are data.';
    expect(html(reply)).toBe(
      '<p>I built the landing page.</p><ul><li><strong>Hero image:</strong> the generator returned gradients.</li><li><strong>Service report:</strong> labelled &quot;Illustrative&quot;.</li><li><strong>Monospace figures:</strong> kept, they are data.</li></ul>',
    );
  });

  it('numbered items keep their first number; blank lines between items keep one list; an indented line continues its item', () => {
    expect(html('Next:\n3. Swap the photo\n\n4. Check `Hero`\n   on mobile')).toBe('<p>Next:</p><ol start="3"><li>Swap the photo</li><li>Check <code>Hero</code> on mobile</li></ol>');
  });

  it('bold at a line start, a year opening a sentence and a single line break stay prose', () => {
    expect(html('**Done.** The page is ready\nin Preview.\n\n2024. That year we opened.')).toBe('<p><strong>Done.</strong> The page is ready in Preview.</p><p>2024. That year we opened.</p>');
  });

  it('a prose line after a list starts a paragraph, and the streaming caret follows the last block', () => {
    expect(html('- one\n- two\nThat is all', true)).toBe(`<ul><li>one</li><li>two</li></ul><p>That is all${CARET}</p>`);
    expect(html('- one\n- two', true)).toBe(`<ul><li>one</li><li>two${CARET}</li></ul>`);
  });
});
