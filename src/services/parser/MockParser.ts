import type { ParseOptions, ScrapedThread } from "../../types/index.js";
import { normalizeResults, type ThreadsParser } from "./ThreadsParser.js";

/** Фейковый парсер: гоняем пайплайн без Apify и без расхода кредитов. */
export class MockParser implements ThreadsParser {
  readonly name = "mock";

  async searchByKeywords(options: ParseOptions): Promise<ScrapedThread[]> {
    const limit = options.limitPerKeyword ?? 3;

    const threads = options.keywords.flatMap((keyword, qIndex) =>
      Array.from({ length: limit }, (_, i) => ({
        id: `mock-${qIndex}-${i}`,
        url: `https://www.threads.net/t/mock-${qIndex}-${i}`,
        username: `author_${qIndex}${i}`,
        text: `Тестовый тред про «${keyword}» №${i + 1}.`,
        likes: (i + 1) * 37,
        replies: (i + 1) * 4,
        reposts: i,
        postedAt: new Date(Date.now() - i * 3_600_000).toISOString(),
        matchedQuery: keyword,
      })),
    );

    return normalizeResults(threads, options);
  }
}
