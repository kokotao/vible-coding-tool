#!/usr/bin/env node
/**
 * @description 发布前检查 npm 打包清单，阻止 .env、data、tests、docs 等敏感或非发布文件进入制品。
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-28 09:26
 */

const { execSync } = require("node:child_process");

function parsePackJson(raw) {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");

  if (start < 0 || end < 0 || end < start) {
    throw new Error("cannot parse `npm pack --dry-run --json` output");
  }

  return JSON.parse(raw.slice(start, end + 1));
}

function main() {
  const output = execSync("npm pack --dry-run --json", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const parsed = parsePackJson(output);
  const files = parsed[0]?.files?.map((entry) => entry.path) ?? [];

  const blockedPatterns = [
    /^\.env($|\.)/i,
    /^data\//i,
    /^docs\//i,
    /^tests?\//i,
    /^src\//i,
    /^scripts\//i,
    /^\.playwright-mcp\//i,
    /^\.superpowers\//i
  ];

  const blockedFiles = files.filter((filePath) => blockedPatterns.some((pattern) => pattern.test(filePath)));

  if (blockedFiles.length > 0) {
    console.error("[publish:check] blocked files found in package:");
    for (const filePath of blockedFiles) {
      console.error(`  - ${filePath}`);
    }
    process.exit(1);
  }

  console.log(`[publish:check] package scan passed. fileCount=${files.length}`);
}

main();
