import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { OcelotDocument, ORIGIN } from './document';
import { History } from './history';
import { checkInvariants } from './invariants';
import { FORMAT_VERSION, decodeDocument, encodeDocument } from './persistence';
import { ModelError } from './types';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const history = new History(doc);
  const human = doc.ops(ORIGIN.human);
  const agent = doc.ops(ORIGIN.agent);
  return { doc, history, human, agent };
}

describe('pages: model', () => {
  it('a new document has one page, and artboards join the first page by default', () => {
    const { doc, human } = setup();
    expect(doc.pageIds()).toHaveLength(1);
    expect(doc.pageName(doc.pageIds()[0]!)).toBe('Page 1');
    const a = human.createArtboard({ name: 'A' });
    expect(doc.pageOfArtboard(a)).toBe(doc.firstPageId());
    expect(doc.pageOf(human.insertNodes(a, [{ type: 'frame' }])[0]!)).toBe(doc.firstPageId());
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('creates, renames and reorders pages', () => {
    const { doc, human } = setup();
    const p1 = doc.firstPageId();
    const p2 = human.createPage({ name: 'Mobile' });
    const p3 = human.createPage({ name: 'Brand', after: p1 });
    expect(doc.pageIds()).toEqual([p1, p3, p2]);
    expect(human.createPage()).toBeTruthy();
    expect(doc.pageName(doc.pageIds().at(-1)!)).toBe('Page 4');
    human.renamePage(p2, '  Phone  ');
    expect(doc.pageName(p2)).toBe('Phone');
    expect(() => human.renamePage(p2, '  ')).toThrow(ModelError);
    human.movePage(p2, 0);
    expect(doc.pageIds().slice(0, 3)).toEqual([p2, p1, p3]);
    human.movePage(p2, -1);
    expect(doc.pageIds().at(-1)).toBe(p2);
    expect(() => human.movePage('nope', 0)).toThrow(/list_pages/);
  });

  it('keeps artboard order per page and lists all pages in page order', () => {
    const { doc, human } = setup();
    const p1 = doc.firstPageId();
    const p2 = human.createPage({ name: 'B' });
    const a = human.createArtboard({ name: 'a1' });
    const b = human.createArtboard({ name: 'b1', pageId: p2 });
    const c = human.createArtboard({ name: 'a2' });
    const d = human.createArtboard({ name: 'b2', pageId: p2 });
    expect(doc.artboardIds(p1)).toEqual([a, c]);
    expect(doc.artboardIds(p2)).toEqual([b, d]);
    expect(doc.artboardIds()).toEqual([a, c, b, d]);
    human.movePage(p2, 0);
    expect(doc.artboardIds()).toEqual([b, d, a, c]);
    expect(doc.pageList().map((p) => p.artboards)).toEqual([[b, d], [a, c]]);
    expect(() => human.createArtboard({ pageId: 'missing' })).toThrow(/does not exist/);
  });

  it('places a new artboard relative to its own page only', () => {
    const { doc, human } = setup();
    const p2 = human.createPage({ name: 'B' });
    const first = human.createArtboard({ name: 'Home — Desktop' });
    const other = human.createArtboard({ name: 'Home — Desktop', pageId: p2 });
    // Same name and size on different pages: both start at the origin of their own canvas.
    expect(doc.require(other).frame).toMatchObject({ x: doc.require(first).frame!.x, y: doc.require(first).frame!.y });
  });

  it('moves artboards between pages, appending to the target, and avoids overlaps there', () => {
    const { doc, human } = setup();
    const p1 = doc.firstPageId();
    const p2 = human.createPage({ name: 'B' });
    const a = human.createArtboard({ name: 'A', x: 0, y: 0, width: 400, height: 300 });
    const b = human.createArtboard({ name: 'B', x: 2000, y: 0, width: 400, height: 300 });
    const c = human.createArtboard({ name: 'C', x: 0, y: 0, width: 400, height: 300, pageId: p2 });
    expect(human.moveArtboardsToPage([a, b], p2)).toEqual([a, b]);
    expect(doc.artboardIds(p1)).toEqual([]);
    expect(doc.artboardIds(p2)).toEqual([c, a, b]);
    // `a` overlapped `c` at (0,0), so it got free space; `b` kept its spot.
    const f = doc.require(a).frame!;
    expect(f.x >= 400 || f.y >= 300).toBe(true);
    expect(doc.require(b).frame).toMatchObject({ x: 2000, y: 0 });
    expect(human.moveArtboardsToPage([a], p2)).toEqual([]);
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('refuses to move non-artboards and unknown ids', () => {
    const { doc, human } = setup();
    const p2 = human.createPage();
    const a = human.createArtboard();
    const [child] = human.insertNodes(a, [{ type: 'frame' }]);
    expect(() => human.moveArtboardsToPage([child!], p2)).toThrow(/not an artboard/);
    expect(() => human.moveArtboardsToPage(['ghost'], p2)).toThrow(/does not exist/);
    expect(doc.pageOfArtboard(a)).toBe(doc.firstPageId());
  });

  it('duplicates a page with deep copies of its artboards in place', () => {
    const { doc, human } = setup();
    const p1 = doc.firstPageId();
    const a = human.createArtboard({ name: 'A', x: 10, y: 20, width: 500, height: 400, styles: { 'background-color': '#123456' } });
    const [box] = human.insertNodes(a, [{ type: 'frame', styles: { padding: '8px' }, children: [{ type: 'text', text: 'Hi' }] }]);
    const copy = human.duplicatePage(p1);
    expect(doc.pageIds()).toEqual([p1, copy]);
    expect(doc.pageName(copy)).toBe('Page 1 copy');
    const [a2] = doc.artboardIds(copy);
    expect(a2).not.toBe(a);
    expect(doc.require(a2!)).toMatchObject({ name: 'A', styles: { 'background-color': '#123456' }, frame: { x: 10, y: 20, width: 500, height: 400 } });
    const [box2] = doc.childIds(a2!);
    expect(box2).not.toBe(box);
    expect(doc.require(box2!).styles.padding).toBe('8px');
    expect(doc.require(doc.childIds(box2!)[0]!).text).toBe('Hi');
    expect(doc.artboardIds(p1)).toEqual([a]);
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('duplicating an artboard keeps it on its page', () => {
    const { doc, human } = setup();
    const p2 = human.createPage();
    const a = human.createArtboard({ pageId: p2 });
    const [copy] = human.duplicateNodes([a]);
    expect(doc.pageOfArtboard(copy!)).toBe(p2);
  });

  it('deletes a page with its artboards and refuses the last page', () => {
    const { doc, human } = setup();
    const p1 = doc.firstPageId();
    const p2 = human.createPage({ name: 'B' });
    const a = human.createArtboard({ pageId: p2 });
    const [child] = human.insertNodes(a, [{ type: 'frame' }]);
    const keep = human.createArtboard();
    expect(human.deletePage(p2)).toEqual([a]);
    expect(doc.pageIds()).toEqual([p1]);
    expect(doc.has(a)).toBe(false);
    expect(doc.has(child!)).toBe(false);
    expect(doc.artboardIds()).toEqual([keep]);
    expect(() => human.deletePage(p1)).toThrow(/last page/);
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('page operations are undoable steps for the right actor', () => {
    const { doc, history, human, agent } = setup();
    const p1 = doc.firstPageId();
    const p2 = human.createPage({ name: 'B' });
    history.breakHumanStep();
    const a = human.createArtboard({ pageId: p2 });
    history.breakHumanStep();
    history.beginAgentBatch('Reorganize');
    agent.renamePage(p2, 'Mobile');
    agent.movePage(p2, 0);
    agent.moveArtboardsToPage([a], p1);
    history.endAgentBatch();
    expect(doc.pageIds()).toEqual([p2, p1]);
    expect(doc.pageOfArtboard(a)).toBe(p1);

    expect(history.undo()).toMatchObject({ actor: 'agent', label: 'Reorganize' });
    expect(doc.pageIds()).toEqual([p1, p2]);
    expect(doc.pageName(p2)).toBe('B');
    expect(doc.pageOfArtboard(a)).toBe(p2);
    history.redo();
    expect(doc.pageIds()).toEqual([p2, p1]);

    history.undo();
    history.undo(); // human: the artboard
    expect(doc.has(a)).toBe(false);
    history.undo(); // human: the page
    expect(doc.pageIds()).toEqual([p1]);
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('undoing a page delete restores the page and its artboards; undoing a page creation moves strays to the first page', () => {
    const { doc, history, human, agent } = setup();
    const p1 = doc.firstPageId();
    const p2 = human.createPage({ name: 'B' });
    const a = human.createArtboard({ pageId: p2 });
    history.breakHumanStep();
    agent.deletePage(p2);
    expect(doc.has(a)).toBe(false);
    history.undo();
    expect(doc.pageIds()).toEqual([p1, p2]);
    expect(doc.artboardIds(p2)).toEqual([a]);

    // A page vanishes while an artboard still points at it (its creation was undone by another actor):
    // the repair pass sends the artboard to the first page.
    const p3 = agent.createPage({ name: 'C' });
    const b = agent.createArtboard({ pageId: p1 });
    agent.moveArtboardsToPage([b], p3);
    expect(doc.pageOfArtboard(b)).toBe(p3);
    doc.ydoc.transact(() => {
      doc.pages.delete(p3);
      doc.pageOrder.delete(doc.pageOrder.toArray().indexOf(p3), 1);
    }, ORIGIN.system);
    expect(doc.pageOfArtboard(b)).toBeNull();
    doc.ensurePages();
    expect(doc.pageOfArtboard(b)).toBe(doc.firstPageId());
    expect(checkInvariants(doc)).toEqual([]);
  });
});

describe('pages: persistence and migration', () => {
  /** A document the way version 1 wrote it: no pages, no page pointers on artboards. */
  function legacyFile() {
    const { doc, human } = setup();
    human.createArtboard({ name: 'One' });
    human.createArtboard({ name: 'Two' });
    human.createArtboard({ name: 'Three' });
    doc.ydoc.transact(() => {
      doc.pages.forEach((_v, k) => doc.pages.delete(k));
      doc.pageOrder.delete(0, doc.pageOrder.length);
      for (const id of doc.artboards.toArray()) doc.ynode(id).delete('page');
    }, ORIGIN.system);
    const file = JSON.parse(JSON.stringify(encodeDocument(doc)));
    file.version = 1;
    delete file.currentPageId;
    delete file.tree.pages;
    return { file, ids: doc.artboardIds() };
  }

  it('loads a version-1 document as one page "Page 1" holding every artboard, in order', () => {
    const { file, ids } = legacyFile();
    const doc = decodeDocument(file);
    expect(doc.pageIds()).toHaveLength(1);
    const page = doc.page(doc.pageIds()[0]!)!;
    expect(page.name).toBe('Page 1');
    expect(page.artboards).toEqual(ids);
    expect(doc.artboardIds()).toEqual(ids);
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('saves version 2 with the pages in the readable tree and the current page next to the document', () => {
    const { doc, human } = setup();
    const p2 = human.createPage({ name: 'Mobile' });
    const a = human.createArtboard({ pageId: p2 });
    const file = encodeDocument(doc, new Date(0), { currentPageId: p2 });
    expect(file.version).toBe(FORMAT_VERSION);
    expect(FORMAT_VERSION).toBe(2);
    expect(file.currentPageId).toBe(p2);
    expect(file.tree.pages).toEqual([
      { id: doc.firstPageId(), name: 'Page 1', artboards: [] },
      { id: p2, name: 'Mobile', artboards: [a] },
    ]);
    const back = decodeDocument(JSON.parse(JSON.stringify(file)));
    expect(back.pageList()).toEqual(doc.pageList());
    // A current page that does not exist is not written.
    expect(encodeDocument(doc, new Date(0), { currentPageId: 'gone' }).currentPageId).toBeUndefined();
  });

  it('repairs a page list that disagrees with the pages (dangling, duplicate and unlisted ids)', () => {
    const { doc, human } = setup();
    const p2 = human.createPage({ name: 'B' });
    doc.ydoc.transact(() => {
      doc.pageOrder.push(['ghost', p2]);
      const extra = new Y.Map<unknown>();
      extra.set('id', 'p_extra');
      extra.set('name', 'Extra');
      doc.pages.set('p_extra', extra);
    }, ORIGIN.system);
    expect(doc.ensurePages()).toBeGreaterThan(0);
    expect(doc.pageIds().sort()).toEqual([doc.firstPageId(), p2, 'p_extra'].sort());
    expect(new Set(doc.pageIds()).size).toBe(3);
  });
});
