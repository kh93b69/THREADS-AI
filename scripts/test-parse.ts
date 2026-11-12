/**
 * Тест Parser Service.
 *   npm run test:parse -- "нейросети для бизнеса" "автоматизация"
 *
 * Без APIFY_TOKEN в .env используется MockParser.
 */
import { ApifyParser } from "../src/services/parser/ApifyParser.js";
import { MockParser } from "../src/services/parser/MockParser.js";
import type { ThreadsParser } from "../src/services/parser/ThreadsParser.js";

const keywords = process.argv.slice(2);

async function main(): Promise<void> {
  const parser: ThreadsParser = process.env.APIFY_TOKEN ? new ApifyParser() : new MockParser();
  console.log(`Парсер: ${parser.name}`);

  const threads = await parser.searchByKeywords({
    keywords: keywords.length > 0 ? keywords : ["автоматизация бизнеса"],
    limitPerKeyword: 10,
    maxAgeDays: 7,
  });

  console.log(`Найдено тредов: ${threads.length}`);
  for (const thread of threads.slice(0, 10)) {
    console.log(`[${thread.likes}♥] @${thread.username}: ${thread.text.slice(0, 120)}`);
  }
}

main().catch((error: unknown) => {
  console.error("Ошибка:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
