import { readFile, writeFile } from "node:fs/promises";
import { THREADS_GRAPH_BASE, config } from "../../config/env.js";
import { request } from "../../utils/http.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("token");

const STORE_PATH = new URL("../../../.tokens.json", import.meta.url).pathname;
/** Long-lived token живёт 60 дней; продлеваем заранее. */
const REFRESH_THRESHOLD_DAYS = 10;
const DAY_MS = 86_400_000;

interface RefreshResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface TokenRecord {
  accessToken: string;
  /** ISO-дата истечения. */
  expiresAt: string;
  refreshedAt: string;
}

/**
 * Хранение и продление long-lived User Access Token.
 *
 * Meta не отдаёт refresh-token: тот же токен обменивается на новый через
 * GET /refresh_access_token?grant_type=th_refresh_token. Токен можно продлить
 * только если ему больше 24 часов и он ещё не истёк. Истёк — нужен новый
 * OAuth-флоу вручную.
 *
 * Состояние лежит в .tokens.json (в .gitignore). На Railway/serverless
 * файловая система нестабильна — подмени load/save на Redis или Postgres.
 */
export class TokenManager {
  constructor(private readonly storePath: string = STORE_PATH) {}

  /** Возвращает валидный токен, продлевая его при необходимости. */
  async getValidToken(): Promise<string> {
    const record = (await this.load()) ?? this.seedFromEnv();

    const msLeft = new Date(record.expiresAt).getTime() - Date.now();
    const daysLeft = Math.floor(msLeft / DAY_MS);

    if (msLeft <= 0) {
      throw new Error(
        "Токен истёк. Нужен ручной OAuth: пройди авторизацию заново и положи новый токен в THREADS_ACCESS_TOKEN.",
      );
    }

    if (daysLeft > REFRESH_THRESHOLD_DAYS) {
      log.debug("Токен ещё свежий", { daysLeft });
      return record.accessToken;
    }

    log.info(`До истечения ${daysLeft} дн. — продлеваю токен`);
    return (await this.refresh(record.accessToken)).accessToken;
  }

  /** Принудительное продление. Вызывается кроном раз в ~50 дней. */
  async refresh(currentToken: string): Promise<TokenRecord> {
    const data = await request<RefreshResponse>(`${THREADS_GRAPH_BASE}/refresh_access_token`, {
      query: {
        grant_type: "th_refresh_token",
        access_token: currentToken,
      },
    });

    const record: TokenRecord = {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      refreshedAt: new Date().toISOString(),
    };

    await this.save(record);
    log.info("Токен продлён", { expiresAt: record.expiresAt });
    return record;
  }

  private seedFromEnv(): TokenRecord {
    log.warn(".tokens.json не найден — беру токен из THREADS_ACCESS_TOKEN");
    return {
      accessToken: config.threads.accessToken,
      // Пессимистичная оценка: считаем, что токену уже 55 дней,
      // чтобы первый же запуск его продлил и зафиксировал реальный срок.
      expiresAt: new Date(Date.now() + 5 * DAY_MS).toISOString(),
      refreshedAt: new Date(0).toISOString(),
    };
  }

  async load(): Promise<TokenRecord | null> {
    try {
      return JSON.parse(await readFile(this.storePath, "utf8")) as TokenRecord;
    } catch {
      return null;
    }
  }

  async save(record: TokenRecord): Promise<void> {
    try {
      await writeFile(this.storePath, JSON.stringify(record, null, 2), "utf8");
    } catch (error) {
      // На Railway файловая система эфемерная и местами read-only: падать из-за
      // этого нельзя — токен в памяти валиден. Но его надо сохранить руками.
      log.warn("Не смог записать .tokens.json — скопируй токен в переменные окружения", {
        error: String(error),
        accessToken: record.accessToken,
        expiresAt: record.expiresAt,
      });
    }
  }
}
