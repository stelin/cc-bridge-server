# ai-bridge-server 编码实现文档

> 配套 `DESIGN.md` v3。本文档面向开发者，按步骤说明 ai-bridge-server 的具体编码改造。
>
> **核心思路**：把 `jetbrains-cc-gui/ai-bridge` 整体 copy 到本目录，原地修改 `permission-ipc.js` 和 `daemon.js` 两个文件，**其他业务文件零改动**。再在外层加一个 HTTP/SSE 服务器把 stdin/stdout 暴露成网络协议。

---

## 0. 目标产物

```
ai-bridge-server/
├── DESIGN.md                  ← v3 设计文档
├── IMPL-SERVER.md             ← 本文档
├── IMPL-PLUGIN.md             ← 插件侧改造文档
├── package.json               ← 根包（合并 ai-bridge 依赖 + server 依赖）
├── package-lock.json
├── README.md                  ← 部署/使用说明
├── src/                       ← 【新增】HTTP/SSE 服务层
│   ├── server.js              ← HTTP 入口
│   ├── session-manager.js     ← session 生命周期 + daemon spawn
│   ├── sse-hub.js             ← SSE 推送 + ring buffer + 重连回放
│   ├── history-server.js      ← /history/* 端点
│   ├── path-guard.js          ← 路径白名单
│   └── logger.js              ← 日志
├── ai-bridge/                 ← 【copy 自 jetbrains-cc-gui/ai-bridge】
│   ├── daemon.js              ← 改：stdin 加 _ctrl 路由（单点 ~10 行）
│   ├── permission-ipc.js      ← 重写：文件 IPC → stdio _ctrl IPC
│   ├── permission-handler.js  ← 不动
│   ├── permission-safety.js   ← 不动
│   ├── channel-manager.js     ← 不动
│   ├── read-cc-switch-db.js   ← 不动（容器内若需 cc-switch DB 也读容器内）
│   ├── channels/              ← 不动
│   ├── services/              ← 不动
│   ├── utils/                 ← 不动
│   ├── config/                ← 不动
│   └── package.json           ← 合并到根 package.json，删除
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── scripts/
│   ├── sync-from-upstream.sh  ← 后续从 jetbrains-cc-gui 同步 ai-bridge 更新的脚本
│   └── start.sh
└── test/
    ├── session-manager.test.js
    ├── sse-hub.test.js
    ├── history-server.test.js
    ├── path-guard.test.js
    └── e2e.test.js
```

---

## Step 1：Copy ai-bridge 源码

```bash
cd /Users/stelin/Develop/GolandProject/ai-project/ai-bridge-server

# 整体 copy（保留目录结构）
cp -r ../jetbrains-cc-gui/ai-bridge ./ai-bridge

# 不需要的文件可以删（按需）
rm ai-bridge/.gitignore  # 用根目录的 .gitignore
rm ai-bridge/.npmrc       # 同上

# 把 ai-bridge/package.json 的 dependencies / type 字段合并到根 package.json，
# 然后删除 ai-bridge/package.json 和 package-lock.json
```

**保留目录树**：

| 目录/文件 | 保留 | 备注 |
|---|---|---|
| `daemon.js` | ✅ 改 | 加 `_ctrl` 路由 |
| `permission-ipc.js` | ✅ 重写 | 文件 IPC → stdio IPC |
| `permission-handler.js` | ✅ 不动 | 它只调 permission-ipc 的导出函数，签名不变就零波及 |
| `permission-safety.js` | ✅ 不动 | |
| `channel-manager.js` | ✅ 不动 | |
| `read-cc-switch-db.js` | ✅ 不动 | 容器内若有 cc-switch SQLite 也是容器内读 |
| `channels/` | ✅ 不动 | claude-channel.js / codex-channel.js |
| `services/` | ✅ 不动 | 所有业务逻辑 |
| `utils/` | ✅ 不动 | |
| `config/` | ✅ 不动 | api-config.js 等 |
| `package.json` | ❌ 删 | 合并到根 |
| `package-lock.json` | ❌ 删 | 同上 |

---

## Step 2：改造 `ai-bridge/permission-ipc.js`（核心）

**目标**：把三个文件 IPC 函数（`requestPermissionFromJava` / `requestAskUserQuestionAnswers` / `requestPlanApproval`）改成 stdio 协议，**保持导出签名不变**——上层 `permission-handler.js` 和 `services/claude/permission-mode.js` / `services/codex/codex-event-handler.js` 一行不用动。

### 2.1 完整重写后的文件骨架

```js
// ai-bridge/permission-ipc.js  (重写，约 150 行)
/**
 * Stdio IPC primitives for permission communication with remote client.
 * Replaces the original file-based IPC. Server-side gateway transports
 * these stdout messages over SSE and feeds stdin responses back.
 *
 * Wire format (stdout, server transports as SSE):
 *   {"type":"_ctrl","action":"permission_request","requestId":"...","toolName":"Edit","inputs":{...},"cwd":"..."}
 *   {"type":"_ctrl","action":"ask_user_question_request","requestId":"...","questions":[...],"cwd":"..."}
 *   {"type":"_ctrl","action":"plan_approval_request","requestId":"...","plan":"...","cwd":"..."}
 *
 * Wire format (stdin, server forwards from client POST /session/{id}/in):
 *   {"type":"_ctrl","action":"permission_response","requestId":"...","allow":true}
 *   {"type":"_ctrl","action":"ask_user_question_response","requestId":"...","answers":[...]}
 *   {"type":"_ctrl","action":"plan_approval_response","requestId":"...","approved":true,"editedPlan":null}
 */

// ========== Debug logging ==========
export function debugLog(tag, message, data = null) {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` | Data: ${JSON.stringify(data)}` : '';
  // 注意：不能用 console.log，因为 daemon.js 拦截了 stdout。
  // 用 process.stderr.write，server 会按 stderr 收集到日志。
  process.stderr.write(`[${timestamp}][PERM_DEBUG][${tag}] ${message}${dataStr}\n`);
}

// ========== Constants ==========
export const PERMISSION_TIMEOUT_MS = 300000; // 5 min, 与 Java 侧一致

// ========== Pending requests registry ==========
// requestId → { resolve, reject, timer }
const pending = new Map();

// ========== _ctrl response router ==========
// daemon.js 主循环识别 type==='_ctrl' 后调这个函数
export function handleControlResponse(msg) {
  const p = pending.get(msg.requestId);
  if (!p) {
    debugLog('CTRL_NO_PENDING', `Received response for unknown requestId: ${msg.requestId}`);
    return;
  }
  pending.delete(msg.requestId);
  clearTimeout(p.timer);
  p.resolve(msg);
}

// ========== Helper: send a request and wait for response ==========
function sendRequest(action, payload) {
  const requestId = `${action.split('_')[0]}-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  // ⚠️ 必须用底层 stdout write，daemon.js 已拦截 console.log/process.stdout.write
  // 所以这里要用导出的 _originalStdoutWrite。详见 Step 3。
  const line = JSON.stringify({ type: '_ctrl', action, requestId, ...payload }) + '\n';
  globalThis.__rawStdoutWrite(line);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      debugLog('TIMEOUT', `${action} timeout`, { requestId });
      reject(new Error(`${action} timeout after ${PERMISSION_TIMEOUT_MS}ms`));
    }, PERMISSION_TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timer });
  });
}

// ========== Public API (与原文件签名完全一致) ==========

export async function requestPermissionFromJava(toolName, input) {
  debugLog('REQUEST_START', `Tool: ${toolName}`, { input });
  try {
    const resp = await sendRequest('permission_request', {
      toolName,
      inputs: input,
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    });
    debugLog('RESPONSE_PARSED', `allow=${resp.allow}`);
    return Boolean(resp.allow);
  } catch (e) {
    debugLog('FATAL_ERROR', `requestPermissionFromJava failed: ${e.message}`);
    return false;
  }
}

export async function requestAskUserQuestionAnswers(input) {
  debugLog('ASK_USER_QUESTION_START', 'Requesting answers', { input });
  try {
    const resp = await sendRequest('ask_user_question_request', {
      questions: input.questions || [],
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    });
    debugLog('ASK_USER_QUESTION_RESPONSE', `answers=${JSON.stringify(resp.answers)}`);
    return resp.answers || null;
  } catch (e) {
    debugLog('ASK_USER_QUESTION_ERROR', `failed: ${e.message}`);
    return null;
  }
}

export async function requestPlanApproval(input) {
  debugLog('PLAN_APPROVAL_START', 'Requesting plan approval', { input });
  try {
    const resp = await sendRequest('plan_approval_request', {
      plan: input?.plan || '',
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    });
    debugLog('PLAN_APPROVAL_RESPONSE', `approved=${resp.approved}`);
    return {
      approved: Boolean(resp.approved),
      editedPlan: resp.editedPlan || null,
    };
  } catch (e) {
    debugLog('PLAN_APPROVAL_ERROR', `failed: ${e.message}`);
    return { approved: false, editedPlan: null };
  }
}

// ========== Removed (no longer needed) ==========
// - PERMISSION_DIR  (no file system)
// - SESSION_ID      (per-process daemon, no need for session multiplexing in IPC)
// - mkdirSync / writeFileSync / readFileSync / unlinkSync / existsSync / readdirSync
```

### 2.2 检查上层 import 是否还能用

```bash
grep -rn "from '.*permission-ipc'" ai-bridge --include="*.js"
# 应该看到三处导入：
#   ai-bridge/permission-handler.js       imports requestAskUserQuestionAnswers, requestPermissionFromJava, requestPlanApproval
# 所有签名保持一致 ✅，permission-handler.js 完全不用动。
```

### 2.3 注意点

- **不能用 `console.log` 或 `process.stdout.write`** 直接写 `_ctrl` 消息——daemon.js 在 line 75-78 把这两个 API 都 hook 了用于业务消息封装。必须用 `_originalStdoutWrite`。**通过 daemon.js 暴露 `globalThis.__rawStdoutWrite` 给 permission-ipc 用**（详见 Step 3）。
- **debugLog 也要走 stderr**——避免和业务消息混在 stdout，server 端 stderr 单独收日志，不会推到 SSE 客户端。

---

## Step 3：改造 `ai-bridge/daemon.js`（两处单点改动）

### 3.1 在 stdin 主循环加 `_ctrl` 路由

定位：当前 `daemon.js:436` 处的 `rl.on('line', ...)`。

```js
// 在文件顶部加 import
import { handleControlResponse } from './permission-ipc.js';

// ...

rl.on('line', (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch (e) {
    _originalStderrWrite(`[daemon] Invalid JSON input: ${line.substring(0, 200)}\n`, 'utf8');
    return;
  }

  // 【新增】_ctrl 控制消息路由（permission/ask/plan 响应）
  if (request.type === '_ctrl') {
    handleControlResponse(request);
    return;
  }

  // ↓↓↓ 以下保持原样（heartbeat / abort / 普通命令队列）
  if (request.method === 'heartbeat' || request.method === 'status') {
    processRequest(request);
    return;
  }
  // ... rest unchanged
});
```

### 3.2 暴露 raw stdout write 给 permission-ipc

定位：`daemon.js:75` 附近声明 `_originalStdoutWrite` 后。

```js
const _originalStdoutWrite = process.stdout.write.bind(process.stdout);
const _originalStderrWrite = process.stderr.write.bind(process.stderr);

// 【新增】暴露给 permission-ipc.js（写 _ctrl 消息绕过 daemon 的 stdout 封装）
globalThis.__rawStdoutWrite = (s) => _originalStdoutWrite(s, 'utf8');
```

### 3.3 删除 file IPC 相关启动逻辑（可选清理）

旧 `permission-ipc.js` 启动时会 mkdirSync(`/tmp/claude-permission`) —— 新版没这个副作用，无需清理。容器里 `/tmp/claude-permission` 不会再被创建，干净。

### 3.4 daemon.js 改动量

总计：~10 行（1 行 import + 4 行 _ctrl 分支 + 1 行 globalThis 暴露 + 注释）。**其他 539 行完全不动**。

---

## Step 4：新增 HTTP/SSE 服务层

### 4.1 `src/server.js`（HTTP 入口，~80 行）

```js
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from './session-manager.js';
import { createHistoryRouter } from './history-server.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT || '3284', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || '60000', 10);
const HISTORY_ROOT = path.join(os.homedir(), '.claude/projects');

const sessions = createSessionManager({ idleTimeoutMs: IDLE_TIMEOUT_MS });
const history = createHistoryRouter({ root: HISTORY_ROOT });

const VERSION = process.env.npm_package_version || 'dev';
const DAEMON_VERSION = '1.0.0'; // 与 ai-bridge/daemon.js 内 DAEMON_VERSION 一致

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Last-Event-ID');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }

    if (url.pathname === '/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ version: VERSION, daemonVersion: DAEMON_VERSION }));
    }

    if (url.pathname === '/session' && req.method === 'POST') {
      return sessions.create(req, res);
    }

    const m = url.pathname.match(/^\/session\/([^/]+)(?:\/(events|in))?$/);
    if (m) {
      const [, sid, action] = m;
      if (!action && req.method === 'DELETE') return sessions.destroy(sid, res);
      if (action === 'events' && req.method === 'GET')  return sessions.subscribeSse(sid, req, res);
      if (action === 'in'     && req.method === 'POST') return sessions.writeIn(sid, req, res);
      res.writeHead(405).end();
      return;
    }

    if (url.pathname.startsWith('/history/')) return history(req, res);

    res.writeHead(404).end();
  } catch (e) {
    logger.error('Unhandled error', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`ai-bridge-server listening on :${PORT}`);
  logger.info(`History root: ${HISTORY_ROOT}`);
});

process.on('SIGTERM', () => sessions.shutdownAll(() => process.exit(0)));
process.on('SIGINT',  () => sessions.shutdownAll(() => process.exit(0)));
```

### 4.2 `src/session-manager.js`（~200 行）

关键职责：
- `create(req, res)`：spawn daemon，返回 `{sessionId}`
- `subscribeSse(sid, req, res)`：升级响应为 SSE，attach 到 hub
- `writeIn(sid, req, res)`：读 body，写 daemon stdin
- `destroy(sid, res)`：SIGTERM daemon
- 内部维护 `sessions: Map<sid, Session>`，每个 Session 有 child / hub / idleTimer

```js
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { createSseHub } from './sse-hub.js';
import { logger } from './logger.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DAEMON_PATH = path.resolve(__dirname, '../ai-bridge/daemon.js');

export function createSessionManager({ idleTimeoutMs }) {
  const sessions = new Map();

  function create(req, res) {
    const sid = crypto.randomUUID();
    const child = spawn(process.execPath, [DAEMON_PATH], {
      env: { ...process.env },  // 不需要 CLAUDE_PERMISSION_TRANSPORT，daemon 已写死 stdio
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const hub = createSseHub({ bufferSize: 1000 });
    const session = { sid, child, hub, idleTimer: null };
    sessions.set(sid, session);

    // daemon stdout 按行 → hub
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', line => { if (line.trim()) hub.publish(line); });

    // stderr 仅日志
    child.stderr.on('data', d => logger.warn(`[daemon ${sid.slice(0, 8)}] ${d.toString().trimEnd()}`));

    child.on('exit', code => {
      logger.info(`daemon exited code=${code} sid=${sid}`);
      hub.publish(JSON.stringify({
        type: '_ctrl', action: 'gateway_error',
        message: `daemon exited code=${code}`, code: 'DAEMON_DOWN',
      }));
      hub.close();
      sessions.delete(sid);
    });

    armIdleTimer(session);
    sendJSON(res, 200, { sessionId: sid });
  }

  function subscribeSse(sid, req, res) {
    const s = sessions.get(sid);
    if (!s) return sendJSON(res, 404, { error: 'session not found' });
    cancelIdleTimer(s);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const lastId = parseInt(req.headers['last-event-id'] || '0', 10);
    s.hub.attach(res, lastId);

    req.on('close', () => {
      s.hub.detach(res);
      armIdleTimer(s);
    });
  }

  async function writeIn(sid, req, res) {
    const s = sessions.get(sid);
    if (!s) return sendJSON(res, 404, { error: 'session not found' });
    if (s.child.exitCode !== null) return sendJSON(res, 410, { error: 'daemon dead' });

    let body = '';
    for await (const chunk of req) body += chunk;
    body = body.trim();
    if (!body) return sendJSON(res, 400, { error: 'empty body' });

    try { s.child.stdin.write(body + '\n'); }
    catch (e) { return sendJSON(res, 500, { error: `stdin write failed: ${e.message}` }); }

    sendJSON(res, 200, { queued: true });
  }

  function destroy(sid, res) {
    const s = sessions.get(sid);
    if (s) gracefulKill(s.child);
    sessions.delete(sid);
    sendJSON(res, 200, { closed: true });
  }

  function armIdleTimer(s) {
    if (s.hub.subscriberCount() > 0) return;
    cancelIdleTimer(s);
    s.idleTimer = setTimeout(() => {
      logger.info(`session ${s.sid} idle ${idleTimeoutMs}ms with no SSE, killing`);
      gracefulKill(s.child);
      sessions.delete(s.sid);
    }, idleTimeoutMs);
  }
  function cancelIdleTimer(s) { if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; } }

  function gracefulKill(child) {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref();
  }

  function shutdownAll(cb) {
    for (const s of sessions.values()) gracefulKill(s.child);
    setTimeout(cb, 1000);
  }

  return { create, subscribeSse, writeIn, destroy, shutdownAll };
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
```

### 4.3 `src/sse-hub.js`（~120 行）

```js
export function createSseHub({ bufferSize = 1000 }) {
  const buffer = [];
  let nextId = 1;
  const subscribers = new Set();
  const heartbeat = setInterval(() => {
    for (const res of subscribers) {
      try { res.write(': hb\n\n'); } catch {}
    }
  }, 15_000);
  heartbeat.unref();

  function publish(line) {
    const id = nextId++;
    buffer.push({ id, data: line });
    if (buffer.length > bufferSize) buffer.shift();
    for (const res of subscribers) writeEvent(res, id, line);
  }

  function attach(res, lastEventId) {
    subscribers.add(res);
    if (lastEventId > 0 && buffer.length > 0 && buffer[0].id > lastEventId + 1) {
      // 客户端要回放的事件已超出 buffer，告知丢失
      writeEvent(res, nextId++, JSON.stringify({
        type: '_ctrl', action: 'gateway_error',
        message: 'event buffer exhausted, please reconnect with a new session',
        code: 'BUFFER_LOST',
      }));
      return;
    }
    for (const { id, data } of buffer) {
      if (id > lastEventId) writeEvent(res, id, data);
    }
  }

  function detach(res) {
    subscribers.delete(res);
    try { res.end(); } catch {}
  }

  function close() {
    clearInterval(heartbeat);
    for (const res of subscribers) detach(res);
  }

  function subscriberCount() { return subscribers.size; }

  function writeEvent(res, id, data) {
    try {
      res.write(`id: ${id}\nevent: message\ndata: ${data}\n\n`);
    } catch (e) {
      detach(res);
    }
  }

  return { publish, attach, detach, close, subscriberCount };
}
```

### 4.4 `src/history-server.js`（~250 行）

```js
import fs from 'node:fs';
import path from 'node:path';
import { resolveSafe, base64UrlDecode } from './path-guard.js';

export function createHistoryRouter({ root }) {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      switch (url.pathname) {
        case '/history/projects':     return await listProjects(res, root);
        case '/history/sessions':     return await listSessions(res, root, url.searchParams);
        case '/history/session':      return await readSession(req, res, root, url.searchParams);
        case '/history/session-lite': return await readSessionLite(res, root, url.searchParams);
        // /history/search 二期实现
        default: res.writeHead(404).end();
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
    const stat = await fs.promises.stat(dir);
    const sessions = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.jsonl'));
    projects.push({
      encodedPath: Buffer.from(e.name).toString('base64url'),
      displayPath: e.name.replace(/-/g, '/'),  // Claude 历史目录命名规则
      mtime: stat.mtimeMs,
      sessionCount: sessions.length,
    });
  }
  projects.sort((a, b) => b.mtime - a.mtime);
  sendJSON(res, 200, projects);
}

async function listSessions(res, root, params) {
  const projectDir = resolveSafe(root, base64UrlDecode(params.get('project') || ''));
  const limit = Math.min(parseInt(params.get('limit') || '50', 10), 500);
  const offset = parseInt(params.get('offset') || '0', 10);

  const files = (await fs.promises.readdir(projectDir))
    .filter(f => f.endsWith('.jsonl'));
  const items = [];
  for (const f of files) {
    const stat = await fs.promises.stat(path.join(projectDir, f));
    items.push({ sessionId: f.replace(/\.jsonl$/, ''), mtime: stat.mtimeMs, size: stat.size });
  }
  items.sort((a, b) => b.mtime - a.mtime);

  const page = items.slice(offset, offset + limit);
  // 读首尾几行提取 title / messageCount（轻量解析）
  const enriched = await Promise.all(page.map(it => enrichSession(projectDir, it)));
  sendJSON(res, 200, enriched);
}

async function enrichSession(projectDir, item) {
  const filePath = path.join(projectDir, item.sessionId + '.jsonl');
  // 读首 4KB 提取首条消息作为 title
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(4096);
    await fd.read(buf, 0, buf.length, 0);
    const firstLine = buf.toString('utf8').split('\n')[0];
    let title = '(无标题)';
    let model = '';
    try {
      const obj = JSON.parse(firstLine);
      title = (obj.message?.content?.[0]?.text || obj.content || '(无标题)').slice(0, 100);
      model = obj.model || '';
    } catch {}
    return {
      sessionId: item.sessionId,
      title,
      startTime: item.mtime,
      lastTurnTime: item.mtime,
      messageCount: -1,  // 精确数需扫整文件，列表页不算
      model,
    };
  } finally { await fd.close(); }
}

async function readSession(req, res, root, params) {
  const projectDir = resolveSafe(root, base64UrlDecode(params.get('project') || ''));
  const sessionId = safeId(params.get('sessionId') || '');
  const filePath = path.join(projectDir, sessionId + '.jsonl');
  const stat = await fs.promises.stat(filePath);

  const range = parseRange(req.headers.range, stat.size);
  const headers = {
    'Content-Type': 'application/x-ndjson',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers['Content-Length'] = range.end - range.start + 1;
    res.writeHead(206, headers);
    fs.createReadStream(filePath, range).pipe(res);
  } else {
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  }
}

async function readSessionLite(res, root, params) {
  // 读首/尾两条消息组成 lite 对象
  const projectDir = resolveSafe(root, base64UrlDecode(params.get('project') || ''));
  const sessionId = safeId(params.get('sessionId') || '');
  const filePath = path.join(projectDir, sessionId + '.jsonl');
  const content = await fs.promises.readFile(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
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

function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function extractText(obj) {
  return obj?.message?.content?.[0]?.text || obj?.content || '';
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
  if (start >= size || end >= size || start > end) return null;
  return { start, end };
}

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
```

### 4.5 `src/path-guard.js`（~50 行）

```js
import path from 'node:path';

export function resolveSafe(root, relPath) {
  if (!relPath) throw httpError(400, 'missing path');
  if (relPath.includes('\0')) throw httpError(400, 'invalid path');

  const resolved = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);

  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw httpError(403, 'path escape detected');
  }
  // 拒绝符号链接逃逸（容器内 .claude/projects/ 通常无 symlink；防御性检查）
  // 如果需要严格，可以 fs.realpathSync 后再校验。简化版：禁止 ".."。
  if (relPath.split(path.sep).includes('..')) throw httpError(403, 'parent dir not allowed');

  return resolved;
}

export function base64UrlDecode(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw httpError(400, 'invalid encoded path');
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    throw httpError(400, 'malformed base64url');
  }
}

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
```

### 4.6 `src/logger.js`（~30 行）

```js
const LEVEL = process.env.LOG_LEVEL || 'info';
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, ...args) {
  if (LEVELS[level] < LEVELS[LEVEL]) return;
  const ts = new Date().toISOString();
  console.error(`[${ts}][${level.toUpperCase()}]`, ...args);
}

export const logger = {
  debug: (...a) => log('debug', ...a),
  info:  (...a) => log('info',  ...a),
  warn:  (...a) => log('warn',  ...a),
  error: (...a) => log('error', ...a),
};
```

---

## Step 5：根 `package.json`

```json
{
  "name": "ai-bridge-server",
  "version": "1.0.0",
  "type": "module",
  "main": "src/server.js",
  "bin": { "ai-bridge-server": "src/server.js" },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    // 把 ai-bridge/package.json 里的 dependencies 全合并过来
    // 不需要新增 ws、express、koa 等任何 HTTP 框架，原生 http 够用
  }
}
```

合并方式：

```bash
# 看 ai-bridge/package.json 里的 dependencies
cat ai-bridge/package.json
# 合并到根 package.json，然后
rm ai-bridge/package.json ai-bridge/package-lock.json
npm install
```

---

## Step 6：Dockerfile + docker-compose.yml

### 6.1 `docker/Dockerfile`

```dockerfile
FROM node:20-slim

# 创建非 root 用户（与 host uid 对齐由运行时 --user 控制）
RUN useradd -m -u 1000 devuser

USER devuser
WORKDIR /home/devuser

# 1. 安装 claude CLI（按需）
RUN npm i -g @anthropic-ai/claude-code

# 2. （可选）预装常用 MCP server
# RUN npm i -g @modelcontextprotocol/server-github

# 3. 预放配置文件（构建时复制；运行时也可挂载）
COPY --chown=devuser settings.json /home/devuser/.claude/settings.json
COPY --chown=devuser claude.json   /home/devuser/.claude.json
COPY --chown=devuser codemoss/     /home/devuser/.codemoss/

# 4. 安装 ai-bridge-server
COPY --chown=devuser ../ /opt/ai-bridge-server
WORKDIR /opt/ai-bridge-server
RUN npm ci --omit=dev

EXPOSE 3284
ENV PORT=3284
ENV LOG_LEVEL=info
ENV SESSION_IDLE_TIMEOUT_MS=60000

CMD ["node", "src/server.js"]
```

### 6.2 `docker/docker-compose.yml`

```yaml
version: '3.8'
services:
  ai-bridge-server:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    image: ai-bridge-server:latest
    user: "${UID:-1000}:${GID:-1000}"
    ports:
      - "3284:3284"
    volumes:
      # 必须：项目目录路径完全一致（用户按需修改）
      - ${PROJECT_PATH}:${PROJECT_PATH}
    environment:
      PORT: 3284
      HOME: /home/devuser
      SESSION_IDLE_TIMEOUT_MS: 60000
      LOG_LEVEL: info
    restart: unless-stopped
```

---

## Step 7：测试要点

### 7.1 单元测试

- `path-guard.test.js`：base64url 解码、路径越界、`..` 拒绝、symlink 不在 root 下
- `sse-hub.test.js`：发布/订阅、ring buffer 溢出、`Last-Event-ID` 回放、buffer lost 错误
- `history-server.test.js`：listProjects 排序、Range 切片、sessionId 正则校验

### 7.2 e2e 测试（用 curl + node 脚本）

```bash
# 1. 启动 server
node src/server.js &

# 2. 健康检查
curl http://localhost:3284/health  # → {"status":"ok"}

# 3. 创建 session
SID=$(curl -s -X POST http://localhost:3284/session | jq -r .sessionId)

# 4. 订阅 SSE（后台）
curl -N http://localhost:3284/session/$SID/events &
SSE_PID=$!

# 5. 发命令
curl -s -X POST http://localhost:3284/session/$SID/in \
     -H 'Content-Type: application/json' \
     -d '{"id":"r1","method":"heartbeat"}'
# SSE 应收到：data: {"id":"r2","type":"heartbeat","ts":...}

# 6. 关闭
curl -s -X DELETE http://localhost:3284/session/$SID
kill $SSE_PID
```

### 7.3 联调清单

- [ ] `POST /session` 成功，daemon ready 事件能从 SSE 收到
- [ ] `claude.send` 流式输出能完整收到 thinking / content_delta / tool_use
- [ ] 三通道权限（permission/ask/plan）都能走通：daemon 发 `_ctrl/*_request`，POST `/in` 回 `_ctrl/*_response`
- [ ] SSE 断开后用 `Last-Event-ID` 重连能回放事件
- [ ] idle 60s 无 SSE → daemon 被 kill
- [ ] `/history/projects` 列出 `~/.claude/projects/` 下的目录
- [ ] `/history/session` Range 请求返回正确字节区间
- [ ] path-guard 拒绝 `?project=Li4v` (base64url of "../") → 403
- [ ] daemon 崩溃 → SSE 收到 `gateway_error code=DAEMON_DOWN`

---

## Step 8：upstream 同步策略

未来 jetbrains-cc-gui/ai-bridge 有更新（新增 channel / 修 bug），用脚本同步：

```bash
# scripts/sync-from-upstream.sh
#!/bin/bash
set -e
UPSTREAM=../jetbrains-cc-gui/ai-bridge
LOCAL=./ai-bridge

# 这两个文件本仓库已修改，不能盲目覆盖；用 diff 给出报告
PROTECTED=("daemon.js" "permission-ipc.js")

for f in $(cd $UPSTREAM && find . -type f); do
  if [[ " ${PROTECTED[@]} " =~ " $(basename $f) " ]]; then
    echo "[PROTECTED] $f — 请手工 diff & merge："
    diff -u $LOCAL/$f $UPSTREAM/$f || true
  else
    cp -v $UPSTREAM/$f $LOCAL/$f
  fi
done
```

---

## 总结：本仓库改动量

| 文件 | 类型 | 行数 |
|---|---|---|
| `ai-bridge/` 整体 copy | copy | ~3000（已有，不算新写） |
| `ai-bridge/permission-ipc.js` | 重写 | ~150（替代原 345） |
| `ai-bridge/daemon.js` | 加 ~10 行 | +10 |
| `src/server.js` | 新增 | ~80 |
| `src/session-manager.js` | 新增 | ~200 |
| `src/sse-hub.js` | 新增 | ~120 |
| `src/history-server.js` | 新增 | ~250 |
| `src/path-guard.js` | 新增 | ~50 |
| `src/logger.js` | 新增 | ~30 |
| `docker/Dockerfile` + `docker-compose.yml` | 新增 | ~60 |
| `scripts/sync-from-upstream.sh` | 新增 | ~20 |
| 测试 | 新增 | ~400 |
| **本仓库新写代码合计** | | **~1370** |

业务零改动（channels/services/utils/config/permission-handler 等共 ~3000 行），透明继承 daemon 的全部能力。

---

## 附录 A：会话生命周期增强（2026-05-08）

### A.1 背景

初版实现里 `bridgeSid` 与 daemon 子进程**强绑定**：客户端 SSE 一旦断连超过 `SESSION_IDLE_TIMEOUT_MS`（默认 60s），idle 回收器就会 SIGTERM daemon 并 `sessions.delete(sid)`。客户端用旧 sid 重连时只能拿到 404，原本的对话上下文（`~/.claude/projects/<cwd>/<claudeSid>.jsonl`）虽然还在磁盘上，但 bridge 这一层已经无法把它接回来。表现就是「用一段时间后开始报 404」。

本次增强把 bridgeSid 从「一个活着的子进程」改成**「一条会话契约」**：sid 稳定、daemon 进程可以起起落落、Claude 会话由服务端用 `claudeSid` 自动续接，并支持跨服务进程重启的元数据持久化。

### A.2 会话状态机

```
        create               idle (no subscribers, no writes)
   --------------------> [active] -------------------> [freezing]
          DELETE                                          | child exit
          /session/{sid}                                  v
              |                                       [frozen]
              v                                          | maxFrozenMs 兜底
         [destroying] <--- thaw (subscribe / writeIn) ---|
              | child exit                               | DELETE
              v                                          v
         [removed]                                  [removed]
```

| 状态 | 含义 | child | hub |
|---|---|---|---|
| `active` | daemon 正常运行 | 活 | 活 |
| `freezing` | idle 回收器已 SIGTERM，等 child exit | 死中 | 活 |
| `frozen` | child 已退出，等待客户端重连透明拉起 | `null` | 活（保留 ring buffer + 订阅协议）|
| `destroying` | 用户 DELETE 触发，等 child exit | 死中 | 活但即将关闭 |

`subscribeSse` / `writeIn` 收到 `frozen` 状态时调用 `spawnDaemon(s)` 透明解冻，并把后续 daemon 输出继续灌进同一个 hub——客户端的 EventSource 重连感知不到中间换了 daemon。

### A.3 Claude session id 自动注入

daemon stdout 里有两种格式会带出 Claude 端的 `session_id`：

- 文本行：`[SESSION_ID] <uuid>`
- JSON 行：`{ ..., "session_id": "<uuid>" }` 或 `{ ..., "type":"system", "subtype":"init", "session_id":"<uuid>" }`

服务端的 `maybeCaptureClaudeSid` 抓到后把它存到 `session.claudeSid`。后续 `writeIn` 时如果客户端 payload 里**没有**填 `sessionId`（顶层）或 `stdinData.sessionId`（嵌套），服务端就把 `claudeSid` 注入进去——daemon 那边的 `claude-channel.js` 早已支持把它当 `resumeSessionId`，于是新拉起的 daemon 自动 resume jsonl 续上对话。

> **客户端策略冲突时尊重客户端**：如果 payload 自己带了 `sessionId`，服务端不覆盖。这给了客户端「我就要起新对话」的能力。

### A.4 元数据持久化

`src/session-store.js` 把以下契约字段持久化到 `~/.cc-bridge/sessions.json`（可被 `SESSION_STORE_PATH` 覆盖）：

```json
{
  "version": 1,
  "sessions": [
    {
      "sid": "...",
      "projectPath": "...",
      "claudeSid": "...",
      "state": "frozen",
      "createdAt": 1715170000000,
      "lastActiveAt": 1715170000000
    }
  ]
}
```

**显式不持久化**：`child` PID、hub ring buffer、订阅者集合、定时器。重启后所有还活着的 session 都从 `frozen` 起步，daemon 在客户端重连时按需 spawn。

写入策略：

- 200ms 防抖
- `tmp + rename` 原子换入
- 触发点：`create` / 抓到新 `claudeSid` / `child.exit` 三分支 / `destroy` / `maxFrozenMs` 兜底删除 / 优雅关停 `flush()`

启动时 `server.js` 顶层 `await store.load()`，再调用 `manager.hydrate(records)` 重建 sessions Map：

- `projectPath` 已不可达 → 跳过 + 警告
- `now - lastActiveAt >= maxFrozenMs` → 跳过
- 其它 → 重建为 `frozen`，新建空 hub 标记 `staleForReplay`，按剩余窗口 arm `maxFrozenTimer`

### A.5 客户端契约变更

#### 对插件透明的部分

- `bridgeSid` 持续可用，无需修改重连逻辑。
- SSE 自动重连（EventSource 默认行为）配合服务端的 freeze/thaw 即可恢复对话。
- `claudeSid` 由服务端管理，客户端无需感知。

#### 唯一新增的可见事件：`BUFFER_LOST`

```json
{
  "type": "_ctrl",
  "action": "gateway_error",
  "code": "BUFFER_LOST",
  "message": "gateway restarted, please refresh history"
}
```

- **何时出现**：仅在桥接服务进程被重启过、客户端用旧 `bridgeSid` 重连时。普通的 idle freeze/thaw **不会**触发。
- **含义**：事件流的中间段（重启窗口期内的事件）不可恢复，但会话契约本身仍然可用。
- **建议处理**：
  1. 调 `GET /sessions` 拿到当前 `bridgeSid` 对应的 `claudeSessionId`。
  2. 调 `GET /history/session?project=<encoded>&sessionId=<claudeSessionId>` 把对话历史补回 UI。
  3. 之后照常使用同一个 `bridgeSid` 发消息。
- **与 `DAEMON_DOWN` 的区别**：`DAEMON_DOWN` 表示 session 已销毁（daemon 异常崩溃），客户端**必须**重建 session；`BUFFER_LOST` 表示 sid 仍可用，**只是**事件流出现断档。

### A.6 新环境变量

| 变量 | 默认值 | 含义 |
|---|---|---|
| `SESSION_IDLE_TIMEOUT_MS` | `60000` | 无订阅者多久后 freeze；`<=0` 禁用 freeze |
| `SESSION_MAX_FROZEN_MS` | `86400000`（24h） | frozen 多久后硬销毁；`<=0` 禁用兜底 |
| `SESSION_STORE_PATH` | `~/.cc-bridge/sessions.json` | 元数据持久化文件路径 |

### A.7 `/sessions` 响应字段扩展

调试接口现在多返回三个字段：

```json
{
  "sessionId": "...",
  "pid": 12345,
  "claudeSessionId": "...",
  "state": "active",
  "createdAt": 1715170000000,
  "lastActiveAt": 1715170000000,
  "projectPath": "...",
  "subscribers": 1,
  "alive": true
}
```

`pid` 在 `frozen` 状态下为 `null`、`alive` 为 `false`。

### A.8 已知不覆盖的边界

- **多进程并发**：同一台机器同时运行多个桥接服务进程会抢同一份 `sessions.json`，未加文件锁。文档保证「同机器单实例」。
- **SSE ring buffer 不持久化**：跨进程重启后中间事件不可恢复，依赖客户端走 `BUFFER_LOST` 路径补救。
- **daemon 健康检查**：`active` 状态下 daemon 异常崩溃仍走原 `DAEMON_DOWN` 路径销毁 session，本轮不做自动重启。

### A.9 改动量

| 文件 | 类型 | 行数 |
|---|---|---|
| `src/session-manager.js` | 重写 | ~480（替代原 ~280）|
| `src/session-store.js` | 新增 | ~85 |
| `src/sse-hub.js` | 加 ~25 行 | +25 |
| `src/server.js` | 加 ~14 行 | +14 |
| **本次增强合计** | | **~430（净增）** |
