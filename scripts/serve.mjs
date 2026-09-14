/**
 * Minimal static file server.
 *
 * This app is plain ES modules with no build step, but getDisplayMedia and
 * navigator.storage.persist() both require a secure context — file:// does not
 * qualify, http://localhost does. So the app has to be served, not opened.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from './bridge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
};

export function createServer() {
  const bridge = createBridge();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      // ── mark bridge ──────────────────────────────────────────────────
      // Lets an OS-level hotkey drop a marker while Tradovate has focus.
      if (url.pathname === '/bridge/events' && req.method === 'GET') {
        bridge.subscribe(res);
        return;
      }

      if (url.pathname === '/bridge/mark' && req.method === 'POST') {
        const body = await readBody(req);
        const { status, body: payload } = bridge.handleCommand(body, req.headers);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      if (url.pathname === '/bridge/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ listeners: bridge.clientCount, lastCommandAt: bridge.lastCommandAt }));
        return;
      }

      // ── static files ─────────────────────────────────────────────────
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';

      const filePath = path.join(ROOT, rel);
      // Refuse to serve anything outside the project root.
      if (!filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      const body = await fs.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });

  server.bridge = bridge;
  return server;
}

/** Reads a request body, with a cap so a stray large POST cannot sit in memory. */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function listen(port = 0) {
  return new Promise((resolve) => {
    const server = createServer();
    // 127.0.0.1, never 0.0.0.0: the recordings and the mark bridge stay on this
    // machine and are not reachable from the network.
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT || 5173);
  listen(port).then(({ port: p }) => {
    console.log(`trade journal recorder → http://localhost:${p}`);
    console.log(`global hotkeys post to  → http://localhost:${p}/bridge/mark`);
    console.log('leave this window open while you record; Ctrl+C when you are done.');
  });
}
