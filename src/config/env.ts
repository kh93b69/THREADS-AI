import "dotenv/config";

export class ConfigError extends Error {}

function str(key: string, fallback?: string): string {
  const raw = process.env[key]?.trim();
  if (raw) return raw;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(
    `Не задана переменная окружения ${key}. Скопируй .env.example в .env и заполни её.`,
  );
}

function optional(key: string): string | undefined {
  const raw = process.env[key]?.trim();
  return raw ? raw : undefined;
}

function bool(key: string, fallback = false): boolean {
  const raw = optional(key);
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/**
 * Конфиг читается лениво, по сервисам: Parser может работать без токена Meta,
 * Poster — без токена Apify. Поэтому вместо одного большого объекта — геттеры.
 */
export const config = {
  get dryRun(): boolean {
    return bool("DRY_RUN", false);
  },

  threads: {
    get accessToken(): string {
      return str("THREADS_ACCESS_TOKEN");
    },
    /** Threads app ID — не ID основного приложения Meta. */
    get appId(): string {
      return str("THREADS_APP_ID");
    },
    get appSecret(): string {
      return str("THREADS_APP_SECRET");
    },
    /** Должен совпадать байт в байт с тем, что вписан в настройках Meta. */
    get redirectUri(): string {
      return `${str("PUBLIC_URL").replace(/\/$/, "")}/auth/callback`;
    },
    get userId(): string {
      return str("THREADS_USER_ID");
    },
    get apiVersion(): string {
      return str("THREADS_API_VERSION", "v1.0");
    },
  },

  llm: {
    get apiKey(): string {
      return str("ANTHROPIC_API_KEY");
    },
    get model(): string {
      return str("LLM_MODEL", "claude-opus-5-5");
    },
    get effort(): "low" | "medium" | "high" | "xhigh" | "max" {
      const value = str("LLM_EFFORT", "low");
      const allowed = ["low", "medium", "high", "xhigh", "max"] as const;
      if (!(allowed as readonly string[]).includes(value)) {
        throw new ConfigError(`LLM_EFFORT должен быть одним из: ${allowed.join(", ")}`);
      }
      return value as "low" | "medium" | "high" | "xhigh" | "max";
    },
  },

  autopost: {
    get enabled(): boolean {
      return bool("AUTOPOST_ENABLED", false);
    },
    /** Времена публикации "HH:MM" через запятую, в зоне timezone. */
    get times(): string[] {
      return str("POST_TIMES", "10:00,19:00")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    },
    get timezone(): string {
      return str("TIMEZONE", "Europe/Moscow");
    },
  },

  apify: {
    get token(): string {
      return str("APIFY_TOKEN");
    },
    get actorId(): string {
      return str("APIFY_ACTOR_ID", "apify/threads-scraper");
    },
  },
} as const;

/** Константы домена Threads. Meta поддерживает и .com, и .net. */
export const THREADS_GRAPH_BASE =
  process.env["THREADS_GRAPH_BASE"]?.trim() || "https://graph.threads.com";
/** Жёсткий лимит Meta на длину текстового поста. */
export const THREADS_TEXT_LIMIT = 500;
