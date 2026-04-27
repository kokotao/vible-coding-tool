/**
 * @description Codex 任务执行包装器，自动上报 running/succeeded/failed 事件到网关并触发飞书回推
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 18:16
 */
import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

type RunnerArgs = {
  sessionId: string;
  taskId?: string;
  gatewayUrl: string;
  title: string;
  command: string[];
  ingressToken?: string;
  signingSecret?: string;
};

type CodexEventPayload = {
  eventId: string;
  taskId?: string;
  sessionId: string;
  status: "running" | "succeeded" | "failed";
  summary: string;
  detail?: string;
  senderId: string;
  occurredAt: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await assertGatewayReady(args.gatewayUrl);

  const resolvedTaskId =
    args.taskId?.trim() || (await findLatestRunningTaskId(args.gatewayUrl, args.sessionId)) || undefined;
  if (resolvedTaskId) {
    console.log(`[codex-run] reuse taskId=${resolvedTaskId}`);
  } else {
    console.log("[codex-run] no running task found for session, gateway may create/attach one by sessionId");
  }

  await postEvent(args, {
    eventId: randomUUID(),
    taskId: resolvedTaskId,
    sessionId: args.sessionId,
    status: "running",
    summary: args.title,
    senderId: "codex_task_runner",
    occurredAt: new Date().toISOString()
  });

  const startedAt = Date.now();
  const result = await runCommand(args.command);
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const detail = sanitizeDetail(`${result.stdoutTail}\n${result.stderrTail}`.trim(), 1800);

  if (result.code === 0) {
    await postEvent(args, {
      eventId: randomUUID(),
      taskId: resolvedTaskId,
      sessionId: args.sessionId,
      status: "succeeded",
      summary: `任务完成：${args.title}（${elapsedSec}s）`,
      detail,
      senderId: "codex_task_runner",
      occurredAt: new Date().toISOString()
    });
    console.log(`[codex-run] command succeeded in ${elapsedSec}s`);
    return;
  }

  await postEvent(args, {
    eventId: randomUUID(),
    taskId: resolvedTaskId,
    sessionId: args.sessionId,
    status: "failed",
    summary: `任务失败：${args.title}（exit=${result.code}, ${elapsedSec}s）`,
    detail,
    senderId: "codex_task_runner",
    occurredAt: new Date().toISOString()
  });
  throw new Error(`[codex-run] command failed with exit code ${result.code}`);
}

function parseArgs(argv: string[]): RunnerArgs {
  const optionMap = new Map<string, string>();
  let separatorIndex = -1;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--") {
      separatorIndex = i;
      break;
    }
  }

  const optionTokens = separatorIndex >= 0 ? argv.slice(0, separatorIndex) : argv;
  const command = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : [];

  for (let i = 0; i < optionTokens.length; i += 1) {
    const token = optionTokens[i];
    if (!token.startsWith("--")) {
      throw new Error(`invalid option token: ${token}`);
    }

    const key = token.slice(2);
    const value = optionTokens[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for option --${key}`);
    }
    optionMap.set(key, value);
    i += 1;
  }

  const sessionId = (optionMap.get("session") || "").trim();
  if (!sessionId) {
    throw new Error("missing required option --session <sessionId>");
  }

  if (command.length === 0) {
    throw new Error("missing command, use '-- <command> [args...]'");
  }

  return {
    sessionId,
    taskId: optionMap.get("task"),
    gatewayUrl: (optionMap.get("gateway") || process.env.GATEWAY_URL || "http://127.0.0.1:3000").replace(/\/+$/, ""),
    title: optionMap.get("title") || command.join(" "),
    command,
    ingressToken: optionMap.get("token") || process.env.CODEX_INGRESS_TOKEN,
    signingSecret: optionMap.get("signingSecret") || process.env.CODEX_INGRESS_SIGNING_SECRET
  };
}

async function assertGatewayReady(gatewayUrl: string) {
  const response = await fetch(`${gatewayUrl}/health`);
  if (!response.ok) {
    throw new Error(`gateway health check failed: status=${response.status}`);
  }
}

async function findLatestRunningTaskId(gatewayUrl: string, sessionId: string) {
  const response = await fetch(`${gatewayUrl}/api/codex/tasks?statuses=running&limit=200`);
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    items?: Array<{ taskId?: string; sessionId?: string }>;
  };
  const matched = (payload.items || []).find((item) => item.sessionId === sessionId && item.taskId);
  return matched?.taskId || null;
}

async function postEvent(args: RunnerArgs, payload: CodexEventPayload) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (args.ingressToken) {
    headers["x-codex-ingress-token"] = args.ingressToken;
  }
  if (args.signingSecret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID().replaceAll("-", "");
    const signature = createHmac("sha256", args.signingSecret)
      .update(`${timestamp}.${nonce}.${body}`)
      .digest("hex");
    headers["x-codex-ingress-timestamp"] = timestamp;
    headers["x-codex-ingress-nonce"] = nonce;
    headers["x-codex-ingress-signature"] = signature;
  }

  const response = await fetch(`${args.gatewayUrl}/api/codex/events`, {
    method: "POST",
    headers,
    body
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`event post failed: status=${response.status}, body=${responseText}`);
  }

  console.log(`[codex-run] event posted status=${payload.status} body=${responseText}`);
}

async function runCommand(command: string[]) {
  const [bin, ...args] = command;
  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    cwd: process.cwd()
  });

  let stdoutTail = "";
  let stderrTail = "";
  const tailLimit = 4000;

  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    process.stdout.write(text);
    stdoutTail = `${stdoutTail}${text}`.slice(-tailLimit);
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    process.stderr.write(text);
    stderrTail = `${stderrTail}${text}`.slice(-tailLimit);
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
  });

  return {
    code,
    stdoutTail,
    stderrTail
  };
}

function sanitizeDetail(value: string, maxLength: number) {
  const cleaned = value.replace(/\u0000/g, "").trim();
  if (!cleaned) {
    return "";
  }

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return cleaned.slice(0, maxLength);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
