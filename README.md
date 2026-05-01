# ai-bridge-server

> jetbrains-cc-gui 插件的远程 daemon 服务。把本地 stdio 协议的 ai-bridge 包装成 HTTP + SSE，让 IDE 通过网络远程调用。
>
> 主对话走 `POST /session/{id}/in` + SSE `/session/{id}/events`；历史走 HTTP `/history/*`；权限/AskUser/Plan 走 stdio `_ctrl` 三通道（透传到 SSE）。

完整设计见 [`DESIGN.md`](./DESIGN.md)，server 实现细节见 [`IMPL-SERVER.md`](./IMPL-SERVER.md)，插件改造见 [`IMPL-PLUGIN.md`](./IMPL-PLUGIN.md)。

---

## 1. 前置要求

| 项 | 要求 | 备注 |
|---|---|---|
| Node.js | **>= 20** | `node --version` 检查 |
| Claude CLI / SDK | 已安装 | `npm i -g @anthropic-ai/claude-code` |
| `~/.claude/settings.json` | 含有效 API key | 同本地用 claude code 的配置 |
| 端口 | 默认 3284 | 可通过 `PORT` 环境变量改 |
| OS | macOS / Linux / Windows (WSL) | daemon.js 跨平台 |

部署机上的项目目录路径**必须与 IDE 客户端一致**（这是远程模式的核心约束，详见 `DESIGN.md` §0）。

---

## 2. 快速开始

### 2.1 Clone 启动（开发 / 本地试跑）

```bash
# 1. clone（假设 ai-project 已克隆，本目录在 ai-project/ai-bridge-server）
cd /path/to/ai-project/ai-bridge-server

# 2. 装依赖（首次）
npm install

# 3. 启动
node src/server.js
# 或：
npm start
```

启动成功会看到：

```
[2026-04-30T...][INFO] ai-bridge-server v1.0.0 listening on http://0.0.0.0:3284
[2026-04-30T...][INFO] History root: /Users/you/.claude/projects
[2026-04-30T...][INFO] Idle timeout: 60000ms
```

### 2.2 调试模式

```bash
LOG_LEVEL=debug npm run dev
```

---

## 3. 配置

所有配置走环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3284` | HTTP 端口 |
| `HOST` | `0.0.0.0` | 监听地址；只想本机访问可改 `127.0.0.1` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `SESSION_IDLE_TIMEOUT_MS` | `60000` | 无 SSE 订阅多久后 kill daemon |
| `HISTORY_ROOT` | `~/.claude/projects` | `/history/*` 端点扫描的根目录 |
| `HOME` | (系统默认) | daemon 内 `os.homedir()` 解析点；远程部署常需明确设置 |

示例：

```bash
PORT=3300 LOG_LEVEL=debug HOME=/var/lib/aibridge node src/server.js
```

`~/.claude/settings.json` 里的 API key、proxy、permission 白名单等照常生效——daemon 启动时自动读。

---

## 4. 测试

### 4.1 用浏览器测试页面（推荐）

仓库根目录提供 [`test.html`](./test.html)，包含完整的交互式调试 UI：

```bash
# 方式 A：直接 file:// 打开
open test.html        # macOS
xdg-open test.html    # Linux

# 方式 B：随便起个静态服务（避免某些浏览器对 file:// + EventSource 的限制）
cd /path/to/ai-bridge-server
npx serve .           # 然后访问 http://localhost:3000/test.html
# 或 python3 -m http.server 8000
```

页面功能：

- **左栏**：服务连接 / Session 生命周期 / 快捷命令（heartbeat、abort、shutdown）/ 历史浏览
- **右上**：POST 发送区（含 5 种预设，下拉直接选）
- **右下**：SSE 实时接收区，自动识别 `_ctrl` 消息
  - `permission_request` → 显示"允许 / 拒绝"按钮
  - `ask_user_question_request` → 输入框 + 选项按钮 + 提交
  - `plan_approval_request` → "批准 / 拒绝"按钮
  - 点击后自动 POST 回响应

#### 最小验证流程

1. 启动 server `node src/server.js`
2. 打开 `test.html`
3. 点 **/health** → 服务连接灯变绿
4. 点 **创建 Session** → 拿到 sessionId
5. 点 **订阅 SSE** → 接收灯变绿 + 看到 daemon ready 事件
6. 点快捷命令 **heartbeat** → SSE 区出现 heartbeat 响应
7. 在右上选预设 **claude.send** → 点 **发送** → 看流式输出
8. 任何工具调用触发权限弹窗时 → 在 SSE 区点"允许"按钮 → 看到对话继续

### 4.2 用 curl 测试

```bash
# 1. 健康检查
curl http://localhost:3284/health
# → {"status":"ok"}

curl http://localhost:3284/version
# → {"version":"1.0.0","daemonVersion":"1.0.0"}

# 2. 创建 session
SID=$(curl -s -X POST http://localhost:3284/session | sed 's/.*"sessionId":"\([^"]*\)".*/\1/')
echo "session: $SID"

# 3. 后台订阅 SSE
curl -N http://localhost:3284/session/$SID/events &
SSE_PID=$!

# 4. 发心跳
curl -s -X POST http://localhost:3284/session/$SID/in \
     -H 'Content-Type: application/json' \
     -d '{"id":"r1","method":"heartbeat"}'
# 上面 curl -N 应该看到一行 data: {"id":"r1","type":"heartbeat","ts":...}

# 5. 列历史项目
curl -s http://localhost:3284/history/projects | head -c 500

# 6. 关闭
kill $SSE_PID
curl -s -X DELETE http://localhost:3284/session/$SID
```

### 4.3 联调清单（验证全部功能）

- [ ] `POST /session` 返回 sessionId，SSE 收到 `daemon/ready` 事件
- [ ] `claude.send` 流式输出能完整收到（thinking / content_delta / tool_use / done）
- [ ] 三通道权限：daemon 发 `_ctrl/*_request`，POST `/in` 回 `_ctrl/*_response`，请求继续
- [ ] SSE 断开后浏览器自动重连（带 `Last-Event-ID`），事件不丢
- [ ] 60s 无 SSE → daemon 被 kill（看 server 日志）
- [ ] `/history/projects` 列出 `~/.claude/projects/` 下的目录
- [ ] `/history/session?...` 含 Range 请求返回正确字节区间
- [ ] path-guard 拒绝 `?project=Li4v` (base64url of "../") → 403
- [ ] daemon 崩溃 → SSE 收到 `gateway_error code=DAEMON_DOWN`

---

## 5. 打包发布

### 5.1 用 tar 打包整个目录（最简单）

```bash
cd /path/to/ai-project/ai-bridge-server
npm ci --omit=dev          # 装好 prod 依赖
cd ..
tar --exclude='ai-bridge-server/.git' \
    --exclude='ai-bridge-server/node_modules/.cache' \
    -czf ai-bridge-server-1.0.0.tar.gz ai-bridge-server/
```

到目标机器解压：

```bash
tar -xzf ai-bridge-server-1.0.0.tar.gz
cd ai-bridge-server
node src/server.js
```

> 如果目标机器还要 `npm install`，那就别打包 node_modules，让对方自己装。

### 5.2 用 `npm pack` 打 tarball

```bash
npm pack
# 生成 ai-bridge-server-1.0.0.tgz
```

到目标机器：

```bash
tar -xzf ai-bridge-server-1.0.0.tgz
cd package
npm install --omit=dev
node src/server.js
```

### 5.3 制作单文件可执行（可选）

用 `@yao-pkg/pkg`（Node 20 兼容）打成单二进制：

```bash
npm i -g @yao-pkg/pkg
pkg . --out-path dist/ --targets node20-linux-x64,node20-macos-x64,node20-win-x64
# 生成 dist/ai-bridge-server-{linux,macos,win}.exe
```

⚠️ 注意：`ai-bridge/daemon.js` 是子进程动态 spawn 的脚本，pkg 默认不会把它打进二进制——需要在 `package.json` 加 `pkg.assets`：

```json
{
  "pkg": {
    "assets": ["ai-bridge/**/*.js", "ai-bridge/**/*.json"],
    "scripts": ["ai-bridge/**/*.js"]
  }
}
```

且运行时 `DAEMON_PATH` 在 pkg 模式下要解析到二进制旁边的 ai-bridge，参见 pkg 的 `process.pkg` API。**实际生产建议走 5.1 / 5.2 路径**，简单可靠。

### 5.4 用 git 直接拉

不打包也行，目标机器：

```bash
git clone <你的 fork> ai-bridge-server
cd ai-bridge-server
npm ci --omit=dev
node src/server.js
```

---

## 6. 生产部署

不用 Docker 的几种常见方式：

### 6.1 systemd（Linux）

`/etc/systemd/system/ai-bridge-server.service`：

```ini
[Unit]
Description=ai-bridge-server (remote daemon for jetbrains-cc-gui)
After=network.target

[Service]
Type=simple
User=devuser
Group=devuser
WorkingDirectory=/opt/ai-bridge-server
Environment=PORT=3284
Environment=LOG_LEVEL=info
Environment=SESSION_IDLE_TIMEOUT_MS=60000
Environment=HOME=/home/devuser
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-bridge-server
sudo systemctl status ai-bridge-server
journalctl -u ai-bridge-server -f
```

### 6.2 pm2（跨平台）

```bash
npm i -g pm2
cd /opt/ai-bridge-server
pm2 start src/server.js --name ai-bridge-server \
    --max-memory-restart 500M \
    --time
pm2 save
pm2 startup            # 跟提示注册开机自启
```

也可以写 `ecosystem.config.cjs`：

```js
module.exports = {
  apps: [{
    name: 'ai-bridge-server',
    script: 'src/server.js',
    cwd: '/opt/ai-bridge-server',
    env: {
      PORT: 3284,
      LOG_LEVEL: 'info',
      SESSION_IDLE_TIMEOUT_MS: 60000,
    },
    max_memory_restart: '500M',
    autorestart: true,
  }]
};
```

### 6.3 launchd（macOS）

`~/Library/LaunchAgents/com.codemoss.ai-bridge-server.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>           <string>com.codemoss.ai-bridge-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/ai-bridge-server/src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/opt/ai-bridge-server</string>
  <key>RunAtLoad</key>       <true/>
  <key>KeepAlive</key>       <true/>
  <key>StandardOutPath</key> <string>/tmp/ai-bridge-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/ai-bridge-server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>          <string>3284</string>
    <key>LOG_LEVEL</key>     <string>info</string>
  </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.codemoss.ai-bridge-server.plist
launchctl list | grep ai-bridge
```

### 6.4 nohup（应急 / 临时）

```bash
cd /opt/ai-bridge-server
nohup node src/server.js > /tmp/ai-bridge-server.log 2>&1 &
echo $! > /tmp/ai-bridge-server.pid
# 关停
kill $(cat /tmp/ai-bridge-server.pid)
```

### 6.5 反向代理（可选）

如果要走 nginx，**必须**关闭 SSE 缓冲：

```nginx
server {
  listen 80;
  server_name ai-bridge.your-domain.com;

  location / {
    proxy_pass http://127.0.0.1:3284;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # SSE 关键三件套
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding on;

    # 长连接
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
  }
}
```

---

## 7. 故障排查

| 现象 | 可能原因 | 解决 |
|---|---|---|
| `Error: Cannot find module '@anthropic-ai/claude-code'` | claude SDK 没装 | `npm i -g @anthropic-ai/claude-code` |
| `POST /session` 返回 500 spawn failed | node / daemon.js 路径找不到 | 检查 `which node`，确保 `ai-bridge/daemon.js` 存在 |
| SSE 一直没 daemon ready | API key 缺失 / 错误 | 看 server 日志的 daemon stderr，检查 `~/.claude/settings.json` |
| 浏览器测试页 SSE 立刻断开 | nginx / 反代缓冲 | 加 `proxy_buffering off` 等 |
| 60s 后 daemon 自动死 | idle timeout | SSE 必须保持订阅；或调大 `SESSION_IDLE_TIMEOUT_MS` |
| `/history/projects` 返回 `[]` | `~/.claude/projects/` 不存在或为空 | 先在该机器上跑过一次 claude code 才会有 |
| 工具调用永远卡在权限弹窗 | client 没回 `_ctrl/*_response` | 用 `test.html` 的 `_ctrl` 弹框点确认；插件场景检查 RemotePermissionAdapter 配置 |
| `host`/容器路径不一致导致 Read 失败 | 部署机上没有同名项目目录 | 项目路径 host ↔ 部署机必须完全相同 |
| 上游 ai-bridge 改了，要同步 | | `./scripts/sync-from-upstream.sh`（默认 dry-run，加 `--apply` 真改） |

### 看日志

```bash
# Direct
node src/server.js 2>&1 | tee server.log

# systemd
journalctl -u ai-bridge-server -f

# pm2
pm2 logs ai-bridge-server
```

### 验证 daemon 能独立跑

排查"server 起来了但 daemon 起不来"时：

```bash
cd /path/to/ai-bridge-server
node ai-bridge/daemon.js
# 应该立即看到 stdout 一行 {"type":"daemon","event":"ready",...}
# Ctrl-D 关闭
```

---

## 8. API 速查

### Session

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/session` | 创建 session，返回 `{sessionId, pid}` |
| `GET`  | `/session/{id}/events` | SSE 事件流（支持 `Last-Event-ID` 重连） |
| `POST` | `/session/{id}/in` | 写一行 JSON 到 daemon stdin |
| `DELETE` | `/session/{id}` | 关闭 daemon |
| `GET`  | `/sessions` | 列出活跃 session（调试用） |

### History（只读）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/history/projects` | 列项目 |
| `GET` | `/history/sessions?project=<encodedPath>&limit=&offset=` | 列会话 |
| `GET` | `/history/session?project=&sessionId=` | 读 jsonl 流（支持 Range） |
| `GET` | `/history/session-lite?project=&sessionId=` | 读会话 lite 元数据 |

### 通用

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | `{"status":"ok"}` |
| `GET` | `/version` | `{version, daemonVersion}` |

完整协议（含 `_ctrl` 三通道消息表）见 `DESIGN.md` 附录 B。

---

## 9. 目录结构

```
ai-bridge-server/
├── DESIGN.md                  ← 架构设计 v3
├── IMPL-SERVER.md             ← server 编码细节
├── IMPL-PLUGIN.md             ← 插件改造细节
├── README.md                  ← 本文档
├── test.html                  ← 浏览器测试台
├── package.json
├── src/                       ← HTTP/SSE 服务层
│   ├── server.js              入口
│   ├── session-manager.js     session 生命周期
│   ├── sse-hub.js             SSE 推送 + ring buffer
│   ├── history-server.js      /history/* 端点
│   ├── path-guard.js          路径白名单
│   └── logger.js
├── ai-bridge/                 ← copy 自 jetbrains-cc-gui/ai-bridge
│   ├── daemon.js              已改：加 _ctrl 路由
│   ├── permission-ipc.js      已重写：stdio _ctrl IPC
│   └── (其他业务文件零改动)
├── scripts/
│   ├── start.sh
│   └── sync-from-upstream.sh  (从上游同步 ai-bridge 更新)
└── docker/                    (可选；非容器部署可忽略)
    ├── Dockerfile
    └── docker-compose.yml
```

---

## 10. 协议核心约束（再次强调）

- 项目目录路径在客户端机器（host）与 server 部署机器**必须一致** —— 这是远程模式工具调用（Read/Edit/Bash/Glob/Grep）能正常工作的前提
- `~/.claude` / `~/.codemoss` 在 server 部署机器**独立维护** —— Settings/MCP/Skills/Provider 等管理在远程模式下不可在 IDE 在线编辑（容器/部署机预配）
- Checkpoint / Rewind 远程模式不支持
- 一期不支持文件附件 / 图片粘贴（二期通过 `/upload` 加）

详见 `DESIGN.md` §0、§1.2。
