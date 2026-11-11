// MCP tool `export_deck`: a deck page as one PDF (one page per slide) or a PowerPoint file. Like the other export tools it
// writes to the document's export folder (the agent never chooses a path). The humans' Export popover shares
// export/deckExport.ts.

import { ExportError } from '../export/fileExport';
import { runDeckExport, type DeckExportOutcome } from '../export/deckExport';
import { resolvePageId } from './pageTools';
import { ToolError, agentLabel, bool, str, type Args, type ToolContext, type ToolDef, type ToolResult } from './toolkit';

/** The deck to export: `page_id`, else the page the agent last worked on / the user views if that is a deck, else the document's only deck. */
function deckPageId(ctx: ToolContext, args: Args): string {
  const { doc } = ctx.editor;
  if (str(args, 'page_id', { optional: true }) !== undefined) return resolvePageId(ctx, args);
  const current = resolvePageId(ctx, args);
  if (doc.pageKind(current) === 'deck') return current;
  const decks = doc.pageIds().filter((id) => doc.pageKind(id) === 'deck');
  if (decks.length === 1) return decks[0]!;
  if (!decks.length) throw new ToolError('The document has no deck page. Create one with create_page { kind: "deck" } (read get_guide { topic: "slides-guide" } first), or turn a page into a deck with update_page { kind: "deck" }.');
  throw new ToolError(`The document has ${decks.length} decks (${decks.map((id) => `"${doc.requirePage(id).name}" ${id}`).join(', ')}). Pass page_id to say which one to export.`);
}

function resultJson(outcome: DeckExportOutcome, notes: boolean) {
  const { file } = outcome;
  return {
    folder: outcome.folder,
    file: file?.name,
    format: outcome.format,
    ...(outcome.mode ? { mode: outcome.mode } : {}),
    bytes: file?.bytes,
    slide_count: outcome.slides.length,
    notes,
    slides: outcome.slides.map((s, i) => ({
      index: i + 1,
      artboard_id: s.artboardId,
      name: s.name,
      has_notes: s.hasNotes,
      ...(s.textBoxes !== undefined ? { text_boxes: s.textBoxes } : {}),
      ...(s.warnings.length ? { warnings: s.warnings } : {}),
    })),
    ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
    next:
      outcome.format === 'pdf'
        ? 'The preview shows slide 1. The PDF has one page per slide; speaker notes are note annotations on their pages. The user finds the file in the export folder.'
        : 'The preview shows slide 1. Text boxes are editable text over a text-less picture of each slide; speaker notes are in the notes pane. The user finds the file in the export folder.',
  };
}

export const DECK_EXPORT_TOOLS: ToolDef[] = [
  {
    name: 'export_deck',
    title: 'Export a deck (PDF or PowerPoint)',
    readOnly: false,
    description:
      'Exports a DECK page (kind "deck": its artboards in page order are the slides) into the document\'s export folder (exports/ inside the .ocelot package; a temporary folder while the document is unsaved). ' +
      'You cannot choose the path; the file is named after the page (`<Page>.pdf` / `<Page>.pptx`, overwritten on re-export). ' +
      'format "pdf": one vector PDF page per slide at the slide size (the page count always equals the slide count); with notes true (default) each slide\'s speaker notes (set_slide) are note annotations on its page. ' +
      'format "pptx": a PowerPoint file, one slide per artboard, 13.333in wide. mode "text" (default) puts editable PowerPoint text boxes (measured from the real layout: font, size, weight, colour, spacing) over a text-less picture of the slide, so text can be edited but shapes cannot; ' +
      'mode "image" makes each slide one picture (exact, nothing editable). Speaker notes go into the notes pane when notes is true (default). ' +
      'Text that PowerPoint cannot reproduce stays in the picture and is reported (gradient text, rotated or filtered layers, text in code layers); fonts are named, not embedded, so PowerPoint substitutes any font the user does not have installed (the result lists them). ' +
      'The result gives the folder, file, one entry per slide (notes, text boxes, warnings) and a preview of slide 1. Check warnings and tell the user about fonts. page_id defaults to the deck you last worked on or the document\'s only deck. ' +
      'Use export_pdf for plain artboards and export_video for video pages.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The deck page (list_pages, get_deck). Default: the current deck.' },
        format: { type: 'string', enum: ['pdf', 'pptx'], description: 'pdf: one page per slide. pptx: PowerPoint.' },
        notes: { type: 'boolean', default: true, description: 'Include speaker notes (PDF: note annotations; PPTX: notes pane).' },
        mode: { type: 'string', enum: ['text', 'image'], default: 'text', description: 'pptx only. text: editable text boxes over a picture. image: each slide one picture.' },
      },
      required: ['format'],
      additionalProperties: false,
    },
    async run(args, ctx): Promise<ToolResult> {
      const format = str(args, 'format', { optional: false });
      if (format !== 'pdf' && format !== 'pptx') throw new ToolError('format must be "pdf" or "pptx". Use export_video for MP4, MOV or GIF.');
      const mode = str(args, 'mode', { optional: true }) ?? 'text';
      if (mode !== 'text' && mode !== 'image') throw new ToolError('mode must be "text" (editable text boxes) or "image" (each slide one picture).');
      if (format === 'pdf' && args['mode'] !== undefined) throw new ToolError('mode applies to pptx only. A PDF always keeps text as vector text.');
      const notes = bool(args, 'notes') ?? true;
      const pageId = deckPageId(ctx, args);
      let outcome: DeckExportOutcome;
      try {
        outcome = await runDeckExport(ctx.editor, ctx.host, { pageId, format, notes, mode, destination: 'exports', previews: 1 });
      } catch (err) {
        if (err instanceof ExportError) throw new ToolError(err.message);
        throw err;
      }
      ctx.editor.ui.toast(`${agentLabel(ctx)} exported ${format === 'pdf' ? 'a PDF' : 'a PowerPoint file'} of the deck (${outcome.slides.length} slides) to the export folder.`, 'agent');
      const png = outcome.preview ?? outcome.file?.preview;
      return {
        content: [{ type: 'text', text: JSON.stringify(resultJson(outcome, notes), null, 2) }, ...(png ? [{ type: 'image' as const, data: png, mimeType: 'image/png' }] : [])],
      };
    },
  },
];
