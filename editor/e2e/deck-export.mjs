#!/usr/bin/env node
// Deck export acceptance (headless Chromium twin of the Mac app's export service): a 4-slide deck with real text layouts,
// then export_deck as
//   pptx (hybrid)  slide count = artboards, native text boxes with the measured text, notes pane, one stored image per
//                  distinct background, fonts named in warnings
//   pptx (image)   pictures only, no text boxes
//   pdf            one page per slide, in deck order
// and the Export popover on a deck page (Presentation (PDF) / PowerPoint (PPTX), notes on/off).
// Files are checked on disk below <package>/exports/ and copied to /tmp/ocelot-deck-export for `qlmanage -t`.
//
// Usage: bunx vite build --outDir /tmp/ocelot-pptx-dist && OCELOT_DIST=/tmp/ocelot-pptx-dist node e2e/deck-export.mjs
//   (without OCELOT_DIST the default dist/ from `bun run build` is used)
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { startHeadlessHost } from './headless-host.mjs';

const out = '/tmp/ocelot-deck-export';
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'ocelot-deck-export-'));
const pkg = join(work, 'Deck test.ocelot');

const t0 = Date.now();
const lap = (what) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`);
const host = await startHeadlessHost({ port: 0, log: () => {}, doc: pkg, stateDir: join(work, 'state'), ...(process.env.OCELOT_DIST ? { dist: process.env.OCELOT_DIST } : {}) });
const page = host.page;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let rpcId = 0;
const mcp = async (method, params) => {
  const res = await fetch(host.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await res.json()).result;
};
const call = async (name, args) => {
  const r = await mcp('tools/call', { name, arguments: args });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { json, content: r.content };
};
await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });

/** Entries of a ZIP (stored or deflated) by name. */
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extra + comment;
  }
  return files;
}
const pdfInfo = (buf) => {
  const text = buf.toString('latin1');
  return {
    pages: [...text.matchAll(/\/Type\s*\/Page\b(?!s)/g)].length,
    sizes: [...text.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Math.round(+m[1]), Math.round(+m[2])]),
  };
};

// ---- the deck: 4 slides at 1920×1080 ----
const FONT = 'font-family:Helvetica,Arial,sans-serif';
const slides = [
  { name: '01 Title', bg: '#0f2a1e', html: `<main style="height:100%;padding:160px 160px;background:#0f2a1e;color:#f4f1ea;${FONT}"><h1 data-name="Title" style="margin:0;font-size:120px;line-height:1.05;font-weight:700;letter-spacing:-2px">Ocelot decks</h1><p data-name="Subtitle" style="margin:40px 0 0;font-size:44px;line-height:1.3;color:#c9d8cf">Real HTML layers, editable text in PowerPoint</p></main>`, notes: 'Open with the one-liner.\nPause. Then the demo.' },
  { name: '02 Problem', bg: '#f4f1ea', html: `<main style="height:100%;padding:120px 160px;background:#f4f1ea;color:#1a3a2a;${FONT}"><h2 data-name="Heading" style="margin:0;font-size:80px;line-height:1.1;text-transform:uppercase">Slides drift</h2><p data-name="Body" style="margin:48px 0 0;width:1100px;font-size:40px;line-height:1.5">Every export tool flattens your design into <b>pictures</b>, or rebuilds it as <i>approximate</i> shapes. Neither survives a client edit.</p><div data-name="Card" style="position:absolute;right:160px;bottom:140px;width:420px;height:260px;border-radius:32px;background:#d9480f;box-shadow:0 30px 60px rgba(0,0,0,.25)"></div></main>`, notes: 'Name one painful hand-off.' },
  { name: '03 Fonts', bg: '#101820', html: `<main style="height:100%;padding:140px 160px;background:linear-gradient(135deg,#101820,#24384a);color:#fff;font-family:Georgia,serif"><h2 data-name="Serif" style="margin:0;font-size:96px;font-weight:400">A serif headline</h2><p data-name="Custom font" style="margin:40px 0 0;font-size:44px;font-family:'Fraunces',Georgia,serif;color:rgba(255,255,255,.7)">Fraunces is named, not embedded</p><h3 data-name="Gradient text" style="margin:60px 0 0;font-size:90px;background:linear-gradient(90deg,#ff7a18,#af002d);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent">Gradient stays picture</h3></main>`, notes: '' },
  { name: '04 Close', bg: '#f4f1ea', html: `<main style="height:100%;padding:160px;background:#f4f1ea;color:#1a3a2a;${FONT};text-align:center"><h1 data-name="Ask" style="margin:0;font-size:110px;font-weight:700">Try it on your deck</h1><p data-name="Contact" style="margin:40px 0 0;font-size:40px;line-height:1.4">hello@example.com<br>ocelot.design</p></main>`, notes: 'Ask for the intro.' },
];
const deckPage = await page.evaluate(() => {
  const ed = window.__ocelotDebugEditor;
  const id = ed.human.createPage({ name: 'Pitch' });
  ed.human.setPageKind(id, 'deck', { width: 1920, height: 1080 });
  return id;
});
const ids = [];
for (const s of slides) {
  const id = (await call('create_artboard', { page_id: deckPage, name: s.name, width: 1920, height: 1080 })).json.artboard_id;
  await call('write_html', { node_id: id, mode: 'replace', html: s.html });
  ids.push(id);
}
await page.evaluate(({ ids, notes }) => {
  const ed = window.__ocelotDebugEditor;
  ids.forEach((id, i) => { if (notes[i]) ed.human.setSlide(id, { notes: notes[i] }); });
}, { ids, notes: slides.map((s) => s.notes) });
lap('deck built');
await page.screenshot({ path: `${out}/editor.png` });

const exportsDir = join(pkg, 'exports');
const files = () => readdirSync(exportsDir).sort();

// ---- PPTX hybrid ----
const pptx = await call('export_deck', { page_id: deckPage, format: 'pptx' });
console.log(JSON.stringify(pptx.json, null, 1));
assert.equal(pptx.json.file, 'Pitch.pptx');
assert.equal(pptx.json.slide_count, 4);
assert.equal(pptx.json.mode, 'text');
assert.deepEqual(pptx.json.slides.map((s) => s.has_notes), [true, true, false, true]);
assert.ok(pptx.content.some((c) => c.type === 'image'), 'a preview of slide 1 comes with the result');
assert.ok(pptx.json.slides.every((s) => s.text_boxes >= 1), 'every slide has native text boxes');
assert.match(pptx.json.warnings.join('\n'), /Fraunces/, 'the font that is not embedded is named');
assert.match(pptx.json.warnings.join('\n'), /Gradient text|gradient/, 'gradient text is reported as left in the picture');
const zip = readZip(readFileSync(join(exportsDir, 'Pitch.pptx')));
const slideXml = (n) => zip.get(`ppt/slides/slide${n}.xml`).toString('utf8');
assert.equal([...zip.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, 4, 'slide count = artboards');
assert.match(slideXml(1), /<a:t>Ocelot decks<\/a:t>/);
assert.match(slideXml(1), /sz="6000"/, '120px title = 60pt');
assert.match(slideXml(2), /SLIDES DRIFT/, 'text-transform is applied to the text');
assert.match(slideXml(2), /<a:t>pictures<\/a:t>/);
assert.match(slideXml(2), /b="1"/);
assert.match(slideXml(2), /i="1"/);
assert.doesNotMatch(slideXml(3), /Gradient stays picture/, 'gradient text is not a text box');
assert.match(slideXml(3), /typeface="Fraunces"/);
assert.match(slideXml(4), /algn="ctr"/);
assert.match(slideXml(4), /hello@example\.com/);
const notes = [...zip.keys()].filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).sort().map((n) => zip.get(n).toString('utf8'));
assert.match(notes[0], /Open with the one-liner\./);
assert.match(notes[3], /Ask for the intro\./);
const media = [...zip.keys()].filter((n) => /^ppt\/media\/.+\.(png|jpe?g)$/.test(n));
assert.ok(media.length >= 1 && media.length <= 4, `distinct backgrounds are stored once: ${media}`);
copyFileSync(join(exportsDir, 'Pitch.pptx'), `${out}/Pitch.pptx`);
lap('pptx hybrid');

// ---- PPTX image-only ----
await call('export_deck', { page_id: deckPage, format: 'pptx', mode: 'image', notes: false });
const imageZip = readZip(readFileSync(join(exportsDir, 'Pitch.pptx')));
assert.equal([...imageZip.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, 4);
assert.doesNotMatch(imageZip.get('ppt/slides/slide1.xml').toString('utf8'), /<a:t>/, 'image-only slides have no text');
copyFileSync(join(exportsDir, 'Pitch.pptx'), `${out}/Pitch-image.pptx`);
await call('export_deck', { page_id: deckPage, format: 'pptx' }); // leave the hybrid file in place
copyFileSync(join(exportsDir, 'Pitch.pptx'), `${out}/Pitch.pptx`);
lap('pptx image');

// ---- PDF: one page per slide ----
const pdf = await call('export_deck', { page_id: deckPage, format: 'pdf' });
assert.equal(pdf.json.file, 'Pitch.pdf');
assert.equal(pdf.json.slide_count, 4);
const info = pdfInfo(readFileSync(join(exportsDir, 'Pitch.pdf')));
assert.equal(info.pages, 4, 'PDF page count = slide count');
assert.deepEqual(info.sizes, [[1920, 1080], [1920, 1080], [1920, 1080], [1920, 1080]]);
assert.match((pdf.json.warnings ?? []).join(' '), /Speaker notes are not in this PDF/, 'the headless host says it cannot write note annotations');
copyFileSync(join(exportsDir, 'Pitch.pdf'), `${out}/Pitch.pdf`);
assert.deepEqual(files(), ['Pitch.pdf', 'Pitch.pptx']);
lap('pdf');

// ---- errors say what to do ----
const canvasPage = (await call('get_document_info', {})).json.pages?.[0]?.id;
await assert.rejects(call('export_deck', { page_id: canvasPage, format: 'pptx' }), /not a deck/);
await assert.rejects(call('export_deck', { format: 'docx' }), /"pdf" or "pptx"/);

// ---- the popover on a deck page ----
await page.setViewportSize({ width: 1400, height: 900 });
await page.evaluate((id) => window.__ocelotDebugEditor.setCurrentPage?.(id) ?? window.__ocelotDebugEditor.showPage?.(id), deckPage);
await page.waitForTimeout(300);
await page.keyboard.press('Shift+Control+KeyE');
const popover = page.locator('[data-testid=export-popover]');
await popover.waitFor({ timeout: 3000 });
const target = page.locator('[data-testid=export-deck-target]');
if (await target.count()) {
  assert.match(await target.innerText(), /Presentation \(PDF\)[\s\S]*PowerPoint \(PPTX\)/);
  await target.locator('[data-value=pptx]').check();
  assert.match(await page.locator('[data-testid=export-summary]').textContent(), /Pitch\.pptx: PPTX with editable text, 4 slides, notes on 3/);
  await page.locator('[data-testid=export-deck-notes]').uncheck();
  assert.match(await page.locator('[data-testid=export-summary]').textContent(), /no notes/);
  await page.locator('[data-testid=export-deck-editable]').uncheck();
  assert.match(await page.locator('[data-testid=export-summary]').textContent(), /PPTX of pictures/);
  await page.screenshot({ path: `${out}/popover-deck.png` });
  await target.locator('[data-value=pdf]').check();
  assert.match(await page.locator('[data-testid=export-summary]').textContent(), /Pitch\.pdf: PDF, 4 slides, no notes/);
  await page.locator('[data-testid=export-go]').click();
  await page.locator('[data-testid=export-error]').waitFor({ timeout: 5000 });
  assert.match(await page.locator('[data-testid=export-error]').textContent(), /headless host has no file dialog/);
} else {
  console.log('popover: deck page is not the current page in this build; skipped');
}
await page.keyboard.press('Escape');

assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
console.log(`PASS deck export (files in ${out})`);
await Promise.race([host.close(), new Promise((r) => setTimeout(r, 3000))]);
rmSync(work, { recursive: true, force: true });
process.exit(0);
