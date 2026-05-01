# jetbrains-cc-gui 远程模式编码实现文档

> 配套 `DESIGN.md` v3 + `IMPL-SERVER.md`。本文档面向插件开发者，按步骤说明 jetbrains-cc-gui 加远程模式支持的具体改造。
>
> **核心原则**：本地模式代码**完全不动，零回归风险**。所有远程逻辑通过新增的 `IBridge` / `HistoryDataSource` 抽象 + `RemoteBridge` / `RemoteHistoryDataSource` 实现 + 工厂选择 + UI 灰态完成。

---

## 0. 改造总览

| 模块 | 操作 | 路径 |
|---|---|---|
| `IBridge` 接口 | 新增 | `provider/common/IBridge.java` |
| `DaemonBridge.java` (674行) | 改名 + 加 implements | → `LocalBridge.java` |
| `RemoteBridge.java` | 新增 | `provider/common/RemoteBridge.java` |
| `SseSubscriber.java` | 新增 | `provider/common/SseSubscriber.java` |
| `ControlMessageHandler` 接口 + Adapter | 新增 | `permission/` |
| `HistoryDataSource` 接口 | 新增 | `provider/common/HistoryDataSource.java` |
| `LocalHistoryDataSource` | 新增（包装现有 reader） | `provider/claude/LocalHistoryDataSource.java` |
| `RemoteHistoryDataSource` | 新增（HTTP 客户端） | `provider/claude/RemoteHistoryDataSource.java` |
| `ClaudeSDKBridge` 工厂 | 微调 | `provider/claude/ClaudeSDKBridge.java` |
| `CodemossSettingsService` | 加字段 | `settings/CodemossSettingsService.java` |
| `RemoteModeContext` | 新增 | `settings/RemoteModeContext.java` |
| `RemoteServerSection` (Webview) | 新增 | `webview/src/components/settings/` |
| Settings/MCP/Skills/Provider/Rewind 面板 | 加灰态 | 各对应文件 |

**ai-bridge 目录本身完全不动**——本地模式继续走原有 stdio 文件 IPC。

---

## Step 1：新增 `IBridge` 接口

**目标**：抽出 DaemonBridge 的对外 API，让 LocalBridge 和 RemoteBridge 可互换。

**文件**：`src/main/java/com/github/claudecodegui/provider/common/IBridge.java`

```java
package com.github.claudecodegui.provider.common;

import com.google.gson.JsonObject;
import com.github.claudecodegui.permission.ControlMessageHandler;

import java.util.concurrent.CompletableFuture;

public interface IBridge {

    /** 启动桥接（本地：spawn daemon；远程：POST /session + SSE 订阅）。返回是否成功。 */
    boolean start();

    /** 停止并清理。 */
    void stop();

    /** 是否仍可用（本地：进程存活；远程：SSE 连接活 + 最近收到事件）。 */
    boolean isAlive();

    /** 不存活则启动；存活则 noop。 */
    boolean ensureRunning();

    /** 立即中断当前活跃请求。 */
    void sendAbort();

    /** 发送命令。method 如 "claude.send" / "codex.send" / "heartbeat"。 */
    CompletableFuture<Boolean> sendCommand(
        String method, JsonObject params, DaemonOutputCallback callback);

    /** 监听 daemon 生命周期事件。 */
    void setLifecycleListener(DaemonLifecycleListener listener);

    /** 当前是否已预加载 SDK。 */
    boolean isSdkPreloaded();

    /**
     * 设置 _ctrl 控制消息处理器（仅远程模式有效）。
     * 本地模式下控制消息走文件 IPC，setControlMessageHandler 留空实现。
     */
    void setControlMessageHandler(ControlMessageHandler handler);

    // ===== 嵌套类型沿用 DaemonBridge 现有定义 =====

    interface DaemonOutputCallback {
        void onLine(String line);
        void onStderr(String stderr);
        void onDone(boolean success, String error);
    }

    interface DaemonLifecycleListener {
        void onReady();
        void onDeath();
        void onRestart();
    }
}
```

---

## Step 2：DaemonBridge → LocalBridge

### 2.1 改名 + 加 implements

```bash
# 重命名文件
mv src/main/java/com/github/claudecodegui/provider/common/DaemonBridge.java \
   src/main/java/com/github/claudecodegui/provider/common/LocalBridge.java
```

类声明改成：

```java
public class LocalBridge implements IBridge {
    // ... 原有 674 行代码完全不动
}
```

把现有的 `DaemonOutputCallback` / `DaemonLifecycleListener` 嵌套接口**删除**（移到 `IBridge` 里），原代码引用的地方编译会自动指向 `IBridge.DaemonOutputCallback`。

### 2.2 加 setControlMessageHandler 空实现

```java
@Override
public void setControlMessageHandler(ControlMessageHandler handler) {
    // 本地模式：控制消息走文件 IPC，由 PermissionService / PermissionRequestWatcher 处理；
    // 这里不需要做任何事
}
```

### 2.3 全局重命名引用

```bash
# 找所有引用 DaemonBridge 的地方
grep -rn "DaemonBridge" src/main/java/com/github/claudecodegui --include="*.java"
```

替换策略：
- 类型声明（`DaemonBridge bridge = ...`）→ 改为 `IBridge bridge = ...`
- `new DaemonBridge(...)` → `new LocalBridge(...)`
- 不要直接引用 LocalBridge 类型，全部走 IBridge 接口

预计影响 ~5 个文件（含 `ClaudeSDKBridge.java`、`BaseSDKBridge.java` 等），都是机械替换。

---

## Step 3：新增 `RemoteBridge.java`

**文件**：`src/main/java/com/github/claudecodegui/provider/common/RemoteBridge.java`

```java
package com.github.claudecodegui.provider.common;

import com.google.gson.*;
import com.github.claudecodegui.permission.ControlMessageHandler;
import com.intellij.openapi.diagnostic.Logger;

import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

public class RemoteBridge implements IBridge {

    private static final Logger LOG = Logger.getInstance(RemoteBridge.class);
    private static final long START_TIMEOUT_MS = 30_000;
    private static final Duration HTTP_TIMEOUT = Duration.ofSeconds(30);

    private final String baseUrl;        // http://host:3284
    private final HttpClient http;
    private volatile String sessionId;
    private volatile SseSubscriber sseSubscriber;
    private final AtomicLong lastEventId = new AtomicLong(0);
    private final AtomicBoolean ready = new AtomicBoolean(false);
    private final AtomicBoolean sdkPreloaded = new AtomicBoolean(false);
    private final AtomicBoolean alive = new AtomicBoolean(false);

    private final ConcurrentHashMap<String, RequestState> active = new ConcurrentHashMap<>();
    private volatile DaemonLifecycleListener lifecycleListener;
    private volatile ControlMessageHandler controlHandler;
    private volatile CountDownLatch readyLatch = new CountDownLatch(1);

    public RemoteBridge(String baseUrl) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .version(HttpClient.Version.HTTP_1_1)
            .build();
    }

    @Override
    public boolean start() {
        try {
            // 1. POST /session
            HttpResponse<String> resp = http.send(
                HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/session"))
                    .timeout(HTTP_TIMEOUT)
                    .POST(HttpRequest.BodyPublishers.noBody())
                    .build(),
                HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 200) {
                LOG.warn("POST /session failed: " + resp.statusCode() + " " + resp.body());
                return false;
            }
            sessionId = JsonParser.parseString(resp.body())
                .getAsJsonObject().get("sessionId").getAsString();

            // 2. 启动 SSE 订阅
            startSseSubscriber();

            // 3. 等 daemon ready
            if (!readyLatch.await(START_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                LOG.warn("Timeout waiting for daemon ready");
                stop();
                return false;
            }
            alive.set(true);
            return true;
        } catch (Exception e) {
            LOG.warn("RemoteBridge.start failed", e);
            return false;
        }
    }

    private void startSseSubscriber() {
        sseSubscriber = new SseSubscriber(
            URI.create(baseUrl + "/session/" + sessionId + "/events"),
            lastEventId,
            this::onSseEvent,
            this::onSseClosed
        );
        sseSubscriber.start();
    }

    private void onSseEvent(String data) {
        JsonObject msg;
        try {
            msg = JsonParser.parseString(data).getAsJsonObject();
        } catch (Exception e) {
            LOG.warn("Invalid SSE data: " + data);
            return;
        }

        String type = optString(msg, "type");
        if ("daemon".equals(type)) {
            handleDaemonEvent(msg);
        } else if ("_ctrl".equals(type)) {
            handleCtrl(msg);
        } else if (msg.has("id")) {
            routeRequestOutput(msg);
        }
    }

    private void handleDaemonEvent(JsonObject msg) {
        String event = optString(msg, "event");
        if ("ready".equals(event)) {
            sdkPreloaded.set(msg.has("sdkPreloaded") && msg.get("sdkPreloaded").getAsBoolean());
            ready.set(true);
            readyLatch.countDown();
            if (lifecycleListener != null) lifecycleListener.onReady();
        } else if ("shutdown".equals(event)) {
            handleDeath();
        }
    }

    private void handleCtrl(JsonObject msg) {
        String action = optString(msg, "action");
        if ("gateway_error".equals(action)) {
            LOG.warn("Gateway error: " + msg);
            handleDeath();
            return;
        }
        // permission_request / ask_user_question_request / plan_approval_request
        if (controlHandler != null) {
            controlHandler.onRequest(action, msg, response -> postIn(response));
        }
    }

    private void routeRequestOutput(JsonObject msg) {
        String id = msg.get("id").getAsString();
        RequestState rs = active.get(id);
        if (rs == null) return;

        if (msg.has("line")) {
            rs.callback.onLine(msg.get("line").getAsString());
        } else if (msg.has("stderr")) {
            rs.callback.onStderr(msg.get("stderr").getAsString());
        } else if (msg.has("done") && msg.get("done").getAsBoolean()) {
            boolean ok = !msg.has("success") || msg.get("success").getAsBoolean();
            String err = optString(msg, "error");
            rs.callback.onDone(ok, err);
            rs.future.complete(ok);
            active.remove(id);
        } else if ("heartbeat".equals(optString(msg, "type"))) {
            // heartbeat 响应，无需特殊处理
        }
    }

    private void onSseClosed(Throwable t) {
        // SseSubscriber 内部已做指数退避重连；
        // 如果重连最终失败（超过最大次数），SseSubscriber 会调这个回调。
        LOG.warn("SSE permanently closed", t);
        handleDeath();
    }

    private void handleDeath() {
        if (alive.compareAndSet(true, false)) {
            ready.set(false);
            readyLatch = new CountDownLatch(1);
            // 把所有 pending future 置失败
            for (RequestState rs : active.values()) {
                rs.callback.onDone(false, "remote daemon died");
                rs.future.complete(false);
            }
            active.clear();
            if (lifecycleListener != null) lifecycleListener.onDeath();
        }
    }

    @Override
    public CompletableFuture<Boolean> sendCommand(String method, JsonObject params,
                                                   DaemonOutputCallback callback) {
        if (!alive.get()) {
            CompletableFuture<Boolean> f = new CompletableFuture<>();
            f.complete(false);
            return f;
        }
        String id = UUID.randomUUID().toString();
        RequestState rs = new RequestState(callback, new CompletableFuture<>());
        active.put(id, rs);

        JsonObject req = new JsonObject();
        req.addProperty("id", id);
        req.addProperty("method", method);
        req.add("params", params);
        postIn(req);
        return rs.future;
    }

    @Override
    public void sendAbort() {
        JsonObject abort = new JsonObject();
        abort.addProperty("id", "abort-" + System.currentTimeMillis());
        abort.addProperty("method", "abort");
        postIn(abort);
    }

    /** 把任意 JSON 写到 daemon stdin（通过 POST /session/{sid}/in）。 */
    private void postIn(JsonObject body) {
        if (sessionId == null) return;
        try {
            http.sendAsync(
                HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/session/" + sessionId + "/in"))
                    .timeout(HTTP_TIMEOUT)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
                    .build(),
                HttpResponse.BodyHandlers.discarding()
            ).exceptionally(e -> {
                LOG.warn("POST /in failed: " + e.getMessage());
                return null;
            });
        } catch (Exception e) {
            LOG.warn("POST /in error", e);
        }
    }

    @Override
    public void stop() {
        alive.set(false);
        if (sseSubscriber != null) sseSubscriber.cancel();
        if (sessionId != null) {
            try {
                http.sendAsync(
                    HttpRequest.newBuilder()
                        .uri(URI.create(baseUrl + "/session/" + sessionId))
                        .timeout(Duration.ofSeconds(5))
                        .DELETE()
                        .build(),
                    HttpResponse.BodyHandlers.discarding()
                );
            } catch (Exception ignored) {}
        }
    }

    @Override public boolean isAlive() { return alive.get(); }
    @Override public boolean ensureRunning() { return isAlive() || start(); }
    @Override public boolean isSdkPreloaded() { return sdkPreloaded.get(); }
    @Override public void setLifecycleListener(DaemonLifecycleListener l) { this.lifecycleListener = l; }
    @Override public void setControlMessageHandler(ControlMessageHandler h) { this.controlHandler = h; }

    private static String optString(JsonObject o, String k) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : null;
    }

    private static class RequestState {
        final DaemonOutputCallback callback;
        final CompletableFuture<Boolean> future;
        RequestState(DaemonOutputCallback cb, CompletableFuture<Boolean> f) {
            this.callback = cb;
            this.future = f;
        }
    }
}
```

代码量：~350 行。

---

## Step 4：新增 `SseSubscriber.java`

**文件**：`src/main/java/com/github/claudecodegui/provider/common/SseSubscriber.java`

SSE 协议格式回顾：
```
id: 42
event: message
data: {"...": "..."}

: heartbeat comment

id: 43
data: ...
```

实现：用 `HttpClient.send` 拿到 InputStream，按行解析；断线后指数退避重连，附 `Last-Event-ID`。

```java
package com.github.claudecodegui.provider.common;

import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

public class SseSubscriber {

    private static final Logger LOG = Logger.getInstance(SseSubscriber.class);
    private static final long INITIAL_BACKOFF_MS = 1000;
    private static final long MAX_BACKOFF_MS = 30_000;
    private static final int MAX_RECONNECT_ATTEMPTS = 20;
    private static final long EVENT_TIMEOUT_MS = 30_000; // 30s 无事件视为断开

    private final URI url;
    private final AtomicLong lastEventId;
    private final Consumer<String> onData;
    private final Consumer<Throwable> onClosed;

    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private volatile Thread workerThread;
    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .version(HttpClient.Version.HTTP_1_1)
        .build();

    public SseSubscriber(URI url, AtomicLong lastEventId,
                         Consumer<String> onData, Consumer<Throwable> onClosed) {
        this.url = url;
        this.lastEventId = lastEventId;
        this.onData = onData;
        this.onClosed = onClosed;
    }

    public void start() {
        workerThread = new Thread(this::loop, "SseSubscriber-" + Integer.toHexString(hashCode()));
        workerThread.setDaemon(true);
        workerThread.start();
    }

    public void cancel() {
        cancelled.set(true);
        if (workerThread != null) workerThread.interrupt();
    }

    private void loop() {
        long backoff = INITIAL_BACKOFF_MS;
        int attempts = 0;
        while (!cancelled.get()) {
            try {
                runOnce();
                if (cancelled.get()) return;
                // 正常断开，重连
                LOG.info("SSE stream closed, reconnecting...");
            } catch (Exception e) {
                if (cancelled.get()) return;
                LOG.warn("SSE error: " + e.getMessage());
                attempts++;
                if (attempts >= MAX_RECONNECT_ATTEMPTS) {
                    onClosed.accept(e);
                    return;
                }
            }
            try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
    }

    private void runOnce() throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder()
            .uri(url)
            .timeout(Duration.ofMinutes(60))     // 长连接
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache");
        long lid = lastEventId.get();
        if (lid > 0) b.header("Last-Event-ID", String.valueOf(lid));

        HttpResponse<java.io.InputStream> resp = http.send(b.GET().build(),
            HttpResponse.BodyHandlers.ofInputStream());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("SSE bad status: " + resp.statusCode());
        }

        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(resp.body(), StandardCharsets.UTF_8))) {

            String currentId = null;
            StringBuilder dataBuf = new StringBuilder();
            long lastEventTime = System.currentTimeMillis();

            String line;
            while (!cancelled.get() && (line = reader.readLine()) != null) {
                lastEventTime = System.currentTimeMillis();

                if (line.isEmpty()) {
                    // 事件结束分隔符
                    if (dataBuf.length() > 0) {
                        if (currentId != null) {
                            try { lastEventId.set(Long.parseLong(currentId)); } catch (NumberFormatException ignored) {}
                        }
                        try { onData.accept(dataBuf.toString()); }
                        catch (Exception e) { LOG.warn("onData handler threw", e); }
                    }
                    currentId = null;
                    dataBuf.setLength(0);
                } else if (line.startsWith(":")) {
                    // comment / heartbeat，忽略
                } else if (line.startsWith("id:")) {
                    currentId = line.substring(3).trim();
                } else if (line.startsWith("event:")) {
                    // 我们只关心 data，event type 忽略
                } else if (line.startsWith("data:")) {
                    if (dataBuf.length() > 0) dataBuf.append('\n');
                    dataBuf.append(line.substring(5).trim());
                }

                if (System.currentTimeMillis() - lastEventTime > EVENT_TIMEOUT_MS) {
                    throw new RuntimeException("SSE event timeout (no events for " + EVENT_TIMEOUT_MS + "ms)");
                }
            }
        }
    }
}
```

代码量：~150 行。

---

## Step 5：`ControlMessageHandler` + `RemotePermissionAdapter`

### 5.1 `ControlMessageHandler` 接口

**文件**：`src/main/java/com/github/claudecodegui/permission/ControlMessageHandler.java`

```java
package com.github.claudecodegui.permission;

import com.google.gson.JsonObject;

import java.util.function.Consumer;

/**
 * Handles _ctrl messages from remote daemon (permission/ask/plan requests).
 * Local mode does not use this; control flows through file IPC instead.
 */
public interface ControlMessageHandler {

    /**
     * @param action       "permission_request" | "ask_user_question_request" | "plan_approval_request"
     * @param request      raw JSON request from daemon
     * @param replySender  callback to send response JSON back to daemon (over POST /in)
     */
    void onRequest(String action, JsonObject request, Consumer<JsonObject> replySender);
}
```

### 5.2 `RemotePermissionAdapter`：把 _ctrl 桥接到现有 PermissionDialog UI

**文件**：`src/main/java/com/github/claudecodegui/permission/RemotePermissionAdapter.java`

关键：本地模式下 PermissionService 通过 PermissionRequestWatcher 监听文件变更，再走 UI 流程；远程模式下我们直接调 PermissionDialog/同等 UI 组件，**不经过文件**。

```java
package com.github.claudecodegui.permission;

import com.google.gson.*;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.function.Consumer;

public class RemotePermissionAdapter implements ControlMessageHandler {

    private static final Logger LOG = Logger.getInstance(RemotePermissionAdapter.class);

    private final Project project;
    private final PermissionDialogRouter router;  // 复用现有 dialog 路由器

    public RemotePermissionAdapter(Project project) {
        this.project = project;
        this.router = project.getService(PermissionDialogRouter.class);
    }

    @Override
    public void onRequest(String action, JsonObject request, Consumer<JsonObject> replySender) {
        switch (action) {
            case "permission_request":          handlePermission(request, replySender); break;
            case "ask_user_question_request":   handleAskUserQuestion(request, replySender); break;
            case "plan_approval_request":       handlePlanApproval(request, replySender); break;
            default:
                LOG.warn("Unknown _ctrl action: " + action);
        }
    }

    private void handlePermission(JsonObject req, Consumer<JsonObject> reply) {
        String requestId = req.get("requestId").getAsString();
        String toolName = req.get("toolName").getAsString();
        JsonObject inputs = req.has("inputs") ? req.getAsJsonObject("inputs") : new JsonObject();
        String cwd = req.has("cwd") ? req.get("cwd").getAsString() : "";

        // 转换成 PermissionRequest 对象（与本地模式同款）
        PermissionRequest pr = new PermissionRequest(requestId, toolName, inputs, cwd);

        ApplicationManager.getApplication().invokeLater(() -> {
            router.showDialog(project, pr, allow -> {
                JsonObject resp = new JsonObject();
                resp.addProperty("type", "_ctrl");
                resp.addProperty("action", "permission_response");
                resp.addProperty("requestId", requestId);
                resp.addProperty("allow", allow);
                reply.accept(resp);
            });
        });
    }

    private void handleAskUserQuestion(JsonObject req, Consumer<JsonObject> reply) {
        String requestId = req.get("requestId").getAsString();
        JsonArray questions = req.has("questions") ? req.getAsJsonArray("questions") : new JsonArray();

        ApplicationManager.getApplication().invokeLater(() -> {
            router.showAskUserQuestionDialog(project, questions, answers -> {
                JsonObject resp = new JsonObject();
                resp.addProperty("type", "_ctrl");
                resp.addProperty("action", "ask_user_question_response");
                resp.addProperty("requestId", requestId);
                resp.add("answers", answers);
                reply.accept(resp);
            });
        });
    }

    private void handlePlanApproval(JsonObject req, Consumer<JsonObject> reply) {
        String requestId = req.get("requestId").getAsString();
        String plan = req.has("plan") ? req.get("plan").getAsString() : "";

        ApplicationManager.getApplication().invokeLater(() -> {
            router.showPlanApprovalDialog(project, plan, (approved, editedPlan) -> {
                JsonObject resp = new JsonObject();
                resp.addProperty("type", "_ctrl");
                resp.addProperty("action", "plan_approval_response");
                resp.addProperty("requestId", requestId);
                resp.addProperty("approved", approved);
                if (editedPlan != null) resp.addProperty("editedPlan", editedPlan);
                reply.accept(resp);
            });
        });
    }
}
```

### 5.3 `PermissionDialogRouter` 扩展（如果原版没有 ask/plan dialog 入口）

检查现有 `PermissionDialogRouter.java`（已存在），看是否已暴露 askUserQuestion / planApproval 的 dialog 方法。如果没有，把现有 PermissionService 内部的对应方法 promote 成 router 上的公开方法即可（无需重写 UI 组件，仅改个调用入口）。

代码量：RemotePermissionAdapter ~120 行 + ControlMessageHandler ~10 行 + Router 适配 ~30 行。

---

## Step 6：`HistoryDataSource` 抽象 + 双实现

### 6.1 接口

**文件**：`src/main/java/com/github/claudecodegui/provider/common/HistoryDataSource.java`

```java
package com.github.claudecodegui.provider.common;

import java.util.List;
import java.util.Optional;

public interface HistoryDataSource {

    List<ProjectInfo> listProjects();

    List<SessionInfo> listSessions(String encodedProjectPath, int limit, int offset);

    Optional<byte[]> readSessionRaw(String encodedProjectPath, String sessionId);

    Optional<SessionLite> readSessionLite(String encodedProjectPath, String sessionId);

    record ProjectInfo(String encodedPath, String displayPath, long mtime, int sessionCount) {}

    record SessionLite(
        String sessionId, String title,
        String firstUserMsg, String lastAssistantMsg,
        int messageCount
    ) {}
}
```

注：`SessionInfo` 复用 `provider/common/SessionInfo.java` 现有定义。

### 6.2 `LocalHistoryDataSource`（包装现有 reader）

**文件**：`src/main/java/com/github/claudecodegui/provider/claude/LocalHistoryDataSource.java`

```java
package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.common.HistoryDataSource;
import com.github.claudecodegui.provider.common.SessionInfo;

import java.util.List;
import java.util.Optional;

public class LocalHistoryDataSource implements HistoryDataSource {

    private final ClaudeHistoryReader reader = new ClaudeHistoryReader();
    private final ClaudeSessionLiteReader liteReader = new ClaudeSessionLiteReader();
    private final ClaudeHistoryIndexService indexService = new ClaudeHistoryIndexService();

    @Override
    public List<ProjectInfo> listProjects() {
        return indexService.listProjects().stream()
            .map(p -> new ProjectInfo(
                java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(p.dirName().getBytes()),
                p.displayPath(), p.mtime(), p.sessionCount()))
            .toList();
    }

    @Override
    public List<SessionInfo> listSessions(String encodedProjectPath, int limit, int offset) {
        String dirName = new String(java.util.Base64.getUrlDecoder().decode(encodedProjectPath));
        return reader.listSessions(dirName, limit, offset);
    }

    @Override
    public Optional<byte[]> readSessionRaw(String encodedProjectPath, String sessionId) {
        String dirName = new String(java.util.Base64.getUrlDecoder().decode(encodedProjectPath));
        return reader.readRaw(dirName, sessionId);
    }

    @Override
    public Optional<SessionLite> readSessionLite(String encodedProjectPath, String sessionId) {
        String dirName = new String(java.util.Base64.getUrlDecoder().decode(encodedProjectPath));
        return liteReader.read(dirName, sessionId)
            .map(l -> new SessionLite(l.sessionId(), l.title(), l.firstUserMsg(), l.lastAssistantMsg(), l.messageCount()));
    }
}
```

⚠️ 假定现有 `ClaudeHistoryReader` / `ClaudeSessionLiteReader` / `ClaudeHistoryIndexService` 已暴露相应方法；如未暴露则补齐方法签名（不需要改实现）。

### 6.3 `RemoteHistoryDataSource`（HTTP 客户端）

**文件**：`src/main/java/com/github/claudecodegui/provider/claude/RemoteHistoryDataSource.java`

```java
package com.github.claudecodegui.provider.claude;

import com.google.gson.*;
import com.github.claudecodegui.provider.common.HistoryDataSource;
import com.github.claudecodegui.provider.common.SessionInfo;
import com.intellij.openapi.diagnostic.Logger;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;

public class RemoteHistoryDataSource implements HistoryDataSource {

    private static final Logger LOG = Logger.getInstance(RemoteHistoryDataSource.class);
    private final String baseUrl;
    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build();

    // 简单 mtime 缓存
    private final Map<String, CacheEntry<List<ProjectInfo>>> projectsCache = new HashMap<>();

    public RemoteHistoryDataSource(String baseUrl) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }

    @Override
    public List<ProjectInfo> listProjects() {
        try {
            JsonArray arr = getJson("/history/projects").getAsJsonArray();
            List<ProjectInfo> out = new ArrayList<>();
            for (JsonElement el : arr) {
                JsonObject o = el.getAsJsonObject();
                out.add(new ProjectInfo(
                    o.get("encodedPath").getAsString(),
                    o.get("displayPath").getAsString(),
                    o.get("mtime").getAsLong(),
                    o.get("sessionCount").getAsInt()
                ));
            }
            return out;
        } catch (Exception e) {
            LOG.warn("listProjects failed", e);
            return List.of();
        }
    }

    @Override
    public List<SessionInfo> listSessions(String encodedProjectPath, int limit, int offset) {
        try {
            String path = "/history/sessions?project=" + urlEnc(encodedProjectPath)
                + "&limit=" + limit + "&offset=" + offset;
            JsonArray arr = getJson(path).getAsJsonArray();
            List<SessionInfo> out = new ArrayList<>();
            for (JsonElement el : arr) {
                JsonObject o = el.getAsJsonObject();
                out.add(SessionInfo.builder()
                    .sessionId(o.get("sessionId").getAsString())
                    .title(o.get("title").getAsString())
                    .startTime(o.get("startTime").getAsLong())
                    .lastTurnTime(o.get("lastTurnTime").getAsLong())
                    .messageCount(o.get("messageCount").getAsInt())
                    .model(o.has("model") ? o.get("model").getAsString() : "")
                    .build());
            }
            return out;
        } catch (Exception e) {
            LOG.warn("listSessions failed", e);
            return List.of();
        }
    }

    @Override
    public Optional<byte[]> readSessionRaw(String encodedProjectPath, String sessionId) {
        try {
            String path = "/history/session?project=" + urlEnc(encodedProjectPath)
                + "&sessionId=" + urlEnc(sessionId);
            HttpResponse<byte[]> resp = http.send(
                HttpRequest.newBuilder().uri(URI.create(baseUrl + path)).GET().build(),
                HttpResponse.BodyHandlers.ofByteArray());
            if (resp.statusCode() != 200 && resp.statusCode() != 206) return Optional.empty();
            return Optional.of(resp.body());
        } catch (Exception e) {
            LOG.warn("readSessionRaw failed", e);
            return Optional.empty();
        }
    }

    @Override
    public Optional<SessionLite> readSessionLite(String encodedProjectPath, String sessionId) {
        try {
            String path = "/history/session-lite?project=" + urlEnc(encodedProjectPath)
                + "&sessionId=" + urlEnc(sessionId);
            JsonObject o = getJson(path).getAsJsonObject();
            return Optional.of(new SessionLite(
                o.get("sessionId").getAsString(),
                o.get("title").getAsString(),
                o.has("firstUserMsg") ? o.get("firstUserMsg").getAsString() : "",
                o.has("lastAssistantMsg") ? o.get("lastAssistantMsg").getAsString() : "",
                o.has("messageCount") ? o.get("messageCount").getAsInt() : 0
            ));
        } catch (Exception e) {
            LOG.warn("readSessionLite failed", e);
            return Optional.empty();
        }
    }

    private JsonElement getJson(String path) throws Exception {
        HttpResponse<String> resp = http.send(
            HttpRequest.newBuilder().uri(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(15)).GET().build(),
            HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) throw new RuntimeException("HTTP " + resp.statusCode());
        return JsonParser.parseString(resp.body());
    }

    private static String urlEnc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private record CacheEntry<T>(T value, long mtime) {}
}
```

代码量：LocalHistoryDataSource ~80 行 + RemoteHistoryDataSource ~200 行。

---

## Step 7：`CodemossSettingsService` 加字段

**文件**：`src/main/java/com/github/claudecodegui/settings/CodemossSettingsService.java`

加两个字段：

```java
@State(
    name = "CodemossSettings",
    storages = @Storage("codemoss-settings.xml")
)
public class CodemossSettingsService implements PersistentStateComponent<CodemossSettingsService.State> {

    public static class State {
        // ... 已有字段

        // 【新增】
        public String daemonMode = "local";        // "local" | "remote"
        public String remoteServerUrl = "http://localhost:3284";
    }

    public boolean isRemoteMode() {
        return "remote".equals(state.daemonMode);
    }
    public String getRemoteServerUrl() { return state.remoteServerUrl; }
    public void setDaemonMode(String mode) { state.daemonMode = mode; }
    public void setRemoteServerUrl(String url) { state.remoteServerUrl = url; }
}
```

---

## Step 8：`RemoteModeContext` + 各面板灰态

### 8.1 `RemoteModeContext`

**文件**：`src/main/java/com/github/claudecodegui/settings/RemoteModeContext.java`

```java
package com.github.claudecodegui.settings;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;

@Service
public final class RemoteModeContext {

    public static RemoteModeContext getInstance() {
        return ApplicationManager.getApplication().getService(RemoteModeContext.class);
    }

    public boolean isRemote() {
        return CodemossSettingsService.getInstance().isRemoteMode();
    }

    public String unsupportedTooltip() {
        return "远程模式下不支持，请在容器镜像内配置";
    }
}
```

### 8.2 各面板灰态适配

**Settings UI（API key / base URL）**：
找现有的 settings panel（webview 或 Java），在渲染时检查 `RemoteModeContext.isRemote()`，是则把字段 `setEnabled(false)` + 显示提示。

**MCP/Skills/Provider 面板**：在 webview 入口（如 `webview/src/components/settings/McpServerSection.tsx`）加：

```tsx
const remote = useRemoteMode();   // 新增 hook，从 IDE 状态读
if (remote) {
  return <DisabledSection title="MCP 服务器" tooltip="远程模式下不支持，请在容器内配置 ~/.claude.json" />;
}
// ... 原有渲染
```

**Rewind action**：

```java
public class RewindAction extends AnAction {
    @Override
    public void update(AnActionEvent e) {
        e.getPresentation().setEnabled(!RemoteModeContext.getInstance().isRemote());
        if (RemoteModeContext.getInstance().isRemote()) {
            e.getPresentation().setDescription("远程模式下不支持 Rewind");
        }
    }
}
```

**附件 / 图片粘贴**：在输入框组件检查 `isRemote()`，是则隐藏附件按钮 + 拦截粘贴图片事件。

代码量：~200 行（含 webview 多个面板的条件渲染）。

---

## Step 9：Settings 加 RemoteServerSection

**文件**：`webview/src/components/settings/RemoteServerSection/index.tsx`

```tsx
import React, { useState } from 'react';

export function RemoteServerSection({ settings, onChange }) {
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');

  async function testConnection() {
    setTestStatus('testing');
    try {
      const res = await fetch(settings.remoteServerUrl + '/health');
      const json = await res.json();
      if (json.status === 'ok') {
        // 再试 POST /session 验证 daemon 能 spawn
        const sess = await fetch(settings.remoteServerUrl + '/session', { method: 'POST' });
        const { sessionId } = await sess.json();
        await fetch(settings.remoteServerUrl + '/session/' + sessionId, { method: 'DELETE' });
        setTestStatus('ok');
        setTestMsg('连接正常 ✓');
      } else {
        setTestStatus('fail');
        setTestMsg('健康检查失败');
      }
    } catch (e: any) {
      setTestStatus('fail');
      setTestMsg(e.message);
    }
  }

  return (
    <section>
      <h3>远程模式</h3>
      <label>
        模式：
        <select value={settings.daemonMode} onChange={e => onChange({ daemonMode: e.target.value })}>
          <option value="local">本地</option>
          <option value="remote">远程</option>
        </select>
      </label>
      {settings.daemonMode === 'remote' && (
        <>
          <label>
            服务地址：
            <input
              type="url"
              placeholder="http://192.168.1.100:3284"
              value={settings.remoteServerUrl}
              onChange={e => onChange({ remoteServerUrl: e.target.value })}
            />
          </label>
          <button onClick={testConnection} disabled={testStatus === 'testing'}>
            {testStatus === 'testing' ? '测试中…' : '测试连接'}
          </button>
          {testStatus !== 'idle' && <div className={`test-${testStatus}`}>{testMsg}</div>}
          <p className="hint">
            ⚠️ 远程模式下，Settings/MCP/Skills/Provider/Rewind 不可用，请在容器镜像内预配置。
          </p>
        </>
      )}
    </section>
  );
}
```

代码量：~150 行（含样式）。

---

## Step 10：`ClaudeSDKBridge` 工厂改造

**文件**：`src/main/java/com/github/claudecodegui/provider/claude/ClaudeSDKBridge.java`

定位：当前应该是 `new DaemonBridge(...)` 的位置。改成：

```java
public class ClaudeSDKBridge {

    private final IBridge bridge;
    private final HistoryDataSource history;

    public ClaudeSDKBridge(/* existing deps */) {
        var settings = CodemossSettingsService.getInstance();
        boolean remote = settings.isRemoteMode();

        if (remote) {
            this.bridge = new RemoteBridge(settings.getRemoteServerUrl());
            this.history = new RemoteHistoryDataSource(settings.getRemoteServerUrl());
        } else {
            this.bridge = new LocalBridge(/* existing args */);
            this.history = new LocalHistoryDataSource();
        }

        // 注入控制消息处理器（仅远程模式生效；本地模式 setControlMessageHandler 是 noop）
        bridge.setControlMessageHandler(new RemotePermissionAdapter(project));
    }

    public IBridge getBridge() { return bridge; }
    public HistoryDataSource getHistory() { return history; }
    // ... 其他原有方法保持不变
}
```

`CodexSDKBridge` 同理。

⚠️ 切换 mode 时需要重启插件 / 重建 ClaudeSDKBridge 实例——可以加一个监听器，settings 变更后调 `bridge.stop()` + 重建。

代码量：工厂 ~30 行。

---

## Step 11：测试要点

### 11.1 本地模式回归（最重要！）

切换 settings.daemonMode = "local"，跑全部现有测试用例：
- 对话流
- 文件 IPC permission（`/tmp/claude-permission` 写文件）
- AskUserQuestion / Plan approval
- 历史会话面板
- Rewind / Skills / MCP / Provider 编辑

**预期**：与改造前**完全一致**，无任何回归。

### 11.2 远程模式核心路径

启动 ai-bridge-server（本机或 docker），settings 切换 remote：

- [ ] 测试连接按钮能成功（health + session create + delete）
- [ ] 发送一条 "Hi"，能收到完整 streaming 响应
- [ ] 触发 Edit 工具 → 弹权限对话框 → 同意/拒绝都能正确传回
- [ ] AskUserQuestion 能弹问答 → 答案传回
- [ ] Plan 模式 → 弹审批 → approved/edited 传回
- [ ] 历史面板能列出容器内 `~/.claude/projects/` 下的会话
- [ ] 点击历史会话能 resume
- [ ] Settings/MCP/Skills/Provider 面板正确灰态
- [ ] Rewind 按钮禁用
- [ ] 网络断开后自动重连，事件不丢
- [ ] 容器内 daemon 崩溃 → 插件感知到 dead，UI 提示

### 11.3 UI 灰态验证

切到远程模式，逐一检查：
- 各 settings 编辑区是 disabled
- MCP / Skills / Provider 面板显示"远程模式下不支持"
- Rewind action 灰
- 附件按钮隐藏

---

## 总结：插件侧改动量

| 模块 | 类型 | 行数 |
|---|---|---|
| `IBridge.java` | 新增 | ~40 |
| `LocalBridge.java`（DaemonBridge 改名 + implements） | 修改 | +30（仅声明） |
| `RemoteBridge.java` | 新增 | ~350 |
| `SseSubscriber.java` | 新增 | ~150 |
| `ControlMessageHandler.java` | 新增 | ~10 |
| `RemotePermissionAdapter.java` | 新增 | ~120 |
| `PermissionDialogRouter` 适配 | 修改 | ~30 |
| `HistoryDataSource.java` | 新增 | ~30 |
| `LocalHistoryDataSource.java` | 新增 | ~80 |
| `RemoteHistoryDataSource.java` | 新增 | ~200 |
| `CodemossSettingsService` 加字段 | 修改 | ~30 |
| `RemoteModeContext.java` | 新增 | ~30 |
| 各面板灰态适配（webview + Java） | 修改 | ~200 |
| `RemoteServerSection.tsx` | 新增 | ~150 |
| `ClaudeSDKBridge` 工厂逻辑 | 修改 | ~30 |
| `CodexSDKBridge` 工厂逻辑 | 修改 | ~30 |
| 测试 | 新增 | ~300 |
| **新增合计** | | **~1490** |
| **修改合计** | | **~350** |

**关键保证**：
- ai-bridge/ 目录**零修改**，daemon.js / permission-handler.js / permission-ipc.js 全部原样保留
- DaemonBridge → LocalBridge **只改类名 + 实现接口**，业务逻辑 0 行变动
- 本地模式调用链与改造前**完全等价**，零回归风险

---

## 附录：实施顺序建议

按依赖关系：

1. **D0** ai-bridge-server 跑通（IMPL-SERVER.md Step 1-7）—— 0.5d × 2 = 1d
2. **P0** 加 IBridge 接口 + DaemonBridge → LocalBridge 改名（本地模式回归测试）—— 0.5d
3. **P1** SseSubscriber + RemoteBridge —— 1d
4. **P2** ControlMessageHandler + RemotePermissionAdapter + Router 适配 —— 0.5d
5. **P3** HistoryDataSource + Local/Remote 实现 —— 1d
6. **P4** Settings UI + RemoteModeContext + 灰态 —— 0.5d
7. **P5** ClaudeSDKBridge / CodexSDKBridge 工厂改造 —— 0.5d
8. **P6** 联调 + 边界测试 —— 1d

**插件侧合计：~5 天**（不含 server 侧 1d，已在 IMPL-SERVER.md 估）

总计 server + plugin = **~6 天**。
