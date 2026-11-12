import { ContentGenerator } from "./services/llm/ContentGenerator.js";
import { ApifyParser } from "./services/parser/ApifyParser.js";
import { MockParser } from "./services/parser/MockParser.js";
import type { ThreadsParser } from "./services/parser/ThreadsParser.js";
import { ThreadsPoster } from "./services/poster/ThreadsPoster.js";
import { TokenManager } from "./services/poster/TokenManager.js";

export { ContentGenerator, ApifyParser, MockParser, ThreadsPoster, TokenManager };
export type { ThreadsParser };
export * from "./types/index.js";

/**
 * Сквозной сценарий: сгенерировать текст → опубликовать в Threads.
 * Запуск: npm run dev
 */
async function main(): Promise<void> {
  const generator = new ContentGenerator();
  const text = await generator.generatePost({
    topic: "почему 90% автоматизаций в малом бизнесе умирают через месяц",
    tone: "жёстко по делу, от практика",
  });

  console.log("\n--- Сгенерированный пост ---\n" + text + "\n----------------------------\n");

  const poster = ThreadsPoster.fromEnv();
  const result = await poster.publish({ text });

  console.log("Опубликовано:", result);
}

// Запускаем main только при прямом вызове файла, не при импорте как модуля.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((error: unknown) => {
    console.error("Ошибка:", ThreadsPoster.explainError(error));
    process.exitCode = 1;
  });
}
