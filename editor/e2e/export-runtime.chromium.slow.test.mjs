// The frame runtime contract in Chromium; the same suite runs in WebKit from its own file (a file is one worker, so the two engines run side by side).
import { exportRuntimeSuite } from './export-runtime.suite.mjs';

exportRuntimeSuite('chromium');
