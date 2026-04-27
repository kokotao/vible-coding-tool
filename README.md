# vible-coding-Tool

一个用于连接 `Codex / Claude` 等 vibe coding 工具与飞书、QQ 机器人的双向网关服务。

## 当前进度

- 已完成 `Task 1`：Fastify + TypeScript 服务骨架
- 已完成 `Task 2`：SQLite 初始化与基础仓储层

## 本地运行

1. `cp .env.example .env`
2. `npm install`
3. `npm run dev`
4. 打开 `http://127.0.0.1:3000/health`

## 飞书长连接模式（无需公网 webhook）

1. 先启动网关：`npm run dev`
2. 在飞书后台选择“使用长连接接收事件”，并订阅 `im.message.receive_v1`
3. 启动桥接器：`npm run feishu:ws`
4. 在飞书后台点击“重新验证”

说明：

- 桥接器优先读取环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
- 若未设置，则自动读取网关中的 `/api/connectors/feishu/config`
- 可通过 `GATEWAY_URL` 指定网关地址，默认 `http://127.0.0.1:3000`
- 若网关配置了 `FEISHU_VERIFY_TOKEN`，请在启动桥接器时同时提供相同值

## Codex 任务自动回推（执行即上报）

当你希望“任务执行完自动推送到飞书”时，使用 `codex:run` 包装执行命令：

```bash
npm run codex:run -- --session feishu-codex-demo --title "修复登录接口" -- npm run test
```

说明：

- 该命令会自动上报 `running` -> `succeeded/failed` 到 `/api/codex/events`
- 默认会尝试复用该 `session` 下最新 `running` 任务（由飞书 `#session` 指令创建）
- 可通过 `--task <taskId>` 指定任务
- 可通过 `--gateway <url>` 指定网关地址
- 若配置了 ingress 安全，可用环境变量：
  - `CODEX_INGRESS_TOKEN`
  - `CODEX_INGRESS_SIGNING_SECRET`

## 飞书对话固定指令格式（线程定向）

网关现已支持飞书消息直接下发到指定 Codex 线程执行，推荐格式：

```text
线程 ID：<机器人回推里的线程ID字段>，任务内容：<你的任务指令>
```

示例：

```text
线程 ID：019dca61-0d90-7f01-b1b0-f1bb79eb955e，任务内容：完成我所说的需求进行下一步
```

说明：

- 当前飞书对话会自动复用该发送人的最近会话，默认不需要重复带 `#session`
- 首次对话若还未建立会话，可先发一次 `#session:<id> <任务>` 完成绑定
- 网关会优先解析 `线程 ID` 字段中的完整 thread UUID；若只有简写前缀（例如 `019dca59-发布线程`），会在本机 `~/.codex/sessions` 扫描结果中做唯一匹配
- 也支持直接粘贴 rollout 文件名：`线程 ID：rollout-2026-04-26T23-12-34-019dca59-78b8-7d10-88fd-b6f9b8a7c409.jsonl`
- 高风险命令仍会进入确认流，确认后自动继续下发到 Codex 执行

## 本地会话扫描与年月日分类展示

网关会定时扫描本机 `~/.codex/sessions`，并按目录结构 `YYYY/MM/DD` 聚合展示 rollout 会话：

- 接口：`GET /api/codex/local-sessions?limit=1000&refresh=false`
- 返回：`items`（扁平列表） + `groups`（按年/月/日分组）
- 每条会话包含：`threadId`、`rolloutFileName`、`rolloutPath`、`year/month/day`、`updatedAt`

可选环境变量：

- `CODEX_LOCAL_SESSIONS_SCAN_ENABLED=true|false`
- `CODEX_LOCAL_SESSIONS_ROOT=~/.codex/sessions`
- `CODEX_LOCAL_SESSIONS_SCAN_INTERVAL_MS=15000`

## Codex 全局自动回推（任何任务完成即上报）

网关启动后会默认自动拉起全局 watcher，把当前这台机器上的 Codex 完成事件回推到飞书。

如果你想单独手动启动 watcher，也可以直接运行：

```bash
npm run codex:watch -- --session feishu-codex-demo --recipientOpenId <你的open_id>
```

说明：

- watcher 监听 `~/.codex/sessions` 下 `rollout-*.jsonl` 的 `task_complete` 事件
- 默认 `--bootstrap tail`，首次启动只跟踪后续新增事件，不会回放历史
- `--session` 可指定统一回推会话（建议与你飞书里 `#session:<id>` 一致）
- `--recipientOpenId` 会作为发送者标识上报，网关可自动识别并回推给该用户
- 如果不传 `--recipientOpenId`，watcher 会先去网关读取 `/api/feishu/open-ids/recent` 的最新 open_id，再作为回推目标
- 状态文件默认写入 `./data/codex-watcher-state.json`，用于断点续扫去重
- 常用参数：
  - `--gateway http://127.0.0.1:3000`
  - `--pollMs 3000`
  - `--bootstrap tail|replay`
- `--scanArchived true|false`

如果你不想让网关自动拉起 watcher，可以在环境变量里设：

```bash
CODEX_WATCH_AUTO_START=false
```

飞书模板支持占位符：

- `{taskTitle}`：任务标题
- `{detail}`：任务详细内容（完成内容）
- `{summary}`：摘要（兼容旧配置）
- `{status}` / `{statusLabel}`：状态值 / 中文状态
- `{taskId}` / `{sessionId}` / `{actorId}`

## 测试

- `npm run test`
- `npm run build`
