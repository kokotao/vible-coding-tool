/**
 * @description 终端事件流输出工具，提供彩色日志与关键链路简报
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-28 11:28
 */

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  green: "\x1b[32m"
} as const;

type FeishuCommandDigest = {
  senderId: string;
  sessionId: string;
  threadRef: string | null;
  prompt: string;
  modelSlug: string | null;
};

type CodexCompletionDigest = {
  status: "succeeded" | "failed";
  taskId: string;
  sessionId: string;
  threadRef: string | null;
  summary: string;
};

export class TerminalEventStream {
  info(label: string, detail: string) {
    this.print("stdout", "cyan", "INFO", label, detail);
  }

  warn(label: string, detail: string) {
    this.print("stdout", "yellow", "WARN", label, detail);
  }

  error(label: string, error: unknown) {
    const detail = normalizeError(error);
    this.print("stderr", "red", "ERROR", label, detail);
  }

  feishuCommandReceived(input: FeishuCommandDigest) {
    const detail = [
      `sender=${shorten(input.senderId, 24)}`,
      `session=${shorten(input.sessionId, 28)}`,
      `thread=${input.threadRef ? shorten(input.threadRef, 18) : "-"}`,
      `model=${input.modelSlug || "default"}`,
      `task=${shorten(input.prompt, 56)}`
    ].join(" | ");
    this.print("stdout", "cyan", "FEISHU", "指令入站", detail);
  }

  codexTaskCompleted(input: CodexCompletionDigest) {
    const color = input.status === "succeeded" ? "green" : "red";
    const label = input.status === "succeeded" ? "完成" : "失败";
    const detail = [
      `task=${shorten(input.taskId, 18)}`,
      `session=${shorten(input.sessionId, 24)}`,
      `thread=${input.threadRef ? shorten(input.threadRef, 18) : "-"}`,
      `summary=${shorten(input.summary, 72)}`
    ].join(" | ");
    this.print("stdout", color, "CODEX", label, detail);
  }

  private print(
    channel: "stdout" | "stderr",
    color: "red" | "yellow" | "cyan" | "green",
    scope: string,
    label: string,
    detail: string
  ) {
    const timestamp = formatClock(new Date());
    const line = `[${timestamp}] [${scope}] ${label} | ${singleLine(detail)}`;
    const stream = channel === "stderr" ? process.stderr : process.stdout;
    if (stream.isTTY) {
      stream.write(`${ANSI[color]}${line}${ANSI.reset}\n`);
      return;
    }
    stream.write(`${line}\n`);
  }
}

export function createTerminalEventStream() {
  return new TerminalEventStream();
}

function shorten(value: string, limit: number) {
  const normalized = singleLine(value);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function singleLine(value: string) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return singleLine(`${error.name}: ${error.message}`);
  }
  return singleLine(String(error));
}

function formatClock(date: Date) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
