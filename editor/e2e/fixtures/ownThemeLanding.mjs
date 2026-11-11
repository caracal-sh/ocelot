// A bakery landing page written with tokens only: every colour, font, radius and shadow is a var(--theme-…) of the document's own theme.
export const OWN_THEME = {
  name: 'Ferrule',
  tokens: {
    'color-canvas': '#F6EEDF',
    'color-ink': '#2B1A10',
    'color-accent': '#B4451F',
    'font-display': 'Fraunces',
    'font-sans': 'Geist',
    'radius-md': '4px',
    'radius-lg': '8px',
    'text-5xl': '72px',
    'text-5xl--weight': '400',
  },
};

export const OWN_THEME_LANDING = `<main data-name="Page" style="display:flex;flex-direction:column;gap:56px;padding:48px 96px 64px;height:100%">
  <nav data-name="Nav" style="display:flex;align-items:center;justify-content:space-between">
    <div data-name="Logo" style="font-family:var(--theme-font-display);font-size:var(--theme-text-xl);color:var(--theme-color-ink)">Crust &amp; Pedal</div>
    <div data-name="Nav links" style="display:flex;gap:32px;font-size:var(--theme-text-sm);color:var(--theme-color-ink-2)"><span>Loaves</span><span>Routes</span><span>Order</span></div>
  </nav>
  <section data-name="Hero" style="display:flex;align-items:center;justify-content:space-between;gap:64px">
    <div data-name="Hero copy" style="display:flex;flex-direction:column;gap:24px;max-width:560px">
      <h1 data-name="Headline" style="margin:0;font-family:var(--theme-font-display);font-size:var(--theme-text-5xl);line-height:var(--theme-text-5xl--line-height);font-weight:var(--theme-text-5xl--weight);letter-spacing:var(--theme-text-5xl--tracking);color:var(--theme-color-ink)">Sourdough, still warm, by bike.</h1>
      <p data-name="Lead" style="margin:0;font-size:var(--theme-text-lg);line-height:var(--theme-text-lg--line-height);color:var(--theme-color-ink-2)">Baked before dawn, delivered by 8. One loaf or a week of them.</p>
      <div data-name="Actions" style="display:flex;gap:12px">
        <button data-name="Order button" style="padding:14px 24px;border:var(--theme-control-border);border-radius:var(--theme-control-radius);background:var(--theme-color-accent);color:var(--theme-color-accent-ink);font-family:var(--theme-font-sans);font-size:var(--theme-text-base);font-weight:600">Order this week's loaf</button>
        <button data-name="Routes button" style="padding:14px 24px;border:1px solid var(--theme-color-line);border-radius:var(--theme-control-radius);background:transparent;color:var(--theme-color-ink);font-family:var(--theme-font-sans);font-size:var(--theme-text-base);font-weight:600">See the routes</button>
      </div>
    </div>
    <div data-name="Loaf card" style="width:420px;height:300px;display:flex;flex-direction:column;justify-content:flex-end;padding:28px;border-radius:var(--theme-radius-lg);background:var(--theme-color-accent-soft);box-shadow:var(--theme-shadow-2)">
      <div style="font-family:var(--theme-font-display);font-size:var(--theme-text-2xl);color:var(--theme-color-ink)">Country loaf</div>
      <div style="font-size:var(--theme-text-sm);color:var(--theme-color-ink-2)">72-hour ferment · 800 g · Tuesday to Saturday</div>
    </div>
  </section>
  <section data-name="Routes" style="display:flex;gap:24px">
    <div data-name="Route card" style="flex:1;padding:24px;border-radius:var(--theme-radius-lg);background:var(--theme-color-surface);border:var(--theme-border-width) solid var(--theme-border-color)"><div style="font-family:var(--theme-font-display);font-size:var(--theme-text-xl);color:var(--theme-color-ink)">Harbour loop</div><div style="font-size:var(--theme-text-sm);color:var(--theme-color-ink-2)">Mon, Wed, Fri · 6:30 to 8:00</div></div>
    <div data-name="Route card" style="flex:1;padding:24px;border-radius:var(--theme-radius-lg);background:var(--theme-color-surface);border:var(--theme-border-width) solid var(--theme-border-color)"><div style="font-family:var(--theme-font-display);font-size:var(--theme-text-xl);color:var(--theme-color-ink)">Hill route</div><div style="font-size:var(--theme-text-sm);color:var(--theme-color-ink-2)">Tue, Thu · 6:45 to 8:15</div></div>
    <div data-name="Route card" style="flex:1;padding:24px;border-radius:var(--theme-radius-lg);background:var(--theme-color-surface);border:var(--theme-border-width) solid var(--theme-border-color)"><div style="font-family:var(--theme-font-display);font-size:var(--theme-text-xl);color:var(--theme-color-ink)">Saturday market</div><div style="font-size:var(--theme-text-sm);color:var(--theme-color-ink-2)">Pick up at the stall · 9:00</div></div>
  </section>
</main>`;
