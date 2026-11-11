import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { OcelotDocument, ORIGIN } from './document';
import { decodeDocument, encodeDocument } from './persistence';

describe('loading a crafted document', () => {
  it('drops keyframes and state declarations the write paths would have refused', () => {
    const doc = new OcelotDocument();
    const ops = doc.ops(ORIGIN.human);
    const ab = ops.createArtboard({ name: 'A' });
    const [btn] = ops.insertNodes(ab, [{ type: 'frame', states: { hover: { opacity: '0.5' } } }]);
    ops.setKeyframes('good', [{ offset: 'from', styles: { opacity: '0' } }, { offset: 'to', styles: { opacity: '1' } }]);
    // Bypass the validated paths, as a hand-edited file would.
    doc.ydoc.transact(() => {
      doc.keyframes.set('evil}</style><script>x</script>', [{ offset: 'from', styles: { opacity: '0' } }]);
      doc.keyframes.set('mixed', [
        { offset: 'from', styles: { opacity: '0', color: 'red;}</style><script>' } },
        { offset: 'to', styles: { background: 'url(x) ; } body { x: y' } },
      ]);
      const hover = (doc.ynode(btn!).get('states') as Y.Map<Y.Map<string>>).get('hover')!;
      hover.set('color', 'red; } body { background: red');
      hover.set('transform', 'scale(2)');
      (doc.ynode(btn!).get('states') as Y.Map<Y.Map<string>>).set('bogus', new Y.Map<string>());
    }, ORIGIN.system);

    const loaded = decodeDocument(JSON.parse(JSON.stringify(encodeDocument(doc))));
    const keyframes = loaded.keyframesMap();
    expect(Object.keys(keyframes).sort()).toEqual(['good', 'mixed']);
    expect(keyframes['good']).toHaveLength(2);
    expect(keyframes['mixed']).toEqual([{ offset: 'from', styles: { opacity: '0' } }]); // the stop with only a bad value is gone
    expect(loaded.require(btn!).states).toEqual({ hover: { opacity: '0.5', transform: 'scale(2)' } });
  });

  it('leaves a clean document untouched', () => {
    const doc = new OcelotDocument();
    doc.ops(ORIGIN.human).setKeyframes('fade', [{ offset: 'from', styles: { opacity: '0' } }, { offset: 'to', styles: { opacity: '1' } }]);
    expect(decodeDocument(JSON.parse(JSON.stringify(encodeDocument(doc)))).keyframesMap()).toEqual(doc.keyframesMap());
  });
});
