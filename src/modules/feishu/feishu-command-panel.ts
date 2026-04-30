/**
 * @description 飞书指令面板的命令解析、卡片模板与选择态渲染工具
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 21:55
 */
import type { FeishuPanelContextRecord } from "../../storage/repositories/feishu-panel-context-repository";
import type { CodexModelCatalogRecord } from "../codex/codex-model-catalog-service";

export type FeishuPanelCommand =
  | { actionType: "view_projects" }
  | { actionType: "view_projects_by_path"; selector: string }
  | { actionType: "select_project"; selector: string }
  | { actionType: "view_sessions"; page?: number; window?: FeishuPanelSessionWindow }
  | { actionType: "view_project_sessions"; page?: number; window?: FeishuPanelSessionWindow }
  | { actionType: "select_session"; selector: string }
  | { actionType: "view_models" }
  | { actionType: "select_model"; selector: string; reasoningLevel?: string | null }
  | { actionType: "view_gateway_status" }
  | { actionType: "current_selection" }
  | { actionType: "compose_session_command" }
  | { actionType: "compose_thread_command" }
  | { actionType: "compose_project_session_command" }
  | { actionType: "stop_task"; taskId: string; sessionId?: string | null; threadRef?: string | null }
  | { actionType: "help" }
  | { actionType: "start_task"; prompt: string };

export type FeishuPanelProjectSummary = {
  projectName: string;
  projectPath: string;
  sessionCount: number;
  latestUpdatedAt: string;
  latestSessionTitle: string;
};

export type FeishuPanelSessionSummary = {
  threadId: string;
  rolloutFileName: string;
  sessionTitle: string;
  messageCount: number;
  updatedAt: string;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  projectName: string;
  projectPath: string;
};

export type FeishuPanelSessionWindow = "all" | "24h" | "7d";

export type FeishuPanelGatewayStatus = {
  watcherRunning: boolean;
  watcherAutoStart: boolean;
  watcherLastSuccessfulPostAt: string | null;
  watcherLastError: string | null;
  localSessionScanEnabled: boolean;
  localSessionRoot: string | null;
  codexAutoDispatchEnabled: boolean;
  codexCliBin: string;
  defaultModel: string | null;
  modelCount: number;
  selectedContext: FeishuPanelContextRecord;
};

const PANEL_ACTION_PATTERN = /^(查看|列出|展示)?(项目|session|会话|线程|模型|网关|状态|当前选择|帮助)(列表|状态)?$/i;
const PANEL_VIEW_PROJECTS_BY_PATH_PATTERN = /^(查看|列出|展示|选择)?项目路径(?:[：:]\s*|\s+)(.+)$/i;
const PANEL_SELECT_PROJECT_PATTERN = /^(选择|切换|使用)项目(?:[：:]\s*|\s+)(.+)$/i;
const PANEL_SELECT_SESSION_PATTERN = /^(选择|切换|使用)(session|会话|线程)(?:[：:]\s*|\s+)(.+)$/i;
const PANEL_SELECT_MODEL_PATTERN = /^(选择|切换|使用)模型(?:[：:]\s*|\s+)(.+)$/i;
const PANEL_START_TASK_PATTERN = /^(开始任务|继续|执行任务|在当前\s*session\s*继续)[：:]\s*(.+)$/i;
const PANEL_COMPOSE_SESSION_PATTERN = /^(会话指令|会话模式|使用会话指令)$/i;
const PANEL_COMPOSE_THREAD_PATTERN = /^(线程定向|线程模式|使用线程定向)$/i;
const PANEL_COMPOSE_PROJECT_SESSION_PATTERN = /^(新建|创建)\s*(session|会话)$/i;
const PANEL_VIEW_CURRENT_PROJECT_SESSIONS_PATTERN = /^(查看|列出|展示)?当前项目(session|会话|线程)(列表)?$/i;

const REASONING_LEVEL_ORDER = [
  "low",
  "medium",
  "high",
  "xhigh",
  "very_high",
  "ultra_high",
  "ultrahigh",
  "highest",
  "extreme"
] as const;

const REASONING_LEVEL_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  very_high: "极高",
  ultra_high: "极高",
  ultrahigh: "极高",
  highest: "极高",
  extreme: "极高"
};

type FeishuReasoningLevelOption = {
  effort: string;
  label: string;
  description: string;
};

export function normalizeFeishuReasoningLevel(value: string | null | undefined) {
  const normalized = (value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized || null;
}

export function resolveFeishuReasoningLevelLabel(value: string | null | undefined) {
  const normalized = normalizeFeishuReasoningLevel(value);
  if (!normalized) {
    return "未选择";
  }

  return REASONING_LEVEL_LABELS[normalized] || value?.trim() || normalized;
}

export function resolveFeishuReasoningOptions(model: CodexModelCatalogRecord) {
  const seen = new Set<string>();
  return model.supportedReasoningLevels
    .map((item) => {
      const normalized = normalizeFeishuReasoningLevel(item.effort);
      if (!normalized || seen.has(normalized)) {
        return null;
      }

      seen.add(normalized);
      return {
        effort: item.effort.trim(),
        label: REASONING_LEVEL_LABELS[normalized] || item.effort.trim(),
        description: item.description.trim()
      } satisfies FeishuReasoningLevelOption;
    })
    .filter((item): item is FeishuReasoningLevelOption => Boolean(item))
    .sort((left, right) => {
      const leftIndex = REASONING_LEVEL_ORDER.indexOf(normalizeFeishuReasoningLevel(left.effort) as (typeof REASONING_LEVEL_ORDER)[number]);
      const rightIndex = REASONING_LEVEL_ORDER.indexOf(normalizeFeishuReasoningLevel(right.effort) as (typeof REASONING_LEVEL_ORDER)[number]);
      const normalizedLeftIndex = leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER;
      const normalizedRightIndex = rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER;
      if (normalizedLeftIndex !== normalizedRightIndex) {
        return normalizedLeftIndex - normalizedRightIndex;
      }
      return left.label.localeCompare(right.label);
    });
}

export function resolveFeishuModelReasoningSelection(input: {
  model: CodexModelCatalogRecord;
  requestedReasoningLevel?: string | null;
}) {
  const options = resolveFeishuReasoningOptions(input.model);
  const requested = normalizeFeishuReasoningLevel(input.requestedReasoningLevel);
  const requestedOption = requested
    ? options.find((option) => normalizeFeishuReasoningLevel(option.effort) === requested) || null
    : null;
  const defaultRequested = normalizeFeishuReasoningLevel(input.model.defaultReasoningLevel);
  const defaultOption = defaultRequested
    ? options.find((option) => normalizeFeishuReasoningLevel(option.effort) === defaultRequested) || null
    : null;
  const selected = requestedOption || defaultOption || options[0] || null;
  const notice =
    requested && !requestedOption
      ? `模型 ${input.model.displayName} 不支持推理等级 ${input.requestedReasoningLevel?.trim() || requested}; 已切换为 ${
          selected?.label || "默认"
        }`
      : !selected
        ? `模型 ${input.model.displayName} 没有可用的推理等级`
        : null;

  return {
    reasoningLevel: selected?.effort ?? null,
    reasoningLabel: selected?.label ?? null,
    reasoningDescription: selected?.description ?? null,
    reasoningOptions: options,
    notice
  };
}

function formatReasoningOptionsSummary(options: FeishuReasoningLevelOption[]) {
  if (options.length === 0) {
    return "";
  }

  return options
    .map((option) => {
      const summary = option.description ? truncate(option.description, 16) : "";
      return summary ? `${option.label}（${summary}）` : option.label;
    })
    .join(" / ");
}

export function parseFeishuPanelCommand(text: string): FeishuPanelCommand | null {
  const rawText = (text || "").trim();
  if (!rawText) {
    return null;
  }

  if (/^(查看|列出|展示)?项目(列表)?$/i.test(rawText)) {
    return { actionType: "view_projects" };
  }

  const projectPathMatched = rawText.match(PANEL_VIEW_PROJECTS_BY_PATH_PATTERN);
  if (projectPathMatched) {
    return {
      actionType: "view_projects_by_path",
      selector: projectPathMatched[2].trim()
    };
  }

  const projectMatched = rawText.match(PANEL_SELECT_PROJECT_PATTERN);
  if (projectMatched) {
    return {
      actionType: "select_project",
      selector: projectMatched[2].trim()
    };
  }

  if (/^(查看|列出|展示)?(session|会话|线程)(列表)?$/i.test(rawText)) {
    return { actionType: "view_sessions" };
  }

  if (PANEL_VIEW_CURRENT_PROJECT_SESSIONS_PATTERN.test(rawText)) {
    return { actionType: "view_project_sessions" };
  }

  const sessionMatched = rawText.match(PANEL_SELECT_SESSION_PATTERN);
  if (sessionMatched) {
    return {
      actionType: "select_session",
      selector: sessionMatched[3].trim()
    };
  }

  if (/^(查看|列出|展示)?模型列表$/i.test(rawText)) {
    return { actionType: "view_models" };
  }

  const modelMatched = rawText.match(PANEL_SELECT_MODEL_PATTERN);
  if (modelMatched) {
    return {
      actionType: "select_model",
      selector: modelMatched[2].trim()
    };
  }

  if (/^(查看|查询)?(网关|服务)状态$/i.test(rawText)) {
    return { actionType: "view_gateway_status" };
  }

  if (/^(当前选择|当前状态|查看当前选择)$/i.test(rawText)) {
    return { actionType: "current_selection" };
  }

  if (PANEL_COMPOSE_SESSION_PATTERN.test(rawText)) {
    return { actionType: "compose_session_command" };
  }

  if (PANEL_COMPOSE_THREAD_PATTERN.test(rawText)) {
    return { actionType: "compose_thread_command" };
  }

  if (PANEL_COMPOSE_PROJECT_SESSION_PATTERN.test(rawText)) {
    return { actionType: "compose_project_session_command" };
  }

  if (/^(指令帮助|帮助|help)$/i.test(rawText)) {
    return { actionType: "help" };
  }

  const startTaskMatched = rawText.match(PANEL_START_TASK_PATTERN);
  if (startTaskMatched) {
    return {
      actionType: "start_task",
      prompt: startTaskMatched[2].trim()
    };
  }

  return null;
}

export function parseFeishuPanelActionValue(value: unknown): FeishuPanelCommand | null {
  if (!value) {
    return null;
  }

  const record = normalizeActionValue(value);
  if (!record) {
    return null;
  }

  const actionType = String(record.panelAction || record.actionType || record.type || "").trim();
  if (!actionType) {
    return null;
  }

  if (actionType === "view_projects") {
    return { actionType: "view_projects" };
  }

  if (actionType === "view_projects_by_path") {
    return {
      actionType: "view_projects_by_path",
      selector: String(record.selector || record.projectPath || record.path || "").trim()
    };
  }

  if (actionType === "select_project") {
    return {
      actionType: "select_project",
      selector: String(record.selector || record.projectPath || record.projectName || "").trim()
    };
  }

  if (actionType === "view_sessions") {
    const page = parsePanelPage(record);
    const window = parsePanelWindow(record);
    return {
      actionType: "view_sessions",
      ...(page ? { page } : {}),
      ...(window ? { window } : {})
    };
  }

  if (actionType === "view_project_sessions") {
    const page = parsePanelPage(record);
    const window = parsePanelWindow(record);
    return {
      actionType: "view_project_sessions",
      ...(page ? { page } : {}),
      ...(window ? { window } : {})
    };
  }

  if (actionType === "select_session") {
    return {
      actionType: "select_session",
      selector: String(record.selector || record.threadId || record.threadRef || "").trim()
    };
  }

  if (actionType === "view_models") {
    return { actionType: "view_models" };
  }

  if (actionType === "select_model") {
    return {
      actionType: "select_model",
      selector: String(record.selector || record.modelSlug || record.slug || record.modelName || "").trim(),
      reasoningLevel: String(record.reasoningLevel || record.reasoning || record.modelReasoningLevel || record.effort || "")
        .trim() || undefined
    };
  }

  if (actionType === "view_gateway_status") {
    return { actionType: "view_gateway_status" };
  }

  if (actionType === "current_selection") {
    return { actionType: "current_selection" };
  }

  if (actionType === "compose_session_command") {
    return { actionType: "compose_session_command" };
  }

  if (actionType === "compose_thread_command") {
    return { actionType: "compose_thread_command" };
  }

  if (actionType === "compose_project_session_command") {
    return { actionType: "compose_project_session_command" };
  }

  if (actionType === "stop_task") {
    const taskId = String(record.taskId || record.id || "").trim();
    if (!taskId) {
      return null;
    }
    return {
      actionType: "stop_task",
      taskId,
      sessionId: String(record.sessionId || "").trim() || null,
      threadRef: String(record.threadRef || record.threadId || "").trim() || null
    };
  }

  if (actionType === "help") {
    return { actionType: "help" };
  }

  if (actionType === "start_task") {
    return {
      actionType: "start_task",
      prompt: String(record.prompt || record.text || record.content || "").trim()
    };
  }

  return null;
}

export function buildFeishuProjectListCard(input: {
  context: FeishuPanelContextRecord;
  projects: FeishuPanelProjectSummary[];
  title?: string;
  intro?: string;
  emptyMessage?: string;
}) {
  const topProjects = input.projects.slice(0, 12);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: renderSelectionIntro(input.context, "项目")
    }
  ];

  if (topProjects.length === 0) {
    elements.push({
      tag: "markdown",
      content: input.emptyMessage || "【暂无项目】\n当前本地会话目录里没有可展示的项目。"
    });
    elements.push(buildActionBlock([{ text: "查看网关状态", value: { panelAction: "view_gateway_status" } }]));
  } else {
    topProjects.forEach((project, index) => {
      elements.push({
        tag: "markdown",
        content: [
          `【项目 ${index + 1}】${project.projectName}`,
          `路径：${project.projectPath}`,
          `会话数：${project.sessionCount}`,
          `最近更新时间：${project.latestUpdatedAt}`,
          `最近会话：${project.latestSessionTitle}`
        ].join("\n")
      });
      elements.push(
        buildActionBlock([
          {
            text: "选择此项目",
            type: "primary",
            value: {
              panelAction: "select_project",
              selector: project.projectPath,
              projectPath: project.projectPath,
              projectName: project.projectName
            }
          }
        ])
      );
    });
  }

  elements.push(...buildBottomActionBlocks());

  return buildCard({
    title: input.title || "项目列表",
    template: "wathet",
    intro: input.intro || "按项目分组展示最近的本地 Codex 会话，先选项目再选 session。",
    elements
  });
}

export function buildFeishuSessionListCard(input: {
  context: FeishuPanelContextRecord;
  project: FeishuPanelProjectSummary;
  sessions: FeishuPanelSessionSummary[];
  actionType: "view_sessions" | "view_project_sessions";
  window: FeishuPanelSessionWindow;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalCount: number;
  rawTotalCount: number;
}) {
  const topSessions = input.sessions;
  const actionType = input.actionType || "view_project_sessions";
  const filterButtons = buildSessionWindowButtons({
    actionType,
    window: input.window
  });
  const paginationButtons = buildSessionPaginationButtons({
    actionType,
    window: input.window,
    currentPage: input.currentPage,
    totalPages: input.totalPages
  });
  const newSessionActionBlock = buildActionBlock([
    {
      text: "新建 session",
      type: "primary",
      value: {
        panelAction: "compose_project_session_command"
      }
    }
  ]);
  const startIndex = (input.currentPage - 1) * input.pageSize;
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: renderSelectionIntro(input.context, "session")
    },
    {
      tag: "markdown",
      content: [
        "【当前项目】",
        `${input.project.projectName}`,
        `路径：${input.project.projectPath}`,
        `会话数：${input.project.sessionCount}`,
        `筛选范围：${formatSessionWindowLabel(input.window)}`,
        `分页：第 ${input.currentPage}/${input.totalPages} 页（每页 ${input.pageSize} 条）`,
        `筛选后会话数：${input.totalCount}`,
        `项目总会话数：${input.rawTotalCount}`,
        `最近会话：${input.project.latestSessionTitle}`
      ].join("\n")
    }
  ];

  elements.push(newSessionActionBlock);
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: "点击新建 session 后，下一条消息会在当前项目下创建新的 Codex 会话。"
      }
    ]
  });
  elements.push(buildActionBlock(filterButtons));
  if (paginationButtons.length > 0) {
    elements.push(buildActionBlock(paginationButtons));
  }

  if (topSessions.length === 0) {
    elements.push({
      tag: "markdown",
      content: "【暂无 session】\n当前筛选条件下没有会话，请切换筛选范围或选择其他项目。"
    });
  } else {
    topSessions.forEach((session, index) => {
      elements.push({
        tag: "markdown",
        content: [
          `【session ${startIndex + index + 1}】${session.sessionTitle}`,
          `thread：${session.threadId}`,
          `文件：${session.rolloutFileName}`,
          `消息数：${session.messageCount}`,
          `首条消息时间：${session.firstMessageAt || "无"}`,
          `最近消息时间：${session.lastMessageAt || "无"}`,
          `更新时间：${session.updatedAt}`
        ].join("\n")
      });
      elements.push(
        buildActionBlock([
          {
            text: "选择此 session",
            type: "primary",
            value: {
              panelAction: "select_session",
              selector: session.threadId,
              threadId: session.threadId,
              sessionTitle: session.sessionTitle,
              projectPath: session.projectPath,
              projectName: session.projectName
            }
          }
        ])
      );
    });
  }

  elements.push(...buildBottomActionBlocks());

  return buildCard({
    title: "Session 列表",
    template: "blue",
    intro: "选中 session 后，直接发送任务内容即可进入对应 Codex 线程。",
    elements
  });
}

export function buildFeishuModelListCard(input: {
  context: FeishuPanelContextRecord;
  models: CodexModelCatalogRecord[];
  defaultModel: string | null;
}) {
  const topModels = input.models.filter((model) => model.visibility !== "hidden").slice(0, 20);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: renderSelectionIntro(input.context, "模型", input.context.selectedReasoningLevel)
    }
  ];

  if (topModels.length === 0) {
    elements.push({
      tag: "markdown",
      content: "【暂无模型】\n没有从 Codex CLI 读取到模型目录。"
    });
  } else {
    topModels.forEach((model, index) => {
      const reasoningOptions = resolveFeishuReasoningOptions(model);
      const reasoningSelection = resolveFeishuModelReasoningSelection({ model });
      const isSelectedModel = model.slug === input.context.selectedModelSlug;
      const selectedReasoningLevel = isSelectedModel ? normalizeFeishuReasoningLevel(input.context.selectedReasoningLevel) : null;
      const selectedReasoningLabel = isSelectedModel ? resolveFeishuReasoningLevelLabel(input.context.selectedReasoningLevel) : null;
      const badge = isSelectedModel
        ? selectedReasoningLabel
          ? `（已选 / ${selectedReasoningLabel}）`
          : "（已选）"
        : model.slug === input.defaultModel
          ? "（默认）"
          : "";
      const reasoningSummary = formatReasoningOptionsSummary(reasoningOptions);
      const selectValue: Record<string, unknown> = {
        panelAction: "select_model",
        selector: model.slug,
        modelSlug: model.slug,
        modelName: model.displayName
      };

      if (reasoningSelection.reasoningLevel) {
        selectValue.reasoningLevel = reasoningSelection.reasoningLevel;
      }

      elements.push({
        tag: "markdown",
        content: [
          `【模型 ${index + 1}】${model.displayName} ${badge}`,
          `${model.slug}`,
          [
            `${truncate(model.description || "无描述", 180)}`,
            reasoningSelection.reasoningLabel ? `默认推理：${reasoningSelection.reasoningLabel}` : "",
            reasoningSummary ? `支持推理：${reasoningSummary}` : ""
          ]
            .filter(Boolean)
            .join("\n")
        ].join("\n")
      });

      const reasoningButtons: Array<{ text: string; value: Record<string, unknown>; type?: "default" | "primary" | "danger" }> = reasoningOptions.map((option) => {
        const isSelectedReasoning = isSelectedModel && normalizeFeishuReasoningLevel(option.effort) === selectedReasoningLevel;
        return {
          text: `${option.label}${isSelectedReasoning ? "（已选）" : ""}`,
          type: isSelectedReasoning ? "primary" : "default",
          value: {
            panelAction: "select_model",
            selector: model.slug,
            modelSlug: model.slug,
            modelName: model.displayName,
            reasoningLevel: option.effort
          }
        };
      });

      elements.push(
        buildActionBlock([
          {
            text: isSelectedModel ? "重新选择模型" : "选择此模型",
            type: isSelectedModel ? "default" : "primary",
            value: selectValue
          },
          ...reasoningButtons
        ])
      );
    });
  }

  elements.push(...buildBottomActionBlocks());

  return buildCard({
    title: "模型列表",
    template: "purple",
    intro: "模型列表来自 Codex CLI，选择后会作为后续任务的默认模型。",
    elements
  });
}

export function buildFeishuGatewayStatusCard(input: {
  context: FeishuPanelContextRecord;
  gatewayStatus: FeishuPanelGatewayStatus;
}) {
  const status = input.gatewayStatus;
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: renderSelectionIntro(input.context, "网关状态", input.context.selectedReasoningLevel)
    },
    {
      tag: "markdown",
      content: [
        "【网关概览】",
        `自动回推：${status.watcherRunning ? "运行中" : "未运行"}`,
        `自动启动：${status.watcherAutoStart ? "开启" : "关闭"}`,
        `最近成功回推：${status.watcherLastSuccessfulPostAt || "无"}`,
        `最近错误：${status.watcherLastError || "无"}`,
        `本地 session 扫描：${status.localSessionScanEnabled ? "开启" : "关闭"}`,
        `本地 session 根目录：${status.localSessionRoot || "未配置"}`,
        `Codex 自动执行：${status.codexAutoDispatchEnabled ? "开启" : "关闭"}`,
        `Codex CLI：${status.codexCliBin}`,
        `可用模型数：${status.modelCount}`,
        `默认模型：${status.defaultModel || "未设置"}`
      ].join("\n")
    },
    {
      tag: "markdown",
      content: [
        "【当前选择】",
        `项目：${status.selectedContext.selectedProjectName || "未选择"}`,
        `session：${status.selectedContext.selectedSessionTitle || status.selectedContext.selectedThreadId || "未选择"}`,
        `模型：${status.selectedContext.selectedModelName || status.selectedContext.selectedModelSlug || "未选择"}`,
        `推理：${resolveFeishuReasoningLevelLabel(status.selectedContext.selectedReasoningLevel)}`
      ].join("\n")
    },
    ...buildBottomActionBlocks()
  ];

  return buildCard({
    title: "网关状态",
    template: status.watcherRunning ? "green" : "orange",
    intro: "这里展示网关、扫描器、模型目录和当前选择状态。",
    elements
  });
}

export function buildFeishuSelectionCard(input: {
  context: FeishuPanelContextRecord;
  project?: FeishuPanelProjectSummary | null;
  session?: FeishuPanelSessionSummary | null;
  model?: CodexModelCatalogRecord | null;
  notice?: string | null;
}) {
  const elements: Array<Record<string, unknown>> = [];

  if (input.notice?.trim()) {
    elements.push({
      tag: "markdown",
      content: `【提示】\n${input.notice.trim()}`
    });
  }

  const selectedReasoningLevel = input.context.selectedReasoningLevel || input.model?.defaultReasoningLevel || null;

  elements.push(
    {
      tag: "markdown",
      content: "【当前选择】\n这是你在飞书里的连续选择上下文。"
    },
    {
      tag: "markdown",
      content: [
        `项目：${input.context.selectedProjectName || "未选择"}`,
        `session：${input.context.selectedSessionTitle || input.context.selectedThreadId || "未选择"}`,
        `模型：${input.context.selectedModelName || input.context.selectedModelSlug || "未选择"}`,
        `推理：${resolveFeishuReasoningLevelLabel(selectedReasoningLevel)}`,
        `输入模式：${formatComposeModeLabel(input.context.pendingComposeMode)}`,
        `最近动作：${input.context.lastAction || "无"}`
      ].join("\n")
    }
  );

  if (input.project) {
    elements.push({
      tag: "markdown",
      content: [
        "【当前项目】",
        `${input.project.projectName}`,
        `路径：${input.project.projectPath}`,
        `会话数：${input.project.sessionCount}`
      ].join("\n")
    });
  }

  if (input.session) {
    elements.push({
      tag: "markdown",
      content: [
        "【当前 session】",
        `${input.session.sessionTitle}`,
        `thread：${input.session.threadId}`,
        `文件：${input.session.rolloutFileName}`,
        `最近消息时间：${input.session.lastMessageAt || "无"}`,
        "发送任务内容即可进入当前 session。"
      ].join("\n")
    });
  }

  if (input.model) {
    const reasoningSelection = resolveFeishuModelReasoningSelection({
      model: input.model,
      requestedReasoningLevel: selectedReasoningLevel
    });

    elements.push({
      tag: "markdown",
      content: [
        "【当前模型】",
        `${input.model.displayName}`,
        `${input.model.slug}`,
        `默认推理：${reasoningSelection.reasoningLabel || "未设置"}`,
        `可选推理：${formatReasoningOptionsSummary(reasoningSelection.reasoningOptions) || "无"}`,
        `${truncate(input.model.description || "无描述", 180)}`
      ].join("\n")
    });
  }

  elements.push(...buildBottomActionBlocks());

  return buildCard({
    title: "当前选择",
    template: "indigo",
    intro: "这里展示你当前选中的 project、session 和模型。",
    elements
  });
}

export function buildFeishuComposeGuideCard(input: {
  context: FeishuPanelContextRecord;
  mode: "session_command" | "thread_command" | "project_session_command";
}) {
  const hasSelectedSession = Boolean(input.context.selectedThreadId);
  const selectedSession = input.context.selectedSessionTitle || input.context.selectedThreadId || "未选择";
  const hasSelectedProject = Boolean(input.context.selectedProjectPath);
  const selectedProject = input.context.selectedProjectName || input.context.selectedProjectPath || "未选择";
  const autoRouteGuide =
    input.mode === "project_session_command"
      ? hasSelectedProject
        ? [
            "【下一步】",
            `当前已选项目：${selectedProject}`,
            "下一条消息直接输入任务内容即可，我会在当前项目下创建新的 Codex 会话。",
            "提示：这不会复用已有 session。"
          ].join("\n")
        : [
            "【下一步】",
            "未选中项目，请先选择项目，再点击“新建 session”。",
            "模板：查看项目 -> 选择项目 -> 新建 session"
          ].join("\n")
      : input.mode === "session_command"
      ? hasSelectedSession
        ? [
            "【下一步】",
            `当前已选 session：${selectedSession}`,
            "下一条消息直接输入任务内容即可，我会自动按会话指令模板下发。",
            `等效模板：#session:${input.context.selectedThreadId} <任务内容>`
          ].join("\n")
        : [
            "【下一步】",
            "未选中 session，下一条请直接发送完整会话指令。",
            "模板：#session:<sessionId> <任务内容>"
          ].join("\n")
      : hasSelectedSession
        ? [
            "【下一步】",
            `当前已选 session：${selectedSession}`,
            "下一条消息直接输入任务内容即可，我会自动按线程定向模板下发。",
            `等效模板：线程 ID：${input.context.selectedThreadId}，任务内容：<任务内容>`
          ].join("\n")
        : [
            "【下一步】",
            "未选中 session，请先选择 session 或直接发送完整线程定向指令。",
            "模板：线程 ID：<线程标识>，任务内容：<任务内容>"
          ].join("\n");

  return buildCard({
    title:
      input.mode === "session_command"
        ? "会话指令模式已开启"
        : input.mode === "project_session_command"
          ? "新建 session 模式已开启"
          : "线程定向模式已开启",
    template:
      input.mode === "session_command"
        ? "blue"
        : input.mode === "project_session_command"
          ? "green"
          : "turquoise",
    intro: "已进入任务输入模式，下一条文本会优先按你选择的模板路由。",
    elements: [
      {
        tag: "markdown",
        content: [
          "【当前选择】",
          `项目：${selectedProject}`,
          `session：${selectedSession}`,
          `模型：${input.context.selectedModelName || input.context.selectedModelSlug || "未选择"}`
        ].join("\n")
      },
      {
        tag: "markdown",
        content: autoRouteGuide
      },
      ...buildBottomActionBlocks()
    ]
  });
}

export function buildFeishuTaskStatusCard(input: {
  title: string;
  statusLabel: string;
  summary: string;
  detail: string;
  taskId: string;
  sessionId: string;
  actorId: string;
  actorLabel?: string;
  threadRef: string;
  threadAlias: string;
  renderedText: string;
  footerNote?: string | null;
}) {
  const runningLabel = "\u8fdb\u884c\u4e2d";
  const pendingConfirmLabel = "\u5f85\u786e\u8ba4";
  const successLabel = "\u6210\u529f";
  const failedLabel = "\u5931\u8d25";
  const isRunning = input.statusLabel === runningLabel;
  const isPendingConfirm = input.statusLabel === pendingConfirmLabel;
  const detailLabel = isRunning || isPendingConfirm ? "\u4efb\u52a1\u5185\u5bb9" : "\u5b8c\u6210\u5185\u5bb9";
  const titleText = normalizeCardText(input.title || "\u672a\u547d\u540d\u4efb\u52a1");
  const normalizedTitle = normalizeCardText(titleText);
  const normalizedPreview = normalizeCardText(resolveTaskCardPreviewText(input));
  const previewText = normalizedPreview && normalizedPreview !== normalizedTitle ? normalizedPreview : "";
  const detailText = normalizeCardText(input.detail || input.summary || "\u65e0");
  const headingColor = isRunning || isPendingConfirm ? "blue" : input.statusLabel === successLabel ? "green" : "red";
  const sessionSelector = resolveTaskCardSessionSelector(input);
  const actionButtons: Array<{ text: string; value: Record<string, unknown>; type?: "default" | "primary" | "danger" }> = [];

  if (sessionSelector) {
    actionButtons.push({
      text: "\u9009\u62e9\u6b64\u4f1a\u8bdd",
      type: "primary",
      value: {
        panelAction: "select_session",
        selector: sessionSelector,
        threadId: sessionSelector,
        threadRef: input.threadRef || "",
        sessionId: input.sessionId
      }
    });
  }

  if (isRunning) {
    actionButtons.push({
      text: "\u7ec8\u6b62\u4efb\u52a1",
      type: "danger",
      value: {
        panelAction: "stop_task",
        taskId: input.taskId,
        sessionId: input.sessionId,
        threadRef: input.threadRef || ""
      }
    });
  }

  const runtimeNoteBlock = buildTaskRuntimeNoteBlock(input.footerNote);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: [
        `<font color='${headingColor}'>**\u3010\u4efb\u52a1\u6807\u9898\u3011**</font>`,
        `**${titleText}**`,
        previewText ? `> ${previewText}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: [`<font color='${headingColor}'>**\u3010${detailLabel}\u3011**</font>`, detailText].join("\n")
    },
    { tag: "hr" }
  ];

  if (actionButtons.length > 0) {
    elements.push(buildActionBlock(actionButtons));
    elements.push({ tag: "hr" });
  }

  elements.push(...buildBottomActionBlocks());
  elements.push({ tag: "hr" });
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: [
          `\uD83C\uDD94 \u4efb\u52a1ID\uff1a${shortenMetaIdentifier(input.taskId)}`,
          `\uD83D\uDCAC \u4f1a\u8bddID\uff1a${shortenMetaIdentifier(input.sessionId)}`,
          `\uD83D\uDC64 \u89e6\u53d1\u65b9\uff1a${resolveTaskCardActorLabel(input.actorLabel, input.actorId)}`,
          `\uD83E\uDDF5 \u7ebf\u7a0bID\uff1a${resolveTaskCardThreadLabel(input.threadAlias, input.threadRef)}`
        ].join(" \u00b7 ")
      }
    ]
  });

  if (runtimeNoteBlock) {
    elements.push({ tag: "hr" });
    elements.push(runtimeNoteBlock);
  }

  return buildCard({
    title: `${input.statusLabel} \u00b7 ${truncate(titleText, 28)}`,
    template: input.statusLabel === failedLabel ? "red" : input.statusLabel === successLabel ? "green" : "blue",
    intro: "",
    elements
  });
}
function renderSelectionIntro(context: FeishuPanelContextRecord, title: string, reasoningLevel: string | null = null) {
  return [
    `【${title}】`,
    `当前选择：项目=${context.selectedProjectName || "未选"} / session=${
      context.selectedSessionTitle || context.selectedThreadId || "未选"
    } / 模型=${context.selectedModelName || context.selectedModelSlug || "未选"} / 推理=${resolveFeishuReasoningLevelLabel(
      reasoningLevel
    )} / 输入模式=${formatComposeModeLabel(context.pendingComposeMode)}`,
    `最近动作：${context.lastAction || "无"}`
  ].join("\n");
}

function buildCard(input: {
  title: string;
  template:
    | "blue"
    | "wathet"
    | "turquoise"
    | "green"
    | "yellow"
    | "orange"
    | "red"
    | "carmine"
    | "violet"
    | "purple"
    | "indigo"
    | "grey";
  intro?: string;
  elements: Array<Record<string, unknown>>;
}) {
  const intro = (input.intro || "").trim();
  const introElements = intro
    ? [
        {
          tag: "markdown",
          content: `【说明】\n${intro}`
        },
        {
          tag: "hr"
        }
      ]
    : [];
  const beautifiedElements = beautifyCardElements([...introElements, ...input.elements], input.template);

  return JSON.stringify({
    config: {
      wide_screen_mode: true,
      enable_forward: true
    },
    header: {
      template: input.template,
      title: {
        tag: "plain_text",
        content: input.title
      }
    },
    elements: beautifiedElements
  });
}

function beautifyCardElements(
  elements: Array<Record<string, unknown>>,
  template: string
) {
  const accentColor = resolveCardAccentColor(template);
  return elements.map((element) => {
    const tag = String(element.tag || "");
    if (tag === "markdown" && typeof element.content === "string") {
      return {
        ...element,
        content: beautifyMarkdownContent(element.content, accentColor)
      };
    }

    if (tag === "note" && Array.isArray(element.elements)) {
      return {
        ...element,
        elements: element.elements.map((noteElement) => {
          if (!noteElement || typeof noteElement !== "object") {
            return noteElement;
          }

          const typed = noteElement as Record<string, unknown>;
          if (typed.tag !== "plain_text" || typeof typed.content !== "string") {
            return noteElement;
          }

          return {
            ...typed,
            content: beautifyNotePlainText(typed.content)
          };
        })
      };
    }

    return element;
  });
}

function beautifyMarkdownContent(content: string, accentColor: string) {
  const normalized = (content || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return normalized;
  }

  const lines = normalized.split("\n");
  if (lines.length === 0) {
    return normalized;
  }

  const firstLine = lines[0].trim();
  if (/^【[^】]+】$/.test(firstLine)) {
    lines[0] = `<font color='${accentColor}'>**${firstLine}**</font>`;
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith(">") || line.startsWith("`")) {
      lines[index] = line;
      continue;
    }

    if (/^[^：:\n]{1,18}[：:]\s*/.test(line)) {
      lines[index] = line.replace(/^([^：:]{1,18}[：:])\s*/, "**$1** ");
      continue;
    }

    lines[index] = line;
  }

  return lines.join("\n");
}

function beautifyNotePlainText(content: string) {
  const normalized = (content || "").trim();
  if (!normalized) {
    return normalized;
  }

  const withBetterSeparators = normalized.replace(/\s+\|\s+/g, " · ");
  const replacements: Array<{ pattern: RegExp; replacement: string }> = [
    { pattern: /(^| · )任务ID：/g, replacement: "$1🆔 任务ID：" },
    { pattern: /(^| · )会话ID：/g, replacement: "$1💬 会话ID：" },
    { pattern: /(^| · )触发方：/g, replacement: "$1👤 触发方：" },
    { pattern: /(^| · )线程ID：/g, replacement: "$1🧵 线程ID：" },
    { pattern: /^该次任务耗时：/, replacement: "⏱️ 该次任务耗时：" }
  ];

  return replacements.reduce((acc, item) => acc.replace(item.pattern, item.replacement), withBetterSeparators);
}

function resolveCardAccentColor(template: string) {
  if (template === "red" || template === "carmine") {
    return "red";
  }
  if (template === "green" || template === "turquoise") {
    return "green";
  }
  if (template === "orange" || template === "yellow") {
    return "orange";
  }
  if (template === "purple" || template === "violet" || template === "indigo") {
    return "purple";
  }
  if (template === "grey") {
    return "grey";
  }
  return "blue";
}

function buildActionBlock(buttons: Array<{ text: string; value: Record<string, unknown>; type?: "default" | "primary" | "danger" }>) {
  return {
    tag: "action",
    layout: "flow",
    actions: buttons.map((button) => ({
      tag: "button",
      type: button.type ?? "default",
      text: {
        tag: "plain_text",
        content: button.text
      },
      value: button.value
    }))
  };
}

function buildBottomActionBlocks() {
  return [
    buildActionBlock([
      {
        text: "查看项目",
        type: "default",
        value: { panelAction: "view_projects" }
      },
      {
        text: "当前项目会话",
        type: "default",
        value: { panelAction: "view_project_sessions" }
      },
      {
        text: "新建 session",
        type: "primary",
        value: { panelAction: "compose_project_session_command" }
      },
      {
        text: "会话指令",
        type: "default",
        value: { panelAction: "compose_session_command" }
      }
    ]),
    buildActionBlock([
      {
        text: "查看模型列表",
        type: "default",
        value: { panelAction: "view_models" }
      },
      {
        text: "网关状态",
        type: "default",
        value: { panelAction: "view_gateway_status" }
      },
      {
        text: "当前选择",
        type: "default",
        value: { panelAction: "current_selection" }
      },
      {
        text: "线程定向",
        type: "default",
        value: { panelAction: "compose_thread_command" }
      },
      {
        text: "帮助",
        type: "default",
        value: { panelAction: "help" }
      }
    ])
  ];
}

function buildTaskRuntimeNoteBlock(note: string | null | undefined) {
  const content = (note || "").trim();
  if (!content) {
    return null;
  }

  return {
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content
      }
    ]
  };
}

function buildSessionWindowButtons(input: {
  actionType: "view_sessions" | "view_project_sessions";
  window: FeishuPanelSessionWindow;
}) {
  const resolveType = (target: FeishuPanelSessionWindow): "default" | "primary" => (input.window === target ? "primary" : "default");
  return [
    {
      text: "全部",
      type: resolveType("all"),
      value: {
        panelAction: input.actionType,
        window: "all",
        page: 1
      }
    },
    {
      text: "最近24h",
      type: resolveType("24h"),
      value: {
        panelAction: input.actionType,
        window: "24h",
        page: 1
      }
    },
    {
      text: "最近7d",
      type: resolveType("7d"),
      value: {
        panelAction: input.actionType,
        window: "7d",
        page: 1
      }
    }
  ];
}

function buildSessionPaginationButtons(input: {
  actionType: "view_sessions" | "view_project_sessions";
  window: FeishuPanelSessionWindow;
  currentPage: number;
  totalPages: number;
}) {
  const buttons: Array<{ text: string; value: Record<string, unknown>; type?: "default" | "primary" | "danger" }> = [];
  if (input.currentPage > 1) {
    buttons.push({
      text: "上一页",
      type: "default",
      value: {
        panelAction: input.actionType,
        window: input.window,
        page: input.currentPage - 1
      }
    });
  }
  if (input.currentPage < input.totalPages) {
    buttons.push({
      text: "下一页",
      type: "default",
      value: {
        panelAction: input.actionType,
        window: input.window,
        page: input.currentPage + 1
      }
    });
  }
  return buttons;
}

function formatSessionWindowLabel(window: FeishuPanelSessionWindow) {
  if (window === "24h") {
    return "最近24小时";
  }
  if (window === "7d") {
    return "最近7天";
  }
  return "全部";
}

function formatComposeModeLabel(mode: FeishuPanelContextRecord["pendingComposeMode"]) {
  if (mode === "session_command") {
    return "会话指令";
  }

  if (mode === "project_session_command") {
    return "新建 session";
  }

  if (mode === "thread_command") {
    return "线程定向";
  }

  return "普通";
}

function resolveTaskCardPreviewText(input: {
  title: string;
  summary: string;
  detail: string;
  renderedText: string;
}) {
  const fallback = truncate(input.summary || input.detail || "无摘要", 240);
  const cleaned = sanitizeRenderedStatusText(input.renderedText, {
    title: input.title,
    summary: input.summary,
    detail: input.detail
  });

  if (!cleaned) {
    return fallback;
  }

  return truncate(cleaned, 240);
}

function resolveTaskCardSessionSelector(input: {
  sessionId: string;
  threadRef: string;
  threadAlias: string;
}) {
  const threadRef = (input.threadRef || "").trim();
  if (threadRef) {
    return threadRef;
  }

  const threadAlias = (input.threadAlias || "").trim();
  if (threadAlias) {
    return threadAlias;
  }

  const sessionId = (input.sessionId || "").trim();
  return sessionId || "";
}

function sanitizeRenderedStatusText(
  renderedText: string,
  context: {
    title: string;
    summary: string;
    detail: string;
  }
) {
  const source = (renderedText || "").trim();
  if (!source) {
    return "";
  }

  const title = (context.title || "").trim();
  const summary = (context.summary || "").trim();
  const detail = (context.detail || "").trim();
  const ignoredLinePatterns = [
    /^【(任务标题|任务元信息|任务内容|完成内容)】$/,
    /^(任务状态|任务标题|任务ID|会话ID|触发方|线程(?:\s*ID)?|线程ID|任务内容|完成内容)[：:]/
  ];

  const keptLines: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of source.split(/\r?\n+/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (
      ignoredLinePatterns.some((pattern) => pattern.test(line)) ||
      line === title ||
      line === summary ||
      line === detail ||
      seen.has(line)
    ) {
      continue;
    }

    seen.add(line);
    keptLines.push(line);
  }

  return keptLines.join("；");
}

function resolveTaskCardActorLabel(actorLabel: string | undefined, actorId: string) {
  const preferred = (actorLabel || "").trim();
  if (preferred) {
    return preferred;
  }

  const normalizedActorId = (actorId || "").trim();
  return normalizedActorId || "未知";
}

function resolveTaskCardThreadLabel(threadAlias: string, threadRef: string) {
  const normalizedAlias = (threadAlias || "").trim();
  if (normalizedAlias) {
    return shortenMetaIdentifier(normalizedAlias);
  }

  const normalizedThreadRef = (threadRef || "").trim();
  if (normalizedThreadRef) {
    return shortenMetaIdentifier(normalizedThreadRef);
  }

  return "无";
}

function shortenMetaIdentifier(value: string) {
  const normalized = (value || "").trim();
  if (!normalized) {
    return "无";
  }

  const uuidLikeMatched = normalized.match(/^([0-9a-fA-F]{8})-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
  if (uuidLikeMatched) {
    return uuidLikeMatched[1];
  }

  if (normalized.length <= 20) {
    return normalized;
  }

  const prefixMatched = normalized.match(/^([0-9a-zA-Z]{8,})[-_][0-9a-zA-Z_-]+$/);
  if (prefixMatched) {
    return prefixMatched[1].slice(0, 8);
  }

  return normalized.slice(0, 8);
}

function truncate(value: string, maxLength: number) {
  const cleaned = value.replace(/\u0000/g, "").trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLength - 3)}...`;
}

function normalizeCardText(value: string) {
  const cleaned = (value || "").replace(/\u0000/g, "").trim();
  return cleaned || "无";
}

function normalizeActionValue(value: unknown) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function parsePanelPage(record: Record<string, unknown>) {
  const raw = record.page;
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(value) || value < 1) {
    return undefined;
  }
  return Math.floor(value);
}

function parsePanelWindow(record: Record<string, unknown>): FeishuPanelSessionWindow | undefined {
  const raw = String(record.window || record.timeWindow || record.sessionWindow || "").trim().toLowerCase();
  if (!raw) {
    return undefined;
  }
  if (raw === "24h" || raw === "7d" || raw === "all") {
    return raw;
  }
  return undefined;
}
