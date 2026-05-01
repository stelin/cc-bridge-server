# ai-bridge-server 设计方案 v3

> 远程化 jetbrains-cc-gui 插件 daemon：在 docker 容器内运行 daemon.js，**全程通过 HTTP 通信**——客户端 → 服务端用 POST 发请求与控制响应，服务端 → 客户端用 SSE 推流式输出与控制请求；历史会话也走 HTTP。
>
> v3 变更：**取消 WebSocket，统一 HTTP + SSE**；其余设计（部署拓扑、三通道权限 IPC、远程模式功能降级、HTTP `/history/*`）延续 v2。

---

## 0. 适用场景与前置约束（必读）

本方案**只在以下部署拓扑下成立**，偏离此拓扑请见 §12 后续扩展。

```
┌─────────────────────────┐         ┌──────────────────────────────────┐
│  Host (用户机)          │         │  Docker 容器                     │
│                         │         │                                  │
│  IDE + 插件             │         │  ai-bridge-server                │
│                         │         │  └─ HTTP（POST + SSE）→ daemon.js│
│  /Users/x/myproj  ──────┼─bind────┼──→ /Users/x/myproj              │
│  (项目代码 host 编辑)   │  mount  │  (路径完全一致，daemon 直接读写)│
│                         │         │                                  │
│                         │         │  ~/.claude/        (容器独立)    │
│                         │         │  ~/.codemoss/      (容器独立)    │
│                         │         │  /tmp/             (容器独立)    │
└─────────────────────────┘         └──────────────────────────────────┘
        ↑                                     ↑
        │           HTTP http://host:3284/    │
        │             /session/{id}/events    │  ← SSE 服务端推
        │             /session/{id}/in        │  ← POST 客户端发
        │             /history/*              │  ← GET 历史
        │             /health, /version       │
        └─────────────────────────────────────┘
```

**前置约束**：

1. **项目目录路径一致** —— host 与容器路径必须完全相同（`-v /Users/x/proj:/Users/x/proj`）
2. **`~/.claude` 与 `~/.codemoss` 不挂载** —— 容器独立维护用户配置
3. **容器镜像必须预配** —— API key、MCP、Skills、Provider（详见 §8）
4. **`os.homedir()` 在容器内闭环** —— daemon 内所有 `~` 解析基于容器 HOME
5. **uid 对齐** —— `docker run --user $(id -u):$(id -g)`，避免 mount 文件权限问题

---

## 1. 目标与非目标

### 1.1 目标

远程模式下"核心编码功能"完整可用，与本地模式体验等价：

- 主对话流（thinking / content_delta / tool_use / usage）
- Tool execution：Read / Edit / Write / Glob / Grep / Bash 在项目文件上
- Permission / AskUserQuestion / Plan approval 审批弹窗
- 历史会话面板：列表 / 查看 / Resume
- MCP 工具调用（容器内预装）
- Codex provider（与 Claude 走同一通道）

### 1.2 非目标（远程模式下不支持）

| 功能 | 远程模式下表现 | 说明 |
|---|---|---|
| Settings UI 编辑 API key / base URL | 灰态 + 提示 | 容器预配 `~/.claude/settings.json` |
| MCP 服务器管理面板 | 灰态 + 提示 | 容器预配 `~/.claude.json` |
| Skills 管理面板 | 灰态 + 提示 | 容器预配 `~/.codemoss/skills/` |
| Provider 管理面板 | 灰态 + 提示 | 容器预配 `~/.codemoss/config.json` |
| Checkpoint / Rewind | 按钮禁用 | 容器内 `~/.claude/checkpoints/` host 不可见 |
| 跨会话用量聚合统计 | 仅展示当前会话用量 | 不聚合历史 |
| 文件附件 / 图片粘贴 | 隐藏附件按钮（一期） | 二期通过 /upload 加 |

### 1.3 显式不做

- 认证 / 鉴权（部署侧用 nginx/caddy / VPN）
- TLS（同上）
- 多用户隔离（单用户假设）
- 高可用 / 集群
- 跨机器（非 docker / 不 mount 项目）远程模式 —— 见 §12

---

## 2. 总体架构

### 2.1 本地模式（不变）

```
┌─────────────────┐  spawn   ┌─────────────────┐
│ JetBrains 插件  │ ───────► │   daemon.js     │
│  LocalBridge    │  stdio   │ (Node.js + SDK) │
│  (NDJSON r/w)   │ ◄──────► │                 │
└─────────────────┘          └─────────────────┘
                              File IPC: ~/.claude/permissions/
                              ◄──────► permission-handler.js
```

### 2.2 远程模式（HTTP + SSE 单一通道）

```
┌─────────────────────┐                          ┌──────────────────────────────┐
│  JetBrains 插件     │                          │  Docker 容器                 │
│                     │                          │  ┌────────────────────────┐  │
│  ┌─ IBridge ─────┐  │ POST /session            │  │  ai-bridge-server      │  │
│  │ LocalBridge   │  │ ──────────────────────►  │  │  ┌──────────────────┐  │  │
│  │ RemoteBridge ─┼──┤ GET  /session/{id}/events│  │  │ session-manager  │  │  │
│  └───────────────┘  │ ◄═════ SSE stream ═════  │  │  │ + sse-hub        │  │  │
│                     │                          │  │  └────┬─────────────┘  │  │
│                     │ POST /session/{id}/in    │  │       │ spawn          │  │
│                     │ ──────────────────────►  │  │       ▼ stdio          │  │
│  ┌─ HistoryDS ───┐  │ DELETE /session/{id}     │  │  ┌──────────────────┐  │  │
│  │ LocalDS       │  │                          │  │  │  daemon.js       │  │  │
│  │ RemoteDS ─────┼──┤ GET  /history/*          │  │  │  (env=stdio IPC) │  │  │
│  └───────────────┘  │                          │  │  └──────────────────┘  │  │
│                     │                          │  │                        │  │
│  RemoteMode 全局开关│                          │  │  history-server        │  │
│  灰态: settings/    │                          │  │  → ~/.claude/projects/ │  │
│  mcp/skills/...     │                          │  └────────────────────────┘  │
└─────────────────────┘                          └──────────────────────────────┘
```

### 2.3 关键设计决策

| 决策 | 方案 | 理由 |
|---|---|---|
| 主对话 transport | **HTTP POST（client→server）+ SSE（server→client）** | 简单、标准、curl 可调；nginx/反代友好；与 history API 风格统一；Java HttpClient 原生支持 |
| 历史读取 transport | HTTP GET `/history/*` | 同上 |
| Permission/Ask/Plan IPC | stdio `_ctrl` 三通道（替代文件 IPC） | 跨进程边界稳定；通过 SSE/POST 透传，与正常请求/响应同通道 |
| daemon 子进程模型 | 一个 session = 一个 daemon | 隔离；session 关闭/idle 超时 → daemon 清理 |
| Session 恢复 | SSE 内建 `Last-Event-ID` 重连 + 服务端 ring buffer | 网络抖动期间 daemon 不死，事件不丢 |
| 配置类管理 UI | 容器预配 + 远程模式 UI 灰态 | `~/.claude` 不挂载，无需配置上行通道 |
| 项目文件访问 | bind mount 路径一致 | daemon 与 host IDE 透明共享 |
| 心跳 | HTTP keepalive + SSE 注释心跳 + daemon heartbeat 三层 | 网络断 / SSE 断 / daemon 死分别检测 |

### 2.4 为什么不用 WebSocket（设计变更说明）

v2 用 WS，v3 改 HTTP+SSE。理由：

| 维度 | WebSocket | HTTP + SSE |
|---|---|---|
| 协议复杂度 | 需 ws 库（server 端 + Java 端） | 标准 HTTP，server 用原生 http，Java 用原生 HttpClient |
| 调试 | 需要 wscat / 浏览器 DevTools | curl 直接验所有端点 |
| 反向代理 | nginx 需 `proxy_http_version 1.1` + `Upgrade` 头 | nginx 默认基本可用，仅需 `proxy_buffering off` |
| 重连语义 | 自实现指数退避 | SSE 内建 `Last-Event-ID` |
| 与 history API 一致性 | 双协议 | 单协议 |
| 监控 / 日志 | 自建指标 | 标准 access log 即可 |
| 序列化 | 文本/二进制 frame | 文本流（daemon 输出本就是 JSON 文本） |
| 双向语义 | 一条连接双向 | 两条单向：SSE 收 + POST 发（语义更清晰） |

唯一损失：建立连接的开销稍高（POST 不复用 SSE 连接）。在我们这个场景下可忽略。

---

## 3. 协议设计

### 3.1 Session 模型

一个 session = 一个 daemon 子进程 = 一条逻辑会话上下文。

| Step | Endpoint | 说明 |
|---|---|---|
| 1. 创建 | `POST /session` | server spawn daemon；返回 `{sessionId}` |
| 2. 订阅事件 | `GET /session/{id}/events` (SSE) | 拿 daemon 所有 stdout 输出 |
| 3. 发请求 | `POST /session/{id}/in` | body 一行 JSON，server 写到 daemon stdin |
| 4. 关闭 | `DELETE /session/{id}` | SIGTERM daemon，清理 buffer |
| 5. 续期 | (隐式) SSE 连接活着即续期 | idle > 60s 无 SSE 连接 → 服务端自动 kill daemon |

**单 IDE 实例 = 单 session**。多 IDE 同时连同一容器 → 多 session 互相隔离。

### 3.2 SSE 事件流（Server → Client）

`GET /session/{id}/events` 响应：

```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no            (反代必备)
Connection: keep-alive
```

每个 daemon stdout 行变成一个 SSE event：

```
id: 42
event: message
data: {"type":"daemon","event":"ready","pid":12345,"sdkPreloaded":true}

id: 43
event: message
data: {"id":"r1","line":"[CONTENT_DELTA] \"Hello\""}

id: 44
event: message
data: {"id":"r1","done":true,"success":true}

id: 45
event: message
data: {"type":"_ctrl","action":"permission_request","requestId":"p-42","toolName":"Edit","inputs":{...},"cwd":"/Users/x/proj"}
```

特殊事件：

```
event: heartbeat            ← server 每 15s 发一次空 comment 行 ":"，保活
data: 

event: gateway-error        ← daemon 异常退出/无法启动
data: {"message":"daemon exited code=1","code":"DAEMON_DOWN"}
```

**重连**：客户端断线后重连时附 `Last-Event-ID: 44`，server 回放 buffer 中 id > 44 的事件。

### 3.3 `POST /session/{id}/in`（Client → Server）

请求 body：一条 JSON（不需要换行符，server 写 stdin 时补 `\n`）

```http
POST /session/abc123/in HTTP/1.1
Content-Type: application/json

{"id":"r1","method":"claude.send","params":{...}}
```

响应：`200 OK {"queued":true}`（仅表示已写入 stdin，不等 daemon 响应）

**所有客户端 → 服务端的消息都走这个端点**，包括：

| 用途 | body |
|---|---|
| 普通请求 | `{"id":"r1","method":"claude.send","params":{...}}` |
| 心跳 | `{"id":"r2","method":"heartbeat"}` |
| 中止 | `{"id":"r3","method":"abort"}` |
| 关闭 daemon | `{"id":"r4","method":"shutdown"}` |
| 权限响应 | `{"type":"_ctrl","action":"permission_response","requestId":"p-42","allow":true}` |
| AskUser 响应 | `{"type":"_ctrl","action":"ask_user_question_response","requestId":"q-7","answers":[...]}` |
| Plan 响应 | `{"type":"_ctrl","action":"plan_approval_response","requestId":"plan-3","approved":true}` |

server 端 `/in` 是个**纯透传管道**：把 body 序列化成一行写入 daemon stdin，不解析、不路由。

### 3.4 三通道 stdio Permission IPC（与 v2 一致，仅传输层变化）

**当前本地实现（File IPC）**：

| 通道 | 文件名模式 |
|---|---|
| Permission | `request-{sid}-{rid}.json` ↔ `response-...json` |
| AskUserQuestion | `ask-user-question-{sid}-{rid}.json` ↔ 响应 |
| PlanApproval | `plan-approval-{sid}-{rid}.json` ↔ 响应 |

**远程实现**：daemon 内部 API 不变，通过 transport 抽象切换：

```
permission-transport.js  (新增抽象层)
├── FileTransport      (本地模式默认；现有文件 IPC 行为)
└── StdioTransport     (远程模式；通过 stdout 发请求、stdin 收响应)
```

环境变量 `CLAUDE_PERMISSION_TRANSPORT=stdio` 启用 StdioTransport。

**StdioTransport 流程**（permission/ask/plan 同构）：

1. daemon 调 `transport.requestPermission(...)` 等
2. StdioTransport 生成 requestId，`process.stdout.write(JSON + "\n")`
3. server 把 daemon stdout 行作为 SSE event 推给 client
4. 插件弹 UI → 用户决定 → `POST /session/{id}/in` 带 control 响应
5. server 把 body 写到 daemon stdin
6. daemon.js 主循环识别 `type==='_ctrl'` → `transport.handleResponse(msg)`
7. StdioTransport pending map 中 promise resolve

**daemon.js 改造点**：
- `permission-handler.js` / `permission-ipc.js`：fs IO 替换为 `transport.request*(...)`
- 新增 `permission-transport.js`：抽象 + 两实现
- daemon.js stdin 主循环：识别 `msg.type === '_ctrl'`，路由到 `transport.handleResponse(msg)`，不进入正常请求处理

代码量：~200 行。

### 3.5 HTTP `/history/*` API（与 v2 一致）

服务端硬编码白名单：**只允许读 `$HOME/.claude/projects/` 下，禁止 `..` / 软链逃逸**。

```
GET  /history/projects             → [{ encodedPath, displayPath, mtime, sessionCount }]
GET  /history/sessions?project=    → [{ sessionId, title, startTime, lastTurnTime, messageCount, model }]
GET  /history/session?project=&sessionId=
     Header: Range: bytes=0-       → application/x-ndjson 流
GET  /history/session-lite?project=&sessionId=
                                   → { sessionId, title, firstUserMsg, ... }
GET  /history/search?q=&limit=     → [{ sessionId, project, snippet, score }]  (二期)
```

**关键点**：encodedPath 用 base64url；Range 必须支持；JSONL 直接透传；不需要 watch（实时更新走 SSE）。

### 3.6 文件附件 / 图片（一期不做）

远程模式下隐藏附件按钮 + 禁用图片粘贴。二期：`POST /upload` 端点 + 客户端透明改写路径。

---

## 4. 项目结构

### 4.1 ai-bridge-server 目录布局

```
ai-bridge-server/
├── DESIGN.md                  ← 本文档
├── README.md                  ← 部署/使用说明
├── package.json
├── package-lock.json
├── src/
│   ├── server.js              ← 入口：HTTP 路由（~80 行）
│   ├── session-manager.js     ← session 生命周期 + daemon spawn（~200 行）
│   ├── sse-hub.js             ← SSE 推送 + ring buffer + 重连回放（~150 行）
│   ├── history-server.js      ← HTTP /history/* 端点（~250 行）
│   ├── path-guard.js          ← 路径白名单 + 防逃逸（~50 行）
│   ├── upload.js              ← (二期) 文件上传
│   └── logger.js              ← 日志（~30 行）
├── scripts/
│   ├── install-bridge.sh      ← 软链 ../jetbrains-cc-gui/ai-bridge
│   ├── start.sh               ← 生产启动脚本
│   └── ai-bridge-server.service ← systemd unit
├── docker/
│   ├── Dockerfile             ← 容器镜像
│   └── docker-compose.yml     ← 部署示例
├── ai-bridge/                 ← 软链或拷贝自 jetbrains-cc-gui/ai-bridge
└── test/
    ├── session-manager.test.js
    ├── sse-hub.test.js
    ├── history-server.test.js
    ├── path-guard.test.js
    └── e2e.test.js
```

### 4.2 与 jetbrains-cc-gui/ai-bridge 的关系

- 短期：软链 `ln -s ../jetbrains-cc-gui/ai-bridge ai-bridge`
- 中期：`npm link`
- 发布期：作为 npm 依赖

---

## 5. 详细模块设计

### 5.1 server.js（入口）

```js
const http = require('http');
const { createSessionManager } = require('./session-manager');
const { createHistoryRouter } = require('./history-server');

const port = process.env.PORT || 3284;
const sessions = createSessionManager({ idleTimeoutMs: 60_000 });
const historyRouter = createHistoryRouter({ root: path.join(os.homedir(), '.claude/projects') });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/health')   return sendJSON(res, { status: 'ok' });
  if (url.pathname === '/version')  return sendJSON(res, { version, daemonVersion });

  if (url.pathname === '/session' && req.method === 'POST') {
    return sessions.create(req, res);
  }
  const sessionMatch = url.pathname.match(/^\/session\/([^/]+)\/(events|in)$/);
  if (sessionMatch) {
    const [, sid, action] = sessionMatch;
    if (action === 'events' && req.method === 'GET')  return sessions.subscribeSse(sid, req, res);
    if (action === 'in'     && req.method === 'POST') return sessions.writeIn(sid, req, res);
  }
  if (url.pathname.match(/^\/session\/[^/]+$/) && req.method === 'DELETE') {
    return sessions.destroy(url.pathname.split('/')[2], res);
  }

  if (url.pathname.startsWith('/history/')) return historyRouter(req, res);

  res.writeHead(404).end();
});

server.listen(port, '0.0.0.0');
```

### 5.2 session-manager.js（核心）

```js
function createSessionManager({ idleTimeoutMs }) {
  const sessions = new Map();  // sid → Session

  function create(req, res) {
    const sid = uuid();
    const child = spawn('node', [DAEMON_PATH], {
      env: { ...process.env, CLAUDE_PERMISSION_TRANSPORT: 'stdio' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const session = {
      sid, child,
      hub: createSseHub({ bufferSize: 1000 }),
      lastActivity: Date.now(),
      idleTimer: null
    };
    sessions.set(sid, session);

    // 透传 daemon stdout → SSE hub
    const stdoutLines = readline.createInterface({ input: child.stdout });
    stdoutLines.on('line', line => session.hub.publish(line));

    child.stderr.on('data', d => logger.warn('daemon stderr', d.toString()));

    child.on('exit', code => {
      session.hub.publish(JSON.stringify({
        type: '_ctrl', action: 'gateway_error',
        message: `daemon exited code=${code}`, code: 'DAEMON_DOWN'
      }));
      session.hub.close();
      sessions.delete(sid);
    });

    armIdleTimer(session);
    sendJSON(res, { sessionId: sid });
  }

  function subscribeSse(sid, req, res) {
    const s = sessions.get(sid);
    if (!s) return res.writeHead(404).end();
    cancelIdleTimer(s);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const lastId = parseInt(req.headers['last-event-id'] || '0', 10);
    s.hub.attach(res, lastId);
    req.on('close', () => {
      s.hub.detach(res);
      armIdleTimer(s);
    });
  }

  function writeIn(sid, req, res) {
    const s = sessions.get(sid);
    if (!s) return res.writeHead(404).end();
    s.lastActivity = Date.now();
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      s.child.stdin.write(body.trim() + '\n');
      sendJSON(res, { queued: true });
    });
  }

  function destroy(sid, res) {
    const s = sessions.get(sid);
    if (s) gracefulKill(s.child);
    sessions.delete(sid);
    sendJSON(res, { closed: true });
  }

  function armIdleTimer(s) {
    if (s.hub.subscriberCount() > 0) return;
    s.idleTimer = setTimeout(() => {
      logger.info(`session ${s.sid} idle, killing daemon`);
      gracefulKill(s.child);
      sessions.delete(s.sid);
    }, idleTimeoutMs);
  }
  function cancelIdleTimer(s) {
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  }

  return { create, subscribeSse, writeIn, destroy };
}
```

代码量：~200 行。

### 5.3 sse-hub.js（SSE 推送 + ring buffer）

```js
function createSseHub({ bufferSize }) {
  const buffer = [];           // [{ id, data }]
  let nextId = 1;
  const subscribers = new Set();
  const heartbeat = setInterval(() => {
    for (const res of subscribers) res.write(': hb\n\n');
  }, 15_000);

  function publish(line) {
    const id = nextId++;
    buffer.push({ id, data: line });
    if (buffer.length > bufferSize) buffer.shift();
    for (const res of subscribers) writeEvent(res, id, line);
  }

  function attach(res, lastEventId) {
    subscribers.add(res);
    // 回放 buffer 中 id > lastEventId 的事件
    for (const { id, data } of buffer) {
      if (id > lastEventId) writeEvent(res, id, data);
    }
  }

  function detach(res) { subscribers.delete(res); try { res.end(); } catch {} }
  function close()  { clearInterval(heartbeat); for (const r of subscribers) detach(r); }
  function subscriberCount() { return subscribers.size; }

  function writeEvent(res, id, data) {
    res.write(`id: ${id}\nevent: message\ndata: ${data}\n\n`);
  }

  return { publish, attach, detach, close, subscriberCount };
}
```

代码量：~150 行。

### 5.4 history-server.js（HTTP 历史端点）

与 v2 一致：path-guard 白名单 + Range 支持 + 5 个端点。代码量：~250 行。

### 5.5 daemon.js 改造（在 jetbrains-cc-gui/ai-bridge 里改）

与 v2 一致：

- 新增 `permission-transport.js`：FileTransport + StdioTransport 抽象
- `permission-handler.js` / `permission-ipc.js`：fs IO 替换为 `transport.request*(...)`
- `daemon.js` stdin 主循环：识别 `msg.type === '_ctrl'` 并路由到 `transport.handleResponse(msg)`

支持三通道：permission / ask_user_question / plan_approval。

代码量：~200 行。

### 5.6 插件端改造

#### 5.6.1 IBridge 抽象

```java
public interface IBridge {
    boolean start();
    void stop();
    boolean isAlive();
    boolean ensureRunning();
    void sendAbort();
    CompletableFuture<Boolean> sendCommand(String method, JsonObject params, DaemonOutputCallback cb);
    void setLifecycleListener(DaemonLifecycleListener l);
    boolean isSdkPreloaded();
    void setControlMessageHandler(ControlMessageHandler h);
}
```

`DaemonBridge` 改名 `LocalBridge`，实现 IBridge。本地模式下 control 走文件 IPC（现状不变）。

#### 5.6.2 RemoteBridge.java

HTTP 客户端 + SSE 订阅，行为镜像 LocalBridge：

```java
public class RemoteBridge implements IBridge {
    private final String baseUrl;        // http://host:3284
    private final HttpClient http = HttpClient.newHttpClient();
    private String sessionId;
    private final Map<String, RequestState> active = new ConcurrentHashMap<>();
    private ControlMessageHandler controlHandler;
    private long lastEventId = 0;
    private volatile SseSubscriber sseSubscriber;

    public boolean start() {
        // 1. POST /session
        var resp = http.send(HttpRequest.newBuilder()
            .uri(URI.create(baseUrl + "/session"))
            .POST(HttpRequest.BodyPublishers.noBody())
            .build(), HttpResponse.BodyHandlers.ofString());
        sessionId = parseJson(resp.body()).get("sessionId").getAsString();

        // 2. 订阅 SSE
        startSseSubscriber();
        return waitReady(30, SECONDS);
    }

    public CompletableFuture<Boolean> sendCommand(String method, JsonObject params, DaemonOutputCallback cb) {
        String id = UUID.randomUUID().toString();
        active.put(id, new RequestState(cb));
        JsonObject req = new JsonObject();
        req.addProperty("id", id);
        req.addProperty("method", method);
        req.add("params", params);
        postIn(req);
        return /* future linked to active.get(id).done */;
    }

    private void postIn(JsonObject body) {
        http.sendAsync(HttpRequest.newBuilder()
            .uri(URI.create(baseUrl + "/session/" + sessionId + "/in"))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
            .build(), HttpResponse.BodyHandlers.discarding());
    }

    private void startSseSubscriber() {
        sseSubscriber = new SseSubscriber(
            URI.create(baseUrl + "/session/" + sessionId + "/events"),
            lastEventId,
            this::onSseEvent,
            this::onSseClosed   // 自动指数退避重连
        );
        sseSubscriber.start();
    }

    private void onSseEvent(long eventId, String data) {
        lastEventId = eventId;
        JsonObject msg = JsonParser.parseString(data).getAsJsonObject();
        if ("daemon".equals(getStr(msg, "type")))      handleDaemonEvent(msg);
        else if ("_ctrl".equals(getStr(msg, "type")))  handleCtrl(msg);
        else if (msg.has("id"))                         routeRequestOutput(msg);
    }

    private void handleCtrl(JsonObject msg) {
        String action = getStr(msg, "action");
        if ("gateway_error".equals(action)) { lifecycle.onDead(); return; }
        // permission_request / ask_user_question_request / plan_approval_request
        controlHandler.onRequest(action, msg, response -> postIn(response));
    }

    public void stop() {
        if (sseSubscriber != null) sseSubscriber.cancel();
        if (sessionId != null) {
            http.sendAsync(HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/session/" + sessionId))
                .DELETE().build(), HttpResponse.BodyHandlers.discarding());
        }
    }
}
```

`SseSubscriber` 是个轻量工具类（~150 行），内部用 `HttpClient` + `BodyHandlers.fromLineSubscriber` 解析 SSE 帧（id / event / data / 注释行 / 空行分隔），断线时按 `Last-Event-ID` 重连。

代码量：RemoteBridge ~350 行 + SseSubscriber ~150 行 = **~500 行**。

#### 5.6.3 HistoryDataSource 抽象（与 v2 一致）

```java
public interface HistoryDataSource {
    List<ProjectInfo> listProjects();
    List<SessionInfo> listSessions(String projectPath, int limit, int offset);
    Optional<byte[]> readSessionRaw(String projectPath, String sessionId);
    Optional<SessionLite> readSessionLite(String projectPath, String sessionId);
    Optional<SearchResults> search(String query, int limit);
}
```

`LocalHistoryDataSource`（包装现有 reader） + `RemoteHistoryDataSource`（HTTP 客户端 + mtime 缓存 + Range 流式）。

代码量：~300 行。

#### 5.6.4 RemoteMode 全局上下文 + UI 灰态（与 v2 一致）

`RemoteModeContext` 单例 + 各面板条件渲染。代码量：~200 行。

#### 5.6.5 工厂 + Settings UI

```java
boolean remote = settings.isRemoteMode();
IBridge bridge = remote ? new RemoteBridge(settings.remoteUrl()) : new LocalBridge();
HistoryDataSource history = remote
    ? new RemoteHistoryDataSource(settings.remoteUrl())
    : new LocalHistoryDataSource();
```

`RemoteServerSection`（webview）：mode 单选 + remoteUrl 输入 + 连通性测试（`GET /health` + `POST /session` 试连）。

代码量：~200 行。

---

## 6. 错误处理与边界

| 场景 | 处理 |
|---|---|
| SSE 连接断开（网络抖动） | SseSubscriber 指数退避重连，附 `Last-Event-ID` 回放；daemon 不死，事件不丢 |
| daemon 子进程崩溃 | server publish `_ctrl/gateway_error code=DAEMON_DOWN`；session-manager 删除 session；插件 lifecycle 触发"dead" |
| 客户端长时间不重连（SSE 断 60s） | session-manager idleTimer 触发，gracefulKill daemon，释放资源 |
| 权限/Ask/Plan 响应超时（5min） | StdioTransport 内部 reject → ToolDenied，与本地一致 |
| 多 IDE 实例连同一容器 | 各自创建独立 session（独立 daemon），完全隔离 |
| SSE 反代被 nginx 缓冲卡住 | 文档强制 `proxy_buffering off; proxy_cache off; proxy_http_version 1.1; chunked_transfer_encoding on;` |
| daemon stdout 非 JSON 行 | daemon 已规范化 `[STDOUT_RAW]`；hub 按行透传 |
| `/session/{id}/in` 在 daemon 死后调用 | 返回 410 Gone，插件触发重连流程 |
| `/history/session` 大文件 | 强制 Range；客户端流式解析；UI 增量渲染 |
| HTTP 路径越界（`..` / 软链） | path-guard 一律 403 |
| ring buffer 溢出（SSE 长时间断开） | 客户端重连时 `Last-Event-ID` 不在 buffer → server 发一条 `gateway_error code=BUFFER_LOST`，插件提示"会话状态丢失，请重开" |
| 容器内 `~/.claude` 未初始化（首次 spawn） | daemon 启动时 SDK 自动创建；缺 API key 则首次请求即报错，正常透传到客户端 |
| host / 容器路径不一致 | session 创建时 server 检测项目目录可读性失败 → 拒绝创建并返回明确错误码 `PATH_MISMATCH` |
| host UI 改 settings 但远程模式下不生效 | 灰态 + 提示文字"远程模式下请在容器内配置" |

---

## 7. 部署

### 7.1 docker-compose 示例

```yaml
version: '3.8'
services:
  ai-bridge-server:
    image: ai-bridge-server:latest
    user: "${UID}:${GID}"
    ports:
      - "3284:3284"
    volumes:
      - /Users/stelin/Develop/myproject:/Users/stelin/Develop/myproject
    environment:
      PORT: 3284
      HOME: /home/devuser
      SESSION_IDLE_TIMEOUT_MS: 60000
    restart: unless-stopped
```

### 7.2 容器镜像（Dockerfile）

```dockerfile
FROM node:20-slim
RUN useradd -m -u 1000 devuser
USER devuser
WORKDIR /home/devuser

# 1. claude CLI / SDK
RUN npm i -g @anthropic-ai/claude-code

# 2. 常用 MCP server（按需）
RUN npm i -g @modelcontextprotocol/server-github mcp-chrome-devtools

# 3. 预放配置
COPY --chown=devuser settings.json /home/devuser/.claude/settings.json
COPY --chown=devuser claude.json   /home/devuser/.claude.json
COPY --chown=devuser codemoss/     /home/devuser/.codemoss/

# 4. ai-bridge-server
COPY --chown=devuser ai-bridge-server /opt/ai-bridge-server
WORKDIR /opt/ai-bridge-server
RUN npm ci --omit=dev

EXPOSE 3284
CMD ["node", "src/server.js"]
```

### 7.3 nginx 反代关键配置

```nginx
location / {
    proxy_pass http://ai-bridge-server:3284;
    proxy_http_version 1.1;
    proxy_buffering off;          # SSE 必备
    proxy_cache off;              # SSE 必备
    chunked_transfer_encoding on;
    proxy_read_timeout 86400s;    # 长连接保活
    proxy_set_header X-Accel-Buffering no;
}
```

### 7.4 部署 checklist

- [ ] 项目目录 host ↔ 容器路径完全一致
- [ ] `--user $(id -u):$(id -g)` 或 `user:` 配置
- [ ] 镜像内 `~/.claude/settings.json` 含有效 API key
- [ ] 镜像内 `~/.claude.json` 含 MCP 服务器配置（如需）
- [ ] 镜像内 `~/.codemoss/` 含 Skills / Provider 配置（如需）
- [ ] 端口映射 3284:3284（或自定义）
- [ ] 反代关 buffer / cache（如有 nginx）
- [ ] 容器内 HOME 与 daemon `os.homedir()` 一致

### 7.5 首次连接体验

1. 用户在 IDE 设置面板填 baseUrl → 点"测试连通"
2. 插件 `GET /health` 验活
3. `GET /version` 检查版本
4. `POST /session` 试创建（验证 daemon 能 spawn + 路径正确）
5. `GET /session/{id}/events` 试订阅（验证 SSE 通路）
6. 立即 `DELETE /session/{id}` 释放
7. 任一步失败 → UI 给明确错误（路径不一致 / API key 缺失 / 端口不通 / 反代 buffer 没关）

---

## 8. 实施步骤

| 阶段 | 工作 | 产出 | 估时 |
|---|---|---|---|
| **P0** daemon 三通道 stdio IPC | permission-transport.js 抽象 + StdioTransport（permission/ask/plan） + daemon.js 主循环 _ctrl 路由 | 本地模式回归通过 | 0.5d |
| **P1** ai-bridge-server HTTP 骨架 | server.js + session-manager + sse-hub + ring buffer + idle timeout | curl 能跑通：POST /session → SSE 订阅 → POST /in → 收到 daemon 输出 | 1d |
| **P1.5** HTTP `/history/*` 端点 | history-server.js + path-guard + Range + 5 个端点 | curl 能列项目/会话/读 jsonl | 1d |
| **P2** 插件 IBridge + HistoryDataSource 抽象 | 抽接口 + DaemonBridge → LocalBridge + LocalHistoryDataSource | 本地模式回归通过 | 1d |
| **P3** RemoteBridge + SseSubscriber + RemoteHistoryDataSource | HTTP 客户端 + SSE 解析 + 三通道 _ctrl 适配 + 重连 + 工厂切换 | 远程模式打通基础对话 + 历史面板 | 1.5d |
| **P4** Settings UI + 远程模式灰态 | RemoteServerSection + 持久化 + 连通性测试 + 各面板灰态 | 用户可在 UI 切换 + 不可用功能正确禁用 | 0.5d |
| **P5** 联调 + 边界测试 | 长会话 / SSE 断网重连 / 三通道审批 / Plan 模式 / MCP 工具 / Resume 会话 / 大 history Range / nginx 反代 | 文档 + 已知问题列表 | 1d |
| **合计** | | | **~6.5 天** |

**两波出可演示版本**：

- **第一波（P0-P3 不含 history，~5d）**：对话主链路 + 三通道权限完整跑通
- **第二波（+P1.5 + RemoteHistoryDataSource，~2.5d）**：补历史

---

## 9. 代码量汇总

| 模块 | 位置 | 新增 | 修改 |
|---|---|---|---|
| permission-transport.js | jetbrains-cc-gui/ai-bridge/ | ~120 | - |
| permission-handler.js / permission-ipc.js / daemon.js _ctrl 路由 | jetbrains-cc-gui/ai-bridge/ | - | ~80 |
| server.js | ai-bridge-server/src/ | ~80 | - |
| session-manager.js | ai-bridge-server/src/ | ~200 | - |
| sse-hub.js | ai-bridge-server/src/ | ~150 | - |
| history-server.js + path-guard.js | ai-bridge-server/src/ | ~250 | - |
| daemon-loader / logger / scripts / Dockerfile | ai-bridge-server/ | ~150 | - |
| IBridge.java | jetbrains-cc-gui/.../common/ | ~40 | - |
| LocalBridge.java（DaemonBridge 改名 + 适配接口） | jetbrains-cc-gui/.../common/ | - | ~50 |
| RemoteBridge.java | jetbrains-cc-gui/.../common/ | ~350 | - |
| SseSubscriber.java | jetbrains-cc-gui/.../common/ | ~150 | - |
| ControlMessageHandler / RemotePermissionAdapter | jetbrains-cc-gui/.../permission/ | ~120 | - |
| HistoryDataSource 接口 + LocalHistoryDataSource | jetbrains-cc-gui/.../provider/claude/ | ~150 | - |
| RemoteHistoryDataSource | jetbrains-cc-gui/.../provider/claude/ | ~200 | - |
| ClaudeSDKBridge 工厂 | jetbrains-cc-gui/.../claude/ | - | ~30 |
| RemoteModeContext + 各面板灰态 | jetbrains-cc-gui/.../ + webview | ~200 | ~80 |
| RemoteServerSection.tsx + Settings 字段 | jetbrains-cc-gui/webview/ + .../settings/ | ~200 | ~30 |
| 测试 | ai-bridge-server/test/ + jetbrains | ~400 | - |
| **总计** | | **~2760** | **~270** |

---

## 10. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| daemon 改 stdio 协议影响本地模式 | 高 | 环境变量切换；本地默认 FileTransport；写完跑现有所有测试 |
| 部署拓扑错配（路径不一致 / `~/.claude` 误挂载） | 高 | session 创建时检测；连接时验 cwd；docs 部署 checklist |
| nginx 缓冲 SSE 导致事件延迟 | 高 | 文档强制 `proxy_buffering off`；客户端 SSE 心跳超时检测（30s 无事件即视为断开） |
| ring buffer 溢出导致重连状态丢失 | 中 | buffer 至少 1000 条 + 5 分钟内事件；溢出时明确错误码让用户重开 |
| `/history/session` 大文件性能 | 中 | Range 必须实现 + 客户端流式解析 |
| 三通道 _ctrl 消息混入正常请求处理 | 中 | daemon 主循环最先识别 `type==='_ctrl'` 并 return |
| 容器内 `~/.claude` 没预配 | 中 | 镜像构建时强制；启动脚本检测 settings.json 存在 |
| 权限弹窗 UI 等待超时 | 中 | 沿用 5 分钟超时；UI 加进度提示 |
| MCP 远程化 | 中 | MCP 进程在容器内跑；镜像里预装相应工具 |
| Session idle timeout 误杀活跃会话 | 中 | 仅在"无 SSE 订阅 60s"才触发；`/in` POST 也算续期；client 保活 SSE 即可 |
| 网络抖动频繁重连 | 低 | SSE 内建 + 指数退避；ring buffer 续传 |
| 多连接共用 daemon 还是独立 | 低 | 选独立（隔离性 > 内存占用） |
| host UI 改 settings 但灰态没生效 | 低 | RemoteModeContext 单点检查；测试覆盖 |

---

## 11. 后续可扩展点（不在本期范围）

- **附件 / 图片**：`POST /upload` 端点 + 客户端透明改写路径
- **跨机器远程化**（不挂载项目目录）：需要 FsProvider 抽象层（read/list/stat/write/watch），daemon 内 SDK 的 fs 工具改造，~9-10 天
- **配置类管理远程化**（settings/mcp/skills/provider 在线编辑）：需要 `/config/*` 端点 + 配置上行通道
- **Checkpoint / Rewind 远程化**：`~/.claude/checkpoints/` 暴露给 host
- **跨会话用量聚合**：history 端点扩展
- **多用户隔离**：session 加 token / Bearer auth
- **TLS / 鉴权**：Bearer / mTLS
- **Daemon 池化**：避免每 session spawn 开销
- **Web 客户端**：浏览器直接 SSE 接，不需要插件
- **监控指标**：`/metrics` Prometheus 格式

---

## 附录 A：关键文件路径

**本仓库（ai-bridge-server）**：
- `src/server.js`
- `src/session-manager.js`
- `src/sse-hub.js`
- `src/history-server.js`
- `src/path-guard.js`
- `ai-bridge/`（软链）
- `docker/Dockerfile` / `docker/docker-compose.yml`

**jetbrains-cc-gui 改动点**：
- `ai-bridge/permission-transport.js` 【新增】
- `ai-bridge/permission-handler.js` 【修改】
- `ai-bridge/permission-ipc.js` 【修改】
- `ai-bridge/daemon.js` 【修改 _ctrl 路由】
- `src/main/java/com/github/claudecodegui/provider/common/IBridge.java` 【新增】
- `src/main/java/com/github/claudecodegui/provider/common/LocalBridge.java` 【DaemonBridge 改名】
- `src/main/java/com/github/claudecodegui/provider/common/RemoteBridge.java` 【新增】
- `src/main/java/com/github/claudecodegui/provider/common/SseSubscriber.java` 【新增】
- `src/main/java/com/github/claudecodegui/provider/common/HistoryDataSource.java` 【新增】
- `src/main/java/com/github/claudecodegui/provider/claude/LocalHistoryDataSource.java` 【新增】
- `src/main/java/com/github/claudecodegui/provider/claude/RemoteHistoryDataSource.java` 【新增】
- `src/main/java/com/github/claudecodegui/provider/claude/ClaudeSDKBridge.java` 【修改工厂】
- `src/main/java/com/github/claudecodegui/permission/ControlMessageHandler.java` 【新增】
- `src/main/java/com/github/claudecodegui/settings/CodemossSettingsService.java` 【加字段】
- `src/main/java/com/github/claudecodegui/settings/RemoteModeContext.java` 【新增】
- `webview/src/components/settings/RemoteServerSection/` 【新增】
- 各 settings/mcp/skills/provider 面板 【修改：远程模式灰态】

---

## 附录 B：协议消息全集（Cheat Sheet）

### B.1 Session 端点

| 端点 | 方法 | 入参 | 响应 |
|---|---|---|---|
| `/session` | POST | (空) | `{"sessionId":"abc123"}` |
| `/session/{id}/events` | GET (SSE) | header `Last-Event-ID` (重连用) | `text/event-stream` |
| `/session/{id}/in` | POST | 一行 JSON | `{"queued":true}` |
| `/session/{id}` | DELETE | - | `{"closed":true}` |

### B.2 SSE 事件类型（server → client，data 内容）

| data 形态 | 示例 |
|---|---|
| daemon ready | `{"type":"daemon","event":"ready","pid":123,"sdkPreloaded":true}` |
| 输出行 | `{"id":"r1","line":"[CONTENT_DELTA] \"Hi\""}` |
| stderr | `{"id":"r1","stderr":"warning..."}` |
| 完成 | `{"id":"r1","done":true,"success":true}` |
| 心跳响应 | `{"id":"r2","type":"heartbeat","ts":1234567890}` |
| 权限请求 | `{"type":"_ctrl","action":"permission_request","requestId":"p1","toolName":"Edit","inputs":{...},"cwd":"/x"}` |
| AskUser 请求 | `{"type":"_ctrl","action":"ask_user_question_request","requestId":"q1","question":"...","options":[...]}` |
| Plan 请求 | `{"type":"_ctrl","action":"plan_approval_request","requestId":"plan1","plan":"..."}` |
| Gateway 错误 | `{"type":"_ctrl","action":"gateway_error","message":"...","code":"DAEMON_DOWN\|PATH_MISMATCH\|BUFFER_LOST"}` |

### B.3 `POST /session/{id}/in` body 类型（client → server）

| 用途 | body |
|---|---|
| 普通请求 | `{"id":"r1","method":"claude.send","params":{...}}` |
| 心跳 | `{"id":"r2","method":"heartbeat"}` |
| 中止 | `{"id":"r3","method":"abort"}` |
| 关闭 daemon | `{"id":"r4","method":"shutdown"}` |
| 权限响应 | `{"type":"_ctrl","action":"permission_response","requestId":"p1","allow":true}` |
| AskUser 响应 | `{"type":"_ctrl","action":"ask_user_question_response","requestId":"q1","answers":[...]}` |
| Plan 响应 | `{"type":"_ctrl","action":"plan_approval_response","requestId":"plan1","approved":true,"editedPlan":null}` |

### B.4 HTTP 通用端点

| 端点 | 方法 | 参数 | 响应 |
|---|---|---|---|
| `/health` | GET | - | `{"status":"ok"}` |
| `/version` | GET | - | `{"version":"...","daemonVersion":"..."}` |
| `/history/projects` | GET | - | `[{encodedPath, displayPath, mtime, sessionCount}]` |
| `/history/sessions` | GET | `project, limit, offset` | `[{sessionId, title, startTime, lastTurnTime, messageCount, model}]` |
| `/history/session` | GET | `project, sessionId` (Range) | `application/x-ndjson` 流 |
| `/history/session-lite` | GET | `project, sessionId` | `{sessionId, title, firstUserMsg, ...}` |
| `/history/search` (二期) | GET | `q, limit` | `[{sessionId, project, snippet, score}]` |
