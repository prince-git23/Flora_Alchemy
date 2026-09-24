// TEMP QA harness (delete before commit) — serves dist/ with the same SPA
// rewrite production uses, and proxies /api to the local backend so browser
// requests are same-origin (no CORS involvement).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('dist');
const PORT = Number(process.argv[2] || 4321);
const API = process.env.QA_API_TARGET || 'http://127.0.0.1:4100';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2' };

http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (urlPath.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const fwd = {};
    for (const h of ['content-type', 'authorization', 'cookie', 'accept']) {
      if (req.headers[h]) fwd[h] = req.headers[h];
    }
    if (!fwd['content-type']) fwd['content-type'] = 'application/json';
    const upstream = await fetch(`${API}${req.url}`, {
      method: req.method,
      headers: fwd,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
    return res.end(Buffer.from(await upstream.arrayBuffer()));
  }

  const filePath = path.join(ROOT, urlPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    return fs.createReadStream(filePath).pipe(res);
  }
  // Missing /assets/* now 404s, matching the Phase 20.0 vercel.json fix.
  if (urlPath.startsWith('/assets/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
}).listen(PORT, () => console.log(`SPA harness on http://127.0.0.1:${PORT} → api ${API}`));
