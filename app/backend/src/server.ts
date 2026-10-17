// Entry point: API on :5590. With SERVE_TEST_UI=1 it also serves frontend/index.html at "/".
import http from 'node:http';
import fs from 'node:fs';
import { config } from './config.js';
import { store } from './db.js';
import { log } from './log.js';
import { createHandler } from './routes.js';
import { MockBackend } from './tools.js';

const api = createHandler({ catalogPath: config.catalogPath, backend: new MockBackend(config.catalogPath), modelUrl: config.modelUrl });

const server = http.createServer((req, res) => {
  if (config.serveTestUi && req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(config.testUiPath, (err, html) => {
      if (err) res.writeHead(404).end('test UI not found at frontend/index.html');
      else res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    });
    return;
  }
  api(req, res);
});

server.listen(config.port, config.host, () => {
  log('info', 'listening', { port: config.port, model: config.model, modelUrl: config.modelUrl, origins: config.allowedOrigins });
});

function shutdown(signal: string) {
  log('info', 'shutting down', { signal });
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
