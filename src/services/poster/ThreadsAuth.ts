import { THREADS_GRAPH_BASE, config } from "../../config/env.js";
import { request } from "../../utils/http.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("auth");

/** Meta ругается на redirect_uri кодом 191 / сообщением "Invalid redirect_uri". */
function isRedirectUriError(error: unknown): boolean {
  return error instanceof Error && /redirect_uri/i.test(error.message);
}

/** Со слешем в конце ↔ без него. */
function toggleTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.replace(/\/+$/, "") : `${value}/`;
}

/** Страница авторизации, куда уходит пользователь. Это не graph-хост. */
const THREADS_AUTHORIZE_URL = "https://threads.com/oauth/authorize";

/** Права, которые просим. threads_basic обязателен и не убирается. */
const SCOPES = ["threads_basic", "threads_content_publish"];

interface ShortLivedResponse {
  access_token: string;
  token_type: string;
  user_id: number | string;
}

interface LongLivedResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface AuthResult {
  accessToken: string;
  userId: string;
  expiresIn: number;
  expiresAt: string;
}

/**
 * OAuth-поток Threads: три шага, все описаны в документации Meta.
 *   1. Пользователь идёт на threads.com/oauth/authorize и разрешает доступ.
 *   2. Код с редиректа меняем на short-lived токен (живёт час).
 *   3. Short-lived меняем на long-lived (60 дней) — только с сервера,
 *      потому что в запросе участвует app secret.
 */
export class ThreadsAuth {
  constructor(
    private readonly appId: string = config.threads.appId,
    private readonly appSecret: string = config.threads.appSecret,
    private readonly redirectUri: string = config.threads.redirectUri,
  ) {}

  /** Ссылка, по которой пользователь даёт доступ. */
  buildAuthorizeUrl(state: string): string {
    const url = new URL(THREADS_AUTHORIZE_URL);
    url.searchParams.set("client_id", this.appId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", SCOPES.join(","));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return url.toString();
  }

  /** Шаги 2 и 3 разом: из кода с редиректа — сразу долгоживущий токен. */
  async exchangeCode(code: string): Promise<AuthResult> {
    // Threads иногда добавляет "#_" в хвост кода — это не часть кода.
    const cleanCode = code.replace(/#_$/, "");

    // Дашборд Meta нормализует слеш в конце по-разному на шаге авторизации и
    // на обмене кода, поэтому при ошибке redirect_uri пробуем второй вариант
    // написания и подсказываем, какой из них прижился.
    let short: ShortLivedResponse;
    try {
      short = await this.exchangeCodeForShortLived(cleanCode, this.redirectUri);
    } catch (error) {
      if (!isRedirectUriError(error)) throw error;

      const alternative = toggleTrailingSlash(this.redirectUri);
      log.warn("redirect_uri не подошёл, пробую второй вариант", { alternative });

      short = await this.exchangeCodeForShortLived(cleanCode, alternative);
      log.warn(
        `Сработал вариант со слешем иначе. Пропиши его в THREADS_REDIRECT_URI: ${alternative}`,
      );
    }
    const long = await this.exchangeForLongLived(short.access_token);

    return {
      accessToken: long.access_token,
      userId: String(short.user_id),
      expiresIn: long.expires_in,
      expiresAt: new Date(Date.now() + long.expires_in * 1000).toISOString(),
    };
  }

  private async exchangeCodeForShortLived(
    code: string,
    redirectUri: string,
  ): Promise<ShortLivedResponse> {
    // Этот шаг — form-urlencoded POST, а не JSON: требование Meta.
    const body = new URLSearchParams({
      client_id: this.appId,
      client_secret: this.appSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });

    const response = await fetch(`${THREADS_GRAPH_BASE}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = (await response.json()) as ShortLivedResponse & {
      error_message?: string;
      error_type?: string;
    };

    if (!response.ok || !data.access_token) {
      throw new Error(
        `Обмен кода не удался (${response.status}): ${data.error_message ?? JSON.stringify(data)}`,
      );
    }

    log.info("Получен short-lived токен", { userId: data.user_id });
    return data;
  }

  private async exchangeForLongLived(shortLivedToken: string): Promise<LongLivedResponse> {
    const data = await request<LongLivedResponse>(`${THREADS_GRAPH_BASE}/access_token`, {
      query: {
        grant_type: "th_exchange_token",
        client_secret: this.appSecret,
        access_token: shortLivedToken,
      },
    });

    log.info("Получен long-lived токен", { expiresIn: data.expires_in });
    return data;
  }
}
