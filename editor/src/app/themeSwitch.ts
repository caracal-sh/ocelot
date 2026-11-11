/**
 * When the system appearance flips (light ↔ dark), every colour transition in the chrome would start at once and the
 * switch would smear. This turns all transitions off for the flip: the override goes in, a style flush commits the new
 * colours while it applies, and it comes out after the next paint (better-ui "Suppress transitions on theme switch").
 * Returns the cleanup.
 */
export function installThemeSwitchGuard(doc: Document = document): () => void {
  const view = doc.defaultView;
  const query = view?.matchMedia?.('(prefers-color-scheme: dark)');
  if (!view || !query) return () => {};
  const onChange = () => {
    const style = doc.createElement('style');
    style.textContent = '*,*::before,*::after{transition:none !important}';
    doc.head.append(style);
    void doc.body.offsetHeight; // forces a synchronous style flush while the override applies
    view.requestAnimationFrame(() => view.requestAnimationFrame(() => style.remove()));
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
