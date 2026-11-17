import { DEFAULT_TONE, pickTopic } from "../content/topics.js";
import { ContentGenerator } from "../services/llm/ContentGenerator.js";
import { ThreadsPoster } from "../services/poster/ThreadsPoster.js";
import type { PublishResult } from "../types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("autopost");

export interface AutoPostResult extends PublishResult {
  topic: string;
  text: string;
}

export interface AutoPostOptions {
  /** Индекс слота в расписании дня — влияет на выбор темы. */
  slotIndex?: number;
  /** Сколько всего слотов в дне. */
  slotsPerDay?: number;
  /** Своя тема вместо темы из контент-плана. */
  topic?: string;
  tone?: string;
}

/**
 * Один автоматический пост: выбрать тему → написать текст → опубликовать.
 * Сюда приходит и планировщик, и ручной вызов POST /publish/auto.
 */
export async function runAutoPost(options: AutoPostOptions = {}): Promise<AutoPostResult> {
  const slotIndex = options.slotIndex ?? 0;
  const slotsPerDay = options.slotsPerDay ?? 1;

  const planned = pickTopic(new Date(), slotIndex, slotsPerDay);
  const topic = options.topic ?? planned.topic;
  const tone = options.tone ?? planned.tone ?? DEFAULT_TONE;

  log.info("Готовлю пост", { topic, slotIndex });

  const text = await new ContentGenerator().generatePost({ topic, tone });
  const result = await ThreadsPoster.fromEnv().publish({ text });

  log.info("Пост опубликован", {
    threadId: result.threadId,
    permalink: result.permalink,
    length: text.length,
  });

  return { ...result, topic, text };
}
