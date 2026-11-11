// One realistic landing page written only with var(--theme-*) tokens: the same markup renders in every catalog theme.
// Used by the themed export pixel diff (export-diff.mjs) and the theme contact sheet (themes-contact-sheet.mjs).

const icon = (d) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = [
  icon('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  icon('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12l3 3 5-6"/>'),
  icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
];

const CARDS = [
  { title: 'Instant sync', body: 'Every edit reaches your whole team in under a second, on any device, even offline.' },
  { title: 'Reviewed by default', body: 'Changes wait for a teammate’s approval, so nothing ships without a second pair of eyes.' },
  { title: 'Built-in history', body: 'Rewind any project to any moment. Restore a file, a page or the whole workspace.' },
];

const card = (c, i) => `
    <article data-name="Card ${i + 1}" style="display:flex;flex-direction:column;gap:12px;padding:28px;background:var(--theme-color-surface);color:var(--theme-color-ink);border:var(--theme-border-width) solid var(--theme-border-color);border-radius:var(--theme-radius-lg);box-shadow:var(--theme-shadow-2)">
      <div style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin-bottom:4px;border-radius:var(--theme-control-radius);background:var(--theme-color-accent-soft);color:var(--theme-color-accent-text)">${ICONS[i]}</div>
      <h3 style="font-family:var(--theme-font-display);font-size:var(--theme-text-xl);line-height:var(--theme-text-xl--line-height);font-weight:var(--theme-text-xl--weight);letter-spacing:var(--theme-text-xl--tracking)">${c.title}</h3>
      <p style="font-size:var(--theme-text-base);line-height:var(--theme-text-base--line-height);color:var(--theme-color-ink-2)">${c.body}</p>
    </article>`;

export const LANDING_HTML = `
<div data-name="Page" style="display:flex;flex-direction:column;gap:44px;height:100%;padding:36px 72px 32px;box-sizing:border-box">
  <header data-name="Nav" style="display:flex;align-items:center;justify-content:space-between">
    <span style="font-family:var(--theme-font-display);font-size:var(--theme-text-xl);line-height:var(--theme-text-xl--line-height);font-weight:var(--theme-text-xl--weight);letter-spacing:var(--theme-text-xl--tracking)">Meridian</span>
    <nav style="display:flex;gap:32px;font-size:var(--theme-text-sm);line-height:var(--theme-text-sm--line-height);color:var(--theme-color-ink-2)"><span>Product</span><span>Pricing</span><span>Customers</span><span>Docs</span></nav>
    <button style="height:40px;padding:0 20px;background:var(--theme-color-surface);color:var(--theme-color-ink);border:var(--theme-control-border);border-radius:var(--theme-control-radius);box-shadow:var(--theme-control-shadow);font-family:var(--theme-font-sans);font-size:var(--theme-text-sm);font-weight:700">Sign in</button>
  </header>
  <section data-name="Hero" style="display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center">
    <span style="padding:5px 14px;border-radius:var(--theme-radius-full);background:var(--theme-color-accent-soft);color:var(--theme-color-accent-text);font-size:var(--theme-text-xs);line-height:var(--theme-text-xs--line-height);font-weight:700;letter-spacing:0.04em">NEW · TEAM WORKSPACES</span>
    <h1 style="max-width:1000px;font-family:var(--theme-font-display);font-size:var(--theme-text-4xl);line-height:var(--theme-text-4xl--line-height);font-weight:var(--theme-text-4xl--weight);letter-spacing:var(--theme-text-4xl--tracking)">Ship together, without the meetings</h1>
    <p style="max-width:600px;font-size:var(--theme-text-lg);line-height:var(--theme-text-lg--line-height);color:var(--theme-color-ink-2)">Meridian keeps your plans, files and decisions in one calm place, so a team of five moves like a team of fifty.</p>
    <div style="display:flex;gap:16px;margin-top:8px">
      <button style="height:52px;padding:0 30px;background:var(--theme-color-accent);color:var(--theme-color-accent-ink);border:var(--theme-control-border);border-radius:var(--theme-control-radius);box-shadow:var(--theme-control-shadow);font-family:var(--theme-font-sans);font-size:var(--theme-text-base);font-weight:700">Start for free</button>
      <button style="height:52px;padding:0 30px;background:var(--theme-color-surface);color:var(--theme-color-ink);border:var(--theme-control-border);border-radius:var(--theme-control-radius);box-shadow:var(--theme-control-shadow);font-family:var(--theme-font-sans);font-size:var(--theme-text-base);font-weight:700">Book a demo</button>
    </div>
  </section>
  <section data-name="Cards" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px">${CARDS.map(card).join('')}
  </section>
  <footer data-name="Footer" style="display:flex;align-items:center;justify-content:space-between;margin-top:auto;padding-top:20px;border-top:1px solid var(--theme-color-line-subtle);font-size:var(--theme-text-sm);line-height:var(--theme-text-sm--line-height);color:var(--theme-color-ink-3)">
    <span>© 2026 Meridian Labs</span>
    <span style="display:flex;gap:24px"><span>Privacy</span><span>Terms</span><span>Status</span></span>
  </footer>
</div>`;
