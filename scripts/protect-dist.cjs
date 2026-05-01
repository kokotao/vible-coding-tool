#!/usr/bin/env node
/**
 * @description Obfuscate compiled dist/src JavaScript files to raise reverse engineering cost.
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-05-01 10:30
 */

const { readdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const JavaScriptObfuscator = require("javascript-obfuscator");

function walkJsFiles(rootDir, collector) {
  const entries = readdirSync(rootDir);
  for (const name of entries) {
    const fullPath = join(rootDir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkJsFiles(fullPath, collector);
      continue;
    }
    if (fullPath.endsWith(".js")) {
      collector.push(fullPath);
    }
  }
}

function resolveOptions() {
  const level = String(process.env.PROTECT_LEVEL || "strong").toLowerCase();
  const common = {
    compact: true,
    target: "node",
    sourceMap: false,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    ignoreRequireImports: true,
    stringArray: true,
    stringArrayThreshold: 0.8,
    transformObjectKeys: false
  };

  if (level === "strong") {
    return {
      ...common,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.35,
      deadCodeInjection: false,
      splitStrings: true,
      splitStringsChunkLength: 8
    };
  }

  return {
    ...common,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    splitStrings: false
  };
}

function main() {
  if (String(process.env.PROTECT_ENABLED || "true").toLowerCase() === "false") {
    console.log("[build:protect] skipped by PROTECT_ENABLED=false");
    return;
  }

  const targetRoot = join("dist", "src");
  const files = [];

  try {
    walkJsFiles(targetRoot, files);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      console.log("[build:protect] dist/src not found, skip.");
      return;
    }
    throw error;
  }

  const startedAt = Date.now();
  const options = resolveOptions();

  for (const filePath of files) {
    const source = readFileSync(filePath, "utf8");
    const result = JavaScriptObfuscator.obfuscate(source, options).getObfuscatedCode();
    writeFileSync(filePath, result, "utf8");
  }

  const elapsed = Date.now() - startedAt;
  console.log(`[build:protect] obfuscated ${files.length} file(s) in ${elapsed}ms. level=${String(process.env.PROTECT_LEVEL || "strong")}`);
}

main();
