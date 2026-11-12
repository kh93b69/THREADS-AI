/** Тип медиа-контейнера в Threads Graph API. */
export type ThreadsMediaType = "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL";

export interface CreatePostInput {
  /** Текст поста, максимум 500 символов. */
  text: string;
  mediaType?: ThreadsMediaType;
  /** Публичный URL картинки (для mediaType: "IMAGE"). */
  imageUrl?: string;
  /** Публичный URL видео (для mediaType: "VIDEO"). */
  videoUrl?: string;
  /** ID треда, на который отвечаем (для веток). */
  replyToId?: string;
  /** Ссылка для превью под постом (только для TEXT). */
  linkAttachment?: string;
}

export interface PublishResult {
  /** ID созданного медиа-контейнера. */
  containerId: string;
  /** ID опубликованного треда. */
  threadId: string;
  permalink?: string;
  publishedAt: string;
}

/** Нормализованный тред, который возвращает Parser Service. */
export interface ScrapedThread {
  id: string;
  url: string;
  username: string;
  text: string;
  likes: number;
  replies: number;
  reposts: number;
  postedAt: string | null;
  /** Ключевой запрос, по которому нашли этот тред. */
  matchedQuery: string;
  /** Сырой объект от провайдера — на случай, если нужны доп. поля. */
  raw?: unknown;
}

export interface ParseOptions {
  keywords: string[];
  /** Сколько тредов максимум на один ключевой запрос. */
  limitPerKeyword?: number;
  /** Не брать посты старше N дней. */
  maxAgeDays?: number;
}
