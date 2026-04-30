#!/usr/bin/env node
/**
 * @description 删除 dist 目录下的 source map 文件，避免发布包暴露源码映射
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-30 18:36
 */

const { readdirSync, rmSync, statSync } = require("node:fs");
const { join } = require("node:path");

function walk(dir, collector) {
  const entries = readdirSync(dir);
  for (const name of entries) {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, collector);
      continue;
    }
    if (fullPath.endsWith(".map")) {
      collector.push(fullPath);
    }
  }
}

function main() {
  const targetRoot = "dist";
  const sourceMaps = [];

  try {
    walk(targetRoot, sourceMaps);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      console.log("[build:clean-maps] dist directory not found, skip.");
      return;
    }
    throw error;
  }

  for (const filePath of sourceMaps) {
    rmSync(filePath, { force: true });
  }

  console.log(`[build:clean-maps] removed ${sourceMaps.length} source map file(s).`);
}

main();
