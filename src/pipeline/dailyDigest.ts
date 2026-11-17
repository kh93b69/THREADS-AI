import { Telegram, escapeTg } from "../services/notify/Telegram.js";
import { ThreadsPoster } from "../services/poster/ThreadsPoster.js";
import type { PostStats } from "../types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("digest");

const DAY_MS = 86_400_000;

export interface DigestResult {
  posts: PostStats[];
  text: string;
  sent: boolean;
}

/**
 * Ежедневная сводка: что вышло за сутки и как зашло.
 * Вовлечённость считаем как (лайки + комменты + репосты) / просмотры —
 * это то, на что реально смотришь, решая, повторять формат или нет.
 */
export async function runDailyDigest(days = 1): Promise<DigestResult> {
  const since = Date.now() - days * DAY_MS;
  const posts = await ThreadsPoster.fromEnv().getRecentPostsWithInsights(25, since);

  const text = formatDigest(posts, days);
  const sent = await new Telegram().send(text);

  log.info("Сводка собрана", { posts: posts.length, sent });
  return { posts, text, sent };
}

export function formatDigest(posts: PostStats[], days: number): string {
  const period = days === 1 ? "за сутки" : `за ${days} дн.`;

  if (posts.length === 0) {
    return `📊 <b>Сводка ${escapeTg(period)}</b>\n\nПостов не было.`;
  }

  const total = posts.reduce(
    (acc, post) => ({
      views: acc.views + post.views,
      likes: acc.likes + post.likes,
      replies: acc.replies + post.replies,
      reposts: acc.reposts + post.reposts,
    }),
    { views: 0, likes: 0, replies: 0, reposts: 0 },
  );

  const lines: string[] = [
    `📊 <b>Сводка ${escapeTg(period)}</b>`,
    "",
    `Постов: <b>${posts.length}</b>`,
    `Просмотры: <b>${total.views}</b>`,
    `Лайки: <b>${total.likes}</b> · Комменты: <b>${total.replies}</b> · Репосты: <b>${total.reposts}</b>`,
    `Вовлечённость: <b>${formatRate(engagementRate(total.views, total))}</b>`,
    "",
  ];

  // Лучший пост наверх: по нему понятно, какой формат повторять.
  const sorted = [...posts].sort(
    (a, b) => engagementCount(b) - engagementCount(a) || b.views - a.views,
  );

  for (const [index, post] of sorted.entries()) {
    const head = index === 0 && sorted.length > 1 ? "🏆 " : "";
    lines.push(
      `${head}${escapeTg(firstLine(post.text))}`,
      `   👁 ${post.views} · ❤️ ${post.likes} · 💬 ${post.replies} · 🔁 ${post.reposts} · ${formatRate(
        engagementRate(post.views, post),
      )}`,
      post.permalink ? `   ${escapeTg(post.permalink)}` : "",
      "",
    );
  }

  if (total.replies > 0) {
    lines.push(`💬 Есть ${total.replies} коммент(ов) — стоит ответить: это поднимает охват.`);
  }

  return lines.filter((line) => line !== undefined).join("\n").trim();
}

function engagementCount(stats: { likes: number; replies: number; reposts: number }): number {
  return stats.likes + stats.replies + stats.reposts;
}

function engagementRate(
  views: number,
  stats: { likes: number; replies: number; reposts: number },
): number | null {
  if (views <= 0) return null;
  return engagementCount(stats) / views;
}

function formatRate(rate: number | null): string {
  return rate === null ? "нет данных" : `${(rate * 100).toFixed(1)}%`;
}

/** В сводке нужен не весь пост, а его первая строка — крючок. */
function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  const trimmed = line.trim();
  if (trimmed.length === 0) return "(без текста)";
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

/** Время сводки из переменных окружения. */
export function digestTime(): string {
  return (process.env["DIGEST_TIME"]?.trim() || "21:00");
}

export function digestEnabled(): boolean {
  const raw = process.env["DIGEST_ENABLED"]?.trim().toLowerCase();
  // По умолчанию включена, если настроен Телеграм: сводка без него бессмысленна.
  if (raw === undefined || raw === "") return new Telegram().configured;
  return ["1", "true", "yes", "on"].includes(raw);
}
