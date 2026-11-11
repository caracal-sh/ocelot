import { configDefaults, defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Code layers run in a sandboxed iframe with an opaque origin (`Origin: null`), so
 * the vendored libraries must be served with CORS (see render/codeLayer.ts).
 */
function vendorCors(): Plugin {
  const headers = (_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  };
  return {
    name: 'ocelot-vendor-cors',
    configureServer(server) {
      server.middlewares.use('/vendor', headers);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/vendor', headers);
    },
  };
}

export default defineConfig({
  plugins: [react(), vendorCors()],
  // Absolute base: the release build is served from ocelot://app/ by the
  // Swift scheme handler, so /assets/... resolves inside the bundle.
  base: '/',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'safari17',
    sourcemap: true,
    // The editor, and the audience window's player page (present/player.ts).
    rollupOptions: { input: { main: 'index.html', player: 'player.html' } },
  },
  test: {
    // Generates editor/public/vendor on a fresh checkout (code layers import three, gsap and motion from there).
    globalSetup: ['./e2e/vendor-setup.mjs'],
    environment: 'node',
    // Two projects: `unit` (everything that runs in a few seconds) and `slow` (`*.slow.test.mjs`: real browsers, ffmpeg or child
    // processes, 10 to 60 s each). `vitest run --project unit` is the quick loop; plain `vitest run` runs both.
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'e2e/**/*.test.mjs'], exclude: [...configDefaults.exclude, '**/*.slow.test.*'] },
      },
      { extends: true, test: { name: 'slow', include: ['e2e/**/*.slow.test.mjs'] } },
    ],
    // Hermetic: a headless host in a test must never start the developer's real omp (its credential broker and gateway
    // take seconds to start and stop, and touch the user's sign-in). Tests that need omp pass a fake one explicitly.
    // CI has no omp at all, so this also makes local runs behave like CI.
    env: { OCELOT_OMP: '/nonexistent/omp-is-disabled-in-tests' },
  },
});
