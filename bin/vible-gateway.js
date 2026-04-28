#!/usr/bin/env node
/**
 * @description 全局安装后的 vible 网关 CLI 启动入口，转发到编译产物 server。
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-28 09:05
 */

const { existsSync } = require("node:fs");
const path = require("node:path");

const serverEntry = path.resolve(__dirname, "..", "dist", "src", "server.js");

if (!existsSync(serverEntry)) {
  console.error("[vible-gateway] dist build is missing. Run `npm run build` before executing CLI.");
  process.exit(1);
}

require(serverEntry);
