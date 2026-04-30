#!/usr/bin/env node
/**
 * @description 全局安装后的 vible 网关 CLI 启动入口，转发到编译产物 server。
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-28 09:05
 */

const { existsSync } = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("viblect - Vible Coding Tool Gateway CLI");
  console.log("");
  console.log("Usage:");
  console.log("  viblect              Start gateway server");
  console.log("  viblect --help       Show this help message");
  console.log("");
  console.log("Environment:");
  console.log("  HOST                 Default 127.0.0.1");
  console.log("  PORT                 Default 3000");
  process.exit(0);
}

const serverEntry = path.resolve(__dirname, "..", "dist", "src", "server.js");

if (!existsSync(serverEntry)) {
  console.error("[vible-gateway] dist build is missing. Run `npm run build` before executing CLI.");
  process.exit(1);
}

require(serverEntry);
