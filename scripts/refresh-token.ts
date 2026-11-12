/**
 * Продление long-lived токена. Повесь на крон раз в 50 дней:
 *   npm run test:token
 */
import { TokenManager } from "../src/services/poster/TokenManager.js";
import { config } from "../src/config/env.js";

async function main(): Promise<void> {
  const manager = new TokenManager();
  const stored = await manager.load();
  const record = await manager.refresh(stored?.accessToken ?? config.threads.accessToken);

  console.log("Новый токен действует до:", record.expiresAt);
  console.log("Сохранён в .tokens.json. Не забудь обновить THREADS_ACCESS_TOKEN в проде.");
}

main().catch((error: unknown) => {
  console.error("Ошибка:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
