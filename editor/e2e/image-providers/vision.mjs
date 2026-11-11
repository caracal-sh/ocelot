// `vision` provider: Apple Vision foreground masking. It only exists in the Ocelot Mac app;
// the headless host lists it so agents see why it is missing and what to use instead.

import { invalid } from './common.mjs';

export const VISION_DETAIL = 'Apple Vision runs only in the Ocelot Mac app; the headless host removes backgrounds with fal or the omp gateway.';

export function createVisionProvider() {
  const model = {
    id: 'vision:foreground-mask',
    provider: 'vision',
    model: 'foreground-mask',
    label: 'Foreground mask (Apple Vision)',
    capabilities: ['remove_background', 'crop_to_subject'],
    maxN: 1,
    available: false,
    unavailableReason: VISION_DETAIL,
  };
  return {
    id: 'vision',
    label: 'On-device (Apple Vision)',
    async describe() {
      return {
        id: 'vision',
        label: this.label,
        status: 'unavailable',
        detail: VISION_DETAIL,
        setup: 'Use the Ocelot Mac app, or set FAL_KEY',
        models: [model],
      };
    },
    /** Called by the host instead of generating: this provider cannot run here. */
    unavailableError() {
      return invalid(VISION_DETAIL);
    },
    async generate() {
      throw invalid(VISION_DETAIL);
    },
  };
}
