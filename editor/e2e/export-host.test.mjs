import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, createExportHost, pdfWrapperHtml, validateExport, validateFileName } from './export-host.mjs';

let root;
let pkg;
let events;
let calls;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ocelot-export-host-'));
  pkg = join(root, 'doc.ocelot');
  events = [];
  calls = { capture: [], pdf: [] };
});
afterEach(() => rm(root, { recursive: true, force: true }));

const host = (over = {}) =>
  createExportHost({
    getPackageDir: async () => pkg,
    capture: async (a) => {
      calls.capture.push(a);
      return { buffer: Buffer.from(`${a.type}:${a.width * a.scale}x${a.height * a.scale}`), width: a.width * a.scale, height: a.height * a.scale };
    },
    renderPdf: async (items) => {
      calls.pdf.push(items);
      return Buffer.from(`%PDF fake ${items.length} pages`);
    },
    thumbnail: async (buffer) => `thumb(${buffer.toString()})`,
    notify: (e) => events.push(e),
    ...over,
  });

const item = (file, extra = {}) => ({ file, html: '<html></html>', width: 200, height: 100, ...extra });
const run = (h, params) => h.handlers['host.exportRun']({ runId: 'r', kind: 'png', scale: 2, destination: 'exports', suggestedName: 'Doc.pdf', items: [item('A@2x.png')], ...params });

describe('validation', () => {
  it('accepts plain file names with the right extension and refuses the rest', () => {
    expect(validateFileName('Page 1 — Home@2x.png', 'png')).toBe('Page 1 — Home@2x.png');
    for (const bad of ['../a.png', 'a/b.png', '.hidden.png', 'a.jpg', 'a:b.png', '.png', '', 'x'.repeat(201) + '.png']) {
      expect(() => validateFileName(bad, 'png'), bad).toThrow(/not a valid export file name/);
    }
  });

  it('checks kind, items, scale, duplicates and the 8192px limit with messages that say what to do', () => {
    const base = { kind: 'png', scale: 2, suggestedName: 'x.pdf', items: [item('a.png')] };
    expect(() => validateExport({ ...base, kind: 'gif' })).toThrow(/kind must be/);
    expect(() => validateExport({ ...base, items: [] })).toThrow(/Nothing to export/);
    expect(() => validateExport({ ...base, scale: 4 })).toThrow(/scale must be/);
    expect(() => validateExport({ ...base, items: [item('a.png'), item('a.png')] })).toThrow(/Two files are both named/);
    expect(() => validateExport({ ...base, scale: 3, items: [item('big.png', { width: 4000 })] })).toThrow(/Use a lower scale/);
    expect(() => validateExport({ ...base, kind: 'pdf', suggestedName: '../x.pdf' })).toThrow(/not a valid export file name/);
    expect(validateExport({ ...base, kind: 'pdf', items: [item('Home')] })).toEqual({ ext: 'pdf', pdfName: 'x.pdf' });
  });
});

describe('host.exportRun', () => {
  it('writes PNGs below <package>/exports with previews and reports progress', async () => {
    const h = host();
    const res = await run(h, { previews: 1, items: [item('Page 1 — Home@2x.png'), item('Page 1 — Pricing@2x.png', { nodeId: 'n1', transparent: true })] });
    expect(res.folder).toMatch(/doc\.ocelot[/\\]exports$/);
    expect(res.files.map((f) => [f.name, f.width, f.height])).toEqual([['Page 1 — Home@2x.png', 400, 200], ['Page 1 — Pricing@2x.png', 400, 200]]);
    expect(res.files[0].preview).toBe('thumb(png:400x200)');
    expect(res.files[1].preview).toBeUndefined();
    expect(await readFile(res.files[0].path, 'utf8')).toBe('png:400x200');
    expect(calls.capture.map((c) => [c.scale, c.nodeId, c.transparent, c.type])).toEqual([[2, undefined, false, 'png'], [2, 'n1', true, 'png']]);
    expect(events.map((e) => e.message)).toEqual(['Rendering 1 of 2: Page 1 — Home@2x.png', 'Rendering 2 of 2: Page 1 — Pricing@2x.png', 'Saving']);
    expect(events.at(-1)).toMatchObject({ runId: 'r', done: 2, total: 2 });
  });

  it('JPG asks for jpeg and never for transparency', async () => {
    const res = await run(host(), { kind: 'jpg', scale: 1, items: [item('A.jpg', { transparent: true })] });
    expect(calls.capture[0]).toMatchObject({ type: 'jpeg', transparent: false });
    expect(await readFile(res.files[0].path, 'utf8')).toBe('jpeg:200x100');
  });

  it('PDF: one combined file, page count reported, preview of the first page', async () => {
    const res = await run(host(), { kind: 'pdf', suggestedName: 'Mobile.pdf', previews: 1, items: [item('M1', { width: 390, height: 844 }), item('M2', { width: 390, height: 700 })] });
    expect(res.files).toHaveLength(1);
    expect(res.files[0]).toMatchObject({ name: 'Mobile.pdf', pages: 2, width: 390, height: 844, preview: 'thumb(png:390x844)' });
    expect(calls.pdf[0].map((i) => i.file)).toEqual(['M1', 'M2']);
    expect(await readdir(join(pkg, 'exports'))).toEqual(['Mobile.pdf']);
  });

  it('PDF with speaker notes: the pages come out, and the host says it cannot annotate them', async () => {
    const res = await run(host(), { kind: 'pdf', suggestedName: 'Deck.pdf', items: [item('S1', { notes: 'Say hello.' }), item('S2')] });
    expect(res.files[0]).toMatchObject({ name: 'Deck.pdf', pages: 2 });
    expect(res.warnings).toEqual([expect.stringMatching(/Speaker notes are not in this PDF.*Export PPTX/)]);
    expect((await run(host(), { kind: 'pdf', suggestedName: 'Deck.pdf', items: [item('S1'), item('S2')] })).warnings).toBeUndefined();
  });

  it('overwrites the same name in place', async () => {
    const h = host();
    await run(h, {});
    await run(h, { items: [item('A@2x.png', { width: 10, height: 10 })] });
    expect(await readFile(join(pkg, 'exports', 'A@2x.png'), 'utf8')).toBe('png:20x20');
  });

  it('a dialog or the pasteboard is the Mac app\'s: it says so', async () => {
    await expect(run(host(), { destination: 'panel' })).rejects.toMatchObject({ code: 'host_unavailable', message: expect.stringContaining('export_image') });
    await expect(run(host(), { destination: 'clipboard' })).rejects.toMatchObject({ code: 'host_unavailable' });
    await expect(run(host(), { destination: 'elsewhere' })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('cancel stops before the next render and writes nothing', async () => {
    const h = host({
      capture: async (a) => {
        calls.capture.push(a);
        await h.handlers['host.exportCancel']({ runId: 'r' });
        return { buffer: Buffer.from('x'), width: 1, height: 1 };
      },
    });
    const res = await run(h, { items: [item('A.png'), item('B.png')] });
    expect(res).toEqual({ files: [], cancelled: true });
    expect(calls.capture).toHaveLength(1);
    await expect(readdir(join(pkg, 'exports'))).resolves.toEqual([]);
  });

  it('refuses an exports folder that is a symlink out of the package', async () => {
    await mkdir(pkg, { recursive: true });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(pkg, 'exports'));
    await expect(run(host(), {})).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('outside the package') });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('host.exportWriteFile', () => {
  const write = (h, params) => h.handlers['host.exportWriteFile']({ runId: 'r', name: 'Pitch.pptx', destination: 'exports', dataBase64: Buffer.from('PK-bytes').toString('base64'), ...params });

  it('writes the decoded bytes below <package>/exports and reports the file', async () => {
    const res = await write(host(), { width: 1920, height: 1080, pages: 8 });
    expect(res.files).toEqual([{ name: 'Pitch.pptx', path: join(await realpath(pkg), 'exports', 'Pitch.pptx'), bytes: 8, width: 1920, height: 1080, pages: 8 }]);
    expect(await readFile(join(pkg, 'exports', 'Pitch.pptx'), 'utf8')).toBe('PK-bytes');
    await write(host(), { dataBase64: Buffer.from('v2').toString('base64') });
    expect(await readFile(join(pkg, 'exports', 'Pitch.pptx'), 'utf8')).toBe('v2'); // re-export overwrites in place
  });

  it('refuses other extensions, odd names, empty or oversized data and the dialog, with what to do next', async () => {
    await expect(write(host(), { name: 'x.exe' })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('.pptx') });
    await expect(write(host(), { name: '../evil.pptx' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(write(host(), { dataBase64: '' })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('base64') });
    await expect(write(host(), { dataBase64: 'A'.repeat(Math.ceil((MAX_FILE_BYTES / 3) * 4) + 8) })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('larger than 256 MB') });
    await expect(write(host(), { destination: 'panel' })).rejects.toMatchObject({ code: 'host_unavailable', message: expect.stringContaining('export_deck') });
    await expect(write(host(), { destination: 'desktop' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(readdir(join(pkg, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('pdfWrapperHtml', () => {
  it('gives every artboard its own named page of exactly its size in points, in order', () => {
    const html = pdfWrapperHtml([item('a', { width: 1440, height: 900 }), item('b', { width: 390, height: 844, html: '<p class="x">"hi" & bye</p>' })]);
    expect(html).toContain('@page p0{size:1440pt 900pt;margin:0}');
    expect(html).toContain('@page p1{size:390pt 844pt;margin:0}');
    expect(html.indexOf('page:p0')).toBeLessThan(html.indexOf('page:p1'));
    expect(html).toContain('break-before:page');
    expect(html).not.toContain('class="x"'); // quotes inside the srcdoc value are escaped
    expect(html).toContain('&amp; bye');
    expect(html).toContain('&quot;hi&quot;');
  });
});
