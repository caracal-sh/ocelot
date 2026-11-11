// Shared helpers for headless browser checks (perf, render diff).
// Uses Playwright's Chromium. Set OCELOT_CHROMIUM to use a preinstalled browser binary, or OCELOT_BROWSER=webkit to run in Playwright's
// WebKit (the Mac app's WKWebView engine) where a script supports it.
import { chromium, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

export async function launch() {
  const executablePath = process.env.OCELOT_CHROMIUM || undefined;
  // Inside the ocelot-headless container the container is the sandbox: Docker's default seccomp
  // profile forbids Chromium's user-namespace sandbox, and /dev/shm is small. Set by the image.
  const args = process.env.OCELOT_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
  if (process.env.OCELOT_BROWSER === 'webkit') return webkit.launch();
  return chromium.launch({ executablePath, args });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain' };

/**
 * Serves a directory (the built editor) on a random localhost port.
 *
 * `addPage(html)` serves generated HTML (screenshot pages) from the same server and returns its path; `dropPage(path)` removes it.
 * Generated pages must come from here, not from `page.route(...).fulfill(...)`: a fulfilled response has no remote address, so
 * Chromium's Local Network Access treats the document as public and blocks its sandboxed code frames from fetching the
 * vendored modules on 127.0.0.1 ("Permission was denied for this request to access the `loopback` address space").
 */
export async function serve(root) {
  const pages = new Map();
  let pageSeq = 0;
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const page = pages.get(path);
    if (page !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
      return;
    }
    const file = join(root, path === '/' ? 'index.html' : path);
    try {
      const body = await readFile(file);
      const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' };
      // Code layers load vendored modules from an opaque origin (CORS), like the Mac scheme handler allows.
      if (path.startsWith('/vendor/')) headers['access-control-allow-origin'] = '*';
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    addPage(html) {
      const path = `/__ocelot_page_${++pageSeq}.html`;
      pages.set(path, html);
      return path;
    },
    dropPage: (path) => pages.delete(path),
    close: () => new Promise((r) => server.close(r)),
  };
}
