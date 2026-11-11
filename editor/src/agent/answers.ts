// How an answered question reads in the transcript ("You chose: Dark").

import type { AnswerEntry } from './transcript';

/** One question's answer: "You chose: A, B", "You wrote: “…”" or both ("You chose: A and wrote “…”"). */
export function answerText(entry: AnswerEntry): string {
  const chose = entry.chosen.length ? `You chose: ${entry.chosen.join(', ')}` : '';
  if (!entry.custom) return chose || 'You gave no answer';
  return chose ? `${chose}, and wrote “${entry.custom}”` : `You wrote: “${entry.custom}”`;
}
