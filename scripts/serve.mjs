/**
 * Static file server for the production build, used by the browser tests and
 * for local checks. It serves `dist/` under a repository-style path, as GitHub
 * Pages does for a project site, so that path handling is tested as deployed.
 * It listens on the loopback interface only, answers 400 to a request whose
 * target cannot be parsed or decoded, and serves only files inside the folder.
 *
 *   node scripts/serve.mjs [--port 4173] [--base /isa-trace-lab/] [--dir dist]
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(opt('port', '4173'));
const base = opt('base', '/isa-trace-lab/');
const root = resolve(opt('dir', 'dist'));
// A file is inside the folder only if its path continues the folder's path after a separator.
const rootPrefix = root.endsWith(sep) ? root : root + sep;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

createServer((req, res) => {
  let url;
  let rel;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
    rel = url.pathname.startsWith(base) ? decodeURIComponent(url.pathname.slice(base.length)) || 'index.html' : '';
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad request');
    return;
  }
  if (url.pathname === base.replace(/\/$/, '')) {
    res.writeHead(301, { Location: base });
    res.end();
    return;
  }
  if (!url.pathname.startsWith(base)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const file = normalize(join(root, rel));
  if (!file.startsWith(rootPrefix) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} at http://localhost:${port}${base}`);
});
