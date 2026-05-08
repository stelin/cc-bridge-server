/**
 * Session manager.
 *
 * A bridge "session" is a stable contract identified by `bridgeSid`. It owns:
 *   - projectPath (locked at creation time)
 *   - an SSE Hub that survives daemon restarts (so Last-Event-ID replay works)
 *   - the captured Claude session id, used to resume the underlying conversation
 *     when the daemon child is recreated
 *   - a daemon child process whose lifetime is decoupled from the bridge sid
 *
 * Lifecycle states:
 *   - 'active'      daemon is running, bridge sid bound to a live child
 *   - 'freezing'    idle reaper sent SIGTERM; waiting for child to exit
 *   - 'frozen'      child exited cleanly via idle reap; sid + hub kept alive
 *                   for transparent reconnect. Will be GC'd after maxFrozenMs.
 *   - 'destroying'  user requested DELETE; waiting for child to exit
 *
 * Reconnect flow: a frozen session is thawed on the next subscribeSse / writeIn
 * by spawning a fresh daemon. If we already captured a Claude session id, we
 * inject it into writeIn payloads so the new daemon resumes the conversation.
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

export function createSessionManager({
  idleTimeoutMs = 60_000,
  maxFrozenMs = 24 * 60 * 60 * 1000,
  store = null,
} = {}) {
  const sessions = new Map(); // sid -> Session

  if (store) {
    // Persisted snapshot only contains the bridge contract — never the live
    // child PID, hub buffer, or subscriber list. Sessions that are mid-shutdown
    // ('destroying') are excluded; everything else is recorded as 'frozen'
    // because after a process restart the child will always be gone.
    store.setSnapshotProvider(() => ({
      version: 1,
      sessions: [...sessions.values()]
        .filter((s) => s.state !== 'destroying')
        .map((s) => ({
          sid: s.sid,
          projectPath: s.projectPath,
          claudeSid: s.claudeSid,
          state: 'frozen',
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
        })),
    }));
  }
  const persist = () => store?.scheduleFlush();

  async function create(req, res) {
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

    if (!projectPath) {
      return sendJSON(res, 400, {
        code: 'PROJECT_PATH_REQUIRED',
        error: 'projectPath is a required field of POST /session',
      });
    }

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

    const sid = crypto.randomUUID();
    const hub = createSseHub({ bufferSize: 1000, tag: sid.slice(0, 8) });
    const session = {
      sid,
      projectPath,
      hub,
      child: null,
      claudeSid: null,
      state: 'active',
      idleTimer: null,
      maxFrozenTimer: null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    sessions.set(sid, session);

    try {
      spawnDaemon(session);
    } catch (e) {
      sessions.delete(sid);
      hub.close();
      logger.error('Failed to spawn daemon', e);
      return sendJSON(res, 500, { code: 'SPAWN_FAILED', error: `spawn failed: ${e.message}` });
    }

    armIdleTimer(session);
    persist();
    logger.info(`session created sid=${sid} pid=${session.child.pid} projectPath=${projectPath}`);
    sendJSON(res, 200, { sessionId: sid, pid: session.child.pid, projectPath });
  }

  function spawnDaemon(s) {
    const child = spawn(process.execPath, [DAEMON_PATH], {
      cwd: s.projectPath,
      env: {
        ...process.env,
        AI_BRIDGE_REMOTE_MODE: '1',
        IDEA_PROJECT_PATH: s.projectPath,
        PROJECT_PATH:      s.projectPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    s.child = child;
    s.state = 'active';
    s.lastActiveAt = Date.now();
    cancelMaxFrozenTimer(s);

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      maybeCaptureClaudeSid(s, trimmed);
      s.hub.publish(trimmed);
    });

    child.stderr.on('data', (d) => {
      const text = d.toString().trimEnd();
      if (text) logger.warn(`[daemon ${s.sid.slice(0, 8)}] ${text}`);
    });

    child.on('exit', (code, signal) => {
      const prevState = s.state;
      logger.info(`daemon exited code=${code} signal=${signal} sid=${s.sid} state=${prevState}`);

      if (prevState === 'freezing') {
        s.state = 'frozen';
        s.child = null;
        cancelIdleTimer(s);
        armMaxFrozenTimer(s);
        persist();
        return;
      }

      if (prevState === 'destroying') {
        s.hub.close();
        sessions.delete(s.sid);
        cancelIdleTimer(s);
        cancelMaxFrozenTimer(s);
        persist();
        return;
      }

      // 'active' state crash — surface as DAEMON_DOWN and tear down the session
      try {
        s.hub.publish(JSON.stringify({
          type: '_ctrl',
          action: 'gateway_error',
          message: `daemon exited code=${code} signal=${signal || 'none'}`,
          code: 'DAEMON_DOWN',
        }));
      } catch {}
      s.hub.close();
      sessions.delete(s.sid);
      cancelIdleTimer(s);
      cancelMaxFrozenTimer(s);
      persist();
    });

    child.on('error', (err) => {
      logger.error(`daemon error sid=${s.sid}`, err);
    });

    return child;
  }

  // Captures the Claude-side conversation id from daemon stdout. Daemon wraps
  // every internal line as {"id":"<reqId>","line":"..."}, so the SESSION_ID
  // tag and the system-init JSON's session_id both arrive embedded in the
  // wrapper. Match the canonical UUID anywhere on the line, anchored to either
  // the "[SESSION_ID]" tag or a "session_id" key (raw or JSON-escaped).
  function maybeCaptureClaudeSid(s, line) {
    const m = line.match(
      /(?:\[SESSION_ID\]|session_id)["\\:\s]+([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})/
    );
    if (!m) return;
    const candidate = m[1];
    if (candidate !== s.claudeSid) {
      const prev = s.claudeSid ? s.claudeSid.slice(0, 8) : '(none)';
      s.claudeSid = candidate;
      logger.info(`claudeSid captured sid=${s.sid.slice(0, 8)} prev=${prev} now=${candidate.slice(0, 8)}`);
      persist();
    }
  }

  function subscribeSse(sid, req, res) {
    const s = sessions.get(sid);
    if (!s) {
      logger.warn(`SSE subscribe rejected: session not found sid=${sid}`);
      return sendJSON(res, 404, { error: 'session not found' });
    }

    if (s.state === 'frozen') {
      try {
        const tag = s.claudeSid ? s.claudeSid.slice(0, 8) : '(none)';
        logger.info(`thawing for SSE subscribe sid=${sid.slice(0, 8)} claudeSid=${tag}`);
        spawnDaemon(s);
      } catch (e) {
        logger.error(`thaw spawn failed sid=${sid.slice(0, 8)}`, e);
        return sendJSON(res, 500, { code: 'THAW_FAILED', error: `thaw failed: ${e.message}` });
      }
    }

    cancelIdleTimer(s);
    s.lastActiveAt = Date.now();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try { res.write(': connected\n\n'); } catch {}

    const lastIdHeader = req.headers['last-event-id'];
    const lastId = lastIdHeader ? parseInt(lastIdHeader, 10) || 0 : 0;
    s.hub.attach(res, lastId);
    logger.info(`SSE subscribed sid=${sid.slice(0, 8)} lastId=${lastId} subs=${s.hub.subscriberCount()}`);

    req.on('close', () => {
      s.hub.detach(res);
      logger.info(`SSE detached sid=${sid.slice(0, 8)} subs=${s.hub.subscriberCount()}`);
      if (sessions.has(sid)) armIdleTimer(s);
    });
  }

  async function writeIn(sid, req, res) {
    const s = sessions.get(sid);
    if (!s) {
      logger.warn(`writeIn rejected: session not found sid=${sid}`);
      return sendJSON(res, 404, { error: 'session not found' });
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

    if (body.includes('\n')) {
      return sendJSON(res, 400, { error: 'body must be a single JSON line' });
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      return sendJSON(res, 400, { error: `invalid JSON: ${e.message}` });
    }

    // Transparently inject the captured Claude sid so a freshly-thawed daemon
    // resumes the same conversation. Honor any client-provided sessionId.
    let injected = false;
    if (s.claudeSid && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const inStdin =
        parsed.stdinData && typeof parsed.stdinData === 'object' && !Array.isArray(parsed.stdinData);
      const hasTopSid = typeof parsed.sessionId === 'string' && parsed.sessionId !== '';
      const hasNestedSid = inStdin && typeof parsed.stdinData.sessionId === 'string' && parsed.stdinData.sessionId !== '';
      if (!hasTopSid && !hasNestedSid) {
        if (inStdin) parsed.stdinData.sessionId = s.claudeSid;
        else parsed.sessionId = s.claudeSid;
        body = JSON.stringify(parsed);
        injected = true;
      }
    }

    if (s.state === 'frozen') {
      try {
        logger.info(`thawing for writeIn sid=${sid.slice(0, 8)}`);
        spawnDaemon(s);
      } catch (e) {
        logger.error(`thaw spawn failed sid=${sid.slice(0, 8)}`, e);
        return sendJSON(res, 500, { code: 'THAW_FAILED', error: `thaw failed: ${e.message}` });
      }
    }

    if (!s.child || s.child.exitCode !== null || s.child.killed) {
      logger.warn(`writeIn rejected: daemon dead sid=${sid.slice(0, 8)}`);
      return sendJSON(res, 410, { error: 'daemon dead' });
    }

    try {
      s.child.stdin.write(body + '\n');
    } catch (e) {
      logger.warn(`stdin write failed sid=${sid.slice(0, 8)}: ${e.message}`);
      return sendJSON(res, 500, { error: `stdin write failed: ${e.message}` });
    }

    s.lastActiveAt = Date.now();

    let preview = body;
    try {
      const m = parsed.method || parsed.action || parsed.type || parsed.command || '?';
      preview = `method=${m}${parsed.id ? ' id=' + String(parsed.id).slice(0, 8) : ''}`;
    } catch {}
    const inj = injected ? ` injected-claudeSid=${s.claudeSid.slice(0, 8)}` : '';
    logger.info(`writeIn sid=${sid.slice(0, 8)} bytes=${body.length} ${preview}${inj}`);
    if (logger.isVerbose()) {
      const full = body.length > 1200 ? body.slice(0, 1200) + `...(${body.length}b)` : body;
      logger.verbose(`writeIn sid=${sid.slice(0, 8)} body=${full}`);
    }
    sendJSON(res, 200, { queued: true });
  }

  function destroy(sid, res) {
    const s = sessions.get(sid);
    if (s) {
      logger.info(`session destroy requested sid=${sid.slice(0, 8)} state=${s.state}`);
      cancelIdleTimer(s);
      cancelMaxFrozenTimer(s);
      if (s.state === 'frozen' || !s.child) {
        s.hub.close();
        sessions.delete(sid);
        persist();
      } else {
        s.state = 'destroying';
        gracefulKill(s.child);
      }
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
        pid: s.child ? s.child.pid : null,
        claudeSessionId: s.claudeSid,
        state: s.state,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        projectPath: s.projectPath || null,
        subscribers: s.hub.subscriberCount(),
        alive: !!(s.child && s.child.exitCode === null && !s.child.killed),
      });
    }
    sendJSON(res, 200, out);
  }

  function armIdleTimer(s) {
    if (s.state !== 'active') return;
    if (idleTimeoutMs <= 0) return;
    if (s.hub.subscriberCount() > 0) return;
    cancelIdleTimer(s);
    s.idleTimer = setTimeout(() => {
      if (s.state !== 'active') return;
      if (s.hub.subscriberCount() > 0) return;
      logger.info(`session ${s.sid} idle ${idleTimeoutMs}ms with no SSE subscriber, freezing`);
      s.state = 'freezing';
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

  function armMaxFrozenTimer(s) {
    cancelMaxFrozenTimer(s);
    if (maxFrozenMs <= 0) return;
    s.maxFrozenTimer = setTimeout(() => {
      if (s.state !== 'frozen') return;
      logger.info(`session ${s.sid} frozen for ${maxFrozenMs}ms with no reconnect, destroying`);
      s.hub.close();
      sessions.delete(s.sid);
      persist();
    }, maxFrozenMs);
    s.maxFrozenTimer.unref?.();
  }

  function cancelMaxFrozenTimer(s) {
    if (s.maxFrozenTimer) {
      clearTimeout(s.maxFrozenTimer);
      s.maxFrozenTimer = null;
    }
  }

  function gracefulKill(child) {
    if (!child) return;
    try { child.kill('SIGTERM'); } catch {}
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 5000);
    t.unref?.();
  }

  function shutdownAll(cb) {
    logger.info(`shutting down ${sessions.size} session(s)`);
    for (const s of sessions.values()) {
      cancelIdleTimer(s);
      cancelMaxFrozenTimer(s);
      if (s.child) gracefulKill(s.child);
    }
    setTimeout(cb, 1000);
  }

  // Rebuild in-memory sessions from persisted records (server startup).
  // Each restored session is born 'frozen' with a fresh empty hub flagged
  // staleForReplay; the daemon respawns lazily on subscribe/write.
  function hydrate(records) {
    if (!Array.isArray(records) || records.length === 0) return { restored: 0, dropped: 0 };
    let restored = 0, dropped = 0;
    const now = Date.now();
    for (const r of records) {
      if (!r || typeof r.sid !== 'string' || typeof r.projectPath !== 'string') {
        dropped++;
        continue;
      }
      try {
        const st = fs.statSync(r.projectPath);
        if (!st.isDirectory()) throw new Error('not a directory');
      } catch (e) {
        logger.warn(`hydrate: drop sid=${r.sid.slice(0, 8)} (projectPath ${r.projectPath}: ${e.message})`);
        dropped++;
        continue;
      }
      // Honor any maxFrozenMs that has already elapsed.
      const lastActiveAt = typeof r.lastActiveAt === 'number' ? r.lastActiveAt : now;
      if (maxFrozenMs > 0 && now - lastActiveAt >= maxFrozenMs) {
        logger.info(`hydrate: drop sid=${r.sid.slice(0, 8)} (exceeded maxFrozenMs)`);
        dropped++;
        continue;
      }
      const hub = createSseHub({ bufferSize: 1000, tag: r.sid.slice(0, 8) });
      hub.markStaleForReplay();
      const session = {
        sid: r.sid,
        projectPath: r.projectPath,
        hub,
        child: null,
        claudeSid: typeof r.claudeSid === 'string' ? r.claudeSid : null,
        state: 'frozen',
        idleTimer: null,
        maxFrozenTimer: null,
        createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
        lastActiveAt,
      };
      sessions.set(session.sid, session);
      // Re-arm the hard-expiry timer for the remaining window.
      if (maxFrozenMs > 0) {
        const remaining = Math.max(1000, maxFrozenMs - (now - lastActiveAt));
        session.maxFrozenTimer = setTimeout(() => {
          if (session.state !== 'frozen') return;
          logger.info(`session ${session.sid} frozen for ${maxFrozenMs}ms with no reconnect, destroying`);
          session.hub.close();
          sessions.delete(session.sid);
          persist();
        }, remaining);
        session.maxFrozenTimer.unref?.();
      }
      restored++;
    }
    logger.info(`hydrate: restored=${restored} dropped=${dropped}`);
    if (dropped > 0) persist();
    return { restored, dropped };
  }

  return { create, subscribeSse, writeIn, destroy, listSessions, shutdownAll, hydrate };
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
