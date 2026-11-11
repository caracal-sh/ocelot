import type { PatternArtboard } from './types';

/** The two sizes every recipe draws: the Desktop and Mobile artboard presets. */
export const DESKTOP = { width: 1440, height: 900 } as const;
export const MOBILE = { width: 375, height: 812 } as const;

export function desktop(name: string, required = true, height: number = DESKTOP.height): PatternArtboard {
  return { name: `${name} — Desktop`, width: DESKTOP.width, height, required };
}

export function mobile(name: string, required = true, height: number = MOBILE.height): PatternArtboard {
  return { name: `${name} — Mobile`, width: MOBILE.width, height, required };
}
