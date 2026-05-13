/**
 * @description Web 本地会话聊天发送服务，负责校验本地线程并复用统一命令入站服务派发到 Codex
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-05-06 21:30
 */
import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors";
import { CommandIntakeService } from "../commands/command-intake-service";
import { MessageRepository } from "../../storage/repositories/message-repository";
import { TaskRepository } from "../../storage/repositories/task-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";
import { CodexLocalSessionService } from "./codex-local-session-service";

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CodexWebChatServiceDeps = {
  taskRepository: TaskRepository;
  messageRepository: MessageRepository;
  toolSessionRepository: ToolSessionRepository;
  commandIntakeService: CommandIntakeService;
  codexLocalSessionService?: CodexLocalSessionService;
};

type SendToLocalSessionInput = {
  threadId: string;
  prompt: string;
  actorId?: string;
  sourcePlatform?: string;
};

export class CodexWebChatService {
  constructor(private readonly deps: CodexWebChatServiceDeps) {}

  sendToLocalSession(input: SendToLocalSessionInput) {
    const threadId = String(input.threadId || "").trim();
    const prompt = String(input.prompt || "").trim();
    if (!threadId) {
      throw new AppError("THREAD_ID_REQUIRED", 400, "threadId is required");
    }
    if (!THREAD_ID_PATTERN.test(threadId)) {
      throw new AppError("INVALID_THREAD_ID", 400, "threadId must be a valid UUID");
    }
    if (!prompt) {
      throw new AppError("PROMPT_REQUIRED", 400, "prompt is required");
    }

    const actorId = (input.actorId || "").trim() || "web_console";
    const sourcePlatform = (input.sourcePlatform || "").trim() || "web_console";
    const existingSession = this.deps.toolSessionRepository.findBySessionId(threadId);
    const localSession = this.resolveLocalSession(threadId);
    if (!existingSession && !localSession) {
      throw new AppError("LOCAL_SESSION_NOT_FOUND", 404, `Local session ${threadId} not found`);
    }
    const result = this.deps.commandIntakeService.acceptCommand({
      sessionId: threadId,
      actorId,
      sourcePlatform,
      prompt,
      taskType: "web_local_session_chat",
      threadRef: threadId,
      projectPath: this.resolveProjectPath(localSession?.projectPath ?? null),
      busyGuard: true,
      createdBy: existingSession?.createdBy ?? actorId
    });

    const dispatch = result.dispatch;
    if (!dispatch.accepted) {
      if (result.pendingConfirmation) {
        return {
          accepted: true,
          taskId: result.taskId,
          sessionId: threadId,
          threadRef: dispatch.threadRef,
          command: dispatch.command,
          riskLevel: result.riskLevel,
          pendingConfirmation: true
        };
      }
      const failureTime = new Date().toISOString();
      this.deps.taskRepository.updateStatus(result.taskId, "failed", failureTime);
      this.deps.toolSessionRepository.updateStatus(threadId, "paused", failureTime);
      this.deps.messageRepository.create({
        eventId: randomUUID(),
        sessionId: threadId,
        direction: "tool_to_bot",
        sourcePlatform: sourcePlatform,
        platformMessageId: null,
        senderId: "codex_dispatcher",
        content: `Web dispatch failed: ${dispatch.reason || "unknown"}`,
        messageType: "tool_event",
        riskLevel: "low",
        status: "failed",
        taskId: result.taskId,
        createdAt: failureTime
      });
      throw new AppError("DISPATCH_FAILED", 409, `Dispatch failed: ${dispatch.reason || "unknown"}`);
    }

    return {
      accepted: true,
      taskId: result.taskId,
      sessionId: threadId,
      threadRef: dispatch.threadRef,
      command: dispatch.command,
      riskLevel: result.riskLevel,
      pendingConfirmation: false
    };
  }

  private resolveLocalSession(threadId: string) {
    if (!this.deps.codexLocalSessionService) {
      return null;
    }
    try {
      return this.deps.codexLocalSessionService.getSessionDetail({
        threadId,
        refresh: false
      });
    } catch {
      return null;
    }
  }

  private resolveProjectPath(localProjectPath: string | null) {
    return String(localProjectPath || "").trim() || null;
  }
}
