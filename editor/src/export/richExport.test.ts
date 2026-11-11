// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shapeSpec } from '../canvas/shapes';
import { Editor } from '../editor/Editor';
import { fillsToStyles, newGradient } from '../panels/fills';
import { exportHtml } from './html';
import { exportReact } from './react';

// What the new editing surfaces write (rich text markup, stacked fills, shapes) must survive both exports.
describe('exports of rich text, stacked fills and shapes', () => {
  function setup() {
    const editor = new Editor();
    const artboard = editor.doc.artboardIds()[0]!;
    const [text, card, ellipse, line] = editor.agent.insertNodes(artboard, [
      {
        type: 'text',
        tag: 'p',
        html: 'Save <b>20%</b> <span style="color: #ff6a00; font-size: 24px">today</span> <a href="https://example.com/x" style="text-decoration: underline">now</a>',
        styles: { margin: '0' },
      },
      { type: 'frame', styles: { width: '200px', height: '100px', ...Object.fromEntries(Object.entries(fillsToStyles([newGradient('linear', '#336699'), { type: 'solid', color: 'rgba(0, 0, 0, 0.4)' }])).filter(([, v]) => v !== null)) as Record<string, string> } },
      shapeSpec('ellipse', { width: 80, height: 80, colors: { fill: '#d9d9d9', stroke: '#111' } }),
      shapeSpec('line', { width: 120, height: 1, colors: { fill: '#d9d9d9', stroke: '#111111' } }),
    ]);
    return { editor, artboard, text: text!, card: card!, ellipse: ellipse!, line: line! };
  }

  it('HTML export keeps the inline markup and every style value', () => {
    const { editor, artboard } = setup();
    const html = exportHtml(editor.doc, artboard);
    expect(html).toContain('Save <b>20%</b> <span style="color: #ff6a00; font-size: 24px">today</span> <a href="https://example.com/x" style="text-decoration: underline">now</a>');
    expect(html).toContain('linear-gradient(180deg, #336699 0%, rgba(51, 102, 153, 0) 100%), rgba(0, 0, 0, 0.4)');
    expect(html).toContain('border-radius: 50%');
    expect(html).toContain('height: 1px');
  });

  it('React export turns the inline styles into JSX and keeps classes for the rest', () => {
    const { editor, artboard } = setup();
    const { code } = exportReact(editor.doc, artboard);
    expect(code).toContain('<b>20%</b>');
    expect(code).toContain('color: "#ff6a00"');
    expect(code).toContain('fontSize: "24px"');
    expect(code).toContain('href="https://example.com/x"');
    expect(code).toContain('rounded-[50%]');
    // A gradient over a color must stay one `background` value: `bg-[…]` would put the color into background-image.
    expect(code).toContain('[background:linear-gradient(180deg,#336699_0%,rgba(51,102,153,0)_100%),rgba(0,0,0,0.4)]');
    expect(code).not.toMatch(/bg-\[linear-gradient\([^\]]*\),rgba/);
  });
});
