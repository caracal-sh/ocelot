// NOTICE.md of an exported registry: the licences the MIT and ISC texts require to travel with copies of shadcn/ui sources and with
// the lucide icon paths the canvas draws (plan §1.2 "Licence"), the font lines, and how to install.

import { presetCodeOf } from '../knobs';
import type { DesignSystemRecord } from '../model';
import type { BundledFont } from '../../themes/fonts';
import SHADCN_MIT from '../snapshot/LICENSE-shadcn-ui.txt?raw';
import LUCIDE_LICENSE from '../snapshot/LICENSE-lucide.txt?raw';

export function noticeMarkdown(record: DesignSystemRecord, bundledFonts: readonly BundledFont[]): string {
  const fontLines = bundledFonts.map((f) => `- ${f.family}: ${f.copyright}. SIL Open Font License 1.1, text in \`fonts/${f.license}\`.`);
  const preset = presetCodeOf(record);
  const code = preset.code;
  const presetSection = code
    ? `\n## Preset code\n\nThe knobs of this design system (style, colours, radius, fonts, icons, menus) as a shadcn preset code: \`${code}\` (https://ui.shadcn.com/create?preset=${code}).\n` +
      `\`<runner> shadcn@${record.snapshot.shadcn} preset decode ${code}\` prints them; \`<runner> shadcn@${record.snapshot.shadcn} init --preset ${code}\` starts a plain shadcn project with the same knobs, without the tokens and component overrides edited in Ocelot.\n` +
      `${preset.notes.length ? `\nA preset code does not carry everything:\n\n${preset.notes.map((n) => `- ${n}`).join('\n')}\n` : ''}`
    : '';
  return `# Notice

${record.name} is a design system made in Ocelot. It is built on the shadcn/ui component sources (style \`${record.style}\`, Base UI) and the shadcn preset
code format, which are MIT licensed, and the lucide icon paths, which are ISC licensed. Both licences require their notice to stay with copies, so it is reproduced here.
The sources use \`@base-ui/react\` (MIT), \`class-variance-authority\` (Apache-2.0) and \`tw-animate-css\` (MIT) as dependencies; they are installed from
npm, not copied.

## Install

Pick your package runner (\`bunx --bun\`, \`npx\` or \`pnpm dlx\`) and run, in a new project:

    <runner> shadcn@${record.snapshot.shadcn} init ./r/<name>.json --base base --template vite

or in an existing shadcn project:

    <runner> shadcn@${record.snapshot.shadcn} add ./r/<name>.json
${presetSection}${fontLines.length ? `\n## Fonts\n\nCopy \`fonts/\` to \`public/fonts/\`; the \`@font-face\` rules load \`/fonts/<file>\`.\n\n${fontLines.join('\n')}\n` : ''}
## shadcn/ui

${SHADCN_MIT.trim()}

## lucide

${LUCIDE_LICENSE.trim()}
`;
}
