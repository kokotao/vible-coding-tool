const appRoot = document.getElementById("app");
const drawerRoot = document.getElementById("drawer-root");
const toastRoot = document.getElementById("toast-root");

const state = {
  dashboard: null,
  codexOverview: null,
  connectorConfigs: {},
  drawer: {
    open: false,
    platform: null,
    activeTab: "connection",
    config: null,
    recentOpenIds: []
  }
};

function showToast(message, tone = "info") {
  const stack = ensureToastStack();
  const toast = document.createElement("div");
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  stack.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

function ensureToastStack() {
  let stack = toastRoot.querySelector(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    toastRoot.appendChild(stack);
  }
  return stack;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Request failed");
  }

  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusClass(status) {
  return `status-pill status-${String(status).replaceAll(" ", "_")}`;
}

function route() {
  const hash = location.hash || "#/";
  const codexTaskEventMatch = hash.match(/^#\/codex\/tasks\/([^/]+)\/events$/);
  if (codexTaskEventMatch) return { name: "codexTaskEvents", taskId: decodeURIComponent(codexTaskEventMatch[1]) };
  const taskMatch = hash.match(/^#\/tasks\/([^/]+)$/);
  if (taskMatch) return { name: "task", taskId: decodeURIComponent(taskMatch[1]) };
  const sessionMatch = hash.match(/^#\/sessions\/([^/]+)$/);
  if (sessionMatch) return { name: "session", sessionId: decodeURIComponent(sessionMatch[1]) };
  return { name: "dashboard" };
}

function navButton(label, hash) {
  return `<a class="button subtle small" href="${hash}">${label}</a>`;
}

async function loadDashboard() {
  const [dashboard, codexOverview] = await Promise.all([
    fetchJson("/api/dashboard/summary"),
    loadCodexOverview()
  ]);
  state.dashboard = dashboard;
  state.codexOverview = codexOverview;
}

async function loadCodexOverview() {
  try {
    return await fetchJson("/api/codex/overview?taskLimit=6&sessionLimit=6&sinceHours=24");
  } catch (error) {
    return {
      summary: null,
      activeTasks: [],
      recentSessions: [],
      updatedAt: null,
      loadError: error.message || "Codex overview unavailable"
    };
  }
}

async function loadConnectorConfig(platform) {
  const config = await fetchJson(`/api/connectors/${platform}/config`);
  state.connectorConfigs[platform] = config;
  return config;
}

async function loadRecentFeishuOpenIds(limit = 20) {
  const response = await fetchJson(`/api/feishu/open-ids/recent?limit=${encodeURIComponent(limit)}`);
  return response.items || [];
}

function renderShell(title, subtitle, actionsHtml, contentHtml) {
  appRoot.innerHTML = `
    <div class="shell">
      <section class="hero">
        <div>
          <div class="hero-badge">vible coding mission control</div>
          <h1>${title}</h1>
          <p>${subtitle}</p>
        </div>
        <div class="hero-actions">
          ${actionsHtml}
        </div>
      </section>
      ${contentHtml}
    </div>
  `;
}

function renderMetricCard(label, value) {
  return `
    <article class="metric-card">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
    </article>
  `;
}

function renderDashboardPage() {
  const dashboard = state.dashboard;
  const metrics = [
    renderMetricCard("运行中任务", dashboard.summary.runningTaskCount),
    renderMetricCard("待确认风险", dashboard.summary.pendingRiskCount),
    renderMetricCard("活跃会话", dashboard.summary.activeSessionCount),
    renderMetricCard("今日失败", dashboard.summary.failedTaskCountToday)
  ].join("");

  const timelineHtml = dashboard.taskTimeline.length
    ? dashboard.taskTimeline
        .map(
          (item) => `
            <article class="timeline-item">
              <div class="row">
                <div>
                  <div class="timeline-title">${escapeHtml(item.taskTitle || item.sessionId)}</div>
                  <div class="subtext">${escapeHtml(item.sessionId)}</div>
                </div>
                <span class="${statusClass(item.status)}">${escapeHtml(item.status)}</span>
              </div>
              <div class="timeline-summary">${escapeHtml(item.summary)}</div>
              <div class="row" style="margin-top:12px;">
                <div class="subtext">${escapeHtml(item.updatedAt)}</div>
                <div style="display:flex;gap:8px;">
                  <a class="button small primary" href="#/tasks/${encodeURIComponent(item.taskId)}">查看任务</a>
                  <button class="button small" ${item.canStop ? `data-stop-task="${escapeHtml(item.taskId)}"` : "disabled"}>
                    ${item.canStop ? "停止任务" : "处理中"}
                  </button>
                </div>
              </div>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">当前还没有任务事件。等飞书或 QQ 的指令进入网关后，这里会开始滚动显示任务流。</div>`;

  const sessionsHtml = dashboard.activeSessions.length
    ? dashboard.activeSessions
        .map(
          (item) => `
            <a class="session-row" href="#/sessions/${encodeURIComponent(item.sessionId)}">
              <div class="row">
                <div>
                  <div class="session-title">${escapeHtml(item.taskTitle || item.sessionId)}</div>
                  <div class="subtext">${escapeHtml(item.sessionId)}</div>
                </div>
                <span class="${statusClass(item.status)}">${escapeHtml(item.status)}</span>
              </div>
              <div class="session-meta">${escapeHtml(item.lastMessageSummary || "暂无消息")}</div>
            </a>
          `
        )
        .join("")
    : `<div class="empty-state">暂无活跃会话。等第一批 session 被机器人消息激活后，这里会出现列表。</div>`;

  const codexOverview = state.codexOverview;
  const codexActiveTasksHtml = codexOverview?.activeTasks?.length
    ? codexOverview.activeTasks
        .map(
          (item) => `
            <article class="session-row">
              <div class="row">
                <div>
                  <div class="session-title">${escapeHtml(item.taskTitle || item.taskId)}</div>
                  <div class="subtext">${escapeHtml(item.sessionId)}</div>
                </div>
                <span class="${statusClass(item.status)}">${escapeHtml(item.status)}</span>
              </div>
              <div class="session-meta">${escapeHtml(item.summary || "暂无摘要")}</div>
              <div class="row" style="margin-top:10px;">
                <a class="button small" href="#/tasks/${encodeURIComponent(item.taskId)}">任务详情</a>
                <a class="button small subtle" href="#/codex/tasks/${encodeURIComponent(item.taskId)}/events">事件流</a>
              </div>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">近 24 小时没有进行中的 Codex 任务。</div>`;

  const codexSessionsHtml = codexOverview?.recentSessions?.length
    ? codexOverview.recentSessions
        .map(
          (item) => `
            <a class="session-row" href="#/sessions/${encodeURIComponent(item.sessionId)}">
              <div class="row">
                <div>
                  <div class="session-title">${escapeHtml(item.latestTaskSummary || item.sessionId)}</div>
                  <div class="subtext">${escapeHtml(item.sessionId)}</div>
                </div>
                <span class="${statusClass(item.status)}">${escapeHtml(item.status)}</span>
              </div>
              <div class="session-meta">${escapeHtml(item.latestMessageSummary || "暂无消息")}</div>
            </a>
          `
        )
        .join("")
    : `<div class="empty-state">近 24 小时没有 Codex 会话更新。</div>`;

  const codexSummaryHtml = codexOverview?.summary
    ? `
      <div class="detail-list">
        <div class="detail-row"><span class="subtext">运行中</span><strong>${escapeHtml(codexOverview.summary.runningTaskCount)}</strong></div>
        <div class="detail-row"><span class="subtext">成功</span><strong>${escapeHtml(codexOverview.summary.succeededTaskCount)}</strong></div>
        <div class="detail-row"><span class="subtext">失败</span><strong>${escapeHtml(codexOverview.summary.failedTaskCount)}</strong></div>
        <div class="detail-row"><span class="subtext">活跃会话</span><strong>${escapeHtml(codexOverview.summary.activeSessionCount)}</strong></div>
      </div>
    `
    : `<div class="empty-state">Codex 总览暂不可用：${escapeHtml(codexOverview?.loadError || "unknown_error")}</div>`;

  const risksHtml = dashboard.pendingRisks.length
    ? dashboard.pendingRisks
        .map(
          (item) => `
            <article class="risk-card">
              <div class="row">
                <div>
                  <div class="risk-title">${escapeHtml(item.taskTitle || item.sessionId)}</div>
                  <div class="subtext">${escapeHtml(item.sessionId)}</div>
                </div>
                <span class="${statusClass("pending_confirm")}">待确认</span>
              </div>
              <div class="risk-meta">${escapeHtml(item.riskReason)}</div>
              <div class="row" style="margin-top:12px;">
                <div class="subtext">发起人：${escapeHtml(item.requestedBy)}</div>
                <div style="display:flex;gap:8px;">
                  <button class="button small" data-confirm-risk="${escapeHtml(item.confirmationToken)}">确认</button>
                  <button class="button small" data-reject-risk="${escapeHtml(item.confirmationToken)}">取消</button>
                </div>
              </div>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">当前没有待确认风险。大部分确认会优先在飞书 / QQ 消息里完成。</div>`;

  const connectorsHtml = dashboard.connectors
    .map(
      (connector) => `
        <article class="connector-card">
          <div class="row">
            <div>
              <div class="session-title">${connector.platform.toUpperCase()}</div>
              <div class="subtext">${escapeHtml(connector.defaultChannelName || "尚未绑定默认群 / 频道")}</div>
            </div>
            <span class="${statusClass(connector.connectionStatus)}">${escapeHtml(connector.connectionStatus)}</span>
          </div>
          <div class="detail-list" style="margin-top:14px;">
            <div class="detail-row">
              <span class="subtext">接入模式</span>
              <strong>${escapeHtml(connector.eventMode)}</strong>
            </div>
            <div class="detail-row">
              <span class="subtext">最近联调</span>
              <strong>${escapeHtml(connector.lastTestResult || "未测试")}</strong>
            </div>
          </div>
          <div class="row" style="margin-top:14px;">
            <div class="subtext">${connector.enabled ? "已可用于机器人消息链路" : "未完成接入"}</div>
            <button class="button small primary" data-open-connector="${connector.platform}">编辑配置</button>
          </div>
        </article>
      `
    )
    .join("");

  renderShell(
    "任务驾驶舱与连接中心",
    "机器人消息仍然是主交互面，这个页面负责把任务、会话、风控和连接状态集中展示出来，并承接少量补位操作。",
    [navButton("首页总览", "#/"), navButton("健康检查", "/health")].join(""),
    `
      <section class="metrics">${metrics}</section>
      <section class="content-grid">
        <div class="stack">
          <div class="panel">
            <div class="panel-head">
              <div>
                <h2>实时任务时间线</h2>
                <p>优先展示现在系统正在忙什么，再顺着任务进入详情追踪。</p>
              </div>
            </div>
            <div class="timeline">${timelineHtml}</div>
          </div>
          <div class="panel">
            <div class="panel-head">
              <div>
                <h2>Codex 左侧接管总览（24h）</h2>
                <p>直接展示 Codex 任务与会话状态，并可下钻到事件流页面。</p>
              </div>
            </div>
            <div class="detail-list">${codexSummaryHtml}</div>
            <div class="panel-head" style="margin-top:16px;">
              <div>
                <h2 style="font-size:18px;">活跃任务</h2>
              </div>
              <div class="subtext">更新时间：${escapeHtml(codexOverview?.updatedAt || "-")}</div>
            </div>
            <div class="session-list">${codexActiveTasksHtml}</div>
            <div class="panel-head" style="margin-top:16px;">
              <div>
                <h2 style="font-size:18px;">最近会话</h2>
              </div>
            </div>
            <div class="session-list">${codexSessionsHtml}</div>
          </div>
          <div class="panel">
            <div class="panel-head">
              <div>
                <h2>最近活跃会话</h2>
                <p>展示标题为主、sessionId 为辅的活跃会话列表。</p>
              </div>
            </div>
            <div class="session-list">${sessionsHtml}</div>
          </div>
        </div>
        <div class="stack">
          <div class="panel">
            <div class="panel-head">
              <div>
                <h2>风险待确认</h2>
                <p>网页端可补做确认，但主确认链路仍优先在飞书 / QQ 里完成。</p>
              </div>
            </div>
            <div class="risk-list">${risksHtml}</div>
          </div>
          <div class="panel">
            <div class="panel-head">
              <div>
                <h2>连接中心</h2>
                <p>这里是首页级的操作型区域，不只是状态板。</p>
              </div>
            </div>
            <div class="connector-list">${connectorsHtml}</div>
          </div>
        </div>
      </section>
    `
  );
}

function renderTaskDetailPage(detail) {
  const messageHtml = detail.messageTimeline.length
    ? detail.messageTimeline
        .map(
          (node) => `
            <details class="message-node">
              <summary>
                <div class="row">
                  <div>
                    <strong>${escapeHtml(node.messageType)}</strong>
                    <div class="subtext">${escapeHtml(node.sourcePlatform)} · ${escapeHtml(node.createdAt)}</div>
                  </div>
                  <span class="${statusClass(node.status)}">${escapeHtml(node.status)}</span>
                </div>
                <div class="timeline-summary">${escapeHtml(node.summary)}</div>
              </summary>
              <div class="message-body">${escapeHtml(node.rawContent)}</div>
            </details>
          `
        )
        .join("")
    : `<div class="empty-state">暂无消息时间线。</div>`;

  const risksHtml = detail.riskRecords.length
    ? detail.riskRecords
        .map(
          (risk) => `
            <article class="risk-card">
              <div class="row">
                <div>
                  <div class="risk-title">${escapeHtml(risk.status)}</div>
                  <div class="subtext">请求人：${escapeHtml(risk.requestedBy)}</div>
                </div>
                <div class="subtext">过期时间：${escapeHtml(risk.expiredAt)}</div>
              </div>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">此任务暂无风控记录。</div>`;

  const auditHtml = detail.auditLogs.length
    ? detail.auditLogs
        .map(
          (audit) => `
            <article class="session-row">
              <div class="row">
                <div>
                  <div class="session-title">${escapeHtml(audit.action)}</div>
                  <div class="subtext">${escapeHtml(audit.detail || "")}</div>
                </div>
                <span class="${statusClass(audit.result)}">${escapeHtml(audit.result)}</span>
              </div>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">暂无审计记录。</div>`;

  renderShell(
    escapeHtml(detail.taskTitle || detail.taskId),
    "任务详情默认以排障与追踪为主，再串联消息时间线、风控记录和审计日志。",
    [navButton("返回总览", "#/"), navButton("所属会话", `#/sessions/${encodeURIComponent(detail.sessionId)}`)].join(""),
    `
      <div class="page-header">
        <a class="back-link" href="#/">← 返回首页</a>
        <span class="${statusClass(detail.status)}">${escapeHtml(detail.status)}</span>
      </div>
      <div class="detail-grid">
        <article class="detail-card">
          <h2>任务摘要</h2>
          <p>${escapeHtml(detail.summary || "暂无摘要")}</p>
          <div class="detail-keygrid">
            <div class="key-item"><div class="label">Task ID</div><div class="value">${escapeHtml(detail.taskId)}</div></div>
            <div class="key-item"><div class="label">Session</div><div class="value">${escapeHtml(detail.sessionId)}</div></div>
            <div class="key-item"><div class="label">Platform</div><div class="value">${escapeHtml(detail.sourcePlatform)}</div></div>
            <div class="key-item"><div class="label">Provider</div><div class="value">${escapeHtml(detail.toolProvider)}</div></div>
          </div>
          <div class="drawer-actions" style="margin-top:16px;">
            <button class="button" data-retry-notify="${escapeHtml(detail.taskId)}">重试通知</button>
          </div>
        </article>
        <article class="detail-card">
          <h2>消息时间线</h2>
          <p>默认看摘要，展开后再看原始消息内容。</p>
          ${messageHtml}
        </article>
        <article class="detail-card">
          <h2>风控记录</h2>
          <p>机器人消息是主确认入口，这里主要承担查看与补位。</p>
          <div class="risk-list">${risksHtml}</div>
        </article>
        <article class="detail-card">
          <h2>审计日志</h2>
          <p>帮助快速串起谁发起、谁执行、网关做了什么。</p>
          <div class="session-list">${auditHtml}</div>
        </article>
      </div>
    `
  );
}

function renderSessionDetailPage(detail) {
  const taskHtml = detail.recentTasks.length
    ? detail.recentTasks
        .map(
          (task) => `
            <a class="session-row" href="#/tasks/${encodeURIComponent(task.taskId)}">
              <div class="row">
                <div>
                  <div class="session-title">${escapeHtml(task.taskTitle || task.taskId)}</div>
                  <div class="subtext">${escapeHtml(task.taskId)}</div>
                </div>
                <span class="${statusClass(task.status)}">${escapeHtml(task.status)}</span>
              </div>
            </a>
          `
        )
        .join("")
    : `<div class="empty-state">这个会话还没有关联任务。</div>`;

  const messageHtml = detail.messageTimeline.length
    ? detail.messageTimeline
        .map(
          (message) => `
            <details class="message-node">
              <summary>
                <div class="row">
                  <div>
                    <strong>${escapeHtml(message.messageType)}</strong>
                    <div class="subtext">${escapeHtml(message.createdAt)}</div>
                  </div>
                  <span class="${statusClass(message.direction)}">${escapeHtml(message.direction)}</span>
                </div>
              </summary>
              <div class="message-body">${escapeHtml(message.rawContent)}</div>
            </details>
          `
        )
        .join("")
    : `<div class="empty-state">暂无会话消息。</div>`;

  renderShell(
    escapeHtml(detail.sessionId),
    "会话详情用于补充查看任务上下文、历史消息和绑定信息。",
    [navButton("返回总览", "#/")].join(""),
    `
      <div class="page-header">
        <a class="back-link" href="#/">← 返回首页</a>
        <span class="${statusClass(detail.status)}">${escapeHtml(detail.status)}</span>
      </div>
      <div class="detail-grid">
        <article class="detail-card">
          <h2>会话摘要</h2>
          <div class="detail-keygrid">
            <div class="key-item"><div class="label">Provider</div><div class="value">${escapeHtml(detail.toolProvider)}</div></div>
            <div class="key-item"><div class="label">Ref</div><div class="value">${escapeHtml(detail.toolSessionRef)}</div></div>
            <div class="key-item"><div class="label">Prefix</div><div class="value">${escapeHtml(detail.bindings.sessionPrefix)}</div></div>
            <div class="key-item"><div class="label">绑定频道</div><div class="value">${escapeHtml(detail.bindings.defaultChannelName || "未设置")}</div></div>
          </div>
        </article>
        <article class="detail-card">
          <h2>最近任务</h2>
          <div class="session-list">${taskHtml}</div>
        </article>
        <article class="detail-card">
          <h2>会话消息时间线</h2>
          ${messageHtml}
        </article>
      </div>
    `
  );
}

function renderCodexTaskEventsPage(detail) {
  const eventHtml = detail.items.length
    ? detail.items
        .map(
          (event) => `
            <article class="session-row">
              <div class="row">
                <div>
                  <div class="session-title">${escapeHtml(event.event)}</div>
                  <div class="subtext">${escapeHtml(event.timestamp)} · ${escapeHtml(event.type)}</div>
                </div>
                <span class="${statusClass(event.status || "info")}">${escapeHtml(event.status || "n/a")}</span>
              </div>
              <div class="session-meta">${escapeHtml(event.detail || "")}</div>
              <div class="subtext">source=${escapeHtml(event.source || "-")} actor=${escapeHtml(event.actorId || "-")}</div>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">暂无事件记录。</div>`;

  renderShell(
    `Codex 事件流 · ${escapeHtml(detail.taskId)}`,
    "用于追踪左侧运行态同步、消息事件和审计日志的时间顺序。",
    [navButton("返回总览", "#/"), navButton("任务详情", `#/tasks/${encodeURIComponent(detail.taskId)}`)].join(""),
    `
      <div class="page-header">
        <a class="back-link" href="#/">← 返回首页</a>
        <span class="${statusClass(detail.status)}">${escapeHtml(detail.status)}</span>
      </div>
      <div class="detail-grid">
        <article class="detail-card">
          <h2>任务与会话</h2>
          <div class="detail-keygrid">
            <div class="key-item"><div class="label">Task ID</div><div class="value">${escapeHtml(detail.taskId)}</div></div>
            <div class="key-item"><div class="label">Session</div><div class="value">${escapeHtml(detail.sessionId)}</div></div>
            <div class="key-item"><div class="label">事件数</div><div class="value">${escapeHtml(detail.items.length)}</div></div>
            <div class="key-item"><div class="label">状态</div><div class="value">${escapeHtml(detail.status)}</div></div>
          </div>
        </article>
        <article class="detail-card">
          <h2>事件时间线</h2>
          <p>包含 task_status / message / audit 三类事件。</p>
          <div class="session-list">${eventHtml}</div>
        </article>
      </div>
    `
  );
}

async function renderRoute() {
  const current = route();

  if (current.name === "dashboard") {
    await loadDashboard();
    renderDashboardPage();
    bindDashboardEvents();
    return;
  }

  if (current.name === "codexTaskEvents") {
    const detail = await fetchJson(`/api/codex/tasks/${encodeURIComponent(current.taskId)}/events?limit=120`);
    renderCodexTaskEventsPage(detail);
    return;
  }

  if (current.name === "task") {
    const detail = await fetchJson(`/api/tasks/${encodeURIComponent(current.taskId)}/detail`);
    renderTaskDetailPage(detail);
    bindTaskDetailEvents();
    return;
  }

  if (current.name === "session") {
    const detail = await fetchJson(`/api/sessions/${encodeURIComponent(current.sessionId)}/detail`);
    renderSessionDetailPage(detail);
  }
}

function bindDashboardEvents() {
  appRoot.querySelectorAll("[data-open-connector]").forEach((button) => {
    button.addEventListener("click", async () => {
      const platform = button.getAttribute("data-open-connector");
      await openConnectorDrawer(platform);
    });
  });

  appRoot.querySelectorAll("[data-stop-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.getAttribute("data-stop-task");
      if (!taskId) return;

      button.disabled = true;
      try {
        const result = await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/stop`, {
          method: "POST"
        });
        await boot();
        showToast(result.message || "任务已停止", "success");
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        button.disabled = false;
      }
    });
  });

  appRoot.querySelectorAll("[data-confirm-risk]").forEach((button) => {
    button.addEventListener("click", async () => {
      const token = button.getAttribute("data-confirm-risk");
      if (!token) return;
      await submitRiskDecision(token, "confirm");
    });
  });

  appRoot.querySelectorAll("[data-reject-risk]").forEach((button) => {
    button.addEventListener("click", async () => {
      const token = button.getAttribute("data-reject-risk");
      if (!token) return;
      await submitRiskDecision(token, "reject");
    });
  });
}

function bindTaskDetailEvents() {
  appRoot.querySelectorAll("[data-retry-notify]").forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.getAttribute("data-retry-notify");
      if (!taskId) return;

      button.disabled = true;
      try {
        const result = await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/retry-notify`, {
          method: "POST"
        });
        await boot();
        showToast(result.message || "已触发重试通知", "success");
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function submitRiskDecision(token, action) {
  const path = action === "confirm" ? "confirm" : "reject";
  const successMessage = action === "confirm" ? "已确认风险指令" : "已拒绝风险指令";

  try {
    await fetchJson(`/api/risks/${encodeURIComponent(token)}/${path}`, {
      method: "POST"
    });
    await boot();
    showToast(successMessage, "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function openConnectorDrawer(platform) {
  const [config, recentOpenIds] = await Promise.all([
    loadConnectorConfig(platform),
    platform === "feishu" ? loadRecentFeishuOpenIds(20) : Promise.resolve([])
  ]);

  state.drawer = {
    open: true,
    platform,
    activeTab: "connection",
    config: structuredClone(config),
    recentOpenIds
  };
  renderDrawer();
}

function closeDrawer() {
  state.drawer.open = false;
  drawerRoot.innerHTML = "";
}

function renderDrawer() {
  if (!state.drawer.open || !state.drawer.config) {
    drawerRoot.innerHTML = "";
    return;
  }

  const config = state.drawer.config;
  const tabs = [
    ["connection", "连接"],
    ["risk", "风控"],
    ["template", "模板"],
    ["binding", "绑定"]
  ]
    .map(
      ([key, label]) => `
        <button class="${state.drawer.activeTab === key ? "active" : ""}" data-tab="${key}">${label}</button>
      `
    )
    .join("");

  drawerRoot.innerHTML = `
    <div class="drawer-backdrop" data-close-drawer="true">
      <aside class="drawer" role="dialog" aria-modal="true">
        <div class="panel-head">
          <div>
            <h2>${config.platform.toUpperCase()} 连接中心</h2>
            <p>首页级操作型配置抽屉，覆盖连接、风控、模板和绑定。</p>
          </div>
          <button class="button small" data-close-drawer="true">关闭</button>
        </div>
        <div class="tabbar">${tabs}</div>
        <div class="form-grid">
          ${renderDrawerTab(config, state.drawer.recentOpenIds || [])}
        </div>
      </aside>
    </div>
  `;

  drawerRoot.querySelectorAll("[data-close-drawer]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target === event.currentTarget || element.tagName === "BUTTON") {
        closeDrawer();
      }
    });
  });

  drawerRoot.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.drawer.activeTab = button.getAttribute("data-tab");
      renderDrawer();
    });
  });

  bindDrawerFormEvents();
}

function renderDrawerTab(config, recentOpenIds) {
  if (state.drawer.activeTab === "connection") {
    return `
      <div class="field"><label>App ID</label><input name="appId" value="${escapeHtml(config.appId)}" /></div>
      <div class="field"><label>App Secret</label><input name="appSecret" value="${escapeHtml(config.appSecret)}" /></div>
      <div class="field"><label>接入模式</label>
        <select name="eventMode">
          <option value="webhook" ${config.eventMode === "webhook" ? "selected" : ""}>Webhook</option>
          <option value="websocket" ${config.eventMode === "websocket" ? "selected" : ""}>WebSocket</option>
        </select>
      </div>
      <div class="field"><label>回调地址</label><input name="callbackUrl" value="${escapeHtml(config.callbackUrl)}" /></div>
      <div class="field"><label>默认群 / 频道名称</label><input name="defaultChannelName" value="${escapeHtml(config.defaultChannelName || "")}" /></div>
      <div class="inline-note">最近一次联调：${escapeHtml(config.lastTestResult || "未测试")} ${config.lastTestAt ? `· ${escapeHtml(config.lastTestAt)}` : ""}</div>
      <div class="drawer-actions">
        <button class="button primary" data-save-connector="true">保存配置</button>
        <button class="button" data-test-connector="true">测试连接</button>
      </div>
    `;
  }

  if (state.drawer.activeTab === "risk") {
    return `
      <div class="field"><label>确认超时（秒）</label><input name="confirmTimeoutSeconds" type="number" value="${escapeHtml(config.confirmTimeoutSeconds)}" /></div>
      <div class="field"><label>高风险关键词（逗号分隔）</label><textarea name="riskKeywords">${escapeHtml(config.riskKeywords.join(", "))}</textarea></div>
      <div class="inline-note">网页端可补做确认，但机器人消息仍然是主确认链路。</div>
      <div class="drawer-actions"><button class="button primary" data-save-connector="true">保存风控</button></div>
    `;
  }

  if (state.drawer.activeTab === "template") {
    return `
      <div class="field"><label>任务开始文案</label><textarea name="templateTaskStarted">${escapeHtml(config.templateTaskStarted)}</textarea></div>
      <div class="field"><label>任务成功文案</label><textarea name="templateTaskSucceeded">${escapeHtml(config.templateTaskSucceeded)}</textarea></div>
      <div class="field"><label>任务失败文案</label><textarea name="templateTaskFailed">${escapeHtml(config.templateTaskFailed)}</textarea></div>
      <div class="field"><label>待确认文案</label><textarea name="templateTaskPendingConfirm">${escapeHtml(config.templateTaskPendingConfirm)}</textarea></div>
      <div class="drawer-actions"><button class="button primary" data-save-connector="true">保存模板</button></div>
    `;
  }

  const quickMessagePanel =
    config.platform === "feishu"
      ? `
        <div class="field"><label>快捷发送目标 open_id</label>
          <select name="quickOpenId">
            ${
              recentOpenIds.length
                ? recentOpenIds
                    .map(
                      (item) => `
                        <option value="${escapeHtml(item.openId)}">
                          ${escapeHtml(item.openId)} · ${escapeHtml(item.sessionId)} · ${escapeHtml(item.lastSeenAt)}
                        </option>
                      `
                    )
                    .join("")
                : `<option value="">暂无 recent open_id，请先从飞书触发一条入站消息</option>`
            }
          </select>
        </div>
        <div class="field"><label>快捷发送内容</label><textarea name="quickText">网关联调消息：连接中心主动推送测试</textarea></div>
        <div class="drawer-actions"><button class="button" data-send-feishu-message="true" ${
          recentOpenIds.length ? "" : "disabled"
        }>发送测试消息</button></div>
      `
      : "";

  return `
    <div class="field"><label>Session 前缀</label><input name="sessionPrefix" value="${escapeHtml(config.sessionPrefix)}" /></div>
    <div class="field"><label>启用状态</label>
      <select name="enabled">
        <option value="true" ${config.enabled ? "selected" : ""}>启用</option>
        <option value="false" ${config.enabled ? "" : "selected"}>停用</option>
      </select>
    </div>
    <div class="inline-note">首版采用全局单配置和机器人类型前缀，例如 <strong>${escapeHtml(config.sessionPrefix || `${config.platform}-codex`)}</strong>。</div>
    <div class="drawer-actions"><button class="button primary" data-save-connector="true">保存绑定</button></div>
    ${quickMessagePanel}
  `;
}

function bindDrawerFormEvents() {
  drawerRoot.querySelectorAll("input, textarea, select").forEach((field) => {
    field.addEventListener("input", syncDrawerConfigFromForm);
    field.addEventListener("change", syncDrawerConfigFromForm);
  });

  drawerRoot.querySelector("[data-save-connector='true']")?.addEventListener("click", saveConnectorConfig);
  drawerRoot.querySelector("[data-test-connector='true']")?.addEventListener("click", testConnectorConfig);
  drawerRoot.querySelector("[data-send-feishu-message='true']")?.addEventListener("click", sendFeishuQuickMessage);
}

function syncDrawerConfigFromForm() {
  const form = state.drawer.config;
  if (!form) return;

  drawerRoot.querySelectorAll("input, textarea, select").forEach((field) => {
    const name = field.getAttribute("name");
    if (!name) return;
    if (name === "enabled") {
      form.enabled = field.value === "true";
      return;
    }
    if (name === "confirmTimeoutSeconds") {
      form.confirmTimeoutSeconds = Number(field.value || "120");
      return;
    }
    if (name === "riskKeywords") {
      form.riskKeywords = field.value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      return;
    }
    if (name === "quickOpenId" || name === "quickText") {
      return;
    }
    form[name] = field.value;
  });
}

async function sendFeishuQuickMessage() {
  const openId = drawerRoot.querySelector("[name='quickOpenId']")?.value || "";
  const text = drawerRoot.querySelector("[name='quickText']")?.value || "";

  if (!openId.trim()) {
    showToast("请先选择一个 open_id", "error");
    return;
  }

  if (!text.trim()) {
    showToast("发送内容不能为空", "error");
    return;
  }

  try {
    const result = await fetchJson("/api/feishu/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        openId: openId.trim(),
        text: text.trim()
      })
    });

    await loadDashboard();
    renderRoute();
    renderDrawer();
    if (result.notify?.sent) {
      showToast("飞书消息已发送", "success");
      return;
    }

    showToast(`发送失败：${result.notify?.reason || "unknown_error"}`, "error");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function saveConnectorConfig() {
  syncDrawerConfigFromForm();
  const config = state.drawer.config;
  if (!config) return;

  try {
    const saved = await fetchJson(`/api/connectors/${config.platform}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config)
    });

    state.connectorConfigs[config.platform] = saved;
    state.drawer.config = structuredClone(saved);
    await loadDashboard();
    renderRoute();
    renderDrawer();
    showToast(`${config.platform.toUpperCase()} 配置已保存`, "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function testConnectorConfig() {
  syncDrawerConfigFromForm();
  const config = state.drawer.config;
  if (!config) return;

  try {
    await saveConnectorConfig();
    const result = await fetchJson(`/api/connectors/${config.platform}/test`, {
      method: "POST"
    });
    const updated = await loadConnectorConfig(config.platform);
    state.drawer.config = structuredClone(updated);
    await loadDashboard();
    renderRoute();
    renderDrawer();
    showToast(result.message, result.success ? "success" : "error");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function boot() {
  try {
    await renderRoute();
  } catch (error) {
    renderShell(
      "管理台加载失败",
      "后端接口已经启动，但当前页面没能正确拿到数据。",
      navButton("重试", "#/"),
      `<div class="panel"><div class="empty-state">${escapeHtml(error.message)}</div></div>`
    );
  }
}

window.addEventListener("hashchange", () => {
  void boot();
});

window.addEventListener("click", (event) => {
  if (event.target === drawerRoot.querySelector(".drawer-backdrop")) {
    closeDrawer();
  }
});

void boot();
