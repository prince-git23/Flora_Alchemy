/*
 * Flora Alchemy — responsive audit static server (Phase 20.6.5).
 *
 * Serves frontend/dist with /__audit.js injected as the first child of
 * <head> in every index.html response, and answers SPA paths with
 * index.html so deep links like /admin/staff work without a router server.
 *
 * Usage: node frontend/scripts/responsive-audit/serve.mjs   (env: AUDIT_PORT)
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '../../dist');
const AUDIT_JS = readFileSync(join(__dirname, 'audit.js'), 'utf8');
const PORT = Number(process.env.AUDIT_PORT || 4611);

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`[serve] dist/index.html not found at ${DIST} — run "npm run build" first.`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/__audit.js') {
      send(res, 200, AUDIT_JS, 'text/javascript; charset=utf-8');
      return;
    }

    let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST)) {
      send(res, 403, 'forbidden');
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      file = join(DIST, 'index.html'); // SPA fallback
    }

    let body = readFileSync(file);
    if (file.endsWith('index.html')) {
      let html = body.toString('utf8');
      // First child of <head> — runs before the inline theme script and
      // before any module script, so seeding lands before the app boots.
      html = html.replace(/<head>/i, '<head><script src="/__audit.js"></script>');
      body = Buffer.from(html, 'utf8');
    }

    send(res, 200, body, MIME[extname(file).toLowerCase()] || 'application/octet-stream');
  } catch (err) {
    send(res, 500, String(err && err.stack ? err.stack : err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] ready http://127.0.0.1:${PORT}`);
});
