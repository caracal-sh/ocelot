import { useLayoutEffect, type RefObject } from 'react';

/** Exit of a floating surface: opacity only, shorter than its enter. */
export const GHOST_EXIT_MS = 100;

/**
 * Popovers and menus are unmounted by their owners the moment they close. This leaves a decorative, inert copy
 * behind that fades out, so the surface does not vanish. The copy carries no test ids, roles or ids, and is
 * skipped where the Web Animations API is missing (jsdom).
 */
export function fadeOutGhost(el: HTMLElement): void {
  if (!el.isConnected || typeof el.animate !== 'function') return;
  const view = el.ownerDocument.defaultView;
  if (!view || view.getComputedStyle(el).visibility === 'hidden') return;
  const rect = el.getBoundingClientRect();
  const ghost = el.cloneNode(true) as HTMLElement;
  for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>('[data-testid], [id], [role], [autofocus]')]) {
    node.removeAttribute('data-testid');
    node.removeAttribute('id');
    node.removeAttribute('role');
    node.removeAttribute('autofocus');
  }
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.classList.add('at-ghost');
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    right: 'auto',
    bottom: 'auto',
    margin: '0',
    translate: 'none', // the rect below already includes a positioning translate (centred surfaces)
    transition: 'none',
    pointerEvents: 'none',
  });
  el.ownerDocument.body.append(ghost);
  const ease = view.getComputedStyle(el.ownerDocument.documentElement).getPropertyValue('--at-ease-out').trim() || 'ease-out';
  const done = () => ghost.remove();
  ghost.animate({ opacity: [1, 0] }, { duration: GHOST_EXIT_MS, easing: ease, fill: 'forwards' }).finished.then(done, done);
}

/** Fades `ref`'s element out (see fadeOutGhost) when the calling component unmounts. */
export function useExitGhost(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el) fadeOutGhost(el);
    };
  }, [ref]);
}
