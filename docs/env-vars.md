# 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PI_WEB_PORT` | `8787` | HTTP 端口（旧名 `PORT` 兼容） |
| `PI_WEB_CWD` | `process.cwd()` | 智能体工作区（读/写/终端都以此为根） |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | 每客户端持久化 UI 状态（client-state.json，最近项目/工作目录）；对话会话放 SDK 默认目录 `<agentDir>/sessions/--<cwd>--/`（与 pi CLI/TUI 共享同一对话列表） |
| `PI_WEB_INLINE_FILE_MAX` | `12288` (12KB) | inline 附件的内联阈值，超过自动降级为路径引用 |
| `PI_WEB_TOOL_TIMEOUT_MS` | `1200000` (20 分钟) | 单个工具调用最长执行时长，超时看门狗自动 abort 会话（防挂死） |
| `PI_WEB_VISION_TIMEOUT_MS` | `90000` | 视觉桥单次转写（整批图片）超时，防止慢视觉模型拖住 prompt |
| `PI_WEB_STALL_NOTIFY_MS` | `180000` | 模型无进展看门狗：流式运行中 N 毫秒无任何 SDK 事件则发 warning 提示可能失联（不自动 abort——深度思考可合法静默数分钟）；0 = 关闭 |
| `PI_WEB_TERMINAL_IDLE_MS` | `15000` | 终端活力检测：agent 触碰过的终端连续 N 毫秒无输出且该对话正在运行时，自动注入 steer 消息提醒 AI 检查；0 = 关闭 |
| `PI_WEB_UPLOAD_RETENTION_DAYS` | `14` | 上传文件保留天数（`<dataDir>/uploads/`，启动时扫一次 + 每 6 小时一次）；0 = 关闭清理 |
| `PI_WEB_SHELL` | 自动探测 | Windows 终端面板（node-pty）的 shell：默认优先 Git Bash（与 SDK bash 工具一致），可用此变量显式指定（如 `powershell.exe` / `cmd.exe`） |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi 配置目录（auth.json / models.json / skills） |
| `PI_WEB_HOST` | `127.0.0.1` | 监听地址。**默认只绑 loopback**（本地个人工具，不暴露到网络）；局域网/容器访问需显式 `0.0.0.0`（docker-compose 已内置） |
| `PI_WEB_ALLOW_ORIGINS` | 空 | 逗号分隔的额外 Origin 白名单（如 `http://localhost:5173` dev 代理、反代场景），用于绕过 WS 的 Origin/Host 同权威校验 |
| `PI_WEB_ALLOW_HOSTS` | 空 | 可选严格模式：设置了才启用，请求 Host 的 hostname 必须在此白名单（逗号分隔） |
| `PI_WEB_TOKEN` | 空 | **可选共享口令鉴权**：设置后所有 HTTP/WS 请求必须携带（`Authorization: Bearer` / `X-PI-Token` 头、`?token=` 参数或 `pi_web_token` cookie 任一匹配；浏览器首次经 `?token=xxx` 进入后存 localStorage 并下发 HttpOnly cookie）；`/api/health` 保持开放供探针。前端 `web/src/auth-token.ts` 统一注入；回归：`tests/token-auth-test.mjs`（端口 8975） |
| `UA_TELEMETRY_HTTP` | `http://127.0.0.1:8765` | Observe 只读遥测上游。只接受 loopback `http://` origin；拒绝凭据、路径、query、fragment。配置无效时主 UI 继续启动，`/api/observe/*` 返回 503。 |

## Observe 遥测限制

- `/api/observe/*` 只允许 GET。代理最多并发 16 个上游请求；header 超时 5 秒，JSON body 超时 10 秒，SSE 空闲超时 35 秒。
- 原始 query 最长 2048 字符。`limit` 范围为 1..1000；筛选值最长 256 字符；`Last-Event-ID` 最长 64 字符。JSON 响应最多 16 MiB。
- 浏览器首次连接及普通重连通过反向分页加载最新记录。每页最多 1000 个，内存最多保留 10000 条。旧 cursor 高于当前上游 high-water 时，浏览器清除旧投影并从当前 high-water 继续。
- 原始事件不写入浏览器存储。浏览器只持有内存投影；显示字符串超过 65536 个 UTF-16 code units、标识符超过 256 个 code units、过深或过宽结构时保留前缀并追加 `[TRUNCATED]`。事件 sequence 仍会推进 cursor。
- `PI_WEB_TOKEN` 通过现有 `withToken` bootstrap 或 HttpOnly cookie 送到 Pi Web 服务。Observe 代理在转发到遥测 core 前移除 token。
