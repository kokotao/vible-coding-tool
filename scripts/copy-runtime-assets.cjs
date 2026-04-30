#!/usr/bin/env node
/**
 * @description 复制运行时必需的非 TS 资源（如 SQL 迁移）到 dist 目录
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-30 18:40
 */

const { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } = require("node:fs");
const { dirname, join, relative } = require("node:path");

function copyDir(fromDir, toDir) {
  if (!existsSync(fromDir)) {
    return 0;
  }

  const entries = readdirSync(fromDir);
  let copied = 0;

  for (const entry of entries) {
    const fromPath = join(fromDir, entry);
    const toPath = join(toDir, entry);
    const stat = statSync(fromPath);

    if (stat.isDirectory()) {
      copied += copyDir(fromPath, toPath);
      continue;
    }

    mkdirSync(dirname(toPath), { recursive: true });
    copyFileSync(fromPath, toPath);
    copied += 1;
  }

  return copied;
}

function main() {
  const fromRoot = join("src", "storage", "migrations");
  const toRoot = join("dist", "src", "storage", "migrations");
  const count = copyDir(fromRoot, toRoot);
  const target = relative(process.cwd(), toRoot) || toRoot;
  console.log(`[build:copy-assets] copied ${count} file(s) to ${target}`);
}

main();
