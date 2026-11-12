import { config } from "../../config/env.js";
import type { ParseOptions, ScrapedThread } from "../../types/index.js";
import { request } from "../../utils/http.js";
import { createLogger } from "../../utils/logger.js";
import { normalizeResults, type ThreadsParser } from "./ThreadsParser.js";

const log = createLogger("parser:apify");

const APIFY_BASE = "https://api.apify.com/v2";

/**
 * Parser Service на Apify.
 *
 * ЗАГЛУШКА: каркас запроса готов, но поля input/output у каждого актора свои.
 * Перед включением:
 *   1. Выбери актор в Apify Store (поиск по "threads scraper").
 *   2. Посмотри его input schema и перепиши buildActorInput().
 *   3. Посмотри формат dataset items и перепиши mapItem().
 * Официальный поиск Meta не используем — там жёсткие лимиты.
 */
export class ApifyParser implements ThreadsParser {
  readonly name = "apify";

  private readonly token: string;
  private readonly actorId: string;

  constructor(options?: { token?: string; actorId?: string }) {
    this.token = options?.token ?? config.apify.token;
    this.actorId = options?.actorId ?? config.apify.actorId;
  }

  async searchByKeywords(options: ParseOptions): Promise<ScrapedThread[]> {
    if (options.keywords.length === 0) {
      throw new Error("Нужен хотя бы один ключевой запрос.");
    }

    // В URL актора "/" заменяется на "~": apify/threads-scraper → apify~threads-scraper
    const actorPath = this.actorId.replace("/", "~");

    log.info("Запускаю актор Apify", { actorId: this.actorId, keywords: options.keywords });

    const items = await request<unknown[]>(
      `${APIFY_BASE}/acts/${actorPath}/run-sync-get-dataset-items`,
      {
        method: "POST",
        query: { token: this.token },
        body: this.buildActorInput(options),
        // Синхронный запуск актора — это минуты, а не секунды.
        timeoutMs: 300_000,
        retries: 0,
      },
    );

    log.info("Актор вернул элементы", { count: items.length });

    const mapped = items
      .map((item) => this.mapItem(item, options.keywords[0] ?? ""))
      .filter((item): item is ScrapedThread => item !== null);

    return normalizeResults(mapped, options);
  }

  /** TODO: привести к input schema выбранного актора. */
  private buildActorInput(options: ParseOptions): Record<string, unknown> {
    return {
      queries: options.keywords,
      resultsPerQuery: options.limitPerKeyword ?? 25,
      searchType: "posts",
    };
  }

  /** TODO: привести к формату dataset items выбранного актора. */
  private mapItem(item: unknown, matchedQuery: string): ScrapedThread | null {
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;

    const id = str(raw["id"]) ?? str(raw["postId"]) ?? str(raw["code"]);
    const text = str(raw["text"]) ?? str(raw["caption"]) ?? "";
    if (!id) return null;

    return {
      id,
      url: str(raw["url"]) ?? str(raw["permalink"]) ?? `https://www.threads.net/t/${id}`,
      username: str(raw["username"]) ?? str(raw["ownerUsername"]) ?? "unknown",
      text,
      likes: num(raw["likesCount"]) ?? num(raw["likes"]) ?? 0,
      replies: num(raw["repliesCount"]) ?? num(raw["replies"]) ?? 0,
      reposts: num(raw["repostsCount"]) ?? num(raw["reposts"]) ?? 0,
      postedAt: str(raw["timestamp"]) ?? str(raw["publishedAt"]) ?? null,
      matchedQuery: str(raw["searchQuery"]) ?? matchedQuery,
      raw,
    };
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
