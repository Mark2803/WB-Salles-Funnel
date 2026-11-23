// HTTP-сервер: страница инструмента (папка public) и JSON API для неё.
// Работает за nginx: снаружи https://tea-master-team.ru/management/wb-funnel/ → http://127.0.0.1:3300/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, checkConfig, ROOT_DIR } from './config.mjs';
import { openDb, ensureProducts } from './db.mjs';
import { createApi } from './api.mjs';
import { startScheduler } from './sync.mjs';

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

export function createServer({ db, cfg = config, log = console, verifyToken }) {
  const api = createApi({ db, cfg, log, verifyToken });
  return http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      return serveStatic(url.pathname, res, req);
    } catch (err) {
      log.error?.(`[server] ${req.method} ${url.pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } }));
    }
  });

  function serveStatic(pathname, res) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!rel) rel = 'index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }
}

// Запуск как программы
if (import.meta.url === `file://${process.argv[1]}`) {
  const { errors, warnings } = checkConfig();
  for (const w of warnings) console.warn(`Предупреждение: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`Ошибка настройки: ${e}`);
    process.exit(1);
  }
  const db = openDb(config.dataDir);
  ensureProducts(db, config.trackedNmIds);
  const server = createServer({ db });
  server.listen(config.port, config.host, () => {
    console.log(`WB воронка запущена: http://${config.host}:${config.port} (артикулов: ${config.trackedNmIds.length}${config.mock ? ', ТЕСТОВЫЙ РЕЖИМ' : ''})`);
  });
  startScheduler(db);
  const stop = () => {
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
