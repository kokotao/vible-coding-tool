#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";

const command = isWindows ? "powershell.exe" : "bash";
const args = isWindows
  ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "install.ps1")]
  : [path.join(__dirname, "install.sh")];

const result = spawnSync(command, args, {
  cwd: projectRoot,
  stdio: "inherit",
  shell: false
});

if (result.error) {
  console.error(`[install:check] failed to execute ${command}:`, result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
