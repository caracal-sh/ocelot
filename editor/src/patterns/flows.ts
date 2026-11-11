import { desktop, mobile } from './helpers';
import type { Pattern } from './types';

export const ONBOARDING: Pattern = {
  id: 'onboarding',
  title: 'Onboarding',
  kind: 'flow',
  category: 'onboarding',
  platform: 'both',
  summary: 'A short first run that ends in something useful, can be skipped, and survives interruption.',
  purpose:
    'Take a new person from an empty account to their first useful result. Every step either collects something that changes what they see next or removes friction; anything else waits until later.',
  useWhen: [
    'The first run after sign-up, before the product looks like itself.',
    'A new workspace, project or device that needs a few decisions to be useful.',
    'Reopening a half-finished setup.',
  ],
  avoidWhen: [
    'Teaching the whole interface: let the product teach itself in context.',
    'Collecting data for marketing: that is not the person\'s goal.',
  ],
  keywords: [
    'onboarding', 'welcome', 'getting started', 'first run', 'setup', 'set up', 'wizard', 'walkthrough', 'steps', 'new user', 'tutorial', 'activation',
    'checklist', 'profile setup', 'create workspace', 'intro',
  ],
  anatomy: [
    { region: 'Progress', job: 'Shows how far along and how much is left.', notes: 'A quiet "Step 2 of 4" or a thin bar. Three to five steps. Saved, so it can resume.' },
    { region: 'Step content', job: 'One question or one action per screen.', notes: 'A short headline in the person\'s terms, a line saying why it is asked, then the control: option cards, a field or a connect button.' },
    { region: 'Preview', job: 'Optional: shows what the answer changes.', notes: 'A live fragment of the real product on the right (web) or above the control (mobile).' },
    { region: 'Primary action', job: 'Moves forward.', notes: 'One filled button named for what happens next: "Continue", "Create workspace".' },
    { region: 'Skip and back', job: 'Keep the person in control.', notes: '"Skip for now" as text, for anything optional; a back control on every step after the first.' },
    { region: 'Completion', job: 'Lands in the product with a first result.', notes: 'The first useful thing exists (a sample project, an imported list) and the first action is obvious. An optional checklist continues the setup without blocking.' },
  ],
  states: [
    { name: 'Welcome', required: true, shows: 'What the person will have at the end and how long it takes.', copy: '"Set up your workspace in two minutes." One action.' },
    { name: 'Step', required: true, shows: 'A question with its control, progress, back and the primary action.', copy: 'Headlines are tasks: "What are you working on?" Options are the person\'s words.' },
    { name: 'Step error', required: true, shows: 'The failed field or connection is marked inline; what was entered stays; the primary action stays available.', copy: '"We could not connect to the calendar. Try again or skip this for now."' },
    { name: 'Optional step skipped', required: true, shows: 'The flow continues; the skipped item reappears in the checklist.', copy: 'The checklist item says what is missing: "Connect your calendar".' },
    { name: 'Interrupted and resumed', required: true, shows: 'On return the person lands on the step they left, with their answers, and sees how much is done.', copy: '"Welcome back. You are on step 3 of 4."' },
    { name: 'Permission asked', required: false, shows: 'A pre-permission screen explaining why before the system dialog; denial continues the flow.', copy: 'See permission-prompt.' },
    { name: 'Completion', required: true, shows: 'The product with real or sample content and one next action.', copy: '"Your workspace is ready. Add your first task."' },
  ],
  copy: [
    'Say why each question is asked and what it changes.',
    'Use the person\'s words for options, not internal labels.',
    'Name the next step on the button; "Continue" is for steps without a result, "Create workspace" for the last one.',
    'Skipping is allowed and named plainly: "Skip for now", never "No thanks, I do not want to improve".',
    'Never count steps you do not have; do not promise "just one more question" twice.',
  ],
  layout: [
    { platform: 'web', rule: 'A centered column 480 to 560px wide, with an optional 40% preview pane on the right; step headline 28 to 32px, support 16px muted, 32 to 40px before the control.' },
    { platform: 'web', rule: 'Option cards 56 to 72px high, 12px apart, selection shown by border, fill and a check, never color alone.' },
    { platform: 'mobile', rule: 'One step per screen; back control 44px top-left; primary button 52px pinned at the bottom with 34px safe area; 24px side padding.' },
    { rule: 'At most five steps; each step must answer "what does this change for me?".' },
  ],
  mistakes: [
    'Asking for permissions before showing any value.',
    'A twelve-step form dressed as a welcome.',
    'No way back, or no way to skip an optional step.',
    'Progress that restarts when the person closes the tab.',
    'A product tour of tooltips over an empty product.',
    'Illustrations of abstract shapes instead of the product.',
    'A completion screen that is confetti with no next action.',
  ],
  review: [
    { check: 'First result arrives', how: 'The Completion artboard shows real or sample content, not an empty product.' },
    { check: 'Skippable and reversible', how: 'Every optional step has Skip, every step after the first has Back.' },
    { check: 'Short', how: 'Count the steps: five or fewer, and each changes something visible.' },
    { check: 'Progress is saved', how: 'A Resumed artboard exists and says where the person is.' },
    { check: 'One filled button', how: 'Each step has exactly one primary action.' },
  ],
  build: {
    artboards: [
      desktop('Onboarding / Welcome'),
      desktop('Onboarding / Step 1'),
      desktop('Onboarding / Step 2'),
      desktop('Onboarding / Step error'),
      desktop('Onboarding / Resumed'),
      desktop('Onboarding / Done'),
      mobile('Onboarding / Welcome'),
      mobile('Onboarding / Step 1'),
      mobile('Onboarding / Done'),
    ],
    blocks: [],
    components: ['button', 'card', 'radio-group', 'field', 'input', 'progress', 'alert', 'checkbox'],
    designSystem: [
      'create_artboard per step, named "Onboarding / Step 1 — Desktop" so arrange_artboards orders them as a row. Reuse one frame for the shell and duplicate_nodes it per step; change the headline, support line and control only.',
      'Option cards: <ds-card> each containing a title and a description with a <ds-radio-group-item>; the selected one gets a 2px primary border. Progress: <ds-progress> with a small label, or plain text "Step 2 of 4".',
      'Primary <ds-button> at the bottom of the column; "Skip for now" as <ds-button variant="ghost">; back as a ghost icon button.',
      'Step error: set invalid on the field and add <ds-field-error> or an <ds-alert>. Completion: the product screen with sample content and a highlighted first action.',
      'set_link: Continue to the next step, Back to the previous, Skip to the next, Done to the product screen.',
    ],
    plain: [
      'create_artboard "Onboarding / Welcome — Desktop"; write the column with write_html, then duplicate_nodes the artboard for each step and change the text and the control.',
      'Use one option-card style: 64px high, 1px border, 12px radius, selected state with a 2px accent border and a check icon.',
      'The progress line is 13px muted text or a 4px bar at the top; the primary button is the only filled control.',
      'Build the Completion artboard from the real product screen with sample content, not a celebration.',
      'Link the steps with set_link and run get_links.',
    ],
    snippet:
      '<div style="display:flex;flex-direction:column;gap:24px;width:520px">' +
      '<p style="margin:0;font-size:13px">Step 2 of 4</p>' +
      '<h1 style="margin:0;font-size:30px;font-weight:600;line-height:1.2">What are you working on?</h1>' +
      '<p style="margin:0;font-size:16px">We use this to set up your first project.</p>' +
      '<ds-card><ds-card-header><ds-card-title>A website</ds-card-title><ds-card-description>Pages, launches and content.</ds-card-description></ds-card-header></ds-card>' +
      '<div style="display:flex;gap:12px"><ds-button variant="ghost">Skip for now</ds-button><ds-button>Continue</ds-button></div></div>',
  },
  related: ['sign-in-up', 'permission-prompt', 'empty-states'],
  sketch: [
    ['line', 30, 6, 40, 1],
    ['accent', 30, 6, 16, 1],
    ['ink', 30, 14, 34, 4],
    ['line', 30, 22, 26, 2],
    ['box', 30, 28, 40, 8],
    ['box', 30, 38, 40, 8],
    ['accent', 54, 50, 16, 5],
    ['line', 30, 52, 12, 2],
  ],
};

export const EMPTY_STATES: Pattern = {
  id: 'empty-states',
  title: 'Empty states',
  kind: 'state-set',
  category: 'feedback',
  platform: 'both',
  summary: 'Four different empty screens — first use, no results, error, no access — each with its own words.',
  purpose:
    'Handle the moments when there is nothing to show. There are at least four different reasons for it, each needing a different message and a different next step; one "Nothing here" for all of them is the most common design failure.',
  useWhen: [
    'Any list, table, feed, dashboard block or search that can come back empty.',
    'A screen whose data failed to load or that the person cannot open.',
  ],
  avoidWhen: [
    'A list that always has content: do not invent a state.',
    'As decoration: an empty state exists to help the next action.',
  ],
  keywords: [
    'empty state', 'empty states', 'no data', 'nothing here', 'no results', 'error state', 'blank slate', 'zero state', 'first use', 'no access',
    'permission denied', 'not found', '404', 'all caught up', 'offline', 'failed to load',
  ],
  anatomy: [
    { region: 'Media', job: 'Optional: a small icon or a fragment of the real product.', notes: '48 to 64px. Neutral, never a mascot that is bigger than the words.' },
    { region: 'Headline', job: 'Says which kind of empty this is.', notes: '18 to 20px, weight 600; one line.' },
    { region: 'Explanation', job: 'Says why and what will be here.', notes: '14 to 15px muted, one to three lines, at most about 60 characters wide.' },
    { region: 'Primary action', job: 'The one next step for this kind of empty.', notes: 'A single button. The action differs by kind; it is never "Create" for all of them.' },
    { region: 'Secondary help', job: 'Optional: a text link to docs or support.', notes: 'Quiet; never competes with the primary action.' },
  ],
  states: [
    { name: 'First use', required: true, shows: 'The area is empty because nothing was created yet; it says what this will hold and offers to create the first one (if the person is allowed to).', copy: '"No projects yet. Projects hold your tasks, files and discussions." Action: "Create project". Respect permissions: if they cannot create, say who can.' },
    { name: 'No results', required: true, shows: 'A search or filter matched nothing; the query and filters stay, and the way out is to loosen them.', copy: '"No projects match "launch" and Status: Active." Action: "Clear filters". Not Create.' },
    { name: 'Error', required: true, shows: 'The content could not load; the result is unknown, not empty; previous input is kept; stale data is labelled with its age.', copy: '"We could not load your projects." Action: "Try again". Say what happens if retry fails: where to look.' },
    { name: 'No access', required: true, shows: 'The content exists but the person cannot open it; the message does not leak names or counts.', copy: '"You do not have access to this project." Action: "Request access" or "Contact an admin".' },
    { name: 'All caught up', required: false, shows: 'A list that is empty because everything is done.', copy: '"You are all caught up." A small, calm message; no new action required.' },
    { name: 'Offline', required: false, shows: 'No connection: shows cached content if any, labelled, and says when it will sync.', copy: '"You are offline. Changes are saved on this device and will sync when you reconnect."' },
  ],
  copy: [
    'Name the reason in the headline: "No projects yet", "No matches", "Could not load", "No access".',
    'The action differs by kind: create, clear filters, retry, request access.',
    'Never blame the person; never write "Oops".',
    'Do not offer Create on no-results or error unless it truly fits.',
    'Keep the person\'s input: query, filters and half-typed forms survive an error.',
  ],
  layout: [
    { rule: 'The block is 320 to 420px wide, centered in the area that is empty (not the whole page), with 12 to 16px between headline and explanation and 24px before the action.' },
    { platform: 'web', rule: 'Place it within the table or list area so the toolbar and header stay visible; vertical position slightly above the center of that area.' },
    { platform: 'mobile', rule: '24px side padding; the action is 48px high, full width when it is the only one.' },
    { rule: 'Media 48 to 64px, optical center above the headline with 16 to 20px between.' },
  ],
  mistakes: [
    'One generic illustration and "Nothing here" for every case.',
    'A Create button on a no-results screen.',
    'An error shown as an empty list, so people think their data is gone.',
    'Revealing the name of a resource in the no-access message.',
    'A large decorative illustration that pushes the action off the screen.',
    'Clearing the query or the filters when the search fails.',
  ],
  review: [
    { check: 'Four artboards, four messages', how: 'First use, No results, Error and No access exist as separate artboards with different headlines and different primary actions.' },
    { check: 'No Create on the wrong states', how: 'The primary action on No results is Clear filters; on Error it is Try again.' },
    { check: 'Input survives', how: 'The query and filters appear in the No results and Error artboards.' },
    { check: 'No leaked names', how: 'The No access text does not contain the resource\'s name.' },
    { check: 'Copy size', how: 'Headline 18px or more, explanation 14px or more, within about 60 characters wide.' },
  ],
  build: {
    artboards: [
      desktop('Projects / First use'),
      desktop('Projects / No results'),
      desktop('Projects / Error'),
      desktop('Projects / No access'),
      mobile('Projects / First use'),
      mobile('Projects / No results'),
      desktop('Projects / All caught up', false),
    ],
    blocks: [],
    components: ['empty', 'button', 'alert', 'input', 'badge'],
    designSystem: [
      'Build the screen once as the populated list (toolbar and header), then duplicate_nodes it for each state and replace the content area with one <ds-empty> (header with media, title, description; content with the action).',
      'First use: <ds-empty-media variant="icon"> with a relevant icon, the create <ds-button>. No results: keep the toolbar and the filters, <ds-button variant="outline">Clear filters</ds-button>. Error: <ds-alert variant="destructive"> or an <ds-empty> with a retry button. No access: <ds-empty> with Request access.',
      'Keep the same layout position for all four so reviewers can compare; only words, icon and action change.',
      'Mobile: the same four on 375-wide artboards.',
    ],
    plain: [
      'Build the populated screen, then duplicate_nodes it for each state; delete the rows and write one centered block into the content area: 20px headline, 14px muted text, one button.',
      'Use the same container size and vertical position for each state; change the words, the icon and the action.',
      'Make sure No results keeps the query text in the search field and the active filter chips.',
      'Screenshot the four side by side with arrange_artboards.',
    ],
    snippet:
      '<ds-empty style="width:420px"><ds-empty-header><ds-empty-media variant="icon"><ds-icon name="search"></ds-icon></ds-empty-media>' +
      '<ds-empty-title>No projects match "launch"</ds-empty-title>' +
      '<ds-empty-description>Nothing matches this search with Status: Active. Try fewer words or clear the filter.</ds-empty-description></ds-empty-header>' +
      '<ds-empty-content><ds-button variant="outline">Clear filters</ds-button></ds-empty-content></ds-empty>',
  },
  related: ['data-table', 'search-results', 'dashboard-overview'],
  sketch: [
    ['box', 8, 6, 84, 8],
    ['line', 12, 9, 22, 2],
    ['fill', 42, 20, 16, 12],
    ['ink', 34, 36, 32, 3],
    ['line', 30, 42, 40, 2],
    ['line', 36, 46, 28, 2],
    ['accent', 42, 52, 16, 5],
  ],
};

export const NOTIFICATIONS: Pattern = {
  id: 'notifications',
  title: 'Notifications and inbox',
  kind: 'screen',
  category: 'feedback',
  platform: 'both',
  summary: 'A feed of what happened, grouped by day, with clear unread marks and few actions.',
  purpose:
    'Tell people what changed while they were away and let them act on what needs them. Notifications are read in passing, so each one must be a clear sentence with a visible state and a clear target.',
  useWhen: [
    'A bell menu, an inbox page or a notification centre.',
    'The page behind a push or email notification.',
  ],
  avoidWhen: [
    'Transient confirmations of an action just performed: use a toast.',
    'Marketing messages in the same feed as activity.',
  ],
  keywords: [
    'notifications', 'inbox', 'alerts', 'activity feed', 'bell', 'unread', 'mentions', 'updates', 'messages', 'notification center', 'push', 'feed',
    'toast', 'mark all read',
  ],
  anatomy: [
    { region: 'Header', job: 'Names the list and offers list-wide actions.', notes: 'Title, "Mark all as read", a link to notification settings.' },
    { region: 'Filters', job: 'Narrow by state or kind.', notes: 'Tabs: All, Unread, Mentions. Show counts only for unread.' },
    { region: 'Day groups', job: 'Order the feed in time.', notes: 'Today, Yesterday, then dates. Sticky small headings.' },
    { region: 'Notification row', job: 'One event.', notes: 'Actor avatar, a sentence with the object emphasised, a relative time, an unread marker (a dot and weight, not color alone) and, when the event waits for a decision, one inline action.' },
    { region: 'Row actions', job: 'Manage the item.', notes: 'Mark read, mute this thread, open; on hover and focus on web, swipe or overflow on mobile.' },
    { region: 'Footer', job: 'Continues the list.', notes: 'Load more or an end marker ("You are up to date").' },
  ],
  states: [
    { name: 'Default', required: true, shows: 'A mix of unread and read rows, grouped by day.', copy: 'Rows are sentences: "Ana Ruiz commented on Homepage redesign".' },
    { name: 'Unread filter', required: true, shows: 'Only unread rows, with the count; marking one read removes it from the list after a short delay.', copy: 'The tab shows "Unread, 4".' },
    { name: 'All caught up', required: true, shows: 'The list is empty because everything is read; a short calm message.', copy: '"You are all caught up." Link to settings, no new action.' },
    { name: 'Loading', required: true, shows: 'Skeleton rows at the final row height under the real header and tabs, so nothing moves when the feed arrives.', copy: 'No text; the shapes are the message.' },
    { name: 'Error', required: true, shows: 'The feed could not load; retry.', copy: '"We could not load notifications. Retry."' },
    { name: 'Action taken', required: false, shows: 'The inline action completed: the row shows the result and the unread marker clears.', copy: '"Invite accepted." Not a new notification.' },
    { name: 'Push permission', required: false, shows: 'Mobile: a prompt to enable push, shown in context.', copy: 'See permission-prompt.' },
  ],
  copy: [
    'A notification is a sentence: actor, verb, object, place. No "You have a new notification".',
    'Time is relative and short ("2h"), absolute on hover or long press.',
    'Inline actions are verbs the person can do now: "Accept", "Review", not "View details".',
    'The same event reads the same in the feed, the email and the push.',
    'Group repeated events ("Ana and 3 others commented") instead of listing each.',
  ],
  layout: [
    { platform: 'web', rule: 'Popover 380 to 420px wide, up to 560px tall, scrolling inside; full page list 640 to 720px.' },
    { rule: 'Rows 64 to 80px; avatar 32 to 40px; 12 to 16px between avatar and text; the unread dot 8px at the row\'s left edge.' },
    { platform: 'mobile', rule: 'Rows at least 72px with 16px side padding; tabs scroll horizontally; inline actions 44px high.' },
    { rule: 'Text 14px for the sentence, 13px muted for the time and the place; two lines at most, then truncate.' },
  ],
  mistakes: [
    'Unread shown only by a faint color change.',
    'Every row with two buttons.',
    'A bell with a count that never clears.',
    'Marketing and activity mixed.',
    'Rows that say only "New activity" without a subject.',
    'No link from a notification to the thing it is about.',
  ],
  review: [
    { check: 'Unread is unmistakable', how: 'In the screenshot unread rows differ by a marker and weight, not only a tint.' },
    { check: 'Sentences', how: 'Every row names the actor, the verb and the object.' },
    { check: 'At most one inline action', how: 'No row has more than one decisive action visible.' },
    { check: 'All caught up exists', how: 'An All caught up artboard is drawn with its own words.' },
    { check: 'Time format is consistent', how: 'Read the time on every row: all use one short relative format, and the day headings agree with them.' },
  ],
  build: {
    artboards: [
      desktop('Notifications / Default'),
      desktop('Notifications / Unread'),
      desktop('Notifications / All caught up'),
      desktop('Notifications / Loading'),
      desktop('Notifications / Error'),
      mobile('Notifications / Default'),
      mobile('Notifications / All caught up', false),
    ],
    blocks: [],
    components: ['item', 'avatar', 'badge', 'button', 'tabs', 'skeleton', 'empty', 'alert', 'separator'],
    designSystem: [
      'create_artboard "Notifications / Default — Desktop"; header with title and a ghost <ds-button> "Mark all as read"; <ds-tabs> for All, Unread and Mentions.',
      'Rows: <ds-item> with <ds-item-media> holding a <ds-avatar>, <ds-item-content> with the sentence (title) and the place and time (description), and <ds-item-actions> for the one inline <ds-button variant="outline" size="sm">. The unread marker is an 8px circle layer on the left plus weight 600 on the sentence.',
      'Group by day with small headings; build one row then duplicate_nodes and set_text for the rest.',
      'States: skeletons for Loading, <ds-empty> for All caught up, <ds-alert variant="destructive"> with Retry for Error.',
    ],
    plain: [
      'create_artboard "Notifications / Default — Desktop"; write one row (avatar, sentence, time, unread dot) as a frame of 72px height, then duplicate_nodes and set_text.',
      'Unread rows: add the dot and weight 600; read rows are regular weight. Never rely on tint alone.',
      'Day headings in 12px uppercase-free muted text; states are separate artboards with the list replaced.',
      'Mobile as its own artboard; screenshot all.',
    ],
    snippet:
      '<ds-item><ds-item-media><ds-avatar><ds-avatar-fallback>AR</ds-avatar-fallback></ds-avatar></ds-item-media>' +
      '<ds-item-content><ds-item-title>Ana Ruiz commented on Homepage redesign</ds-item-title><ds-item-description>2h · Design / Website</ds-item-description></ds-item-content>' +
      '<ds-item-actions><ds-button variant="outline" size="sm">Review</ds-button></ds-item-actions></ds-item>',
  },
  related: ['detail-page', 'settings', 'permission-prompt'],
  sketch: [
    ['ink', 8, 6, 22, 3],
    ['line', 70, 6, 22, 2],
    ['fill', 8, 14, 12, 4],
    ['fill', 22, 14, 12, 4],
    ['fill', 8, 24, 5, 5],
    ['line', 16, 24, 50, 2],
    ['line', 16, 29, 24, 2],
    ['fill', 8, 38, 5, 5],
    ['line', 16, 38, 44, 2],
    ['line', 16, 43, 20, 2],
    ['box', 74, 38, 18, 6],
    ['line', 16, 52, 40, 2],
  ],
};

export const PERMISSION_PROMPT: Pattern = {
  id: 'permission-prompt',
  title: 'Permission prompt',
  kind: 'flow',
  category: 'onboarding',
  platform: 'mobile',
  summary: 'Ask for a device permission in context, say what it gives, and keep going if the answer is no.',
  purpose:
    'Explain why the product needs a device permission before the system asks, so the person can make an informed choice. The system dialog can be shown only once, so the explanation screen protects it.',
  useWhen: [
    'Notifications, location, camera, contacts or photos, at the moment the feature needs them.',
    'After a denial, when the person later tries the feature again.',
  ],
  avoidWhen: [
    'At launch, before the person has seen any value.',
    'Asking for several permissions on one screen.',
  ],
  keywords: [
    'permission', 'permissions', 'notifications permission', 'push notifications', 'location', 'camera', 'contacts', 'photos', 'allow', 'ios', 'android',
    'pre-permission', 'access request', 'tracking',
  ],
  anatomy: [
    { region: 'Skip', job: 'Lets the person move on.', notes: 'A "Not now" text action at the top-right or bottom, 44px tall.' },
    { region: 'Preview', job: 'Shows what the permission enables.', notes: 'A fragment of the real feature (a notification that would arrive, a map with nearby places). Not a generic icon in a circle.' },
    { region: 'Headline', job: 'States the benefit in the person\'s terms.', notes: '24 to 28px. "Know when your order ships".' },
    { region: 'Explanation', job: 'Says what will and will not happen.', notes: 'One or two lines: what is used and what is never done with it.' },
    { region: 'Primary action', job: 'Triggers the system dialog.', notes: 'Named for the permission: "Turn on notifications", "Allow location".' },
    { region: 'Secondary action', job: 'Declines without drama.', notes: '"Not now". The flow continues.' },
  ],
  states: [
    { name: 'Explanation', required: true, shows: 'The pre-permission screen with preview, benefit, primary and secondary actions.', copy: 'One permission, one benefit.' },
    { name: 'System dialog', required: false, shows: 'The system\'s own prompt over a dimmed explanation; do not draw a copy of it.', copy: 'The system words are the system\'s.' },
    { name: 'Granted', required: true, shows: 'The feature is on and the person continues to it, with a short confirmation.', copy: '"Notifications are on. We will tell you when an order ships."' },
    { name: 'Denied', required: true, shows: 'The flow continues. Later, where the feature would be used, an inline message explains how to enable it and links to system settings.', copy: '"Notifications are off. Turn them on in Settings to hear when your order ships." Action: "Open Settings".' },
    { name: 'Not asked yet (deferred)', required: false, shows: 'The person chose Not now; a quiet entry point remains where the feature lives.', copy: '"Turn on notifications".' },
  ],
  copy: [
    'Say the benefit first, the permission second.',
    'Promise only what is true: if you never share location, say that.',
    'The primary action names the permission; the secondary never shames.',
    'After a denial, never ask again on the same screen; offer the path to settings instead.',
    'One permission per screen.',
  ],
  layout: [
    { platform: 'mobile', rule: '375 x 812 artboard; the preview takes the top 40 to 45%; headline 24 to 28px; body 16px; 24px side padding.' },
    { platform: 'mobile', rule: 'Primary button 52px high, pinned bottom with 34px safe area; the secondary above or below it, at least 44px tall.' },
    { platform: 'mobile', rule: 'Include the status bar (get_guide mobile-status-bar) and start content 16px below it; never put content under it.' },
  ],
  mistakes: [
    'Asking at first launch with no context.',
    'A fake system dialog drawn inside the app.',
    'A generic bell icon in a circle and no preview.',
    'Making the decline option tiny or grey on grey.',
    'Blocking progress after a denial.',
    'Asking for notifications, location and camera on one screen.',
  ],
  review: [
    { check: 'Benefit in the headline', how: 'The headline states what the person gets, not the permission name.' },
    { check: 'Decline is readable', how: 'The secondary action is at least 44px tall and at least 4.5:1 contrast.' },
    { check: 'Denied path exists', how: 'A Denied artboard shows the flow continuing and the later route to settings.' },
    { check: 'One permission', how: 'The screen asks for exactly one.' },
    { check: 'Real preview', how: 'The preview shows the product\'s own content.' },
  ],
  build: {
    artboards: [mobile('Permission / Explanation'), mobile('Permission / Granted'), mobile('Permission / Denied'), mobile('Permission / Deferred', false)],
    blocks: [],
    components: ['button', 'card', 'alert', 'item'],
    designSystem: [
      'create_artboard "Permission / Explanation — Mobile" with the Mobile preset and the status bar (get_guide mobile-status-bar). Write the preview as a real fragment (a notification card, a map snippet).',
      'Headline and body as plain text layers; primary <ds-button style="width:100%;height:52px">Turn on notifications</ds-button> and <ds-button variant="ghost">Not now</ds-button> pinned in a bottom frame with 34px padding.',
      'Denied: the screen where the feature lives, with an <ds-alert> explaining how to turn it on and an outline <ds-button> "Open Settings".',
      'set_link Not now and Granted/Denied targets.',
    ],
    plain: [
      'create_artboard "Permission / Explanation — Mobile"; paste the status bar, write the preview, headline, body and the pinned bottom actions with write_html.',
      'Primary button 52px, full width, the only filled control; "Not now" is a text button with 44px height.',
      'Duplicate for Granted and Denied; Denied is the feature screen with an inline message.',
      'Screenshot and link.',
    ],
    snippet:
      '<div style="display:flex;flex-direction:column;gap:12px;width:327px">' +
      '<h1 style="margin:0;font-size:26px;font-weight:600;line-height:1.2">Know when your order ships</h1>' +
      '<p style="margin:0;font-size:16px">We send one notification when it ships and one when it arrives. Nothing else.</p>' +
      '<ds-button style="width:100%;height:52px">Turn on notifications</ds-button><ds-button variant="ghost" style="width:100%">Not now</ds-button></div>',
  },
  related: ['onboarding', 'notifications'],
  sketch: [
    ['box', 34, 2, 32, 58],
    ['fill', 38, 8, 24, 18],
    ['ink', 38, 30, 20, 3],
    ['line', 38, 36, 24, 2],
    ['line', 38, 40, 18, 2],
    ['accent', 38, 48, 24, 5],
    ['line', 44, 56, 12, 1],
  ],
};
