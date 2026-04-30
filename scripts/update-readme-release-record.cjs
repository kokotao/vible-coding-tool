#!/usr/bin/env node
/**
 * @description 发布后自动同步 README 发布记录表格，按版本写入 npm registry 发布时间并去重。
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-30 18:32
 */

const { execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const README_PATH = resolve(process.cwd(), "README.md");
const PACKAGE_JSON_PATH = resolve(process.cwd(), "package.json");
const NPM_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_NOTE = "发布记录待补充";
const REGISTRY_RETRY_TIMES = 10;
const REGISTRY_RETRY_INTERVAL_MS = 3000;

function readPackageMeta() {
  const raw = readFileSync(PACKAGE_JSON_PATH, "utf8");
  const pkg = JSON.parse(raw);
  if (!pkg?.name || !pkg?.version) {
    throw new Error("package.json 缺少 name/version");
  }
  return {
    name: String(pkg.name),
    version: String(pkg.version)
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryReadPublishTime(packageName, version) {
  try {
    const raw = execSync(`npm view ${packageName} time --json --registry=${NPM_REGISTRY}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const times = JSON.parse(raw);
    const publishedAt = times?.[version];
    return publishedAt ? String(publishedAt) : null;
  } catch {
    return null;
  }
}

function readPublishTime(packageName, version) {
  for (let attempt = 1; attempt <= REGISTRY_RETRY_TIMES; attempt += 1) {
    const publishedAt = tryReadPublishTime(packageName, version);
    if (publishedAt) {
      return {
        publishedAt,
        fromRegistry: true
      };
    }
    if (attempt < REGISTRY_RETRY_TIMES) {
      sleep(REGISTRY_RETRY_INTERVAL_MS);
    }
  }

  return {
    publishedAt: new Date().toISOString(),
    fromRegistry: false
  };
}

function findReleaseTableIndexes(lines) {
  const sectionTitleIndex = lines.findIndex((line) => line.trim() === "## 发布记录（npm）");
  if (sectionTitleIndex === -1) {
    throw new Error("README 未找到“发布记录（npm）”章节");
  }

  const tableHeaderIndex = lines.findIndex((line, index) => index > sectionTitleIndex && line.trim().startsWith("| 版本"));
  if (tableHeaderIndex === -1) {
    throw new Error("README 未找到发布记录表头");
  }

  const tableDividerIndex = tableHeaderIndex + 1;
  if (!lines[tableDividerIndex] || !lines[tableDividerIndex].trim().startsWith("|")) {
    throw new Error("README 发布记录表格格式异常（缺少分隔行）");
  }

  let tableEndIndex = tableDividerIndex + 1;
  while (tableEndIndex < lines.length && lines[tableEndIndex].trim().startsWith("|")) {
    tableEndIndex += 1;
  }

  return {
    sectionTitleIndex,
    tableHeaderIndex,
    tableDividerIndex,
    tableRowsStartIndex: tableDividerIndex + 1,
    tableEndIndex
  };
}

function safeExec(command) {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    return "";
  }
}

function normalizeGithubBase(originUrl) {
  const text = String(originUrl || "").trim();
  if (!text) {
    return "";
  }
  if (text.startsWith("git@github.com:")) {
    const repo = text.slice("git@github.com:".length).replace(/\.git$/i, "");
    return repo ? `https://github.com/${repo}` : "";
  }
  const httpsMatched = text.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/i);
  if (httpsMatched?.[1]) {
    return `https://github.com/${httpsMatched[1]}`;
  }
  return "";
}

function buildReleaseNoteFromGit() {
  const subject = safeExec("git log -1 --pretty=%s");
  const shortSha = safeExec("git log -1 --pretty=%h");
  const fullSha = safeExec("git log -1 --pretty=%H");
  if (!subject || !shortSha) {
    return DEFAULT_NOTE;
  }
  const originUrl = safeExec("git config --get remote.origin.url");
  const githubBase = normalizeGithubBase(originUrl);
  if (githubBase && fullSha) {
    return `[${shortSha}](${githubBase}/commit/${fullSha}) ${subject}`;
  }
  return `${shortSha} ${subject}`;
}

function parseVersionFromRow(row) {
  const cells = row
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  return cells[0] || "";
}

function upsertReleaseRow(lines, indexes, rowVersion, rowPublishedAt, rowNote) {
  const newRow = `| ${rowVersion} | ${rowPublishedAt} | ${rowNote} |`;
  const rows = lines.slice(indexes.tableRowsStartIndex, indexes.tableEndIndex);

  const filteredRows = [];
  let replaced = false;
  for (const row of rows) {
    if (parseVersionFromRow(row) === rowVersion) {
      if (!replaced) {
        filteredRows.push(newRow);
        replaced = true;
      }
      continue;
    }
    filteredRows.push(row);
  }

  if (!replaced) {
    filteredRows.unshift(newRow);
  }

  return [
    ...lines.slice(0, indexes.tableRowsStartIndex),
    ...filteredRows,
    ...lines.slice(indexes.tableEndIndex)
  ];
}

function removePendingVersionLine(lines, version) {
  const pendingPattern = new RegExp(`^\\s*-\\s*${version.replace(/\./g, "\\.")}\\b`);
  return lines.filter((line) => !pendingPattern.test(line));
}

function trimEmptyPendingSection(lines) {
  const titleIndex = lines.findIndex((line) => line.trim() === "待发布版本：");
  if (titleIndex === -1) {
    return lines;
  }
  let cursor = titleIndex + 1;
  while (cursor < lines.length && lines[cursor].trim() === "") {
    cursor += 1;
  }
  const hasPendingBullet = cursor < lines.length && /^\s*-\s+/.test(lines[cursor]);
  if (hasPendingBullet) {
    return lines;
  }
  return [...lines.slice(0, titleIndex), ...lines.slice(cursor)];
}

function main() {
  const { name, version } = readPackageMeta();
  const publishMeta = readPublishTime(name, version);
  const publishedAt = publishMeta.publishedAt;
  const note = publishMeta.fromRegistry
    ? buildReleaseNoteFromGit()
    : `${buildReleaseNoteFromGit()}（npm 发布时间待同步）`;

  const original = readFileSync(README_PATH, "utf8");
  const lines = original.split(/\r?\n/);
  const indexes = findReleaseTableIndexes(lines);
  const withRow = upsertReleaseRow(lines, indexes, version, publishedAt, note);
  const cleaned = removePendingVersionLine(withRow, version);
  const normalized = trimEmptyPendingSection(cleaned);
  const next = `${normalized.join("\n").trimEnd()}\n`;

  if (next === original) {
    console.log(`[release:record] README 发布记录已是最新：${name}@${version}`);
    return;
  }

  writeFileSync(README_PATH, next, "utf8");
  if (publishMeta.fromRegistry) {
    console.log(`[release:record] README 发布记录已更新：${name}@${version} -> ${publishedAt}`);
    return;
  }
  console.log(`[release:record] npm registry 延迟，先写入占位时间：${name}@${version} -> ${publishedAt}`);
}

main();
