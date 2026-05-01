#!/usr/bin/env node
/**
 * ai-bridge-server entry point.
 *
 * Wires together:
 *   - GET  /health, /version
 *   - POST /session                       create daemon-backed session
 *   - GET  /session/{id}/events           SSE stream
 *   - POST /session/{id}/in               write line to daemon stdin
 *   - DELETE /session/{id}                kill daemon
 *   - GET  /sessions                      list active sessions (debug)
 *   - GET  /history/*                     read-only access to ~/.claude/projects
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';

import { createSessionManager } from './session-manager.js';
import { createHistoryRouter } from './history-server.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT || '3284', 10);
const HOST = process.env.HOST || '0.0.0.0';
const IDLE_TIMEOUT_MS = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || '60000', 10);
const HISTORY_ROOT = process.env.HISTORY_ROOT || path.join(os.homedir(), '.claude/projects');

const PKG_VERSION = readPackageVersion();
const DAEMON_VERSION = '1.0.0'; // keep in sync with ai-bridge/daemon.js

const sessions = createSessionManager({ idleTimeoutMs: IDLE_TIMEOUT_MS });
const history = createHistoryRouter({ root: HISTORY_ROOT });

const server = http.createServer(async (req, res) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  const startedAt = Date.now();

  // CORS — open by design (deployment is expected to live behind VPN/proxy).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  // Per-request entry / exit logging. SSE responses log entry now and exit on close.
  const remote = req.socket?.remoteAddress || '-';
  logger.info(`[req ${reqId}] ${req.method} ${req.url} from=${remote}`);
  if (logger.isVerbose()) {
    logger.verbose(`[req ${reqId}] headers=${JSON.stringify(req.headers)}`);
  }
  let logged = false;
  const logEnd = (suffix = '') => {
    if (logged) return;
    logged = true;
    const dur = Date.now() - startedAt;
    logger.info(`[req ${reqId}] -> ${res.statusCode || '?'} ${dur}ms${suffix}`);
  };
  res.on('finish', () => logEnd());
  res.on('close',  () => logEnd(' (closed)'));

  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (u.pathname === '/health') {
      return sendJSON(res, 200, { status: 'ok' });
    }
    if (u.pathname === '/version') {
      return sendJSON(res, 200, { version: PKG_VERSION, daemonVersion: DAEMON_VERSION });
    }

    if (u.pathname === '/session' && req.method === 'POST') {
      return sessions.create(req, res);
    }
    if (u.pathname === '/sessions' && req.method === 'GET') {
      return sessions.listSessions(res);
    }

    const m = u.pathname.match(/^\/session\/([a-fA-F0-9-]+)(?:\/(events|in))?$/);
    if (m) {
      const sid = m[1];
      const action = m[2];
      if (!action && req.method === 'DELETE') return sessions.destroy(sid, res);
      if (action === 'events' && req.method === 'GET')  return sessions.subscribeSse(sid, req, res);
      if (action === 'in'     && req.method === 'POST') return sessions.writeIn(sid, req, res);
      res.writeHead(405).end();
      return;
    }

    if (u.pathname.startsWith('/history/')) {
      return history(req, res);
    }

    res.writeHead(404).end();
  } catch (e) {
    logger.error('Unhandled error', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, HOST, () => {
  logger.info(`ai-bridge-server v${PKG_VERSION} listening on http://${HOST}:${PORT}`);
  logger.info(`History root: ${HISTORY_ROOT}`);
  logger.info(`Idle timeout: ${IDLE_TIMEOUT_MS}ms`);
  logger.info(`Verbose logging: ${logger.isVerbose() ? 'ON' : 'off'} (toggle with --verbose / -v / VERBOSE=1)`);
});

// Graceful shutdown
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  server.close(() => logger.info('HTTP server closed'));
  sessions.shutdownAll(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ===== helpers =====

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readPackageVersion() {
  try {
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    return pkg.version || 'dev';
  } catch {
    return 'dev';
  }
}
