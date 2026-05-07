/**
 * /history/* endpoints — read-only access to ~/.claude/projects/*.
 * All paths are validated against the configured root via path-guard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveSafe, base64UrlDecode, base64UrlEncode, httpError } from './path-guard.js';

export function createHistoryRouter({ root }) {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      switch (url.pathname) {
        case '/history/projects':
          return await listProjects(res, root);
        case '/history/sessions':
          return await listSessions(res, root, url.searchParams);
        case '/history/session':
          return await readSession(req, res, root, url.searchParams);
        case '/history/session-lite':
          return await readSessionLite(res, root, url.searchParams);
        case '/history/project-data':
          return await readProjectData(res, root, url.searchParams);
        // /history/search 二期实现
        default:
          res.writeHead(404).end();
      }
    } catch (e) {
      const status = e.status || 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  };
}

async function listProjects(res, root) {
  if (!fs.existsSync(root)) return sendJSON(res, 200, []);

  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const projects = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    let stat, sessions;
    try {
      stat = await fs.promises.stat(dir);
      sessions = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    projects.push({
      encodedPath: base64UrlEncode(e.name),
      displayPath: e.name.replace(/-/g, '/'),
      mtime: stat.mtimeMs,
      sessionCount: sessions.length,
    });
  }
  projects.sort((a, b) => b.mtime - a.mtime);
  sendJSON(res, 200, projects);
}

async function listSessions(res, root, params) {
  const encoded = params.get('project') || '';
  const projectDir = resolveSafe(root, base64UrlDecode(encoded));
  const limit = clamp(parseInt(params.get('limit') || '50', 10), 1, 500);
  const offset = Math.max(0, parseInt(params.get('offset') || '0', 10));

  let files;
  try {
    files = (await fs.promises.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'));
  } catch (e) {
    if (e.code === 'ENOENT') return sendJSON(res, 200, []);
    throw e;
  }

  const items = [];
  for (const f of files) {
    const full = path.join(projectDir, f);
    try {
      const stat = await fs.promises.stat(full);
      items.push({
        sessionId: f.replace(/\.jsonl$/, ''),
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    } catch {}
  }
  items.sort((a, b) => b.mtime - a.mtime);

  const page = items.slice(offset, offset + limit);
  const enriched = await Promise.all(page.map((it) => enrichSession(projectDir, it)));
  sendJSON(res, 200, enriched);
}

async function enrichSession(projectDir, item) {
  const filePath = path.join(projectDir, `${item.sessionId}.jsonl`);
  let title = '(无标题)';
  let model = '';
  try {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(8192, item.size || 8192));
      await fd.read(buf, 0, buf.length, 0);
      const firstLine = buf.toString('utf8').split('\n')[0];
      const obj = safeJson(firstLine);
      if (obj) {
        title = String(extractText(obj) || obj.summary || obj.title || '(无标题)').slice(0, 100);
        model = obj.model || obj.message?.model || '';
      }
    } finally {
      await fd.close();
    }
  } catch {}
  return {
    sessionId: item.sessionId,
    title,
    startTime: item.mtime,
    lastTurnTime: item.mtime,
    messageCount: -1, // Precise count requires full scan; -1 = "unknown"
    size: item.size,
    model,
  };
}

async function readSession(req, res, root, params) {
  const encoded = params.get('project') || '';
  const projectDir = resolveSafe(root, base64UrlDecode(encoded));
  const sessionId = safeId(params.get('sessionId') || '');
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (e) {
    if (e.code === 'ENOENT') throw httpError(404, 'session not found');
    throw e;
  }

  const range = parseRange(req.headers.range, stat.size);
  const baseHeaders = {
    'Content-Type': 'application/x-ndjson',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };

  if (range) {
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'Content-Length': range.end - range.start + 1,
    });
    fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
  } else {
    res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
  }
}

async function readSessionLite(res, root, params) {
  const encoded = params.get('project') || '';
  const projectDir = resolveSafe(root, base64UrlDecode(encoded));
  const sessionId = safeId(params.get('sessionId') || '');
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);

  let content;
  try {
    content = await fs.promises.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw httpError(404, 'session not found');
    throw e;
  }

  const lines = content.split('\n').filter((l) => l.trim());
  const first = safeJson(lines[0]);
  const last = safeJson(lines[lines.length - 1]);

  sendJSON(res, 200, {
    sessionId,
    title: extractText(first).slice(0, 100),
    firstUserMsg: extractText(first),
    lastAssistantMsg: extractText(last),
    messageCount: lines.length,
  });
}

// ===== helpers =====

function safeJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

function extractText(obj) {
  if (!obj) return '';
  if (typeof obj.message?.content === 'string') return obj.message.content;
  if (Array.isArray(obj.message?.content)) {
    const text = obj.message.content.find((c) => c?.type === 'text' || typeof c?.text === 'string');
    if (text?.text) return text.text;
  }
  if (Array.isArray(obj.content)) {
    const text = obj.content.find((c) => c?.type === 'text' || typeof c?.text === 'string');
    if (text?.text) return text.text;
  }
  if (typeof obj.content === 'string') return obj.content;
  if (typeof obj.text === 'string') return obj.text;
  return '';
}

function safeId(s) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(s)) throw httpError(400, 'invalid sessionId');
  return s;
}

function parseRange(header, size) {
  if (!header) return null;
  const m = header.match(/^bytes=(\d+)-(\d*)$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (start >= size || end >= size || start > end) return null;
  return { start, end };
}

function clamp(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ===== /history/project-data =====

async function readProjectData(res, root, params) {
  const raw = params.get('projectPath') || '';
  if (!raw) throw httpError(400, 'projectPath required');

  const dirName = resolveProjectDirName(raw);
  const projectDir = resolveSafe(root, dirName);

  let files;
  try {
    files = (await fs.promises.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      return sendJSON(res, 200, {
        success: true,
        sessions: [],
        currentProject: dirName,
        total: 0,
        sessionCount: 0,
      });
    }
    throw e;
  }

  const sessions = [];
  for (const f of files) {
    const full = path.join(projectDir, f);
    const info = await scanSession(full);
    if (info) sessions.push(info);
  }

  sessions.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));

  sendJSON(res, 200, {
    success: true,
    sessions,
    currentProject: dirName,
    total: sessions.length,
    sessionCount: sessions.length,
  });
}

/**
 * Auto-detect input format: raw absolute path → claude-encoded dir name,
 * otherwise treat as already-encoded dir name (or base64url).
 */
function resolveProjectDirName(input) {
  // Absolute path → claude convention encode
  if (input.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(input)) {
    return claudeEncode(input);
  }
  // Try base64url decode; if result looks like an absolute path, use encoded form
  try {
    const decoded = base64UrlDecode(input);
    if (decoded.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(decoded)) {
      return claudeEncode(decoded);
    }
  } catch {}
  // Already a dir name like "-Users-foo-bar"
  return input;
}

/** /Users/foo/bar → -Users-foo-bar */
function claudeEncode(absPath) {
  return absPath.replace(/[\/\\:]/g, '-');
}

async function scanSession(filePath) {
  let content;
  try {
    content = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const fileName = path.basename(filePath);
  const sessionId = fileName.replace(/\.jsonl$/, '');

  const lines = content.split('\n');
  const messages = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const obj = safeJson(line);
    if (obj) messages.push(obj);
  }
  if (messages.length === 0) return null;

  let lastTs = 0;
  for (const m of messages) {
    if (m.timestamp) {
      const t = parseTimestamp(m.timestamp);
      if (t > lastTs) lastTs = t;
    }
  }

  const title = generateSummary(messages);
  if (!isValidSession(sessionId, title, messages.length)) return null;

  let fileSize = 0;
  try {
    const st = await fs.promises.stat(filePath);
    fileSize = st.size;
  } catch {}

  return {
    sessionId,
    title,
    messageCount: messages.length,
    lastTimestamp: lastTs,
    firstTimestamp: lastTs,
    fileSize,
  };
}

function generateSummary(messages) {
  for (const msg of messages) {
    if (msg.type === 'user' && !msg.isMeta && msg.message?.content != null) {
      let text = extractTextFromContent(msg.message.content);
      if (text) {
        text = extractCommandMessageContent(text);
        text = sanitizeAndTruncateSingleLine(text, 45);
        if (text) return text;
      }
    }
  }
  return null;
}

function isValidSession(sessionId, summary, messageCount) {
  if (!sessionId || sessionId.startsWith('agent-')) return false;
  if (!summary) return false;
  const lower = summary.toLowerCase();
  if (lower === 'warmup' || lower === 'no prompt'
      || lower.startsWith('warmup') || lower.startsWith('no prompt')) {
    return false;
  }
  return messageCount >= 2;
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      }
    }
    const r = parts.join(' ').trim();
    return r || null;
  }
  return null;
}

/**
 * Mirrors TagExtractor.extractCommandMessageContent: if text contains
 * <command-message>...</command-message>, return that (optionally with args).
 */
function extractCommandMessageContent(text) {
  if (!text) return text;
  const cmdMsg = extractTag(text, 'command-message');
  if (cmdMsg == null) return text;
  const cmdArgs = extractTag(text, 'command-args');
  if (cmdArgs && cmdArgs.trim()) return `${cmdMsg} ${cmdArgs}`.trim();
  return cmdMsg.trim();
}

function extractTag(text, tagName) {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const m = text.match(re);
  return m ? m[1] : null;
}

/**
 * Mirrors TextSanitizer.sanitizeAndTruncateSingleLine: collapse whitespace,
 * trim, truncate to maxLen with ellipsis.
 */
function sanitizeAndTruncateSingleLine(text, maxLen) {
  if (!text) return '';
  let s = text.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + '...';
  return s;
}

function parseTimestamp(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}
