import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app', 'src', 'main', 'assets', 'www');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
const upstreams = { site: 'https://ipkey.vip', model: 'https://api.ipkey.vip' };
const forwardHeaders = ['accept', 'accept-language', 'authorization', 'content-type', 'x-user-ui-request'];

export function createPreviewServer() {
  return http.createServer(async (req, res) => {
    const host = req.headers.host;
    if (!/^127\.0\.0\.1:\d+$/.test(host || '')) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { res.writeHead(400).end(); return; }
    if (url.pathname.startsWith('/__proxy/')) {
      const match = url.pathname.match(/^\/__proxy\/(site|model)(\/.*)$/);
      const publicStatus = match && match[1] === 'site' && match[2] === '/api/public/channel-status';
      const allowed = match && (match[1] === 'site' ? match[2].startsWith('/api/v1/') || publicStatus : match[2].startsWith('/v1/'));
      if (!allowed || req.headers['x-pp-preview'] !== '1' ||
          (publicStatus && req.method !== 'GET') ||
          !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ||
          (req.headers.origin && req.headers.origin !== `http://${host}`) ||
          (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const headers = {};
      for (const name of forwardHeaders) if (req.headers[name]) headers[name] = req.headers[name];
      const upstreamUrl = new URL(match[2] + url.search, upstreams[match[1]]);
      if (!(match[1] === 'site' ? upstreamUrl.pathname.startsWith('/api/v1/') || upstreamUrl.pathname === '/api/public/channel-status' : upstreamUrl.pathname.startsWith('/v1/'))) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const options = { method: req.method, headers, redirect: 'manual' };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        options.body = Readable.toWeb(req);
        options.duplex = 'half';
      }
      try {
        const upstream = await fetch(upstreamUrl, options);
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
        if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
        else res.end();
      } catch {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'UPSTREAM_ERROR', message: '无法连接 Pp API' }));
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
    catch { res.writeHead(400).end(); return; }
    const filename = path.resolve(root, '.' + pathname);
    if (!filename.startsWith(root + path.sep) || !types[path.extname(filename)]) {
      res.writeHead(404).end();
      return;
    }
    fs.stat(filename, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': types[path.extname(filename)], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(filename).pipe(res);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PP_PREVIEW_PORT || 8798);
  createPreviewServer().listen(port, '127.0.0.1', () => console.log(`Pp API preview: http://127.0.0.1:${port}/`));
}
