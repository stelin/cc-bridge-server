/**
 * Session manager: each session maps to one daemon child process plus an
 * SSE event hub. Idle sessions (no SSE subscribers for `idleTimeoutMs`) are
 * automatically reaped to prevent orphan daemons.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { createSseHub } from './sse-hub.js';
import { logger } from './logger.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DAEMON_PATH = path.resolve(__dirname, '../ai-bridge/daemon.js');

export function createSessionManager({ idleTimeoutMs = 60_000 } = {}) {
  const sessions = new Map(); // sid -> Session

  async function create(req, res) {
    // 1. Read body — POST /session now requires { projectPath: "..." }.
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 64 * 1024) {
          return sendJSON(res, 413, { code: 'BODY_TOO_LARGE', error: 'body too large' });
        }
      }
    } catch (e) {
      return sendJSON(res, 400, { code: 'BAD_BODY', error: `read body failed: ${e.message}` });
    }

    let projectPath = null;
    if (body.trim()) {
      try {
        const json = JSON.parse(body);
        if (json && typeof json.projectPath === 'string' && json.projectPath) {
          projectPath = json.projectPath;
        }
      } catch (e) {
        return sendJSON(res, 400, { code: 'BAD_JSON', error: `invalid JSON body: ${e.message}` });
      }
    }

    // 2. projectPath is mandatory — see design §1 rule 9.
    if (!projectPath) {
      return sendJSON(res, 400, {
        code: 'PROJECT_PATH_REQUIRED',
        error: 'projectPath is a required field of POST /session',
      });
    }

    // 3. The path must be reachable from the server process.
    try {
      const st = fs.statSync(projectPath);
      if (!st.isDirectory()) throw new Error('not a directory');
    } catch (e) {
      logger.warn(`POST /session rejected: projectPath not accessible: ${projectPath} (${e.message})`);
      return sendJSON(res, 400, {
        code: 'PROJECT_PATH_NOT_ACCESSIBLE',
        error: `projectPath not accessible on server: ${projectPath}`,
        projectPath,
      });
    }

    // 4. Spawn the daemon with cwd + env bound to the project path.
    const sid = crypto.randomUUID();
    let child;
    try {
      child = spawn(process.execPath, [DAEMON_PATH], {
        cwd: projectPath,
        env: {
          ...process.env,
          AI_BRIDGE_REMOTE_MODE: '1',
          IDEA_PROJECT_PATH: projectPath,
          PROJECT_PATH:      projectPath,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      logger.error('Failed to spawn daemon', e);
      return sendJSON(res, 500, { code: 'SPAWN_FAILED', error: `spawn failed: ${e.message}` });
    }

    const hub = createSseHub({ bufferSize: 1000, tag: sid.slice(0, 8) });
    const session = { sid, child, hub, idleTimer: null, createdAt: Date.now(), projectPath };
    sessions.set(sid, session);

    // daemon stdout -> hub (one event per line)
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed) hub.publish(trimmed);
    });

    // stderr -> server log only (never leaked to clients)
    child.stderr.on('data', (d) => {
      const text = d.toString().trimEnd();
      if (text) logger.warn(`[daemon ${sid.slice(0, 8)}] ${text}`);
    });

    child.on('exit', (code, signal) => {
      logger.info(`daemon exited code=${code} signal=${signal} sid=${sid}`);
      // Last gasp event so any subscribers reconnect/close gracefully.
      try {
        hub.publish(JSON.stringify({
          type: '_ctrl',
          action: 'gateway_error',
          message: `daemon exited code=${code} signal=${signal || 'none'}`,
          code: 'DAEMON_DOWN',
        }));
      } catch {}
      hub.close();
      sessions.delete(sid);
    });

    child.on('error', (err) => {
      logger.error(`daemon error sid=${sid}`, err);
    });

    armIdleTimer(session);
    logger.info(`session created sid=${sid} pid=${child.pid} projectPath=${projectPath}`);
    sendJSON(res, 200, { sessionId: sid, pid: child.pid, projectPath });
  }

  function subscribeSse(sid, req, res) {
    const s = sessions.get(sid);
    if (!s) {
      logger.warn(`SSE subscribe rejected: session not found sid=${sid}`);
      return sendJSON(res, 404, { error: 'session not found' });
    }
    cancelIdleTimer(s);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Initial comment so the client opens the stream eagerly.
    try { res.write(': connected\n\n'); } catch {}

    const lastIdHeader = req.headers['last-event-id'];
    const lastId = lastIdHeader ? parseInt(lastIdHeader, 10) || 0 : 0;
    s.hub.attach(res, lastId);
    logger.info(`SSE subscribed sid=${sid.slice(0, 8)} lastId=${lastId} subs=${s.hub.subscriberCount()}`);

    req.on('close', () => {
      s.hub.detach(res);
      logger.info(`SSE detached sid=${sid.slice(0, 8)} subs=${s.hub.subscriberCount()}`);
      // If session still exists (daemon alive) and no other subscribers, arm
      // idle timer.
      if (sessions.has(sid)) armIdleTimer(s);
    });
  }

  async function writeIn(sid, req, res) {
    const s = sessions.get(sid);
    if (!s) {
      logger.warn(`writeIn rejected: session not found sid=${sid}`);
      return sendJSON(res, 404, { error: 'session not found' });
    }
    if (s.child.exitCode !== null || s.child.killed) {
      logger.warn(`writeIn rejected: daemon dead sid=${sid.slice(0, 8)}`);
      return sendJSON(res, 410, { error: 'daemon dead' });
    }

    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 10 * 1024 * 1024) {
          return sendJSON(res, 413, { error: 'body too large' });
        }
      }
    } catch (e) {
      return sendJSON(res, 400, { error: `read body failed: ${e.message}` });
    }
    body = body.trim();
    if (!body) return sendJSON(res, 400, { error: 'empty body' });

    // Validate single-line JSON. Reject multi-line bodies so we never write
    // multiple commands on one stdin write.
    if (body.includes('\n')) {
      return sendJSON(res, 400, { error: 'body must be a single JSON line' });
    }
    try {
      JSON.parse(body);
    } catch (e) {
      return sendJSON(res, 400, { error: `invalid JSON: ${e.message}` });
    }

    try {
      s.child.stdin.write(body + '\n');
    } catch (e) {
      logger.warn(`stdin write failed sid=${sid.slice(0, 8)}: ${e.message}`);
      return sendJSON(res, 500, { error: `stdin write failed: ${e.message}` });
    }
    let preview = body;
    try {
      const parsed = JSON.parse(body);
      const m = parsed.method || parsed.action || parsed.type || '?';
      preview = `method=${m}${parsed.id ? ' id=' + String(parsed.id).slice(0, 8) : ''}`;
    } catch {}
    logger.info(`writeIn sid=${sid.slice(0, 8)} bytes=${body.length} ${preview}`);
    if (logger.isVerbose()) {
      const full = body.length > 1200 ? body.slice(0, 1200) + `...(${body.length}b)` : body;
      logger.verbose(`writeIn sid=${sid.slice(0, 8)} body=${full}`);
    }
    sendJSON(res, 200, { queued: true });
  }

  function destroy(sid, res) {
    const s = sessions.get(sid);
    if (s) {
      logger.info(`session destroy requested sid=${sid.slice(0, 8)}`);
      gracefulKill(s.child);
      // Hub close happens on child 'exit'.
    } else {
      logger.warn(`session destroy: not found sid=${sid}`);
    }
    sendJSON(res, 200, { closed: true });
  }

  function listSessions(res) {
    const out = [];
    for (const [sid, s] of sessions) {
      out.push({
        sessionId: sid,
        pid: s.child.pid,
        createdAt: s.createdAt,
        projectPath: s.projectPath || null,
        subscribers: s.hub.subscriberCount(),
        alive: s.child.exitCode === null && !s.child.killed,
      });
    }
    sendJSON(res, 200, out);
  }

  function armIdleTimer(s) {
    if (s.hub.subscriberCount() > 0) return;
    cancelIdleTimer(s);
    s.idleTimer = setTimeout(() => {
      logger.info(`session ${s.sid} idle ${idleTimeoutMs}ms with no SSE subscriber, killing`);
      gracefulKill(s.child);
    }, idleTimeoutMs);
    s.idleTimer.unref?.();
  }

  function cancelIdleTimer(s) {
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
    }
  }

  function gracefulKill(child) {
    try { child.kill('SIGTERM'); } catch {}
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 5000);
    t.unref?.();
  }

  function shutdownAll(cb) {
    logger.info(`shutting down ${sessions.size} session(s)`);
    for (const s of sessions.values()) gracefulKill(s.child);
    setTimeout(cb, 1000);
  }

  return { create, subscribeSse, writeIn, destroy, listSessions, shutdownAll };
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
