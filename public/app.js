const appRoot = document.getElementById("app");
const drawerRoot = document.getElementById("drawer-root");
const toastRoot = document.getElementById("toast-root");
let dashboardRefreshTimer = null;
let dashboardRefreshInFlight = false;

const state = {
  dashboard: null,
  codexOverview: null,
  codexLocalSessions: null,
  localSessionsPage: {
    selectedProjectKey: null,
    selectedDayKey: null,
    selectedThreadId: null,
    detail: null,
    loadError: null
  },
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
  const localSessionsMatch = hash.match(/^#\/local-sessions(?:\/([^/?#]+))?/);
  if (localSessionsMatch) {
    return {
      name: "localSessions",
      threadId: localSessionsMatch[1] ? decodeURIComponent(localSessionsMatch[1]) : null
    };
  }
  const taskMatch = hash.match(/^#\/tasks\/([^/]+)$/);
  if (taskMatch) return { name: "task", taskId: decodeURIComponent(taskMatch[1]) };
  const sessionMatch = hash.match(/^#\/sessions\/([^/]+)$/);
  if (sessionMatch) return { name: "session", sessionId: decodeURIComponent(sessionMatch[1]) };
  return { name: "dashboard" };
}

function navButton(label, hash) {
  return `<a class="button subtle small" href="${hash}">${label}</a>`;
}

function stopDashboardRefresh() {
  if (!dashboardRefreshTimer) {
    return;
  }

  clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer = null;
}

function startDashboardRefresh() {
  if (dashboardRefreshTimer) {
    return;
  }

  dashboardRefreshTimer = window.setInterval(() => {
    if (route().name !== "dashboard" || dashboardRefreshInFlight) {
      return;
    }

    dashboardRefreshInFlight = true;
    void loadDashboard()
      .then(() => {
        if (route().name === "dashboard") {
          renderDashboardPage();
          bindDashboardEvents();
        }
      })
      .catch(() => {
        // Keep the last rendered view if a refresh request briefly fails.
      })
      .finally(() => {
        dashboardRefreshInFlight = false;
      });
  }, 10000);
}

async function loadDashboard() {
  const [dashboard, codexOverview, codexLocalSessions] = await Promise.all([
    fetchJson("/api/dashboard/summary"),
    loadCodexOverview(),
    loadCodexLocalSessions()
  ]);
  state.dashboard = dashboard;
  state.codexOverview = codexOverview;
  state.codexLocalSessions = codexLocalSessions;
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

async function loadCodexLocalSessions() {
  try {
    return await fetchJson("/api/codex/local-sessions?limit=500&refresh=true");
  } catch (error) {
    return {
      groups: [],
      totalFiles: 0,
      totalThreads: 0,
      scannedAt: null,
      loadError: error.message || "Codex local sessions unavailable"
    };
  }
}

async function loadLocalSessionDetail(threadId) {
  return await fetchJson(`/api/codex/local-sessions/${encodeURIComponent(threadId)}?refresh=true`);
}

async function loadLocalSessionsPage(threadId = null) {
  state.codexLocalSessions = await loadCodexLocalSessions();
  state.localSessionsPage.loadError = null;

  const projects = groupLocalSessionItems(state.codexLocalSessions.items || []);
  const selection = resolveLocalSessionSelection(projects, threadId || null);

  state.localSessionsPage.selectedProjectKey = selection.project?.projectKey || null;
  state.localSessionsPage.selectedDayKey = selection.day?.dayKey || null;
  state.localSessionsPage.selectedThreadId = selection.session?.threadId || null;
  state.localSessionsPage.detail = null;

  if (state.localSessionsPage.selectedThreadId) {
    await refreshLocalSessionDetail(state.localSessionsPage.selectedThreadId);
  }
}

async function refreshLocalSessionDetail(threadId) {
  if (!threadId) {
    state.localSessionsPage.detail = null;
    return;
  }

  try {
    state.localSessionsPage.detail = await loadLocalSessionDetail(threadId);
    state.localSessionsPage.loadError = null;
  } catch (error) {
    state.localSessionsPage.detail = null;
    state.localSessionsPage.loadError = error.message || "Local session detail unavailable";
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

  const codexLocalSessions = state.codexLocalSessions;
  const localSessionProjects = groupLocalSessionItems(codexLocalSessions?.items || []);
  const codexLocalSessionPreviewHtml =
    localSessionProjects.length > 0
      ? localSessionProjects.slice(0, 3).map(
          (project) => `
            <article class="session-row">
              <div class="row">
                <div>
                  <div class="session-title">${escapeHtml(project.projectName)}</div>
                  <div class="subtext">${escapeHtml(project.projectPath || "未知路径")}</div>
                </div>
                <span class="${statusClass("info")}">${escapeHtml(project.count)} 条</span>
              </div>
              <div class="session-meta">
                ${project.days
                  .slice(0, 3)
                  .map((day) => `${escapeHtml(day.label)} (${escapeHtml(day.count)})`)
                  .join("<br/>")}
              </div>
            </article>
          `
        ).join("")
      : `<div class="empty-state">本地 Codex 会话暂无可展示数据：${escapeHtml(codexLocalSessions?.loadError || "empty")}</div>`;

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
    [navButton("首页总览", "#/"), navButton("本地会话页", "#/local-sessions"), navButton("健康检查", "/health")].join(""),
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
            <div class="panel-head" style="margin-top:16px;">
              <div>
                <h2 style="font-size:18px;">本地会话目录</h2>
              </div>
              <button class="button small primary" data-open-local-sessions="true">打开目录页</button>
            </div>
            <div class="detail-list">
              <div class="detail-row"><span class="subtext">线程数</span><strong>${escapeHtml(codexLocalSessions?.totalThreads ?? 0)}</strong></div>
              <div class="detail-row"><span class="subtext">文件数</span><strong>${escapeHtml(codexLocalSessions?.totalFiles ?? 0)}</strong></div>
              <div class="detail-row"><span class="subtext">扫描时间</span><strong>${escapeHtml(codexLocalSessions?.scannedAt || "-")}</strong></div>
            </div>
            <div class="session-list" style="margin-top: 14px;">${codexLocalSessionPreviewHtml}</div>
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

function groupLocalSessionItems(items) {
  const projectMap = new Map();

  for (const item of items) {
    const projectKey = item.projectPath || item.projectName || "unknown-project";
    let project = projectMap.get(projectKey);
    if (!project) {
      project = {
        projectKey,
        projectName: item.projectName || "unknown-project",
        projectPath: item.projectPath || "",
        sessions: [],
        dayMap: new Map(),
        latestAtMs: 0
      };
      projectMap.set(projectKey, project);
    }

    project.sessions.push(item);
    const updatedAtMs = Date.parse(item.updatedAt) || 0;
    project.latestAtMs = Math.max(project.latestAtMs, updatedAtMs);

    const dayKey = `${item.year}-${item.month}-${item.day}`;
    let day = project.dayMap.get(dayKey);
    if (!day) {
      day = {
        dayKey,
        label: `${item.year} 年 ${item.month} 月 ${item.day} 日`,
        items: [],
        latestAtMs: 0
      };
      project.dayMap.set(dayKey, day);
    }

    day.items.push(item);
    day.latestAtMs = Math.max(day.latestAtMs, updatedAtMs);
  }

  return [...projectMap.values()]
    .sort((a, b) => {
      if (b.latestAtMs !== a.latestAtMs) {
        return b.latestAtMs - a.latestAtMs;
      }
      return a.projectName.localeCompare(b.projectName);
    })
    .map((project) => {
      const days = [...project.dayMap.values()]
        .sort((a, b) => {
          if (b.latestAtMs !== a.latestAtMs) {
            return b.latestAtMs - a.latestAtMs;
          }
          return b.dayKey.localeCompare(a.dayKey);
        })
        .map((day) => ({
          dayKey: day.dayKey,
          label: day.label,
          count: day.items.length,
          items: day.items
        }));

      return {
        projectKey: project.projectKey,
        projectName: project.projectName,
        projectPath: project.projectPath,
        sessions: project.sessions,
        days,
        latestAtMs: project.latestAtMs,
        count: project.sessions.length
      };
    });
}

function resolveLocalSessionSelection(projects, preferredThreadId = null) {
  let project = null;
  let day = null;
  let session = null;

  if (preferredThreadId) {
    for (const projectItem of projects) {
      const matchedSession = projectItem.sessions.find((item) => item.threadId === preferredThreadId);
      if (!matchedSession) {
        continue;
      }

      project = projectItem;
      day = projectItem.days.find((dayItem) => dayItem.dayKey === `${matchedSession.year}-${matchedSession.month}-${matchedSession.day}`) || projectItem.days[0] || null;
      session = matchedSession;
      break;
    }
  }

  if (!project && projects.length > 0) {
    const currentProjectKey = state.localSessionsPage.selectedProjectKey;
    project =
      projects.find((item) => item.projectKey === currentProjectKey) ||
      projects[0] ||
      null;
  }

  if (project && !day) {
    const currentDayKey = state.localSessionsPage.selectedDayKey;
    day = project.days.find((item) => item.dayKey === currentDayKey) || project.days[0] || null;
  }

  if (project && day && !session) {
    const currentThreadId = state.localSessionsPage.selectedThreadId;
    session =
      day.items.find((item) => item.threadId === currentThreadId) ||
      day.items[0] ||
      project.sessions[0] ||
      null;
  }

  return {
    project,
    day,
    session
  };
}

function renderLocalSessionMessage(message) {
  const body = escapeHtml(message.content).replaceAll("\n", "<br/>");
  const roleLabel = message.role === "user" ? "用户" : message.role === "tool" ? "工具" : "助手";
  const kindLabel =
    message.kind === "tool_call" ? "工具调用" : message.kind === "tool_output" ? "工具返回" : roleLabel;

  return `
    <article class="local-message ${message.kind} ${message.role}">
      <div class="local-message-meta">
        <span class="local-message-role">${kindLabel}</span>
        <span class="local-message-time">${escapeHtml(message.timestamp || "-")}</span>
      </div>
      ${message.name ? `<div class="local-message-name">${escapeHtml(message.name)}</div>` : ""}
      <div class="local-message-body">${body}</div>
    </article>
  `;
}

function renderLocalSessionsPage() {
  const snapshot = state.codexLocalSessions;
  if (!snapshot) {
    renderShell(
      "本地会话目录",
      "正在扫描本地 rollout 文件。",
      [navButton("返回总览", "#/")].join(""),
      `<div class="panel"><div class="empty-state">正在加载本地会话目录...</div></div>`
    );
    return;
  }

  const projects = groupLocalSessionItems(snapshot.items || []);
  const selection = resolveLocalSessionSelection(projects, state.localSessionsPage.selectedThreadId);
  const selectedProject = selection.project;
  const selectedDay = selection.day;
  const selectedSession = selection.session;

  state.localSessionsPage.selectedProjectKey = selectedProject?.projectKey || null;
  state.localSessionsPage.selectedDayKey = selectedDay?.dayKey || null;
  state.localSessionsPage.selectedThreadId = selectedSession?.threadId || null;

  const selectedDetail = state.localSessionsPage.detail;
  const detail = selectedDetail && selectedSession && selectedDetail.threadId === selectedSession.threadId ? selectedDetail : null;

  const metrics = [
    renderMetricCard("项目数", projects.length),
    renderMetricCard("会话数", snapshot.totalFiles),
    renderMetricCard("线程数", snapshot.totalThreads),
    renderMetricCard("扫描时间", snapshot.scannedAt || "-")
  ].join("");

  const projectTreeHtml = projects.length
    ? projects
        .map(
          (project) => `
            <article class="local-project-card ${project.projectKey === selectedProject?.projectKey ? "active" : ""}">
              <button class="local-project-button" data-select-project="${escapeHtml(project.projectKey)}">
                <div>
                  <div class="local-project-title">${escapeHtml(project.projectName)}</div>
                  <div class="subtext">${escapeHtml(project.projectPath || "未知路径")}</div>
                </div>
                <span class="local-project-count">${escapeHtml(project.count)}</span>
              </button>
              <div class="local-day-chip-list">
                ${project.days
                  .map(
                    (day) => `
                      <button class="local-day-chip ${day.dayKey === selectedDay?.dayKey && project.projectKey === selectedProject?.projectKey ? "active" : ""}" data-select-day="${escapeHtml(
                      day.dayKey
                    )}" data-project-key="${escapeHtml(project.projectKey)}">
                        <span>${escapeHtml(day.label)}</span>
                        <strong>${escapeHtml(day.count)}</strong>
                      </button>
                    `
                  )
                  .join("")}
              </div>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">没有扫描到本地 Codex 会话。</div>`;

  const sessionListHtml = selectedDay?.items?.length
    ? selectedDay.items
        .map(
          (item) => `
            <a class="local-session-card ${item.threadId === selectedSession?.threadId ? "active" : ""}" href="#/local-sessions/${encodeURIComponent(
              item.threadId
            )}">
              <div class="local-session-card-head">
                <div>
                  <div class="local-session-title">${escapeHtml(item.sessionTitle)}</div>
                  <div class="subtext">${escapeHtml(item.projectName)} · ${escapeHtml(item.rolloutFileName)}</div>
                </div>
                <span class="status-pill">${escapeHtml(item.messageCount)} 条</span>
              </div>
              <div class="local-session-card-meta">
                <span>${escapeHtml(item.year)}-${escapeHtml(item.month)}-${escapeHtml(item.day)}</span>
                <span>${escapeHtml(item.updatedAt)}</span>
              </div>
            </a>
          `
        )
        .join("")
    : `<div class="empty-state">当前日期下没有可展示的会话。</div>`;

  const detailHtml = detail
    ? `
      <div class="local-detail-card">
        <div class="panel-head">
          <div>
            <h2>${escapeHtml(detail.sessionTitle)}</h2>
            <p>${escapeHtml(detail.projectName)} · ${escapeHtml(detail.rolloutFileName)}</p>
          </div>
          <div class="local-detail-stats">
            <span class="status-pill">${escapeHtml(detail.messageCount)} 条</span>
            <span class="status-pill">${escapeHtml(detail.year)}-${escapeHtml(detail.month)}-${escapeHtml(detail.day)}</span>
          </div>
        </div>
        <div class="detail-keygrid">
          <div class="key-item"><div class="label">Project</div><div class="value">${escapeHtml(detail.projectName)}</div></div>
          <div class="key-item"><div class="label">Path</div><div class="value">${escapeHtml(detail.projectPath || "-")}</div></div>
          <div class="key-item"><div class="label">Thread</div><div class="value">${escapeHtml(detail.threadId)}</div></div>
          <div class="key-item"><div class="label">Updated</div><div class="value">${escapeHtml(detail.updatedAt)}</div></div>
        </div>
        <div class="local-message-feed">
          ${detail.messages.length ? detail.messages.map((message) => renderLocalSessionMessage(message)).join("") : `<div class="empty-state">没有解析到可展示的聊天内容。</div>`}
        </div>
      </div>
    `
    : state.localSessionsPage.loadError
      ? `<div class="empty-state">会话详情加载失败：${escapeHtml(state.localSessionsPage.loadError)}</div>`
      : `<div class="empty-state">选择一个会话后，这里会展示聊天气泡内容。</div>`;

  renderShell(
    "本地会话目录",
    "按项目和日期聚合本地 Codex rollout 文件，左侧选项目和日期，中间选会话，右侧看聊天内容。",
    [navButton("返回总览", "#/"), `<button class="button small primary" data-refresh-local-sessions="true">刷新目录</button>`].join(""),
    `
      <section class="metrics">${metrics}</section>
      <section class="local-sessions-layout">
        <aside class="panel local-sidebar">
          <div class="panel-head">
            <div>
              <h2>项目与日期</h2>
              <p>先按项目归类，再按日期筛选到具体会话。</p>
            </div>
          </div>
          <div class="local-project-tree">${projectTreeHtml}</div>
        </aside>
        <section class="panel local-session-column">
          <div class="panel-head">
            <div>
              <h2>${escapeHtml(selectedProject?.projectName || "会话列表")}</h2>
              <p>${escapeHtml(selectedDay?.label || "请选择左侧日期")}</p>
            </div>
          </div>
          <div class="local-session-list">${sessionListHtml}</div>
        </section>
        <section class="panel local-detail-column">
          <div class="panel-head">
            <div>
              <h2>聊天内容</h2>
              <p>只渲染真正的对话气泡和必要的工具调用。</p>
            </div>
          </div>
          ${detailHtml}
        </section>
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

  if (current.name === "localSessions") {
    await loadLocalSessionsPage(current.threadId || null);
    renderLocalSessionsPage();
    bindLocalSessionsEvents();
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

  appRoot.querySelectorAll("[data-open-local-sessions]").forEach((button) => {
    button.addEventListener("click", async () => {
      location.hash = "#/local-sessions";
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

function bindLocalSessionsEvents() {
  appRoot.querySelectorAll("[data-refresh-local-sessions]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await loadLocalSessionsPage(state.localSessionsPage.selectedThreadId);
        renderLocalSessionsPage();
        bindLocalSessionsEvents();
        showToast("本地会话目录已刷新", "success");
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        button.disabled = false;
      }
    });
  });

  appRoot.querySelectorAll("[data-select-project]").forEach((button) => {
    button.addEventListener("click", async () => {
      const projectKey = button.getAttribute("data-select-project");
      if (!projectKey || !state.codexLocalSessions) {
        return;
      }

      const projects = groupLocalSessionItems(state.codexLocalSessions.items || []);
      const selectedProject = projects.find((item) => item.projectKey === projectKey);
      if (!selectedProject) {
        return;
      }

      const selectedDay = selectedProject.days[0] || null;
      const selectedSession = selectedDay?.items[0] || selectedProject.sessions[0] || null;
      state.localSessionsPage.selectedProjectKey = selectedProject.projectKey;
      state.localSessionsPage.selectedDayKey = selectedDay?.dayKey || null;
      state.localSessionsPage.selectedThreadId = selectedSession?.threadId || null;
      await refreshLocalSessionDetail(state.localSessionsPage.selectedThreadId);
      renderLocalSessionsPage();
      bindLocalSessionsEvents();
    });
  });

  appRoot.querySelectorAll("[data-select-day]").forEach((button) => {
    button.addEventListener("click", async () => {
      const dayKey = button.getAttribute("data-select-day");
      const projectKey = button.getAttribute("data-project-key");
      if (!dayKey || !projectKey || !state.codexLocalSessions) {
        return;
      }

      const projects = groupLocalSessionItems(state.codexLocalSessions.items || []);
      const selectedProject = projects.find((item) => item.projectKey === projectKey);
      const selectedDay = selectedProject?.days.find((item) => item.dayKey === dayKey) || null;
      const selectedSession = selectedDay?.items[0] || null;

      if (!selectedProject || !selectedDay || !selectedSession) {
        return;
      }

      state.localSessionsPage.selectedProjectKey = selectedProject.projectKey;
      state.localSessionsPage.selectedDayKey = selectedDay.dayKey;
      state.localSessionsPage.selectedThreadId = selectedSession.threadId;
      await refreshLocalSessionDetail(selectedSession.threadId);
      renderLocalSessionsPage();
      bindLocalSessionsEvents();
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

  if (state.drawer.activeTab === "binding") {
    return `
      <div class="field">
        <label>手动绑定指令</label>
        <div class="inline-note">
          在飞书里直接对机器人发送 <strong>绑定姓名：张三</strong>，当前 open_id 会被写入映射并覆盖自动识别结果。
        </div>
      </div>
      <div class="field">
        <label>最近识别的身份</label>
        <div class="detail-list">
          ${
            recentOpenIds.length
              ? recentOpenIds
                  .map(
                    (item) => `
                      <div class="detail-row">
                        <span class="subtext">${escapeHtml(item.displayLabel || item.displayName || item.openId)}</span>
                        <strong>${escapeHtml(item.bindingSource || "unbound")}</strong>
                      </div>
                    `
                  )
                  .join("")
              : `<div class="empty-state">还没有可展示的 Feishu 身份记录。先从飞书发一条消息，系统会自动补齐姓名。</div>`
          }
        </div>
      </div>
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
                          ${escapeHtml(item.displayLabel || item.displayName || item.openId)}
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
    if (route().name === "dashboard") {
      startDashboardRefresh();
    } else {
      stopDashboardRefresh();
    }
  } catch (error) {
    stopDashboardRefresh();
    renderShell(
      "管理台加载失败",
      "后端接口已经启动，但当前页面没能正确拿到数据。",
      navButton("重试", "#/"),
      `<div class="panel"><div class="empty-state">${escapeHtml(error.message)}</div></div>`
    );
  }
}

window.addEventListener("hashchange", () => {
  stopDashboardRefresh();
  void boot();
});

window.addEventListener("click", (event) => {
  if (event.target === drawerRoot.querySelector(".drawer-backdrop")) {
    closeDrawer();
  }
});

void boot();
