const appRoot = document.getElementById("app");
const drawerRoot = document.getElementById("drawer-root");
const toastRoot = document.getElementById("toast-root");
const wizardRoot = document.getElementById("wizard-root");
let dashboardRefreshTimer = null;
let dashboardRefreshInFlight = false;
let localSessionsRefreshTimer = null;
let localSessionsRefreshInFlight = false;
let localSessionsRefreshRequestId = 0;
let startupDrawerApplied = false;
let startupSetupWizardApplied = false;

const state = {
  dashboard: null,
  codexOverview: null,
  codexLocalSessions: null,
  localSessionsPage: {
    selectedProjectKey: null,
    selectedDayKey: null,
    selectedThreadId: null,
    detail: null,
    loadError: null,
    projectSearchText: "",
    searchText: "",
    activeTab: "chat",
    sessionPage: 1
  },
  connectorConfigs: {},
  drawer: {
    open: false,
    mode: null,
    platform: null,
    activeTab: "connection",
    config: null,
    recentOpenIds: [],
    systemStatus: null,
    systemDraft: {
      apiBaseUrl: "",
      apiKey: ""
    }
  },
  setupWizard: {
    open: false,
    status: null
  }
};

const LANGUAGE_QUERY_KEY = "lang";
const LANGUAGE_STORAGE_KEY = "vible.preferredLanguage";
const SUPPORTED_LANGUAGES = new Set(["zh", "en"]);
let activeLanguage = "zh";
let i18nObserver = null;
let localizeInProgress = false;

const EN_TRANSLATIONS = Object.freeze({
  "任务驾驶舱与连接中心": "Task Cockpit & Connection Hub",
  "机器人消息仍然是主交互面，这个页面集中展示任务、会话、风控和连接状态，网页端承接少量补位操作。":
    "Robot messaging is still the primary interaction. This page centralizes tasks, sessions, risk checks, and connector status, with web as a fallback workspace.",
  "系统运行中": "System Running",
  "首页总览": "Dashboard",
  "本地会话页": "Local Sessions",
  "系统配置": "System Settings",
  "健康检查": "Health Check",
  "实时任务时间线": "Live Task Timeline",
  "优先展示系统正在执行什么，快速下钻到任务详情。":
    "Prioritize what is currently running and jump to task details quickly.",
  "Codex 左侧接管总览（24h）": "Codex Left-Side Overview (24h)",
  "更新时间：": "Updated:",
  "活跃任务": "Active Tasks",
  "最近会话": "Recent Sessions",
  "风险待确认": "Pending Risk Confirmations",
  "主确认链路优先在飞书 / QQ，网页端做补位确认。":
    "Primary confirmation should happen in Feishu / QQ, with web as fallback.",
  "连接中心": "Connection Hub",
  "这里是首页级操作区，不只是状态面板。":
    "This is an operational area, not just a status panel.",
  "本地会话目录": "Local Session Directory",
  "打开目录页": "Open Directory Page",
  "扫描时间：": "Scanned At:",
  "最近活跃会话": "Recently Active Sessions",
  "展示标题优先，sessionId 在详情中可见。": "Titles first; sessionId is shown in details.",
  "进行中任务": "Running Tasks",
  "待确认风险": "Pending Risks",
  "活跃会话": "Active Sessions",
  "今日失败": "Failed Today",
  "查看任务": "View Task",
  "停止任务": "Stop Task",
  "处理中": "Processing",
  "当前暂无任务事件。等飞书或 QQ 指令进入网关后，这里会滚动更新。":
    "No task events yet. This feed updates when Feishu or QQ commands enter the gateway.",
  "无风险说明": "No risk description",
  "发起人：": "Requested By:",
  "当前没有待确认风险": "No pending risks right now",
  "大部分确认动作优先在飞书 / QQ 消息里完成。":
    "Most confirmations should still be completed in Feishu / QQ.",
  "尚未绑定默认群 / 频道": "No default group/channel bound",
  "接入模式：": "Mode:",
  "最近联调：": "Last Test:",
  "已可用于机器人消息链路": "Ready for bot messaging flow",
  "未完成接入": "Setup incomplete",
  "编辑配置": "Edit Config",
  "暂无连接器配置。": "No connector configuration yet.",
  "暂无本地会话目录数据。": "No local session directory data yet.",
  "暂无消息": "No message yet",
  "暂无活跃会话。": "No active sessions.",
  "Codex 总览暂不可用：": "Codex overview is unavailable:",
  "暂无摘要": "No summary yet",
  "任务详情": "Task Detail",
  "事件流": "Event Stream",
  "近 24 小时没有进行中的 Codex 任务。": "No running Codex tasks in the last 24 hours.",
  "近 24 小时没有 Codex 会话更新。": "No Codex session updates in the last 24 hours.",
  "首页数据暂不可用，请稍后刷新。": "Dashboard data is unavailable. Please refresh later.",
  "本地会话工作台": "Local Session Workspace",
  "按项目聚合本地 Codex 会话，快速查看历史对话、上下文与工具调用记录。":
    "Group local Codex sessions by project to quickly inspect history, context, and tool calls.",
  "返回首页": "Back to Dashboard",
  "刷新扫描": "Refresh Scan",
  "刷新目录": "Refresh Directory",
  "项目目录": "Project Directory",
  "搜索项目名称或路径": "Search project name or path",
  "全部项目": "All Projects",
  "未选择项目": "No project selected",
  "搜索会话标题": "Search session title",
  "会话日期": "Session Date",
  "暂无可选日期": "No available dates",
  "当前条件下没有会话。": "No sessions match current filters.",
  "选择会话后显示详细聊天内容。": "Select a session to view detailed chat content.",
  "会话详情加载失败：": "Failed to load session detail:",
  "工具调用": "Tool Calls",
  "元数据": "Metadata",
  "刷新当前对话": "Refresh Current Chat",
  "会话信息": "Session Info",
  "没有匹配到项目。": "No matching projects.",
  "没有可展示的聊天内容。": "No chat content to display.",
  "当前会话没有普通对话消息，仅包含工具调用记录。": "This session has no normal chat messages, only tool call records.",
  "没有工具调用记录。": "No tool call records.",
  "未识别到文件路径记录。": "No file path records recognized.",
  "请选择日期": "Please select a date",
  "工具调用与返回 ": "Tool calls and returns: ",
  "工具返回": "Tool Return",
  "工具调用": "Tool Call"
});

const EN_TRANSLATION_PAIRS = Object.entries(EN_TRANSLATIONS).sort((left, right) => right[0].length - left[0].length);

function normalizeLanguage(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return null;
  }
  if (text.startsWith("zh")) {
    return "zh";
  }
  if (text.startsWith("en")) {
    return "en";
  }
  return null;
}

function detectLanguage() {
  const queryLang = normalizeLanguage(new URLSearchParams(window.location.search || "").get(LANGUAGE_QUERY_KEY));
  if (queryLang && SUPPORTED_LANGUAGES.has(queryLang)) {
    return queryLang;
  }

  let storedLang = null;
  try {
    storedLang = normalizeLanguage(window.localStorage?.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    storedLang = null;
  }
  if (storedLang && SUPPORTED_LANGUAGES.has(storedLang)) {
    return storedLang;
  }

  const browserLanguages = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language];
  for (const language of browserLanguages) {
    const normalized = normalizeLanguage(language);
    if (normalized && SUPPORTED_LANGUAGES.has(normalized)) {
      return normalized;
    }
  }

  return "en";
}

function applyLanguage(language) {
  activeLanguage = language;
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  try {
    window.localStorage?.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // ignore storage errors
  }
}

function translateToEnglish(text) {
  let output = String(text ?? "");
  for (const [source, target] of EN_TRANSLATION_PAIRS) {
    if (output.includes(source)) {
      output = output.split(source).join(target);
    }
  }
  return output;
}

function localizeText(text) {
  if (activeLanguage !== "en") {
    return String(text ?? "");
  }
  return translateToEnglish(text);
}

function localizeAttributes(element) {
  const attrs = ["title", "placeholder", "aria-label"];
  attrs.forEach((name) => {
    if (!element.hasAttribute(name)) {
      return;
    }
    const original = element.getAttribute(name);
    if (!original || !/[\u4e00-\u9fff]/.test(original)) {
      return;
    }
    const localized = localizeText(original);
    if (localized !== original) {
      element.setAttribute(name, localized);
    }
  });
}

function localizeElementTree(root) {
  if (activeLanguage !== "en" || !root) {
    return;
  }
  if (localizeInProgress) {
    return;
  }
  localizeInProgress = true;
  try {
    const textNodeFilter = {
      acceptNode(node) {
        if (!node.nodeValue || !/[\u4e00-\u9fff]/.test(node.nodeValue)) {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, textNodeFilter);
    let textNode = walker.nextNode();
    while (textNode) {
      textNode.nodeValue = localizeText(textNode.nodeValue);
      textNode = walker.nextNode();
    }

    if (root instanceof Element) {
      localizeAttributes(root);
      root.querySelectorAll("*").forEach((element) => localizeAttributes(element));
    }
  } finally {
    localizeInProgress = false;
  }
}

function installI18nObserver() {
  if (activeLanguage !== "en" || i18nObserver) {
    return;
  }

  i18nObserver = new MutationObserver((records) => {
    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE && /[\u4e00-\u9fff]/.test(node.nodeValue || "")) {
          node.nodeValue = localizeText(node.nodeValue || "");
          return;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          localizeElementTree(node);
        }
      });
    });
  });

  i18nObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  localizeElementTree(document.body);
}

function showToast(message, tone = "info") {
  const stack = ensureToastStack();
  const toast = document.createElement("div");
  toast.className = `toast ${tone}`;
  toast.textContent = localizeText(message);
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

async function loadCodexLocalSessions(options = {}) {
  const refresh = options.refresh === true;
  try {
    return await fetchJson(`/api/codex/local-sessions?limit=500${refresh ? "&refresh=true" : ""}`);
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

async function loadLocalSessionDetail(threadId, options = {}) {
  const refresh = options.refresh === true;
  return await fetchJson(`/api/codex/local-sessions/${encodeURIComponent(threadId)}${refresh ? "?refresh=true" : ""}`);
}

async function loadLocalSessionsPage(threadId = null, options = {}) {
  const refreshSnapshot = options.refreshSnapshot === true;
  const refreshDetail = options.refreshDetail !== false;
  state.codexLocalSessions = await loadCodexLocalSessions({ refresh: refreshSnapshot });
  state.localSessionsPage.loadError = null;
  state.localSessionsPage.sessionPage = 1;

  const projects = groupLocalSessionItems(state.codexLocalSessions.items || []);
  const selection = resolveLocalSessionSelection(projects, threadId || null);

  state.localSessionsPage.selectedProjectKey = selection.project?.projectKey || null;
  state.localSessionsPage.selectedDayKey = selection.day?.dayKey || null;
  state.localSessionsPage.selectedThreadId = selection.session?.threadId || null;
  state.localSessionsPage.detail = null;

  if (state.localSessionsPage.selectedThreadId) {
    await refreshLocalSessionDetail(state.localSessionsPage.selectedThreadId, { refresh: refreshDetail });
  }
}

function syncLocalSessionDetailToSnapshot(detail) {
  if (!state.codexLocalSessions || !detail) {
    return;
  }

  state.codexLocalSessions = {
    ...state.codexLocalSessions,
    items: (state.codexLocalSessions.items || []).map((item) =>
      item.threadId === detail.threadId ? { ...item, ...detail } : item
    )
  };
}

async function refreshLocalSessionDetail(threadId, options = {}) {
  const requestId = ++localSessionsRefreshRequestId;
  const refresh = options.refresh === true;
  const updateSnapshot = options.updateSnapshot !== false;
  if (!threadId) {
    state.localSessionsPage.detail = null;
    return null;
  }

  try {
    const detail = await loadLocalSessionDetail(threadId, { refresh });
    if (
      requestId !== localSessionsRefreshRequestId ||
      route().name !== "localSessions" ||
      state.localSessionsPage.selectedThreadId !== threadId
    ) {
      return null;
    }
    state.localSessionsPage.detail = detail;
    state.localSessionsPage.loadError = null;
    if (updateSnapshot) {
      syncLocalSessionDetailToSnapshot(detail);
    }
    return detail;
  } catch (error) {
    if (requestId !== localSessionsRefreshRequestId) {
      return null;
    }
    state.localSessionsPage.detail = null;
    state.localSessionsPage.loadError = error.message || "Local session detail unavailable";
    return null;
  }
}

function stopLocalSessionsRefresh() {
  if (!localSessionsRefreshTimer) {
    return;
  }

  clearInterval(localSessionsRefreshTimer);
  localSessionsRefreshTimer = null;
}

function startLocalSessionsRefresh() {
  if (localSessionsRefreshTimer) {
    return;
  }

  localSessionsRefreshTimer = window.setInterval(() => {
    if (route().name !== "localSessions" || localSessionsRefreshInFlight) {
      return;
    }

    const threadId = state.localSessionsPage.selectedThreadId;
    if (!threadId) {
      return;
    }

    localSessionsRefreshInFlight = true;
    void refreshLocalSessionDetail(threadId, { refresh: true })
      .then((detail) => {
        if (!detail || route().name !== "localSessions" || state.localSessionsPage.selectedThreadId !== threadId) {
          return;
        }
        renderLocalSessionsPage();
        bindLocalSessionsEvents();
      })
      .catch(() => {
        // 保持当前页面内容不变，下一轮继续尝试。
      })
      .finally(() => {
        localSessionsRefreshInFlight = false;
      });
  }, 10000);
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

async function loadSystemCodexStatus() {
  return await fetchJson("/api/system/codex-cli/status");
}

function isSetupWizardRequired(status) {
  if (!status) {
    return false;
  }
  if (status.setupWizard && typeof status.setupWizard.required === "boolean") {
    return status.setupWizard.required;
  }
  const apiReady = Boolean(status.apiConfig?.baseUrl) && Boolean(status.apiConfig?.keyConfigured);
  return !status.installed || !apiReady || !status.projectAuthorization?.trustedInConfig;
}

function setupWizardDismissKey(status) {
  const projectRoot = status?.projectRoot || "default_project";
  return `vct.setupWizard.dismissed.${projectRoot}`;
}

function setupWizardFingerprint(status) {
  const reasons = status?.setupWizard?.reasons || [];
  return Array.isArray(reasons) ? reasons.join(",") : "";
}

function markSetupWizardDismissed(status) {
  try {
    const key = setupWizardDismissKey(status);
    const fingerprint = setupWizardFingerprint(status);
    localStorage.setItem(key, fingerprint || "dismissed");
  } catch {
    // ignore storage errors
  }
}

function shouldSkipSetupWizardByDismiss(status) {
  if (isSetupWizardRequired(status)) {
    return false;
  }
  try {
    const key = setupWizardDismissKey(status);
    const expected = setupWizardFingerprint(status) || "dismissed";
    return localStorage.getItem(key) === expected;
  } catch {
    return false;
  }
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

function formatLocalSessionDateLabel(year, month, day) {
  return `${year}-${month}-${day}`;
}

function formatLocalSessionDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const dateTimeLocale = activeLanguage === "zh" ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(dateTimeLocale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function shortenLocalSessionThreadId(threadId) {
  return threadId ? `${threadId.slice(0, 8)}…${threadId.slice(-4)}` : "-";
}

function matchesLocalSessionQuery(item, query) {
  if (!query) {
    return true;
  }

  const haystack = [
    item.projectName,
    item.projectPath,
    item.sessionTitle,
    item.rolloutFileName,
    item.threadId,
    item.updatedAt,
    `${item.year}-${item.month}-${item.day}`
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function matchesLocalProjectQuery(project, query) {
  if (!query) {
    return true;
  }

  const haystack = [project.projectName, project.projectPath, project.count].join(" ").toLowerCase();
  return haystack.includes(query);
}

function renderLocalIcon(name) {
  const size = 16;
  if (name === "search") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle><path d="M16 16l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>`;
  }
  if (name === "folder") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M3.5 7.5h5l2 2h10v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path><path d="M3.5 9.5h17" fill="none" stroke="currentColor" stroke-width="1.6"></path></svg>`;
  }
  if (name === "refresh") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M20 12a8 8 0 0 1-14.5 4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path><path d="M4.5 16.6L5 20l3.4-.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M4 12a8 8 0 0 1 14.4-4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path><path d="M19.5 7.2L19 3.8l-3.4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
  }
  if (name === "settings") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M12 8.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6zm8.1 3.8 1.6 1-1.6 2.7-1.9-.5a7.8 7.8 0 0 1-1.3 1.3l.5 1.9-2.7 1.6-1-1.6a7.8 7.8 0 0 1-1.8 0l-1 1.6-2.7-1.6.5-1.9a7.8 7.8 0 0 1-1.3-1.3l-1.9.5L2.3 13l1.6-1a7.8 7.8 0 0 1 0-1.8l-1.6-1 1.6-2.7 1.9.5a7.8 7.8 0 0 1 1.3-1.3l-.5-1.9 2.7-1.6 1 1.6a7.8 7.8 0 0 1 1.8 0l1-1.6 2.7 1.6-.5 1.9a7.8 7.8 0 0 1 1.3 1.3l1.9-.5 1.6 2.7-1.6 1c.1.6.1 1.2 0 1.8z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"></path></svg>`;
  }
  if (name === "copy") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><rect x="9" y="8" width="11" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"></rect><path d="M5 16H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>`;
  }
  if (name === "share") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M8 12l8-5m-8 5 8 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path><circle cx="6" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle><circle cx="18" cy="7" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle><circle cx="18" cy="17" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle></svg>`;
  }
  if (name === "download") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><path d="M4 17.5v1.2A2.3 2.3 0 0 0 6.3 21h11.4a2.3 2.3 0 0 0 2.3-2.3v-1.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>`;
  }
  if (name === "delete") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M4.5 7h15m-11 0V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7m-9 0 1 12a1.8 1.8 0 0 0 1.8 1.6h5.4a1.8 1.8 0 0 0 1.8-1.6l1-12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
  }
  if (name === "filter") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M4 6h16l-6.2 7v5l-3.6-2v-3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path></svg>`;
  }
  if (name === "sort") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M7 5v14m0 0-3-3m3 3 3-3M17 19V5m0 0-3 3m3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
  }
  if (name === "chat") {
    return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3.5c5 0 9 3.4 9 7.6s-4 7.6-9 7.6a11.2 11.2 0 0 1-4.1-.8l-4 2 .9-3.7C3.6 15 3 13.1 3 11.1 3 6.9 7 3.5 12 3.5z" fill="url(#lswChatGrad)"></path><circle cx="9.3" cy="11.1" r="1" fill="#fff"></circle><circle cx="12" cy="11.1" r="1" fill="#fff"></circle><circle cx="14.7" cy="11.1" r="1" fill="#fff"></circle><defs><linearGradient id="lswChatGrad" x1="3" y1="4" x2="21" y2="20" gradientUnits="userSpaceOnUse"><stop stop-color="#5b9bff"></stop><stop offset="1" stop-color="#82a9ff"></stop></linearGradient></defs></svg>`;
  }
  if (name === "pin") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M8.5 3h7l-.8 5.1 2.9 2.9v1.5h-4.8L12 21l-.8-8.5H6.4V11l2.9-2.9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path></svg>`;
  }
  if (name === "home") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5v8a1.5 1.5 0 0 1-1.5 1.5h-4.2v-6h-4.6v6H5.5A1.5 1.5 0 0 1 4 18.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"></path></svg>`;
  }
  return "";
}

function deriveLocalSessionArtifacts(messages) {
  const filePattern = /(?:\/|\\)?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*\.(?:ts|tsx|js|jsx|json|jsonl|md|py|java|go|css|scss|html|yml|yaml|sql|sh|bat|txt)\b/g;
  const fileSet = new Set();
  const tools = [];
  for (const message of messages) {
    const content = String(message.content || "");
    const matchedFiles = content.match(filePattern) || [];
    for (const fileName of matchedFiles) {
      fileSet.add(fileName);
    }
    if (message.kind === "tool_call") {
      tools.push({
        name: message.name || "tool_call",
        timestamp: message.timestamp || "",
        preview: content
      });
    }
  }

  return {
    files: [...fileSet].slice(0, 100),
    tools
  };
}

function formatDashboardNow() {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
}

function resolveDashboardTone(status) {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return "neutral";
  }

  if (normalized.includes("run") || normalized.includes("active") || normalized.includes("connect") || normalized.includes("success") || normalized.includes("succeed")) {
    return "success";
  }

  if (normalized.includes("pending") || normalized.includes("wait")) {
    return "warning";
  }

  if (normalized.includes("fail") || normalized.includes("error") || normalized.includes("disconnect")) {
    return "danger";
  }

  return "neutral";
}

function renderDashboardIcon(name) {
  const size = 20;

  if (name === "running") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle><path d="M12 7.5v4.8l3.4 2.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
  }
  if (name === "risk") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M12 3.8 3.5 8v6.3c0 3.9 3.4 7.1 8.5 8.9 5.1-1.8 8.5-5 8.5-8.9V8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path><path d="M12 9v5.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path><circle cx="12" cy="16.9" r="1.1" fill="currentColor"></circle></svg>`;
  }
  if (name === "chat") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M12 4c5 0 9 3.3 9 7.3s-4 7.3-9 7.3c-1.3 0-2.6-.2-3.8-.7L4 20l1.1-3.5C3.8 15 3 13.2 3 11.3 3 7.3 7 4 12 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path><circle cx="8.7" cy="11.2" r="1" fill="currentColor"></circle><circle cx="12" cy="11.2" r="1" fill="currentColor"></circle><circle cx="15.3" cy="11.2" r="1" fill="currentColor"></circle></svg>`;
  }
  if (name === "failed") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"></rect><path d="M8 3.8v3.5m8-3.5v3.5M7.8 12.3h8.4m-8.4 3.4h5.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>`;
  }
  if (name === "feishu") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M4 10.4 12.5 4 20 10l-8.6 3.3z" fill="#4fc3ff"></path><path d="M7.1 13.4 16 10l4 3.2-8.7 4.8z" fill="#4b8bff"></path><path d="M4 10.5 11.3 18 4 20z" fill="#74d8ff"></path></svg>`;
  }
  if (name === "qq") {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><ellipse cx="12" cy="11.2" rx="5.5" ry="6.2" fill="#111827"></ellipse><ellipse cx="12" cy="10.7" rx="3.3" ry="3.8" fill="#fff"></ellipse><path d="M8.4 15.2c0 2 1.6 3.6 3.6 3.6s3.6-1.6 3.6-3.6v-.5H8.4z" fill="#fbbf24"></path><circle cx="10.9" cy="10.4" r="0.45" fill="#111827"></circle><circle cx="13.1" cy="10.4" r="0.45" fill="#111827"></circle></svg>`;
  }

  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle></svg>`;
}

function renderDashboardPage() {
  const dashboard = state.dashboard;
  if (!dashboard) {
    appRoot.innerHTML = `<div class="mc-dashboard-empty">首页数据暂不可用，请稍后刷新。</div>`;
    return;
  }

  const codexOverview = state.codexOverview ?? {
    summary: null,
    activeTasks: [],
    recentSessions: [],
    updatedAt: null,
    loadError: null
  };

  const codexLocalSessions = state.codexLocalSessions ?? {
    groups: [],
    items: [],
    totalFiles: 0,
    totalThreads: 0,
    scannedAt: null,
    loadError: null
  };

  const localSessionProjects = groupLocalSessionItems(codexLocalSessions.items || []);

  const metrics = [
    {
      key: "running",
      label: "进行中任务",
      subtitle: "RUNNING TASKS",
      value: dashboard.summary.runningTaskCount
    },
    {
      key: "risk",
      label: "待确认风险",
      subtitle: "PENDING RISKS",
      value: dashboard.summary.pendingRiskCount
    },
    {
      key: "chat",
      label: "活跃会话",
      subtitle: "ACTIVE CONVERSATIONS",
      value: dashboard.summary.activeSessionCount
    },
    {
      key: "failed",
      label: "今日失败",
      subtitle: "TODAY FAILED",
      value: dashboard.summary.failedTaskCountToday
    }
  ]
    .map(
      (item) => `
        <article class="mc-metric-card mc-metric-${item.key}">
          <div class="mc-metric-icon">${renderDashboardIcon(item.key)}</div>
          <div>
            <div class="mc-metric-value">${escapeHtml(item.value)}</div>
            <div class="mc-metric-label">${escapeHtml(item.label)}</div>
            <div class="mc-metric-subtitle">${escapeHtml(item.subtitle)}</div>
          </div>
        </article>
      `
    )
    .join("");

  const timelineHtml = dashboard.taskTimeline.length
    ? dashboard.taskTimeline
        .slice(0, 8)
        .map((item) => {
          const tone = resolveDashboardTone(item.status);
          const canStop = Boolean(item.canStop);
          return `
            <article class="mc-timeline-item">
              <div class="mc-timeline-dot mc-tone-${tone}"></div>
              <div class="mc-timeline-content">
                <div class="mc-timeline-head">
                  <span class="mc-timeline-time">${escapeHtml(formatLocalSessionDateTime(item.updatedAt))}</span>
                  <span class="mc-status mc-status-${tone}">${escapeHtml(item.status || "UNKNOWN")}</span>
                </div>
                <h3>${escapeHtml(item.taskTitle || item.sessionId || item.taskId)}</h3>
                <p>${escapeHtml(item.summary || "暂无摘要")}</p>
                <div class="mc-timeline-actions">
                  <a class="mc-inline-btn" href="#/tasks/${encodeURIComponent(item.taskId)}">查看任务</a>
                  <button class="mc-inline-btn secondary" ${canStop ? `data-stop-task="${escapeHtml(item.taskId)}"` : "disabled"}>
                    ${canStop ? "停止任务" : "处理中"}
                  </button>
                </div>
              </div>
            </article>
          `;
        })
        .join("")
    : `<div class="mc-empty">当前暂无任务事件。等飞书或 QQ 指令进入网关后，这里会滚动更新。</div>`;

  const risksHtml = dashboard.pendingRisks.length
    ? dashboard.pendingRisks
        .slice(0, 4)
        .map(
          (item) => `
            <article class="mc-risk-item">
              <div class="mc-risk-head">
                <h3>${escapeHtml(item.taskTitle || item.sessionId)}</h3>
                <span class="mc-status mc-status-warning">待确认</span>
              </div>
              <p>${escapeHtml(item.riskReason || "无风险说明")}</p>
              <div class="mc-risk-foot">
                <span>发起人：${escapeHtml(item.requestedBy || "-")}</span>
                <div class="mc-risk-actions">
                  <button class="mc-inline-btn" data-confirm-risk="${escapeHtml(item.confirmationToken)}">确认</button>
                  <button class="mc-inline-btn secondary" data-reject-risk="${escapeHtml(item.confirmationToken)}">拒绝</button>
                </div>
              </div>
            </article>
          `
        )
        .join("")
    : `
      <div class="mc-empty">
        <div class="mc-empty-icon">${renderDashboardIcon("risk")}</div>
        <strong>当前没有待确认风险</strong>
        <p>大部分确认动作优先在飞书 / QQ 消息里完成。</p>
      </div>
    `;

  const connectorsHtml = dashboard.connectors.length
    ? dashboard.connectors
        .map((connector) => {
          const tone = resolveDashboardTone(connector.connectionStatus);
          const platformName = String(connector.platform || "").toLowerCase();
          const iconName = platformName === "feishu" ? "feishu" : platformName === "qq" ? "qq" : "running";
          return `
            <article class="mc-connector-item">
              <div class="mc-connector-head">
                <div class="mc-connector-id">
                  <span class="mc-connector-icon">${renderDashboardIcon(iconName)}</span>
                  <div>
                    <h3>${escapeHtml(String(connector.platform || "").toUpperCase())}</h3>
                    <p>${escapeHtml(connector.defaultChannelName || "尚未绑定默认群 / 频道")}</p>
                  </div>
                </div>
                <span class="mc-status mc-status-${tone}">${escapeHtml(connector.connectionStatus || "UNKNOWN")}</span>
              </div>
              <div class="mc-connector-meta">
                <span>接入模式：${escapeHtml(connector.eventMode || "-")}</span>
                <span>最近联调：${escapeHtml(connector.lastTestResult || "未测试")}</span>
              </div>
              <div class="mc-connector-foot">
                <span>${connector.enabled ? "已可用于机器人消息链路" : "未完成接入"}</span>
                <button class="mc-inline-btn" data-open-connector="${escapeHtml(connector.platform)}">编辑配置</button>
              </div>
            </article>
          `;
        })
        .join("")
    : `<div class="mc-empty">暂无连接器配置。</div>`;

  const localSessionsHtml = localSessionProjects.length
    ? localSessionProjects
        .slice(0, 3)
        .map(
          (project) => `
            <article class="mc-local-item">
              <div class="mc-local-head">
                <h3>${escapeHtml(project.projectName)}</h3>
                <span>${escapeHtml(project.count)} 条</span>
              </div>
              <p>${escapeHtml(project.projectPath || "-")}</p>
              <div class="mc-local-days">
                ${project.days
                  .slice(0, 3)
                  .map((day) => `<span>${escapeHtml(day.label)} (${escapeHtml(day.count)})</span>`)
                  .join("")}
              </div>
            </article>
          `
        )
        .join("")
    : `<div class="mc-empty">暂无本地会话目录数据。</div>`;

  const activeSessionsHtml = dashboard.activeSessions.length
    ? dashboard.activeSessions
        .slice(0, 5)
        .map((item) => {
          const tone = resolveDashboardTone(item.status);
          return `
            <a class="mc-session-item" href="#/sessions/${encodeURIComponent(item.sessionId)}">
              <div>
                <h3>${escapeHtml(item.taskTitle || item.sessionId)}</h3>
                <p>${escapeHtml(item.lastMessageSummary || "暂无消息")}</p>
              </div>
              <span class="mc-status mc-status-${tone}">${escapeHtml(item.status || "UNKNOWN")}</span>
            </a>
          `;
        })
        .join("")
    : `<div class="mc-empty">暂无活跃会话。</div>`;

  const codexSummary = codexOverview.summary;
  const codexSummaryHtml = codexSummary
    ? `
      <div class="mc-codex-metrics">
        <span><strong>${escapeHtml(codexSummary.runningTaskCount)}</strong> 运行中</span>
        <span><strong>${escapeHtml(codexSummary.succeededTaskCount)}</strong> 成功</span>
        <span><strong>${escapeHtml(codexSummary.failedTaskCount)}</strong> 失败</span>
        <span><strong>${escapeHtml(codexSummary.activeSessionCount)}</strong> 活跃会话</span>
      </div>
    `
    : `<div class="mc-empty">Codex 总览暂不可用：${escapeHtml(codexOverview.loadError || "unknown_error")}</div>`;

  const codexActiveTasksHtml = codexOverview.activeTasks?.length
    ? codexOverview.activeTasks
        .slice(0, 4)
        .map((item) => {
          const tone = resolveDashboardTone(item.status);
          return `
            <article class="mc-codex-item">
              <div class="mc-codex-item-head">
                <h3>${escapeHtml(item.taskTitle || item.taskId)}</h3>
                <span class="mc-status mc-status-${tone}">${escapeHtml(item.status || "UNKNOWN")}</span>
              </div>
              <p>${escapeHtml(item.summary || "暂无摘要")}</p>
              <div class="mc-codex-item-actions">
                <a class="mc-inline-btn secondary" href="#/tasks/${encodeURIComponent(item.taskId)}">任务详情</a>
                <a class="mc-inline-btn secondary" href="#/codex/tasks/${encodeURIComponent(item.taskId)}/events">事件流</a>
              </div>
            </article>
          `;
        })
        .join("")
    : `<div class="mc-empty">近 24 小时没有进行中的 Codex 任务。</div>`;

  const codexRecentSessionsHtml = codexOverview.recentSessions?.length
    ? codexOverview.recentSessions
        .slice(0, 4)
        .map((item) => {
          const tone = resolveDashboardTone(item.status);
          return `
            <a class="mc-codex-session" href="#/sessions/${encodeURIComponent(item.sessionId)}">
              <div>
                <h3>${escapeHtml(item.latestTaskSummary || item.sessionId)}</h3>
                <p>${escapeHtml(item.latestMessageSummary || "暂无消息")}</p>
              </div>
              <span class="mc-status mc-status-${tone}">${escapeHtml(item.status || "UNKNOWN")}</span>
            </a>
          `;
        })
        .join("")
    : `<div class="mc-empty">近 24 小时没有 Codex 会话更新。</div>`;

  appRoot.innerHTML = `
    <div class="mc-dashboard">
      <div class="mc-orb mc-orb-a"></div>
      <div class="mc-orb mc-orb-b"></div>
      <header class="mc-topbar">
        <div class="mc-title-wrap">
          <h1>任务驾驶舱与连接中心</h1>
          <div class="mc-title-sub">MISSION CONTROL & CONNECTION CENTER</div>
          <p>机器人消息仍然是主交互面，这个页面集中展示任务、会话、风控和连接状态，网页端承接少量补位操作。</p>
        </div>
        <div class="mc-head-side">
          <div class="mc-runtime">
            <span>◷ ${escapeHtml(formatDashboardNow())}</span>
            <span class="mc-runtime-dot">系统运行中</span>
          </div>
          <div class="mc-quick-links">
            <a href="#/" class="mc-nav-chip active">首页总览</a>
            <a href="#/local-sessions" class="mc-nav-chip">本地会话页</a>
            <button type="button" class="mc-nav-chip" data-open-system-config="true">系统配置</button>
            <a href="/health" class="mc-nav-chip">健康检查</a>
          </div>
        </div>
      </header>

      <section class="mc-metric-grid">${metrics}</section>

      <section class="mc-grid">
        <div class="mc-left">
          <article class="mc-panel">
            <div class="mc-panel-head">
              <div>
                <h2>实时任务时间线</h2>
                <p>优先展示系统正在执行什么，快速下钻到任务详情。</p>
              </div>
            </div>
            <div class="mc-timeline">${timelineHtml}</div>
          </article>

          <article class="mc-panel">
            <div class="mc-panel-head">
              <div>
                <h2>Codex 左侧接管总览（24h）</h2>
                <p>更新时间：${escapeHtml(codexOverview.updatedAt || "-")}</p>
              </div>
            </div>
            ${codexSummaryHtml}
            <div class="mc-two-col">
              <section>
                <h3>活跃任务</h3>
                <div class="mc-codex-list">${codexActiveTasksHtml}</div>
              </section>
              <section>
                <h3>最近会话</h3>
                <div class="mc-codex-list">${codexRecentSessionsHtml}</div>
              </section>
            </div>
          </article>
        </div>

        <aside class="mc-right">
          <article class="mc-panel">
            <div class="mc-panel-head">
              <div>
                <h2>风险待确认</h2>
                <p>主确认链路优先在飞书 / QQ，网页端做补位确认。</p>
              </div>
            </div>
            <div class="mc-risk-list">${risksHtml}</div>
          </article>

          <article class="mc-panel">
            <div class="mc-panel-head">
              <div>
                <h2>连接中心</h2>
                <p>这里是首页级操作区，不只是状态面板。</p>
              </div>
            </div>
            <div class="mc-connector-list">${connectorsHtml}</div>
          </article>

          <article class="mc-panel">
            <div class="mc-panel-head">
              <div>
                <h2>本地会话目录</h2>
                <p>线程数 ${escapeHtml(codexLocalSessions.totalThreads || 0)} · 文件数 ${escapeHtml(codexLocalSessions.totalFiles || 0)}</p>
              </div>
              <button class="mc-inline-btn secondary" data-open-local-sessions="true">打开目录页</button>
            </div>
            <div class="mc-local-list">${localSessionsHtml}</div>
            <div class="mc-foot-note">扫描时间：${escapeHtml(codexLocalSessions.scannedAt || "-")}</div>
          </article>

          <article class="mc-panel">
            <div class="mc-panel-head">
              <div>
                <h2>最近活跃会话</h2>
                <p>展示标题优先，sessionId 在详情中可见。</p>
              </div>
            </div>
            <div class="mc-session-list">${activeSessionsHtml}</div>
          </article>
        </aside>
      </section>
    </div>
  `;
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
  const roleLabel = message.role === "user" ? "用户" : "助手";
  const roleClass = message.role === "user" ? "user" : "assistant";
  const body = escapeHtml(message.content || "").replaceAll("\n", "<br/>");
  const avatarText = message.role === "user" ? "用户" : "助手";

  return `
    <article class="lsw-chat-row ${roleClass === "user" ? "is-user" : ""}">
      <div class="lsw-chat-avatar">${escapeHtml(avatarText)}</div>
      <div class="lsw-chat-bubble ${roleClass === "user" ? "is-user" : ""}">
        <div class="lsw-chat-meta">
          <strong>${escapeHtml(roleLabel)}</strong>
          <span>${escapeHtml(formatLocalSessionDateTime(message.timestamp))}</span>
        </div>
        <div class="lsw-chat-content">${body}</div>
      </div>
    </article>
  `;
}

function isLocalToolEvent(message) {
  return message.kind === "tool_call" || message.kind === "tool_output";
}

function isLocalNormalChatMessage(message) {
  return message.kind === "message" && (message.role === "assistant" || message.role === "user");
}

function renderLocalToolFoldRow(block, index) {
  const summary = `工具调用与返回 ${block.length} 条`;
  return `
    <details class="lsw-tool-fold">
      <summary>
        <span>${escapeHtml(summary)}</span>
        <span class="lsw-tool-fold-time">${escapeHtml(formatLocalSessionDateTime(block[0]?.timestamp || ""))}</span>
      </summary>
      <div class="lsw-tool-fold-body">
        ${block
          .map(
            (item, subIndex) => `
              <div class="lsw-tool-fold-row">
                <div class="lsw-tool-fold-title">${escapeHtml(item.kind === "tool_call" ? "工具调用" : "工具返回")} ${escapeHtml(
              String(index + 1)
            )}.${escapeHtml(String(subIndex + 1))}</div>
                ${item.name ? `<div class="lsw-tool-fold-name">${escapeHtml(item.name)}</div>` : ""}
                <pre>${escapeHtml(String(item.content || "")).slice(0, 1200)}</pre>
              </div>
            `
          )
          .join("")}
      </div>
    </details>
  `;
}

function renderLocalChatTimeline(messages, dateLabel) {
  if (!messages.length) {
    return `<div class="lsw-empty">没有可展示的聊天内容。</div>`;
  }

  const blocks = [];
  let toolBuffer = [];

  const flushTools = () => {
    if (toolBuffer.length > 0) {
      blocks.push({ type: "tool", items: [...toolBuffer] });
      toolBuffer = [];
    }
  };

  for (const message of messages) {
    if (isLocalNormalChatMessage(message)) {
      flushTools();
      blocks.push({ type: "chat", item: message });
      continue;
    }
    if (isLocalToolEvent(message)) {
      toolBuffer.push(message);
    }
  }
  flushTools();

  if (!blocks.length) {
    return `<div class="lsw-empty">当前会话没有普通对话消息，仅包含工具调用记录。</div>`;
  }

  return `
    <div class="lsw-date-divider">${escapeHtml(dateLabel)}</div>
    ${blocks
      .map((block, index) => (block.type === "chat" ? renderLocalSessionMessage(block.item) : renderLocalToolFoldRow(block.items, index)))
      .join("")}
  `;
}

function scrollLocalChatToBottom() {
  const chatScroll = appRoot.querySelector(".lsw-chat-scroll");
  if (!(chatScroll instanceof HTMLElement)) {
    return;
  }
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function renderLocalSessionsPage() {
  const snapshot = state.codexLocalSessions;
  if (!snapshot) {
    appRoot.innerHTML = `<div class="lsw-root"><div class="lsw-loading">正在扫描本地 rollout 文件...</div></div>`;
    return;
  }

  const allProjects = groupLocalSessionItems(snapshot.items || []);
  const projectSearchText = state.localSessionsPage.projectSearchText.trim();
  const projectSearchQuery = projectSearchText.toLowerCase();
  const sessionSearchText = state.localSessionsPage.searchText.trim();
  const sessionSearchQuery = sessionSearchText.toLowerCase();
  const activeTab = state.localSessionsPage.activeTab || "chat";

  const filteredProjects = allProjects.filter((project) => matchesLocalProjectQuery(project, projectSearchQuery));
  const poolProjects = filteredProjects.length > 0 ? filteredProjects : allProjects;

  let selection = resolveLocalSessionSelection(poolProjects, state.localSessionsPage.selectedThreadId);
  let selectedProject = selection.project;
  let selectedDay = selection.day;
  let selectedSession = selection.session;

  state.localSessionsPage.selectedProjectKey = selectedProject?.projectKey || null;
  state.localSessionsPage.selectedDayKey = selectedDay?.dayKey || null;
  state.localSessionsPage.selectedThreadId = selectedSession?.threadId || null;

  const sessionsByDay = (selectedDay?.items || []).filter((item) => matchesLocalSessionQuery(item, sessionSearchQuery));
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(sessionsByDay.length / pageSize));
  const sessionPage = Math.min(Math.max(state.localSessionsPage.sessionPage || 1, 1), totalPages);
  state.localSessionsPage.sessionPage = sessionPage;
  const pageStart = (sessionPage - 1) * pageSize;
  const pagedSessions = sessionsByDay.slice(pageStart, pageStart + pageSize);

  const selectedDetail = state.localSessionsPage.detail;
  const detail = selectedDetail && selectedSession && selectedDetail.threadId === selectedSession.threadId ? selectedDetail : null;
  const chatMessages = detail ? detail.messages.slice(-120) : [];
  const artifacts = detail ? deriveLocalSessionArtifacts(detail.messages) : { files: [], tools: [] };
  const chatOnlyCount = chatMessages.filter((message) => isLocalNormalChatMessage(message)).length;
  const toolOnlyCount = chatMessages.filter((message) => isLocalToolEvent(message)).length;
  const tabCount = {
    chat: chatOnlyCount,
    files: artifacts.files.length,
    tools: toolOnlyCount,
    meta: 4
  };

  const projectTotalCount = poolProjects.reduce((sum, item) => sum + item.count, 0);
  const selectedProjectMessageCount = selectedProject?.sessions.reduce((sum, item) => sum + item.messageCount, 0) || 0;
  const dayLabel = selectedDay ? `${selectedDay.label}` : "请选择日期";
  const scannedAt = formatLocalSessionDateTime(snapshot.scannedAt);
  const tabs = [
    { key: "chat", label: "聊天", count: tabCount.chat },
    { key: "files", label: "文件", count: tabCount.files },
    { key: "tools", label: "工具调用", count: tabCount.tools },
    { key: "meta", label: "元数据", count: tabCount.meta }
  ];

  const projectItemsHtml = filteredProjects.length
    ? filteredProjects
        .map(
          (project) => `
            <button class="lsw-project-item ${project.projectKey === selectedProject?.projectKey ? "active" : ""}" data-select-project="${escapeHtml(
              project.projectKey
            )}">
              <span class="lsw-project-icon">${renderLocalIcon("folder")}</span>
              <span class="lsw-project-main">
                <strong>${escapeHtml(project.projectName)}</strong>
                <small>${escapeHtml(project.projectPath || "-")}</small>
              </span>
              <span class="lsw-project-count">${escapeHtml(project.count)}</span>
            </button>
          `
        )
        .join("")
    : `<div class="lsw-empty">没有匹配到项目。</div>`;

  const dayOptionsHtml = (selectedProject?.days || [])
    .map(
      (day) => `
        <option value="${escapeHtml(day.dayKey)}" ${day.dayKey === selectedDay?.dayKey ? "selected" : ""}>
          ${escapeHtml(day.label)} (${escapeHtml(day.count)})
        </option>
      `
    )
    .join("");

  const sessionItemsHtml = pagedSessions.length
    ? pagedSessions
        .map(
          (item) => `
            <a class="lsw-session-item ${item.threadId === selectedSession?.threadId ? "active" : ""}" href="#/local-sessions/${encodeURIComponent(
              item.threadId
            )}">
              <div class="lsw-session-item-head">
                <span class="dot"></span>
                <h3>${escapeHtml(item.sessionTitle)}</h3>
              </div>
              <div class="lsw-session-item-meta">${escapeHtml(item.year)}-${escapeHtml(item.month)}-${escapeHtml(item.day)} · ${escapeHtml(
                item.messageCount
              )} 条消息 · ${escapeHtml(item.rolloutFileName)}</div>
              <div class="lsw-session-item-footer">
                <span class="lsw-session-badge">${escapeHtml(item.projectName)}</span>
                <span>${escapeHtml(formatLocalSessionDateTime(item.updatedAt))}</span>
              </div>
            </a>
          `
        )
        .join("")
    : `<div class="lsw-empty">当前条件下没有会话。</div>`;

  const paginationHtml =
    totalPages > 1
      ? Array.from({ length: Math.min(totalPages, 7) }, (_, idx) => {
          const page = idx + 1;
          return `<button class="lsw-page-btn ${page === sessionPage ? "active" : ""}" data-local-session-page="${page}">${page}</button>`;
        }).join("")
      : `<button class="lsw-page-btn active">1</button>`;

  let detailPanelHtml = `<div class="lsw-empty">选择会话后显示详细聊天内容。</div>`;
  if (state.localSessionsPage.loadError) {
    detailPanelHtml = `<div class="lsw-empty">会话详情加载失败：${escapeHtml(state.localSessionsPage.loadError)}</div>`;
  } else if (detail) {
    const tabBodyHtml =
      activeTab === "files"
        ? artifacts.files.length
          ? `<div class="lsw-list-card">${artifacts.files
              .map((file) => `<div class="lsw-list-row">${escapeHtml(file)}</div>`)
              .join("")}</div>`
          : `<div class="lsw-empty">未识别到文件路径记录。</div>`
        : activeTab === "tools"
          ? artifacts.tools.length
            ? `<div class="lsw-list-card">${artifacts.tools
                .map(
                  (tool) => `
                    <div class="lsw-list-row">
                      <strong>${escapeHtml(tool.name)}</strong>
                      <span>${escapeHtml(formatLocalSessionDateTime(tool.timestamp))}</span>
                      <p>${escapeHtml(tool.preview).slice(0, 220)}</p>
                    </div>
                  `
                )
                .join("")}</div>`
            : `<div class="lsw-empty">没有工具调用记录。</div>`
          : activeTab === "meta"
            ? `
              <div class="lsw-meta-grid">
                <div><label>项目</label><p>${escapeHtml(detail.projectName)}</p></div>
                <div><label>路径</label><p>${escapeHtml(detail.projectPath || "-")}</p></div>
                <div><label>Thread</label><p>${escapeHtml(detail.threadId)}</p></div>
                <div><label>更新时间</label><p>${escapeHtml(formatLocalSessionDateTime(detail.updatedAt))}</p></div>
              </div>
            `
            : `
              <div class="lsw-chat-scroll">
                ${renderLocalChatTimeline(chatMessages, formatLocalSessionDateLabel(detail.year, detail.month, detail.day))}
              </div>
              <div class="lsw-chat-input">
                <input type="text" disabled placeholder="在此输入消息，或输入 @ 选择工具" />
                <button type="button" disabled>${renderLocalIcon("share")} 发送</button>
              </div>
            `;

    detailPanelHtml = `
      <header class="lsw-chat-head">
        <div class="lsw-chat-title">
          <h2>${escapeHtml(detail.sessionTitle)}</h2>
          <p>${renderLocalIcon("folder")} ${escapeHtml(detail.projectName)} · ${escapeHtml(detail.messageCount)} 条消息 · ${escapeHtml(
            detail.rolloutFileName
          )}</p>
        </div>
        <div class="lsw-chat-actions">
          <button class="lsw-info-btn" type="button" data-refresh-local-session-detail="true">${renderLocalIcon("refresh")} 刷新当前对话</button>
          <button class="lsw-icon-btn" type="button" title="复制">${renderLocalIcon("copy")}</button>
          <button class="lsw-icon-btn" type="button" title="分享">${renderLocalIcon("share")}</button>
          <button class="lsw-icon-btn" type="button" title="下载">${renderLocalIcon("download")}</button>
          <button class="lsw-icon-btn" type="button" title="删除">${renderLocalIcon("delete")}</button>
          <button class="lsw-info-btn" type="button">会话信息</button>
        </div>
      </header>
      <div class="lsw-tabs">${tabs
        .map(
          (tab) => `
            <button class="lsw-tab ${tab.key === activeTab ? "active" : ""}" data-select-local-session-tab="${tab.key}">
              ${escapeHtml(tab.label)}${tab.count ? ` (${escapeHtml(tab.count)})` : ""}
            </button>
          `
        )
        .join("")}</div>
      ${tabBodyHtml}
    `;
  }

  appRoot.innerHTML = `
    <div class="lsw-root">
      <div class="lsw-frame">
        <header class="lsw-top">
          <div class="lsw-window-dots"><span></span><span></span><span></span></div>
          <div class="lsw-top-left">
            <div class="lsw-chat-icon">${renderLocalIcon("chat")}</div>
            <div>
              <h1>本地会话工作台</h1>
              <p>按项目聚合本地 Codex 会话，快速查看历史对话、上下文与工具调用记录。</p>
            </div>
          </div>
          <div class="lsw-top-right">
            <div class="lsw-top-meta">${renderLocalIcon("refresh")} 扫描时间：${escapeHtml(scannedAt)}</div>
            <a class="lsw-light-btn lsw-home-link" href="#/">${renderLocalIcon("home")} 返回首页</a>
            <button class="lsw-light-btn" data-refresh-local-sessions="true">${renderLocalIcon("refresh")} 刷新扫描</button>
            <button class="lsw-primary-btn" data-refresh-local-sessions="true">刷新目录</button>
          </div>
        </header>

        <div class="lsw-grid">
          <aside class="lsw-col lsw-col-projects">
            <div class="lsw-col-head">
              <h3>项目目录</h3>
              <button type="button" class="lsw-icon-btn">${renderLocalIcon("pin")}</button>
            </div>
            <label class="lsw-search">
              ${renderLocalIcon("search")}
              <input type="search" value="${escapeHtml(projectSearchText)}" placeholder="搜索项目名称或路径" data-local-project-search="true" />
            </label>
            <button type="button" class="lsw-all-projects">
              <span>${renderLocalIcon("folder")} 全部项目</span>
              <strong>${escapeHtml(poolProjects.length)}</strong>
            </button>
            <div class="lsw-project-list">${projectItemsHtml}</div>
            <div class="lsw-col-footer">共 ${escapeHtml(poolProjects.length)} 个项目，${escapeHtml(projectTotalCount)} 个会话</div>
          </aside>

          <section class="lsw-col lsw-col-sessions">
            <div class="lsw-project-summary">
              <div class="lsw-project-summary-title">${renderLocalIcon("folder")} ${escapeHtml(selectedProject?.projectName || "未选择项目")}</div>
              <div class="lsw-project-summary-path">${escapeHtml(selectedProject?.projectPath || "-")}</div>
              <div class="lsw-project-summary-count">共 ${escapeHtml(selectedProject?.count || 0)} 个会话</div>
            </div>
            <div class="lsw-session-tools">
              <label class="lsw-search">
                ${renderLocalIcon("search")}
                <input type="search" value="${escapeHtml(sessionSearchText)}" placeholder="搜索会话标题" data-local-session-search="true" />
              </label>
              <button type="button" class="lsw-icon-btn">${renderLocalIcon("filter")}</button>
              <button type="button" class="lsw-icon-btn">${renderLocalIcon("sort")}</button>
            </div>
            <label class="lsw-day-select-wrap">
              <span>会话日期</span>
              <select class="lsw-day-select" data-select-day-dropdown="true" data-project-key="${escapeHtml(selectedProject?.projectKey || "")}">
                ${dayOptionsHtml || `<option value="">暂无可选日期</option>`}
              </select>
            </label>
            <div class="lsw-session-list">${sessionItemsHtml}</div>
            <div class="lsw-pagination">
              <button class="lsw-page-arrow" ${sessionPage <= 1 ? "disabled" : `data-local-session-page="${sessionPage - 1}"`}>&lsaquo;</button>
              ${paginationHtml}
              <button class="lsw-page-arrow" ${sessionPage >= totalPages ? "disabled" : `data-local-session-page="${sessionPage + 1}"`}>&rsaquo;</button>
            </div>
            <div class="lsw-col-footer">${escapeHtml(dayLabel)} · ${escapeHtml(sessionsByDay.length)} 个结果 · 当前第 ${escapeHtml(
    sessionPage
  )}/${escapeHtml(totalPages)} 页</div>
          </section>

          <section class="lsw-col lsw-col-chat">
            ${detailPanelHtml}
          </section>
        </div>
      </div>
    </div>
  `;

  if (detail && activeTab === "chat") {
    scrollLocalChatToBottom();
    setTimeout(scrollLocalChatToBottom, 0);
  }
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

  appRoot.querySelectorAll("[data-open-system-config]").forEach((button) => {
    button.addEventListener("click", async () => {
      await openSystemConfigDrawer();
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
        await loadLocalSessionsPage(state.localSessionsPage.selectedThreadId, {
          refreshSnapshot: true,
          refreshDetail: true
        });
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

  appRoot.querySelectorAll("[data-refresh-local-session-detail]").forEach((button) => {
    button.addEventListener("click", async () => {
      const threadId = state.localSessionsPage.selectedThreadId;
      if (!threadId) {
        return;
      }

      button.disabled = true;
      try {
        await refreshLocalSessionDetail(threadId, { refresh: true });
        renderLocalSessionsPage();
        bindLocalSessionsEvents();
        showToast("当前对话已刷新", "success");
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        button.disabled = false;
      }
    });
  });

  appRoot.querySelectorAll("[data-local-project-search]").forEach((input) => {
    input.addEventListener("input", async () => {
      state.localSessionsPage.projectSearchText = input.value;
      state.localSessionsPage.sessionPage = 1;
      renderLocalSessionsPage();
      bindLocalSessionsEvents();
      const nextInput = appRoot.querySelector("[data-local-project-search]");
      if (nextInput instanceof HTMLInputElement) {
        nextInput.focus();
        const cursor = nextInput.value.length;
        nextInput.setSelectionRange(cursor, cursor);
      }
    });
  });

  appRoot.querySelectorAll("[data-local-session-search]").forEach((input) => {
    input.addEventListener("input", async () => {
      state.localSessionsPage.searchText = input.value;
      state.localSessionsPage.sessionPage = 1;
      renderLocalSessionsPage();
      bindLocalSessionsEvents();
      const nextInput = appRoot.querySelector("[data-local-session-search]");
      if (nextInput instanceof HTMLInputElement) {
        nextInput.focus();
        const cursor = nextInput.value.length;
        nextInput.setSelectionRange(cursor, cursor);
      }
    });
  });

  appRoot.querySelectorAll("[data-select-local-session-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      const tab = button.getAttribute("data-select-local-session-tab");
      if (!tab) {
        return;
      }

      state.localSessionsPage.activeTab = tab;
      renderLocalSessionsPage();
      bindLocalSessionsEvents();
    });
  });

  appRoot.querySelectorAll("[data-local-session-page]").forEach((button) => {
    button.addEventListener("click", async () => {
      const nextPage = Number(button.getAttribute("data-local-session-page"));
      if (!nextPage || Number.isNaN(nextPage)) {
        return;
      }
      state.localSessionsPage.sessionPage = nextPage;
      renderLocalSessionsPage();
      bindLocalSessionsEvents();
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
      state.localSessionsPage.sessionPage = 1;
      await refreshLocalSessionDetail(state.localSessionsPage.selectedThreadId, { refresh: true });
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
      state.localSessionsPage.sessionPage = 1;
      await refreshLocalSessionDetail(selectedSession.threadId, { refresh: true });
      renderLocalSessionsPage();
      bindLocalSessionsEvents();
    });
  });

  appRoot.querySelectorAll("[data-select-day-dropdown]").forEach((selectElement) => {
    selectElement.addEventListener("change", async () => {
      const dayKey = selectElement instanceof HTMLSelectElement ? selectElement.value : "";
      const projectKey = selectElement.getAttribute("data-project-key");
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
      state.localSessionsPage.sessionPage = 1;
      await refreshLocalSessionDetail(selectedSession.threadId, { refresh: true });
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
    mode: "connector",
    platform,
    activeTab: "connection",
    config: structuredClone(config),
    recentOpenIds,
    systemStatus: null,
    systemDraft: {
      apiBaseUrl: "",
      apiKey: ""
    }
  };
  renderDrawer();
}

async function openSystemConfigDrawer() {
  const status = await loadSystemCodexStatus();
  state.drawer = {
    open: true,
    mode: "system",
    platform: null,
    activeTab: "system",
    config: null,
    recentOpenIds: [],
    systemStatus: status,
    systemDraft: {
      apiBaseUrl: status.apiConfig?.baseUrl || "",
      apiKey: ""
    }
  };
  renderDrawer();
}

function closeDrawer() {
  state.drawer.open = false;
  state.drawer.mode = null;
  drawerRoot.innerHTML = "";
}

function closeSetupWizard(options = {}) {
  const shouldRemember = options.remember !== false;
  if (shouldRemember && state.setupWizard.status && !isSetupWizardRequired(state.setupWizard.status)) {
    markSetupWizardDismissed(state.setupWizard.status);
  }
  state.setupWizard.open = false;
  state.setupWizard.status = null;
  if (wizardRoot) {
    wizardRoot.innerHTML = "";
  }
}

function renderSetupWizard() {
  if (!wizardRoot) {
    return;
  }
  const status = state.setupWizard.status;
  if (!state.setupWizard.open || !status || !isSetupWizardRequired(status)) {
    wizardRoot.innerHTML = "";
    return;
  }

  const steps = status.setupWizard?.steps || [];
  const quickCommands = status.setupWizard?.quickCommands || [];

  wizardRoot.innerHTML = `
    <div class="wizard-backdrop" data-close-setup-wizard="true">
      <section class="setup-wizard" role="dialog" aria-modal="true">
        <div class="panel-head">
          <div>
            <h2>首次安装配置向导</h2>
            <p>检测到当前设备尚未完成网关初始化，按以下步骤完成后即可开始任务分发。</p>
          </div>
          <button class="button small" data-close-setup-wizard="true">稍后处理</button>
        </div>
        <div class="form-grid">
          <div class="inline-note">
            <div><strong>当前状态：</strong>${escapeHtml(status.installed ? "CLI 已安装" : "CLI 未安装")} ${escapeHtml(status.version || "")}</div>
            <div><strong>系统入口：</strong><a href="/?drawer=system">系统配置抽屉</a></div>
          </div>
          <div class="setup-steps">
            ${steps
              .map(
                (step, index) => `
                  <div class="setup-step ${step.completed ? "done" : "todo"}">
                    <div class="setup-step-head">
                      <strong>步骤 ${index + 1}：${escapeHtml(step.title)}</strong>
                      <span class="status-pill ${step.completed ? "status-success" : "status-pending_confirm"}">${
                        step.completed ? "已完成" : "待完成"
                      }</span>
                    </div>
                    <p>${escapeHtml(step.description || "")}</p>
                  </div>
                `
              )
              .join("")}
          </div>
          ${
            quickCommands.length
              ? `
            <div class="setup-commands">
              <div class="subtext">快捷命令</div>
              ${quickCommands
                .map(
                  (command) => `
                    <div class="setup-command-row">
                      <code>${escapeHtml(command)}</code>
                      <button class="button small subtle" data-copy-command="${escapeHtml(command)}">复制</button>
                    </div>
                  `
                )
                .join("")}
            </div>
          `
              : ""
          }
          <div class="drawer-actions">
            <button class="button" data-setup-open-system="true">打开系统配置</button>
            <button class="button" data-setup-authorize="true">授权当前目录</button>
            <button class="button primary" data-setup-install="true" ${status.installed ? "disabled" : ""}>安装 Codex CLI</button>
            <button class="button subtle" data-setup-refresh="true">刷新状态</button>
          </div>
        </div>
      </section>
    </div>
  `;

  wizardRoot.querySelectorAll("[data-close-setup-wizard]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target === event.currentTarget || element.tagName === "BUTTON") {
        closeSetupWizard();
      }
    });
  });

  wizardRoot.querySelectorAll("[data-copy-command]").forEach((button) => {
    button.addEventListener("click", async () => {
      const command = button.getAttribute("data-copy-command") || "";
      if (!command) {
        return;
      }
      try {
        await navigator.clipboard.writeText(command);
        showToast(`已复制命令：${command}`, "success");
      } catch {
        showToast("复制失败，请手动复制命令", "error");
      }
    });
  });

  wizardRoot.querySelector("[data-setup-open-system='true']")?.addEventListener("click", async () => {
    await openSystemConfigDrawer();
  });
  wizardRoot.querySelector("[data-setup-refresh='true']")?.addEventListener("click", refreshSetupWizardStatus);
  wizardRoot.querySelector("[data-setup-authorize='true']")?.addEventListener("click", authorizeFromSetupWizard);
  wizardRoot.querySelector("[data-setup-install='true']")?.addEventListener("click", installFromSetupWizard);
}

function syncSetupWizardStatus(status) {
  if (!state.setupWizard.open) {
    return;
  }
  state.setupWizard.status = status;
  if (!isSetupWizardRequired(status)) {
    closeSetupWizard({ remember: false });
    showToast("首次安装向导已完成", "success");
    return;
  }
  renderSetupWizard();
}

function renderDrawer() {
  if (!state.drawer.open) {
    drawerRoot.innerHTML = "";
    return;
  }

  if (state.drawer.mode === "system") {
    renderSystemDrawer();
    return;
  }

  renderConnectorDrawer();
}

function renderConnectorDrawer() {
  if (!state.drawer.config) {
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

function renderSystemDrawer() {
  const status = state.drawer.systemStatus;
  if (!status) {
    drawerRoot.innerHTML = "";
    return;
  }

  const installButtonLabel = status.installed ? "已安装 Codex CLI" : "安装 Codex CLI";
  const sessionScanLabel = status.sessionScan?.enabled
    ? `线程 ${status.sessionScan.totalThreads || 0} · 文件 ${status.sessionScan.totalFiles || 0}`
    : "未启用";
  const resolvedCli = status.resolvedCodexBin || status.codexBin || "codex";
  const detectionMessage = status.detectionMessage ? String(status.detectionMessage) : "";
  const quickCommands = Array.isArray(status.setupWizard?.quickCommands) ? status.setupWizard.quickCommands : [];
  const apiProbeLabel = status.apiConfig?.usable ? "可用" : "不可用";
  const apiProbeMessage = status.apiConfig?.probeMessage ? String(status.apiConfig.probeMessage) : "";

  drawerRoot.innerHTML = `
    <div class="drawer-backdrop" data-close-drawer="true">
      <aside class="drawer" role="dialog" aria-modal="true">
        <div class="panel-head">
          <div>
            <h2>系统配置</h2>
            <p>启动初始化、Codex CLI 安装检测、项目目录授权与 Codex CLI 命令探测。</p>
          </div>
          <button class="button small" data-close-drawer="true">关闭</button>
        </div>
        <div class="form-grid">
          <div class="inline-note">
            <div><strong>CLI 状态：</strong>${escapeHtml(status.installed ? "已安装" : "未安装")} ${escapeHtml(
              status.version || ""
            )}</div>
            <div><strong>CLI 命令：</strong>${escapeHtml(status.codexBin || "codex")}</div>
            <div><strong>实际 CLI：</strong>${escapeHtml(resolvedCli)}</div>
            <div><strong>项目目录：</strong>${escapeHtml(status.projectRoot || "-")}</div>
            <div><strong>会话扫描：</strong>${escapeHtml(sessionScanLabel)} ${status.sessionScan?.scannedAt ? `· ${escapeHtml(status.sessionScan.scannedAt)}` : ""}</div>
            <div><strong>目录授权：</strong>${status.projectAuthorization?.trustedInConfig ? "已写入 trusted" : "运行时 full-access 授权"}</div>
            <div><strong>Codex CLI 命令探测：</strong>${escapeHtml(apiProbeLabel)} ${status.apiConfig?.probeCheckedAt ? `· ${escapeHtml(status.apiConfig.probeCheckedAt)}` : ""}</div>
            ${apiProbeMessage ? `<div><strong>探测结果：</strong>${escapeHtml(apiProbeMessage)}</div>` : ""}
            <div><strong>执行策略：</strong>${escapeHtml(status.dispatchCommandPreview || "-")}</div>
            ${
              detectionMessage
                ? `<div><strong>检测提示：</strong>${escapeHtml(detectionMessage)}</div>`
                : ""
            }
            ${
              quickCommands.length
                ? `<div><strong>快捷命令：</strong>${quickCommands.map((command) => `<code>${escapeHtml(command)}</code>`).join(" / ")}</div>`
                : ""
            }
            <div><strong>快捷入口：</strong><a href="/?drawer=system">打开系统配置抽屉</a></div>
          </div>
          <div class="drawer-actions">
            <button class="button" data-system-install="true" ${status.installed ? "disabled" : ""}>${escapeHtml(installButtonLabel)}</button>
            <button class="button" data-system-authorize="true">授权当前目录</button>
            <button class="button subtle" data-system-refresh="true">刷新状态</button>
          </div>
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

  bindDrawerFormEvents();
}

function renderDrawerTab(config, recentOpenIds) {
  if (state.drawer.activeTab === "connection") {
    const isQq = config.platform === "qq";
    const normalizedEventMode = config.eventMode || "webhook";
    const callbackLabel = isQq ? "QQ OpenAPI Base URL (optional)" : "Callback URL";
    const callbackHint =
      isQq && normalizedEventMode === "websocket"
        ? `
          <div class="inline-note">
            QQ WebSocket mode does not require public callback URL.
            Keep this field empty to use default OpenAPI base URL:
            <code>https://api.sgroup.qq.com</code>.
          </div>
        `
        : isQq
          ? `
            <div class="inline-note">
              QQ webhook mode still requires callback URL configured in QQ Open Platform:
              <code>${escapeHtml(`${window.location.origin}/api/qq/webhook`)}</code>.
              This page's callback field only overrides QQ OpenAPI base URL.
            </div>
          `
          : "";
    const eventModeOptions = `
          <option value="webhook" ${normalizedEventMode === "webhook" ? "selected" : ""}>Webhook</option>
          <option value="websocket" ${normalizedEventMode === "websocket" ? "selected" : ""}>WebSocket</option>
        `;

    return `
      <div class="field"><label>App ID</label><input name="appId" value="${escapeHtml(config.appId)}" /></div>
      <div class="field"><label>App Secret</label><input name="appSecret" value="${escapeHtml(config.appSecret)}" /></div>
      <div class="field"><label>Event Mode</label>
        <select name="eventMode">
          ${eventModeOptions}
        </select>
      </div>
      <div class="field"><label>${callbackLabel}</label><input name="callbackUrl" value="${escapeHtml(config.callbackUrl)}" /></div>
      ${callbackHint}
      <div class="field"><label>Default Group / Channel</label><input name="defaultChannelName" value="${escapeHtml(config.defaultChannelName || "")}" /></div>
      <div class="inline-note">Last test: ${escapeHtml(config.lastTestResult || "untested")} ${config.lastTestAt ? `· ${escapeHtml(config.lastTestAt)}` : ""}</div>
      <div class="drawer-actions">
        <button class="button primary" data-save-connector="true">Save Config</button>
        <button class="button" data-test-connector="true">Test Connection</button>
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
  if (state.drawer.mode === "system") {
    bindSystemDrawerFormEvents();
    return;
  }

  drawerRoot.querySelectorAll("input, textarea, select").forEach((field) => {
    field.addEventListener("input", syncDrawerConfigFromForm);
    field.addEventListener("change", syncDrawerConfigFromForm);
  });

  drawerRoot.querySelector("[data-save-connector='true']")?.addEventListener("click", saveConnectorConfig);
  drawerRoot.querySelector("[data-test-connector='true']")?.addEventListener("click", testConnectorConfig);
  drawerRoot.querySelector("[data-send-feishu-message='true']")?.addEventListener("click", sendFeishuQuickMessage);
}

function bindSystemDrawerFormEvents() {
  drawerRoot.querySelector("[data-system-install='true']")?.addEventListener("click", installCodexCliFromDrawer);
  drawerRoot.querySelector("[data-system-refresh='true']")?.addEventListener("click", refreshSystemStatusInDrawer);
  drawerRoot.querySelector("[data-system-authorize='true']")?.addEventListener("click", authorizeProjectFromDrawer);
}

function syncDrawerConfigFromForm() {
  if (state.drawer.mode !== "connector") {
    return;
  }

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

async function refreshSetupWizardStatus() {
  try {
    const status = await loadSystemCodexStatus();
    syncSetupWizardStatus(status);
    if (!state.setupWizard.open) {
      return;
    }
    showToast("向导状态已刷新", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function installFromSetupWizard() {
  const confirmed = window.confirm("将执行 npm install -g @openai/codex，是否继续？");
  if (!confirmed) {
    return;
  }

  try {
    const result = await fetchJson("/api/system/codex-cli/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true
      })
    });
    syncSetupWizardStatus(result.status);
    showToast("Codex CLI 安装完成", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function authorizeFromSetupWizard() {
  try {
    const result = await fetchJson("/api/system/codex-cli/authorize-project", {
      method: "POST"
    });
    syncSetupWizardStatus(result.status);
    showToast("项目目录授权已更新", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function installCodexCliFromDrawer() {
  const confirmed = window.confirm("将执行 npm install -g @openai/codex，是否继续？");
  if (!confirmed) {
    return;
  }

  try {
    const result = await fetchJson("/api/system/codex-cli/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true
      })
    });

    state.drawer.systemStatus = result.status;
    syncSetupWizardStatus(result.status);
    renderDrawer();
    showToast("Codex CLI 安装完成", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function refreshSystemStatusInDrawer() {
  try {
    state.drawer.systemStatus = await loadSystemCodexStatus();
    syncSetupWizardStatus(state.drawer.systemStatus);
    const currentBaseUrl = state.drawer.systemStatus?.apiConfig?.baseUrl || "";
    state.drawer.systemDraft.apiBaseUrl = currentBaseUrl;
    renderDrawer();
    showToast("系统状态已刷新", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function authorizeProjectFromDrawer() {
  try {
    const result = await fetchJson("/api/system/codex-cli/authorize-project", {
      method: "POST"
    });
    state.drawer.systemStatus = result.status;
    syncSetupWizardStatus(result.status);
    renderDrawer();
    showToast("项目目录授权已更新", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function boot() {
  try {
    await renderRoute();
    await applyStartupDrawerFromQuery();
    await applyStartupSetupWizard();
    if (route().name === "dashboard") {
      startDashboardRefresh();
      stopLocalSessionsRefresh();
    } else if (route().name === "localSessions") {
      stopDashboardRefresh();
      startLocalSessionsRefresh();
    } else {
      stopDashboardRefresh();
      stopLocalSessionsRefresh();
    }
  } catch (error) {
    stopDashboardRefresh();
    stopLocalSessionsRefresh();
    renderShell(
      "管理台加载失败",
      "后端接口已经启动，但当前页面没能正确拿到数据。",
      navButton("重试", "#/"),
      `<div class="panel"><div class="empty-state">${escapeHtml(error.message)}</div></div>`
    );
  }
}

async function applyStartupDrawerFromQuery() {
  if (startupDrawerApplied) {
    return;
  }
  const params = new URLSearchParams(window.location.search || "");
  const drawer = (params.get("drawer") || "").trim().toLowerCase();
  if (drawer !== "system") {
    startupDrawerApplied = true;
    return;
  }
  if (route().name !== "dashboard") {
    startupDrawerApplied = true;
    return;
  }
  startupDrawerApplied = true;
  await openSystemConfigDrawer();
}

async function applyStartupSetupWizard() {
  if (startupSetupWizardApplied) {
    return;
  }
  if (route().name !== "dashboard") {
    startupSetupWizardApplied = true;
    return;
  }

  const params = new URLSearchParams(window.location.search || "");
  if ((params.get("drawer") || "").trim().toLowerCase() === "system") {
    startupSetupWizardApplied = true;
    return;
  }

  startupSetupWizardApplied = true;
  try {
    const status = await loadSystemCodexStatus();
    if (!isSetupWizardRequired(status)) {
      return;
    }
    if (shouldSkipSetupWizardByDismiss(status)) {
      return;
    }
    state.setupWizard.open = true;
    state.setupWizard.status = status;
    renderSetupWizard();
  } catch {
    // ignore onboarding auto-popup failure
  }
}

window.addEventListener("hashchange", () => {
  stopDashboardRefresh();
  stopLocalSessionsRefresh();
  void boot();
});

window.addEventListener("click", (event) => {
  if (event.target === drawerRoot.querySelector(".drawer-backdrop")) {
    closeDrawer();
  }
  if (event.target === wizardRoot?.querySelector(".wizard-backdrop")) {
    closeSetupWizard();
  }
});

applyLanguage(detectLanguage());
installI18nObserver();

void boot();
