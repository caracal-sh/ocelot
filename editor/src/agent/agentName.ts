// What the sidebar's agent is called on the canvas: the chosen model's family ("Claude is editing Hero"), not the runner.

/** Brand casing for families whose lower-cased id would read wrong. */
const BRAND_CASE: Record<string, string> = { gpt: 'GPT', deepseek: 'DeepSeek', glm: 'GLM', minimax: 'MiniMax', openai: 'OpenAI' };

/**
 * Short name of a model from its display name ("Claude Haiku 4.5") or id ("claude-haiku-4-5", "anthropic/claude-haiku-4-5"):
 * its first word, with a version suffix ("GPT-5") dropped. '' when there is nothing to name.
 */
export function modelShortName(nameOrId: string): string {
  const base = nameOrId.split('/').pop() ?? '';
  const word = (base.split(/[\s_:]+/)[0] ?? '').split(/-(?=\d)/)[0]!.split('-')[0]!;
  if (!word) return '';
  const brand = BRAND_CASE[word.toLowerCase()];
  if (brand) return brand;
  return /^[a-z]+$/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}
