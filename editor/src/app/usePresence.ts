import { useEffect, useState } from 'react';

/**
 * Keeps something mounted while its exit transition runs. `open` drives the CSS (`data-state`), `mounted` says
 * whether to render at all. Flipping `present` back during the exit reverses the transition from where it is.
 */
export function usePresence(present: boolean, exitMs: number): { mounted: boolean; open: boolean } {
  const [mounted, setMounted] = useState(present);
  if (present && !mounted) setMounted(true);
  useEffect(() => {
    if (present || !mounted) return;
    const timer = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(timer);
  }, [present, mounted, exitMs]);
  return { mounted: present || mounted, open: present };
}
