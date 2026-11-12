/**
 * Минимальный тест Poster Service — без LLM.
 *
 *   npm run test:post -- "Текст поста"
 *
 * Сначала прогоняй с DRY_RUN=true в .env: запрос соберётся и залогируется,
 * но в Threads ничего не уйдёт.
 */
import { ThreadsPoster } from "../src/services/poster/ThreadsPoster.js";

const text = process.argv[2] ?? `Проверка связи с Threads API. ${new Date().toLocaleString("ru-RU")}`;

async function main(): Promise<void> {
  const poster = ThreadsPoster.fromEnv();

  const me = await poster.whoami();
  console.log("Аккаунт:", me);

  const result = await poster.publish({ text });
  console.log("Результат:", result);
  if (result.permalink) console.log("Ссылка:", result.permalink);
}

main().catch((error: unknown) => {
  console.error("Ошибка:", ThreadsPoster.explainError(error));
  process.exitCode = 1;
});
