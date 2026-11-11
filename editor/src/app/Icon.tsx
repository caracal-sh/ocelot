import type { ReactNode } from 'react';

/** 16px outline icons, 1.5px rendered stroke, colored by currentColor. */
const PATHS = {
  pointer: <path d="M4 2.5v10.5l3-2.8 1.9 4.3 1.7-.8-1.9-4.2 4.1-.3z" />,
  frame: <path d="M5.5 2.5v11M10.5 2.5v11M2.5 5.5h11M2.5 10.5h11" />,
  text: <path d="M3.5 4.5V3h9v1.5M8 3v10M6 13h4" />,
  image: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <circle cx="6" cy="6" r="1.25" />
      <path d="M13.5 10.5 10.5 7.5 3 13.5" />
    </>
  ),
  artboard: <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />,
  vector: <path d="M8 2.5 13.5 8 8 13.5 2.5 8z" />,
  code: <path d="M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5" />,
  undo: <path d="M6 3.5 3 6.5l3 3M3 6.5h6.5a3.5 3.5 0 0 1 0 7H7" />,
  redo: <path d="m10 3.5 3 3-3 3M13 6.5H6.5a3.5 3.5 0 0 0 0 7H9" />,
  minus: <path d="M3.5 8h9" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  sidebar: <path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12zM6.5 2.5v11" />,
  chevron: <path d="m6 4 4 4-4 4" />,
  chevronDown: <path d="m4 6 4 4 4-4" />,
  play: <path d="M5.5 3.8v8.4a.5.5 0 0 0 .77.42l6.4-4.2a.5.5 0 0 0 0-.84l-6.4-4.2a.5.5 0 0 0-.77.42z" />,
  pause: <path d="M6 3.5v9M10 3.5v9" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  unlock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8S3.9 3.5 8 3.5 14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  eyeOff: <path d="M2.5 2.5l11 11M6.6 3.7A6 6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.6 2.1M11.3 11.6A6.4 6.4 0 0 1 8 12.5C3.9 12.5 1.5 8 1.5 8a11 11 0 0 1 2.7-3.1" />,
  // Inspector: field labels, segmented controls, menus.
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />,
  sizeFixed: <path d="M2.5 4.5v7M13.5 4.5v7M5 8h6" />,
  sizeHug: <path d="M2.5 8H6M13.5 8H10M4.5 6 6.5 8l-2 2M11.5 6 9.5 8l2 2" />,
  sizeFill: <path d="M2.5 3.5v9M13.5 3.5v9M5.5 8h5M7.5 6 5.5 8l2 2M8.5 6l2 2-2 2" />,
  dirRow: <path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5" />,
  dirColumn: <path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" />,
  dirRowReverse: <path d="M13 8H3M6.5 4.5 3 8l3.5 3.5" />,
  dirColumnReverse: <path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" />,
  wrap: <path d="M3 4.5h10M3 8h7.5a2 2 0 0 1 0 4H7M8.5 10.5 7 12l1.5 1.5" />,
  alignLeft: <path d="M3 4h10M3 7h6M3 10h10M3 13h6" />,
  alignCenter: <path d="M3 4h10M5 7h6M3 10h10M5 13h6" />,
  alignRight: <path d="M3 4h10M7 7h6M3 10h10M7 13h6" />,
  alignJustify: <path d="M3 4h10M3 7h10M3 10h10M3 13h10" />,
  // Align / distribute layers: a stroked guide line and solid bars (outline rects turn to blobs at 12px).
  alignEdgeLeft: (
    <>
      <path d="M2.5 2v12" />
      <rect x="5" y="3.5" width="8.5" height="3.5" rx="0.75" fill="currentColor" stroke="none" />
      <rect x="5" y="9" width="5.5" height="3.5" rx="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  alignEdgeCenterH: (
    <>
      <path d="M8 2v12" />
      <rect x="3" y="3.5" width="10" height="3.5" rx="0.75" fill="currentColor" stroke="none" />
      <rect x="5" y="9" width="6" height="3.5" rx="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  alignEdgeRight: (
    <>
      <path d="M13.5 2v12" />
      <rect x="2.5" y="3.5" width="8.5" height="3.5" rx="0.75" fill="currentColor" stroke="none" />
      <rect x="5.5" y="9" width="5.5" height="3.5" rx="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  alignEdgeTop: (
    <>
      <path d="M2 2.5h12" />
      <rect x="3.5" y="5" width="3.5" height="8.5" rx="0.75" fill="currentColor" stroke="none" />
      <rect x="9" y="5" width="3.5" height="5.5" rx="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  alignEdgeMiddleV: (
    <>
      <path d="M2 8h12" />
      <rect x="3.5" y="3" width="3.5" height="10" rx="0.75" fill="currentColor" stroke="none" />
      <rect x="9" y="5" width="3.5" height="6" rx="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  alignEdgeBottom: (
    <>
      <path d="M2 13.5h12" />
      <rect x="3.5" y="2.5" width="3.5" height="8.5" rx="0.75" fill="currentColor" stroke="none" />
      <rect x="9" y="5.5" width="3.5" height="5.5" rx="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  distributeH: (
    <>
      <path d="M2.5 2v12M13.5 2v12" />
      <rect x="6.25" y="4" width="3.5" height="8" rx="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  distributeV: (
    <>
      <path d="M2 2.5h12M2 13.5h12" />
      <rect x="4" y="6.25" width="8" height="3.5" rx="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  gap: <path d="M3 3v10M13 3v10M6 8h4M7.5 6.5 6 8l1.5 1.5M8.5 6.5 10 8l-1.5 1.5" />,
  padding: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <rect x="5.75" y="5.75" width="4.5" height="4.5" rx="0.5" />
    </>
  ),
  margin: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" strokeDasharray="1.5 2" />
      <rect x="5.75" y="5.75" width="4.5" height="4.5" rx="0.5" />
    </>
  ),
  radius: <path d="M3.5 13.5V9a5.5 5.5 0 0 1 5.5-5.5h4.5" />,
  opacity: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
    </>
  ),
  check: <path d="m3.5 8.5 3 3 6-7" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4.5V9A1.5 1.5 0 0 0 4 10.5h1.5" />
    </>
  ),
  // Fills, shape tools, text formatting.
  eyedropper: <path d="m9.5 4.5 2 2M10.6 3.4a1.5 1.5 0 0 1 2.1 0l-.1 0a1.5 1.5 0 0 1 0 2.1L11.5 6.7l-2.2-2.2zM9.8 6.2 4.4 11.6c-.4.4-.6.9-.6 1.4l-.3.5.5-.3c.5 0 1-.2 1.4-.6l5.4-5.4" />,
  rectangle: <rect x="2.5" y="3.5" width="11" height="9" rx="1" />,
  ellipse: <ellipse cx="8" cy="8" rx="5.5" ry="4.5" />,
  line: <path d="M2.5 8h11" />,
  bold: <path d="M5 3.5h3.2a2.3 2.3 0 0 1 0 4.5H5zM5 8h3.8a2.3 2.3 0 0 1 0 4.5H5z" />,
  italic: <path d="M6.5 3.5h4.5M5 12.5h4.5M9.5 3.5l-3 9" />,
  underline: <path d="M4.5 3v4.5a3.5 3.5 0 0 0 7 0V3M3.5 13.5h9" />,
  strike: <path d="M3 8h10M10.8 5.2C10.4 4 9.4 3.5 8 3.5c-1.6 0-2.8.7-2.8 2 0 1 .8 1.6 2.8 2.5s3 1.2 3 2.6c0 1.2-1.2 2-3 2-1.5 0-2.6-.6-3-2" />,
  link: <path d="M6.8 9.2a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.7.7M9.2 6.8a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l.7-.7" />,
  historyBack: <path d="M13 8H3.5M7.5 4 3.5 8l4 4" />,
  historyForward: <path d="M3 8h9.5M8.5 4l4 4-4 4" />,
  chevronLeft: <path d="m10 4-4 4 4 4" />,
  expand: <path d="M6 2.5H3.5a1 1 0 0 0-1 1V6M10 2.5h2.5a1 1 0 0 1 1 1V6M6 13.5H3.5a1 1 0 0 1-1-1V10M10 13.5h2.5a1 1 0 0 0 1-1V10" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  file: <path d="M4.5 2.5h4.8l3.2 3.2v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-9.2a1 1 0 0 1 1-1zM9.3 2.5v3.2h3.2M5.5 9h5M5.5 11h3.5" />,
  paperclip: <path d="M13 7.2 7.9 12.3a3.1 3.1 0 0 1-4.4-4.4l5.3-5.3a2.1 2.1 0 0 1 3 3L6.5 10.9a1.1 1.1 0 0 1-1.5-1.5l4.7-4.7" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />,
  arrowUp: <path d="M8 13V3.5M4.5 7 8 3.5 11.5 7" />,
  arrowDown: <path d="M8 3v9.5M4.5 9 8 12.5 11.5 9" />,
  history: <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.8v2.6h2.6M8 5.2V8l1.9 1.2" />,
  // Compact the conversation: two lines pressed together by arrows from above and below.
  compact: <path d="M3 6.5h10M3 9.5h10M8 1.5v3M6.5 3.5 8 5l1.5-1.5M8 14.5v-3M6.5 12.5 8 11l1.5 1.5" />,
  askAgent: <path d="M4 3h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 11H8.2L5.5 13.5V11H4A1.5 1.5 0 0 1 2.5 9.5v-5A1.5 1.5 0 0 1 4 3zM8 5.2v3.1M6.45 6.75h3.1" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2M7 7v4M9 7v4" />,
  // Document components: the main is four diamonds, an instance one diamond around a smaller one.
  component: <path d="M8 2.5 9.75 4.25 8 6 6.25 4.25zM11.75 6.25 13.5 8 11.75 9.75 10 8zM8 10 9.75 11.75 8 13.5 6.25 11.75zM4.25 6.25 6 8 4.25 9.75 2.5 8z" />,
  instance: <path d="M8 2.5 13.5 8 8 13.5 2.5 8zM8 6.25 9.75 8 8 9.75 6.25 8z" />,
  target: <path d="M2.5 8h2.5M11 8h2.5M8 2.5V5M8 11v2.5M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="at-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
