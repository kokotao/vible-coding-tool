/**
 * @description 解析飞书文本消息中的 #session 指令与命令正文
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 09:26
 */
import { AppError } from "../../lib/errors";
import { parseFeishuPanelCommand } from "./feishu-command-panel";

export type ParsedCommand = {
  sessionId: string | null;
  prompt: string;
  threadAlias: string | null;
  threadSelector: string | null;
  sourcePlatform: "feishu";
  senderId: string;
  platformMessageId: string | null;
};

export type ParsedIdentityBindingCommand = {
  displayName: string;
  targetOpenId: string | null;
};

export type FeishuCommandHelpReason =
  | "ambiguous_command"
  | "session_required"
  | "thread_not_found"
  | "thread_selector_ambiguous";

export type FeishuCommandHelpItem = {
  title: string;
  syntax: string;
  description: string;
  example: string;
};

type FeishuCommandHelpCardTemplate = {
  title: string;
  template: "blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red" | "carmine" | "violet" | "purple" | "indigo" | "grey";
  intro: string;
};

const SESSION_PATTERN = /#session:([a-zA-Z0-9_-]+)/;
const THREAD_ID_PATTERN = /线程\s*ID[：:]\s*([^\n，,]+)/i;
const THREAD_TAG_PATTERN = /#thread:([a-zA-Z0-9_-]+)/;
const TASK_CONTENT_PATTERN = /任务内容[：:]\s*([\s\S]+)/;
const IDENTITY_BIND_TARGET_PATTERN =
  /(?:^|[\s,，;；])(?:触发方|open[_\s-]?id|openId)\s*[:：=]?\s*(ou_[a-zA-Z0-9_-]+)/i;
const IDENTITY_BIND_NAME_PATTERN =
  /(?:^|[\s,，;；])(?:绑定姓名|绑定名称|绑定昵称|姓名绑定|姓名|name)\s*[:：=]?\s*([\s\S]+?)$/i;

export const FEISHU_COMMAND_HELP_ITEMS: FeishuCommandHelpItem[] = [
  {
    title: "会话指令",
    syntax: "#session:<id> <任务>",
    description: "显式指定会话后再下发任务，适合新会话或需要固定路由的场景",
    example: "#session:feishu-codex-demo 修复登录接口 500"
  },
  {
    title: "线程定向",
    syntax: "线程 ID：<线程标识>，任务内容：<任务>",
    description: "把任务直接送到指定 Codex 线程，支持完整 UUID、简写前缀或 rollout 文件名",
    example: "线程 ID：019dca61-0d90-7f01-b1b0-f1bb79eb955e，任务内容：完成我所说的需求进行下一步"
  },
  {
    title: "项目列表",
    syntax: "查看项目",
    description: "列出当前本机 Codex session 中的项目卡片，点击后进入对应项目的 session 列表",
    example: "查看项目"
  },
  {
    title: "选择项目",
    syntax: "选择项目：<项目名或路径>",
    description: "从项目列表中锁定当前项目，后续可继续选择 session",
    example: "选择项目：vible-coding-Tool"
  },
  {
    title: "Session 列表",
    syntax: "查看 session",
    description: "展示当前项目下的 session 列表，点击即可锁定目标 thread",
    example: "查看 session"
  },
  {
    title: "当前项目会话",
    syntax: "查看当前项目session",
    description: "基于当前已选择项目直接刷新 session 列表，便于快速切换会话",
    example: "查看当前项目session"
  },
  {
    title: "选择 Session",
    syntax: "选择 session：<threadId>",
    description: "锁定一个具体 Codex thread，后续直接发送任务内容即可执行",
    example: "选择 session：019dca61-0d90-7f01-b1b0-f1bb79eb955e"
  },
  {
    title: "模型列表",
    syntax: "查看模型列表",
    description: "通过 Codex CLI 读取当前可用模型目录并展示卡片",
    example: "查看模型列表"
  },
  {
    title: "选择模型",
    syntax: "选择模型：<modelId>",
    description: "把选中的模型写入当前飞书上下文，后续任务自动使用",
    example: "选择模型：gpt-5.4"
  },
  {
    title: "网关状态",
    syntax: "查看网关状态",
    description: "查看 Codex 回推、session 扫描、自动执行和当前选择状态",
    example: "查看网关状态"
  },
  {
    title: "姓名绑定",
    syntax: "绑定姓名：<姓名>",
    description: "绑定当前 open_id 的显示名，也支持加触发方或 open_id 目标",
    example: "@机器人 绑定姓名:TauChun 触发方:ou_target_bind"
  }
];

export function buildFeishuCommandHelpText(reason: FeishuCommandHelpReason = "ambiguous_command") {
  const reasonIntro: Record<FeishuCommandHelpReason, string> = {
    ambiguous_command: "指令不明确，未创建任务。",
    session_required: "未找到可复用会话，请先显式指定 session。",
    thread_not_found: "未找到目标线程，请确认线程标识是否正确。",
    thread_selector_ambiguous: "线程标识匹配到多个结果，请改用完整 UUID。"
  };

  return [
    reasonIntro[reason],
    "请使用以下任一格式：",
    ...FEISHU_COMMAND_HELP_ITEMS.map((item, index) => `${index + 1}. ${item.syntax} - ${item.description}`),
    "如果你想继续已有会话，也请直接带上 #session:<id>。",
    "如果你想用连续选择流程，先 `查看项目`，再 `选择项目`，再 `选择 session`，最后直接发送任务内容。",
    "如果你只是想绑定姓名，可以直接发：绑定姓名：张三"
  ].join("\n");
}

export function buildFeishuCommandHelpPayload(reason: FeishuCommandHelpReason = "ambiguous_command") {
  return {
    title: "飞书指令速查",
    reason,
    commands: FEISHU_COMMAND_HELP_ITEMS
  };
}

export function buildFeishuCommandHelpCard(reason: FeishuCommandHelpReason = "ambiguous_command") {
  const template = resolveFeishuCommandHelpCardTemplate(reason);
  const commandList = FEISHU_COMMAND_HELP_ITEMS.map(
    (item, index) => `${index + 1}. ${item.title}\n格式：${item.syntax}\n说明：${item.description}\n示例：${item.example}`
  ).join("\n\n");

  return JSON.stringify({
    config: {
      wide_screen_mode: true,
      enable_forward: true
    },
    header: {
      template: template.template,
      title: {
        tag: "plain_text",
        content: template.title
      }
    },
    elements: [
      {
        tag: "markdown",
        content: `【拦截结果】\n${template.intro}\n\n这条消息暂未进入 Codex 执行链路。`
      },
      {
        tag: "hr"
      },
      {
        tag: "markdown",
        content: `【支持的指令格式】\n\n${commandList}`
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "继续已有会话时可以直接复用最近会话；如果你要指定线程，请尽量使用完整 UUID。"
          }
        ]
      }
    ]
  });
}

export function isExplicitFeishuCommand(text: string) {
  const rawText = (text || "").trim();
  if (!rawText) {
    return false;
  }

  return Boolean(
    parseFeishuIdentityBindingCommand(rawText) ||
      parseFeishuPanelCommand(rawText) ||
      rawText.match(SESSION_PATTERN) ||
      rawText.match(THREAD_ID_PATTERN) ||
      rawText.match(THREAD_TAG_PATTERN)
  );
}

export function parseFeishuCommand(input: {
  text: string;
  senderId: string;
  messageId?: string | null;
}): ParsedCommand {
  const rawText = (input.text || "").trim();
  const sessionMatched = rawText.match(SESSION_PATTERN);
  const threadIdMatched = rawText.match(THREAD_ID_PATTERN);
  const threadTagMatched = rawText.match(THREAD_TAG_PATTERN);
  const taskContentMatched = rawText.match(TASK_CONTENT_PATTERN);

  let prompt = taskContentMatched?.[1]?.trim() || "";
  if (!prompt) {
    prompt = rawText;
    if (sessionMatched) {
      prompt = prompt.replace(sessionMatched[0], "").trim();
    }
    if (threadTagMatched) {
      prompt = prompt.replace(threadTagMatched[0], "").trim();
    }
    if (threadIdMatched) {
      prompt = prompt.replace(threadIdMatched[0], "").trim();
    }
  }

  if (!prompt) {
    throw new AppError("EMPTY_COMMAND", 400, "Command content is empty");
  }

  const threadAlias = null;
  const rawSelector = (threadTagMatched?.[1] || threadIdMatched?.[1] || "").trim();
  const threadSelector = rawSelector.replace(/[；;。]+$/g, "").trim() || null;

  return {
    sessionId: sessionMatched?.[1] || null,
    prompt,
    threadAlias,
    threadSelector,
    sourcePlatform: "feishu",
    senderId: input.senderId,
    platformMessageId: input.messageId ?? null
  };
}

export function parseFeishuIdentityBindingCommand(text: string): ParsedIdentityBindingCommand | null {
  const rawText = stripFeishuMentionPrefix((text || "").trim());
  if (!rawText) {
    return null;
  }

  const targetOpenId = rawText.match(IDENTITY_BIND_TARGET_PATTERN)?.[1]?.trim() || null;
  const nameSource = targetOpenId ? rawText.replace(IDENTITY_BIND_TARGET_PATTERN, "").trim() : rawText;
  const matched = nameSource.match(IDENTITY_BIND_NAME_PATTERN);

  if (!matched) {
    return null;
  }

  const displayName = cleanupBindingDisplayName(matched[1] || "");
  if (!displayName) {
    return null;
  }

  return {
    displayName,
    targetOpenId
  };
}

function stripFeishuMentionPrefix(text: string) {
  return text.replace(/^(?:@\S+\s*)+/, "").trim();
}

function cleanupBindingDisplayName(value: string) {
  return value
    .replace(/\s*(?:触发方|open[_\s-]?id|openId)\s*[:：=]?\s*(ou_[a-zA-Z0-9_-]+)\s*$/i, "")
    .trim();
}

function resolveFeishuCommandHelpCardTemplate(reason: FeishuCommandHelpReason): FeishuCommandHelpCardTemplate {
  if (reason === "session_required") {
    return {
      title: "会话未指定",
      template: "orange",
      intro: "当前消息没有可复用会话，网关需要你先显式指定 session。"
    };
  }

  if (reason === "thread_not_found") {
    return {
      title: "线程未找到",
      template: "yellow",
      intro: "这条消息带了线程信息，但当前没有匹配到可用线程。"
    };
  }

  if (reason === "thread_selector_ambiguous") {
    return {
      title: "线程匹配歧义",
      template: "red",
      intro: "线程标识匹配到了多个结果，请换成更精确的完整 UUID。"
    };
  }

  return {
    title: "指令不明确",
    template: "blue",
    intro: "当前消息没有明确命中支持的飞书指令格式。"
  };
}
