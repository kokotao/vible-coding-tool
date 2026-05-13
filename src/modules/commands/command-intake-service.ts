/**
 * @description 公共命令入站服务，统一处理任务建档、消息落库、风控确认、调度上下文持久化与调度触发
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-05-10 14:05
 */
import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors";
import { ConnectorConfigService } from "../connectors/connector-config-service";
import { evaluateRisk } from "../risk/risk-guard";
import { CodexDispatchService, type DispatchTaskResult } from "../codex/codex-dispatch-service";
import { MessageRepository } from "../../storage/repositories/message-repository";
import { RiskConfirmationRepository } from "../../storage/repositories/risk-confirmation-repository";
import { TaskDispatchContextRepository } from "../../storage/repositories/task-dispatch-context-repository";
import { TaskRepository } from "../../storage/repositories/task-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";
import type { SqliteDatabase } from "../../storage/sqlite";

type CommandIntakeServiceDeps = {
  db: SqliteDatabase;
  connectorConfigService: ConnectorConfigService;
  taskRepository: TaskRepository;
  messageRepository: MessageRepository;
  riskConfirmationRepository: RiskConfirmationRepository;
  toolSessionRepository: ToolSessionRepository;
  taskDispatchContextRepository: TaskDispatchContextRepository;
  codexDispatchService?: CodexDispatchService;
};

export type AcceptCommandInput = {
  sessionId: string;
  actorId: string;
  sourcePlatform: string;
  prompt: string;
  taskType: string;
  toolProvider?: string;
  createdBy?: string | null;
  threadRef?: string | null;
  projectPath?: string | null;
  modelSlug?: string | null;
  modelReasoningLevel?: string | null;
  platformMessageId?: string | null;
  riskKeywords?: string[];
  confirmTimeoutSeconds?: number;
  busyGuard?: boolean;
};

export type AcceptCommandResult = {
  accepted: true;
  taskId: string;
  eventId: string;
  sessionId: string;
  riskLevel: "high" | "low";
  pendingConfirmation: boolean;
  dispatch: DispatchTaskResult;
  taskStatus: string;
};

export class CommandIntakeService {
  private readonly sessionAdmissionLocks = new Set<string>();

  constructor(private readonly deps: CommandIntakeServiceDeps) {}

  acceptCommand(input: AcceptCommandInput): AcceptCommandResult {
    const sessionId = String(input.sessionId || "").trim();
    const actorId = String(input.actorId || "").trim() || "web_console";
    const sourcePlatform = String(input.sourcePlatform || "").trim() || "web_console";
    const prompt = String(input.prompt || "").trim();
    if (!sessionId) {
      throw new AppError("SESSION_REQUIRED", 400, "sessionId is required");
    }
    if (!prompt) {
      throw new AppError("PROMPT_REQUIRED", 400, "prompt is required");
    }

    return this.withSessionAdmissionLock(sessionId, input.busyGuard === true, () => {
      const persisted = this.persistAcceptedCommand({
        sessionId,
        actorId,
        sourcePlatform,
        prompt,
        taskType: input.taskType,
        toolProvider: input.toolProvider,
        createdBy: input.createdBy,
        threadRef: normalizeNullable(input.threadRef),
        projectPath: normalizeNullable(input.projectPath),
        modelSlug: normalizeNullable(input.modelSlug),
        modelReasoningLevel: normalizeNullable(input.modelReasoningLevel),
        platformMessageId: input.platformMessageId ?? null,
        riskKeywords: input.riskKeywords,
        confirmTimeoutSeconds: input.confirmTimeoutSeconds,
        busyGuard: input.busyGuard === true
      });

      if (persisted.pendingConfirmation) {
        return {
          accepted: true,
          taskId: persisted.taskId,
          eventId: persisted.eventId,
          sessionId: persisted.sessionId,
          riskLevel: "high",
          pendingConfirmation: true,
          taskStatus: persisted.taskStatus,
          dispatch: {
            accepted: false,
            skipped: true,
            reason: "pending_confirmation",
            pid: null,
            threadRef: persisted.threadRef,
            command: []
          }
        };
      }

      const dispatch = this.dispatchTask({
        taskId: persisted.taskId,
        sessionId: persisted.sessionId,
        prompt,
        actorId,
        threadRef: persisted.threadRef,
        modelSlug: persisted.modelSlug,
        modelReasoningLevel: persisted.modelReasoningLevel,
        projectPath: persisted.projectPath
      });

      return {
        accepted: true,
        taskId: persisted.taskId,
        eventId: persisted.eventId,
        sessionId: persisted.sessionId,
        riskLevel: "low",
        pendingConfirmation: false,
        taskStatus: persisted.taskStatus,
        dispatch
      };
    });
  }

  private dispatchTask(input: {
    taskId: string;
    sessionId: string;
    prompt: string;
    actorId: string;
    threadRef: string | null;
    modelSlug: string | null;
    modelReasoningLevel: string | null;
    projectPath: string | null;
  }) {
    if (!this.deps.codexDispatchService) {
      return {
        accepted: false,
        skipped: true,
        reason: "dispatcher_disabled",
        pid: null,
        threadRef: input.threadRef,
        command: []
      };
    }
    return this.deps.codexDispatchService.dispatchTask(input);
  }

  private resolveRiskPolicy(customKeywords?: string[], confirmTimeoutSeconds?: number) {
    if (customKeywords !== undefined || confirmTimeoutSeconds !== undefined) {
      return {
        keywords: (customKeywords || []).map((keyword) => String(keyword || "").trim()).filter(Boolean),
        confirmTimeoutSeconds: Math.max(confirmTimeoutSeconds || 0, 120)
      };
    }

    const connectors = this.deps.connectorConfigService.listAll();
    const mergedKeywords = new Set<string>();
    for (const config of connectors) {
      for (const keyword of config.riskKeywords) {
        const normalized = String(keyword || "").trim();
        if (normalized) {
          mergedKeywords.add(normalized);
        }
      }
    }
    for (const keyword of customKeywords || []) {
      const normalized = String(keyword || "").trim();
      if (normalized) {
        mergedKeywords.add(normalized);
      }
    }

    const connectorTimeout = connectors.reduce((max, item) => Math.max(max, item.confirmTimeoutSeconds || 0), 0);
    return {
      keywords: [...mergedKeywords],
      confirmTimeoutSeconds: Math.max(confirmTimeoutSeconds || 0, connectorTimeout, 120)
    };
  }

  private resolveToolSessionRef(explicitThreadRef: string | null, existingToolSessionRef: string | null) {
    const explicit = String(explicitThreadRef || "").trim();
    if (explicit) {
      return explicit;
    }
    return String(existingToolSessionRef || "").trim();
  }

  private withSessionAdmissionLock<T>(sessionId: string, enabled: boolean, callback: () => T) {
    if (!enabled) {
      return callback();
    }

    if (this.sessionAdmissionLocks.has(sessionId)) {
      throw new AppError("SESSION_BUSY", 409, "Session is busy with an active task");
    }

    this.sessionAdmissionLocks.add(sessionId);
    try {
      return callback();
    } finally {
      this.sessionAdmissionLocks.delete(sessionId);
    }
  }

  private persistAcceptedCommand(input: {
    sessionId: string;
    actorId: string;
    sourcePlatform: string;
    prompt: string;
    taskType: string;
    toolProvider?: string;
    createdBy?: string | null;
    threadRef: string | null;
    projectPath: string | null;
    modelSlug: string | null;
    modelReasoningLevel: string | null;
    platformMessageId: string | null;
    riskKeywords?: string[];
    confirmTimeoutSeconds?: number;
    busyGuard: boolean;
  }) {
    const transaction = this.deps.db.transaction((next: typeof input) => {
      if (next.busyGuard && this.deps.taskRepository.countActiveBySessionId(next.sessionId) > 0) {
        throw new AppError("SESSION_BUSY", 409, "Session is busy with an active task");
      }

      const now = new Date().toISOString();
      const existingSession = this.deps.toolSessionRepository.findBySessionId(next.sessionId);
      const riskPolicy = this.resolveRiskPolicy(next.riskKeywords, next.confirmTimeoutSeconds);
      const risk = evaluateRisk(next.prompt, riskPolicy.keywords);
      const taskStatus = risk.level === "high" ? "pending_confirm" : "running";
      const sessionStatus = risk.level === "high" ? "waiting_confirm" : "running";
      const taskId = randomUUID();
      const eventId = randomUUID();
      const toolSessionRef = this.resolveToolSessionRef(next.threadRef, existingSession?.toolSessionRef ?? null);

      this.deps.toolSessionRepository.upsert({
        sessionId: next.sessionId,
        toolProvider: (next.toolProvider || "").trim() || existingSession?.toolProvider || "codex",
        toolSessionRef,
        status: sessionStatus,
        createdBy: existingSession?.createdBy ?? next.createdBy ?? next.actorId,
        createdAt: existingSession?.createdAt ?? now,
        updatedAt: now
      });

      this.deps.taskRepository.create({
        taskId,
        sessionId: next.sessionId,
        triggerMessageId: eventId,
        taskType: next.taskType,
        status: taskStatus,
        summary: next.prompt,
        startedAt: now,
        finishedAt: null
      });

      this.deps.messageRepository.create({
        eventId,
        sessionId: next.sessionId,
        direction: "bot_to_tool",
        sourcePlatform: next.sourcePlatform,
        platformMessageId: next.platformMessageId,
        senderId: next.actorId,
        content: next.prompt,
        messageType: "command",
        riskLevel: risk.level,
        status: taskStatus,
        taskId,
        createdAt: now
      });

      this.deps.taskDispatchContextRepository.upsert({
        taskId,
        sessionId: next.sessionId,
        threadRef: next.threadRef,
        projectPath: next.projectPath,
        modelSlug: next.modelSlug,
        modelReasoningLevel: next.modelReasoningLevel,
        createdAt: now,
        updatedAt: now
      });

      if (risk.level === "high") {
        const expiredAt = new Date(Date.now() + riskPolicy.confirmTimeoutSeconds * 1000).toISOString();
        this.deps.riskConfirmationRepository.create({
          taskId,
          sessionId: next.sessionId,
          requestedBy: next.actorId,
          confirmationToken: randomUUID(),
          status: "pending",
          expiredAt,
          confirmedBy: null,
          confirmedAt: null
        });
      }

      return {
        taskId,
        eventId,
        sessionId: next.sessionId,
        riskLevel: risk.level as "high" | "low",
        pendingConfirmation: risk.level === "high",
        taskStatus,
        threadRef: next.threadRef,
        projectPath: next.projectPath,
        modelSlug: next.modelSlug,
        modelReasoningLevel: next.modelReasoningLevel
      };
    });

    return transaction.immediate(input);
  }
}

function normalizeNullable(value: string | null | undefined) {
  const normalized = String(value || "").trim();
  return normalized || null;
}
