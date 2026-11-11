import { useEffect } from 'react';
import { installTooltips } from './tooltip';

/** Mounts the app's tooltip once (app/tooltip.ts): controls opt in with `data-tip`, not `title`. */
export function Tooltips() {
  useEffect(() => installTooltips(), []);
  return null;
}
