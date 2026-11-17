import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config/env.js";
import { runAutoPost } from "./pipeline/autoPost.js";
import { ContentGenerator } from "./services/llm/ContentGenerator.js";
import { ApifyParser } from "./services/parser/ApifyParser.js";
import { MockParser } from "./services/parser/MockParser.js";
import type { ThreadsParser } from "./services/parser/ThreadsParser.js";
import { ThreadsAuth } from "./services/poster/ThreadsAuth.js";
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
 *   GET  /auth/start        → получение токена Meta: открыть в браузере
 *   GET  /auth/callback     → сюда Threads возвращает после разрешения доступа
 *   ANY  /auth/uninstall    → Meta требует заполнить это поле в настройках
 *   ANY  /auth/delete       → и это тоже, иначе форма не сохраняется
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
  // Слеш в конце пути игнорируем: Meta может вернуть на /auth/callback/
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const route = `${req.method} ${path}`;

  if (route === "GET /health") {
    return json(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
  }

  if (route === "GET /auth/start") return authStart(url, res);
  if (route === "GET /auth/callback") return authCallback(url, res);

  // Meta не сохраняет форму настроек, пока не заполнены все три callback-адреса.
  // Эти два она дёргает, только если пользователь отзывает доступ или удаляет
  // данные; нам достаточно ответить 200, чтобы она не считала их битыми.
  if (path === "/auth/uninstall" || path === "/auth/delete") {
    log.info("Meta дёрнула callback", { path, method: req.method });
    return json(res, 200, { ok: true });
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

/**
 * Одноразовые state для OAuth: защита от того, что кто-то дёрнет /auth/callback
 * со своим кодом. Живут в памяти — этого достаточно, поток занимает полминуты.
 */
const pendingStates = new Map<string, string>();

/**
 * Старт OAuth. Открывается в браузере, поэтому заголовок передать нельзя —
 * секрет идёт в query: /auth/start?secret=...
 */
function authStart(url: URL, res: ServerResponse): void {
  if (API_SECRET && url.searchParams.get("secret") !== API_SECRET) {
    return html(res, 401, "<h1>Неверный secret</h1><p>Открой ссылку с ?secret=&lt;API_SECRET&gt;</p>");
  }

  try {
    const auth = new ThreadsAuth();
    const state = randomUUID();
    // Запоминаем redirect_uri именно этой попытки: на обмене кода Meta требует
    // ровно его, даже если переменные окружения успели поменяться.
    pendingStates.set(state, auth.currentRedirectUri);
    // Чтобы забытые state не копились, если поток бросили на половине.
    setTimeout(() => pendingStates.delete(state), 10 * 60_000).unref();

    const target = auth.buildAuthorizeUrl(state);

    // ?debug=1 — не редиректим, а показываем, что именно уходит в Meta.
    // Нужно, когда Meta отвечает "URL заблокирован" (код 1349168):
    // почти всегда виноват client_id от основного приложения вместо Threads,
    // либо redirect_uri, не совпавший с зарегистрированным байт в байт.
    if (url.searchParams.get("debug") === "1") {
      const parsed = new URL(target);
      pendingStates.delete(state);
      return html(
        res,
        200,
        `<h1>Что уйдёт в Meta</h1>
         <p><b>client_id</b> — должен совпадать с «ID приложения Threads» в Настройках,
         а не с ID основного приложения:</p>
         <pre>${escapeHtml(parsed.searchParams.get("client_id") ?? "")}</pre>
         <p><b>redirect_uri</b> — должен совпадать с «Авторизация URL обратного вызова»
         символ в символ, без слеша в конце:</p>
         <pre>${escapeHtml(parsed.searchParams.get("redirect_uri") ?? "")}</pre>
         <p><b>scope</b>:</p>
         <pre>${escapeHtml(parsed.searchParams.get("scope") ?? "")}</pre>
         <p>Полная ссылка авторизации:</p>
         <pre>${escapeHtml(target)}</pre>
         <p>Если Meta отвечает «URL заблокирован», сравни redirect_uri выше с тем,
         что сохранено в настройках приложения. Дашборд иногда сам дописывает слеш.
         Альтернативное написание, которое может ждать Meta:</p>
         <pre>${escapeHtml(toggleTrailingSlash(parsed.searchParams.get("redirect_uri") ?? ""))}</pre>
         <p>Чтобы послать именно его, задай переменную
         <code>THREADS_REDIRECT_URI</code> этим значением.</p>`,
      );
    }

    log.info("Отправляю на авторизацию Threads");
    res.writeHead(302, { Location: target });
    res.end();
  } catch (error) {
    html(res, 500, `<h1>Не настроено</h1><pre>${escapeHtml(String(error))}</pre>`);
  }
}

/** Threads возвращает сюда с ?code=... — меняем его на долгоживущий токен. */
async function authCallback(url: URL, res: ServerResponse): Promise<void> {
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (error) {
    return html(res, 400, `<h1>Доступ не выдан</h1><p>${escapeHtml(error)}</p>`);
  }

  const state = url.searchParams.get("state");
  const usedRedirectUri = state ? pendingStates.get(state) : undefined;
  if (!state || !usedRedirectUri) {
    return html(
      res,
      400,
      "<h1>Неизвестный state</h1><p>Начни заново с /auth/start?secret=&lt;API_SECRET&gt;</p>",
    );
  }

  pendingStates.delete(state);

  const code = url.searchParams.get("code");
  if (!code) return html(res, 400, "<h1>Нет параметра code</h1>");

  try {
    const result = await new ThreadsAuth().exchangeCode(code, usedRedirectUri);
    log.info("Токен получен, осталось записать его в переменные Railway", {
      userId: result.userId,
      expiresAt: result.expiresAt,
    });

    return html(
      res,
      200,
      `<h1>Готово</h1>
       <p>Скопируй обе строки в Railway → Variables, затем поставь <code>DRY_RUN=false</code> и передеплой.</p>
       <pre>THREADS_ACCESS_TOKEN=${escapeHtml(result.accessToken)}
THREADS_USER_ID=${escapeHtml(result.userId)}</pre>
       <p>Токен действует до <b>${escapeHtml(result.expiresAt)}</b> (60 дней).
       Продлевать: <code>npm run test:token</code> раз в ~50 дней.</p>`,
    );
  } catch (err) {
    return html(res, 502, `<h1>Обмен не удался</h1><pre>${escapeHtml(String(err))}</pre>`);
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

/** Ответ для браузера: OAuth-поток человек проходит глазами, не curl-ом. */
function html(res: ServerResponse, status: number, body: string): void {
  const page = `<!doctype html><meta charset="utf-8">
<title>Threads Machine</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem}
pre{background:#f4f4f5;padding:1rem;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}</style>
${body}`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(page),
  });
  res.end(page);
}

/** Со слешем в конце ↔ без него: второй вариант для сверки с настройками Meta. */
function toggleTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.replace(/\/+$/, "") : `${value}/`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
