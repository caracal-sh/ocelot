import { desktop, mobile } from './helpers';
import type { Pattern } from './types';

export const PRICING: Pattern = {
  id: 'pricing',
  title: 'Pricing',
  kind: 'screen',
  category: 'commerce',
  platform: 'web',
  summary: 'Plans a visitor can compare in seconds, with one clear recommendation and honest limits.',
  purpose:
    'Help a visitor choose a plan and start. The test is speed: a reader should be able to name the right plan for their situation in a few seconds, and trust that the price they see is the price they pay.',
  useWhen: [
    'A product sells tiers or seats and the page needs to turn comparison into a choice.',
    'A pricing section on a marketing page, or the standalone pricing page.',
    'An in-app plan picker (the same structure, inside the product chrome).',
  ],
  avoidWhen: [
    'A single price with no choice: a short price block in the page is enough.',
    'Flows that happen at the moment of a limit: see upgrade-paywall.',
  ],
  keywords: [
    'pricing', 'pricing plans', 'plan tiers', 'tiers', 'price', 'prices', 'enterprise', 'compare plans', 'plan comparison', 'per seat', 'subscription plans',
    'monthly annual', 'billing period', 'saas pricing',
  ],
  anatomy: [
    { region: 'Heading', job: 'States what the visitor is choosing.', notes: 'A plain headline and one line of support, not a slogan. It may carry the billing toggle beneath it.' },
    { region: 'Billing period switch', job: 'Switches monthly and yearly prices.', notes: 'Optional. A two-option segmented control. Show a saving only when it is true and computed from the two prices on screen.' },
    { region: 'Plan cards', job: 'One column per plan, in ascending order.', notes: 'Two to four plans. Each has a name, one line saying who it is for, the price with its period, one action, and the features that differ.' },
    { region: 'Recommended plan', job: 'Gives the hesitant visitor a default.', notes: 'One plan only, marked with a short label that says why ("Best for teams") and a stronger border or fill. Not scaled up.' },
    { region: 'Feature lists', job: 'Say what changes between plans.', notes: 'Four to seven lines, led by the limit that matters (seats, projects, history). "Everything in Free, plus" rather than repeating.' },
    { region: 'Comparison table', job: 'Optional detail for careful buyers.', notes: 'Below the cards, grouped by theme, the plan header sticky. Skip it when the cards already tell the story.' },
    { region: 'Questions', job: 'Answers the billing doubts: cancel, refund, taxes, seats.', notes: 'Four to six items in an accordion, one open.' },
    { region: 'Contact route', job: 'For custom needs.', notes: 'A quiet row: "Need something else? Talk to us." One action.' },
  ],
  states: [
    { name: 'Default', required: true, shows: 'Monthly prices, recommended plan marked, every plan with one action.', copy: 'Actions name the result: "Start free", "Start 14-day trial", "Contact sales". Not "Get started" on every card.' },
    { name: 'Yearly selected', required: true, shows: 'Prices show the per-month amount and say it is billed yearly; the saving appears next to the switch.', copy: '"$10 per month, billed yearly ($120)". The saving is a number or nothing.' },
    { name: 'Current plan', required: false, shows: 'For a signed-in visitor: their plan shows a disabled "Current plan" label, others offer "Switch to this plan".', copy: 'Downgrades say what will be lost and when it takes effect.' },
    { name: 'Long content', required: true, shows: 'The same cards with a long plan name, a six-digit price and the longest feature text: nothing wraps badly or overlaps.', copy: 'Design for it: let names wrap to two lines, keep the price on one line, and align the feature rows across cards.' },
    { name: 'Mobile', required: true, shows: 'Plans stacked, the recommended plan first; the comparison table becomes per-plan lists.', copy: 'Same words as desktop.' },
  ],
  copy: [
    'Price, currency and period sit together on one line: "$12 / user / month".',
    'If billing is yearly, say it next to the price, not in a footnote.',
    'Never invent a price, a discount or a "most popular" claim; use the numbers the brief gives, or plausible round numbers and say they are placeholders.',
    'Describe a plan by who it is for ("For small teams"), then by what it includes.',
    'The same capability has the same words in every plan row and in the table.',
  ],
  layout: [
    { platform: 'web', rule: 'Container 1040 to 1200px; three cards 320 to 360px wide with 24px gaps; two cards 400 to 440px.' },
    { platform: 'web', rule: 'Card padding 28 to 32px; plan name 18 to 20px; price 36 to 48px weight 600; feature lines 14 to 15px with 12px between; action 40 to 44px high, full width, at the bottom of every card so the actions align.' },
    { rule: 'Feature rows should line up horizontally across cards where the same capability appears.' },
    { platform: 'mobile', rule: 'One column, 20px side padding, recommended plan first, price 32 to 36px, actions 48px high.' },
    { rule: 'Distinguish the recommended plan by border weight or fill, not by making it larger: scaling breaks the grid.' },
  ],
  mistakes: [
    'Three identical cards, twelve check marks each, no hierarchy.',
    '"Most popular" on more than one plan, or on a plan no one chooses.',
    'The price hidden behind "Contact us" on every plan.',
    'Features phrased differently per plan for the same capability, so a reader cannot compare.',
    'A recommended card scaled 110% so the row edges no longer align.',
    'No sign of billing period, taxes or what happens at renewal.',
    'Gradient headline and glow on the recommended card standing in for a reason to choose it.',
  ],
  review: [
    { check: 'Five-second choice', how: 'Show the screenshot to yourself for five seconds: you can say which plan fits a team of five, and why.' },
    { check: 'One recommendation with a reason', how: 'Exactly one card is marked, and its label says who it is for.' },
    { check: 'Price, period and billing together', how: 'Each card shows price, period and (yearly) the billed amount on the same block as the action.' },
    { check: 'Aligned rows', how: 'get_tree_summary: the cards share one top, one height and the actions share a y position.' },
    { check: 'Long content survives', how: 'The Long content artboard has no clipped text and no overlap.' },
    { check: 'No invented numbers', how: 'Every saving, discount or count on the page can be computed from the prices shown.' },
  ],
  build: {
    artboards: [
      desktop('Pricing / Monthly', true, 1100),
      desktop('Pricing / Yearly', true, 1100),
      desktop('Pricing / Long content', true, 1100),
      mobile('Pricing / Monthly', true, 1500),
      desktop('Pricing / Current plan', false, 1100),
    ],
    blocks: [],
    components: ['card', 'badge', 'button', 'toggle-group', 'separator', 'accordion', 'table'],
    designSystem: [
      'No block exists for pricing: build it from components. create_artboard "Pricing / Monthly — Desktop" 1440 wide with height "fit-content" at the end.',
      'Write the header group first (headline, support line, <ds-toggle-group> with Monthly and Yearly, the active item pressed), then one <ds-card> per plan in a flex row with 24px gap.',
      'Each card: card-header with card-title (plan name) and card-description (who it is for), card-content with the price block (plain text layer) and the feature list, card-footer with one <ds-button>. The recommended card gets a <ds-badge> in its header and a border color of var(--primary); the other cards use the default button variant outline.',
      'Questions: <ds-accordion> with one open item. Table is optional (<ds-table>).',
      'For Yearly: duplicate_nodes the artboard, set_text on prices, and set the toggle item. For Long content: set_text with the longest plan name and price, then check wrapping with get_screenshot.',
      'Mobile: a new artboard, cards stacked in one column, recommended first.',
    ],
    plain: [
      'create_artboard "Pricing / Monthly — Desktop"; write the header, then a flex row of cards (align-items: stretch, gap 24px) with write_html; make each card a column with the action at the bottom (margin-top: auto).',
      'Use one border and one radius for all cards; the recommended card gets a 2px accent border and a small label above its name. Do not scale it.',
      'Duplicate for Yearly and Long content, change text only. Mobile gets its own artboard.',
      'get_screenshot, then inspect_design; verify the card tops, heights and button y positions are equal.',
    ],
    snippet:
      '<ds-card style="width:340px"><ds-card-header><ds-badge variant="secondary">Best for teams</ds-badge><ds-card-title>Team</ds-card-title><ds-card-description>For groups that plan together.</ds-card-description></ds-card-header>' +
      '<ds-card-content><p style="margin:0;font-size:40px;font-weight:600;line-height:1.1">$12 <span style="font-size:14px;font-weight:400">/ user / month</span></p>' +
      '<p style="margin:12px 0 0;font-size:14px">Everything in Free, plus unlimited projects and a year of history.</p></ds-card-content>' +
      '<ds-card-footer><ds-button style="width:100%">Start 14-day trial</ds-button></ds-card-footer></ds-card>',
  },
  related: ['checkout', 'upgrade-paywall'],
  sketch: [
    ['ink', 30, 5, 40, 4],
    ['line', 36, 12, 28, 2],
    ['box', 6, 20, 26, 34],
    ['line', 10, 25, 12, 2],
    ['ink', 10, 30, 14, 4],
    ['line', 10, 38, 18, 2],
    ['line', 10, 42, 16, 2],
    ['box', 37, 18, 26, 38],
    ['accent', 40, 49, 20, 4],
    ['ink', 41, 26, 14, 4],
    ['line', 41, 38, 18, 2],
    ['box', 68, 20, 26, 34],
    ['line', 72, 25, 12, 2],
    ['ink', 72, 30, 14, 4],
  ],
};

export const CHECKOUT: Pattern = {
  id: 'checkout',
  title: 'Checkout',
  kind: 'flow',
  category: 'commerce',
  platform: 'both',
  summary: 'Pay without surprises: the total always visible, errors that keep your input, no forced account.',
  purpose:
    'Turn an intention to buy into a completed payment. Everything that could make the person stop (a surprise cost, a lost form, a forced account, an unclear failure) is handled on purpose.',
  useWhen: [
    'Buying goods, a plan or a one-off service with a card or wallet.',
    'A seat purchase or plan change that ends in a payment.',
  ],
  avoidWhen: [
    'The moment of choosing a plan: see pricing.',
    'Donations or tips with one amount: a short form is enough.',
  ],
  keywords: [
    'checkout', 'payment', 'pay', 'cart', 'order', 'purchase', 'buy', 'credit card', 'shipping address', 'billing address', 'order summary',
    'place order', 'ecommerce', 'e-commerce', 'shop',
  ],
  anatomy: [
    { region: 'Order summary', job: 'Shows what is being bought and what it costs, at every step.', notes: 'Line items with a quantity, price and remove or change link; then subtotal, shipping, tax and the total, which is the largest number. Shipping and tax appear before the last step.' },
    { region: 'Contact', job: 'Collects the email (and guest or sign-in choice).', notes: 'Guest checkout is the default. Offer sign-in as a link, never as a gate.' },
    { region: 'Delivery', job: 'Address and delivery method, if anything ships.', notes: 'Address lookup helps; method choices show the price and arrival date.' },
    { region: 'Payment', job: 'Card fields and wallet buttons.', notes: 'Wallets first when available, then a card group (number, expiry, code) with the field format hinted. The billing address defaults to the delivery address.' },
    { region: 'Promo code', job: 'Applies a code.', notes: 'Collapsed behind a text link so it does not pull people away to search for one.' },
    { region: 'Place order', job: 'Completes the purchase.', notes: 'One primary button that includes the amount: "Pay $48.00". Beside it, one line about refunds or security that is true.' },
  ],
  states: [
    { name: 'Default', required: true, shows: 'Summary visible, form sections in order, the primary button enabled.', copy: 'Section headings are short nouns: Contact, Delivery, Payment.' },
    { name: 'Field error', required: true, shows: 'Inline errors under the fields, entered values kept, focus on the first error, a short summary above the button on long forms.', copy: '"Card number should be 16 digits", "Enter a postcode like 94107".' },
    { name: 'Payment declined', required: true, shows: 'The payment section marked, a message that says the bank declined and what to try; the form and cart stay as they were.', copy: '"Your bank declined this payment. Try another card or contact your bank." Do not clear card details the person may fix.' },
    { name: 'Processing', required: true, shows: 'The button shows a spinner and "Processing…", everything else read-only, a line telling the person not to leave.', copy: '"Processing your payment. Please stay on this page."' },
    { name: 'Confirmation', required: true, shows: 'Order number, what was bought, where it goes, when it arrives, a receipt route and the next action.', copy: 'Start with the fact: "Order 4821 is confirmed". Say which email got the receipt.' },
    { name: 'Promo code', required: false, shows: 'Applied: the discount as its own line in the summary and a way to remove it. Invalid: one line under the field.', copy: '"Code SPRING10 took $4.80 off." / "That code is not valid or has expired."' },
    { name: 'Price or stock changed', required: false, shows: 'A message above the summary describing what changed, with the new total.', copy: '"The price of Linen shirt changed to $52.00. Your total is updated."' },
  ],
  copy: [
    'The primary button includes the amount. The total is repeated near it.',
    'Label every field with its name; never use a placeholder in its place.',
    'Reassurance lines state a fact ("Free returns within 30 days"), not a feeling ("100% safe!").',
    'Errors keep what the person typed and say how to fix it.',
    'Name the action the same way through the flow: "Place order" is never "Complete purchase" on the next screen.',
  ],
  layout: [
    { platform: 'web', rule: 'Two columns: form 560 to 640px on the left, summary 360 to 420px on the right and sticky; 48 to 64px between them; the whole thing centered in a 1040 to 1200px container.' },
    { platform: 'mobile', rule: 'One column. The summary collapses into a row at the top that shows the item count and the total and expands on tap; the primary button is pinned to the bottom with the total beside it.' },
    { rule: 'Fields 44px high on web, 48px on mobile; 16px between fields; two short fields (expiry, code) share a row.' },
    { rule: 'Section headings 18px weight 600; labels 14px; the total 20 to 24px weight 600.' },
    { rule: 'Progress, when the flow has steps, is a quiet "Step 2 of 3" line, not a decorative stepper.' },
  ],
  mistakes: [
    'Account creation required before paying.',
    'Shipping or tax shown only on the final step.',
    'A loud promo field that sends people to search for codes.',
    'Clearing the form after an error, or after a declined card.',
    'Several primary buttons on one screen (wallet, card, save for later).',
    'A confirmation page that is only "Thank you!" with no order details.',
    'Reassurance badges in every corner with no content behind them.',
  ],
  review: [
    { check: 'Total always visible', how: 'The total appears in the summary on every artboard, and on mobile in the pinned bar.' },
    { check: 'One primary action', how: 'One filled button per screen, labelled with the amount.' },
    { check: 'No surprise costs', how: 'Shipping and tax are visible before the Payment section.' },
    { check: 'Failure keeps input', how: 'The Payment declined artboard shows the entered values still in place.' },
    { check: 'Every field labelled', how: 'get_tree_summary: each input has a label; placeholders only show format examples.' },
    { check: 'Confirmation carries facts', how: 'Order number, items, delivery and receipt email are all present.' },
  ],
  build: {
    artboards: [
      desktop('Checkout / Details'),
      desktop('Checkout / Field error'),
      desktop('Checkout / Payment declined'),
      desktop('Checkout / Processing'),
      desktop('Checkout / Confirmation'),
      mobile('Checkout / Details', true, 1400),
      mobile('Checkout / Confirmation'),
      desktop('Checkout / Promo applied', false),
    ],
    blocks: [],
    components: ['card', 'field', 'input', 'button', 'separator', 'alert', 'accordion', 'table', 'spinner'],
    designSystem: [
      'No block exists for checkout: compose it. create_artboard "Checkout / Details — Desktop"; write the two columns as two frames (form, summary), the summary sticky-styled with a card.',
      'Form column: one <ds-field-set> per section (Contact, Delivery, Payment) with <ds-field> rows; short fields share a flex row. Place wallet buttons first as outline <ds-button>s, then the card fields.',
      'Summary: a <ds-card> with an item list (flex rows, price right-aligned in a fixed slot), a <ds-separator>, then subtotal, shipping, tax and a total row at 20px weight 600. Promo code is a text link that opens a field in another artboard state.',
      'The primary <ds-button> reads "Pay $48.00" and is the only filled button.',
      'States: duplicate the Details artboard, then apply invalid and field-error to inputs; add an <ds-alert variant="destructive"> in the payment section for a declined card; swap the button for a spinner and "Processing…"; build Confirmation as its own artboard with the order facts.',
      'Mobile: a single column with the summary collapsed to a row at the top; pin the pay button to the bottom of the artboard.',
    ],
    plain: [
      'create_artboard "Checkout / Details — Desktop"; write the form column then the summary column in one flex row; then add states by duplicate_nodes and targeted set_text and update_styles.',
      'Use one input style (44px, 1px border at 3:1 contrast, 8px radius) for every field; the pay button is the single filled element.',
      'The summary total is the largest number on the screen; line items right-align prices in a fixed-width slot so decimals line up.',
      'Mobile on its own artboard (375 x 812 preset, height fit-content); screenshot all states and link the steps with set_link.',
    ],
    snippet:
      '<ds-card style="width:400px"><ds-card-header><ds-card-title>Order summary</ds-card-title></ds-card-header>' +
      '<ds-card-content><div style="display:flex;justify-content:space-between;font-size:14px"><span>Linen shirt × 1</span><span>$52.00</span></div>' +
      '<div style="display:flex;justify-content:space-between;font-size:14px;margin-top:8px"><span>Shipping</span><span>$0.00</span></div>' +
      '<ds-separator style="margin:16px 0"></ds-separator>' +
      '<div style="display:flex;justify-content:space-between;font-size:20px;font-weight:600"><span>Total</span><span>$52.00</span></div></ds-card-content>' +
      '<ds-card-footer><ds-button style="width:100%">Pay $52.00</ds-button></ds-card-footer></ds-card>',
  },
  related: ['pricing', 'notifications'],
  sketch: [
    ['ink', 6, 6, 20, 3],
    ['line', 6, 14, 12, 2],
    ['box', 6, 18, 52, 6],
    ['box', 6, 27, 52, 6],
    ['line', 6, 38, 14, 2],
    ['box', 6, 42, 52, 6],
    ['accent', 6, 52, 52, 6],
    ['fill', 66, 6, 28, 52],
    ['line', 70, 12, 16, 2],
    ['line', 70, 18, 20, 2],
    ['ink', 70, 46, 14, 4],
  ],
};

export const UPGRADE_PAYWALL: Pattern = {
  id: 'upgrade-paywall',
  title: 'Upgrade and paywall',
  kind: 'flow',
  category: 'commerce',
  platform: 'both',
  summary: 'Ask for money at the moment of need: say what unlocks, show the full price, keep No readable.',
  purpose:
    'Offer a paid plan to someone who just ran into a limit or reached for a paid feature. The person should understand what they get, what it costs and when, and be able to say no without a hunt for the exit.',
  useWhen: [
    'A person hits a plan limit (seats, storage, projects) or taps a locked feature.',
    'A trial is ending or has ended.',
    'A mobile subscription screen shown after value was delivered.',
  ],
  avoidWhen: [
    'Browsing prices before a decision: that is the pricing screen.',
    'As the first screen of a product: show value first, ask for money after.',
  ],
  keywords: [
    'upgrade', 'paywall', 'subscribe', 'subscription', 'premium', 'pro', 'trial', 'free trial', 'unlock', 'limit reached', 'plan limit',
    'in-app purchase', 'restore purchases', 'go pro', 'upsell', 'limit is reached',
  ],
  anatomy: [
    { region: 'Close', job: 'Lets the person leave.', notes: 'A real 44px target in the top corner, or a "Not now" text action. Never a faint 12px cross.' },
    { region: 'Context', job: 'Says what the person was trying to do.', notes: '"You have used all 3 projects on Free." Ties the offer to their action.' },
    { region: 'Benefit list', job: 'Names what the paid plan changes for this person.', notes: 'Three or four lines, led by what they were blocked on. Outcomes, not feature names.' },
    { region: 'Plan choice', job: 'Optional: period or tier.', notes: 'At most two options, each with the full price and period. The default is the one the brief recommends, and the reason is on screen.' },
    { region: 'Price and terms', job: 'States what will be charged and when.', notes: 'Price, period, renewal and trial length sit directly above or beside the action: "$12/month after a 7-day trial. Renews monthly. Cancel anytime in Settings."' },
    { region: 'Primary action', job: 'Starts the purchase.', notes: 'One filled button: "Start free trial" or "Upgrade to Pro". Secondary: "Not now".' },
    { region: 'Footer links', job: 'Restore and legal.', notes: 'Mobile: "Restore purchases", terms and privacy as quiet text links.' },
  ],
  states: [
    { name: 'Default', required: true, shows: 'Context, benefits, price and terms, primary and secondary actions.', copy: 'The headline names the unlock: "Keep creating projects", not "Go Premium!".' },
    { name: 'Trial available', required: false, shows: 'Trial length, the date billing starts, the price afterwards.', copy: '"Free for 7 days, then $12/month. Billing starts on 18 Nov."' },
    { name: 'Processing', required: true, shows: 'Primary button with a spinner, controls read-only; close stays available until the platform sheet takes over.', copy: '"Starting your trial…".' },
    { name: 'Purchase failed', required: true, shows: 'The paywall stays, a message above the action says what happened; nothing the person built is lost.', copy: '"The payment did not go through. You have not been charged. Try again or use another method."' },
    { name: 'Success', required: true, shows: 'A short confirmation, then back to where the person was, the feature now usable.', copy: '"You are on Pro. Your project is ready." Then the action they were doing.' },
    { name: 'Restore', required: false, shows: 'Mobile: a result for restore: found (back to success) or nothing found (what to try).', copy: '"We could not find an earlier purchase on this account. Sign in with the account you bought with."' },
  ],
  copy: [
    'Never invent a price, a saving, a user count or a countdown; show only values from the brief.',
    'Price, period and renewal sit next to the action, in the same text size as the benefit list.',
    '"Not now" is real text with a normal contrast; it returns the person to what they were doing.',
    'Describe the outcome ("Unlimited projects"), not the tier internals ("Tier 2 entitlement").',
    'Failure copy says nothing was charged, if that is true.',
  ],
  layout: [
    { platform: 'web', rule: 'A dialog 480 to 560px wide, 32px padding, centered over a dimmed screen; actions at the bottom, primary on the right or full width.' },
    { platform: 'mobile', rule: 'A full-height sheet: close target 44px at the top, content scrolls, the primary button 52px high pinned at the bottom with 34px of safe area below it.' },
    { rule: 'Headline 24 to 28px; benefit lines 15 to 16px with 12px between; price and terms 13 to 14px, never smaller than the benefits above them.' },
    { rule: 'Two plan options sit side by side on web and stacked on mobile; the selected one uses a 2px border and a filled radio.' },
  ],
  mistakes: [
    'A countdown or "only 3 left" that is not real.',
    'The No option as a tiny grey cross, or hidden until a delay.',
    'The price only in the platform sheet after the tap.',
    'A bundle of ten benefits that all say "unlimited".',
    'A paywall as the first screen, before any value.',
    'Blocking with a modal that loses the person\'s unsaved work.',
    'Fake testimonials or star ratings.',
  ],
  review: [
    { check: 'Price beside action', how: 'Price, period and renewal appear within one line of the primary button.' },
    { check: 'Readable way out', how: 'The close or "Not now" control is at least 44px tall on mobile and at least 4.5:1 contrast.' },
    { check: 'Tied to the action', how: 'The headline or context line names what the person was trying to do.' },
    { check: 'Failure is its own artboard', how: 'A Purchase failed artboard exists and says nothing was lost.' },
    { check: 'No invented claims', how: 'Every number on screen comes from the brief.' },
  ],
  build: {
    artboards: [
      desktop('Upgrade / Default'),
      desktop('Upgrade / Purchase failed'),
      desktop('Upgrade / Success', false),
      mobile('Upgrade / Default'),
      mobile('Upgrade / Purchase failed'),
      mobile('Upgrade / Restore', false),
    ],
    blocks: [],
    components: ['card', 'button', 'badge', 'radio-group', 'alert', 'separator', 'spinner'],
    designSystem: [
      'On web, draw the paywall as an open dialog over the screen it interrupts: get_component dialog gives the overlay recipe. On mobile, a sheet: a full-height frame on the Mobile artboard with a pinned footer.',
      'Content: title and context in the header, benefits as flex rows with a check icon ({ "icon": "check" } in <ds-icon name="check">), plan choice as two <ds-card> options with a <ds-radio-group-item> each, terms as a 13px muted paragraph directly above the filled <ds-button>.',
      'Secondary action: <ds-button variant="ghost">Not now</ds-button>; restore and legal links as text at the foot of the sheet.',
      'Purchase failed: duplicate the artboard and add <ds-alert variant="destructive"> above the action; keep the button label.',
      'Success: a separate short artboard that returns to the unlocked screen.',
    ],
    plain: [
      'create_artboard for the host screen first (a dimmed, simplified version of the screen being interrupted), then write the dialog frame at 520px centered; the sheet on mobile is a frame with border-radius at the top and a pinned bottom bar.',
      'One filled button; "Not now" is a text button with at least 4.5:1 contrast and a 44px tall hit area.',
      'Duplicate for Purchase failed and Success; change only the message layers.',
      'Screenshot web and mobile; verify price and renewal sit within one line of the button.',
    ],
    snippet:
      '<ds-card style="width:520px"><ds-card-header><ds-card-title>Keep creating projects</ds-card-title><ds-card-description>You have used all 3 projects on Free.</ds-card-description></ds-card-header>' +
      '<ds-card-content><p style="margin:0;font-size:15px">Unlimited projects, a year of version history and priority exports.</p>' +
      '<p style="margin:16px 0 0;font-size:14px">$12/month after a 7-day trial. Renews monthly. Cancel anytime in Settings.</p></ds-card-content>' +
      '<ds-card-footer><ds-button variant="ghost">Not now</ds-button><ds-button>Start free trial</ds-button></ds-card-footer></ds-card>',
  },
  related: ['pricing', 'checkout', 'settings'],
  sketch: [
    ['fill', 0, 0, 100, 62],
    ['box', 26, 6, 48, 50],
    ['ink', 31, 12, 26, 4],
    ['line', 31, 20, 36, 2],
    ['line', 31, 25, 30, 2],
    ['line', 31, 30, 33, 2],
    ['line', 31, 38, 34, 2],
    ['accent', 52, 46, 17, 5],
    ['line', 31, 48, 10, 2],
  ],
};
