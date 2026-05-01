#!/usr/bin/env node
/**
 * @description Verify runtime viability after protection by probing health endpoint and CLI help.
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-05-01 10:30
 */

const { spawn, spawnSync } = require("node:child_process");
const { request } = require("node:http");
const { once } = require("node:events");
const { createServer } = require("node:net");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function resolveVerifyPort(host) {
  if (process.env.VERIFY_PORT) {
    const fixed = Number(process.env.VERIFY_PORT);
    if (!Number.isInteger(fixed) || fixed < 1 || fixed > 65535) {
      throw new Error(`[verify:runtime] invalid VERIFY_PORT=${process.env.VERIFY_PORT}`);
    }
    return Promise.resolve(fixed);
  }

  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("[verify:runtime] failed to resolve available port")));
        return;
      }

      const freePort = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(freePort);
      });
    });
  });
}

async function stopChildProcess(child, timeoutMs) {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  try {
    await withTimeout(once(child, "exit"), timeoutMs, "[verify:runtime] child exit timeout");
  } catch (error) {
    child.kill("SIGKILL");
    await withTimeout(once(child, "exit"), 2000, "[verify:runtime] child force-kill timeout");
  }
}

function probeHealth(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`unexpected status=${res.statusCode || "unknown"}`));
      }
    });

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForHealth(url, maxWaitMs, child) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < maxWaitMs) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code=${child.exitCode}`);
    }

    try {
      await probeHealth(url, 1200);
      return;
    } catch (error) {
      lastError = error;
      await delay(400);
    }
  }

  throw lastError || new Error("health probe timeout");
}

async function verifyServer() {
  const host = "127.0.0.1";
  const port = await resolveVerifyPort(host);
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port)
    }
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    const next = stderr + String(chunk);
    stderr = next.length > 20000 ? next.slice(next.length - 20000) : next;
  });

  const healthUrl = `http://${host}:${port}/health`;

  try {
    await waitForHealth(healthUrl, 20000, child);
  } catch (error) {
    await stopChildProcess(child, 3000);
    throw new Error(`[verify:runtime] server health check failed: ${error.message}\n${stderr.trim()}`);
  }

  await stopChildProcess(child, 3000);
  console.log(`[verify:runtime] health check passed: ${healthUrl}`);
}

function verifyCli() {
  const result = spawnSync(process.execPath, ["bin/vible-gateway.js", "--help"], {
    stdio: "pipe",
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(`[verify:runtime] CLI check failed: status=${result.status}\n${result.stderr || ""}`);
  }

  if (!String(result.stdout || "").includes("Usage:")) {
    throw new Error("[verify:runtime] CLI output missing usage text");
  }

  console.log("[verify:runtime] CLI help check passed.");
}

async function main() {
  verifyCli();
  await verifyServer();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
