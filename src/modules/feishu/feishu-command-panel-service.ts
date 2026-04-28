/**
 * @description 飞书指令面板服务，负责 project/session/model 的连续选择与卡片渲染
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 22:05
 */
import { AppError } from "../../lib/errors";
import {
  buildFeishuComposeGuideCard,
  buildFeishuGatewayStatusCard,
  buildFeishuModelListCard,
  buildFeishuProjectListCard,
  buildFeishuSelectionCard,
  buildFeishuSessionListCard,
  type FeishuPanelCommand,
  type FeishuPanelGatewayStatus,
  type FeishuPanelProjectSummary,
  type FeishuPanelSessionWindow,
  type FeishuPanelSessionSummary,
  parseFeishuPanelActionValue,
  parseFeishuPanelCommand
} from "./feishu-command-panel";
import { getCodexGlobalWatcherRuntimeStatus } from "../codex/codex-global-watcher";
import { CodexLocalSessionService, type LocalCodexSessionRecord } from "../codex/codex-local-session-service";
import { CodexModelCatalogService, type CodexModelCatalogRecord } from "../codex/codex-model-catalog-service";
import {
  FeishuPanelComposeMode,
  FeishuPanelContextRecord,
  FeishuPanelContextRepository,
  FeishuPanelCurrentView
} from "../../storage/repositories/feishu-panel-context-repository";

type FeishuCommandPanelServiceDeps = {
  contextRepository: FeishuPanelContextRepository;
  codexLocalSessionService?: CodexLocalSessionService;
  codexModelCatalogService: CodexModelCatalogService;
  codexAutoDispatchEnabled: boolean;
  codexCliBin: string;
};

export type FeishuCommandPanelSelection = {
  context: FeishuPanelContextRecord;
  card: string;
};

const SESSION_LIST_PAGE_SIZE = 8;

export class FeishuCommandPanelService {
  constructor(private readonly deps: FeishuCommandPanelServiceDeps) {}

  parseCommand(text: string) {
    return parseFeishuPanelCommand(text);
  }

  parseAction(value: unknown) {
    return parseFeishuPanelActionValue(value);
  }

  getContext(openId: string) {
    return this.ensureContext(openId);
  }

  async showProjects(openId: string, refresh = true): Promise<FeishuCommandPanelSelection> {
    const context = this.updateContext(openId, {
      currentView: "project_list",
      lastAction: "view_projects"
    });
    const snapshot = this.loadLocalSessions(refresh);
    const projects = this.buildProjectSummaries(snapshot.items);
    return {
      context,
      card: buildFeishuProjectListCard({
        context,
        projects
      })
    };
  }

  async selectProject(openId: string, selector: string, refresh = true): Promise<FeishuCommandPanelSelection> {
    const snapshot = this.loadLocalSessions(refresh);
    const project = this.resolveProject(snapshot.items, selector);
    if (!project) {
      throw new AppError("FEISHU_PANEL_PROJECT_NOT_FOUND", 404, `Project not found for selector: ${selector}`);
    }

    const sessions = this.buildSessionsForProject(snapshot.items, project.projectPath);
    return this.renderProjectSessionList(openId, {
      project,
      sessions,
      page: 1,
      window: "all",
      actionType: "view_project_sessions",
      lastAction: `select_project:${project.projectPath}`,
      contextPatch: {
        selectedProjectName: project.projectName,
        selectedProjectPath: project.projectPath,
        selectedThreadId: null,
        selectedSessionTitle: null
      }
    });
  }

  async showSessions(
    openId: string,
    input: {
      refresh?: boolean;
      page?: number;
      window?: FeishuPanelSessionWindow;
    } = {}
  ): Promise<FeishuCommandPanelSelection> {
    const context = this.ensureContext(openId);
    const refresh = input.refresh ?? true;
    if (!context.selectedProjectPath) {
      return this.showProjects(openId, refresh);
    }

    const snapshot = this.loadLocalSessions(refresh);
    const project = this.resolveProject(snapshot.items, context.selectedProjectPath);
    if (!project) {
      return this.showProjects(openId, refresh);
    }

    const sessions = this.buildSessionsForProject(snapshot.items, project.projectPath);
    return this.renderProjectSessionList(openId, {
      project,
      sessions,
      page: input.page,
      window: input.window,
      actionType: "view_sessions",
      lastAction: "view_sessions"
    });
  }

  async showCurrentProjectSessions(
    openId: string,
    input: {
      refresh?: boolean;
      page?: number;
      window?: FeishuPanelSessionWindow;
    } = {}
  ): Promise<FeishuCommandPanelSelection> {
    const context = this.ensureContext(openId);
    const refresh = input.refresh ?? true;
    if (!context.selectedProjectPath) {
      return this.showProjects(openId, refresh);
    }

    const snapshot = this.loadLocalSessions(refresh);
    const project = this.resolveProject(snapshot.items, context.selectedProjectPath);
    if (!project) {
      return this.showProjects(openId, refresh);
    }

    const sessions = this.buildSessionsForProject(snapshot.items, project.projectPath);
    return this.renderProjectSessionList(openId, {
      project,
      sessions,
      page: input.page,
      window: input.window,
      actionType: "view_project_sessions",
      lastAction: "view_project_sessions"
    });
  }

  async selectSession(openId: string, selector: string, refresh = true): Promise<FeishuCommandPanelSelection> {
    const snapshot = this.loadLocalSessions(refresh);
    const session = this.resolveSession(snapshot.items, selector);
    if (!session) {
      throw new AppError("FEISHU_PANEL_SESSION_NOT_FOUND", 404, `Session not found for selector: ${selector}`);
    }

    const updated = this.updateContext(openId, {
      currentView: "selection",
      selectedProjectName: session.projectName,
      selectedProjectPath: session.projectPath,
      selectedThreadId: session.threadId,
      selectedSessionTitle: session.sessionTitle,
      lastAction: `select_session:${session.threadId}`
    });
    return {
      context: updated,
      card: buildFeishuSelectionCard({
        context: updated,
        project: this.resolveProject(snapshot.items, session.projectPath),
        session,
        notice: "已切换到此会话，可直接回复任务内容。"
      })
    };
  }

  async showModels(openId: string, refresh = true): Promise<FeishuCommandPanelSelection> {
    const catalog = this.deps.codexModelCatalogService.listModels({ refresh });
    const context = this.updateContext(openId, {
      currentView: "model_list",
      lastAction: "view_models"
    });

    return {
      context,
      card: buildFeishuModelListCard({
        context,
        models: catalog.items,
        defaultModel: catalog.defaultModel
      })
    };
  }

  async selectModel(openId: string, selector: string, refresh = true): Promise<FeishuCommandPanelSelection> {
    const catalog = this.deps.codexModelCatalogService.listModels({ refresh });
    const model = this.resolveModel(catalog.items, selector);
    if (!model) {
      throw new AppError("FEISHU_PANEL_MODEL_NOT_FOUND", 404, `Model not found for selector: ${selector}`);
    }

    const context = this.updateContext(openId, {
      currentView: "selection",
      selectedModelSlug: model.slug,
      selectedModelName: model.displayName,
      lastAction: `select_model:${model.slug}`
    });

    return {
      context,
      card: buildFeishuSelectionCard({
        context,
        project: this.resolveSelectedProject(context),
        session: this.resolveSelectedSession(context),
        model
      })
    };
  }

  async showGatewayStatus(openId: string, refresh = true): Promise<FeishuCommandPanelSelection> {
    let catalog:
      | {
          items: CodexModelCatalogRecord[];
          defaultModel: string | null;
        }
      | null = null;

    try {
      catalog = this.deps.codexModelCatalogService.listModels({ refresh });
    } catch {
      catalog = null;
    }

    const context = this.updateContext(openId, {
      currentView: "gateway_status",
      lastAction: "view_gateway_status"
    });
    const panelStatus = this.buildGatewayStatus(context, catalog?.items.length ?? 0, catalog?.defaultModel ?? null);

    return {
      context,
      card: buildFeishuGatewayStatusCard({
        context,
        gatewayStatus: panelStatus
      })
    };
  }

  async showCurrentSelection(openId: string, refresh = true): Promise<FeishuCommandPanelSelection> {
    const context = this.updateContext(openId, {
      currentView: "selection",
      lastAction: "current_selection"
    });
    return {
      context,
      card: buildFeishuSelectionCard({
        context,
        project: this.resolveSelectedProject(context, refresh),
        session: this.resolveSelectedSession(context, refresh),
        model: this.resolveSelectedModel(context, refresh)
      })
    };
  }

  activateComposeMode(openId: string, mode: FeishuPanelComposeMode): FeishuCommandPanelSelection {
    const patch: Partial<Omit<FeishuPanelContextRecord, "openId">> = {
      currentView: "selection",
      pendingComposeMode: mode,
      lastAction:
        mode === "session_command"
          ? "compose_session_command"
          : mode === "project_session_command"
            ? "compose_project_session_command"
            : "compose_thread_command"
    };

    if (mode === "project_session_command") {
      patch.selectedThreadId = null;
      patch.selectedSessionTitle = null;
    }

    const context = this.updateContext(openId, patch);

    return {
      context,
      card: buildFeishuComposeGuideCard({
        context,
        mode
      })
    };
  }

  clearComposeMode(openId: string) {
    const existing = this.ensureContext(openId);
    if (!existing.pendingComposeMode) {
      return existing;
    }

    return this.updateContext(openId, {
      pendingComposeMode: null
    });
  }

  async handlePanelCommand(openId: string, command: FeishuPanelCommand, refresh = true): Promise<FeishuCommandPanelSelection> {
    switch (command.actionType) {
      case "view_projects":
        return this.showProjects(openId, refresh);
      case "select_project":
        return this.selectProject(openId, command.selector, refresh);
      case "view_sessions":
        return this.showSessions(openId, {
          refresh,
          page: command.page,
          window: command.window
        });
      case "view_project_sessions":
        return this.showCurrentProjectSessions(openId, {
          refresh,
          page: command.page,
          window: command.window
        });
      case "select_session":
        return this.selectSession(openId, command.selector, refresh);
      case "view_models":
        return this.showModels(openId, refresh);
      case "select_model":
        return this.selectModel(openId, command.selector, refresh);
      case "view_gateway_status":
        return this.showGatewayStatus(openId, refresh);
      case "current_selection":
        return this.showCurrentSelection(openId, refresh);
      case "compose_session_command":
        return this.activateComposeMode(openId, "session_command");
      case "compose_thread_command":
        return this.activateComposeMode(openId, "thread_command");
      case "compose_project_session_command":
        return this.activateComposeMode(openId, "project_session_command");
      case "help":
        return this.showCurrentSelection(openId, refresh);
      case "start_task":
        return this.showCurrentSelection(openId, refresh);
      default:
        return this.showCurrentSelection(openId, refresh);
    }
  }

  resolveDispatchContext(openId: string) {
    const context = this.ensureContext(openId);
    const selectedModel = this.resolveSelectedModel(context);
    return {
      context,
      selectedThreadId: context.selectedThreadId,
      selectedModelSlug: context.selectedModelSlug,
      selectedModelName: context.selectedModelName,
      selectedProjectPath: context.selectedProjectPath,
      selectedProjectName: context.selectedProjectName,
      selectedSessionTitle: context.selectedSessionTitle,
      selectedModel,
      pendingComposeMode: context.pendingComposeMode,
      selectedProject: this.resolveSelectedProject(context),
      selectedSession: this.resolveSelectedSession(context)
    };
  }

  private ensureContext(openId: string) {
    const existing = this.deps.contextRepository.findByOpenId(openId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    return (
      this.deps.contextRepository.upsert({
        openId: openId.trim(),
        currentView: "home",
        selectedProjectName: null,
        selectedProjectPath: null,
        selectedThreadId: null,
        selectedSessionTitle: null,
        selectedModelSlug: null,
        selectedModelName: null,
        pendingComposeMode: null,
        lastAction: null,
        updatedAt: now
      }) || {
        openId: openId.trim(),
        currentView: "home",
        selectedProjectName: null,
        selectedProjectPath: null,
        selectedThreadId: null,
        selectedSessionTitle: null,
        selectedModelSlug: null,
        selectedModelName: null,
        pendingComposeMode: null,
        lastAction: null,
        updatedAt: now
      }
    );
  }

  private updateContext(
    openId: string,
    patch: Partial<Omit<FeishuPanelContextRecord, "openId">> & { currentView?: FeishuPanelCurrentView; lastAction?: string | null }
  ) {
    const existing = this.ensureContext(openId);
    const updatedAt = new Date().toISOString();
    const next = {
      ...existing,
      ...patch,
      openId: existing.openId,
      updatedAt
    };
    return this.deps.contextRepository.upsert(next) ?? next;
  }

  private loadLocalSessions(refresh: boolean) {
    if (!this.deps.codexLocalSessionService) {
      throw new AppError("CODEX_LOCAL_SESSIONS_DISABLED", 503, "Local codex sessions scanner is disabled");
    }

    return this.deps.codexLocalSessionService.getSnapshot({
      limit: 10000,
      refresh
    });
  }

  private buildProjectSummaries(items: LocalCodexSessionRecord[]): FeishuPanelProjectSummary[] {
    const grouped = new Map<
      string,
      {
        projectName: string;
        projectPath: string;
        sessionCount: number;
        latestUpdatedAt: string;
        latestSessionTitle: string;
      }
    >();

    for (const item of items) {
      const key = item.projectPath || item.projectName;
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          projectName: item.projectName,
          projectPath: item.projectPath,
          sessionCount: 1,
          latestUpdatedAt: item.updatedAt,
          latestSessionTitle: item.sessionTitle
        });
        continue;
      }

      existing.sessionCount += 1;
      if (item.updatedAt.localeCompare(existing.latestUpdatedAt) > 0) {
        existing.latestUpdatedAt = item.updatedAt;
        existing.latestSessionTitle = item.sessionTitle;
      }
    }

    return [...grouped.values()].sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt));
  }

  private buildSessionsForProject(items: LocalCodexSessionRecord[], projectPath: string): FeishuPanelSessionSummary[] {
    return items
      .filter((item) => item.projectPath === projectPath)
      .map((item) => ({
        threadId: item.threadId,
        rolloutFileName: item.rolloutFileName,
        sessionTitle: item.sessionTitle,
        messageCount: item.messageCount,
        updatedAt: item.updatedAt,
        firstMessageAt: item.firstMessageAt,
        lastMessageAt: item.lastMessageAt,
        projectName: item.projectName,
        projectPath: item.projectPath
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private renderProjectSessionList(inputOpenId: string, input: {
    project: FeishuPanelProjectSummary;
    sessions: FeishuPanelSessionSummary[];
    page?: number;
    window?: FeishuPanelSessionWindow;
    actionType: "view_sessions" | "view_project_sessions";
    lastAction: string;
    contextPatch?: Partial<Omit<FeishuPanelContextRecord, "openId" | "updatedAt">>;
  }): FeishuCommandPanelSelection {
    const window = this.normalizeSessionWindow(input.window);
    const filtered = this.filterSessionsByWindow(input.sessions, window);
    const pagination = this.paginateSessions(filtered, input.page);
    const context = this.updateContext(inputOpenId, {
      currentView: "session_list",
      lastAction: `${input.lastAction}:window=${window}:page=${pagination.currentPage}`,
      ...(input.contextPatch || {})
    });

    return {
      context,
      card: buildFeishuSessionListCard({
        context,
        project: input.project,
        sessions: pagination.items,
        actionType: input.actionType,
        window,
        currentPage: pagination.currentPage,
        totalPages: pagination.totalPages,
        pageSize: SESSION_LIST_PAGE_SIZE,
        totalCount: filtered.length,
        rawTotalCount: input.sessions.length
      })
    };
  }

  private normalizeSessionWindow(window: FeishuPanelSessionWindow | undefined): FeishuPanelSessionWindow {
    if (window === "24h" || window === "7d") {
      return window;
    }
    return "all";
  }

  private filterSessionsByWindow(sessions: FeishuPanelSessionSummary[], window: FeishuPanelSessionWindow): FeishuPanelSessionSummary[] {
    if (window === "all") {
      return sessions;
    }

    const now = Date.now();
    const thresholdMs = window === "24h" ? now - 24 * 60 * 60 * 1000 : now - 7 * 24 * 60 * 60 * 1000;
    return sessions.filter((session) => {
      const source = session.lastMessageAt || session.updatedAt;
      const timestamp = Date.parse(source);
      return Number.isFinite(timestamp) && timestamp >= thresholdMs;
    });
  }

  private paginateSessions(sessions: FeishuPanelSessionSummary[], page: number | undefined) {
    const totalPages = Math.max(1, Math.ceil(sessions.length / SESSION_LIST_PAGE_SIZE));
    const currentPage = Math.min(Math.max(page ?? 1, 1), totalPages);
    const offset = (currentPage - 1) * SESSION_LIST_PAGE_SIZE;
    return {
      totalPages,
      currentPage,
      items: sessions.slice(offset, offset + SESSION_LIST_PAGE_SIZE)
    };
  }

  private resolveProject(items: LocalCodexSessionRecord[], selector: string) {
    const normalized = selector.trim();
    if (!normalized) {
      return null;
    }

    const summaries = this.buildProjectSummaries(items);
    if (/^\d+$/.test(normalized)) {
      const index = Number(normalized) - 1;
      if (index >= 0 && index < summaries.length) {
        return summaries[index];
      }
    }

    const lower = normalized.toLowerCase();
    return (
      summaries.find((item) => item.projectPath.toLowerCase() === lower) ||
      summaries.find((item) => item.projectName.toLowerCase() === lower) ||
      summaries.find((item) => item.projectPath.toLowerCase().includes(lower)) ||
      summaries.find((item) => item.projectName.toLowerCase().includes(lower)) ||
      null
    );
  }

  private resolveSession(items: LocalCodexSessionRecord[], selector: string) {
    const normalized = selector.trim();
    if (!normalized) {
      return null;
    }

    const resolved = this.deps.codexLocalSessionService?.resolveThreadSelector(normalized);
    if (resolved?.status === "resolved") {
      return this.findSessionByThreadId(items, resolved.threadId);
    }

    if (resolved?.status === "ambiguous") {
      throw new AppError("FEISHU_PANEL_SESSION_AMBIGUOUS", 409, `Session selector matches multiple sessions: ${resolved.candidates.join(", ")}`);
    }

    const lower = normalized.toLowerCase();
    return (
      this.findSessionByThreadId(items, normalized) ||
      items.find((item) => item.rolloutFileName.toLowerCase() === lower) ||
      items.find((item) => item.sessionTitle.toLowerCase().includes(lower)) ||
      items.find((item) => item.projectPath.toLowerCase().includes(lower)) ||
      items.find((item) => item.projectName.toLowerCase().includes(lower)) ||
      null
    );
  }

  private findSessionByThreadId(items: LocalCodexSessionRecord[], threadId: string) {
    const normalized = threadId.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    return items.find((item) => item.threadId.toLowerCase() === normalized) ?? null;
  }

  private resolveModel(models: CodexModelCatalogRecord[], selector: string) {
    const normalized = selector.trim();
    if (!normalized) {
      return null;
    }

    const lower = normalized.toLowerCase();
    return (
      models.find((item) => item.slug.toLowerCase() === lower) ||
      models.find((item) => item.displayName.toLowerCase() === lower) ||
      models.find((item) => item.slug.toLowerCase().includes(lower)) ||
      models.find((item) => item.displayName.toLowerCase().includes(lower)) ||
      null
    );
  }

  private resolveSelectedProject(context: FeishuPanelContextRecord, refresh = false) {
    if (!context.selectedProjectPath || !this.deps.codexLocalSessionService) {
      return null;
    }

    const snapshot = this.loadLocalSessions(refresh);
    return this.resolveProject(snapshot.items, context.selectedProjectPath);
  }

  private resolveSelectedSession(context: FeishuPanelContextRecord, refresh = false) {
    if (!context.selectedThreadId || !this.deps.codexLocalSessionService) {
      return null;
    }

    const snapshot = this.loadLocalSessions(refresh);
    return this.findSessionByThreadId(snapshot.items, context.selectedThreadId);
  }

  private resolveSelectedModel(context: FeishuPanelContextRecord, refresh = false) {
    if (!context.selectedModelSlug) {
      return null;
    }

    try {
      const catalog = this.deps.codexModelCatalogService.listModels({ refresh });
      return this.resolveModel(catalog.items, context.selectedModelSlug);
    } catch {
      return null;
    }
  }

  private buildGatewayStatus(context: FeishuPanelContextRecord, modelCount: number, defaultModel: string | null): FeishuPanelGatewayStatus {
    const watcher = getCodexGlobalWatcherRuntimeStatus();
    return {
      watcherRunning: watcher.running,
      watcherAutoStart: watcher.autoStartConfigured,
      watcherLastSuccessfulPostAt: watcher.lastSuccessfulPostAt,
      watcherLastError: watcher.lastError,
      localSessionScanEnabled: Boolean(this.deps.codexLocalSessionService),
      localSessionRoot: watcher.sessionsRoot,
      codexAutoDispatchEnabled: this.deps.codexAutoDispatchEnabled,
      codexCliBin: this.deps.codexCliBin,
      defaultModel,
      modelCount,
      selectedContext: context
    };
  }
}
