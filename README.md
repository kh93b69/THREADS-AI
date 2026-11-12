# Threads Machine

Два независимых сервиса в одном репозитории:

| Сервис | Что делает | Источник данных |
|---|---|---|
| **Poster Service** | генерит текст через LLM и публикует пост | официальный Threads Graph API |
| **Parser Service** | собирает чужие треды по ключевым словам | Apify (в обход лимитов Meta) |

Сервисы не знают друг о друге и общаются только через типы в `src/types`.

## Установка

```bash
npm install
cp .env.example .env   # заполни токены
npm run typecheck
```

## Команды

| Команда | Что делает |
|---|---|
| `npm run dev` | HTTP-сервер с автоперезагрузкой (`src/server.ts`) |
| `npm run dev:once` | один прогон «LLM → публикация» без сервера (`src/index.ts`) |
| `npm run test:post -- "текст"` | тест Poster Service без LLM |
| `npm run test:token` | продлить long-lived токен |
| `npm run test:parse -- "запрос"` | тест Parser Service (без `APIFY_TOKEN` → mock) |
| `npm run build` | сборка в `dist/` |
| `npm start` | прод-запуск собранного сервера (эта команда у Railway) |

## Первый запуск

1. Поставь `DRY_RUN=true` в `.env` — запросы собираются и логируются, но в Threads ничего не уходит.
2. `npm run test:post -- "Привет из API"` — проверь, что `whoami` вернул твой аккаунт.
3. Убери `DRY_RUN` и повтори — пост уйдёт по-настоящему.

## Получение токена Meta

Нужны скоупы `threads_basic` и `threads_content_publish`.

1. Создай приложение в [developers.facebook.com](https://developers.facebook.com) с продуктом Threads API.
2. Пройди OAuth, получи short-lived код → обменяй на long-lived токен (живёт 60 дней).
3. Положи его в `THREADS_ACCESS_TOKEN`, а `THREADS_USER_ID` возьми из `GET /v1.0/me?fields=id`.
4. Дальше `TokenManager` продлевает токен сам, если вызывать `npm run test:token` по крону раз в ~50 дней.

Важно: Meta не отдаёт отдельный refresh-token — продлевается тот же токен. Продлить можно только токен, которому больше 24 часов и который ещё не истёк. Истёк — проходи OAuth заново.

## Структура

```
src/
  config/env.ts                    ленивая валидация .env
  types/index.ts                   общие типы обоих сервисов
  utils/http.ts                    fetch + таймаут + ретраи + сокрытие токенов
  utils/logger.ts
  services/
    poster/ThreadsPoster.ts        контейнер → публикация
    poster/TokenManager.ts         продление токена, состояние в .tokens.json
    llm/ContentGenerator.ts        Anthropic Messages API, лимит 500 символов
    parser/ThreadsParser.ts        интерфейс парсера + постобработка
    parser/ApifyParser.ts          реализация на Apify (ЗАГЛУШКА, см. TODO)
    parser/MockParser.ts           фейковые данные для прогона пайплайна
scripts/                           ручные тесты
```

## Что доделать в Parser Service

`ApifyParser` — каркас: HTTP-запрос к актору собран, но у каждого актора свои поля.

1. Найди актор в Apify Store (поиск «threads scraper»).
2. Посмотри его input schema → перепиши `buildActorInput()`.
3. Посмотри формат dataset items → перепиши `mapItem()`.

Остальной код трогать не нужно: приложение работает с нормализованным `ScrapedThread`.

## Лимиты, о которых стоит помнить

- 500 символов на текстовый пост (режется автоматически в `normalizeText`).
- 250 публикаций за 24 часа на аккаунт.
- Публикация всегда двухшаговая: `/threads` → `/threads_publish`. Для IMAGE/VIDEO между шагами опрашивается статус контейнера.

## HTTP API

То, что крутится на Railway (`src/server.ts`). Все запросы кроме `/health` требуют
заголовок `x-api-secret` со значением `API_SECRET`.

| Маршрут | Тело | Что делает |
|---|---|---|
| `GET /health` | — | проверка живости, её пингует Railway |
| `POST /publish` | `{"topic": "..."}` | генерит текст через LLM и публикует |
| `POST /publish` | `{"text": "..."}` | публикует готовый текст, без LLM |
| `POST /parse` | `{"keywords": ["..."]}` | треды конкурентов по ключевым словам |

```bash
curl -X POST https://<твой-домен>.up.railway.app/publish \
  -H "x-api-secret: $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"topic": "почему автоматизации умирают через месяц"}'
```

## Деплой на Railway

Railway сам определяет Node-проект: ставит зависимости, выполняет `npm run build`,
запускает `npm start`. Никаких Dockerfile и railway.json не нужно.

1. **Variables** в проекте Railway — вставь переменные из `.env.example`
   (`PORT` не задавай, Railway подставляет его сам).
2. **Settings → Networking → Generate Domain** — получишь публичный URL.
3. Проверь `https://<домен>/health` — должен вернуть `{"ok":true}`.
4. Первый деплой держи с `DRY_RUN=true`, убедись что `/publish` отвечает 200,
   потом переключай на `false`.

Деплой стартует автоматически на каждый push в `main`.

### Про базу данных

На старте БД не нужна: сервис stateless, всё состояние — в переменных окружения.

БД понадобится, когда появится **очередь постов и расписание** (чтобы бот сам
постил по плану) или **история парсинга** (чтобы не предлагать одни и те же треды).
Тогда проще добавить Postgres кнопкой в том же проекте Railway, чем подключать
Supabase: `DATABASE_URL` подставится в сервис автоматически, без второго аккаунта
и без лишней сети между провайдерами. Supabase имеет смысл, только если
понадобится его авторизация или realtime.

Одно место уже сейчас упирается в отсутствие БД: `TokenManager` пишет продлённый
токен в `.tokens.json`, а файловая система Railway эфемерная. Пока обходим руками —
раз в ~50 дней запускаешь `npm run test:token` локально и копируешь новый токен
в Variables. Код это не ломает: при неудачной записи он логирует токен с
предупреждением вместо падения.
