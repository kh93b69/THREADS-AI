import { THREADS_GRAPH_BASE, THREADS_TEXT_LIMIT, config } from "../../config/env.js";
import type { CreatePostInput, PostStats, PublishResult, ThreadsMediaType } from "../../types/index.js";
import { HttpError, request, sleep } from "../../utils/http.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("poster");

export interface ThreadsPosterOptions {
  accessToken: string;
  userId: string;
  apiVersion?: string;
  dryRun?: boolean;
}

interface ContainerResponse {
  id: string;
}

interface PublishResponse {
  id: string;
}

interface ContainerStatusResponse {
  status: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";
  error_message?: string;
}

/**
 * Poster Service — официальный Threads Graph API.
 *
 * Публикация всегда двухшаговая:
 *   1. POST /{threads_user_id}/threads          → создаём медиа-контейнер
 *   2. POST /{threads_user_id}/threads_publish  → публикуем его по creation_id
 *
 * Meta рекомендует ждать ~30 сек между шагами для медиа; для TEXT
 * публикуем сразу, для IMAGE/VIDEO — опрашиваем статус контейнера.
 */
export class ThreadsPoster {
  private readonly accessToken: string;
  private readonly userId: string;
  private readonly apiVersion: string;
  private readonly dryRun: boolean;

  constructor(options: ThreadsPosterOptions) {
    this.accessToken = options.accessToken;
    this.userId = options.userId;
    this.apiVersion = options.apiVersion ?? "v1.0";
    this.dryRun = options.dryRun ?? false;
  }

  /** Фабрика из .env — обычный способ создания в приложении. */
  static fromEnv(): ThreadsPoster {
    return new ThreadsPoster({
      accessToken: config.threads.accessToken,
      userId: config.threads.userId,
      apiVersion: config.threads.apiVersion,
      dryRun: config.dryRun,
    });
  }

  private url(path: string): string {
    return `${THREADS_GRAPH_BASE}/${this.apiVersion}/${path}`;
  }

  /** Шаг 1: создание медиа-контейнера. Возвращает creation_id. */
  async createContainer(input: CreatePostInput): Promise<string> {
    const text = normalizeText(input.text);
    const mediaType: ThreadsMediaType = input.mediaType ?? "TEXT";

    if (mediaType === "IMAGE" && !input.imageUrl) {
      throw new Error("Для mediaType: \"IMAGE\" обязателен imageUrl.");
    }
    if (mediaType === "VIDEO" && !input.videoUrl) {
      throw new Error("Для mediaType: \"VIDEO\" обязателен videoUrl.");
    }

    if (this.dryRun) {
      log.info("DRY_RUN: контейнер не создаётся", { mediaType, length: text.length, text });
      return "dry-run-container";
    }

    const data = await request<ContainerResponse>(this.url(`${this.userId}/threads`), {
      method: "POST",
      query: {
        media_type: mediaType,
        text,
        image_url: input.imageUrl,
        video_url: input.videoUrl,
        reply_to_id: input.replyToId,
        link_attachment: mediaType === "TEXT" ? input.linkAttachment : undefined,
        access_token: this.accessToken,
      },
    });

    log.info("Контейнер создан", { containerId: data.id, mediaType });
    return data.id;
  }

  /** Шаг 2: публикация ранее созданного контейнера. */
  async publishContainer(containerId: string): Promise<string> {
    if (this.dryRun) {
      log.info("DRY_RUN: публикация пропущена", { containerId });
      return "dry-run-thread";
    }

    const data = await request<PublishResponse>(this.url(`${this.userId}/threads_publish`), {
      method: "POST",
      query: {
        creation_id: containerId,
        access_token: this.accessToken,
      },
    });

    log.info("Тред опубликован", { threadId: data.id });
    return data.id;
  }

  /**
   * Полный цикл: контейнер → (ожидание готовности медиа) → публикация.
   * Это основной метод, которым пользуется остальное приложение.
   */
  async publish(input: CreatePostInput): Promise<PublishResult> {
    const containerId = await this.createContainer(input);

    const mediaType = input.mediaType ?? "TEXT";
    if (mediaType !== "TEXT" && !this.dryRun) {
      await this.waitForContainer(containerId);
    }

    const threadId = await this.publishContainer(containerId);

    return {
      containerId,
      threadId,
      permalink: this.dryRun ? undefined : await this.getPermalink(threadId).catch(() => undefined),
      publishedAt: new Date().toISOString(),
    };
  }

  /** Опрос статуса контейнера — нужен для IMAGE/VIDEO. */
  async waitForContainer(containerId: string, attempts = 10, intervalMs = 5_000): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const data = await request<ContainerStatusResponse>(this.url(containerId), {
        query: { fields: "status,error_message", access_token: this.accessToken },
      });

      log.debug("Статус контейнера", { containerId, status: data.status, attempt: i + 1 });

      if (data.status === "FINISHED") return;
      if (data.status === "ERROR" || data.status === "EXPIRED") {
        throw new Error(
          `Контейнер ${containerId} в статусе ${data.status}: ${data.error_message ?? "без деталей"}`,
        );
      }
      await sleep(intervalMs);
    }
    throw new Error(`Контейнер ${containerId} не перешёл в FINISHED за отведённое время.`);
  }

  async getPermalink(threadId: string): Promise<string | undefined> {
    const data = await request<{ permalink?: string }>(this.url(threadId), {
      query: { fields: "permalink", access_token: this.accessToken },
    });
    return data.permalink;
  }

  /**
   * Последние посты аккаунта со статистикой.
   * Требует прав threads_manage_insights (просмотры, лайки) и
   * threads_read_replies (комментарии) — если токен выдан без них,
   * Meta вернёт 403, и это честно пробросится наверх.
   */
  async getRecentPostsWithInsights(limit = 10, sinceMs?: number): Promise<PostStats[]> {
    const list = await request<{ data?: Array<{ id: string; text?: string; timestamp?: string; permalink?: string }> }>(
      this.url(`${this.userId}/threads`),
      {
        query: {
          fields: "id,text,timestamp,permalink",
          limit,
          access_token: this.accessToken,
        },
      },
    );

    const posts = (list.data ?? []).filter((post) => {
      if (sinceMs === undefined || !post.timestamp) return true;
      return new Date(post.timestamp).getTime() >= sinceMs;
    });

    // Статистику Meta отдаёт только по одному посту за запрос.
    return Promise.all(posts.map((post) => this.withInsights(post)));
  }

  private async withInsights(post: {
    id: string;
    text?: string;
    timestamp?: string;
    permalink?: string;
  }): Promise<PostStats> {
    const base: PostStats = {
      id: post.id,
      text: post.text ?? "",
      permalink: post.permalink,
      postedAt: post.timestamp ?? null,
      views: 0,
      likes: 0,
      replies: 0,
      reposts: 0,
      quotes: 0,
      shares: 0,
    };

    try {
      const data = await request<{ data?: Array<{ name: string; values?: Array<{ value: number }> }> }>(
        this.url(`${post.id}/insights`),
        {
          query: {
            metric: "views,likes,replies,reposts,quotes,shares",
            access_token: this.accessToken,
          },
        },
      );

      for (const metric of data.data ?? []) {
        const value = metric.values?.[0]?.value ?? 0;
        if (metric.name in base) {
          (base as unknown as Record<string, number>)[metric.name] = value;
        }
      }
    } catch (error) {
      // Пост мог быть слишком свежим или прав не хватает: остальная сводка
      // важнее, чем падение из-за одной строки.
      log.warn("Нет статистики по посту", { id: post.id, error: String(error) });
    }

    return base;
  }

  /** Проверка токена и доступа: GET /me. Удобно вызывать на старте. */
  async whoami(): Promise<{ id: string; username?: string }> {
    return request(this.url("me"), {
      query: { fields: "id,username", access_token: this.accessToken },
    });
  }

  /** Понятное сообщение для самых частых ошибок Meta. */
  static explainError(error: unknown): string {
    if (error instanceof HttpError) {
      if (error.status === 401 || error.status === 190) {
        return "Токен недействителен или истёк — перевыпусти long-lived token.";
      }
      if (error.status === 403) {
        return "Нет прав: проверь скоупы threads_basic и threads_content_publish.";
      }
      if (error.status === 429) {
        return "Упёрлись в лимит публикаций Meta (250 постов / 24 ч). Подожди и повтори.";
      }
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

/** Жёстко режем по лимиту Meta, чтобы не ловить 400 на публикации. */
export function normalizeText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("Текст поста пустой.");
  }
  if (trimmed.length <= THREADS_TEXT_LIMIT) return trimmed;

  log.warn(`Текст длиннее ${THREADS_TEXT_LIMIT} символов — обрезаю`, {
    length: trimmed.length,
  });
  return trimmed.slice(0, THREADS_TEXT_LIMIT - 1).trimEnd() + "…";
}
