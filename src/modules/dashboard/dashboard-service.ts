import { ConnectorService } from "../connectors/connector-service";
import { deriveTaskTitle, startOfTodayIso, summarizeText } from "../common/display";
import { MessageRepository } from "../../storage/repositories/message-repository";
import { RiskConfirmationRepository } from "../../storage/repositories/risk-confirmation-repository";
import { TaskRepository } from "../../storage/repositories/task-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";

export type DashboardServiceDeps = {
  taskRepository: TaskRepository;
  messageRepository: MessageRepository;
  riskConfirmationRepository: RiskConfirmationRepository;
  toolSessionRepository: ToolSessionRepository;
  connectorService: ConnectorService;
};

export class DashboardService {
  constructor(private readonly deps: DashboardServiceDeps) {}

  getSummary() {
    const tasks = this.deps.taskRepository.listRecent(8);
    const sessions = this.deps.toolSessionRepository.listActive(8);
    const pendingRisks = this.deps.riskConfirmationRepository.listPending(6);

    return {
      summary: {
        runningTaskCount: this.deps.taskRepository.countByStatus("running"),
        pendingRiskCount: this.deps.riskConfirmationRepository.countPending(),
        activeSessionCount: this.deps.toolSessionRepository.countActive(),
        failedTaskCountToday: this.deps.taskRepository.countFailedSince(startOfTodayIso())
      },
      taskTimeline: tasks.map((task) => {
        const messages = this.deps.messageRepository.listByTaskId(task.taskId);
        const latestMessage = messages.at(-1);
        const taskTitle = deriveTaskTitle(task, messages);

        return {
          taskId: task.taskId,
          sessionId: task.sessionId,
          taskTitle,
          status: task.status,
          summary: summarizeText(task.summary ?? latestMessage?.content ?? taskTitle ?? "No summary"),
          sourcePlatform: latestMessage?.sourcePlatform ?? "feishu",
          toolProvider: "codex",
          updatedAt: latestMessage?.createdAt ?? task.finishedAt ?? task.startedAt,
          canStop: task.status === "running",
          canConfirm: task.status === "pending_confirm"
        };
      }),
      activeSessions: sessions.map((session) => {
        const sessionTasks = this.deps.taskRepository.findManyBySessionId(session.sessionId, 1);
        const latestTask = sessionTasks[0];
        const latestMessage = this.deps.messageRepository.findLatestBySessionId(session.sessionId);
        const taskMessages = latestTask ? this.deps.messageRepository.listByTaskId(latestTask.taskId) : [];

        return {
          sessionId: session.sessionId,
          taskTitle: latestTask ? deriveTaskTitle(latestTask, taskMessages) : null,
          status: session.status,
          lastMessageSummary: summarizeText(latestMessage?.content ?? latestTask?.summary ?? ""),
          updatedAt: latestMessage?.createdAt ?? latestTask?.finishedAt ?? latestTask?.startedAt ?? session.updatedAt
        };
      }),
      pendingRisks: pendingRisks.map((risk) => {
        const task = this.deps.taskRepository.findByTaskId(risk.taskId);
        const taskMessages = task ? this.deps.messageRepository.listByTaskId(task.taskId) : [];

        return {
          taskId: risk.taskId,
          sessionId: risk.sessionId,
          confirmationToken: risk.confirmationToken,
          taskTitle: task ? deriveTaskTitle(task, taskMessages) : null,
          riskReason: task?.summary ?? "High risk confirmation required",
          requestedBy: risk.requestedBy,
          expiredAt: risk.expiredAt,
          canApprove: true,
          canReject: true
        };
      }),
      connectors: this.deps.connectorService.listSummaries()
    };
  }
}
