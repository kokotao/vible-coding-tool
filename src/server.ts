import { buildApp } from "./app";
import { loadEnv } from "./config/env";

async function main() {
  const env = loadEnv();
  const app = buildApp({ env });

  try {
    await app.listen({
      host: env.host,
      port: env.port
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
