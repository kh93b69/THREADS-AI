import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config/env.js";
import { runAutoPost } from "./pipeline/autoPost.js";
import { ContentGenerator } from "./services/llm/ContentGenerator.js";
import { ApifyParser } from "./services/parser/ApifyParser.js";
import { MockParser } from "./services/parser/MockParser.js";
import type { ThreadsParser } from "./services/parser/ThreadsParser.js";
import { ThreadsPoster } from "./services/poster/ThreadsPoster.js";
import { Scheduler } from "./services/scheduler/Scheduler.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("server");

const PORT = Number(process.env.PORT ?? 3000);
/** Общий секрет для защиты /publish и /parse. Без него эндпоинты публичные — не деплой так. */
const API_SECRET = process.env.API_SECRET?.trim();

/**
 * HTTP-обёртка над сервисами — то, что крутится на Railway.
 *
 *   GET  /health            → проверка живости (Railway пингует её сам)
 *   GET  /schedule          → расписание автопостинга и когда следующий пост
 *   POST /publish           → { topic } или { text } → пост в Threads
 *   POST /publish/auto      → пост по контент-плану, прямо сейчас
 *   POST /parse             → { keywords: string[] } → треды конкурентов
 *
 * Авторизация: заголовок `x-api-secret` должен совпасть с API_SECRET.
 */
const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    log.error("Необработанная ошибка", { error: String(error) });
    json(res, 500, { error: ThreadsPoster.explainError(error) });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /health") {
    return json(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
  }

  if (API_SECRET && req.headers["x-api-secret"] !== API_SECRET) {
    return json(res, 401, { error: "Неверный x-api-secret." });
  }

  switch (route) {
    case "GET /schedule":
      return json(res, 200, {
        autopostEnabled: config.autopost.enabled,
        ...(scheduler ? scheduler.status() : { note: "Планировщик выключен (AUTOPOST_ENABLED=false)." }),
      });
    case "POST /publish/auto":
      return publishAuto(res);
    case "POST /publish":
      return publish(await readJson(req), res);
    case "POST /parse":
      return parse(await readJson(req), res);
    default:
      return json(res, 404, { error: `Неизвестный маршрут: ${route}` });
  }
}

async function publish(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const topic = typeof body["topic"] === "string" ? body["topic"] : undefined;
  const providedText = typeof body["text"] === "string" ? body["text"] : undefined;

  if (!topic && !providedText) {
    return json(res, 400, { error: "Нужен либо topic (сгенерим текст), либо готовый text." });
  }

  const text =
    providedText ??
    (await new ContentGenerator().generatePost({
      topic: topic as string,
      tone: typeof body["tone"] === "string" ? body["tone"] : undefined,
    }));

  try {
    const result = await ThreadsPoster.fromEnv().publish({ text });
    log.info("Пост опубликован через API", { threadId: result.threadId });
    return json(res, 200, { ...result, text });
  } catch (error) {
    return json(res, 502, { error: ThreadsPoster.explainError(error), text });
  }
}

/** Ручной запуск того же пайплайна, что крутит планировщик. */
async function publishAuto(res: ServerResponse): Promise<void> {
  try {
    const result = await runAutoPost({ slotsPerDay: config.autopost.times.length });
    return json(res, 200, result);
  } catch (error) {
    return json(res, 502, { error: ThreadsPoster.explainError(error) });
  }
}

async function parse(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const keywords = Array.isArray(body["keywords"])
    ? body["keywords"].filter((k): k is string => typeof k === "string")
    : [];

  if (keywords.length === 0) {
    return json(res, 400, { error: "Нужен непустой массив keywords." });
  }

  const parser: ThreadsParser = process.env.APIFY_TOKEN ? new ApifyParser() : new MockParser();
  const threads = await parser.searchByKeywords({
    keywords,
    limitPerKeyword: Number(body["limitPerKeyword"] ?? 25),
    maxAgeDays: body["maxAgeDays"] === undefined ? undefined : Number(body["maxAgeDays"]),
  });

  return json(res, 200, { parser: parser.name, count: threads.length, threads });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("Тело запроса больше 1 МБ.");
    chunks.push(chunk as Buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error("Тело запроса — не валидный JSON.");
  }
}

let scheduler: Scheduler | null = null;

if (config.autopost.enabled) {
  scheduler = new Scheduler({
    times: config.autopost.times,
    timezone: config.autopost.timezone,
    job: (slotIndex, slotsPerDay) => runAutoPost({ slotIndex, slotsPerDay }),
  });
}

server.listen(PORT, () => {
  log.info(`Слушаю порт ${PORT}`, { authEnabled: Boolean(API_SECRET) });
  if (!API_SECRET) log.warn("API_SECRET не задан — эндпоинты открыты всем!");

  if (scheduler) scheduler.start();
  else log.info("Автопостинг выключен: AUTOPOST_ENABLED=false");
});

// Railway присылает SIGTERM при редеплое — закрываемся аккуратно.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info(`Получен ${signal}, останавливаюсь`);
    scheduler?.stop();
    server.close(() => process.exit(0));
  });
}
