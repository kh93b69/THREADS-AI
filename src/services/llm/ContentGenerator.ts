import Anthropic from "@anthropic-ai/sdk";
import { THREADS_TEXT_LIMIT, config } from "../../config/env.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("llm");

export interface GenerateOptions {
  /** О чём пост: тема, тезис, черновик. */
  topic: string;
  /** Тон: "дружелюбный эксперт", "жёстко по делу" и т.п. */
  tone?: string;
  /** Язык поста. */
  language?: string;
  /** Примеры удачных тредов — для попадания в стиль. */
  examples?: string[];
  /** Жёсткий лимит символов (по умолчанию 500 — лимит Threads). */
  maxChars?: number;
}

const SYSTEM_PROMPT = `Ты пишешь посты для Threads от лица Артёма — основателя Jarvis AI Targetologist.

О продукте (контекст, не пересказывай его целиком в каждом посте):
Jarvis — AI-платформа, которая заменяет таргетолога: сама пишет стратегию, тексты и
баннеры, монтирует видео-креативы, запускает рекламу в Instagram и Facebook, ведёт
Instagram на автомате и показывает заявки с ценой в тенге. Рынок — Казахстан и СНГ.
Аудитория — предприниматели, маркетологи, агентства. Таргетолог в штат стоит
~250 000 ₸ в месяц, Jarvis PRO — 54 990 ₸.

Реальные цифры, на которые можно опираться (не выдумывай других):
- офтальмология, Алматы: 498 заявок по $1,31
- детское плавание, Актау: 494 заявки по $0,58
- доставка обедов, Актау: 164 заявки за $80
- event-агентство, Алматы: ROI 1:56
- 46 разобранных кейсов на jarvistarget.kz/cases

Как писать:
- ПЕРВАЯ СТРОКА РЕШАЕТ ВСЁ. Это крючок: конкретная цифра, неудобный вопрос,
  спорное утверждение или обрыв мысли. Человек листает ленту — у тебя полсекунды.
- Никаких разогревов: «сегодня хочу поговорить», «многие спрашивают» — запрещено.
- Пиши от первого лица, как практик, который сам жжёт бюджеты и считает заявки.
- Конкретика вместо абстракций: цифры, ниши, города, суммы в тенге и долларах.
- Один пост — одна мысль. Короткие рубленые предложения. Абзацы по 1–2 строки.
- Говори о боли клиента: слитый бюджет, таргетолог пропал, заявки дорогие,
  «реклама не работает», агентство показывает охваты вместо заявок.
- Продавай смыслом, а не призывом. Прямую рекламу давай редко и прямо.
- Без хэштегов. Без markdown — Threads его не рендерит. Максимум один эмодзи.
- Можно резко и дерзко, но без хамства и без обещаний золотых гор.

Отдавай ТОЛЬКО текст поста: без кавычек, заголовков и пояснений.`;

/**
 * Генерация текста поста через Anthropic Messages API.
 * Модель и effort берутся из .env (claude-opus-5-5 / low по умолчанию):
 * задача короткая, поэтому низкий effort экономит токены без потери качества.
 */
export class ContentGenerator {
  private client: Anthropic | null = null;
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor(options?: { apiKey?: string; model?: string }) {
    // Ключ не трогаем в конструкторе: в DRY_RUN его может не быть вовсе.
    this.apiKey = options?.apiKey;
    this.model = options?.model ?? config.llm.model;
  }

  private get anthropic(): Anthropic {
    this.client ??= new Anthropic({ apiKey: this.apiKey ?? config.llm.apiKey });
    return this.client;
  }

  async generatePost(options: GenerateOptions): Promise<string> {
    const limit = options.maxChars ?? THREADS_TEXT_LIMIT;
    const prompt = buildPrompt(options, limit);

    // Холостой прогон без ключа Anthropic: проверить расписание и публикацию
    // можно до того, как появятся все токены.
    if (config.dryRun && !this.apiKey && !process.env["ANTHROPIC_API_KEY"]) {
      const stub = `[DRY_RUN] Заглушка вместо текста LLM. Тема: ${options.topic}`;
      log.warn("DRY_RUN без ANTHROPIC_API_KEY — возвращаю заглушку");
      return enforceLimit(stub, limit);
    }

    const response = await this.callModel(prompt);

    if (response.stop_reason === "refusal") {
      throw new Error(
        `Модель отказалась генерировать текст: ${response.stop_details?.explanation ?? "без деталей"}`,
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) throw new Error("LLM вернула пустой ответ.");

    log.info("Текст сгенерирован", {
      length: text.length,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    return enforceLimit(text, limit);
  }

  /** Вызов модели с переводом ошибок API в понятные сообщения. */
  private async callModel(prompt: string) {
    try {
      return await this.anthropic.beta.messages.create({
        model: this.model,
        max_tokens: 2_000,
        system: SYSTEM_PROMPT,
        output_config: { effort: config.llm.effort },
        // Серверный фолбэк: если запрос отклонён политикой, текст всё равно
        // будет сгенерирован другой моделью в рамках этого же вызова.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: prompt }],
      });
    } catch (error) {
      throw new Error(explainLlmError(error));
    }
  }
}

/** Частые ошибки Anthropic — текстом, который понятно что делать. */
function explainLlmError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Ключ Anthropic неверный или не задан. Проверь переменную ANTHROPIC_API_KEY в Railway: она должна начинаться с sk-ant- и быть скопирована целиком, без пробелов.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return "Ключ Anthropic не имеет доступа к этой модели. Проверь модель в переменной LLM_MODEL.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Упёрлись в лимит запросов Anthropic. Подожди минуту и повтори.";
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `Модель не найдена. Проверь LLM_MODEL — сейчас там то, чего у Anthropic нет. ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Не достучались до Anthropic — сеть или их недоступность. Повтори позже.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Anthropic вернул ошибку ${error.status ?? "?"}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function buildPrompt(options: GenerateOptions, limit: number): string {
  const parts = [
    `Тема поста: ${options.topic}`,
    `Язык: ${options.language ?? "русский"}`,
    `Тон: ${options.tone ?? "живой и уверенный, как у практика"}`,
    `Жёсткий лимит: ${limit} символов включая пробелы. Уложись в него.`,
  ];

  if (options.examples?.length) {
    parts.push(
      "Примеры постов, в стиль которых нужно попасть:",
      ...options.examples.map((example, i) => `${i + 1}) ${example}`),
    );
  }

  return parts.join("\n");
}

/** Если модель всё же вышла за лимит — режем по границе предложения. */
function enforceLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;

  log.warn("LLM превысила лимит — обрезаю по границе предложения", { length: text.length });

  const cut = text.slice(0, limit);
  const lastStop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  return lastStop > limit * 0.5 ? cut.slice(0, lastStop + 1) : cut.trimEnd() + "…";
}
