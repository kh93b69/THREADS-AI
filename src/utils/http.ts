import { createLogger } from "./logger.js";

const log = createLogger("http");

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }

  /** 429 и 5xx имеет смысл повторить, 4xx — нет. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  /** Query-параметры; undefined-значения выбрасываются. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;

/**
 * Тонкая обёртка над нативным fetch: query-сборка, таймаут,
 * экспоненциальный ретрай на 429/5xx, типизированный разбор JSON.
 */
export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = "GET",
    query,
    body,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
  } = options;

  const target = new URL(url);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) target.searchParams.set(key, String(value));
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      log.debug(`${method} ${redact(target)}`, { attempt });

      const response = await fetch(target, {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const raw = await response.text();
      const parsed = raw.length > 0 ? tryParse(raw) : null;

      if (!response.ok) {
        throw new HttpError(
          `${method} ${redact(target)} → ${response.status}: ${extractMessage(parsed) ?? raw.slice(0, 300)}`,
          response.status,
          parsed ?? raw,
        );
      }

      return parsed as T;
    } catch (error) {
      lastError = error;

      const isRetryable =
        (error instanceof HttpError && error.retryable) ||
        (error instanceof Error && (error.name === "AbortError" || error.name === "TypeError"));

      if (!isRetryable || attempt === retries) break;

      const delay = 500 * 2 ** attempt;
      log.warn(`Запрос не удался, повтор через ${delay} мс`, { attempt, error: String(error) });
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Meta отдаёт ошибки как { error: { message, type, code } }. */
function extractMessage(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const err = (parsed as { error: unknown }).error;
    if (err && typeof err === "object" && "message" in err) {
      return String((err as { message: unknown }).message);
    }
  }
  return undefined;
}

/** Токены не должны попадать в логи. */
function redact(url: URL): string {
  const copy = new URL(url.toString());
  for (const key of ["access_token", "token"]) {
    if (copy.searchParams.has(key)) copy.searchParams.set(key, "***");
  }
  return copy.toString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
