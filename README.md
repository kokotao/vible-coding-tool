# vible-coding-tool

一个用于连接 `Codex/Claude` 与 `飞书/QQ` 的双向网关服务。支持消息入站、任务分发、状态回推、风险确认，以及本地 Codex 会话联动。

## 1. 核心能力

- 飞书接入：Webhook / WebSocket（长连接）
- QQ 接入：Webhook / WebSocket（可不依赖公网回调）
- 指令执行：`#session`、`线程 ID` 两种稳定下发格式
- 回推通知：任务 `running/succeeded/failed/pending_confirm` 状态推送
- 风险控制：高风险关键词命中后进入确认流
- 本地会话联动：扫描 `~/.codex/sessions`，支持 thread 选择
- 交互能力（QQ）：
  - 出站 Markdown 消息（`msg_type=2`）
  - Inline Keyboard 按钮
  - 入站 `INTERACTION_CREATE` 按钮回调接入现有任务流

## 2. 环境要求

- Node.js >= 20
- npm >= 10
- 可访问：
  - `https://bots.qq.com`
  - `https://api.sgroup.qq.com`

## 3. 快速启动

```bash
npm install
npm run dev
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

## 4. 连接器配置

在网页配置页或 API 中配置 `feishu` / `qq` 连接器。

### QQ 关键项

- `enabled`: 开启
- `appId` / `appSecret`: 必填
- `eventMode`:
  - `webhook`: 需要平台回调地址
  - `websocket`: 不需要公网回调（推荐本地调试）

### QQ WebSocket 模式启动

```bash
npm run qq:ws
```

或在网关环境变量开启自动拉起：

```bash
QQ_WS_AUTO_START=true
```

## 5. 飞书与 QQ 指令

### 5.1 稳定执行格式（推荐）

1. `#session:<会话ID> <任务内容>`
2. `线程 ID：<线程ID>，任务内容：<任务内容>`

### 5.2 QQ 快捷指令（与飞书对齐）

- `指令帮助` / `帮助` / `help`
- `查看项目`
- `选择项目`
- `查看session`
- `新建session`
- `查看模型列表`
- `查看网关状态`
- `当前选择`

说明：
- 当前 QQ 端对这些“面板类快捷词”会优先返回 Markdown 引导消息和按钮。
- 真正执行任务时建议用 5.1 的两种格式，最稳定。

## 6. QQ 交互说明（重点）

### 6.1 为什么我只看到纯文本消息？

常见原因：
- 你发送的是普通任务文本，系统走了任务状态通知（`msg_type=0`）
- 不是按钮回调场景，没有触发 `INTERACTION_CREATE`

现在已支持：
- 文本快捷词（如 `选择项目`）优先返回 Markdown + 按钮引导
- 按钮点击事件 `INTERACTION_CREATE` 会被接入任务流并自动 ACK，避免客户端按钮一直 loading

### 6.2 交互按钮回调数据示例

```json
{"action":"dispatch","sessionId":"qq-demo","prompt":"修复登录接口500并补单测"}
```

## 7. 常用脚本

```bash
npm run dev
npm run build
npm run test
npm run feishu:ws
npm run qq:ws
```

## 8. 测试

建议至少执行：

```bash
npm run test -- tests/qq/qq-webhook-api.test.ts tests/qq/qq-ws-bridge.test.ts tests/connectors/connector-config-api.test.ts
npm run build
```

## 9. 排障清单

- QQ 无响应：
  - 检查 `appId/appSecret` 是否正确
  - 检查 `eventMode` 是否与实际启动方式一致
  - WebSocket 模式下确认 `qq:ws` 日志有 `ready session=...`
- QQ 看不到交互按钮：
  - 先发 `指令帮助` / `选择项目` 验证是否返回 Markdown
  - 确认回调事件为 `INTERACTION_CREATE`
  - 确认 QQ 平台侧已开通并审核按钮相关能力
- 按钮点击后一直 loading：
  - 检查网关日志是否出现 interaction ACK（`PUT /interactions/{id}`）

## 10. 作者

- Albert_Luo
- 480199976@qq.com
