import type { ParseOptions, ScrapedThread } from "../../types/index.js";

/**
 * Контракт Parser Service. Реализации взаимозаменяемы (Apify, Data365, mock),
 * остальное приложение знает только про этот интерфейс и ScrapedThread.
 */
export interface ThreadsParser {
  readonly name: string;
  searchByKeywords(options: ParseOptions): Promise<ScrapedThread[]>;
}

/** Общая постобработка выдачи: фильтр по дате, дедуп, сортировка по охвату. */
export function normalizeResults(
  threads: ScrapedThread[],
  options: Pick<ParseOptions, "maxAgeDays">,
): ScrapedThread[] {
  const cutoff =
    options.maxAgeDays === undefined
      ? null
      : Date.now() - options.maxAgeDays * 86_400_000;

  const seen = new Set<string>();
  const result: ScrapedThread[] = [];

  for (const thread of threads) {
    if (seen.has(thread.id)) continue;
    if (cutoff !== null && thread.postedAt && new Date(thread.postedAt).getTime() < cutoff) {
      continue;
    }
    seen.add(thread.id);
    result.push(thread);
  }

  return result.sort((a, b) => b.likes + b.replies - (a.likes + a.replies));
}
