import { desktop, mobile } from './helpers';
import type { Pattern } from './types';

export const SIGN_IN_UP: Pattern = {
  id: 'sign-in-up',
  title: 'Sign in and sign up',
  kind: 'screen',
  category: 'account',
  platform: 'both',
  summary: 'One calm screen for getting in: a short form, honest errors, a way out of every dead end.',
  purpose:
    'Get a person into the product with as little typing as possible. The screen has one job, so everything on it either helps the person finish the form or helps them recover when they cannot.',
  useWhen: [
    'The product has accounts: sign in, sign up, and the "email me a link" variant of both.',
    'A returning person has to prove who they are before a protected page.',
    'You need the first screen of a flow that ends in onboarding.',
  ],
  avoidWhen: [
    'Collecting profile details: that is onboarding, after the account exists.',
    'Anything that is not about identity: a newsletter box is not a sign-up screen.',
  ],
  keywords: [
    'sign in', 'sign-in', 'signin', 'log in', 'login', 'sign up', 'signup', 'register', 'registration', 'create account', 'account creation',
    'authentication', 'auth', 'password', 'magic link', 'forgot password', 'reset password', 'sso', 'welcome back',
  ],
  anatomy: [
    { region: 'Brand mark', job: 'Says whose door this is.', notes: 'Small (24 to 32px), above the heading or top-left. Not a hero, not a tagline.' },
    { region: 'Heading', job: 'States the task in plain words.', notes: '"Sign in to Harborline", "Create your account". One line, no exclamation mark.' },
    { region: 'Provider buttons', job: 'Offer the fastest route for people who use one.', notes: 'Optional. Same width and height as the form controls, outline style so the primary action stays the loudest. Put them first only if most people use them, else after an "or" divider.' },
    { region: 'Form', job: 'Collects the minimum: email, and a password on sign in.', notes: 'Labels above fields, never placeholders alone. Password has a show/hide control. Sign up asks for at most email, password and name.' },
    { region: 'Primary action', job: 'Submits.', notes: 'One full-width button named for the result: "Sign in", "Create account". It is the only filled button on the screen.' },
    { region: 'Recovery links', job: 'Get out of dead ends.', notes: '"Forgot password?" beside the password label, "Create an account" or "Sign in" at the foot. Text links, not buttons.' },
    { region: 'Legal line', job: 'Sign up only: consent in one sentence.', notes: 'Muted 12 to 13px, links to terms and privacy. Not a checkbox unless the law where you operate needs one.' },
    { region: 'Side panel', job: 'Web only, optional: shows what the product does with a real interface fragment.', notes: 'Drop it below 960px. It never carries the form on mobile.' },
  ],
  states: [
    { name: 'Default', required: true, shows: 'Empty form, first field focused, provider buttons if any.', copy: 'Heading names the task; no helper text unless it prevents an error (for example the password length rule, shown before typing).' },
    { name: 'Field error', required: true, shows: 'The failing field gets an error border and one line under it; focus moves to the first failing field; entered values stay.', copy: 'Say what to change: "Enter an email like name@company.com", "Use at least 12 characters". Never "Invalid input".' },
    { name: 'Wrong credentials', required: true, shows: 'A form-level message above the button; the password clears, the email stays.', copy: 'Do not reveal whether the email exists: "That email and password do not match. Try again or reset your password."' },
    { name: 'Submitting', required: true, shows: 'The button keeps its width, shows a spinner and its label changes to the progressive form; fields are read-only.', copy: '"Signing in…", "Creating account…".' },
    { name: 'Check your email', required: false, shows: 'For magic-link or verification: the address, a resend action with a cooldown, a way to change the address.', copy: '"We sent a link to ana@northwind.com. It expires in 15 minutes." Resend says when it will be available.' },
    { name: 'Locked or rate limited', required: false, shows: 'A form-level message with the wait time or the reset route; the form is disabled.', copy: 'Give the time ("Try again in 10 minutes") and the escape ("Reset your password").' },
  ],
  copy: [
    'The heading is the task; the button is the result. They do not repeat the same words.',
    'One name per action across the flow: if the screen says "Sign in", the link elsewhere says "Sign in", never "Log in" in one place and "Sign in" in another.',
    'Errors say what happened and what to do next, in the person\'s terms. No codes, no blame.',
    'Provider buttons read "Continue with <provider>" so they work for both sign in and sign up.',
    'The switch between sign in and sign up is a sentence with a link: "New here? Create an account".',
  ],
  layout: [
    { rule: 'Form column 360 to 400px wide, centered horizontally; optically a little above vertical center (about 45% from the top).' },
    { platform: 'web', rule: 'With a side panel: split the artboard 50/50 or 5/7, form side padded 48 to 80px; the panel holds one real interface fragment, not decoration.' },
    { rule: 'Controls 40 to 44px high on web, 48 to 52px on mobile; 16px between fields, 24 to 32px between the heading and the first field.' },
    { rule: 'Heading 24 to 30px, weight 600, line-height 1.2; labels 14px weight 500; helper and error text 13px.' },
    { platform: 'mobile', rule: 'Inputs use 16px text or larger (smaller text makes mobile browsers zoom); 20 to 24px side padding; primary button reachable above the keyboard (keep the form in the top 60% of the screen).' },
  ],
  mistakes: [
    'Placeholder text as the only label: it vanishes when typing and fails contrast.',
    'A disabled submit button with no explanation of what is missing.',
    'Provider buttons filled brighter than the primary action, or each in its own brand color.',
    'A marketing wall beside the form: three feature bullets and a gradient. If the panel does not show the product, remove it.',
    'Sign up asks for company size, role and phone before the person has seen anything.',
    '"Invalid credentials" that tells an attacker which half was wrong, or "No account with that email".',
    'Password rules revealed only after a failed attempt.',
  ],
  review: [
    { check: 'One filled button', how: 'Count filled buttons in the screenshot: exactly one (the submit). Provider and secondary actions are outline or text.' },
    { check: 'Every input has a visible label', how: 'get_tree_summary: each input has a label layer above it; no field relies on placeholder text alone.' },
    { check: 'Error state is a separate artboard', how: 'The Field error and Wrong credentials states exist as sibling artboards named "Sign in / Field error — Desktop" and so on.' },
    { check: 'Form width in range', how: 'get_computed_styles on the form: 360 to 400px wide; on mobile the form fills the width minus 40 to 48px.' },
    { check: 'Mobile inputs are 16px', how: 'get_computed_styles on an input of the mobile artboard: font-size 16px or more, height 48px or more.' },
    { check: 'No dead end', how: 'Every state offers a next action: retry, reset, change email or switch to the other screen.' },
  ],
  build: {
    artboards: [
      desktop('Sign in / Default'),
      desktop('Sign in / Field error'),
      desktop('Sign in / Wrong credentials'),
      desktop('Sign in / Submitting'),
      mobile('Sign in / Default'),
      mobile('Sign in / Field error', false),
      desktop('Sign up / Default', false),
      desktop('Sign in / Check your email', false),
    ],
    blocks: ['login-01', 'login-02', 'login-05', 'signup-01', 'signup-05'],
    components: ['field', 'input', 'button', 'separator', 'alert', 'spinner'],
    designSystem: [
      'list_blocks({ category: "login" }) and pick the nearest block: login-01 (one centered form), login-02 (form plus cover image), login-05 (email only), signup-01 or signup-05 (with providers). insert_block({ block, new_artboard: { name: "Sign in / Default — Desktop" } }) writes it as real instances.',
      'Edit the block\'s words and layers instead of rebuilding: set_text for the heading, labels and button, update_styles for widths. Remove regions the product does not have (providers, side image) rather than leaving them as filler.',
      'For states, duplicate_nodes the finished artboard, then change only what differs: set invalid on the failing input and add a field-error, insert an alert (variant destructive) above the button for the wrong-credentials state, swap the button label and add a spinner for Submitting.',
      'Mobile: a new artboard from the Mobile preset, one column, the same words. Do not shrink the desktop artboard.',
      'End with get_screenshot of every state side by side (arrange_artboards), then set_link between the sign in and sign up artboards and the "Forgot password?" target.',
    ],
    plain: [
      'create_artboard "Sign in / Default — Desktop" 1440 x 900 with a quiet background; write the form column (heading, two labelled inputs 44px high, a full-width 44px filled button, a text link row) with write_html in one group, then the optional provider buttons.',
      'Give each input a real <label> above it and a 1px border at 3:1 contrast against the background; error borders use the product\'s danger color.',
      'Build each state by duplicate_nodes of the artboard plus set_text and update_styles on the differing layers; do not redraw.',
      'Make the Mobile artboard with the Mobile preset (375 x 812): same copy, 20px side padding, 48px controls, 16px input text.',
      'Screenshot every artboard; set_link the switch and recovery links; get_links until nothing is broken.',
    ],
    snippet:
      '<ds-field-set style="width:380px"><ds-field-group>' +
      '<ds-field><ds-field-label>Email</ds-field-label><ds-input type="email" placeholder="name@company.com"></ds-input></ds-field>' +
      '<ds-field invalid><ds-field-label>Password</ds-field-label><ds-input type="password" invalid></ds-input><ds-field-error>Use at least 12 characters.</ds-field-error></ds-field>' +
      '<ds-button style="width:100%">Sign in</ds-button>' +
      '</ds-field-group></ds-field-set>',
  },
  related: ['onboarding', 'empty-states'],
  sketch: [
    ['fill', 0, 0, 50, 62],
    ['ink', 16, 12, 18, 4],
    ['line', 12, 22, 26, 2],
    ['box', 12, 27, 26, 6],
    ['line', 12, 37, 26, 2],
    ['box', 12, 42, 26, 6],
    ['accent', 12, 52, 26, 6],
    ['box', 58, 10, 34, 42],
    ['line', 62, 16, 22, 2],
    ['line', 62, 22, 26, 2],
    ['line', 62, 28, 18, 2],
  ],
};

export const SETTINGS: Pattern = {
  id: 'settings',
  title: 'Settings',
  kind: 'screen',
  category: 'account',
  platform: 'both',
  summary: 'Grouped, scannable settings where every change shows it was saved and danger stays fenced off.',
  purpose:
    'Let people change how the product behaves for them or their team, without fear. A settings screen is read far more than it is edited, so it is built for scanning first and for safe editing second.',
  useWhen: [
    'Account, profile, workspace, project, notification or preference pages.',
    'Any screen where a person edits stored values rather than creating content.',
    'Billing and team pages when they share the same chrome.',
  ],
  avoidWhen: [
    'A setting that every user must decide on first use: that belongs in onboarding.',
    'One-off actions (export, invite): put them where the work happens, link them from here if needed.',
  ],
  keywords: [
    'settings', 'preferences', 'account settings', 'profile', 'workspace settings', 'project settings', 'configuration', 'options', 'admin',
    'team settings', 'toggle', 'danger zone', 'delete account', 'privacy', 'billing settings',
  ],
  anatomy: [
    { region: 'Page header', job: 'Names the page and the scope (which workspace or project).', notes: 'Title plus one muted line. Page-wide actions only if truly page-wide.' },
    { region: 'Section navigation', job: 'Moves between groups of settings.', notes: 'A left rail on web (5 to 7 items, ordered by how often people open them) or a grouped list on mobile where each row opens its own screen. Current item marked by more than color.' },
    { region: 'Setting group', job: 'Holds related settings under one heading.', notes: 'A heading, one line of description, then rows or a small form. Hairline separators or a card, not both stacked.' },
    { region: 'Setting row', job: 'One decision: label, effect, control.', notes: 'Label on the left (14px, weight 500) with a one-line helper that says what changes; control on the right in a fixed-width column.' },
    { region: 'Save feedback', job: 'Shows that the change landed.', notes: 'Toggles and selects save on change and show a quiet "Saved" for about 2 seconds. Text forms have one Save per group, disabled until something changed, with a Discard beside it.' },
    { region: 'Danger zone', job: 'Fences off irreversible actions.', notes: 'Last on the page, separated, one row per action with its consequence in words. The only place the destructive color appears at rest.' },
  ],
  states: [
    { name: 'Default', required: true, shows: 'Groups with their current values, Save disabled, nothing flagged.', copy: 'Helpers state the effect ("Shown in the sidebar and in emails"), not the obvious ("Enter your name").' },
    { name: 'Unsaved changes', required: true, shows: 'Save enabled and Discard visible for the edited group; the changed field is not otherwise decorated.', copy: 'The button says what it saves: "Save changes". Leaving with unsaved changes asks once.' },
    { name: 'Saved', required: true, shows: 'A quiet confirmation next to the control or button, then it fades. The Save button returns to disabled.', copy: '"Saved". Not "Success!" and not a modal.' },
    { name: 'Validation error', required: true, shows: 'The field is marked, a one-line error sits under it, the group\'s Save stays enabled but the error blocks it; focus lands on the first error.', copy: 'Say how to fix it: "Names can use letters, numbers and dashes", not "Invalid".' },
    { name: 'Danger confirmation', required: true, shows: 'A dialog that names the object, says what is lost and who is affected, and asks for a typed name when the loss is permanent.', copy: 'The confirm button repeats the verb and object: "Delete project". The safe button is "Keep project" or "Cancel". Never "Yes".' },
    { name: 'No permission', required: false, shows: 'Controls disabled, not hidden, with one line saying who can change them.', copy: '"Only workspace owners can change this. Ask Ana Ruiz."' },
    { name: 'Loading', required: false, shows: 'The page structure with row skeletons the size of the final rows, so nothing jumps.', copy: 'No spinner text; the skeletons are the message.' },
  ],
  copy: [
    'Labels are nouns ("Project name", "Time zone"), not questions or sentences.',
    'Helper text says what the setting changes for the person, in one line.',
    'A toggle\'s label names the thing that is on ("Email me about mentions"), never "Enable" or "Turn on".',
    'The same setting has the same label everywhere: navigation, page heading and confirmation use one name.',
    'Destructive buttons name the verb and the object; the explanation sits above them, not in a tooltip.',
  ],
  layout: [
    { platform: 'web', rule: 'Content column 640 to 720px; navigation rail 200 to 240px on the left; 32 to 40px between groups, 16 to 24px between a label and its control.' },
    { platform: 'web', rule: 'Row height 56 to 72px with a helper line, 44 to 48px without; every text input and select on the screen shares one width (240 to 320px) and one height (32 to 40px).' },
    { platform: 'mobile', rule: 'A root list of sections with 16px side insets, rows at least 48px (touch target 44px), chevrons on rows that open a screen; each section screen is one column.' },
    { rule: 'Section headings 16 to 18px weight 600; labels 14px; helpers 13px muted; never below 12px.' },
    { rule: 'One primary (filled) button per group, and only while the group has unsaved changes.' },
  ],
  mistakes: [
    'Forty rows on one long page with no grouping or navigation.',
    'A toggle that needs a Save button, or a text field that saves silently on every keystroke.',
    'Different control widths and heights from group to group.',
    'Red used for anything but irreversible actions; a red "Save".',
    'Controls hidden when the person lacks permission, so they cannot tell the setting exists.',
    'The delete action beside the rename field, at equal weight.',
    'Labels written as placeholders inside inputs.',
  ],
  review: [
    { check: 'One control size', how: 'get_computed_styles on three inputs from different groups: same height and width.' },
    { check: 'Save logic is consistent', how: 'Toggles and selects have no Save button; every text group has exactly one, disabled in the Default state.' },
    { check: 'Danger zone is last and the only red', how: 'In the screenshot the destructive color appears only in the danger zone and its confirmation.' },
    { check: 'Required states exist', how: 'Sibling artboards for Unsaved changes, Validation error and Danger confirmation, named "Settings / <State> — Desktop".' },
    { check: 'Helpers carry information', how: 'Read each helper line: it states an effect, and none repeats its label.' },
    { check: 'Navigation shows where you are', how: 'The current section is marked with weight or a bar as well as color.' },
  ],
  build: {
    artboards: [
      desktop('Settings / General'),
      desktop('Settings / Unsaved changes'),
      desktop('Settings / Validation error'),
      desktop('Settings / Delete confirmation'),
      desktop('Settings / No permission', false),
      mobile('Settings / Root'),
      mobile('Settings / General'),
    ],
    blocks: ['sidebar-01', 'sidebar-07'],
    components: ['card', 'field', 'input', 'switch', 'native-select', 'button', 'separator', 'alert', 'badge', 'tabs'],
    designSystem: [
      'create_artboard "Settings / General — Desktop" (Desktop preset) and set the page chrome first: insert_block sidebar-01 for the app shell if the product has one, else a plain 220px navigation rail of text links.',
      'Write each group with write_html as one card: <ds-card> with a card-header (title and description) and card-content holding <ds-field> rows. Rows with a toggle use <ds-field orientation="horizontal"> with a field-content (label, description) beside the switch.',
      'Give every text input the same width with update_styles on the inputs (one value), and put the group\'s Save and Discard buttons in the card-footer.',
      'Danger zone is the last card: a destructive-outlined button inside a card whose description states the consequence. The confirmation is a dialog drawn open on its own artboard (get_component dialog).',
      'Duplicate the General artboard for Unsaved changes (enable Save, show Discard) and Validation error (invalid input, field-error), then Mobile: a Root artboard with grouped item rows and one section screen.',
      'get_screenshot, inspect_design, fix every "fix" finding; set_link the navigation items to their section artboards.',
    ],
    plain: [
      'create_artboard "Settings / General — Desktop"; write the page header, then the navigation rail (220px, current item bold with a 2px bar), then one group per write_html.',
      'Rows: a flex row with the label block on the left (14px/500 and a 13px muted helper) and a control column of fixed width on the right; separate rows with 1px hairlines at low contrast.',
      'Danger zone last, separated by 40px and a 1px border; its button is outline with the danger color on text and border only.',
      'Duplicate for the other states and change only the differing layers. Mobile: separate artboard, a list of rows at 52px with chevrons.',
      'Screenshot all states; check the control widths with get_computed_styles before finishing.',
    ],
    snippet:
      '<ds-card style="width:680px"><ds-card-header><ds-card-title>Project</ds-card-title><ds-card-description>How this project appears to your team.</ds-card-description></ds-card-header>' +
      '<ds-card-content><ds-field-group>' +
      '<ds-field><ds-field-label>Project name</ds-field-label><ds-input placeholder="Website relaunch"></ds-input><ds-field-description>Shown in the sidebar and in emails.</ds-field-description></ds-field>' +
      '<ds-field orientation="horizontal"><ds-field-content><ds-field-label>Email me about mentions</ds-field-label><ds-field-description>One email at most every hour.</ds-field-description></ds-field-content><ds-switch checked></ds-switch></ds-field>' +
      '</ds-field-group></ds-card-content>' +
      '<ds-card-footer><ds-button variant="outline">Discard</ds-button><ds-button>Save changes</ds-button></ds-card-footer></ds-card>',
  },
  related: ['upgrade-paywall', 'notifications', 'empty-states'],
  sketch: [
    ['fill', 4, 4, 18, 54],
    ['line', 7, 10, 12, 2],
    ['ink', 7, 16, 11, 2],
    ['line', 7, 22, 13, 2],
    ['ink', 28, 6, 24, 3],
    ['box', 28, 14, 66, 20],
    ['line', 32, 19, 18, 2],
    ['box', 66, 18, 24, 5],
    ['line', 32, 27, 22, 2],
    ['box', 66, 26, 24, 5],
    ['box', 28, 38, 66, 12],
    ['line', 32, 43, 24, 2],
    ['box', 74, 42, 16, 5],
    ['accent', 78, 53, 16, 5],
  ],
};
