const README_PANEL_ID = "readme-modal-root";
const README_MODAL_OPEN_CLASS = "is-open";

const PROGRESS_ITEMS = [
  "Task 1: Fastify + TypeScript 服务骨架（已完成）",
  "Task 2: SQLite 初始化与基础仓储层（已完成）"
];

const SETUP_STEPS = [
  "1) 复制环境变量文件：cp .env.example .env",
  "2) 安装依赖：npm install",
  "3) 启动服务：npm run dev",
  "4) 健康检查：http://127.0.0.1:3000/health"
];

const panelState = {
  loaded: false
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ensureRoot() {
  let root = document.getElementById(README_PANEL_ID);
  if (root) {
    return root;
  }

  root = document.createElement("section");
  root.id = README_PANEL_ID;
  root.className = "readme-modal-root";
  root.innerHTML = `
    <button type="button" class="readme-launcher" data-readme-open="true">项目进度与README</button>
    <div class="readme-modal-backdrop" data-readme-close="true">
      <div class="readme-modal-card" role="dialog" aria-modal="true" aria-label="项目进度与README" tabindex="-1">
        <div class="readme-modal-head">
          <h2>项目进度与文档</h2>
          <div class="readme-modal-head-actions">
            <button type="button" data-readme-refresh="true">刷新 README</button>
            <button type="button" data-readme-close="true">关闭</button>
          </div>
        </div>
        <div class="readme-grid">
          <div class="readme-block">
            <h3>当前进度</h3>
            <ul>
              ${PROGRESS_ITEMS.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ul>
          </div>
          <div class="readme-block">
            <h3>配置流程</h3>
            <ol>
              ${SETUP_STEPS.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ol>
          </div>
        </div>
        <div class="readme-doc">
          <div class="readme-doc-head">
            <strong>README.md</strong>
            <span data-readme-updated>更新时间：-</span>
          </div>
          <div class="readme-markdown" data-readme-content>点击“项目进度与README”后自动加载文档...</div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(root);
  bindEvents(root);
  return root;
}

function bindEvents(root) {
  root.querySelector("[data-readme-open='true']")?.addEventListener("click", () => {
    setOpen(true);
    if (!panelState.loaded) {
      void loadReadme();
    }
  });

  root.querySelectorAll("[data-readme-close='true']").forEach((node) => {
    node.addEventListener("click", (event) => {
      if (node.classList.contains("readme-modal-backdrop") && event.target !== node) {
        return;
      }
      setOpen(false);
    });
  });

  root.querySelector("[data-readme-refresh='true']")?.addEventListener("click", () => {
    void loadReadme();
  });
}

function setOpen(open) {
  const root = ensureRoot();
  root.classList.toggle(README_MODAL_OPEN_CLASS, open);
  if (!open) {
    return;
  }
  const card = root.querySelector(".readme-modal-card");
  if (card instanceof HTMLElement) {
    card.focus();
  }
}

async function loadReadme() {
  const root = ensureRoot();
  const contentNode = root.querySelector("[data-readme-content]");
  const updatedNode = root.querySelector("[data-readme-updated]");
  if (!(contentNode instanceof HTMLElement) || !(updatedNode instanceof HTMLElement)) {
    return;
  }

  contentNode.textContent = "正在加载 README 文档...";
  try {
    const response = await fetch("/api/dashboard/readme");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.message || "加载 README 失败");
    }

    contentNode.innerHTML = renderMarkdown(String(payload.content || ""));
    updatedNode.textContent = payload.updatedAt ? `更新时间：${payload.updatedAt}` : "更新时间：-";
    panelState.loaded = true;
  } catch (error) {
    contentNode.textContent = String(error?.message || "README 加载失败");
    updatedNode.textContent = "更新时间：-";
  }
}

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  const root = document.getElementById(README_PANEL_ID);
  if (!root?.classList.contains(README_MODAL_OPEN_CLASS)) {
    return;
  }
  setOpen(false);
});

window.addEventListener("hashchange", () => {
  setOpen(false);
});

ensureRoot();

function renderMarkdown(markdownText) {
  const text = String(markdownText || "").replace(/\r\n?/g, "\n");
  if (!text.trim()) {
    return "<p>README 内容为空。</p>";
  }

  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const language = line.replace(/^\s*```/, "").trim();
      i += 1;
      const codeLines = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }
      const code = escapeHtml(codeLines.join("\n"));
      const langClass = language ? ` class="lang-${escapeHtml(language)}"` : "";
      out.push(`<pre><code${langClass}>${code}</code></pre>`);
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(quoteLines.join("<br/>"))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      out.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      out.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ol>`);
      continue;
    }

    if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
      out.push("<hr/>");
      i += 1;
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const paragraphLines = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*---+\s*$/.test(lines[i]) &&
      !/^\s*\*\*\*+\s*$/.test(lines[i])
    ) {
      paragraphLines.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${renderInline(paragraphLines.join(" "))}</p>`);
  }

  return out.join("");
}

function renderInline(rawText) {
  let text = escapeHtml(String(rawText || ""));
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" />');
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>'
  );
  return text;
}
